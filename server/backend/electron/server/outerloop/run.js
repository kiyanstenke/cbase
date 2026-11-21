// The RUN of an outer loop agent on a chat. Every run is its own core.
//
//   startOuterLoopRun({ agent, chat, trigger, runId })
//     1. The pair (agent, chat) already has an open run (running or parked) ⇒ follow-up marker, end. Not active ⇒ end.
//        The agenda keeper in a chat that is not quiet (`keeperWaiting`, agenda/upkeep.js upkeepQuietReason) ⇒ end without a
//        row; a parked run of the keeper then becomes `aborted` with the code `INTENDED_END.quiet` (intended-end.js, not a
//        sentence) — the watermark stays, the next trigger catches up.
//     2. Watermark: `fromId` = `untilMessageId` of the last FINISHED run (else 0), `since` = 0 or on the first run `sinceFor`;
//        nothing new above the line ⇒ end — no run, no row.
//     3. Set (set.js), row `running` (or a parked one continued: `runId`, attempts + 1) — SYNCHRONOUSLY in the call, so
//        that /api/runs/active counts it from the first moment.
//     4. Start gate like a workflow agent (`startGateVerdict`, purpose "agent"): at the limit `parked` with a wakeup at the
//        reset (unknown: in growing steps, limits.probeDelayMs); auto-continue off or attempts ≥ MAX_CONTINUES ⇒ `error`;
//        the project lock "wait" ⇒ parked until the next look.
//     5. An OWN core per run (runs/agents.js openAgents, `own`, `outerLoop`) with one agent: input (input.js), frame, model
//        `<provider>::<model>`, the agent's effort level. On the project (selected cbase or built-in tools, on the chat of
//        a project also a selected coding server — set.js needsProject): cwd and instance of the chat, runtime folder of
//        the chat. Otherwise — sandboxed without a selection, or external servers on a chat without a project — cwd
//        DIRS.empty, no instance (backend) and the FLAT runtime folder of the backend (never one a project container can
//        write to).
//     6. End (`atEnd`): if the run no longer applies (`outerLoopRunApplies` — chat, agent or row gone, aborted) ⇒ write
//        nothing. Else `completed` with text ⇒ note + `finished` with the watermark; without text `finished` without a note
//        ("no note"); else `error`. Tokens from the report, cost from account/prices.js costFor (reported, else estimated
//        at the catalog price), session from the last record (written to the row with the first record that has a session
//        — an aborted run would otherwise leave its transcript behind). Consumption goes through the core into
//        usage_events (source outer_loop, `agent_id`). Then the follow-up run.
//     7. If the core parks mid-run (limit of a turn, record `parked`), the row is `parked` — its wakeup belongs to the core.
//     8. Only a `gapless` agent (the timeline agent): if the input was truncated (`rest`), the watermark sits on the last
//        row SEEN, and a finished run sets the follow-up marker itself — the track is read on without a trigger until
//        nothing new is left.
//   Event at every transition: `broadcast({ type: "outer_loop", agentId, chatId, runId, state, run })` (run = publicRun).
//
//   Abort: outerLoopCoresSilence({ agentIds } | { chatId }) silences the cores (`silence()` + `close()`: no completion
//   notice, no consumption, no `atEnd`), takes the wakeups of parked runs and the follow-up markers — the ROWS are written
//   by the delete path (outerloop/abort.js abortOuterLoop, chats/erase.js deleteOuterLoopChat). A run that returns
//   afterwards writes nothing (`outerLoopRunApplies`).
//   Start: outerLoopRunsAtStart() — `running` of a dead process becomes `aborted`, SYNCHRONOUSLY in the listen callback;
//   `parked` stays and gets its wakeup anew in the restart grace (wakeParkedOuterLoop). Server end: everything silent,
//   rows stay.
//
// Imports `runs/` (core, gate connections), never the other way round (import-direction.test.js).

