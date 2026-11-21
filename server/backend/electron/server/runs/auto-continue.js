// Auto-continue: notification and view (limitNotification, autoContinueView), scheduling and firing the continuation
// (scheduleAutoContinue, fireAutoContinue/Inner, sweepAutoContinues), clearing the rows, parked verdicts (parkJudge,
// resumeJudge, judgeReparked), isLimitError, runInputsRestartGrace.
// No domain is imported here: what the workflow and schedule side does goes through the hooks afterLimitCancel (wait
// row discarded) and afterCompactResume (parked compaction caught up) and the switches "followUpRun" (a waiting
// workflow takes the queued message) and "verdict" (a parked workflow verdict re-enters); subscribers and responders
// are registered in server.js. CAUSES lives in runs/state.js.

import { providerForChat } from "../providers/index.js";
import * as limits from "../limits.js";
import * as store from "../store.js";
import { T } from "../i18n.js";
import { recordNotice } from "../services.js";
import { autoContinueEnabled, autoContinueFiring, autoContinueSweepMs, autoContinueTimers, clearAutoContinueTimer, clockText, gateFreeByMeasurement, gateFreeForAllByMeasurement, creditGateOn, limitGroupText, limitWindowsFor, parkOrQueue, lockingWindow, waitTimeFor, rowMayWrite } from "./limit-gate.js";
import { broadcast, sse } from "../runtime/sse.js";
import { compactChatContext, goalGateAfterRun, targetResumptionDropped } from "./post-run.js";
import { CAUSES, compacting, pendingRunInputs, persistRunInputs, running, workflowDecides } from "./state.js";
import { startRun } from "./do-run.js";
import { fireHooks, turnout } from "./hooks.js";
import { emitPendingInputs, controlActive, takeNextRunInput } from "./queue.js";
import { onlyReadable, onlyReadableText } from "./only-readable.js";
import { managerLocked } from "./manager-lock.js";
import { isLockReason, rememberHalted, takeHalted, withoutTransition, projectCheckBackMs, startLock } from "./project-lock.js";


// Notification about the usage limit: once when parking, once when continuing. Both are needed — when parking, the
// "answer finished" notice is explicitly suppressed (the answer is incomplete), and with a weekly window days can
// pass until it continues. The collapse id separates the two halves: otherwise the second would overwrite the first.
function limitNotification(chat, { parking, text }) {
  if (!chat) return;
  const name = chat.title || "Chat";
  try {
    recordNotice({
      kind: "limit",
      title: parking ? T`Waiting: ${name}` : T`Continuing: ${name}`,
      chatTitle: chat.title || "",
      body: String(text || "").slice(0, 300),
      chatId: chat.id,
      workspaceId: chat.workspaceId || null,
      collapseId: `${chat.id}-limit-${parking ? "park" : "further"}`,
    });
  } catch (e) { console.error("[limit] notification:", e?.message || e); }
}

function autoContinueView(row) {
  // A running chat waits for nothing: during the continuation the row stays (it carries the attempt counter and
  // slips six hours back) but is no wait state — otherwise the clients would show a countdown and an active "start
  // anyway" during the running turn. ONE place for it: all views (route per chat, global list, SSE) pass through here.
  if (!row || running.has(row.chatId)) return null;
  const compact = row.kind === "compact";
  // The credit gate intercepted the start — NOTHING failed. The sentence must say so, otherwise the card reads like a
  // failure, and the button next to it is "start anyway (costs credit)" here instead of "try now". Each kind has its
  // word: a waiting verdict or a waiting compaction is no "turn".
  const gateLabel = compact ? T("Compaction waiting") : row.kind === "judge" ? T("Verdict waiting") : T("No new turn");
  // The lock per project: no limit, no gate — the project's instance is working (relocation, start, recreation), or
  // the server is ending. The transition to ready wakes the row, not the clock: no time of day.
  const waiting = row.reason === "project"
    ? T`${gateLabel} — the project container is not ready yet. Continues as soon as it is.`
    : row.reason === "serverEnd"
    ? T`${gateLabel} — the server is restarting. Continues afterwards.`
    : row.reason === "credit"
    // A promise only with a known reset: a probing gate row carries `resetsAt` 0 — "continuing at <probe time>"
    // would be a promise the next look breaks.
    ? (row.dueAt && row.resetsAt
      ? T`${gateLabel} — window full. Continuing at ${clockText(row.dueAt)}`
      : T`${gateLabel} — window full.`)
    : row.reason === "probe"
    ? T("Reset time unknown — checking back regularly.")
    : compact
      ? T`Compacting at ${clockText(row.dueAt)}`
      : T`Continuing at ${clockText(row.dueAt)}`;
  return {
    chatId: row.chatId,
    kind: row.kind || "run",
    provider: row.provider || "",
    group: row.limitGroup || "",
    label: row.limitLabel || "",
    limitText: limitGroupText(row.limitGroup, row.limitLabel),
    reason: row.reason || "reset",
    // An explicit marker instead of a text comparison: here the credit gate intercepted the START (nothing failed),
    // and the button's label depends on exactly that.
    gate: row.reason === "credit",
    resetsAt: row.resetsAt || null,
    dueAt: row.dueAt || 0,
    attempts: row.attempts || 0,
    probes: row.probes || 0,
    maxAttempts: limits.MAX_CONTINUES,
    evidence: row.evidence || "",
    workflow: !!row.workflow,
    createdAt: row.createdAt || 0,
    updatedAt: row.updatedAt || 0,
    text: waiting,
  };
}

// Row in the history (persisted as role "limit" so it survives a reload) + live event.
function limitLine(chatId, payload) {
  const line = { at: Date.now(), ...payload };
  try { store.addMessage(chatId, "limit", JSON.stringify(line)); } catch {}
  // Payload NESTED: a `type` field of its own in the row would otherwise overwrite the envelope and let the event
  // bypass the harness branch.
  sse(chatId, { type: "harness", subtype: "limit_line", line });
}
function emitAutoContinue(chatId, row) {
  const view = autoContinueView(row);
  sse(chatId, { type: "harness", subtype: "limit_wait", wait: view });
  broadcast({ type: "limit_wait", chatId, waiting: !!view });
}

