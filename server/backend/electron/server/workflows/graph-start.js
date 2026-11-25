// Starting, viewing and stopping graph workflows from the chat. The paths of the MCP tools
// cbase_workflow_start/_status/_stop (mcp/tools/graphworkflows.js) via workflows/graph-routes.js.
//
// startPerTool(chat, body)         accepts a start — ONLY on announcement: the human named the workflow in a message of
//                                  THIS turn with /workflow:<shortname> (runs/human-input.js announcementsInTurn; set
//                                  by the message route). The row becomes `earmarked`; NOTHING is started here — the
//                                  end of the turn does that. The checks are numbered, the first applicable one
//                                  answers; only the idempotency (item 8) comes BEFORE "open" (item 7): the own
//                                  earmarked row is an open foreground start, and a resumed turn would otherwise
//                                  always get a 409 instead of `alreadyStarted`.
// stopGraphStart(chat, id, {from}) earmarked/waiting ⇒ `stopped`; started with an open run ⇒ cancelWorkflow (awaits the
//                                  end of the run); otherwise 409 `to_end`. `stoppedOf` is set BEFORE the cancel —
//                                  whoever asks at the end of the run who stopped it (no completion notice after a stop
//                                  by the agent) already reads it.
// graphRunView(row)                the run view (contract for the status tool, list, event and both clients).
// reportGraphRun(row)              the event `{ type: "harness", subtype: "graph_run", run }` to the stream of the
//                                  starting chat — after EVERY change of a row.
// inputWithAttachments(input, paths)  the input the run begins with: the text plus the announcement's attachments as
//                                  paths — the same wording as the manual start (routes.js POST /workflow).
//
// REDEEMING — the moment a row becomes a run in `workflow_runs`:
// graphTurnCompletion(chat, {clean, aborted, parked})  the turn completion (runs/do-run.js, in the finally BEFORE the
//                                  end of work): the open foreground start of the chat — earmarked: a stopped turn
//                                  dismisses it, a failed one likewise, a parked one leaves it (parked is like
//                                  running: the end of the continuation redeems), a clean one redeems; waiting_lock:
//                                  a clean turn tries once more. `{ started: true }` means: the run has begun, and
//                                  the end of work of this turn is skipped. Without an open start ONE query and `null`.
// redeem(row)                      read the chat afresh, look up the workflow in the effective set, beginWorkflow —
//                                  blocked ⇒ `waiting_lock` with key and reason, otherwise `started` with `runId`.
// wakeGraphStarts()                the wait queue: every `waiting_lock` (and `waiting_storage`, see below) row whose chat
//                                  is free is redeemed — by the wakeup (a workflow run has ended, server.js
//                                  setTriggerWakeup) and by the tick (`graphTickMs`, catches locks that become free
//                                  without emitWorkflowRun: a deleted holder chat, reapStaleLocks). Not reentrant.
// graphStartsRestartGrace()        after the restart (server.js, behind runInputsRestartGrace): an `earmarked` row
//                                  whose chat is not running again is redeemed; if it runs, the end of the resumed
//                                  turn redeems. Then the wait queue.
//
// A start with `background: true` runs in a coding chat of its OWN, the child chat:
// backgroundStart(chat, …)         creates it (childChatCreate: inherits the orchestrator's settings, beginWorkflow
//                                  lays the workflow's on top), copies the announcement's attachments into ITS
//                                  attachment folder (it only reads that one, do-run.js runAddDirs) and redeems
//                                  immediately — another chat runs the workflow, the orchestrator's turn holds nothing
//                                  up. Result: `started` or `waiting_lock`. The child chat is `kind = 'normal'`; the
//                                  link is the row (`child_chat_id`) — it appears in no chat list (store/chats.js
//                                  listChats) and follows the orchestrator into archive and deletion.
// graphRunsOpen({chatId})          the open background starts as background work `kind: "graphWorkflow"` (source of
//                                  runs/background.js, server.js setGraphSource): archive 409, end of work deferred.
// stopKindRuns(chatId)             before the orchestrator is deleted (chats/routes.js DELETE): waiting rows leave the
//                                  queue, per child the open run is cancelled and a still running turn stopped (at
//                                  most 15 s). `false` means: something is still holding — the route answers 409.
//
// Save gate: a background start waits while memory is scarce (storage-gate.js storageSituation: user container above
// 80 % of its limit or host below 20 % free) as `waiting_storage` with the reason — checked in redeem BEFORE
// beginWorkflow, hence before the lock. No numeric cap. Per pass (tick or wakeup) at most ONE run starts out of
// `waiting_storage`, the oldest — otherwise several waiting runs would fill the freed memory at once. The foreground
// does not know the gate: it runs in the chat that is running anyway. "One per pass" counts across graph starts AND
// stack copies: the rows here are the source "graph" (graphCandidates) of the shared arbiter storage-queue.js,
// registered in server.js; wakeGraphStarts is one pass of that arbiter.
//
// Observer: the run view carries `wait` (graph-wait.js waitDetail) — an open permission in the run chat turns a running
// run into "waiting" too —, and every change of a row goes, after its event, to the observer (setGraphRowsObserver →
// graph-background.js graphRowChanged): report waiting, report the end.
//
// Worktree: `worktree: true` gives the run a git worktree of its OWN (worktree.js) without a project lock — foreground
// and background alike. Checked at the call: without a project 400 `project`, without a repo 400 `repo` (text from
// worktree.js graphWorktreeRepos). It is created when REDEEMING (worktreeCreateStart, asynchronous — the row stays
// `earmarked` with the reason "creating its worktree", then it is redeemed once more; a failure dismisses it). The
// path is in `worktree_path`/`worktree_info`; runs/system-prompt.js resolveCwd puts the child chat into it, the
// foreground run reaches it via do-run.js runAddDirs, both get the path rule (worktreePrompt). Cleanup happens at the
// end (graph-background.js) or on deletion (graphChatClosed).
//
// Errors have the shape `{ error, reason }`; `reason` is the statement for programs (the text goes to the model via MCP).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as store from "../store.js";
import { T } from "../i18n.js";
import { attachmentLocation, locationForProject, worktreeRoot } from "../runs/runtime-location.js";
import { copyInRuntimeFolder } from "../runs/runtime-write.js";
import {
  CopyLocked, instanceFromIdentifier, instanceForChat, instanceNameFromIdentifier, instanceOfChat, projectFromIdentifier, turnIdentifier,
} from "../runs/instance.js";
import { sse } from "../runtime/sse.js";
import { announcementsInTurn } from "../runs/human-input.js";
import { startLock } from "../runs/project-lock.js";
import { managerLocked, managerLockText } from "../runs/manager-lock.js";
import { runKindFor } from "../runs/hooks.js";
import { focusedProject } from "../runs/system-prompt.js";
import { compacting, running, stopRun, waitForRunEnd } from "../runs/state.js";
import { ultracodeFollowUp } from "../chats/ultracode.js";
import { cancelWorkflow } from "./gates.js";
import { beginWorkflow } from "./driver.js";
import { withShortNames } from "./shortName.js";
import { withoutControlCharacters, workflowRunView } from "./run-state.js";
import { waitDetail } from "./graph-wait.js";
import { storageSituation } from "./storage-gate.js";
import { wakeStorageQueue } from "./storage-queue.js";
import { removeGraphWorktree, graphWorktreeRepos, createGraphWorktree } from "./worktree.js";

