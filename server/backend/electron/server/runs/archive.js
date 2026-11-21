// The archive as seen from the runs: a chat's open work (`openWork`, the reasons `ARCHIVE_REASONS`), fetching back
// through work (`fetchBack`, called as the second statement of `doRun`) and the ONE broadcast `chat_archive`
// (`reportArchive`). Plus the list parameter `archive` (`archivePage`) — one list of the allowed values, not two.
//
// The rule that hangs here: NOTHING EVER RUNS IN THE ARCHIVE. Open work prevents archiving (the routes check
// `openWork`, 409 with the reasons), and every run start fetches its chat back — at ONE place, in doRun right after
// `running.add` and BEFORE the credit gate: a run parked there is open work (wait row) and does not belong in the
// archive. So the rule holds by construction, also for paths nobody knows yet. EXCEPTION: the causes "channel" and
// "message" do NOT fetch back — no agent fetches a chat from the archive; their delivery stops beforehand
// (channels/delivery.js deliverChannel).
//
// Imports only leaves and the hub WITHOUT the five core modules of runs (auto-continue/do-run/limit-gate/post-run/
// queue) — `import-direction.test.js` holds that (cycle guard) — and no domain.

import * as store from "../store.js";
import { T } from "../i18n.js";
import { broadcast } from "../runtime/sse.js";
import { CAUSES, compacting, pendingRunInputs, running, targetCheck } from "./state.js";
import { openAskOf } from "./ask.js";
import { pendingPermissions } from "./approvals.js";
import { backgroundWork } from "./background.js";
import { fireHooks } from "./hooks.js";

// The copy of a chat's stack, while it is WORKING — being built or being cleared away from the fetch step on (not
// while merely marked for removal: nothing runs there) —, is open work: the chat goes to the archive only afterwards.
// The domain side (stacks/) supplies it via this setter from server.js (runs/ never imports stacks/):
// fn(chatId) → `{ name, state, phase }` or null. Unset: no copy.
let copyWork = null;
export function setCopyWork(fn) { copyWork = typeof fn === "function" ? fn : null; }
// Archiving ends what still belongs to the chats (wakeups; monitors as a safety net — a live one holds the archive). Asked in
// `reportArchive` — the place EVERY archiving goes through (a chat by hand or automatically via chats/archive.js, a folder via
// its PUT route) —, after the write, synchronously. Set from server.js. fn(chatIds). Unset: nothing.
let archiveObserver = null;
export function setArchiveObserver(fn) { archiveObserver = typeof fn === "function" ? fn : null; }


// The reasons, ONE list, in the order in which `openWork` reads them. `text` is T(…) and both clients show it as it
// is — there is no second translation table of the reasons. The clients evaluate `reason` only for the open
// question as the ONLY reason.
const ARCHIVE_REASONS = ["running", "agent", "dynworkflow", "graphWorkflow", "monitor", "copy", "interrupted", "compacted", "queue", "waitRow", "workflow", "question", "approval", "target"];

const REASON_TEXT = {
  running: () => T("A run is active"),
  // A background agent can outlive its turn — then no run is active any more, but work is, and nothing ever runs
  // in the archive. The count from the ONE query (runs/background.js).
  agent: (n) => (n === 1
    ? T("A background agent is running")
    : T`${n} background agents are running`),
  // A dynamic workflow lives outside the turn (dynworkflows/) — the count from the same query (runs/background.js,
  // source via a setter because runs/ does not import the domain).
  dynworkflow: (n) => (n === 1
    ? T("A dynamic workflow is running")
    : T`${n} dynamic workflows are running`),
  // A graph workflow this chat started in the background (it runs in a child chat that follows the orchestrator) —
  // open as long as it waits or runs. From the same query.
  graphWorkflow: (n) => (n === 1
    ? T("A graph workflow is running in the background")
    : T`${n} graph workflows are running in the background`),
  // A monitor (cbase_monitor) outlives its turn and may stay open for days (a watch on a WebSocket). Archiving used to end it
  // silently — the auto-archive would then end a quiet watch after X days without anybody noticing. From the same query.
  monitor: (n) => (n === 1
    ? T("A monitor is running")
    : T`${n} monitors are running`),
  // The copy of this chat's stack is being built or cleared away (setter setCopyWork, above).
  copy: (k) => (k.state === "build"
    ? T`The copy "${k.name}" is being built`
    : T`The copy "${k.name}" is being removed`),
  interrupted: () => T("An interrupted run is waiting to resume"),
  compacted: () => T("The context is being compacted"),
  queue: (n) => (n === 1
    ? T("1 message is waiting in the queue")
    : T`${n} messages are waiting in the queue`),
  waitRow: () => T("Waiting at the usage limit to continue"),
  workflow: () => T("A workflow run is open"),
  question: () => T("A question is waiting for an answer"),
  approval: () => T("An approval is waiting for a decision"),
  target: () => T("The goal is being checked"),
};