function scheduleAutoContinue(row, { now = Date.now() } = {}) {
  if (!row) return;
  clearAutoContinueTimer(row.chatId);
  // 2^31-1 ms is the upper bound of setTimeout — above it fires AT ONCE. The sweeper takes over longer waits.
  const delay = Math.max(1_000, Math.min(row.dueAt - now, 2 ** 31 - 1));
  const t = setTimeout(() => {
    autoContinueTimers.delete(row.chatId);
    fireAutoContinue(row.chatId).catch((e) => console.error("[limit] continuation failed:", e?.message || e));
  }, delay);
  t.unref?.();
  autoContinueTimers.set(row.chatId, t);
}

// Start the next queue entry as a run of its own — ONE form for all places that do it (run end in doRun, end of
// compaction, discarded wait row). If a workflow run is waiting in this chat, the queued message is its ANSWER —
// just like a message via /message. As a turn of its own it would bypass the run, which would stay waiting forever
// and hold its lock. Whether a workflow waits and takes the message is answered by the switch "followUpRun"
// (responder in workflows/gates.js) — SYNCHRONOUSLY: the answer itself continues there as fire-and-forget, and
// without a responder the own turn starts.
function startFollowUpRun(chatId, next) {
  if (!next) return false;
  queueMicrotask(() => {
    const current = store.getChat(chatId);
    if (!current) return;
    if (turnout("followUpRun", { chat: current, next }) !== undefined) return;
    startRun(current, next.prompt, { attachments: next.attachments, cause: next.cause || "user", inputs: next.inputs || [] });
  });
  return true;
}

// Start the queue of a chat that NOTHING occupies right now as a follow-up run — for the places where a window
// WITHOUT a turn ends and a queued entry would otherwise stay: the end of a decision of the graph workflow
// (workflows/gates.js, workflows/driver.js) and the early return of the compaction (post-run.js compactChatContext).
// A chat is occupied by a turn, a compaction, an open workflow decision (state.js workflowDecides) and a run wait row
// ("parked is like running" — its continuation drains the queue). If the workflow waits for the human (question, cap,
// review), a USER message in front is its answer (switch "followUpRun"); a channel, event or agent row in front
// stays — it answers no question of the human, and as a turn it would bypass the waiting run. It goes with the run's
// next turn (at the `result`) or after the answer.
function drainQueue(chatId) {
  if (running.has(chatId) || compacting.has(chatId) || workflowDecides.has(chatId)) return false;
  const header = pendingRunInputs.get(chatId)?.[0];
  if (!header) return false;
  if (store.getPendingResume(chatId)?.kind === "run") return false;
  if ((header.cause || "user") !== "user" && store.getWorkflowRun(chatId)?.status === "waiting") return false;
  return startFollowUpRun(chatId, takeNextRunInput(chatId));
}

// At the run end: clear the run row — ONLY it. A compact or judge row waits for something other than this turn and
// stays. Three places in doRun (code 0, error, abort) do the same.
function clearAwayRunRow(chatId) {
  const pr = store.getPendingResume(chatId);
  if (!pr || (pr.kind || "run") !== "run") return false;
  store.clearPendingResume(chatId);
  clearAutoContinueTimer(chatId);
  emitAutoContinue(chatId, null);
  return true;
}
// The counterpart for a parked VERDICT: a judge row hangs on a node of the workflow. If the node goes away (the run
// ends, the step is skipped), the re-entry is moot — otherwise it would fire after the reset into a run that no
// longer exists, and until then the chat would show a wait strip for a verdict nobody waits for.
// Only the judge row: a run row carries the user's task, a compact row the catching up of the summary — both
// survive the end of a workflow.
function clearAwayJudgeRow(chatId) {
  const pr = store.getPendingResume(chatId);
  if (!pr || pr.kind !== "judge") return false;
  store.clearPendingResume(chatId);
  clearAutoContinueTimer(chatId);
  emitAutoContinue(chatId, null);
  return true;
}

// Read-only (runs/only-readable.js): whatever could still start a turn of this chat goes — the inherited active_runs
// row (otherwise every restart would run into it again), the wait row with its timer (otherwise it would fire at the
// reset) and an inherited queue (otherwise its head would start). Silently: nothing into the history (the chat is
// read-only), no follow-up run, no hooks — there was no turn, so no turn end either, and no schedule or workflow
// end: neither exists in this kind.
function clearAwayOnlyReadable(chatId) {
  clearAutoContinueTimer(chatId);
  try { store.clearActiveRun(chatId); } catch {}
  try {
    if (store.getPendingResume(chatId)) { store.clearPendingResume(chatId); emitAutoContinue(chatId, null); }
  } catch (e) { console.error(`[run] ${chatId}: wait row not cleared:`, e?.message || e); }
  if (pendingRunInputs.has(chatId)) {
    pendingRunInputs.delete(chatId);
    persistRunInputs(chatId);
    emitPendingInputs(chatId);
  }
  console.log(`[run] ${chatId}: ${onlyReadableText()} No turn.`);
}

// Discard the wait row. `kind` says WHO discards: "cancel" (the default) is a path of the human — the strip
// (DELETE), steering, clearing the chat, an aborted workflow; "gave-up" (attempt cap), "off" (toggle off),
// "credits"/"too-long" (situation) are the machine. `reason` is the wording for the hook where no `note` is written
// as a row (the row was already there).
//
// What hangs on the row hangs on it — not on the reason:
//   · A SCHEDULE run whose `run` row goes is over; its reason is the error. Otherwise it would stay running forever
//     and the schedule would never fire again.
//   · A WORKFLOW whose row goes has failed — on EVERY discard, also the explicit one by the user ("cancel"): a
//     "running" workflow without a driver is never a usable state, it only holds its lock. The strip says BEFORE
//     cancelling that a workflow hangs on it and ends as failed (`wait.workflow`). Whoever ends the workflow itself
//     ends it BEFORE discarding the row — then it is already over here, and the reason stays "cancelled by the user".
//   · The QUEUE gets a runner: what was queued behind the row has nobody left to start it without it.
// If the chat is running, its run end belongs to the running doRun (finally: schedule row with the real error text,
// workflow, queue) — then only the row is cleared here.
function cancelAutoContinue(chatId, { note = "", kind = "cancel", reason = "" } = {}) {
  clearAutoContinueTimer(chatId);
  const row = store.getPendingResume(chatId);
  if (!row) return false;
  store.clearPendingResume(chatId);
  if (note) limitLine(chatId, { kind, group: row.limitGroup, label: row.limitLabel, text: note });
  emitAutoContinue(chatId, null);
  const chat = store.getChat(chatId);
  if (!chat || running.has(chatId)) return true;
  // Hook "afterLimitCancel", subscribers in this order: the scheduled end (scheduled/run.js — only a run of a job)
  // and the workflow end (workflows/driver.js — only if the row carried a workflow and it is still running); both
  // check that themselves. Synchronous.
  fireHooks("afterLimitCancel", { chat, row, note, kind, reason: reason || note });
  // During a compaction or "steering" the respective path starts itself (see there).
  if (!compacting.has(chatId) && !controlActive.has(chatId)) startFollowUpRun(chatId, takeNextRunInput(chatId));
  return true;
}