// Maximum length of the input (the tool's schema says the same: maxLength 16000).
const INPUT_MAX = 16000;
// How much input the run view carries (list, event) — the full text is in the row.
const VIEW_INPUT_MAX = 400;
// How many starts of a chat the idempotency check looks at (far beyond any real turn).
const IDEMPOTENCY_WINDOW = 500;
const WAITING = ["earmarked", "waiting_lock", "waiting_storage"];
const STOP_SOURCES = ["agent", "human"];
// The title of a child chat: the workflow name, truncated as for the manual start (routes.js POST /workflow).
const KIND_TITLE_MAX = 40;
// How long the deletion of the orchestrator waits at most for the turns of its children to end.
const KIND_STOP_MS = 15_000;

const errorText = (status, reason, error) => ({ status, body: { error, reason } });

// The effective set of this chat with short names — the same computation as the picker list (chats/routes.js
// itemChatRoutes, GET /workflows), otherwise a workflow would be called differently in the picker than at the route.
// The message route asks here too (slash-workflow.js): the mention on send and the check at the start compute over
// THE SAME set.
function effectiveSet(chat) {
  if (!chat.workspaceId) return [];
  return withShortNames(store.effectiveWorkflows(chat.workspaceId, focusedProject(chat)?.id ?? null));
}

// What the model sends as `workflow`, compared in lowercase; a leading "/workflow:" is the same.
const shortFrom = (s) => String(s ?? "").trim().replace(/^\/?workflow:/i, "").toLowerCase();

function inputWithAttachments(input, attachments = []) {
  const text = String(input ?? "");
  const paths = (Array.isArray(attachments) ? attachments : []).filter((p) => typeof p === "string" && p);
  if (!paths.length) return text;
  return [text, "", "[Attached files — read them first with the Read tool:]", ...paths.map((p) => `- ${p}`)].join("\n").trim();
}

// State of the view from row status and run. `wait` says what is being waited for (graph-wait.js) — and an open
// permission turns a running run into "waiting" too.
const RUN_STATE = { running: "running", waiting: "waiting", done: "finished", failed: "failed", cancelled: "stopped" };
function stateOf(z, run, wait) {
  if (z.status !== "started") return z.status;
  if (!run) return "stopped";
  if (wait) return "waiting";
  return RUN_STATE[run.status] || "stopped";
}

function graphRunView(z) {
  if (!z) return null;
  const run = z.runId ? store.getWorkflowRunById(z.runId) : null;
  const wait = waitDetail(z, run);
  const state = stateOf(z, run, wait);
  const view = run ? workflowRunView(run) : null;
  const toEnd = ["finished", "failed", "stopped", "dismissed"].includes(state);
  const input = z.input.length > VIEW_INPUT_MAX ? `${z.input.slice(0, VIEW_INPUT_MAX - 1)}…` : z.input;
  return {
    startId: z.id, background: z.background, worktree: z.worktree, worktreePath: z.worktreePath,
    workflowId: z.workflowId, name: z.workflowName, shortName: z.shortName, input,
    state, reason: z.reason,
    // The chat in which the run runs: the child chat in the background, otherwise this one.
    chatId: z.childChatId || z.chatId,
    run: view, wait, stoppedOf: z.stoppedOf,
    startedAt: z.createdAt, updatedAt: Math.max(z.updatedAt, run?.updatedAt || 0),
    endedAt: toEnd ? (view?.endedAt || z.updatedAt) : null,
  };
}

