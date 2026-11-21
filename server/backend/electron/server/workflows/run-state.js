// State of a workflow run: the caps (WORKFLOW_MAX_STEPS, WORKFLOW_MAX_VISITS), workflowIntent, workflowGraph, views
// (workflowRunView, runHistoryView), emitWorkflowRun, notes and push verdict, step log (logRunStep, runStepStart,
// closeRunStep), runStillOur, locks, the trigger wakeup (setTriggerWakeup, wired in the registration list in
// server.js) and the observer of the graph workflows (setGraphRunObserver, likewise).

import * as wf from "../workflows.js";
import * as store from "../store.js";
import { T } from "../i18n.js";
import * as notifications from "../notify.js";
import { recordNotice } from "../services.js";
import { broadcast, sse } from "../runtime/sse.js";
import { isScheduledTurn } from "../scheduled/notification.js";

// ── Trigger wakeup ───────────────────────────────────────────────────────────
// A setter instead of an import, following setStartGate (providers/index.js) and setRunState
// (runtime/sse.js): importing ./triggers.js directly would close a cycle (triggers.js runs the
// run via driver.js, and driver.js reads a dozen names back from here).
// Unset, the wakeup SILENTLY DOES NOTHING — that is correct here: the wakeup only speeds up the
// tick of the trigger poller, and where no poller runs (locally without triggers, tests with
// CBASE_TRIGGER_POLL=0) there is nothing to wake; scheduleTriggerDrain itself bails out first
// in exactly that case. Because forgotten wiring would be silent, a test of its own pins the
// path: server/backend/test/gitlab-trigger.test.js (the wakeup starts the event that was waiting
// for the lock as soon as the holder is done) — without the registration in server.js it turns red.
let triggerWakeup = null;
function setTriggerWakeup(fn) {
  triggerWakeup = typeof fn === "function" ? fn : null;
}

// ── Observer of the graph workflows ──────────────────────────────────────────
// The same setter pattern: every change of a run (emitWorkflowRun) reaches workflows/graph-background.js
// graphRunSeen — the card of the starting chat stays current, a wait is reported (silent hint, bell, push),
// at the end of a background run the completion notice arrives. An import would be a cycle
// (graph-background → graph-start → driver → run-state).
// Unset (unit tests without a server) nothing is reported. A throw of the observer costs the run nothing.
let graphRunObserver = null;
function setGraphRunObserver(fn) {
  graphRunObserver = typeof fn === "function" ? fn : null;
}

// ── Workflows: node/edge graph, step by step ─────────────────────────────────
// A chat runs at most ONE workflow (selectable only in a chat that has not started yet).
// The driver sits on the server, not in the prompt: EVERY instruction node is a turn of its own
// (doRun), a small model judges conditions and loop lists (runOnce), a question pauses the run.
// Only this way is the progress correct even when the model would read the graph differently
// from how it is meant.
const WORKFLOW_MAX_STEPS = Math.max(1, Number(process.env.CBASE_WORKFLOW_MAX_STEPS || 60));
// Round cap of a step when the node carries no number of its own. The step limit above is the
// coarse ripcord (the run FAILS); the cap is the fine one: it halts and asks.
const WORKFLOW_MAX_VISITS = Math.max(1, Number(process.env.CBASE_WORKFLOW_MAX_VISITS || wf.DEFAULT_MAX_VISITS));
// The rounds of the completion gate ("check completion") are NOT here: they are a run setting
// per workflow (`run.doneRounds`, 1…10, default wf.DONE_ROUNDS_DEFAULT) — a hidden number that
// silently overrules the UI would be a description side that does not match the execution.
// Deliberately triggered interruptions (skip/cancel). Without this marker the error path of
// doRun would count the turn stopped by the user as a failed step.
const workflowIntent = new Map(); // chatId -> "skip" | "cancel"