import crypto from "node:crypto";
import * as store from "../store.js";
import { DE } from "../i18n-de.js";
import { T } from "../i18n.js";
import { DIRS } from "../app-state.js";
import { startGateVerdict } from "../providers/index.js";
import { MAX_CONTINUES, probeDelayMs } from "../limits.js";
import { openAgents, setParkWakeup } from "../runs/agents.js";
import { autoContinueEnabled, gateFreeForAllByMeasurement, limitWindowsFor } from "../runs/limit-gate.js";
import { projectCheckBackMs } from "../runs/project-lock.js";
import { resolveCwd } from "../runs/system-prompt.js";
import { instanceIdentifierOf, instanceOfChat } from "../runs/instance.js";
import { locationFor, locationForChat } from "../runs/runtime-location.js";
import { CHANNEL_STATUS_ROLES } from "../channels/lifecycle.js";
import { broadcast } from "../runtime/sse.js";
import { costFor } from "../account/prices.js";
import { activation, sinceFor } from "./activation.js";
import { needsProject, externalNames, outerLoopSet, setRow } from "./set.js";
import { CODEX_WRITES, buildInput, withoutFenceLeftovers, outerLoopFrame } from "./input.js";
import { publicRun } from "./publiclyVisible.js";
import { upkeepQuietReason } from "../agenda/upkeep.js";
import { INTENDED_END } from "./intended-end.js";
import { STAGE_MAX, nextStage } from "./track.js";

/** The roles that count as "new" and go into the input (channels/lifecycle.js CHANNEL_STATUS_ROLES). */
export const OUTER_LOOP_ROLES = Object.freeze([...CHANNEL_STATUS_ROLES.messages]);
// A report without text (providers/agent-runtime.js writes this placeholder — the two must match) is not a note.
const NO_REPORT = "(no Report)";

const paar = (agentId, chatId) => `${agentId}|${chatId}`;
const cores = new Map();          // runId → { ctl, agentId, chatId, untilId, sessionId, parked }
const starting = new Set();       // pairs between call and own row (synchronous — no two starts at the same moment)
const afterRun = new Set();       // pairs with a trigger during an open run
const wakeup = new Map();         // runId → { aus, fn } — wakeups of parked runs (gate) in this server run
const atGate = new Map();         // runId → since when parked at the CREDIT gate (not at the project lock) — wakeOuterLoopAtGate
// The beginning of the park reason at the gate, per language — the same sentence is read in the restart grace to
// recognise the runs parked at the gate (the row carries no marker of its own; see wakeParkedOuterLoop).
// A stored reason was written in the language of its moment — it is recognised in both.
const isGateReason = (text) => typeof text === "string" && (text.startsWith("Credit gate:") || text.startsWith(DE["Credit gate:"]));
let closed = false;                   // the server run is ending: nothing starts anymore, nothing writes anymore

function report(runId) {
  try {
    const l = store.outerLoopRun(runId);
    if (l) broadcast({ type: "outer_loop", agentId: l.agentId, chatId: l.chatId, runId: l.id, state: l.state, run: publicRun(l) });
  } catch (e) { console.error("[outer-loop] event:", e?.message || e); }
}

/**
 * Is the agenda keeper waiting? It only starts in a QUIET chat — the same check as its write path (agenda/upkeep.js
 * upkeepQuietReason), synchronous. Always false for every other agent: they only read.
 */
export const keeperWaiting = (agent, chatId) => Boolean(agent?.agendaKeeper) && upkeepQuietReason(chatId) !== null;

/** Does the pair have an open run (running or parked) — or is one being created right now? */
export function pairOpen(agentId, chatId) {
  if (starting.has(paar(agentId, chatId)) || store.outerLoopRunningOn(agentId, chatId)) return true;
  return store.outerLoopRunsParked().some((l) => l.agentId === agentId && l.chatId === chatId);
}

// Built-in tools with which Codex may write (input.js CODEX_WRITES — ONE list for execution and frame): if any are
// selected it runs `acceptEdits` (workspace-write), else read-only; without selected built-ins also without a shell
// (runs/agents.js).
const permissionModeFor = (agent, set) =>
  agent.provider === "codex" && set.builtin.some((t) => CODEX_WRITES.includes(t)) ? "acceptEdits" : "default";

async function gateVerdict({ agent, chat, instance, attempts }) {
  const projectId = instance?.projectId ? String(instance.projectId) : null;
  const identifier = projectId ? instanceIdentifierOf(instance) : null;
  let u;
  try { u = await startGateVerdict({ provider: agent.provider, model: agent.model, chatId: chat.id, purpose: "agent", ...(projectId ? { projectId } : {}), ...(identifier ? { identifier } : {}) }); }
  catch { return null; }
  if (!u || u.ok === true) return null;
  if (u.project) {
    return u.project.kind === "wait"
      ? { until: Date.now() + projectCheckBackMs(), reason: String(u.text || T("project container not ready")), project: true }
      : { error: String(u.text || T("project locked")) };
  }
  const reset = Number(u.window?.resetsAt) || 0;
  const window = String(u.window?.label || u.window?.group || "?");
  return {
    until: reset > Date.now() ? reset : Date.now() + probeDelayMs(attempts),
    reason: T`${T("Credit gate:")} ${window} at ${typeof u.percent === "number" ? u.percent : "?"} %`,
  };
}