function reportGraphRun(z) {
  const run = graphRunView(z);
  if (run) sse(z.chatId, { type: "harness", subtype: "graph_run", run });
  return run;
}

// The other starts of the same announcement in this chat — `alreadyStarted`, so the model starts nothing twice.
const leftOverTheAnnouncement = (chatId, announcementId, withoutId) =>
  store.graphStartsOf(chatId, { limit: IDEMPOTENCY_WINDOW }).filter((z) => z.announcementId === announcementId && z.id !== withoutId).map(graphRunView);

// A foreground run carries no pin; its worktree would lie in the main instance (the chat still binds there), and moving
// into the copy would rebind the chat mid-run — a run across two instances. While the chat's copy is waiting or being
// built, it does not begin (409 `copy`). → the response or null. Only a copy this chat created with move-in can rebind
// (a chat may have several; one without move-in binds nobody) — the first one waiting or under construction.
function copyLocksForeground(chat) {
  const copy = store.liveStackCopiesOfChat(chat.id)
    .find((k) => k.inset && (k.state === "build" || store.STACK_COPY_WAITING.includes(k.state)));
  if (!copy) return null;
  return errorText(409, "copy", T`Your copy "${copy.name}" is still being built — start the run with worktree once it is ready, or without worktree.`);
}

// The instance in which a background run begins (its child is pinned to it, `graph_starts.instance`): that of the
// STARTING TURN (like dynworkflows/run.js and the subagents of the turn; if the copy became ready mid-turn, the turn
// keeps working in the main instance, and the child belongs there); only without a turn instance or with a turn in
// another project (the chat switched midway) the chat's binding. → { pin, instance() } — `pin` the identifier of a
// copy or "" (main); `instance()` the instance for the repo check of a worktree (the same one in which the child
// creates it), THROWS CopyLocked for a copy that cannot be resolved.
function backgroundLocation(chat) {
  const inTurn = turnIdentifier(chat.id);
  if (inTurn && projectFromIdentifier(inTurn) === String(chat.projectId ?? "")) {
    const copy = instanceNameFromIdentifier(inTurn) !== "main";
    return { pin: copy ? inTurn : "", instance: () => {
      const inst = instanceFromIdentifier(inTurn);
      if (!inst && copy) throw new CopyLocked(T`The copy of the running turn (${inTurn}) cannot be resolved — nothing started.`, { identifier: inTurn });
      return inst;
    } };
  }
  const where = instanceForChat(chat);
  return { pin: where.name !== "main" ? where.identifier : "", instance: () => instanceOfChat(chat) };
}