// ── Which reasons also hold up DELETING ────────────────────────────────────────────────────────────────────────────
// ONE truth about open work: the same list, the same sources, the same texts as the archive — and per reason ONE
// decision whether it also holds up deleting a chat (`DELETE /api/chats/:id`) and a workspace
// (`DELETE /api/workspaces/:id`). A reason must hold exactly when something still writes after the delete that the
// closing path (chats/erase.js) cannot end; everything else it closes itself. A new reason without an entry here
// turns `archive.test.js` red — both directions.
const DELETE_HOLDS = Object.freeze({
  running: true, // the turn keeps writing (runs/do-run.js addMessage) — under a chat id no delete path reaches any more
  agent: false, // the closing path (chats/erase.js) ends every agent core via runs/agents.js
  dynworkflow: false, // the chat-closed hook → dynworkflows/ stops silently and deletes the rows
  graphWorkflow: false, // the chat route stops the child runs beforehand, the child chats go along
  monitor: false, // the closing path (chats/erase.js) ends every monitor of the chat (runs/monitors.js closeMonitors)
  // Deleting does NOT take the copy along — it belongs to no chat, its build or removal runs to the end, and it
  // lives on. It need not hold up the delete either: its wake call to the deleted chat is dropped (stacks/ no longer
  // finds the chat), and nothing writes under its chat id afterwards.
  copy: false,
  interrupted: false, // runs/resume.js clears the active_runs row of a missing chat instead of starting it
  compacted: true, // the summary writes AFTER the model call (post-run.js compactChatContext: meta row, wait row)
  queue: false, // the closing path empties pendingRunInputs, store.deleteChat the run_inputs
  waitRow: false, // store.deleteChat deletes pending_resumes; a wakeup finds nothing afterwards
  workflow: false, // store.deleteChat closes the open run (abandonWorkflowRuns)
  question: false, // an open question without a run writes nothing — throwing away the chat with its question is allowed
  approval: false, // a card belongs to a running turn ("running") or to a subagent ("agent")
  target: true, // the target verdict writes AFTER the model call (post-run.js: addMessage "goal", possibly a follow-up run)
});
const DELETE_REASONS = new Set(ARCHIVE_REASONS.filter((g) => DELETE_HOLDS[g] === true));

/**
 * A chat's open work as `[{ reason, text }]` — empty means: can be archived. Read are the sources in the order of
 * `ARCHIVE_REASONS`, and ALL of them: the menu names every reason, not just the first. `openAskOf` reads the whole
 * history and therefore comes late.
 * Synchronous — between this check and the route's write there is no await (no gap for a run start). `only`: a
 * subset of the reasons — then only their sources are read (deleting a workspace asks each of its chats without
 * ever reading a history); order, sources and texts stay the same.
 */
function openWork(chatId, { only = null } = {}) {
  const open = [];
  const wanted = (reason) => !only || only.has(reason);
  const add = (reason, arg) => open.push({ reason, text: REASON_TEXT[reason](arg) });
  const isRunning = running.has(chatId);
  if (isRunning && wanted("running")) add("running");
  // All kinds from the ONE query.
  const openNow = wanted("agent") || wanted("dynworkflow") || wanted("graphWorkflow") || wanted("monitor") ? backgroundWork(chatId) : [];
  const agents = openNow.filter((h) => h.kind === "agent").length;
  if (agents && wanted("agent")) add("agent", agents);
  const dyn = openNow.filter((h) => h.kind === "dynworkflow").length;
  if (dyn && wanted("dynworkflow")) add("dynworkflow", dyn);
  const graph = openNow.filter((h) => h.kind === "graphWorkflow").length;
  if (graph && wanted("graphWorkflow")) add("graphWorkflow", graph);
  const monitors = openNow.filter((h) => h.kind === "monitor").length;
  if (monitors && wanted("monitor")) add("monitor", monitors);
  const copy = copyWork && wanted("copy") ? copyWork(chatId) : null;
  if (copy) add("copy", copy);
  // In the 2.5 s until resumeInterruptedWork an interrupted turn exists only in active_runs. A row without
  // `running` is exactly that turn (the table has one row per running chat).
  if (wanted("interrupted") && !isRunning && store.listActiveRuns().some((r) => r.chatId === chatId)) add("interrupted");
  if (wanted("compacted") && compacting.has(chatId)) add("compacted");
  const queue = wanted("queue") ? (pendingRunInputs.get(chatId) || []).length : 0;
  if (queue) add("queue", queue);
  if (wanted("waitRow") && store.getPendingResume(chatId)) add("waitRow");
  if (wanted("workflow") && store.workflowOpenFor(chatId)) add("workflow");
  if (wanted("question") && openAskOf(chatId)) add("question");
  if (wanted("approval") && [...pendingPermissions.values()].some((p) => p.chatId === chatId)) add("approval");
  if (wanted("target") && targetCheck.has(chatId)) add("target");
  return open;
}

/** What holds up deleting this chat: the reasons from `DELETE_REASONS`, otherwise `[]`. Synchronous like openWork. */
function deleteObstacles(chatId) {
  return openWork(chatId, { only: DELETE_REASONS });
}

/**
 * The 409 answer of a delete that open work holds up — the same sentence for all delete paths. If a turn is
 * running, the chat route's sentence stays (clients show it verbatim); otherwise it names the reasons. `open`
 * carries them individually (`{ reason, text }`, for the workspace also `chatId`).
 */