function wakeupOff(runId) {
  const w = wakeup.get(runId);
  wakeup.delete(runId);
  try { w?.cancel(); } catch { /* a wakeup must not topple anything */ }
}

function setWakeup(runId, until) {
  wakeupOff(runId);
  const fn = () => { wakeup.delete(runId); wakeParked(runId); };
  const cancel = setParkWakeup(Math.max(0, Number(until) - Date.now()), fn);
  wakeup.set(runId, { cancel, fn });
}

/** Continue a parked run (gate) — from the wakeup, the tick (safety net), the restart grace or the gate wakeup (account switch). */
export function wakeParked(runId) {
  if (closed) return;
  atGate.delete(runId); // if it parks at the gate again right away, park() enters it anew
  const l = store.outerLoopRun(runId);
  if (!l || l.state !== "parked" || cores.has(runId)) return;
  const agent = store.outerLoopAgent(l.agentId);
  const chat = store.getChat(l.chatId);
  if (!agent || !chat) {
    if (store.outerLoopRunState(runId, "aborted", { error: T("agent or chat gone") })) report(runId);
    return;
  }
  startOuterLoopRun({ agent, chat, trigger: l.trigger, runId }).catch((e) => console.error("[outer-loop] wakeup:", e?.message || e));
}

function park(runId, until, reason, { atCreditGate = false } = {}) {
  const z = store.outerLoopRunState(runId, "parked", { parkedUntil: until, error: reason });
  if (!z) return;
  if (atCreditGate) atGate.set(runId, Date.now()); else atGate.delete(runId);
  report(runId);
  setWakeup(runId, until);
}

function end(runId, fields) {
  const ok = store.outerLoopRunEnd(runId, fields);
  if (ok) report(runId);
  return ok;
}

/**
 * Start a run (or continue a parked one). → `{ started, reason?, runId? }` (promise; triggers do not wait).
 * @param {{ agent: object, chat: object, trigger: string, runId?: string|null }} o
 */