async function startPerTool(chat, body) {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  // 1. Only the main agent of a coding chat: no run kind (app agents), no other `kind`.
  if (chat.kind !== "normal" || runKindFor(chat)) {
    return errorText(403, "kind", T("Graph workflows are started only by the main agent of a coding chat."));
  }
  // 2. Starts only happen from a running turn — the announcement belongs to it.
  const announcements = announcementsInTurn(chat.id);
  if (announcements === null) {
    return errorText(409, "no_turn", T("No turn is running in this chat — a workflow starts only from the turn in which the human announced it."));
  }
  // The shape (a missing required field is not an announcement; a mistyped field is not guessed).
  if (typeof b.workflow !== "string" || !shortFrom(b.workflow)) {
    return errorText(400, "workflow", T("workflow is missing: the short name from the announcement /workflow:<shortname>."));
  }
  if (b.input !== undefined && typeof b.input !== "string") {
    return errorText(400, "input", T("input must be text."));
  }
  for (const field of ["background", "worktree"]) {
    if (b[field] !== undefined && typeof b[field] !== "boolean") {
      return errorText(400, "form", T`${field} must be true or false.`);
    }
  }
  // 3. Announced? Compared are the id, the short name of the announcement and TODAY's short name, resolved via the id
  //    (a rename between sending and the call shifts the short name, the id of the announcement stays).
  const set = effectiveSet(chat);
  const today = new Map(set.map((w) => [w.id, w]));
  const raw = b.workflow.trim();
  const searched = shortFrom(raw);
  const matches = (e) => e.workflowId === raw || e.shortName.toLowerCase() === searched || today.get(e.workflowId)?.shortName === searched;
  const hits = [];
  for (const a of announcements) {
    const e = a.workflows.find(matches);
    if (e) hits.push({ announcement: a, entry: e });
  }
  if (!hits.length) {
    const announced = [...new Set(announcements.flatMap((a) => a.workflows.map((e) => e.shortName)))];
    return errorText(403, "announcement", T`The human did not announce "${raw}" with /workflow: in this message — only what they name is started. Announced: ${announced.join(", ") || "none"}.`);
  }
  const { announcement, entry } = hits[0];
  // 4. The id is no longer in the effective set (deleted, disabled in the project).
  const flow = today.get(entry.workflowId);
  if (!flow) {
    return errorText(404, "name", T`The workflow "${entry.name}" no longer exists in this chat (deleted or disabled in the project) — nothing started.`);
  }
  // 5. Length of the input (counted before cleaning: the schema counts the same).
  const rawInput = b.input ?? "";
  if (rawInput.length > INPUT_MAX) {
    return errorText(400, "input", T("input is too long: at most 16,000 characters."));
  }
  // 6. Background: only ONE level — a child chat starts no further one in the background (deletion, archive and card
  //    hang on exactly one orchestrator). Worktree: only with a project, and the project needs a repo — both checked
  //    here; it is only created when redeeming (a dismissed earmark thus leaves nothing behind).
  const background = b.background === true;
  const worktree = b.worktree === true;
  if (background && store.graphStartOfChild(chat.id)) {
    return errorText(400, "kind", T("A background run does not start another one in the background — start in the foreground."));
  }
  // In the background the child's instance is already fixed here (that of the turn) — the repo check asks the same one.
  const location = background ? backgroundLocation(chat) : null;
  if (worktree) {
    const project = focusedProject(chat);
    if (!project) return errorText(400, "project", withoutProjectText());
    // Not in the foreground while the chat's copy is waiting or being built. In the background `graph_starts.instance`
    // pins the child.
    const no = background ? null : copyLocksForeground(chat);
    if (no) return no;
    // The repos of the instance in which the worktree is created — in the background that of the child, in the
    // foreground that of the chat (the run runs in the chat itself after this turn).
    try { await graphWorktreeRepos(project, location ? location.instance() : instanceOfChat(chat)); } catch (e) {
      return errorText(400, e?.reason === "repo" ? "repo" : "worktree", String(e?.message || e));
    }
  }
  const input = withoutControlCharacters(rawInput).trim();
  // 8. The same start once more (resumed turn): same announcement, same workflow, same kind (background, worktree),
  //    same input, not dismissed — the row already exists, no second one is created.
  const announcementIds = new Set(hits.map((t) => t.announcement.id));
  const equal = store.graphStartsOf(chat.id, { limit: IDEMPOTENCY_WINDOW }).find((z) => announcementIds.has(z.announcementId)
    && z.workflowId === flow.id && z.background === background && z.worktree === worktree && z.input === input && z.status !== "dismissed");
  if (equal) {
    return { status: 200, body: {
      start: graphRunView(equal), already: true, alreadyStarted: leftOverTheAnnouncement(chat.id, equal.announcementId, equal.id),
      hint: T("You already started this run (same announcement, same input) — not again. End your turn with one line."),
    } };
  }
  const callId = typeof b.callId === "string" ? b.callId.slice(0, 200) : "";
  if (background) return await backgroundStart(chat, { flow, input, announcement, callId, worktree, pin: location.pin });
  // The copy check once more, IMMEDIATELY before the row is created — between the check above and here lay the await
  // of the repo check, and a copy request in that window (a subagent of the same chat, cbase_copy_stack) would not
  // find a row yet and begin building. From here until the row is created no await: check and row are one step for
  // the queue.
  if (worktree) {
    const no = copyLocksForeground(chat);
    if (no) return no;
  }
  // 7. In the foreground at most ONE workflow runs per chat: an open run or an open foreground start.
  const openRun = store.getWorkflowRun(chat.id);
  const openStart = store.workflowOpen(openRun) ? null : store.openForegroundStart(chat.id);
  if (store.workflowOpen(openRun) || openStart) {
    const name = store.workflowOpen(openRun) ? openRun.workflowName : openStart.workflowName;
    return errorText(409, "open", T`A workflow is already open or scheduled in this chat ("${name}") — another one can only run in the background.`);
  }
  const row = store.createGraphStart({
    id: `gs-${crypto.randomUUID()}`, chatId: chat.id, workflowId: flow.id, workflowName: flow.name, shortName: flow.shortName,
    input, attachments: announcement.attachments, background, worktree, announcementId: announcement.id,
    callId, status: "earmarked",
  });
  const start = reportGraphRun(row);
  return { status: 201, body: {
    start, alreadyStarted: leftOverTheAnnouncement(chat.id, announcement.id, row.id),
    hint: T("Scheduled: the workflow starts in this chat as soon as your turn ends. End it now with one line."),
  } };
}

// ── Background ────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The child chat of a background start: a coding chat (`kind = 'normal'`) in the orchestrator's workspace, in the
 * project it is focused on (without a project: none), in no folder, with the workflow name as its title (`titled`: no
 * title oneshot renames it). It inherits the orchestrator's settings — persona, model, permissions, effort, ultracode,
 * provider, browser —, through the ONE ultracode rule; beginWorkflow lays the workflow's on top.
 */
function childChatCreate(chat, flow) {
  const now = Date.now();
  const title = flow.name.length > KIND_TITLE_MAX ? `${flow.name.slice(0, KIND_TITLE_MAX)}…` : flow.name;
  const child = store.createChat(ultracodeFollowUp(null, {
    id: crypto.randomUUID(), workspaceId: chat.workspaceId,
    projectId: focusedProject(chat)?.id ?? null, folderId: null,
    title, profile: chat.profile, kind: "normal",
    model: chat.model, permissionMode: chat.permissionMode, effort: chat.effort, ultracode: chat.ultracode,
    provider: chat.provider, browserMode: chat.browserMode, createdAt: now, updatedAt: now,
  }));
  return store.updateChat(child.id, { titled: 1 });
}

/**
 * Copy the announcement's attachments into the child chat's attachment folder — it only reads its own (do-run.js
 * runAddDirs). Returns the NEW absolute paths (the input names them). A missing file is dropped and logged; a
 * duplicate name gets a number in front instead of overwriting another file.
 */
