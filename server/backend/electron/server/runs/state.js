// State of the runs (a run = one turn of a chat) — the maps and sets that every domain imports by name: running,
// compacting, runChildren, abortedRuns, runWaiting, runBackground, runContext, runStreamText, pendingRunInputs
// (persisted in run_inputs), the controller maps, SUBAGENT_TOOLS — and stopRun; also the set of run causes CAUSES,
// the second re-entry lock `workflowDecides` and `runCause`.
// Pure state: maps and sets are changed via their methods, never rebound.

import * as store from "../store.js";
import { T } from "../i18n.js";
import { clearChatPermissions } from "./approvals.js"; // the leaf, not permissions.js — otherwise an import cycle


// ── Chat-Run ─────────────────────────────────────────────────────────────────
const running = new Set();
// Chats whose context is being compacted RIGHT NOW. That is not a run — there is no child process to inject into —
// but it locks the chat just the same: the compaction discards the session at the end and replaces it by the
// summary. A turn that starts meanwhile works on a session that is about to vanish: its answer would hang on a
// history that is discarded, and the fresh prompt would never see the summary. So a message from this phase is
// queued and started afterwards as a run of its own (see deliverUserPrompt and the finally in compactChatContext).
const compacting = new Set();
// Running Claude processes per chat (for aborting) + chats whose run was aborted on purpose.
const runChildren = new Map(); // chatId -> ChildProcess
const abortedRuns = new Set(); // chatId (marks a deliberate abort)
// Runs in the monitor wait phase: the agent is idle but keeps monitors open (the process lives). In this phase
// /message accepts messages and injects them into the running process.
const runWaiting = new Map(); // chatId -> { monitors: [{taskId, description}] }
// Running BACKGROUND work per chat — regardless of whether the main agent is idle. runWaiting knows the same lists
// but is only filled in the wait phase; a chat whose main agent keeps working WHILE background agents run would
// never appear in it, and the display "N agents working" would stay empty (a background agent's tool block is
// "done" at once, so it does not carry them).
const runBackground = new Map(); // chatId -> { monitors, agents, tasks, wakeupAt }
// Context size of the running run (input of the last API call + its output). Also written to the DB continuously
// so that a reload IN THE MIDDLE of the run does not show "0".
const runContext = new Map(); // chatId -> tokens
// The STREAMED text of the running answer block. Deltas are only passed to open streams, text reaches the DB only
// at the end of the block — whoever joins IN THE MIDDLE of the run (reload, second window, phone) would otherwise
// see the answer only from their entry on. The buffer is extended on each delta, emptied when the block is
// persisted and at the end of the run, and sent along in the `connected` event. It NEVER goes to the DB: the
// history gets the text exactly once, from the end of the block.
const runStreamText = new Map(); // chatId -> Text
// Cap of the buffer. It MUST show itself, otherwise a truncated text cannot be told from a complete one — so
// `streamTextTruncated` travels in the event. Truncated at the END: the beginning is what the newcomer is missing.
const RUN_STREAM_MAX = 200_000;
// User messages that arrive during an active turn. They stay ordered on the server (so they also survive tab/view
// switches) and are injected into the same logical run at the next safe turn boundary. Only on successful
// injection are they persisted as a user message so that the DB history stays correct in time.
//
// The map survives a restart: every mutation updates its image in the table `run_inputs` (persistRunInputs), the
// start reads it back (loadRunInputs) and starts whatever stands there without a runner (runInputsRestartGrace).
// Reason: an entry behind a parked continuation waits until the reset — hours, with a weekly limit days — and a
// restart in that time would lose it without a trace. The map stays the truth in the process, the table its image.
const pendingRunInputs = new Map(); // chatId -> [{id,prompt,display,attachments,cause,silent}]
// The ONE write site of the image: call AFTER every mutation of the map for this chat (queue, take over, inject,
// discard, steer, channel re-bundling). No write-ahead — the table follows the map, never the other way round; and
// a write error holds up no turn: it only costs the restart safety of this one state, and that is in the log.
function persistRunInputs(chatId) {
  try { store.replaceRunInputs(chatId, pendingRunInputs.get(chatId) || []); }
  catch (e) { console.error(`[queue] ${chatId}: queue not saved:`, e?.message || e); }
}
// At start: fill the map from the table. It is EMPTIED first — at start the table is the truth, not a remnant of
// an earlier server life of the same process (in operation there is none; in tests dozens of servers run one after
// another, and two of them share the same data directory in a simulated restart).
// An old entry with `todos: true` is taken over silently — nobody reads the field any more.
function loadRunInputs() {
  pendingRunInputs.clear();
  let rows = [];
  try { rows = store.listRunInputs(); }
  catch (e) { console.error("[queue] queue not loaded:", e?.message || e); return 0; }
  let n = 0;
  for (const { chatId, entries } of rows) {
    if (!entries.length) continue;
    pendingRunInputs.set(chatId, entries);
    n += entries.length;
  }
  if (n) console.log(`[queue] loaded ${n} queued message(s) in ${pendingRunInputs.size} chat(s) from the DB`);
  return n;
}
// Active provider-neutral monitor controller per chat. The cbase MCP calls it via the local API (Codex); the
// completion engine gets the same controller directly as a callback.
const runMonitorControllers = new Map(); // chatId -> { start(args,meta), stop(taskId), close() }
// The wakeup (cbase_wakeup) has no controller per run — it belongs to the chat (runs/wakeup.js).
// The yield of the wait phase per running turn (runs/do-run.js) — if the chat is in another instance by now
// (runs/instance.js turnInstanceDifferent) and an input is waiting, the old process ends instead of accepting it as
// a new turn. runs/queue.js deliverUserPrompt calls it when it queues an input in the wait phase.
const runWaitPhaseYield = new Map(); // chatId -> () => boolean (yielded?)
// The subagent core per chat (cbase_agent) has its own owner: runs/agents.js (the open cores with their live
// agents are asked via runs/background.js).
// What our OWN subagent is called in the event stream. All providers name MCP tools the same way
// (`mcp__<server>__<tool>`, see contract.js mcpToolName) — the short form stands next to it anyway: it costs
// nothing and catches a provider that might drop the prefix one day. Plus the two tools through which a subagent's
// REPORT reaches the main agent (`cbase_agent_output`, `cbase_agent_send`).
// None of these reports is evidence of a limit for the run — our own subagent parks at the limit itself
// (runs/agents.js); the set only serves to assign events to the call block.
const SUBAGENT_TOOLS = new Set([
  "mcp__cbase__cbase_agent", "cbase_agent",
  "mcp__cbase__cbase_agent_output", "cbase_agent_output",
  "mcp__cbase__cbase_agent_send", "cbase_agent_send",
]);
// Cap of the native wakeup (runs/wakeup.js). More generous than the hour cap of the Claude CLI (ScheduleWakeup)
// because it also replaces its CronCreate — "continue tomorrow morning" must work with it. What waits longer than
// a day is a job at fixed times: that is what scheduled jobs are for (Coding → Scheduled, scheduled/).
const NATIVE_WAKEUP_MAX_S = 24 * 3600;
// Chats whose TARGET is being checked right now (archive reason "target"). The target gate
// (post-run.js:goalGateAfterRun) rules AFTER `running.delete` for seconds via a oneshot and may then call
// `await doRun(…)` — in this window the work would otherwise be recorded nowhere, and an archiving would go through
// only to come back by itself seconds later. Set synchronously before the verdict, taken immediately BEFORE the
// follow-up run (which sets `running` in the same tick) and in the finally.
// COUNTED, not set: two verdicts of the same chat can overlap (a second message during the first verdict starts
// run B, whose target gate rules while the first is still running). As a set, the finally of the FIRST would take
// the second's mark along. Every verdict counts up exactly once (`targetCheckOn`) and down exactly once
// (`targetCheckOff`); at 0 the entry is dropped, `has` stays the question.
const targetCheck = new Map(); // chatId -> number of running verdicts (≥ 1; at 0 no entry)
function targetCheckOn(chatId) {
  targetCheck.set(chatId, (targetCheck.get(chatId) || 0) + 1);
}
function targetCheckOff(chatId) {
  const n = (targetCheck.get(chatId) || 0) - 1;
  if (n > 0) targetCheck.set(chatId, n);
  else targetCheck.delete(chatId);
}