export async function startOuterLoopRun({ agent: agentRaw, chat: chatRaw, trigger, runId = null }) {
  if (closed) return { started: false, reason: "serverEnd" };
  const agent = store.outerLoopAgent(agentRaw?.id ?? agentRaw);
  const chat = store.getChat(chatRaw?.id ?? chatRaw);
  if (!agent || !chat) return { started: false, reason: "gone" };
  const p = paar(agent.id, chat.id);
  // 1. At most one open run per pair — a trigger in the meantime remembers a follow-up run.
  if (!runId && pairOpen(agent.id, chat.id)) { afterRun.add(p); return { started: false, reason: "running" }; }
  const current = activation(agent, chat);
  if (!current.active) {
    if (runId && store.outerLoopRunState(runId, "aborted", { error: T`no longer active (${current.source})` })) report(runId);
    return { started: false, reason: current.source };
  }
  // The agenda keeper only in a quiet chat. Quiet and tick already check before (re-arm the timer, defer the clock time);
  // "after every run end", follow-up and the wakeup of a parked run only pass through here. No row, no watermark — before
  // step 3, which creates the row synchronously.
  if (agent.agendaKeeper) {
    const quiet = upkeepQuietReason(chat.id);
    if (quiet) {
      // A CODE, not a sentence (intended-end.js): an intended deferral both clients show calmly — the reason is in the log.
      if (runId && store.outerLoopRunState(runId, "aborted", { error: INTENDED_END.quiet })) {
        console.log(`[outer-loop] parked run ${runId} of the agenda keeper deferred: chat not quiet (${quiet})`);
        report(runId);
      }
      return { started: false, reason: "chat-working", quiet };
    }
  }
  // 2. The watermark.
  const last = store.outerLoopLastFinishedRun(agent.id, chat.id);
  const fromId = last ? Number(last.untilMessageId) || 0 : 0;
  const since = last ? 0 : Number(sinceFor(agent, chat)) || 0;
  const fresh = store.outerLoopNewRows(chat.id, { fromId, since, roles: OUTER_LOOP_ROLES });
  if (!fresh.count) {
    if (runId && store.outerLoopRunState(runId, "aborted", { error: T("nothing new anymore") })) report(runId);
    return { started: false, reason: "nothing-new" };
  }
  // 2a. The stage of the track (track.js; only a gapless agent, else 0). A parked run keeps its own. If even the smallest
  // track failed, it is skipped — visible as a row of its own, never silently.
  const stage = runId ? null : nextStage(agent, chat);
  if (stage !== null && stage > STAGE_MAX) return skipTrack({ agent, chat, trigger, fromId, since, last });
  // 3. Set and row — synchronous. Only a run that works on the project gets the location of the chat (cwd of the project,
  // instance): selected cbase or built-in tools, on a project chat also a selected coding server (set.js needsProject).
  let instance = null;
  const atProject = needsProject(agent, chat);
  let run;
  starting.add(p);
  try {
    if (atProject) instance = instanceOfChat(chat, locationForChat(chat));
    const set = outerLoopSet(agent, chat, { withToken: Boolean(atProject && instance) });
    run = runId
      ? store.outerLoopRunState(runId, "running", { increaseAttempts: true, set: setRow(set) })
      : store.createOuterLoopRun({ id: crypto.randomUUID(), agentId: agent.id, chatId: chat.id, trigger, fromMessageId: fromId, set: setRow(set), provider: agent.provider, model: agent.model, stage });
    if (!run) return { started: false, reason: "gone" };
    run.setFull = set;
  } catch (e) {
    // A copy that no longer exists, a broken set: the run fails visibly instead of silently missing.
    const reason = String(e?.message || e).slice(0, 2000);
    if (runId) end(runId, { state: "error", error: reason });
    else {
      const l = store.createOuterLoopRun({ id: crypto.randomUUID(), agentId: agent.id, chatId: chat.id, trigger, fromMessageId: fromId, provider: agent.provider, model: agent.model });
      end(l.id, { state: "error", error: reason });
    }
    return { started: false, reason: "error" };
  } finally { starting.delete(p); }
  const id = run.id;
  report(id);
  // 4. The start gate.
  const gate = await gateVerdict({ agent, chat, instance, attempts: run.attempts });
  if (closed || !store.outerLoopRunApplies(id)) return { started: false, reason: "gone", runId: id };
  if (gate?.error) { end(id, { state: "error", error: gate.error }); return { started: false, reason: "gate", runId: id }; }
  if (gate) {
    if (!gate.project && (!autoContinueEnabled() || run.attempts >= MAX_CONTINUES)) {
      const why = !autoContinueEnabled()
        ? T("auto-continue is off — the run does not wait")
        : T`gave up after ${run.attempts} attempts`;
      end(id, { state: "error", error: `${gate.reason} — ${why}` });
      return { started: false, reason: "gate", runId: id };
    }
    park(id, gate.until, gate.reason, { atCreditGate: !gate.project });
    return { started: false, reason: "parked", runId: id };
  }
  // 5. The core.
  return startCore({ agent, chat, run, instance, atProject, fromId, since, last });
}

// Skip the smallest track (track.js): the core failed on it even on stage STAGE_MAX. A row `finished` on stage STAGE_MAX
// with the reason in the error field (like "no note") and the watermark behind exactly the track a run on this stage would
// have read (the same computation: buildInput) — the next run reads on behind it, one stage larger. If unread rows still
// lie above, the follow-up run fetches them at once. No core, no consumption.
function skipTrack({ agent, chat, trigger, fromId, since, last }) {
  const e = buildInput({ agent, chat, fromId, since, sinceDisplay: last?.endedAt || since, lastNote: null, trigger, stage: STAGE_MAX });
  const untilId = Number(e.untilId) || fromId;
  const l = store.createOuterLoopRun({ id: crypto.randomUUID(), agentId: agent.id, chatId: chat.id, trigger, fromMessageId: fromId, provider: agent.provider, model: agent.model, stage: STAGE_MAX });
  report(l.id);
  const reason = T`Stretch skipped: history lines ${fromId + 1}–${untilId} not evaluated — even the smallest stretch failed (last at the step cap or another error in the run).`;
  console.error(`[outer-loop] ${agent.name} on chat ${chat.id}: ${reason}`);
  end(l.id, { state: "finished", error: reason, untilMessageId: untilId });
  if (e.rest) afterRun.add(paar(agent.id, chat.id));
  afterRunCheck(agent.id, chat.id, "finished");
  return { started: false, reason: "skipped", runId: l.id };
}