function copyAttachments(paths, childId) {
  const target = attachmentLocation(childId);
  const out = [];
  for (const source of Array.isArray(paths) ? paths : []) {
    if (typeof source !== "string" || !source) continue;
    try {
      if (!fs.statSync(source).isFile()) continue;
      const name = path.basename(source);
      let dest = path.join(target, name);
      // Inside the runtime folder (the child chat of a converted project) via the descriptor (runs/runtime-write.js): a
      // link `attachments → /somewhere` would otherwise put the attachments into the backend. An existing name — a
      // link too — gets a number in front.
      let inLocation = false;
      for (let n = 1; (inLocation = copyInRuntimeFolder(source, dest, { onlyIfMissing: true })) === "present"; n++) dest = path.join(target, `${n}-${name}`);
      if (!inLocation) {
        fs.mkdirSync(target, { recursive: true });
        for (let n = 1; fs.existsSync(dest); n++) dest = path.join(target, `${n}-${name}`);
        fs.copyFileSync(source, dest);
      }
      out.push(dest);
    } catch (e) { console.error("[graph-start] attachment not copied:", source, e?.message || e); }
  }
  return out;
}

/**
 * An accepted background start: child chat, attachments, row — and redeem immediately (another chat runs the workflow,
 * nothing waits for the end of this turn). The row is created as `earmarked` and becomes `started` or `waiting_lock`
 * / `waiting_storage` in the same move; only the result is reported.
 */
async function backgroundStart(chat, { flow, input, announcement, callId, worktree, pin }) {
  const child = childChatCreate(chat, flow);
  // The child chat runs in the instance in which its run begins — `pin` (backgroundLocation: the instance of the
  // starting turn, otherwise the orchestrator's binding; the identifier of a copy, otherwise '', the main instance) is
  // stored in the row and never changes mid-run (runs/instance.js instanceForChat).
  const created = store.createGraphStart({
    id: `gs-${crypto.randomUUID()}`, chatId: chat.id, childChatId: child.id, workflowId: flow.id, workflowName: flow.name,
    shortName: flow.shortName, input, attachments: copyAttachments(announcement.attachments, child.id), background: true, worktree,
    announcementId: announcement.id, callId, status: "earmarked", instance: pin,
  });
  redeem(created);
  // With a worktree, redeeming first creates it and then redeems once more — the call awaits that, so the tool result
  // says what became of it (started, waiting or dismissed including the reason).
  const creating = worktreeCreate.get(created.id);
  if (creating) await creating;
  const row = store.graphStart(created.id);
  const start = graphRunView(row);
  // The way to the running node agent, named where the agent gets hold of the run (communication/target-graph.js accepts it).
  // Guard: test/start-answers-message-path.test.js.
  const end = T`A <task-notification> arrives at the end; the human gives answers and approvals through the card. Status: cbase_workflow_status. To steer the node agent while it runs, write to it with cbase_agent_send to "graph:${row.id}". End your turn with one line.`;
  const hint = row.status === "started"
    ? `${T("Started in the background (its own chat).")} ${end}`
    : row.status === "dismissed"
      ? T`Not started: ${row.reason} End your turn with one line.`
      : `${T`Accepted in the background (its own chat) — it is ${row.reason} and then starts by itself.`} ${end}`;
  return { status: 201, body: { start, alreadyStarted: leftOverTheAnnouncement(chat.id, announcement.id, row.id), hint } };
}

/**
 * The open background starts as rows of background work (runs/background.js setGraphSource): `chatId` is the
 * orchestrator. Without `chatId` those of all chats.
 */
function graphRunsOpen({ chatId } = {}) {
  return store.graphRunsOpenOf(chatId || undefined).map((z) => ({
    chatId: z.chatId, startId: z.id, childChatId: z.childChatId, runId: z.runId, name: z.workflowName, startedAt: z.createdAt,
  }));
}

/**
 * Before the orchestrator is deleted: its waiting background rows leave the queue (`stopped`, by "erase" — otherwise
 * the wakeup would redeem them while a cancel is being awaited below), per child the open run is cancelled
 * (cancelWorkflow awaits its turn) and a still running turn stopped, together at most 15 s. `true` means: none of its
 * children is running any more.
 */
async function stopKindRuns(chatId) {
  const until = Date.now() + KIND_STOP_MS;
  for (const z of store.graphRunsOpenOf(chatId)) {
    if (WAITING.includes(z.status)) change(z, { status: "stopped", stoppedOf: "erase" });
  }
  const children = store.graphChildChatIds(chatId);
  for (const childId of children) {
    const child = store.getChat(childId);
    if (!child) continue;
    if (store.workflowOpen(store.getWorkflowRun(childId))) {
      const z = store.graphStartOfChild(childId);
      if (z && !z.stoppedOf) store.changeGraphStart(z.id, { stoppedOf: "erase" });
      try { await cancelWorkflow(child); } catch (e) { console.error("[graph-start] child run not cancelled:", childId, e?.message || e); }
    }
    if (running.has(childId)) {
      stopRun(childId);
      await waitForRunEnd(childId, Math.max(0, until - Date.now()));
    }
  }
  return children.every((k) => !running.has(k) && !store.workflowOpen(store.getWorkflowRun(k)));
}

