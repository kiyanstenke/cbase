// The observer of graph workflows in the background. A background run runs in its child chat; the orchestrator — the
// chat whose turn started it — only sees it through its row in `graph_starts`. Every change reaches it here:
//
// graphRunSeen(chatId, view)     the observer at emitWorkflowRun (run-state.js setGraphRunObserver, server.js): the row
//                                of the run (ONE query — without a row nothing happens), the event `graph_run` to the
//                                orchestrator, then the wait and the end (graphFollowUps).
// graphRowChanged(z, {prior})    the observer at every change of a row (graph-start.js setGraphRowsObserver): the
//                                event has already been sent; here only wait and end — so an end WITHOUT a run also
//                                reaches the orchestrator (stopped by the human while the row waited for the lock;
//                                dismissed in the queue).
// waitDetail                     lives in graph-wait.js (the run view reads it — here it would be a cycle).
// graphCompletionNotice(z, …)    the completion notice (`<task-notification>`, shape of runs/completionNotice.js,
//                                identifiers of the start) — pure, exported for tests.
// graphApprovalRequestHook / graphApprovalRulingHook  hooks "beforePermission"/"afterPermission": a permission in the
//                                child chat is a wait for the human (the view then says "waiting" although the run is
//                                running) — event, hint and notification, or their end.
// graphChatClosed                hook "chatClosed": a child chat was deleted by hand, the orchestrator lives — the row
//                                becomes `stopped` (by "erase", without child), a silent hint, no completion notice
//                                (the same happens when a dynamic workflow is deleted).
//
// When a wait begins (a NEW instance, graph-wait.js instanceOf — remembered in memory; after a restart a hint arrives
// twice at most): a silent hint to the orchestrator (runs/hints.js — it does not wake: the orchestrator never answers)
// and for question · cap · done · stopped · permission a notification of kind "question" on the child chat (bell,
// push, can be switched off per kind; no new kind in notify.js). review, agent_ask and dyn_approval already report
// themselves (workflows/gates.js, runs/ask.js) — no double report. When a wait ends: its own notification is settled
// (resolveNotices with its requestId `graph:<startId>:<instance>`).
//
// At the end (finished, failed, stopped) of a background run: the output file `graph-<startId>.json` in the
// orchestrator's output location (runs/outputs.js — it is also the permanent marker "already reported"), the completion
// notice via the ONE wake path (runs/queue.js deliverUserPrompt, cause "agent" — if a turn is running, it arrives at
// the tool boundary), then backgroundEnds (a turn that deferred asks again; modelled on dynworkflows/run.js). If the
// agent stopped it itself (`stoppedOf` "agent": cbase_workflow_stop tells it that nothing more is coming) or the
// deletion of the orchestrator stopped it ("erase"), only backgroundEnds. A stop by the human gets the notice with
// `stopped`.
//
// Foreground runs (the same chat runs them) get NOTHING here: the chat sees its run anyway (workflow_run, banner), and
// an event per step would show up in the recording of the golden scenario graph-start. The one exception is the run's
// own worktree (see below) — only with it, only at the end.
//
// The run's own worktree (both kinds): at the end it is removed if unchanged (worktree.js removeGraphWorktree without
// force; `worktree_path` becomes empty, the view reports it), otherwise it stays — its path is then in the view (card
// or strip) and in the completion notice; in the foreground a silent hint to the own chat is added ("The worktree with
// changes stays: …"). In the background the completion notice only goes out AFTER this check — it names the path only
// if it stays. Checked once per start (remembered in memory). On deletion (graphChatClosed) the worktrees of all rows
// of the chat or of the child are removed with force before chats/erase.js tidyUp deletes the rows.
//
// Whatever was still on its way to the node agent at the end lapses in the SAME transition that writes the completion
// notice, for every outcome (finished, failed, stopped — by the agent or by deletion too —, dismissed) and when the
// child chat is deleted: letExpire. What was earmarked for the run and the "message" entries in the child chat's queue
// are `expired` afterwards, and EVERY sender gets exactly one note — the parent chat a silent hint (it does not wake,
// the completion notice does that anyway), a channel a system note `expired` as a card in every participant's history
// WITHOUT a wake turn (channels/delivery.js channelSystemNote; the model reads it with the next delivery); the child
// chat gets a separator (role `hint`), because its history rows would otherwise make the message look delivered.
// Exactly once, because only what was still earmarked lapses — graphFollowUps runs again at every further event of the
// ended run.