// After a failed run: was it the usage limit? Then take over (true) — the caller must then NOT treat the run as an
// error.
//
// `events`     — additional evidence texts (a subagent's error, see doRun). They come from the event stream, not
//                from stderr, because a subagent can fail without ending the process.
// `kind`       — "run" (repeat the turn) or "compact" (catch up the compaction).
// `requireReset` — park only if a CONCRETE reset time is known. For cases where the limit is not evidenced by a
//                process error but only by a text: probing "on suspicion" would be wrong there — a run that ended
//                cleanly would be repeated on the off chance.
// `resumption`, `cause` — only for `kind: "run"`: go to parkOrQueue (see there).
// `gate`       — the START GATE intercepted the call (`err.gate` from runOnce: { window, percent }), not the CLI:
//                nothing failed, the call just did not begin. The row then belongs to toggle B (reason "credit"), and
//                toggle A has NOTHING to say here: it is written and woken also with A off, A off does not discard
//                it, and the strip shows "start anyway". This holds for an intercepted verdict or compaction just as
//                for a turn — otherwise the workflow would end as failed at the first verdict with A off.
async function maybeAutoContinue(chat, {
  providerId, res, prompt, goalDepth = 0, attachments = null,
  events = [], kind = "run", payload = null, requireReset = false, resumption = false, cause = "user", gate = null,
}) {
  const now = Date.now();
  // `errorText` before `resultText`: a connector that supplies the field says which text was an ERROR —
  // `resultText` is always model text with Codex and the loop engine. Without the field (callers that build `res`
  // themselves) as before.
  const hit = limits.detectLimitHit({ resultText: (typeof res?.errorText === "string" ? res.errorText : res?.resultText) || "", stderr: res?.stderr || "", events, now });
  if (!hit.hit) return false;
  // If the START GATE intercepted, the row waits as long as the gate holds — from the same windows, via the same
  // model (`gate.model`, runOnce), on which it just locked (limit-gate.js waitTimeFor). chooseWait would take the
  // latest reset of ALL time locks from 98 % — a week at 98.5 % would hold the row until the weekly reset although
  // the gate was free again after the session.
  const gateModel = gate && typeof gate.model === "string" ? gate.model : undefined;
  const windows = await limitWindowsFor(providerId, gateModel ? { ...chat, model: gateModel } : chat);
  const wait = gate
    ? waitTimeFor({ gateRow: true, chat, providerId, windows, now, model: gateModel, hintResetAt: hit.resetAt })
    : limits.chooseWait({ windows, now, hintResetAt: hit.resetAt, creditsHint: hit.credits });
  const group = wait.window?.group || (hit.credits ? limits.GROUPS.CREDITS : "");
  const label = wait.window?.label || group;
  const common = { group, label, evidence: hit.evidence, limitText: limitGroupText(group, label), ...(gate ? { gate: true } : {}) };
  const refusalText = (w) => (w.reason === "credits"
    ? T("Usage credits or the spend cap are exhausted — that does not recover on its own, so auto-continue cannot help here.")
    : T`The reset is too far out (${clockText(w.resumeAt)}) — not waiting for it.`);
  if (requireReset && !wait.ok) {
    // No run failed (the turn ended cleanly, only a text points to a limit) — NEVER park and NEVER discard a foreign
    // row (cancelAutoContinue would otherwise clear the chat's waiting compaction or verdict). Two cases:
    //   · SUSPICION — no reset ("unknown") or the refusal "credits" only from a credit WINDOW: an account state, no
    //     evidence for this turn. Only a console line.
    //   · EVIDENCE — the message itself says credits (`hit.credits`), or the reset is known and only too far out
    //     ("too-long"). Then the refusal belongs in the history: otherwise nobody sees that the subagent's work never
    //     happened.
    const proof = wait.reason === "too-long" || (wait.reason === "credits" && hit.credits);
    if (!proof) {
      console.log(`[limit] ${chat.id}: hint "${hit.evidence}" without an evidenced reset (${wait.reason}) — not waiting.`);
      return false;
    }
    limitLine(chat.id, { kind: wait.reason, ...common, resetsAt: wait.window?.resetsAt || null, text: refusalText(wait) });
    console.log(`[limit] ${chat.id}: hint "${hit.evidence}" evidences ${wait.reason} — history row, no wait row discarded.`);
    return false;
  }
  const prev = store.getPendingResume(chat.id);
  // The row belongs to its kind (see WAIT_ROW_RANK): a higher-ranking row stays, and HERE already — not only when
  // writing. The branches below (toggle off, attempt cap, credits) write history rows and call cancelAutoContinue:
  // that would clear the foreign row before parkOrQueue could ever defend it.
  if (!rowMayWrite(prev, kind)) {
    console.log(`[limit] ${chat.id}: ${kind} does not wait — the parked row (${prev.kind || "run"}) has priority.`);
    return false;
  }
  const attempts = prev?.attempts || 0;

  if (!autoContinueEnabled() && !gate) {
    limitLine(chat.id, { kind: "off", ...common, text: T`${limitGroupText(group, label)} reached. Auto-continue is switched off.` });
    return false;
  }
  if (attempts >= limits.MAX_CONTINUES) {
    const abandoned = T`${limitGroupText(group, label)}: giving up after ${attempts} automatic continuations.`;
    limitLine(chat.id, { kind: "gave-up", ...common, attempts, text: abandoned });
    // The row in the history is already there (above) — cancelAutoContinue gets only its wording as the reason (for
    // the run of a scheduled job that ends on it), no second row.
    cancelAutoContinue(chat.id, { kind: "gave-up", reason: abandoned });
    return false;
  }
  if (!wait.ok && (wait.reason === "credits" || wait.reason === "too-long")) {
    limitLine(chat.id, { kind: wait.reason, ...common, resetsAt: wait.window?.resetsAt || null, text: refusalText(wait) });
    cancelAutoContinue(chat.id, { kind: wait.reason, reason: refusalText(wait) });
    return false;
  }

  const probe = !wait.ok; // reset unknown → check back in growing steps
  let dueAt = probe ? now + limits.nextProbing(prev?.probes || 0) : wait.resumeAt;
  // A gate row is called "credit" — even if the reset is unknown: the marker decides button and toggle membership,
  // the probing mechanics run alongside (see fireAutoContinueInner).
  const written = parkOrQueue(chat, {
    kind, payload, prompt: prompt || "", goalDepth, attachments,
    provider: providerId || "", limitGroup: group, limitLabel: label,
    reason: gate ? "credit" : probe ? "probe" : "reset", evidence: gate ? `${Number.isFinite(Number(gate.percent)) ? Math.round(Number(gate.percent)) : 100}%` : hit.evidence,
    resetsAt: wait.window?.resetsAt || hit.resetAt || 0, dueAt,
    // OPEN, not "running": a verdict about a cap or review answer is parked WHILE the run is on `waiting`. The
    // marker is computed and persisted here: once wrong, wrong forever. The notion is defined ONCE in
    // store/workflows.js.
    workflow: store.workflowOpenFor(chat.id),
    now,
  }, { resumption, cause });
  if (written && probe) store.reschedulePendingResume(chat.id, { dueAt, probe: true, now });
  const row = store.getPendingResume(chat.id);
  // Not written means: a FOREIGN parked turn has priority, and this run's prompt waits in the queue behind it
  // (parkOrQueue). It still waits — only for the row that is already there; the history names its time.
  if (!written) dueAt = row.dueAt;
  scheduleAutoContinue(row, { now });
  // "The run continues" would simply be wrong for a parked compaction — no task waits there but the summarising of
  // the history.
  const compactKind = kind === "compact";
  const genus = compactKind ? T("the compaction") : kind === "judge" ? T("the verdict") : T("the run");
  const gatePercent = Number.isFinite(Number(gate?.percent)) ? Math.round(Number(gate.percent)) : 100;
  const waitText = row.reason === "credit"
    // The gate intercepted the START — nothing failed, and the sentence must say so (the same form as in the turn
    // path, creditGateHolds).
    ? T`Credit gate: ${common.limitText} is at ${gatePercent} % — not starting ${genus}. Continuing ${wait.ok ? T`at ${clockText(dueAt)}` : T("as soon as the window frees up")}.`
    : row.reason === "probe"
    ? (compactKind
      ? T`${common.limitText} reached. The reset time is unknown — retrying the compaction at ${clockText(dueAt)}.`
      : T`${common.limitText} reached. The reset time is unknown — retrying at ${clockText(dueAt)}.`)
    : (compactKind
      ? T`${common.limitText} reached. The compaction runs automatically at ${clockText(dueAt)}.`
      : T`${common.limitText} reached. The run continues automatically at ${clockText(dueAt)}.`);
  limitLine(chat.id, {
    kind: gate ? "gate" : "wait", ...common, waitFor: kind, reason: row.reason,
    resetsAt: row.resetsAt || null, dueAt: row.dueAt, text: waitText,
  });
  emitAutoContinue(chat.id, row);
  limitNotification(chat, { parking: true, text: waitText });
  console.log(`[limit] ${chat.id}: ${label || "limit"} → continuation ${new Date(dueAt).toISOString()}`);
  return true;
}