/** The list for cbase_workflow_status: newest first, at most 50; with `startId` exactly that one (otherwise 404). */
function graphRunsView(chat, startId = "") {
  if (startId) {
    const z = store.graphStart(startId);
    if (!z || z.chatId !== chat.id) return unknown(startId);
    return { status: 200, body: { runs: [graphRunView(z)] } };
  }
  return { status: 200, body: { runs: store.graphStartsOf(chat.id, { limit: 50 }).map(graphRunView) } };
}

const unknown = (startId) => errorText(404, "unknown", T`There is no graph workflow start "${startId}" in this chat.`);
const toEnd = (z) => errorText(409, "to_end", T`"${z.workflowName}" has already ended — nothing to stop.`);

async function stopGraphStart(chat, startId, { from = "human" } = {}) {
  const who = STOP_SOURCES.includes(from) ? from : "human";
  const z = store.graphStart(startId);
  if (!z || z.chatId !== chat.id) return unknown(startId);
  if (WAITING.includes(z.status)) {
    const fresh = change(z, { status: "stopped", stoppedOf: who });
    return { status: 200, body: { run: graphRunView(fresh) } };
  }
  if (z.status !== "started" || !z.runId) return toEnd(z);
  const run = store.getWorkflowRunById(z.runId);
  const runChat = store.getChat(z.childChatId || z.chatId);
  // Cancel only THIS run: cancelWorkflow addresses the most recent run of the chat.
  if (!store.workflowOpen(run) || !runChat || store.getWorkflowRun(runChat.id)?.id !== run.id) return toEnd(z);
  store.changeGraphStart(z.id, { stoppedOf: who });
  const ok = await cancelWorkflow(runChat);
  if (!ok && store.workflowOpen(store.getWorkflowRunById(run.id))) {
    store.changeGraphStart(z.id, { stoppedOf: "" });
    return errorText(409, "not_stopped", T("The run could not be stopped just now — try again in a moment."));
  }
  return { status: 200, body: { run: reportGraphRun(store.graphStart(z.id)) } };
}

// ── Redeeming ─────────────────────────────────────────────────────────────────────────────────────────────────────

// The tick of the wait queue (`CBASE_GRAPH_TICK_MS`, default 30 s). It is the emergency brake for locks that become
// free without a run ending (the holder chat was deleted: abandonWorkflowRuns; an orphaned lock: reapStaleLocks) — the
// ordinary path is the wakeup at the end of a run. For the save gate it is the MAIN path: memory becomes free without
// anything reporting it.
function graphTickMs() {
  const raw = process.env.CBASE_GRAPH_TICK_MS;
  const ms = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isFinite(ms) && ms > 0 ? ms : 30_000;
}

// The observer of every row change (workflows/graph-background.js graphRowChanged, set in server.js) — a setter
// instead of an import because the observer reads the run view HERE (an import would be a cycle). Through it an end
// WITHOUT a run also reaches the orchestrator (stopped by the human while the row waited; dismissed in the queue).
// Unset (unit tests without a server) only the event. A throw of the observer costs the change nothing.
let rowsObserver = null;
function setGraphRowsObserver(fn) {
  rowsObserver = typeof fn === "function" ? fn : null;
}

// Change a row and report — every change goes as an event to the starting chat, then to the observer.
const change = (z, fields) => {
  const fresh = store.changeGraphStart(z.id, fields);
  const run = reportGraphRun(fresh);
  try { rowsObserver?.(fresh, run, { prior: z.status }); } catch (e) { console.error("[graph-start] row observer:", z.id, e?.message || e); }
  return fresh;
};
const dismiss = (z, reason) => (change(z, { status: "dismissed", reason }), null);

/**
 * Turn an earmarked or waiting row into a run. Returns `{ started: true }` when the run has begun, otherwise `null`
 * (dismissed, or it waits for memory or the lock). The caller makes sure the chat is free.
 */