const workflowGraph = (run) => {
  const w = run && store.getWorkflow(run.workflowId);
  return w ? { workflow: w, graph: wf.normalizeGraph(w.graph) } : null;
};
// Public view of a run (progress strip in both clients).
function workflowRunView(run) {
  if (!run) return null;
  const g = workflowGraph(run);
  const counts = g ? wf.countSteps(g.graph) : { total: run.total, approx: false };
  const frame = run.cursor?.frames?.length ? run.cursor.frames[run.cursor.frames.length - 1] : null;
  return {
    id: run.id, chatId: run.chatId, workflowId: run.workflowId, name: run.workflowName,
    // The number comes from the CURRENT graph, not from the state at the start: whoever extends
    // a workflow while a run is waiting would otherwise get "step 6 / 2" — a frozen number next
    // to a live-computed `approx`. Only without a graph (deleted workflow) the stored number stays.
    status: run.status, step: run.step, total: g ? counts.total : run.total, approx: counts.approx,
    nodeId: run.nodeId, nodeTitle: run.nodeTitle, question: run.question, note: run.note,
    // What is a `waiting` run waiting for? "" = question node, "cap" = decision at the round cap,
    // "review" = a human should check the state.
    pending: wf.pendingOf(run.cursor)?.kind || "",
    // ONLY while the run is alive: the cursor keeps its frames after the end too, and a cancelled
    // run would otherwise keep showing "element 3/5" as if it were still working on it.
    loop: frame && store.workflowOpen(run)
      ? { index: frame.index + 1, total: frame.items.length, item: frame.items[frame.index] || "" } : null,
    // Total runtime: `endedAt` is only set after the end (0 = still running, then the client
    // keeps counting against its own clock). An old run without ended_at gets its last change
    // time instead — the same rule as in the run history.
    startedAt: run.startedAt, updatedAt: run.updatedAt,
    endedAt: run.endedAt || (["done", "failed", "cancelled"].includes(run.status) ? run.updatedAt : 0),
    // The workflow's OWN compaction values (`null` = default), always present. The client shows
    // the hint line in the auto menu from them and computes the marker of the context bar —
    // while the run is open, `percent ?? chat.autocompact` applies.
    compaction: (() => {
      const s = wf.normalizeRunSettings(g?.workflow?.run);
      return { percent: s.autocompact, max: s.autocompactMax };
    })(),
  };
}
// View of a run for the HISTORY (list and detail). The cursor stays out: it is the driver's
// internals and would only bloat the response.
// Is a run's total only estimated? The same question as in `workflowRunView` — without it the
// list would show "9/8" and read like a broken counter while the prompt tells the agent
// "step 9/approx. 8". The answer is cached PER WORKFLOW — the list carries up to 100 runs that
// share a few workflows.
function countCalculator() {
  const cache = new Map();
  return (run) => {
    const id = run?.workflowId || "";
    if (!cache.has(id)) {
      const g = workflowGraph(run);
      cache.set(id, g ? wf.countSteps(g.graph) : null);
    }
    const c = cache.get(id);
    // BOTH numbers from the same source. If only `approx` came from today's graph and `total`
    // from the frozen row, they would contradict each other as soon as someone edited the
    // workflow after the run — and "9/8" would be back.
    if (c) return { total: c.total, approx: !!c.approx };
    // Without a graph (deleted workflow) the stored number stays — and the observation that an
    // exceeded total WAS an estimate.
    return { total: run.total, approx: (run.step | 0) > (run.total | 0) };
  };
}
function runHistoryView(run, counts = null) {
  if (!run) return null;
  const ended = run.endedAt || (["done", "failed", "cancelled"].includes(run.status) ? run.updatedAt : 0);
  return {
    id: run.id, chatId: run.chatId, chatGone: run.chatGone,
    workflowId: run.workflowId, name: run.workflowName,
    status: run.status, step: run.step, total: counts ? counts.total : run.total, approx: counts ? counts.approx : false,
    nodeId: run.nodeId, nodeTitle: run.nodeTitle, question: run.question, note: run.note,
    origin: run.origin || "", trigger: run.triggerEvent || null,
    workspaceId: run.workspaceId, projectId: run.projectId,
    startedAt: run.startedAt, updatedAt: run.updatedAt, endedAt: ended,
    durationMs: ended ? Math.max(0, ended - run.startedAt) : 0,
  };
}
function emitWorkflowRun(chatId, run) {
  const view = workflowRunView(run);
  if (!view) return null;
  sse(chatId, { type: "harness", subtype: "workflow_run", run: view });
  broadcast({ type: "workflow_run", chatId, runId: view.id, status: view.status });
  try { graphRunObserver?.(chatId, view); } catch (e) { console.error("[workflow] graph observer:", e?.message || e); }
  // An ended run has released its lock (store.updateWorkflowRunById) → waiting events should
  // NOT stay put until the next regular tick.
  if (["done", "failed", "cancelled"].includes(view.status)) triggerWakeup?.();
  return view;
}
// A row into the history (role "workflow") AND live into the chat stream — after a reload the
// history must show the same as the live stream.
// The row is sent NESTED (`line`), not spread into the envelope: a row carries a field `type`
// itself (the node kind) and would overwrite `type: "harness"` — the event would bypass the
// harness branch of the clients and the step would be missing from the history.
function workflowNote(chatId, row) {
  store.addMessage(chatId, "workflow", JSON.stringify(row));
  sse(chatId, { type: "harness", subtype: "workflow_step", line: row });
}
// ── Push verdict ─────────────────────────────────────────────────────────────
// The gateway does not know the database — it has neither chats nor settings. The decision is
// therefore made HERE and travels as a stamp on the event; the other side only obeys.
// Precedent: the `push` field the run end has always carried.
function pushVerdictForNote(ev) {
  const kind = notifications.kindOfKind(ev?.kind);
  let chat = null;
  try {
    // For `schedule` too: the run chat carries the choice inherited from the schedule. Only where
    // NO chat is attached at all (service outage) the global default alone counts.
    const chatId = ev?.chatId || null;
    if (chatId) chat = store.getChat(chatId);
  } catch { /* an unreadable row must not cost the notification */ }
  const choice = chat?.notify || {};
  const global = notifications.globalDefaults(store.getSetting);
  // In a scheduled turn question and approval ALWAYS push — the human is not sitting in front of it, and the run stands
  // still until they answer. Their own turns in the same chat follow the choice.
  const scheduledAlways = (kind === "question" || kind === "approval") && isScheduledTurn(chat);
  return {
    category: kind,
    push: scheduledAlways || notifications.pushAllowed(kind, choice, global),
    // On the lock screen the CHAT NAME is on top and the kind below it. The bell's title
    // ("Question: Foo") stays as it is — it reads better in a list there.
    pushTitle: ev?.chatTitle || chat?.title || "",
    pushSubtitle: notifications.kindLabel(kind),
  };
}