function deleteLock(open, { workspace = false } = {}) {
  const texts = [...new Set(open.map((o) => o.text))].join(" · ");
  const chats = new Set(open.map((o) => o.chatId)).size;
  const error = workspace
    ? T`The workspace cannot be deleted right now — open work in ${chats} chat(s): ${texts}`
    : open.some((o) => o.reason === "running")
      ? T("Chat is running — wait for the agent to finish")
      : T`The chat cannot be deleted right now — ${texts}`;
  return { error, open };
}

/**
 * The archive's ONE broadcast to every window and every device. Sent from exactly three places: the PUT routes
 * (`reason: "user"`; archiving ONE chat goes via chats/archive.js), the auto-archive ticker via the same path
 * (`reason: "auto"`) and `fetchBack` (`reason: "work"`, with `cause`).
 * If something comes BACK, the hook kind "chatRestored" `{ chatId }` fires per chat — both paths (PUT routes,
 * fetchBack) go through this report. Subscriber: the channel delivery that the archive hold held back
 * (channels/delivery.js) — the system note at the sender promises it for exactly this moment.
 */
function reportArchive({ workspaceId = "", kind = "normal", chatIds = [], folderIds = [], archived, reason, cause }) {
  broadcast({
    // `kind` stays in the event (the clients read it), always "normal": the manager kind no longer archives
    // (runs/manager-lock.js).
    type: "chat_archive", workspaceId: workspaceId || "", kind: "normal",
    chatIds, folderIds, archived: Boolean(archived), reason,
    ...(cause ? { cause } : {}),
  });
  if (!archived) for (const chatId of chatIds) fireHooks("chatRestored", { chatId });
  if (archived && archiveObserver && chatIds.length) {
    try { archiveObserver([...chatIds]); } catch (e) { console.error("[archive] observer:", e?.message || e); }
  }
}

/**
 * Fetch an archived chat back because work begins for it. Fresh from the DB, not from a chat object passed along —
 * that can carry an old state. An active chat costs one read and writes nothing (golden stays byte-identical).
 * `true` only if it came back.
 *
 * NEVER THROWS: the call sits in doRun right after `running.add` and BEFORE its try/finally — a throw here would
 * leave the chat in `running` forever. An error of the data layer only costs the fetch-back (the run itself would
 * then fail at the same database), and it is in the log.
 */
// No AGENT fetches a chat from the archive — neither via a channel (cause "channel") nor with an agent message
// ("message"). The delivery stops beforehand (channels/delivery.js, archive hold); if such a run arrives anyway, the
// chat stays in the archive.
const NOT_FETCHED_BACK = new Set(["channel", "message"]);
/**
 * The catcher (pattern of runs/only-readable.js): if work with a cause from NOT_FETCHED_BACK arrives at a chat that —
 * fresh from the DB — is archived, NOTHING runs (nothing ever runs in the archive). The deliveries stop beforehand;
 * this is the second safeguard for every future path. Asked in runs/queue.js deliverUserPrompt (machine path: write
 * nothing, queue nothing) and in runs/do-run.js doRun before `running.add`. `true` = hold (with a log line).
 */
function staysInArchive(chatId, cause) {
  if (!NOT_FETCHED_BACK.has(cause)) return false;
  let archived = false;
  try { archived = Boolean(store.getChat(chatId)?.archivedAt); } catch { archived = false; }
  if (archived) console.log(`[archive] ${chatId}: cause "${cause}" at an archived chat — no run, nothing queued`);
  return archived;
}
function fetchBack(chatId, { cause = "user" } = {}) {
  if (NOT_FETCHED_BACK.has(cause)) return false;
  try {
    const r = store.fetchChatBack(chatId);
    if (!r.changed) return false;
    const chat = store.getChat(chatId);
    reportArchive({
      workspaceId: chat?.workspaceId || "", kind: chat?.kind,
      chatIds: [chatId], folderIds: r.folderBack ? [r.folderBack] : [],
      archived: false, reason: "work", cause: CAUSES.has(cause) ? cause : "user",
    });
    return true;
  } catch (e) {
    console.error(`[archive] ${chatId}: fetching back failed:`, e?.message || e);
    return false;
  }
}

// The list parameter `archive`: missing ⇒ "without" (only active items, the contract of every existing client); an
// unknown value ⇒ `null`, and the route answers 400 — a silent fallback to "without" would be a list that leaves
// something out without saying so. An EMPTY value is an unknown one, not an absence.
const ARCHIVE_PAGES = ["without", "only", "including"];
function archivePage(url) {
  const v = url.searchParams.get("archive");
  if (v === null) return "without";
  return ARCHIVE_PAGES.includes(v) ? v : null;
}
const archivePageError = () => ({
  error: T("archive must be \"without\", \"only\" or \"including\""),
});

export { ARCHIVE_REASONS, ARCHIVE_PAGES, NOT_FETCHED_BACK, DELETE_HOLDS, archivePage, archivePageError, staysInArchive, fetchBack, deleteObstacles, deleteLock, reportArchive, openWork };