function redeem(z) {
  const chat = store.getChat(z.chatId);
  // Without a chat there is no row any more (the close path clears both) — if it is still there, it is moot.
  if (!chat) return dismiss(z, T("The chat no longer exists."));
  // A manager orchestrator starts nothing any more: every path to a run — restart, wait queue, tick, turn completion —
  // goes through HERE. Dismissed with the wording of the lock (runs/manager-lock.js).
  if (managerLocked(chat)) return dismiss(z, managerLockText());
  // The chat that runs the run: in the background the child chat, otherwise the starting one.
  const runChat = z.background ? (z.childChatId ? store.getChat(z.childChatId) : null) : chat;
  if (!runChat) return dismiss(z, T("The chat of the background run no longer exists."));
  const flow = effectiveSet(runChat).find((w) => w.id === z.workflowId);
  if (!flow) {
    return dismiss(z, T`The workflow "${z.workflowName}" no longer exists.`);
  }
  // A chat runs at most ONE workflow — if one is open by now (started by hand while the row waited), this one no
  // longer starts.
  const open = store.getWorkflowRun(runChat.id);
  if (store.workflowOpen(open)) {
    return dismiss(z, T`A workflow is already open in this chat ("${open.workflowName}") — "${z.workflowName}" does not start.`);
  }
  // The save gate, only in the background and BEFORE the lock: scarce ⇒ the row waits. Only what changes (status or
  // reason) is reported — the tick asks a waiting row again every 30 s.
  if (z.background) {
    const situation = storageSituation();
    if (!situation.free) {
      if (z.status !== "waiting_storage" || z.reason !== situation.reason) change(z, { status: "waiting_storage", reason: situation.reason, lockKey: "" });
      return null;
    }
  }
  // The own worktree is created HERE — when redeeming, not at the earmark. Creation is asynchronous (git); the row
  // stays as it is meanwhile and is then redeemed once more (worktreeCreateStart). With a worktree the run runs
  // without a lock: two runs on the same project run in parallel.
  if (z.worktree && !z.worktreePath) {
    // Creation writes into the project repo and the runtime folder — so it asks the project's lock like the first
    // step does (a NEW run, without `parentSince`: a new graph workflow waits in every phase of the project layout,
    // likewise behind relocation, recreation, deletion). Locked ⇒ the row waits in the wait queue (`waiting_lock`
    // without a key), tick and wakeup try again (graphCandidates). An `error` of the instance does not hold: the
    // first step then ends visibly. Otherwise the worktree would be created past the lock.
    const u = startLock(runChat.id, "turn");
    if (u && u.kind !== "error") {
      const reason = u.reason === "layout"
        ? T("waiting until the project structure has been applied")
        : T("waiting until the project container is ready");
      if (z.status !== "waiting_lock" || z.reason !== reason || z.lockKey) change(z, { status: "waiting_lock", lockKey: "", reason });
      return null;
    }
    worktreeCreateStart(z, runChat);
    return null;
  }
  let r;
  try {
    r = beginWorkflow(runChat, flow, inputWithAttachments(z.input, z.attachments), { lockKey: z.worktree ? "" : undefined });
  } catch (e) {
    // A start that throws would otherwise stay `earmarked` forever — and, as an open foreground start, hold up every further one.
    console.error("[graph-start] beginWorkflow:", z.id, e?.message || e);
    return dismiss(z, T`"${z.workflowName}" could not be started: ${String(e?.message || e).slice(0, 200)}`);
  }
  if (r.blocked) {
    const holder = (r.lock?.chatId && store.getChat(r.lock.chatId)?.title) || r.lock?.workflowName || r.key;
    change(z, { status: "waiting_lock", lockKey: r.key || "", reason: T`waiting for "${holder}"` });
    return null;
  }
  change(z, { status: "started", runId: r.run.id, reason: "", lockKey: "" });
  return { started: true };
}

// ── Worktree ──────────────────────────────────────────────────────────────────────────────────────────────────────

// startId → the running creation (a promise). While it runs, nobody redeems the row (redeem ends up here again), and
// the end of a foreign turn does not dismiss it (graphTurnCompletion).
const worktreeCreate = new Map();
// startId → project, while the creation (including the removal for a row that has ended) is running — the project's
// idle check counts it (projectbox/idle.js reason "worktree"), the quiet of the project layout holds on it.
const worktreeProject = new Map();
/** How many graph worktrees are currently being created (or removed) in this project. */
const worktreesBeingCreated = (projectId) => {
  const pid = String(projectId ?? "");
  let n = 0;
  for (const p of worktreeProject.values()) if (p === pid) n += 1;
  return n;
};

const withoutProjectText = () => T("A separate worktree needs a project — this chat has none. Start without worktree.");

/**
 * Create the worktree of a row (workflows/worktree.js createGraphWorktree, in the project of the run chat) and then
 * redeem once more if the run chat is free — otherwise the end of its turn or the tick redeems. If creation fails, the
 * row is dismissed (the reason names the error). If the row is no longer open by then (stopped, dismissed, deleted),
 * the fresh worktree is removed again right away. The body only runs in the next microtask — so the promise is in the
 * map before any path removes it again.
 */
function worktreeCreateStart(z, runChat) {
  if (worktreeCreate.has(z.id)) return worktreeCreate.get(z.id);
  const project = focusedProject(runChat);
  change(z, { status: "earmarked", lockKey: "", reason: T("is creating its worktree") });
  const p = Promise.resolve().then(async () => {
    let info;
    try {
      if (!project) throw new Error(withoutProjectText());
      // The root in the project's runtime folder if it is converted, otherwise the flat one. In the instance of the
      // run chat (for a child the pinned one) — a copy that does not exist throws. The root of this instance:
      // `worktrees/` in the main instance, `copy-worktrees/<name>/` in a copy. The instance is asked ONCE and serves
      // root and creation: the same copy, never two answers.
      const inst = instanceOfChat(runChat);
      info = await createGraphWorktree({ startId: z.id, project, root: worktreeRoot(locationForProject(project.id), inst?.instance), instance: inst });
    } catch (e) {
      worktreeCreate.delete(z.id);
      const now = store.graphStart(z.id);
      const text = String(e?.message || e).slice(0, 400);
      console.error("[graph-start] worktree not created:", z.id, text);
      if (now && WAITING.includes(now.status)) {
        dismiss(now, T`The worktree for "${z.workflowName}" could not be created: ${text}`);
      }
      return;
    }
    worktreeCreate.delete(z.id);
    const now = store.graphStart(z.id);
    if (!now || !WAITING.includes(now.status)) {
      const removal = await removeGraphWorktree(info, { force: true });
      if (removal.error.length) console.error("[graph-start] worktree of an ended row not removed:", z.id, removal.error.join(" · "));
      return;
    }
    const fresh = change(now, { worktreePath: info.dir, worktreeInfo: JSON.stringify(info), reason: "" });
    const runChatId = fresh.background ? fresh.childChatId : fresh.chatId;
    if (!chatFree(runChatId)) return;
    if (!fresh.background && store.getPendingResume(fresh.chatId)?.kind === "run") return; // parked is like running
    redeem(fresh);
  }).catch((e) => console.error("[graph-start] worktree creation:", z.id, e?.message || e))
    .finally(() => { worktreeCreate.delete(z.id); worktreeProject.delete(z.id); });
  worktreeCreate.set(z.id, p);
  if (project?.id) worktreeProject.set(z.id, String(project.id));
  return p;
}