import fs from "node:fs";
import path from "node:path";
import * as store from "../store.js";
import { T } from "../i18n.js";
import { recordNotice, resolveNotices } from "../services.js";
import { depositHint } from "../runs/hints.js";
import { deliverUserPrompt } from "../runs/queue.js";
import { backgroundEnds } from "../runs/background.js";
import { createOutputLocation } from "../runs/outputs.js";
import { writeInRuntimeFolder } from "../runs/runtime-write.js";
import { FINISHED_RESULT_MAX, FINISHED_MARKER } from "../runs/completionNotice.js";
import { lastOutput } from "./run-state.js";
import { graphRunView, reportGraphRun } from "./graph-start.js";
import { removeGraphWorktree } from "./worktree.js";
import { instanceOf } from "./graph-wait.js";
import { takeOverQueue } from "./graph-message.js";
import { channelSystemNote } from "../channels/delivery.js";

const QUESTION_HINT_MAX = 300;
const WAITING = ["earmarked", "waiting_lock", "waiting_storage"];
const END = new Set(["finished", "failed", "stopped", "dismissed"]);
// These kinds are reported here; the others already report themselves (see header).
const REPORT = new Set(["question", "cap", "done", "stopped", "permission"]);
// The kind of wait in words (hint to the orchestrator).
const KIND_WORD = {
  question: () => T("question node"), cap: () => T("round cap"), review: () => T("review"),
  done: () => T("completion check"), stopped: () => T("paused##graphWait"), agent_ask: () => T("question card"),
  dyn_approval: () => T("approval of a dynamic workflow"), permission: () => T("permission"),
};

// startId → { instance, requestId, chatId } — the open wait per start (its notification carries `requestId`).
const openWait = new Map();

const xml = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const truncate = (s, max) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };

// ── Waiting ──────────────────────────────────────────────────────────────────────────────────────────────────

function waitEnds(startId) {
  const old = openWait.get(startId);
  if (!old) return;
  openWait.delete(startId);
  resolveNotices({ id: old.chatId, requestId: old.requestId, kinds: ["question"] });
}

function waitReconcile(z, run) {
  const w = run?.wait || null;
  const instance = w ? instanceOf(w, run.run) : "";
  const old = openWait.get(z.id);
  if ((old?.instance || "") === instance) return;
  waitEnds(z.id);
  if (!instance) return;
  const runChatId = z.childChatId || z.chatId;
  const requestId = `graph:${z.id}:${instance}`;
  openWait.set(z.id, { instance, requestId, chatId: runChatId });
  const kindWord = Object.hasOwn(KIND_WORD, w.kind) ? KIND_WORD[w.kind]() : w.kind;
  const question = truncate(w.question, QUESTION_HINT_MAX);
  depositHint(z.chatId, T`Your graph workflow "${z.workflowName}" in the background is waiting for the human (${kindWord}): ${question || "—"}. You do not answer — the human answers through the card.`, { source: "graph-workflow" });
  if (!REPORT.has(w.kind)) return;
  const child = store.getChat(runChatId);
  recordNotice({
    kind: "question",
    title: T`Waiting: ${z.workflowName}`,
    body: w.question || "",
    chatTitle: child?.title || z.workflowName,
    chatId: runChatId, workspaceId: child?.workspaceId || null, projectId: child?.projectId || null,
    requestId,
  });
}

// ── End ──────────────────────────────────────────────────────────────────────────────────────────────────────

const outputFile = (orchestratorId, startId) => path.join(createOutputLocation(orchestratorId), `graph-${startId}.json`);

// The branch of a worktree from `worktree_info` (plain JSON) — empty when there is none.
function worktreeBranch(z) {
  try { return String(JSON.parse(z.worktreeInfo || "null")?.branch || ""); } catch { return ""; }
}

/**
 * The completion notice of a background run. `status` completed · failed · stopped; `run` the view of the run
 * (workflowRunView) or `null` (stopped before the start); `result` the last output; `outputPath` the output file.
 */