// ── Verdicts at the limit ────────────────────────────────────────────────────
// A "verdict" is a derived model call (runOnce) IN THE MIDDLE of a flow: target gate, workflow condition, loop list,
// reading of a cap or review answer. If it fails at the usage limit, neither "failed" nor "unclear" is the right
// answer — both branch wrongly (the workflow dies or takes the safe but wrong branch). Instead the flow is parked at
// exactly this place; `payload` tells the continuation where to re-enter.
//
// Is this error a usage limit? A pure text check — in the verdict functions it answers "second attempt or wait?". A
// second attempt against an exhausted window is only a second failure.
const isLimitError = (e) => limits.detectLimitHit({ stderr: e?.message || String(e) }).hit;

// Chats whose verdict has JUST parked (again). Needed because the parking happens deep in the resumed flow
// (continuation → driver → verdict) and the continuation above must know whether it may clear the wait row or
// whether the next one already stands there. A timestamp comparison would miss in the same millisecond and lose the
// wait state.
const judgeReparked = new Set();

// Park a verdict at the limit. true = taken over, the caller must NOT branch further.
//
// `error.gate`: the start gate intercepted the call, not the CLI — the row then belongs to toggle B (reason
// "credit"), not toggle A (see maybeAutoContinue, `gate`).
//
// The row carries the STATE in which it was created: for a workflow verdict the run (id, status, step, node,
// generation), for the target verdict the last history row. resumeJudge uses it to check whether the flow is still
// the same. A check of the status alone is too weak: after a user turn in the workflow chat (which counts as the
// result of the open step and moves the cursor on) the parked row would judge the NEW step with the OLD output.
async function parkJudge(chat, error, payload) {
  const run = payload?.at && payload.at !== "goal" ? store.getWorkflowRun(chat.id) : null;
  const state = run
    ? { run: { id: run.id, status: run.status, step: run.step, cursor: { at: run.cursor?.at || "", gen: run.cursor?.gen || 0 } } }
    : { lastId: store.messageStats(chat.id).lastId };
  const parked = await maybeAutoContinue(chat, {
    providerId: providerForChat(chat),
    res: { resultText: "", stderr: error?.message || String(error) },
    kind: "judge", payload: { ...(payload || {}), ...state }, gate: error?.gate || null,
  }).catch((e) => { console.error("[limit] check (verdict) failed:", e?.message || e); return false; });
  if (parked) judgeReparked.add(chat.id);
  return parked;
}