/**
 * The turn completion (runs/do-run.js): called in the finally of a run, after `running` has fallen and before the end
 * of work judges. `clean`: code 0, not parked; `aborted`: `/stop` or steering; `parked`: at the limit (the
 * continuation is the same turn).
 */
function graphTurnCompletion(chat, { clean = false, aborted = false, parked = false } = {}) {
  const z = store.openForegroundStart(chat.id);
  if (!z) return null;
  // Redeeming has already begun — the worktree is still being created, or exists and waits for a free chat. This turn
  // is then not the start turn: its outcome dismisses nothing, a clean end redeems as soon as the worktree exists.
  if (z.status === "earmarked" && z.worktree && (z.worktreePath || worktreeCreate.has(z.id))) {
    return clean && z.worktreePath ? redeem(z) : null;
  }
  if (z.status === "earmarked") {
    if (aborted) return dismiss(z, T`The turn was stopped — "${z.workflowName}" does not start.`);
    if (parked) return null;
    if (!clean) return dismiss(z, T`The turn ended with an error — "${z.workflowName}" does not start.`);
    return redeem(z);
  }
  // If the row waits for the lock, every clean turn end tries once more (the chat is free right now).
  if (z.status === "waiting_lock" && clean) return redeem(z);
  return null;
}

// Free means: no turn, no compaction, no open run.
const chatFree = (chatId) => !running.has(chatId) && !compacting.has(chatId) && !store.workflowOpen(store.getWorkflowRun(chatId));

/**
 * The candidates of the wait queue for the shared arbiter (workflows/storage-queue.js; registered in server.js as
 * source "graph"): every `waiting_lock` and `waiting_storage` row whose run chat is free — in the foreground the
 * starting chat, in the background the child chat —, in creation order (`alt` = `createdAt`). In the background
 * redeeming checks memory first, then the lock. Out of `waiting_storage` at most ONE start starts per pass — across
 * graph starts AND stack copies, the oldest; the others wait for the next tick or the next end of a run. A start that
 * then gets stuck at the lock has occupied no memory and does not count (the arbiter only counts
 * `{ started: true }` of a candidate with `storage`).
 */
function graphCandidates() {
  const list = [];
  for (const z of store.graphStartsInStatus(["earmarked", "waiting_lock", "waiting_storage"])) {
    // Out of `earmarked` only those whose worktree already exists: created when the run chat was not free. Every
    // other earmarked row is redeemed by the end of its turn (or by backgroundStart).
    if (z.status === "earmarked" && !(z.worktree && z.worktreePath)) continue;
    list.push({
      waitingSince: z.createdAt,
      storage: z.status === "waiting_storage",
      attempts: () => {
        try {
          if (!chatFree(z.background ? z.childChatId : z.chatId)) return null;
          if (z.status === "earmarked" && !z.background && store.getPendingResume(z.chatId)?.kind === "run") return null;
          return redeem(z);
        } catch (e) { console.error("[graph-start] wake:", z.id, e?.message || e); return null; }
      },
    });
  }
  return list;
}

/**
 * Work off the wait queue — ONE pass of the shared arbiter (graph starts and stack copies, storage-queue.js); the
 * name stays for tick, wakeup and tests. Not reentrant (the arbiter).
 */
function wakeGraphStarts() {
  wakeStorageQueue();
}

/** After the restart: redeem earmarked foreground starts without a running turn, then the wait queue. */
function graphStartsRestartGrace() {
  for (const z of store.graphStartsInStatus(["earmarked"])) {
    // A background row is only still `earmarked` if its worktree was being created when the server fell: redeem once
    // more (a half-created folder dismisses it with the creation error). With a finished worktree the wait queue
    // below takes it.
    if (z.background) {
      if (!z.worktree || z.worktreePath) continue;
      try { if (chatFree(z.childChatId)) redeem(z); } catch (e) { console.error("[graph-start] restart:", z.id, e?.message || e); }
      continue;
    }
    try {
      // If the chat is running again (resumption), the end of that turn redeems. If a run wait row exists (parked at
      // the limit), that is the same — parked is like running, the continuation redeems.
      if (!chatFree(z.chatId) || store.getPendingResume(z.chatId)?.kind === "run") continue;
      redeem(z);
    } catch (e) { console.error("[graph-start] restart:", z.id, e?.message || e); }
  }
  wakeGraphStarts();
}

// Only for the runtime-write test: copying the attachments into the child chat without a whole graph run. No caller in
// the product.
const _attachmentsCopy = copyAttachments;

export {
  _attachmentsCopy, INPUT_MAX, inputWithAttachments, redeem, graphCandidates, graphRunsOpen, graphRunsView, graphRunView, graphStartsRestartGrace, wakeGraphStarts,
  graphTickMs, graphTurnCompletion, backgroundStart, childChatCreate, reportGraphRun, setGraphRowsObserver, startPerTool,
  stopGraphStart, stopKindRuns, effectiveSet, worktreesBeingCreated,
};
