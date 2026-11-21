// Triggers (polled, not webhooks): TRIGGER_*, triggerTimer/triggerPolling/triggerDrainTimer (module-level lets, assigned
// only here), activeTriggerRuns, startTriggerPoller, scheduleTriggerDrain, pollAllTriggers, pollTriggerNode, fireTrigger.

import crypto from "node:crypto";
import * as gitlab from "../gitlab.js";
import * as wf from "../workflows.js";
import * as store from "../store.js";
import { T } from "../i18n.js";
import { recordNotice } from "../services.js";
import { beginWorkflow } from "./driver.js";
import { broadcast } from "../runtime/sse.js";
import { workflowNote } from "./run-state.js";
import { ultracodeFollowUp } from "../chats/ultracode.js";


// ── Triggers: workflows started by an event from OUTSIDE ─────────────────────
// Polled, not by webhook: cbase runs locally or in a private container and cannot be reached from
// GitLab. The cadence is coarse (default 15 s tick, per trigger its own interval from 30 s) — a
// trigger starts a whole agent run, seconds do not matter here.
const TRIGGER_TICK_MS = Number(process.env.CBASE_TRIGGER_TICK_MS) || 15_000;
// Caps, so a burst of latecomers (e.g. 30 MRs after arming) does not start 30 agents: at most N
// runs per poll, and at most N triggered runs at the same time overall. Whatever has to wait stays
// UNSEEN and gets its turn at the next tick — nothing is dropped silently.
// Read at call time, not at load time (a test sets them per case).
const triggerMaxFiresPerPoll = () => Number(process.env.CBASE_TRIGGER_MAX_FIRES) || 3;
const triggerMaxActiveRuns = () => Number(process.env.CBASE_TRIGGER_MAX_ACTIVE) || 3;
// Time window of the dry run ("check now"): 24 h back, so you can SEE what the settings would
// match. The armed trigger, in contrast, only counts from the moment of arming.
const TRIGGER_PREVIEW_MS = 24 * 60 * 60 * 1000;
let triggerTimer = null;
let triggerPolling = false;
// Test seam: number of COMPLETE passes of pollAllTriggers. A test proves "the tick looked and fired
// nothing" by counted polls instead of a pause. Only counted, nothing reads it.
let triggerCycleCounter = 0;
const triggerCycles = () => triggerCycleCounter;

// Workflow runs running at the same time that were started BY A TRIGGER (manual runs do not slow
// the triggers down — the user sits in front of them and knows what they are doing).
const activeTriggerRuns = () =>
  store.listOpenWorkflowRuns().filter((r) => r.cursor?.vars?.origin === "trigger").length;

// The waterline of ONE event kind: kept per kind (`sinceKind`); `since` is the minimum over them and applies where a
// kind has none of its own (yet) — a newly selected kind starts there; arming sets `since` to NOW and clears the kinds
// (store/workflows.js:updateTriggerState).
const waterlineFor = (st, kind) => Math.max(st.since, Number(st.sinceKind?.[kind]) || 0);
// The read pointer of a backlog PER KIND: a kind reads more than 1,000 entries since its line over several ticks, each
// from where the previous one stopped (`gitlab.js:pollTrigger`, `further`). The line itself stays put meanwhile — it
// filters the events, the pointer only the reading. Empty without a backlog.
const readPointerFor = (st, kind) => Number(st.continueKind?.[kind]) || undefined;

function startTriggerPoller() {
  if (triggerTimer) return;
  if (process.env.CBASE_TRIGGER_POLL === "0") return; // tests/special operation: poll only on demand
  const tick = () => pollAllTriggers().catch((e) => console.error("[trigger] poll:", e?.message || e));
  triggerTimer = setInterval(tick, TRIGGER_TICK_MS);
  triggerTimer.unref?.();
  setTimeout(tick, 3000).unref?.(); // look once right after the start
}