async function startCore({ agent, chat, run, instance, atProject, fromId, since, last }) {
  const id = run.id;
  const set = run.setFull;
  const trigger = run.trigger;
  let ctl = null;
  let entry = null;
  try {
    const projectName = chat.projectId ? store.getProject(chat.projectId)?.name || "" : "";
    const input = buildInput({ agent, chat, fromId, since, sinceDisplay: last?.endedAt || since, lastNote: store.outerLoopLastNote(agent.id, chat.id), trigger, stage: run.stage });
    const context = {
      chat,
      cwd: atProject ? resolveCwd(chat, { instance }) : DIRS.empty,
      instance: atProject ? instance : null,
      // The runtime folder (MCP file, profile, outputs) — the chat's ONLY with an instance. Without an instance the CLI runs
      // in the backend and reads its MCP file via the path name; in the runtime folder of a converted project (mounted rw
      // in the project container) the container could replace it between write and read, and an injected `command` would
      // run in the backend. Hence the flat location of the backend; cleanup at the agent's end takes the location of the
      // core, the chat's closing path every location (runs/runtime-location.js cleanUpChatRuntime).
      runtime: atProject && instance ? locationForChat(chat) : locationFor({}),
      provider: agent.provider,
      agentDefs: [],
      depth: 1,
      profile: { permissionMode: permissionModeFor(agent, set), addDirs: [], builtinTools: set.builtin },
      // The selected coding servers as wrappers of the airlock (token role `outer_loop`) — `extern` carries the same
      // servers with the selected tools for allowlist and engine (runs/agents.js).
      tools: { toolset: null, cbase: set.cbase, extraServers: set.extern.map((x) => x.source), extern: set.extern, mcpAllow: externalNames(set), skills: [] },
      limit: { window: limitWindowsFor, autoContinueOn: autoContinueEnabled },
      hold: true,
      deliver: null,
      overruled: false,
      booking: { chatId: chat.id, source: "outer_loop", agentId: agent.id },
    };
    entry = { ctl: null, agentId: agent.id, chatId: chat.id, untilId: input.untilId, rest: Boolean(input.rest), sessionId: "", parked: false };
    cores.set(id, entry);
    ctl = openAgents(context, {
      event: () => {},
      atEnd: (rec, info) => { try { ctl?.takeReports(); } catch { /* empty */ } runEnd(id, info); },
    }, {
      own: true,
      outerLoop: { agentId: agent.id, runId: id },
      frame: outerLoopFrame(agent, chat, set, { projectName }),
      // The history of a run does not belong in the observed chat (it appears in no agent rail).
      sink: () => {},
      deposit: { remember: (image) => parkState(id, image), row: () => {} },
    });
    entry.ctl = ctl;
    await ctl.start({
      description: `Outer Loop ${agent.name}`,
      prompt: input.text,
      model: `${agent.provider}::${agent.model}`,
      ...(agent.effort ? { effort: agent.effort } : {}),
      run_in_background: true,
    }, { parentToolUseId: `outerloop:${agent.id}:${id}` });
    return { started: true, runId: id };
  } catch (e) {
    // The start failed (gate in the core, spawn, spec): core closed, row `error` — only if the run still applies.
    cores.delete(id);
    if (ctl) { try { ctl.silence(); ctl.close(); } catch { /* already closed */ } }
    if (!closed && store.outerLoopRunApplies(id)) end(id, { state: "error", error: String(e?.message || e).slice(0, 2000) });
    afterRunCheck(agent.id, chat.id, "error");
    return { started: false, reason: "error", runId: id };
  }
}

// The state of the agent at every sign of life (deposit of the core): the session for the end, parking and resuming mid-run.
function parkState(runId, image) {
  const k = cores.get(runId);
  if (!k || closed) return;
  // The session into the row at once (the first one counts): an aborted run would otherwise leave its transcript behind —
  // the chat's closing path only finds sessions that are in a row.
  if (image?.sessionId && !k.sessionId) {
    k.sessionId = String(image.sessionId);
    try { store.outerLoopRunSession(runId, k.sessionId); } catch (e) { console.error("[outer-loop] session:", e?.message || e); }
  } else if (image?.sessionId) k.sessionId = String(image.sessionId);
  if (image?.status === "parked" && !k.parked) {
    k.parked = true;
    if (store.outerLoopRunState(runId, "parked", { parkedUntil: Number(image.parkedUntil) || null, error: T("parked at the usage limit") })) report(runId);
  } else if (image?.state === "running" && k.parked) {
    k.parked = false;
    if (store.outerLoopRunState(runId, "running")) report(runId);
  }
}