// Resume a parked verdict where it broke off. First check each time whether the situation is still the same: the
// wait state can be hours old, and in that time the user may have answered, cancelled or ended the workflow. If it no
// longer fits, the row is discarded (false, with a row in the history) instead of reviving a flow from the past.
//
// `overruled`: "start anyway" on the parked verdict — goes as an argument to the whole verdict chain, never to the
// turn it starts at the end.
//
// Only the TARGET verdict (`at === "goal"`, runs/post-run.js) re-enters directly here; every other verdict belongs
// to a workflow run and goes through the switch "verdict" (responder in workflows/gates.js — the checks for
// "workflow", "gate", "cap" and "review" with the state comparison are there). The switch's answer: `false` = the
// situation no longer fits (discarded), a promise = taken over — it is awaited here; no responder = false.
async function resumeJudge(chatId, chat, payload, { overruled = false } = {}) {
  const at = payload?.at || "";
  if (at === "goal") {
    // The state from back then (see parkJudge). If it is missing (a row from before), the older, weaker check of the
    // status alone applies.
    const since = typeof payload?.lastId === "number" ? store.listMessagesSince(chatId, payload.lastId) : [];
    if (since.some((m) => m.role === "user" || m.role === "assistant")) return verdictOutdated(chatId);
    if (running.has(chatId)) return false;
    await goalGateAfterRun(chat, payload.userText || "", payload.assistantText || "", payload.depth || 0, { overruled });
    return true;
  }
  const response = turnout("verdict", { at, chatId, chat, payload, overruled });
  if (response === undefined || response === false) return false;
  await response;
  return true;
}
// The parked verdict is outdated: a row in the history, and the continuation is dropped (false). ONE place for both
// sides of the switch — the target verdict here, the workflow verdicts in workflows/gates.js.
function verdictOutdated(chatId) {
  limitLine(chatId, { kind: "cancel", text: T(
    "The parked verdict is outdated — the chat has moved on since; it is dropped.") });
  return false;
}