// A lock was released → check right away whether an event was waiting for it. Bundled, because several
// status reports fall at the end of a run; and only when the tick is running at all.
let triggerDrainTimer = null;
function scheduleTriggerDrain() {
  if (process.env.CBASE_TRIGGER_POLL === "0" || triggerDrainTimer) return;
  triggerDrainTimer = setTimeout(() => {
    triggerDrainTimer = null;
    // `force`, because the regular tick would otherwise get stuck on the trigger's minimum interval
    // (default 30 s) — but the wait should end with the holder, not with the tick. A run ends
    // rarely, so the extra poll is cheap.
    pollAllTriggers({ force: true }).catch((e) => console.error("[trigger] drain:", e?.message || e));
  }, 400);
  triggerDrainTimer.unref?.();
}

async function pollAllTriggers({ force = false } = {}) {
  if (triggerPolling) return; // one pass at a time — GitLab calls take a while
  triggerPolling = true;
  try {
    // Clear orphaned locks (crash/restart/deleted history) before they hold up a trigger — a lock
    // without an open run is dead by definition.
    store.reapStaleLocks();
    for (const flow of store.listActiveWorkflows()) {
      const graph = wf.normalizeGraph(flow.graph);
      const nodes = wf.triggerNodes(graph);
      store.pruneTriggerStates(flow.id, nodes.map((n) => n.id));
      for (const node of nodes) {
        try {
          await pollTriggerNode(flow, node, { force });
        } catch (e) {
          store.updateTriggerState(flow.id, node.id, { lastPollAt: Date.now(), lastError: String(e?.message || e) });
        }
      }
    }
    triggerCycleCounter += 1;
  } finally {
    triggerPolling = false;
  }
}