// The end of the one agent of a run (step 6).
function runEnd(runId, info) {
  const k = cores.get(runId);
  cores.delete(runId);
  const ctl = k?.ctl;
  if (ctl) setImmediate(() => { try { ctl.close(); } catch { /* already closed */ } });
  if (closed || !k) return;
  if (!store.outerLoopRunApplies(runId)) return;
  const r = info?.report || {};
  const u = info?.usage || {};
  const run = store.outerLoopRun(runId);
  const provider = info?.provider || run?.provider || "";
  const model = info?.model || run?.model || "";
  const billing = info?.billing === "metered" ? "metered" : "subscription";
  let cost = null;
  // Reported cost (OpenRouter, USD — `u.cost`, only if every round carried an amount) takes precedence over the estimate
  // at the catalog price (prices.js). A subscription has none (null).
  try { cost = costFor({ model, input: u.input, output: u.output, cached: u.cached, billing, reported: u.cost }); } catch { cost = null; }
  const consumption = { provider, model, billing, input: Number(u.input) || 0, output: Number(u.output) || 0, cached: Number(u.cached) || 0, cost, sessionId: k.sessionId || "" };
  const raw = String(r.report || "").trim();
  const text = r.status === "completed" && raw !== NO_REPORT ? withoutFenceLeftovers(raw) : "";
  let state;
  if (r.status === "completed" && text) {
    store.createOuterLoopNote({ agentId: k.agentId, chatId: k.chatId, runId, text });
    state = end(runId, { state: "finished", untilMessageId: k.untilId, ...consumption }) ? "finished" : "";
  } else if (r.status === "completed") {
    state = end(runId, { state: "finished", error: T("no note"), untilMessageId: k.untilId, ...consumption }) ? "finished" : "";
  } else {
    const reason = String(r.error || r.status || T("failed")).slice(0, 2000);
    state = end(runId, { state: "error", error: reason, ...consumption }) ? "error" : "";
  }
  // Only `gapless`: the input was truncated — unread rows lie above the new watermark. A finished run fetches them at once
  // in the follow-up run until the track is empty (startOuterLoopRun: "nothing new" ends the chain).
  if (k.rest && state === "finished") afterRun.add(paar(k.agentId, k.chatId));
  afterRunCheck(k.agentId, k.chatId, state);
}

// If a trigger arrived during the run and it ended `finished`, the follow-up run starts at once — `startOuterLoopRun` checks
// itself whether there is anything new since its state. A run that failed takes the marker with it: the watermark still
// stands, the next trigger catches up.
function afterRunCheck(agentId, chatId, state) {
  const p = paar(agentId, chatId);
  if (!afterRun.has(p)) return;
  afterRun.delete(p);
  if (state !== "finished" || closed) return;
  const agent = store.outerLoopAgent(agentId);
  const chat = store.getChat(chatId);
  if (agent && chat) startOuterLoopRun({ agent, chat, trigger: "afterRun" }).catch((e) => console.error("[outer-loop] follow-up:", e?.message || e));
}

/**
 * The abort (the aborter of outerloop/abort.js and the hook "chatClosed"): silence and close the cores of the runs of these
 * agents or this chat, take their wakeups and follow-up markers. The rows are written by the delete path. → number of cores.
 * @param {{ agentIds?: string[], chatId?: string, runIds?: string[] }} o
 */