// Remove control characters (except line break and tab) from a text. A NUL byte would cut off
// the history when read from SQLite while the model got the full text — chat and reality would
// drift apart without an error anywhere.
const withoutControlCharacters = (v) => String(v ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");

// First lines of a long text — for notifications and task descriptions that need a teaser, not
// an essay. Empty lines are dropped so that "…" does not stand alone.
function firstLines(text, max = 160) {
  const s = String(text || "").split("\n").map((l) => l.trim()).filter(Boolean).join(" · ");
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
// Checkbox "notify when reached" (configurable on EVERY node): a triggered run works away for
// hours — which step is worth a look only the person who built the workflow knows. The review
// node does NOT report here, but only when it really waits (then the test instructions are
// fixed) — otherwise the same thing would arrive twice.
function notifyNodeReached(chat, run, node) {
  if (!node?.notify || node.type === "review") return;
  const name = node.title || node.id;
  recordNotice({
    kind: "workflow",
    chatId: chat.id,
    chatTitle: chat.title || "",
    workspaceId: chat.workspaceId,
    projectId: chat.projectId || null,
    title: node.type === "end"
      ? T`Workflow "${run.workflowName}" reached the end`
      : T`Step reached: ${name}`,
    body: [run.workflowName, chat.title].filter(Boolean).join(" · "),
  });
}
// The same decision additionally into the PERMANENT step log of the run. Separate from
// workflowNote because things belong here that have no place in the chat: the complete prompt,
// the raw output of a failed verdict, error texts. Returns the row id so the caller can add
// duration and result after the turn.
function logRunStep(run, kind, { nodeId = "", nodeTitle = "", step = 0, detail = {} } = {}) {
  if (!run?.id) return null;
  try { return store.addRunStep(run.id, { kind, nodeId, nodeTitle, step, detail }); }
  catch (e) { console.error("[workflow] step log:", e?.message || e); return null; }
}
// Duration of a step: measured from the moment the turn was started.
// The row carries the RUN ID: without it any later run of the same chat would close the open
// step of a foreign run — and write its own output into it as the result.
const runStepStart = new Map(); // chatId -> { rowId, at, runId, kind }

// The still OPEN step of a run, from the database. A closed row carries an `ok` or an `error`
// in its detail; anything else is unfinished. This way the assignment survives a backend
// restart — the map above is memory only, and the row of an interrupted turn would otherwise
// stay without duration and result forever.
function openStepRow(runId) {
  if (!runId) return null;
  let rows = [];
  try { rows = store.listRunSteps(runId); } catch { return null; }
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r.kind !== "step" && r.kind !== "command") continue;
    const d = r.detail || {};
    // `limited` counts like a closure: the row waits for the reset, it no longer runs. Without
    // this condition `closeRunStep` would take it for open, adopt it and overwrite the parked
    // marker with the result of an entirely different step.
    return ("ok" in d || "error" in d || d.limited === true) ? null : r;
  }
  return null;
}
// Close the open step of ONE run. If the map is empty (restart) or its entry belongs to another
// run, the row is looked up in the database and measured from its own timestamp.
// `false` = there was nothing to close.
function closeRunStep(run, { output = null, ok = true, error = "" } = {}) {
  if (!run?.id || !run?.chatId) return false;
  const mem = runStepStart.get(run.chatId);
  const own = mem && (!mem.runId || mem.runId === run.id) ? mem : null;
  if (mem && !own) return false; // the map belongs to a FOREIGN run — do not touch
  const row = own ? null : openStepRow(run.id);
  const rowId = own ? own.rowId : row?.id;
  const at = own ? own.at : (row?.at || Date.now());
  // Clear BEFORE the row check: if `logRunStep` failed, the entry carries no row id — and would
  // stay behind as a corpse so that EVERY further closure of this step failed on it.
  if (own) runStepStart.delete(run.chatId);
  if (!rowId) return false;
  try {
    store.finishRunStep(rowId, {
      durationMs: Math.max(1, Date.now() - at),
      detail: ok
        // After a restart THIS row is the only source for `lastOutput` (see lastOutput). It must
        // be capped at the verdict cap, the same way and with the truncation note
        // (`clipForVerdict`) — a silent shorter cut would make the verdict read a mutilated
        // report as a complete one on the resume path.
        ? { output: wf.clipForVerdict(output, wf.RESULT_MAX), ok: true, ...(own ? {} : { adopted: true }) }
        : { ok: false, error: String(error || "").slice(0, 300), ...(own ? {} : { adopted: true }) },
    });
  } catch { return false; }
  return true;
}
// Does the run that is in the database NOW still belong to the operation that began before the
// `await`? A verdict takes seconds; in that time the human can skip, cancel or stop. Whoever
// writes unchecked afterwards overwrites the cursor of a foreign step or writes into a run that
// ended long ago.
function runStillOur(chatId, prior) {
  const now = store.getWorkflowRun(chatId);
  if (!now || !prior) return null;
  if (now.id !== prior.id) return null;
  if (now.status !== prior.status) return null;
  if (now.step !== prior.step) return null;
  if ((now.cursor?.at || "") !== (prior.cursor?.at || "")) return null;
  // Status, step and cursor alone are NOT enough: a stop during a verdict sets `waiting` and the
  // "continue" afterwards `running` again — with the same step and the same node. The returning
  // verdict would see the same state as before and still write, although it belongs to an
  // aborted operation. The number counts exactly these interruptions.
  if ((now.cursor?.gen || 0) !== (prior.cursor?.gen || 0)) return null;
  return now;
}
// Count an interruption (stop, continue): everything that was in an `await` BEFORE this mark no
// longer belongs to the run afterwards.
const nextGeneration = (cursor) => ({ ...(cursor || {}), gen: Number(cursor?.gen || 0) + 1 });
// The output of the last COMPLETED step of a run. After a restart it is the only source for
// `lastOutput` — without it a condition judges "(no previous step)", that is, nothing.
function lastOutput(runId) {
  if (!runId) return "";
  let rows = [];
  try { rows = store.listRunSteps(runId); } catch { return ""; }
  for (let i = rows.length - 1; i >= 0; i--) {
    const d = rows[i].detail || {};
    if (rows[i].kind === "step" && typeof d.output === "string" && d.output) return d.output;
  }
  return "";
}