// Poll one trigger and start a run for each new event.
// `dryRun` only answers "what would fire now" (button "Check now") and changes nothing.
async function pollTriggerNode(flow, node, { dryRun = false, force = false } = {}) {
  const trigger = node.trigger || wf.normalizeTrigger(null);
  const now = Date.now();
  const why = wf.triggerReady(trigger);
  if (why) {
    const msg = T("Trigger is not fully configured yet.");
    if (!dryRun) store.updateTriggerState(flow.id, node.id, { lastPollAt: now, lastError: msg });
    return { events: [], fired: 0, error: msg };
  }
  const account = store.getGitlabAccountWithToken(trigger.accountId);
  if (!account) {
    const msg = T("The trigger's GitLab account no longer exists.");
    if (!dryRun) store.updateTriggerState(flow.id, node.id, { lastPollAt: now, lastError: msg });
    return { events: [], fired: 0, error: msg };
  }
  // The dry run creates NO state and deliberately looks into the past (TRIGGER_PREVIEW_MS): with the
  // real waterline ("from now on") the answer right after setup would always be empty — but the user
  // wants to see whether the settings match anything.
  // A shape of its own: ONE page per kind, the newest, and a sentence that only speaks about the preview. Running it
  // through the armed trigger's cap would show nothing for a busy kind and claim "this kind fires nothing" while the
  // armed trigger fires from its line near NOW (description side and execution side with two answers).
  if (dryRun) {
    const since = Math.max(0, now - TRIGGER_PREVIEW_MS);
    const { events, errors, hints } = await gitlab.pollTrigger(account, trigger, since, { preview: true });
    return { events, fired: 0, error: [...errors, ...hints].join(" · "), since, preview: true };
  }
  const st = store.ensureTriggerState(flow.id, node.id, now);
  if (!force && now - st.lastPollAt < trigger.intervalSec * 1000) return { events: [], fired: 0, skipped: true };

  const { events, errors, hints, positions, further } = await gitlab.pollTrigger(account, trigger,
    (kind) => waterlineFor(st, kind), { further: (kind) => readPointerFor(st, kind) });
  const seen = new Set(st.seen);
  const fresh = events.filter((e) => e.key && !seen.has(e.key));

  const nextSeen = st.seen.slice();
  const maxStarts = triggerMaxFiresPerPoll();
  const maxActive = triggerMaxActiveRuns();
  // Counted ONCE before the loop: the runs this poll starts are immediately among the open ones —
  // `activeTriggerRuns() + fired` would count each of them twice.
  const activePrior = activeTriggerRuns();
  let fired = 0;
  let deferred = 0;         // deferred behind a cap (waits for the next tick)
  let cap = "";          // which one: "active" (concurrent runs) or "query" (starts per poll)
  let blocked = 0;          // deferred by a lock (waits for the holder)
  const holdValue = new Map();   // event kind → timestamp of its OLDEST held-back event
  const waitingOn = new Map(); // key → chat of the holder (for the status message)
  const hold = (e) => holdValue.set(e.kind, Math.min(holdValue.get(e.kind) ?? e.at, e.at));
  for (let i = 0; i < fresh.length; i++) {
    const e = fresh[i];
    // Both caps DEFER, neither discards: marking the remaining events `seen` and moving the line past them would
    // lose them silently.
    if (activePrior + fired >= maxActive || fired >= maxStarts) {
      cap = activePrior + fired >= maxActive ? "active" : "query";
      deferred = fresh.length - i;
      for (const rest of fresh.slice(i)) hold(rest);
      break;
    }
    const r = fireTrigger(flow, node, e);
    // Lock held → the event stays UNSEEN and comes back at the next tick (or immediately, once the
    // holder is done — the release triggers a tick). Another key may still fire, hence `continue`
    // instead of `break`.
    if (r.blocked) {
      blocked++;
      hold(e);
      if (r.key && !waitingOn.has(r.key)) waitingOn.set(r.key, r.lock?.chatId ? store.getChat(r.lock.chatId)?.title || "" : "");
      continue;
    }
    if (r.fired) fired++;
    nextSeen.push(e.key);
  }
  // The waterline PER KIND: a kind that has been read completely (`positions`) moves up to its newest entry — past
  // already known ones too, otherwise every tick polls the same window again — and loses its read pointer. A kind with
  // a backlog (`further`) keeps its line and continues reading from the new pointer at the next tick; a failed kind
  // keeps both, and its error is in the status at every tick until it reads again. With ONE line for all kinds a newer
  // MR would lift it past an issue whose poll just got a 502 — it would never come back.
  // Neither line nor pointer runs past a held-back event of its kind: `created_after`/`updated_after` is the only
  // resubmission, an overrun waiting event would never show up again. What has already fired before that is protected
  // by `seen` against firing twice; the reset only costs one more poll.
  const sinceKind = {};
  const continueKind = {};
  for (const kind of trigger.events) {
    let line = waterlineFor(st, kind);
    let pointer = readPointerFor(st, kind) ?? 0;
    if (Object.hasOwn(positions, kind)) { line = Math.max(line, positions[kind]); pointer = 0; }
    else if (Object.hasOwn(further, kind)) pointer = further[kind];
    if (holdValue.has(kind)) { line = Math.min(line, holdValue.get(kind) - 1); pointer = Math.min(pointer, holdValue.get(kind) - 1); }
    sinceKind[kind] = line;
    if (pointer > line) continueKind[kind] = pointer;
  }
  const lines = Object.values(sinceKind);
  const cursorAt = lines.length ? Math.min(...lines) : st.since;
  const notes = [...errors, ...hints];
  if (deferred) {
    notes.push(cap === "active"
      ? T`${deferred} events are waiting (already ${maxActive} triggered runs active).`
      : T`${deferred} events are waiting for the next poll (cap of ${maxStarts} starts per poll).`);
  }
  if (blocked) {
    const holder = [...waitingOn.values()].find(Boolean);
    notes.push(T`${blocked} event(s) waiting for the lock${holder ? T` — "${holder}" is still running` : ""}.`);
  }
  store.updateTriggerState(flow.id, node.id, {
    since: cursorAt, sinceKind, continueKind, seen: nextSeen, lastPollAt: now, lastError: notes.join(" · "),
    ...(fired ? { lastFireAt: now, fires: st.fires + fired } : {}),
  });
  if (notes.length) console.warn(`[trigger] ${flow.name}/${node.id}: ${notes.join(" · ")}`);
  return { events: fresh, fired, error: notes.join(" · ") };
}