export function outerLoopCoresSilence({ agentIds = null, chatId = null, runIds = null } = {}) {
  // Exactly these runs (deleting a project): only their cores and wakeups — the follow-up marker of their pair stays (an
  // aborted run does not take it anyway: afterRunCheck only runs at the end of a core).
  if (Array.isArray(runIds)) {
    const lids = new Set(runIds.map(String));
    let m = 0;
    for (const [runId, k] of [...cores]) {
      if (!lids.has(runId)) continue;
      cores.delete(runId);
      m += 1;
      try { k.ctl?.silence(); k.ctl?.close(); } catch (e) { console.error("[outer-loop] core:", e?.message || e); }
    }
    for (const runId of [...wakeup.keys()]) if (lids.has(runId)) wakeupOff(runId);
    return m;
  }
  const ids = Array.isArray(agentIds) ? new Set(agentIds.map(String)) : null;
  const hits = (agentId, cId) => (ids ? ids.has(String(agentId)) : String(cId) === String(chatId));
  let n = 0;
  for (const [runId, k] of [...cores]) {
    if (!hits(k.agentId, k.chatId)) continue;
    cores.delete(runId);
    n += 1;
    try { k.ctl?.silence(); k.ctl?.close(); } catch (e) { console.error("[outer-loop] core:", e?.message || e); }
  }
  for (const runId of [...wakeup.keys()]) {
    const l = store.outerLoopRun(runId);
    if (!l || hits(l.agentId, l.chatId)) wakeupOff(runId);
  }
  for (const p of [...afterRun]) {
    const [agentId, cId] = p.split("|");
    if (hits(agentId, cId)) afterRun.delete(p);
  }
  return n;
}

/** Start: `running` of a dead process ⇒ `aborted`, synchronous. Resets the state of this module for the new server run. */
export function outerLoopRunsAtStart() {
  closed = false;
  return store.abortOuterLoopRuns(T("server restarted — the next trigger catches up"));
}

/** Restart grace: set the wakeups of the parked runs anew (time has kept running since parking). → count. */
export function wakeParkedOuterLoop() {
  let n = 0;
  for (const l of store.outerLoopRunsParked()) {
    if (wakeup.has(l.id) || cores.has(l.id)) continue;
    // Parked at the gate (recognised by the park reason): the gate wakeup may wake it early. `since` 0 — this process does
    // not know when it was parked; every stored measurement is at least as recent as the one the gate parked on.
    if (isGateReason(store.outerLoopRun(l.id)?.error)) atGate.set(l.id, 0);
    setWakeup(l.id, l.parkedUntil ?? Date.now());
    n += 1;
  }
  return n;
}

/** The tick as a safety net (sleep, time jump): continue parked runs whose time has come and that no core carries. */
export function outerLoopParkedDue(now = Date.now()) {
  let n = 0;
  for (const l of store.outerLoopRunsParked()) {
    if (cores.has(l.id) || l.parkedUntil === null || l.parkedUntil > now) continue;
    wakeupOff(l.id);
    wakeParked(l.id);
    n += 1;
  }
  return n;
}

/**
 * Continue runs parked at the credit gate early (account switch): if a measurement AFTER parking shows the gate free for
 * every model (runs/limit-gate.js gateFreeForAllByMeasurement, without a network call), a run does not wait for the reset
 * of the window that held it — after an account switch that would be the reset of the OLD account. Called in the tick of
 * the sweeper (server.js). Runs parked at the project lock are not included. → number woken.
 */
export function wakeOuterLoopAtGate() {
  let n = 0;
  for (const [runId, since] of [...atGate]) {
    if (closed) break;
    if (cores.has(runId)) continue;
    if (store.outerLoopRun(runId)?.state !== "parked") { atGate.delete(runId); continue; }
    if (!gateFreeForAllByMeasurement({ since })) continue;
    wakeupOff(runId);
    wakeParked(runId);
    n += 1;
  }
  return n;
}

/** Server end: everything silent — cores closed (without writing), wakeups gone, markers gone. The rows stay (`running` ⇒ next start). */
export function outerLoopRunAtServerEnd() {
  closed = true;
  for (const [runId, k] of [...cores]) {
    cores.delete(runId);
    try { k.ctl?.silence(); k.ctl?.close(); } catch { /* already closed */ }
  }
  for (const runId of [...wakeup.keys()]) wakeupOff(runId);
  atGate.clear();
  afterRun.clear();
  starting.clear();
}

// ── Test seams ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** Fire the wakeups of parked runs NOW, as if the reset had been reached. → count. */
export function outerLoopWakeParkedNow() {
  const all = [...wakeup.entries()];
  for (const [runId, w] of all) { try { w.cancel(); } catch { /* empty */ } wakeup.delete(runId); w.fn(); }
  return all.length;
}
/** How many cores are open. */
export const outerLoopCoreCount = () => cores.size;
/** Does the pair have a follow-up marker? */
export const outerLoopAfterRunMarker = (agentId, chatId) => afterRun.has(paar(agentId, chatId));