// `opts.at` starts at a specific node (the trigger that fired), `opts.vars` puts the event
// variables into the cursor ({{event}}, {{url}} … in every step).
// Lock key of a run: "what is mutually exclusive here?" (see workflows.js). Empty means parallel
// is allowed. The project comes from the CHAT (that is where the work happens), otherwise from
// the workflow; the event variables allow keys per issue/MR.
function runLockKey(workflow, chat, vars, input = "") {
  return wf.lockKeyFor(workflow.lock, {
    workflowId: workflow.id,
    projectId: chat?.projectId || workflow.projectId || "",
    // Without a project the workspace is the shared object — the working directory in which
    // two runs overwrite each other's files lives there.
    workspaceId: chat?.workspaceId || workflow.workspaceId || "",
    // A manual start must pass the input: otherwise {{input}} in a custom template could
    // never be resolved although the description offers it.
    vars: { ...(vars || {}), ...(input ? { input: String(input).slice(0, 400) } : {}) },
  });
}
// Does someone else hold this run's lock? → { key, lock } (otherwise { key, lock: null }).
function lockSituation(workflow, chat, vars, input = "") {
  const key = runLockKey(workflow, chat, vars, input);
  if (!key) return { key: "", lock: null };
  const holder = store.lockHolder(key);
  return { key, lock: holder && holder.chatId !== chat?.id ? holder : null };
}

export { WORKFLOW_MAX_STEPS, WORKFLOW_MAX_VISITS, closeRunStep, emitWorkflowRun, firstLines, runStillOur, lastOutput, lockSituation, logRunStep, nextGeneration, notifyNodeReached, withoutControlCharacters, pushVerdictForNote, runHistoryView, runLockKey, runStepStart, setGraphRunObserver, setTriggerWakeup, workflowGraph, workflowIntent, workflowNote, workflowRunView, countCalculator };