// Execute a due continuation. `manual` = the user pressed "try now" (then the limit is not looked at again — they
// may knowingly try). `anyway` = the button was "start anyway (costs credit)"; only then the start gets `overruled`.
//
// "Try now" on a gate row without `anyway` is NOT released: the attempt runs into the gate and parks again at once —
// rightly so, because the button at the gate is "start anyway" in both clients and sends `anyway:true`. A release
// kept as a marker in memory would be consumed by some later start.
// `early`: the sweeper wakes a gate row before its reset because a newer measurement shows the gate free (account
// switch) — only the wording of the history row depends on it: nothing has reset.
async function fireAutoContinue(chatId, { manual = false, anyway = false, early = false } = {}) {
  if (autoContinueFiring.has(chatId)) return { ok: false, reason: "in-flight" };
  autoContinueFiring.add(chatId);
  try {
    return await fireAutoContinueInner(chatId, { manual, anyway, early });
  } finally {
    autoContinueFiring.delete(chatId);
    wakeupCounter.set(chatId, wakeupCycles(chatId) + 1);
  }
}
// Test seam: how often fireAutoContinue has COMPLETED per chat — timer, sweeper and button, every outcome
// (rescheduled, started, stepped back); a call that meets a running one ("in-flight") decided nothing and does not
// count. Bookkeeping only: "the timer did NOT start" is an absence and needs a timer that really came back — a slept
// duration does not say under load whether it got its turn at all.
const wakeupCounter = new Map();
const wakeupCycles = (chatId) => wakeupCounter.get(chatId) || 0;
async function fireAutoContinueInner(chatId, { manual = false, anyway = false, early = false } = {}) {
  clearAutoContinueTimer(chatId);
  const row = store.getPendingResume(chatId);
  if (!row) return { ok: false, reason: "none" };
  const chat = store.getChat(chatId);
  if (!chat) { store.clearPendingResume(chatId); return { ok: false, reason: "chat-gone" }; }
  // A wait row of a read-only chat is discarded, not started — before any limit check (no network call for a turn
  // that will not exist), for every kind of row.
  if (onlyReadable(chat)) { clearAwayOnlyReadable(chatId); return { ok: false, reason: "only-readable" }; }
  // A manager chat's wait row (runs/manager-lock.js) is neither started nor discarded (no writing) — the timer is
  // already cleared above.
  if (managerLocked(chat)) return { ok: false, reason: "manager-locked" };
  // The row belongs to its kind — also here, when waking: a `compact` or `judge` row waits for the CHAT, not for this
  // turn. If the chat is running, it stays and is checked again in a minute (the sweeper skips running chats, so it
  // needs its own timer) — otherwise the promised compaction "at HH:MM" would never happen if the user happened to be
  // typing then. Only a `run` row is moot then: the running turn IS the chat, and there are no two turns in one chat.
  const waitsForChat = (row.kind || "run") !== "run";
  const runningAlready = () => {
    if (!running.has(chatId)) return null;
    if (!waitsForChat) { cancelAutoContinue(chatId); return { ok: false, reason: "running" }; }
    const nowMs = Date.now();
    store.reschedulePendingResume(chatId, { dueAt: nowMs + autoContinueSweepMs(), now: nowMs });
    scheduleAutoContinue(store.getPendingResume(chatId), { now: nowMs });
    return { ok: false, reason: "running", dueAt: nowMs + autoContinueSweepMs() };
  };
  const occupied = runningAlready();
  if (occupied) return occupied;
  // The continuation of the target gate (a run row with `goalDepth > 0`) of a target that is PAUSED or gone by now
  // (post-run.js targetResumptionDropped): it falls here with a history row — before the lock, the network call, the
  // row "limit reset — the run continues" and the notification, which would otherwise announce a run that doRun then
  // does not begin. Once more after the network call (below): a pause can also happen in that window. Without a
  // running chat cancelAutoContinue lets the queue drain.
  const targetRemoved = () => !waitsForChat && targetResumptionDropped(chatId, { goalDepth: row.goalDepth || 0, row: true });
  if (targetRemoved()) return { ok: false, reason: "target" };
  // The lock per project: it replaces no wait row, it only holds its start. A due row of a locked project is NOT
  // started — not via "try now" either — but rescheduled: prompt, attachments, kind, attempts and creation stay, no
  // attempt is counted, no history row, no notification. It is woken at the transition to ready (projectbox/idle.js
  // wakeProject); then this path checks the limit as for every row. Asked per kind: a turn (run) waits in every
  // working state, a verdict or compaction (a oneshot in the user container) only during relocation. The error state
  // does not hold — the turn begins and ends visibly in doRun. Without an instance row: null.
  // THE REASON: a row of the lock becomes "project" or "serverEnd"; a limit or credit row KEEPS its own (otherwise
  // the resume row, the limit notification and toggle A would drop out, and the credit row would lose the marker
  // "credit" by which the clients show "start anyway"). Only `dueAt` moves; project-lock.js remembers the chat
  // (`rememberHalted`) so the transition to ready still starts it.
  const lock = startLock(chatId, waitsForChat ? "oneshot" : "turn");
  if (lock && lock.kind !== "error") {
    const nowMs = Date.now();
    const serverEnd = lock.reason === "serverEnd";
    const ownReason = !isLockReason(row.reason);
    if (ownReason) rememberHalted(chatId);
    store.reschedulePendingResume(chatId, {
      dueAt: serverEnd ? nowMs : nowMs + (withoutTransition(lock) ? autoContinueSweepMs() : projectCheckBackMs()),
      reason: ownReason ? null : serverEnd ? "serverEnd" : "project", now: nowMs,
    });
    const next = store.getPendingResume(chatId);
    if (!serverEnd) scheduleAutoContinue(next, { now: nowMs });
    emitAutoContinue(chatId, next);
    return { ok: false, reason: serverEnd ? "serverEnd" : "project", dueAt: next?.dueAt || 0 };
  }
  takeHalted(chatId);
  // A gate row (`reason: "credit"`) belongs to toggle B, not toggle A: the gate parked the turn, and whoever switches
  // the gate on agrees to continue at the reset — independent of auto-continue. Otherwise A off would let every gate
  // row lapse. Likewise a row of the project lock (reason "project"/"serverEnd") belongs to no toggle: it waits for
  // the instance, not for a limit, and A off does not discard it.
  if (!autoContinueEnabled() && !manual && row.reason !== "credit" && !isLockReason(row.reason)) {
    cancelAutoContinue(chatId, { kind: "off", note: T("Auto-continue was switched off.") });
    return { ok: false, reason: "disabled" };
  }
  const now = Date.now();
  const providerId = row.provider || providerForChat(chat);
  // A gate row STAYS a gate row even when rescheduled: `reason: "credit"` is the marker by which web and iOS show the
  // button "start anyway" — and the marker by which this path above protects the row from toggle A. Rewriting it to
  // "reset" or "probe" would take both away at the first rescheduling. `null` means in reschedulePendingResume:
  // reason unchanged.
  const gateRow = row.reason === "credit";
  if (!manual) {
    // Does the limit still stand? A start too early burns the attempt, so rather reschedule.
    const windows = await limitWindowsFor(providerId, chat);
    // Read the row ANEW: `row` is a snapshot from BEFORE the network call, which takes hundreds of milliseconds to
    // seconds. In that time the row may have been discarded (DELETE on the strip, toggle, run end) or another path
    // rewrote it (then it carries another timestamp and a timer of its own). In both cases this timer is moot — it
    // must neither reschedule nor move the counter nor write "the run continues" into the history, let alone start:
    // a discarded task would otherwise start from the snapshot after `cancelAutoContinue` had long started the next
    // queue entry. Every write path of the row sets `updated_at`; a discard with recreation also moves `created_at`.
    const stillPresent = store.getPendingResume(chatId);
    if (!stillPresent || stillPresent.updatedAt !== row.updatedAt || stillPresent.createdAt !== row.createdAt) {
      return { ok: false, reason: "gone" };
    }
    // And the chat may be running by now (the queue started after the discard, a channel delivered): the same rule
    // as above, by kind.
    const meanwhile = runningAlready();
    if (meanwhile) return meanwhile;
    if (targetRemoved()) return { ok: false, reason: "target" }; // paused during the network call (see above)
    // A gate row whose gate is OFF by now waits for a rule that no longer exists: do not reschedule but start —
    // doRun asks the gate, and it says "off". The route PUT /api/credit-gate {enabled:false} wakes every gate row
    // itself; but if its timer was just in this network call, that wake call came back as "in-flight", and the
    // running timer would reschedule the row here until the reset.
    const gateExpired = gateRow && !creditGateOn();
    // WHICH question, the row's kind says: a gate row waits for the GATE — so the timer asks the gate question
    // itself (the same function, the same model, the same threshold 99), a limit row for the end of the time lock
    // (stillBlocked, threshold 98). Both rest only on time locks (limits.timeLocks): an empty credit pot must not
    // hold a row here that the gate would have started at once.
    const lock = gateExpired ? null : lockingWindow({ gateRow, chat, providerId, windows, now });
    if (lock) {
      // Until when is answered by THE SAME question (waitTimeFor): a gate row waits as long as the gate holds, not
      // until the latest reset of all time locks from 98 %.
      const again = waitTimeFor({ gateRow, chat, providerId, windows, now });
      const window = again.window || lock;
      const stands = `${window.group || "?"} ${typeof window.percent === "number" ? Math.round(window.percent) : "?"} %, reset ${window.resetsAt ? new Date(window.resetsAt).toISOString() : "unknown"}`;
      if (again.ok) {
        store.reschedulePendingResume(chatId, {
          dueAt: again.resumeAt, resetsAt: again.window?.resetsAt || null, reason: gateRow ? null : "reset",
          limitGroup: again.window?.group || null, limitLabel: again.window?.label || null, now,
        });
        const next = store.getPendingResume(chatId);
        scheduleAutoContinue(next, { now });
        emitAutoContinue(chatId, next);
        console.log(`[limit] ${chatId}: still in place (${stands}) → rescheduled ${new Date(again.resumeAt).toISOString()}`);
        return { ok: false, reason: "still-limited", dueAt: again.resumeAt };
      }
      if ((row.probes || 0) < limits.MAX_PROBES) {
        // Step = number of probes already made (limits.nextProbing — the same rule at all three places). The row's
        // reset is unknown with that: `resetsAt` 0 (not null — null means "unchanged"), otherwise strip and wait
        // sentence would promise the probe time as the continuation, with the old window as its label.
        const dueAt = now + limits.nextProbing(row.probes || 0);
        store.reschedulePendingResume(chatId, {
          dueAt, resetsAt: 0, reason: gateRow ? null : "probe", probe: true,
          limitGroup: window.group || null, limitLabel: window.label || null, now,
        });
        const next = store.getPendingResume(chatId);
        scheduleAutoContinue(next, { now });
        emitAutoContinue(chatId, next);
        console.log(`[limit] ${chatId}: still in place (${stands}) → probe ${(row.probes || 0) + 1}/${limits.MAX_PROBES}, next look ${new Date(dueAt).toISOString()}`);
        return { ok: false, reason: "probe", dueAt };
      }
      console.log(`[limit] ${chatId}: still in place (${stands}) after ${limits.MAX_PROBES} probes — given up`);
      cancelAutoContinue(chatId, { kind: "gave-up", note: T(
        "The limit is still in place and no reset time can be determined — no longer checking back.") });
      return { ok: false, reason: "gave-up" };
    }
  }
  if ((row.attempts || 0) >= limits.MAX_CONTINUES) {
    cancelAutoContinue(chatId, { kind: "gave-up", note: T`Giving up after ${row.attempts} automatic continuations.` });
    return { ok: false, reason: "attempts" };
  }
  // An attempt is a START, not a wake. For verdict and compaction both coincide — they run right here. For a `run`
  // row doRun counts itself, immediately AFTER the gate is passed: if the gate parks the turn again at once (the
  // usage cache is still at 100 % after a network error), no turn ran and the counter stays. Counting every wake
  // would discard the task with "gave-up" within minutes without a model ever being called.
  if (waitsForChat) store.bumpPendingResumeAttempts(chatId);
  // The row STAYS (it carries the attempt counter) but slips far back so the sweeper does not fire a second time
  // next to the run just started. doRun clears it at the end: on success or on an error that is no limit.
  store.reschedulePendingResume(chatId, { dueAt: now + 6 * 3600_000, now });
  const fresh = store.getPendingResume(chatId);
  // The number of THIS attempt for history and console: for a run row the counter has not moved yet (see above), so
  // the next one — and it stays that if the gate intercepts the start.
  const attempt = waitsForChat ? (fresh?.attempts || 0) : (row.attempts || 0) + 1;
  const compactKind = row.kind === "compact";
  const overruled = manual && anyway === true;
  const limitText = limitGroupText(row.limitGroup, row.limitLabel);
  // Three rows for three causes — and the KIND says which (the clients derive their heading from it, not from the
  // text):
  //   "resume"    the reset is here, it continues by itself ("limit reset")
  //   "retry"     the human pressed "try now" — nothing has reset
  //   "gate-free" the human pressed "start anyway (costs credit)". For a TURN creditGateHolds writes this row
  //               itself, with the percentage of now; for verdict and compaction it is here, because their start
  //               gate writes none.
  const resumeText = manual
    ? T("Trying again now.")
    : early
      ? compactKind
        ? T`The credit gate is clear (${limitText} no longer exhausted, e.g. after switching accounts) — running the compaction now.`
        : T`The credit gate is clear (${limitText} no longer exhausted, e.g. after switching accounts) — continuing the run.`
      : compactKind
        ? T`${limitText} has reset — running the compaction now.`
        : T`${limitText} has reset — continuing the run.`;
  if (overruled && waitsForChat) {
    const percent = String(row.evidence || "").replace(/[^\d]/g, "") || "≥ 99";
    limitLine(chatId, {
      kind: "gate-free", group: row.limitGroup, label: row.limitLabel, limitText, percent: Number(percent) || 100, gate: true, waitFor: row.kind,
      text: compactKind
        ? T`Started anyway: ${limitText} is at ${percent} % — this compaction may spend usage credits.`
        : T`Started anyway: ${limitText} is at ${percent} % — this verdict may spend usage credits.`,
    });
  } else if (!overruled && !isLockReason(row.reason)) {
    // A row of the project lock has no limit that would have reset — no "resume" row.
    // `early`: the clients then show "credit gate free" instead of "limit reset" as the heading.
    limitLine(chatId, {
      kind: manual ? "retry" : "resume", group: row.limitGroup, label: row.limitLabel, attempts: attempt,
      waitFor: row.kind || "run", text: resumeText, ...(early && !manual ? { early: true } : {}),
    });
  }
  // The row goes to the clients NOW for verdict and compaction; for a turn only AFTER the start (below): then the
  // chat is in `running` and autoContinueView is silent — the strip disappears for the duration of the turn instead
  // of counting down six hours.
  if (row.kind === "judge" || compactKind) emitAutoContinue(chatId, fresh);
  // Only if the human is NOT standing right there having pressed the button — no need to notify their phone about
  // what they triggered themselves.
  if (!manual && !isLockReason(row.reason)) limitNotification(chat, { parking: false, text: resumeText });
  console.log(`[limit] ${chatId}: continuation running (kind ${row.kind || "run"}, attempt ${attempt || 1}${early ? ", early: gate free" : ""})`);
  // A parked compaction is NO turn: it is caught up instead of repeated. Unlike doRun it deliberately runs awaited
  // here — only so a renewed limit can be told apart (then compactChatContext parked itself again) and a workflow
  // can continue afterwards.
  // A parked verdict: re-enter where it broke off (the flow hangs on it).
  if (row.kind === "judge") {
    judgeReparked.delete(chatId);
    const again = await resumeJudge(chatId, chat, row.payload, { overruled })
      .catch((e) => { console.error("[limit] verdict", chatId, "failed:", e?.message || e); return false; });
    // If the limit still stood, the verdict rescheduled itself — the row then already belongs to the NEXT round and
    // must not be cleared.
    if (judgeReparked.delete(chatId)) return { ok: false, reason: "still-limited" };
    // ONLY the judge row: the caught-up verdict sent the driver on, and the next turn is already running — its gate
    // may have written a run row in the same time. A blind clearPendingResume would take it away: the turn would be
    // parked without anything ever waking it. If the chat is running, the view is silent anyway.
    clearAwayJudgeRow(chatId);
    return { ok: again, reason: again ? "" : "stale" };
  }
  if (compactKind) {
    const out = await compactChatContext(chat, { overruled })
      .catch((e) => ({ ok: false, note: e?.message || String(e) }));
    if (out?.limited) return { ok: false, reason: "still-limited" }; // rescheduled itself
    clearAutoContinueTimer(chatId);
    store.clearPendingResume(chatId);
    emitAutoContinue(chatId, null);
    // If a workflow hung on this compaction (command node `/compact`), it continues now — hook "afterCompactResume",
    // subscriber workflows/driver.js (checks itself whether a run is "running"). The driver already noted the
    // command as done when parking — so it jumps straight to the node and does not compact a second time.
    fireHooks("afterCompactResume", { chat, row });
    return { ok: !!out?.ok, reason: out?.ok ? "" : "compact-failed" };
  }
  // Check AGAIN, immediately before the start and without an `await` in between: the network call above
  // (limitWindowsFor) is an open window in which another path may have started the same chat — then two runs would
  // run in the same chat, and doRun itself has no re-entry lock. Only the run row arrives here (verdict and
  // compaction returned above) — and it is moot for a running chat.
  if (running.has(chatId)) { cancelAutoContinue(chatId); return { ok: false, reason: "running" }; }
  // `overruled` ONLY with `manual && anyway` — and only for this one start. `resumption`: this run is the row's
  // turn; if it parks again, it sets ITS row anew (the counter goes on) instead of being queued behind it as a second
  // task.
  startRun(chat, row.prompt || T("Please continue the interrupted task."), {
    goalDepth: row.goalDepth || 0, attachments: row.attachments || null,
    cause: CAUSES.has(row.payload?.cause) ? row.payload.cause : "user",
    overruled, resumption: true,
  });
  // Only now — the chat is in `running`, the view is empty: the strip goes out. The row read FRESH, not `fresh`: if
  // the project lock holds the turn, doRun returns synchronously — then the chat is NOT in `running` anymore, and
  // `fresh` (six hours ahead) would show a strip for a row doRun just rewrote or (in the error state) cleared. For a
  // running chat the view is empty either way.
  emitAutoContinue(chatId, store.getPendingResume(chatId));
  return { ok: true };
}