function graphCompletionNotice(z, { status, run = null, note = "", result: resultValue = "", outputPath = "" }) {
  const name = z.workflowName;
  const summary = status === "completed" ? `Graph-Workflow "${name}" completed`
    : status === "stopped" ? `Graph-Workflow "${name}" was stopped`
      : `Graph-Workflow "${name}" failed: ${String(note || "").split("\n")[0].slice(0, 300)}`;
  const full = String(resultValue || "").trim();
  const result = full.length > FINISHED_RESULT_MAX
    ? `${full.slice(0, FINISHED_RESULT_MAX)}\n[… truncated — the full output is in the output file]`
    : full;
  const steps = run ? `${Number(run.step) || 0}/${Number(run.total) || 0}` : "0/0";
  const child = z.childChatId || "—";
  let diag = run
    ? `Child chat ${child}, run ${run.id}, steps ${steps}.`
    : `Child chat ${child}, not started (${z.reason || z.status}).`;
  if (z.worktreePath) {
    const branch = worktreeBranch(z);
    diag += ` Worktree with changes stays: ${z.worktreePath}${branch ? ` (branch ${branch})` : ""}.`;
  }
  return [
    FINISHED_MARKER,
    `<task-id>${xml(z.id)}</task-id>`,
    ...(z.callId ? [`<tool-use-id>${xml(z.callId)}</tool-use-id>`] : []),
    ...(outputPath ? [`<output-file>${xml(outputPath)}</output-file>`] : []),
    `<status>${status}</status>`,
    `<name>${xml(name)}</name>`,
    `<summary>${xml(summary)}</summary>`,
    `<result>${xml(result)}</result>`,
    `<diagnostics>${xml(diag)}</diagnostics>`,
    "<note>This is a system message about your graph workflow in the background, not a user reply. Evaluate it and continue working.</note>",
    "</task-notification>",
  ].join("\n");
}

const STATUS_OF = { finished: "completed", failed: "failed", stopped: "stopped" };

function runEnds(z, runItem, { prior = "" } = {}) {
  const orch = store.getChat(z.chatId);
  if (!orch) return; // the orchestrator was deleted first — nobody left to wake
  // Stopped by the agent itself, or the deletion of the orchestrator stopped it: no notice, only the holding turn asks again.
  if (z.stoppedOf === "agent" || z.stoppedOf === "erase") { backgroundEnds(orch.id); return; }
  const run = runItem.run;
  // Dismissed in the queue (the workflow is gone, the child chat is missing): no run, hence no completion notice — a
  // silent hint if the row had already been accepted and was waiting; dismissed within the call itself is said by the tool result.
  if (runItem.state === "dismissed") {
    if (prior === "waiting_lock" || prior === "waiting_storage") {
      depositHint(orch.id, T`Your graph workflow "${z.workflowName}" in the background does not start: ${z.reason}`, { source: "graph-workflow" });
    }
    backgroundEnds(orch.id);
    return;
  }
  const status = STATUS_OF[runItem.state];
  if (!status) return;
  let file;
  try {
    file = outputFile(orch.id, z.id);
    if (fs.existsSync(file)) return; // already reported (across a restart too)
  } catch (e) { console.error("[graph-background] output location:", e?.message || e); return; }
  const note = run?.note || (status === "stopped" ? T("Stopped by the human.") : "");
  const result = z.runId ? lastOutput(z.runId) : "";
  const content = {
    startId: z.id, name: z.workflowName, status, note, childChatId: z.childChatId, runId: z.runId,
    lastOutput: result, worktree: z.worktreePath ? { path: z.worktreePath, branch: worktreeBranch(z) } : null,
  };
  // Inside the runtime folder via the descriptor (runs/runtime-write.js): a dangling link `graph-<id>.json → /somewhere`
  // passes the pre-check above (existsSync follows it into nowhere) and would make the backend create the notice there.
  const json = `${JSON.stringify(content, null, 2)}\n`;
  try { if (!writeInRuntimeFolder(file, json)) fs.writeFileSync(file, json); } catch (e) { console.error("[graph-background] output file:", e?.message || e); }
  const text = graphCompletionNotice(z, { status, run, note, result, outputPath: file });
  try { deliverUserPrompt(orch, { prompt: text, display: text, cause: "agent" }); }
  catch (e) { console.error("[graph-background] completion notice:", e?.message || e); }
  // AFTER the delivery (as in dynworkflows/run.js): a holding turn has already taken up the notice by then.
  backgroundEnds(orch.id);
}

// ── Lapsing ──────────────────────────────────────────────────────────────────────────────────────────────────

const expiredSet = (n, name) => (n === 1
  ? T`A message to the graph workflow "${name}" was not delivered — the run ended before the next node.`
  : T`${n} messages to the graph workflow "${name}" were not delivered — the run ended before the next node.`);