// Chats whose GRAPH WORKFLOW is deciding WITHOUT a turn right now (`running` is not the only re-entry lock).
// Between two turns of a graph run its gate rules on the step (completion verdict) and the driver advances
// (switch, list, cap), both without a turn, the run is on "running". A message in this window would otherwise
// start a turn of its own at once; the driver would come back to `running`, and the gate afterwards would take the
// answer to the message for the result of the NEXT step, whose task never went out — the run would end "done" with
// a step silently skipped (channel messages likewise).
// While the count stands, the chat is BUSY: a delivery is queued (queue.js deliverUserPrompt), the end of work does
// not start the queue (do-run.js), steer and /compact answer 409. Set by workflows/ (gates.js workflowGateAfterRun,
// driver.js driveWorkflow — both call each other nested, hence COUNTED like targetCheck); pure state, `runs/` does
// not import the domain for it. When the count drops to 0, the setter lets the queue drain (auto-continue.js): if
// the driver decided on a turn, that turn takes the queue at its `result` (injectNextRunInput); if it decided on an
// end or a wait, the queue runs as a follow-up run of its own.
// An in-memory counter, not a status: a zombie run on "running" without a driver does NOT occupy the chat — a lock
// on the status would queue every message of such a chat forever.
const workflowDecides = new Map(); // chatId -> number of open decisions (≥ 1; at 0 no entry)
function workflowDecidesOn(chatId) {
  workflowDecides.set(chatId, (workflowDecides.get(chatId) || 0) + 1);
}
/** @returns {boolean} whether this ended the chat's LAST open decision */
function workflowDecidesOff(chatId) {
  const n = (workflowDecides.get(chatId) || 0) - 1;
  if (n > 0) { workflowDecides.set(chatId, n); return false; }
  workflowDecides.delete(chatId);
  return true;
}