// Regularly: execute due rows, give the others a timer (after restart/sleep).
// A gate row (reason "credit") is woken EARLY when a measurement after its parking shows the gate free: after an
// account switch it would otherwise wait until the old account's reset. Without a network call — the timer asks
// afresh itself before the start. A turn row asks with the chat's model (gateFreeByMeasurement), a verdict or a
// compaction strictly for every model (the row does not carry their model — with the chat's the sweep would wake it
// every minute and the gate of its oneshot would park it again at once). If the row's reset is already here, its
// timer wakes it at `dueAt` (with grace), not this branch. Limit rows stay with their reset: their lock came from the
// CLI's message, and the measurement does not know every one (spend cap) — a start too early would cost an attempt.
function gateRowFree(row, chat, now) {
  if (row.reason !== "credit") return false;
  if (row.resetsAt && now >= row.resetsAt) return false;
  const since = row.updatedAt || 0;
  return (row.kind || "run") === "run"
    ? gateFreeByMeasurement({ chat, providerId: row.provider || providerForChat(chat), since })
    : gateFreeForAllByMeasurement({ since }) > 0;
}
function sweepAutoContinues() {
  let rows = [];
  try { rows = store.listPendingResumes(); } catch { return; }
  const now = Date.now();
  for (const row of rows) {
    const chat = store.getChat(row.chatId);
    if (!chat) { try { store.clearPendingResume(row.chatId); } catch {} continue; }
    if (running.has(row.chatId) || autoContinueFiring.has(row.chatId)) continue; // running or just starting
    if (row.dueAt <= now + 500) {
      fireAutoContinue(row.chatId).catch((e) => console.error("[limit] sweep:", e?.message || e));
      continue;
    }
    if (gateRowFree(row, chat, now)) {
      fireAutoContinue(row.chatId, { early: true }).catch((e) => console.error("[limit] sweep:", e?.message || e));
      continue;
    }
    if (!autoContinueTimers.has(row.chatId)) scheduleAutoContinue(row, { now });
  }
}