/**
 * At the end of the run of row `z` (see header): earmarked and queued messages become `expired`, exactly one note per
 * sender. `childGone`: the child chat is being deleted right now — then no separator there and no card for it. Also called
 * from workflows/graph-message.js messageFromQueue (via setExpiredConsumer, server.js): an entry that came out of the
 * queue after the end.
 */
function letExpire(z, { childGone = false } = {}) {
  if (!z?.id || !z.background) return;
  const childId = childGone ? null : z.childChatId;
  if (childId) takeOverQueue(childId, z, { withoutRow: true });
  const expired = store.expireGraphMessages(z.id);
  if (!expired.length) return;
  if (childId && store.getChat(childId)) {
    try { store.addMessage(childId, "hint", expiredSet(expired.length, z.workflowName)); } catch (e) { console.error("[graph-background] separator:", e?.message || e); }
  }
  const chats = new Map();
  const channels = new Map();
  for (const n of expired) {
    if (n.channelId) channels.set(n.channelId, (channels.get(n.channelId) || 0) + 1);
    else { const c = n.ofChatId || z.chatId; chats.set(c, (chats.get(c) || 0) + 1); }
  }
  for (const [chatId, n] of chats) if (store.getChat(chatId)) depositHint(chatId, expiredSet(n, z.workflowName), { source: "graph-workflow" });
  for (const [channelId, n] of channels) {
    const channel = store.getChannel(channelId);
    if (!channel) continue;
    try { channelSystemNote(channel, "expired", expiredSet(n, z.workflowName), { without: childGone ? z.childChatId : null }); }
    catch (e) { console.error("[graph-background] channel note expired:", channelId, e?.message || e); }
  }
}

// ── Worktree ─────────────────────────────────────────────────────────────────────────────────────────────────

// startId → the running cleanup at the end; startIds whose end has already been checked (a changed worktree stays and
// is not re-checked at every further event, its hint not written twice).
const worktreeCleans = new Map();
const worktreeChecked = new Set();

function worktreeInfo(z) {
  try { const v = JSON.parse(z.worktreeInfo || "null"); return v && typeof v.dir === "string" && v.dir ? v : null; } catch { return null; }
}

/** At the end of a run: unchanged ⇒ remove and clear `worktree_path`, changed ⇒ leave in place. Returns the row afterwards. */
function worktreeAtEnd(z) {
  if (!z.worktreePath || worktreeChecked.has(z.id)) return Promise.resolve(z);
  if (worktreeCleans.has(z.id)) return worktreeCleans.get(z.id);
  const info = worktreeInfo(z);
  const p = (async () => {
    if (!info) return z;
    const r = await removeGraphWorktree(info);
    worktreeChecked.add(z.id);
    if (r.error.length) console.error("[graph-background] worktree removal:", z.id, r.error.join(" · "));
    if (r.removed) return store.changeGraphStart(z.id, { worktreePath: "" }) || z;
    if (!z.background && r.changed && store.getChat(z.chatId)) {
      depositHint(z.chatId, T`The worktree with changes stays: ${info.dir} (branch ${info.branch}).`, { source: "graph-workflow" });
    }
    return store.graphStart(z.id) || z;
  })().finally(() => worktreeCleans.delete(z.id));
  worktreeCleans.set(z.id, p);
  return p;
}

/** Foreground: only with a worktree, only at the end — remove or leave in place; a cleared path goes out as an event. */
function foregroundFollowUps(z, run) {
  if (!z.worktree || !z.worktreePath || !run || !END.has(run.state)) return;
  worktreeAtEnd(z)
    .then((fresh) => { if (!fresh.worktreePath && store.getChat(fresh.chatId)) reportGraphRun(fresh); })
    .catch((e) => console.error("[graph-background] worktree at end:", z.id, e?.message || e));
}

/** On deletion: the worktrees of all rows of this chat (as orchestrator) and of its child row, with force. */
function removeWorktrees(chatId) {
  for (const w of store.graphWorktreesOf(chatId)) {
    worktreeChecked.add(w.startId);
    store.changeGraphStart(w.startId, { worktreePath: "" });
    removeGraphWorktree(w.info, { force: true })
      .then((r) => { if (r.error.length) console.error("[graph-background] worktree on deletion:", w.startId, r.error.join(" · ")); })
      .catch((e) => console.error("[graph-background] worktree on deletion:", w.startId, e?.message || e));
  }
}