// Chat title of a triggered run: language-neutral from the event ("!23 Fix flaky test").
function triggerChatTitle(event) {
  const head = [event.ref, event.title].filter(Boolean).join(" ").trim() || wf.eventSummary(event);
  return head.length > 60 ? `${head.slice(0, 60)}…` : head;
}

// One event → a new chat in the workflow's scope + a run from the trigger node.
// Returns: { fired } · { blocked, lock } (lock held → event waits) · { fired: false }.
function fireTrigger(flow, node, event) {
  if (!store.getWorkspace(flow.workspaceId)) return { fired: false };
  if (flow.projectId && !store.getProject(flow.projectId)) return { fired: false };
  const now = Date.now();
  const { input, vars } = wf.triggerVars(event);
  // The lock is acquired BEFORE the chat: otherwise an event that should only wait would produce an
  // empty chat plus a bell notice. The acquisition runs on the already fixed run id, which
  // `beginWorkflow` then takes over (the acquisition there is reentrant).
  const lockKey = wf.lockKeyFor(flow.lock, { workflowId: flow.id, projectId: flow.projectId || "", workspaceId: flow.workspaceId || "", vars });
  const runId = crypto.randomUUID();
  if (lockKey) {
    const got = store.acquireLock(lockKey, {
      runId, workflowId: flow.id, workflowName: flow.name, workspaceId: flow.workspaceId,
    });
    if (!got.ok) return { fired: false, blocked: true, key: lockKey, lock: got.lock };
  }
  const chat = store.createChat(ultracodeFollowUp(null, {
    id: crypto.randomUUID(), workspaceId: flow.workspaceId, projectId: flow.projectId || null,
    title: triggerChatTitle(event), profile: "default", createdAt: now, updatedAt: now,
    // Provider/model/permissions/effort from the workflow's run settings — there is no composer
    // here in which the user could choose them before the start.
    ...wf.chatFieldsFromRun(flow.run),
  }));
  // No auto-title: the event title is already the best there is.
  store.updateChat(chat.id, { titled: 1 });
  // The chat comes into being without the user's doing — the chat lists of all open windows must
  // show it immediately, otherwise the run seems to come out of nowhere.
  broadcast({ type: "chat_created", chatId: chat.id, workspaceId: chat.workspaceId, projectId: chat.projectId || "", title: chat.title });
  const triggerEvent = {
    kind: event.kind, summary: wf.eventSummary(event), url: event.url || "",
    project: event.project || "", author: event.author || "", ref: event.ref || "", at: event.at || now,
    node: node.title || "", source: node.trigger?.source || "gitlab",
  };
  workflowNote(chat.id, { kind: "trigger", source: triggerEvent.source, title: node.title || "", event: triggerEvent });
  // Bell (and the native notification when the app is unfocused): a run nobody started must
  // announce itself — otherwise you only find it by chance in the chat list.
  recordNotice({
    kind: "trigger", chatId: chat.id, chatTitle: chat.title || flow.name || "", workspaceId: chat.workspaceId,
    title: T`Workflow "${flow.name}" triggered`,
    body: wf.eventSummary(event),
  });
  // The triggering event is stored ON THE RUN (not just in the chat history): the run history must
  // be able to say WHY this run exists, even if the chat is deleted later.
  beginWorkflow(store.getChat(chat.id), flow, input, { at: node.id, vars, triggerEvent, runId, lockKey });
  return { fired: true, key: lockKey };
}

export { pollTriggerNode, scheduleTriggerDrain, startTriggerPoller, triggerCycles };