// The queue after the restart — the counterpart of sweepAutoContinues for the wait rows. Runs AFTER
// resumeInterruptedWork.
//
// In operation every entry has a runner that takes it over at the end: the finally of the turn (takeNextRunInput),
// that of the compaction, or the discarded wait row (cancelAutoContinue). After a restart that runner exists only if
// the restart itself started it — otherwise the entry would stand there forever, visible as "1 queued" in a chat
// that does nothing. So it is started exactly where nobody takes over anymore, and the conditions are the same as at
// the handover places in operation:
//   · `running`: resumeInterruptedWork restarted the run (active_runs) or a channel delivered — the run end takes
//     over, as in operation.
//   · run wait row: "parked is like running" — the continuation drains the queue once it is through; an entry
//     started now would only run into the same limit.
//   · workflow run `running`: the chat belongs to its driver (resumeInterruptedWork drives it, or a parked verdict
//     does after the reset). A turn of its own next to it would be a second run in the same chat — doRun has no
//     re-entry lock, and driveWorkflow steps back on `running` instead of waiting. The end of the next node turn
//     takes the entries over, as in operation; a WAITING run gets the entry as its answer instead
//     (startFollowUpRun), just as via /message.
//   · `compacting`/`controlActive` cannot stand at startup; the check is there anyway so the condition here is
//     literally that of the handover places.
// An entry for a deleted chat falls together with its rows.
function runInputsRestartGrace() {
  let started = 0;
  for (const chatId of [...pendingRunInputs.keys()]) {
    if (!store.getChat(chatId)) {
      pendingRunInputs.delete(chatId);
      try { store.clearRunInputs(chatId); } catch {}
      continue;
    }
    if (running.has(chatId) || compacting.has(chatId) || controlActive.has(chatId)) continue;
    if (store.getPendingResume(chatId)?.kind === "run") continue;
    if (store.getWorkflowRun(chatId)?.status === "running") continue;
    if (startFollowUpRun(chatId, takeNextRunInput(chatId))) started += 1;
  }
  if (started) console.log(`[queue] ${started} chat(s) started from the queue (restart)`);
  return started;
}

export { autoContinueView, cancelAutoContinue, emitAutoContinue, fireAutoContinue, startFollowUpRun, isLimitError, clearAwayJudgeRow, limitLine, limitNotification, maybeAutoContinue, clearAwayOnlyReadable, parkJudge, runInputsRestartGrace, clearAwayRunRow, scheduleAutoContinue, drainQueue, sweepAutoContinues, verdictOutdated, wakeupCycles };