// ── The observers ────────────────────────────────────────────────────────────────────────────────────────────

/** Wait and end of a row whose view `run` was just reported. Background; in the foreground only the worktree (see header). */
function graphFollowUps(z, run, { prior = "" } = {}) {
  if (!z || !run) return;
  if (!z.background) { foregroundFollowUps(z, run); return; }
  waitReconcile(z, run);
  if (END.has(run.state)) {
    waitEnds(z.id);
    // Whatever was still on its way to the node agent lapses — BEFORE the completion notice (its turn then already carries the hint).
    letExpire(z);
    // With a worktree check first and remove if applicable — the completion notice names the path only if it stays.
    if (z.worktreePath) {
      worktreeAtEnd(z)
        .then((fresh) => runEnds(fresh, fresh.worktreePath === z.worktreePath ? run : (reportGraphRun(fresh) || run), { prior }))
        .catch((e) => console.error("[graph-background] worktree at end:", z.id, e?.message || e));
      return;
    }
    runEnds(z, run, { prior });
  }
}

/** The observer at emitWorkflowRun (run-state.js). */
function graphRunSeen(chatId, view) {
  if (!view?.id) return;
  const z = store.graphStartOfTheRun(chatId, view.id);
  if (!z) return;
  // Foreground: no event per step — only the worktree at the end, computed without reporting.
  if (!z.background) { if (z.worktree && z.worktreePath) foregroundFollowUps(z, graphRunView(z)); return; }
  graphFollowUps(z, reportGraphRun(z));
}

/** The observer at every change of a row (graph-start.js) — the event has already been sent. */
function graphRowChanged(z, run, { prior = "" } = {}) {
  graphFollowUps(z, run, { prior });
}

// The row of a background run whose child chat this is and whose run is open — otherwise `null`.
function rowWithOpenRun(chatId) {
  const z = store.graphStartOfChild(chatId);
  if (!z || z.status !== "started" || !z.runId) return null;
  return store.workflowOpen(store.getWorkflowRunById(z.runId)) ? z : null;
}

/** Hook "beforePermission": the request is already in pendingPermissions — the view says "waiting". */
function graphApprovalRequestHook({ chatId }) {
  const z = rowWithOpenRun(chatId);
  if (z) graphFollowUps(z, reportGraphRun(z));
}

/** Hook "afterPermission": the request has left pendingPermissions — the wait ends (the view runs again). */
function graphApprovalRulingHook({ chatId }) {
  const z = rowWithOpenRun(chatId);
  if (z) graphFollowUps(z, reportGraphRun(z));
}

/**
 * Hook "chatClosed": every chat passes through here. First the worktrees of all its rows, with force — as orchestrator
 * tidyUp deletes the rows right afterwards. Then the case that a child chat fell (deleted by hand) and its
 * orchestrator lives.
 */
function graphChatClosed({ chatId }) {
  removeWorktrees(chatId);
  const z = store.graphStartOfChild(chatId);
  if (!z) return;
  waitEnds(z.id);
  letExpire(z, { childGone: true });
  // The run was open if the row was still waiting or its run was only closed by the deletion (store.deleteChat →
  // abandonWorkflowRuns: `cancelled` with the note "Chat deleted"). A run that had already ended keeps its outcome.
  const run = z.runId ? store.getWorkflowRunById(z.runId) : null;
  const wasOpen = WAITING.includes(z.status) || (z.status === "started" && (!run || (run.status === "cancelled" && run.note === store.CHAT_DELETED_NOTE)));
  const fresh = store.changeGraphStart(z.id, { childChatId: null, ...(wasOpen ? { status: "stopped", stoppedOf: "erase" } : {}) });
  const orch = store.getChat(z.chatId);
  if (!orch) return;
  reportGraphRun(fresh);
  depositHint(orch.id, T`The human deleted the background run "${z.workflowName}".`, { source: "graph-workflow" });
  backgroundEnds(orch.id);
}

// Only for the runtime-write test: the end of a run (output file and completion notice) without a whole graph run.
// No caller in the product.
const _runEnds = runEnds;

export {
  _runEnds, graphChatClosed, graphCompletionNotice, graphApprovalRequestHook, graphApprovalRulingHook, graphRunSeen,
  graphRowChanged, letExpire,
};