// The causes of a run (`doRun(chat, text, { cause })`): "user" (composer, task, continuation), "event" (wake call),
// "schedule" (the occurrence of a scheduled job), "channel" (a channel message wakes the participant — in a coding
// chat like any message), "agent" (a subagent's completion notice — a system notice, never bundled with user
// messages, resets no channel cap, never counts as human input), "message" (an agent's message to another run in
// the form of runs/message-marker.js — never human input, answers no card and no gate; to a graph child chat it
// goes via workflows/ into the running node turn or into the run's pending store, never as a turn of its own). An
// unknown cause becomes "user" — at all three read sites in runs/ (do-run.js entry, limit-gate.js wait row,
// auto-continue.js wakeup) and on the way back from active_runs.kind (causeFromRunKind, resume.js).
// The SET of causes is a run concept and lives at the hub; `causeFromRunKind` lives here too — its only reader is
// runs/resume.js, and importing the set from a domain would close an import cycle.
// "wakeup": the continuation that the chat's wakeup delivers (runs/wakeup.js) — a system notice like the completion
// notice, never human input; it never goes into the middle of a turn.
const CAUSES = new Set(["user", "event", "schedule", "channel", "agent", "message", "wakeup"]);
const causeFromRunKind = (kind) => {
  const a = String(kind || "").startsWith("chat:") ? String(kind).slice(5) : "user";
  return CAUSES.has(a) ? a : "user";
};

// Cause of the RUNNING turn per chat: chatId → { cause, causeBound }, set in do-run.js, cleared in its finally.
// `causeBound`: this turn only takes inputs of THE SAME cause (today only the scheduled turn). Without it the handover
// of the queue into the open process (queue.js injectNextRunInput, at the `result` and in the wait phase) would not
// know the turn's cause: a user message would run in the locked set of an event turn, a completion notice in the
// full set of a user turn.
const runCause = new Map();
/** May a queued input with cause `cause` go into the open process of the running turn? Without a run or without a
 *  toolset per cause yes; otherwise only for THE SAME cause — everything else becomes a follow-up run of its own
 *  with its own set. */
// A scheduled occurrence (cause "schedule") NEVER goes into an open process — a doRun carries at most one scheduled
// run, otherwise the occurrence would go into the human's run in the wait phase or at the `result`, and the end of
// the run (scheduled/) would close the wrong one. Conversely a scheduled turn runs with `causeBound` (do-run.js) so
// that nothing else goes into IT; the completion notice of its own subagent takes the path via queue.js
// injectEntry and does not ask here.
function inputFitsIntoTheRun(chatId, cause) {
  if (cause === "schedule") return false;
  const run = runCause.get(chatId);
  if (!run?.causeBound) return true;
  return (CAUSES.has(cause) ? cause : "user") === run.cause;
}

// Abort a chat's running generation. Sets the abort marker (also if the process is still spawning) and ends the
// process gently (SIGTERM), hard if necessary (SIGKILL).
function stopRun(id) {
  abortedRuns.add(id);
  const child = runChildren.get(id);
  if (child) {
    try { child.kill("SIGTERM"); } catch {}
    setTimeout(() => { try { if (runChildren.get(id) === child) child.kill("SIGKILL"); } catch {} }, 3000);
  }
  // A run that is waiting for an approval has no process to kill (loop engine) — it hangs in a promise without a
  // deadline. Deny open requests NOW, otherwise the run survives its own stop.
  clearChatPermissions(id, T("Run aborted"), "stop");
  return running.has(id);
}

// If a turn is running, it must end first — otherwise two runs of the same chat would be in the `running` set at
// the same time. A run concept: it only reads `running` (callers: runs/queue.js and workflows/gates.js).
async function waitForRunEnd(chatId, ms = 8000) {
  const until = Date.now() + ms;
  while (running.has(chatId) && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
}

export { CAUSES, NATIVE_WAKEUP_MAX_S, RUN_STREAM_MAX, SUBAGENT_TOOLS, abortedRuns, causeFromRunKind, compacting, inputFitsIntoTheRun, runCause, pendingRunInputs, persistRunInputs, runBackground, runChildren, runContext, loadRunInputs, runMonitorControllers, runStreamText, runWaiting, runWaitPhaseYield, running, stopRun, waitForRunEnd, workflowDecides, workflowDecidesOn, workflowDecidesOff, targetCheck, targetCheckOn, targetCheckOff };
