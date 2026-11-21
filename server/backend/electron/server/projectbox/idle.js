// Idle and lock per project.
//
// For relocation and recreation: "is this project idle?", and a lock that makes new runs of the project WAIT instead of
// refusing them. runs/ asks the lock through the connector runs/project-lock.js (`setProjectLock(projectLock)` in
// server.js; oneshots and subagents through the start gate); the wakeup comes from the transition of the instance to
// `ready` or `error` (./instances.js `setStateWakeup(wakeProject)`).
//
// projectLock(chatId, purpose)   the verdict for ONE start (purpose "turn" · "agent" · "oneshot"; "view" = the git view:
//     judged like "turn" but never nudges a stopped instance), see below. Without the ops marker, without a project on the
//     chat or without an instance row (and without an explicit lock): null — the path without project containers, with no
//     database read except the chat row. The explicit lock lives in memory and is read BEFORE any database access wherever
//     the project is known without the database (the core of an agent carries it).
//     UNREADABLE: if the database throws (SQLITE_BUSY, missing table) the verdict falls CLOSED — unreadable is not
//     "without a row" (empty is not unknown), and open would let the start run in B on the old path, in parallel with a
//     relocation. A turn and an agent wait (reason "unreadable"; the turn in the wait row, checked in the sweeper's tick —
//     no transition wakes it, runs/project-lock.js `withoutTransition`); a oneshot runs in B and is only denied when a
//     relocation holds the explicit lock and the project of its chat could not be read.
//     CLOSED ONLY WHERE A ROW COULD CONCERN IT: without any instance row for the project (or without any row and without
//     a lock if the project is unknown) `unreadable` answers null — answered from the set in memory
//     (store.instanceRowPossible), not from the database that just threw.
//     A oneshot WITH an instance (`inContainer` — the service detection in the project container, also asked through the
//     project without a chat) is judged like an agent: it waits (own sentence), ends visibly on `error`, nudges a new
//     attempt out of `error`; only during a relocation is it denied like every oneshot.
// projectIdle(projectId)     → { quiet, open: [{ chatId, reason, text }], terminals } over EVERY chat of the project
//     (store.chatIdsInProject, including child chats of a graph workflow): the open work of the archive (runs/archive.js
//     openWork — running turn, subagents, dynamic and graph workflows in the background, interrupted turn, compaction,
//     queue, wait row at the limit ("parked is like running"), open workflow run in the foreground (running/waiting: a run
//     waiting at a gate starts the next step after approval), approval card, target check) WITHOUT the open question (its
//     answer is a new turn, which the lock holds) and without the copy being built or cleared away (reason "copy" — an
//     operation on the instance, see IDLE_WITHOUT; a live monitor is part of openWork since it outlives the turn), plus running verdicts, running oneshots of the chat and an
//     announced graph start in the foreground — plus (reason "detection", without a chat) the computing service detection
//     of the project (./detection.js). Terminals (and debuggers of a project route) do NOT count; they are ended with a
//     notice when locking (`terminals` only says how many). A VS Code window attached to the project container does NOT
//     count either and is not asked: recreating and clearing away a copy close it hard — counting it would let a window
//     that stays open for days block every recreation.
//     IN ADDITION: the work that is PINNED to the project while its chat has switched projects since — living subagents of
//     a core of the project, open cores of dynamic workflows with their agents (runs/agents.js coresInProject, asked by
//     the project of the CORE). Without these rows an agent that keeps running in the container of A after a project
//     switch would drop out of the idle check of A. Likewise the running TURN whose chat switched mid-way
//     (runs/instance.js turnsInProject, reason "running"): the switch is allowed, the turn stays in A until it ends and
//     counts there.
// projectLocks(projectId, { reason })  reason "relocation" | "recreate" | "erase" (| "freeze": only set, without idle check
//     and without terminals — `{ ok: true, resolve }`; a lock of ONE instance, also of a copy that is the template of a
//     copy from a copy): set the lock, THEN check idle; if something is open, release the lock at once and report
//     (`{ ok: false, open }`). Otherwise end the terminals and debuggers `proj:<id>` (per instance, `projectTerminalTag`)
//     and `chat:<id>` with a notice and return `{ ok: true, resolve }` — `resolve()` releases the lock and wakes (once; a
//     second call does nothing). `{ terminalsLater: true }`: only lock and check, the terminals are ended by
//     `endTerminals()` in the return value — for a caller that locks several projects (erase.js). `{ countTerminals:
//     true }`: an open terminal is open work (reason "terminal") and is never ended. If something throws between setting
//     and returning, the lock falls with the throw (it would otherwise stand until the restart).
//     One lock per project; a second while the first stands ⇒ `{ ok: false }` with reason "locked". In memory: the
//     procedure that holds it does not survive a restart anyway (its state is in the instance row).
//     "erase": ./erase.js holds it over deleting a CONVERTED project — if it is not idle, deleting fails with 409 and the
//     message; a start during deletion waits as in recreation and runs after `resolve()` without an instance row (in B).
// lockTerminalTags(projectId), lockTerminalSessions(projectId)  the tags of the terminals the lock ends (ONE list for idle,
//     lock and the relocation plan), and per shell pid (= session) its tag.
// projectTerminalTag(projectId, instance)  the tag of a project terminal/debugger in an instance;
//     endInstanceSessions(projectId, instance, notice, { chats }) ends them with a notice (clearing away a copy) — with
//     `chats: true` also the terminals of the chat rail of the chats of this instance.
// wakeProject(projectId)       consumer of the state wakeup and of `resolve`: if the instance no longer works and no lock
//     is set, it fires per chat of the project the wait row of the lock (reason "project"/"serverEnd", a limit or credit
//     row whose start the lock held — runs/project-lock.js `takeHalted` —, or overdue — fireAutoContinue checks the limit
//     there as for every row) or the next entry of the queue (the same conditions as runs/auto-continue.js
//     runInputsRestartGrace), and wakes the workflow agents waiting at the lock (dynworkflows/parking.js
//     wakeProjectWaiting).
// workspaceDeleteLock(workspaceId)  the lock of a WORKSPACE while it is being deleted (workspaces/routes.js DELETE).
//     `{ ok: true, resolve }` or `{ ok: false, error }` (it is already being deleted). While it stands, a turn and an
//     agent wait in EVERY chat of the workspace — not only in those of converted projects (those are additionally held by
//     "erase"): projectLock judges it BEFORE everything else, even without the ops marker, and only asks the chat row
//     while a workspace lock stands. A turn waits as at the project lock (composer queue or wait row with reason
//     "project"), a workflow agent at `atProject`, a subagent in the core is denied with a reason. Oneshots run: they
//     cannot wait (a model call in the middle of another procedure), and what writes into the chat after them is caught by
//     the second check of the route. Without this lock a turn started during the docker steps would make that second
//     check answer 409 — after the project containers and instance rows are already gone.
//     `resolve()` (once): after success the chats are gone and the waiters fall with them; after a refusal it wakes
//     exactly the chats whose start it held — except those of a project whose explicit lock ("erase") still stands: their
//     `resolve` wakes them through wakeProject. The route therefore releases the workspace lock FIRST and the project
//     locks afterwards — the other way round wakeProject would find the workspace lock still standing and park the wait
//     rows until the next check. Plus the waiting workflow agents.
//
// THE VERDICT PER STATE:
//   relocation (state or explicit lock "relocation")  a turn waits; subagent, workflow agent and oneshot are denied with
//       a reason ("deny") — they would only come if the idle check had missed something.
//   start · create · recreate (state or lock "recreate")  turn and agent wait (a subagent in the core is denied with a
//       reason — the core cannot wait —, a workflow agent waits at `atProject`); oneshots run (in B).
//   ready while a server step of the setup runs (reason "setup", ./setup/status.js setupRunning — only with the OWN boot
//       id)  like `create`: turn and agent wait, a oneshot without an instance runs in B, one in the project waits. While
//       the setup waits for an upload, for the human, or stands in `error`, chats run — a source in `error` hinders no
//       turn as long as the instance is `ready`; if it is not, the instance is judged as above. Woken at the end of every
//       server step (→ wakeProject); wakeProject itself does not wake the main instance while one runs.
//   ready and converted while the server ends (runs/server-end.js serverEnds)  like `start`: nothing new begins in a
//       container the stop chain is just stopping; the turn runs in the next process (wait row "serverEnd", due at once,
//       or the persisted queue), workflow agents wait until their run closes and resume from the journal. Only CONVERTED
//       projects — every other chat ends as before.
//   error and converted  "error": the start ends visibly at once (hint, run_error) — oneshots run. EXCEPT: if the row has
//       stood on `error` longer than the check-back interval, a turn or agent nudges ONE new restore attempt through the
//       connector `setErrorAttempt` (server.js → recreate.js recreateErrorAttempt) — the row then stands synchronously in
//       `start`, and the verdict is that of `start` (the turn waits, the workflow agent parks, the transition wakes it).
//       If the attempt fails synchronously (without docker, e.g. without the marker) the fresh reason applies; if it
//       fails later, the transition to `error` wakes the start, and it ends visibly within the new interval. Unset
//       (tests without a server): the plain error.
//       NO new attempt for the instance of a copy whose clearing away runs or failed (restore.js copyInClearAway) — it
//       stays `error`, and the sentence says how to go on (trigger the clearing away again; afterwards the chat works in
//       the main instance). A revived copy would lose the work done after it.
//   stop (a human stops the instance)  like `start`: turn and agent wait, oneshots run in B.
//   stopped and converted  a turn, subagent, workflow agent or oneshot WITH an instance STARTS it: through the connector
//       `setStoppedStart` (server.js → ./instance-stop.js nudgeStopped; a setter because instance-stop.js imports this
//       file) — through the storage gate, with a separator "<instance> started" in the chat that triggered the start —
//       and waits as with `start` (a subagent in the core is denied with a reason); the transition to `ready` wakes it.
//       If the gate is closed the row stays `stopped` with the phase `waiting_storage`; the start waits too and begins as
//       soon as the queue brings the instance up. A oneshot WITHOUT an instance runs in B. Unset (tests without a
//       server): the start ends visibly ("stopped — start it in the tab"), never silently in a stopped container.
//   error without `converted_at`, ready  no lock.
//
// PER IDENTIFIER: main instance and copies of a project each have their own idle state, lock and wakeup. The instance of a
// chat comes through the connector `setInstanceForChat(fn)` — fn(chatId, projectId) → "main" | "copy-<name>" (set in
// server.js); UNSET, every chat is in the main instance.
//   projectLock     judges the row of the instance OF THE CHAT — a core judges ITS OWN (project and identifier, both
//                     pinned; otherwise the lock would judge the copy of the chat while idle counts the core with the
//                     main instance). A copy whose row is missing is a lock with a message (never a fallback to main).
//   instanceIdle(identifier)  the idle state of ONE instance `<projectId>/<instance>`: the chats whose instance it is
//                     (including child chats of graph workflows), plus turns (runs/instance.js turnIdentifier), subagents
//                     and dynamic workflows (runs/agents.js coresInProject, `identifier`) pinned to THIS instance while
//                     their chat stands elsewhere. Without an identifier the work counts for the main instance, as do
//                     the git jobs; the project terminal counts with its instance (`proj:<id>` for main,
//                     `proj:<id>@copy-<name>` for the copy), the terminals of the chat rail with the instance of their
//                     chat. For the main instance of a project without a copy this is exactly projectIdle.
//   projectLocks    "relocation" and "erase" take the WHOLE project and check projectIdle; "recreate" takes ONE instance
//                     (`instance`, default main) and checks instanceIdle; "freeze" takes ONE instance that is being
//                     frozen (without idle — every other instance keeps working). A project lock excludes every instance
//                     lock of the same project and vice versa; two instances lock side by side.
//   wakeProject(projectId, { instance })  wakes the chats of the named instance (without it: of every free instance of the
//                     project) — the state wakeup names the instance whose row just became `ready`/`error`.
//   projectLocked   the lock of the whole project, otherwise that of the main instance.
import * as store from "../store.js";
import { T } from "../i18n.js";
import { projectboxOps, ONLY_IN_OPS } from "./ops.js";
import { MAIN, copyNameOf } from "./creation.js";
import { copyInClearAway } from "./restore.js";
import { serverEnds } from "../runs/server-end.js";
import { compacting, running } from "../runs/state.js";
import { openWork } from "../runs/archive.js";
import { coresInProject } from "../runs/agents.js";
import { autoContinueFiring } from "../runs/limit-gate.js";
import { fireAutoContinue, startFollowUpRun } from "../runs/auto-continue.js";
import { controlActive, takeNextRunInput } from "../runs/queue.js";
import { isLockReason, takeHalted } from "../runs/project-lock.js";
import { turnIdentifier, turnsInProject } from "../runs/instance.js";
import { openGitJobsOf } from "../runs/git-post-work.js";
import { runningOneshotsOf } from "../providers/index.js";
import { runningVerdicts } from "../workflows/driver.js";
import { wakeProjectWaiting } from "../dynworkflows/parking.js";
import { endTerminalsWithNotice, countTerminalsByTag, terminalPidsByTag } from "../terminal.js";
import { endDebugWithNotice, countDebugByTag } from "../debug.js";
import { abortOuterLoop } from "../outerloop/abort.js"; // deleting ends the outer-loop runs
import { runningDetectionsOf, wakeDetections } from "./detection.js"; // reason "detection", waking at the lock
import { setupRunning } from "./setup/status.js"; // reason "setup" (a leaf above the data layer)
import { projectOccupied } from "./instance.js"; // does the layout procedure work HERE?
import { worktreesBeingCreated } from "../workflows/graph-start.js"; // a graph worktree is being created (reason "worktree")

// "freeze" — the pause of an instance for the code snapshot of a copy (the main instance, or a copy that is the template of
// a copy from a copy). New turns, subagents and graph steps in the frozen instance wait at the lock as on start; oneshots
// run in B. Unlike the other three it demands NO idle state and ends NO terminal: the pause freezes what is running, it
// does not stop it (projectLocks below).
// "layout" — the lock for applying a layout: EARMARKED over the whole waiting time (earmarkProject, below), never through
// projectLocks (that checks once and releases at once on open work; held over the waiting time it would block itself,
// because its own queue counts as work). Its verdict depends on the state of the job (`phase` of the marker, see
// verdictTheLock).
export const LOCK_REASONS = Object.freeze(["relocation", "recreate", "erase", "freeze", "layout"]);
// Which lock takes only ONE instance (instance lock) — the others take the whole project. "freeze" takes EXACTLY THE
// INSTANCE that is paused: every other instance of the same project keeps working in its own container — their turns do
// not wait for a foreign 20–60 s. Like every instance lock it excludes a lock of the whole project (relocation, erase) and
// vice versa.
const PER_INSTANCE = new Set(["recreate", "freeze"]);

const lock = new Map(); // projectId → { reason, since } — the explicit locks of the WHOLE project in this process
const instanceLocks = new Map(); // identifier `<projectId>/<instance>` → { reason, since } — those of one instance
// workspaceId → { since, held: Set<chatId> (held turns), agents: boolean } — the workspaces that are being deleted right
// now (workspaceDeleteLock).
const wsLocks = new Map();

// ── the language service ─────────────────────────────────────────────────────────────────────────────────────────────────
// Its servers (lsp/sessions.js) do not count for idle and hold no lock — they END where the terminals end with a notice: at
// the lock of a project or instance (endTerminals below — before the process search of a relocation, otherwise a language
// server would hold it with `process-in-project`) and at the stop or clearing away of an instance (endInstanceSessions).
// projectbox/ does not import lsp/: the connector comes from server.js. `instance` null = every instance of the project.
let languageServiceEnd = null;
/** Connector `fn(projectId, instance | null, reason)` → how many servers ended (server.js: lsp/sessions.js endSessions). */
export function setLanguageServiceEnd(fn) { languageServiceEnd = typeof fn === "function" ? fn : null; }
let languageServiceGroupsFn = null;
/**
 * Connector `fn(projectId)` → the process groups of the language servers of the project IN B (without an instance;
 * server.js: lsp/sessions.js groupsInB). The plan of a relocation (relocation/collect.js) searches for processes in the
 * project folder BEFORE the lock — a language server in B would stand there as `process-in-project` and hold the plan
 * although the lock ends it anyway. It is therefore exempt like the group of a recorded native run — without ending it:
 * the plan only reads.
 */
export function setLanguageServiceGroups(fn) { languageServiceGroupsFn = typeof fn === "function" ? fn : null; }
/** The process groups of the language servers of a project in B — `[]` without a connector or on an error. */
export function languageServiceGroups(projectId) {
  if (!languageServiceGroupsFn) return [];
  try { return (languageServiceGroupsFn(String(projectId ?? "")) || []).filter((x) => Number.isInteger(x) && x > 1); }
  catch (e) { console.warn(`[project] ${projectId}: groups of the language service not readable — ${e?.message || e}`); return []; }
}
/** End the language servers of a project (or of an instance) — the layout also calls this after rebuilding. → how many. */
export function endLanguageServices(projectId, instance = null, reason = "lock") {
  if (!languageServiceEnd) return 0;
  try { return Number(languageServiceEnd(String(projectId ?? ""), instance === null || instance === undefined ? null : String(instance), reason)) || 0; }
  catch (e) { console.warn(`[project] ${projectId}: language service not ended — ${e?.message || e}`); return 0; }
}

// ── the instance of a chat (see header "PER IDENTIFIER") ──────────────────────────────────────────────────────────────
let instanceForChat = null;
/** Connector fn(chatId, projectId) → instance of the chat in this project. Unset: every chat is in the main instance. */
export function setInstanceForChat(fn) { instanceForChat = typeof fn === "function" ? fn : null; }
/** The instance of a chat in the project — main without a connector or without an answer; an invalid answer throws. */
function chatInstance(chatId, projectId) {
  if (!instanceForChat) return MAIN;
  const i = instanceForChat(String(chatId ?? ""), String(projectId ?? ""));
  const inst = i ? String(i) : MAIN;
  copyNameOf(inst); // throws for an invalid instance
  return inst;
}
const identifierOf = (projectId, instance) => store.instanceIdentifier(String(projectId), instance || MAIN);
/** The instance behind an identifier — without an identifier (no instance row) the main instance. */
const instanceTheIdentifier = (identifier) => (typeof identifier === "string" && identifier.includes("/") ? identifier.slice(identifier.lastIndexOf("/") + 1) : MAIN);
/** The row of the instance that is judged: for the main instance `instanceFor`, otherwise that of the copy. */
const rowOf = (projectId, instance) => (instance === MAIN ? store.instanceFor(projectId) : store.projectInstance(projectId, instance));
/** The first lock of an instance of this project (for a lock of the whole project, which it excludes). */
function instanceLockAt(projectId) {
  const front = `${projectId}/`;
  for (const [k, m] of instanceLocks) if (k.startsWith(front)) return m;
  return null;
}
/** The lock that applies to a start in this instance: that of the whole project, otherwise that of the instance. */
const lockFor = (projectId, instance) => lock.get(String(projectId)) || instanceLocks.get(identifierOf(projectId, instance)) || null;

// The new attempt out of `error` (see header, "error and converted"): fn(projectId, row) → true if a new restore attempt
// was nudged. A setter instead of an import: recreate.js imports this file (projectLocks).
let errorAttempt = null;
export function setErrorAttempt(fn) { errorAttempt = typeof fn === "function" ? fn : null; }
function attemptFromError(projectId, row) {
  if (!errorAttempt) return false;
  try { return errorAttempt(projectId, row) === true; }
  catch (e) { console.error(`[project] ${projectId}: new attempt out of error not nudged:`, e?.message || e); return false; }
}

// Header "stopped and converted": fn(projectId, instance, { chatId }) nudges the start of a stopped instance (never
// throws). A setter instead of an import: instance-stop.js imports this file.
let stoppedStart = null;
export function setStoppedStart(fn) { stoppedStart = typeof fn === "function" ? fn : null; }
// The identifiers of stopped instances whose start was denied at the lock (stoppedVerdict) — a turn, agent or workflow
// agent waits there. The end of an occupancy (./instance.js setOccupancyEnd → afterOccupancy) wakes them.
const denied = new Set();
/**
 * The end of an occupancy on the project (project or instance occupancy; set in server.js through ./instance.js
 * setOccupancyEnd): for every remembered stopped instance of this project whose start was denied, wakeProject — the waiting
 * chats and workflow agents judge anew, and their look at the lock nudges the start (free now, otherwise denied and
 * remembered again). An instance that is no longer stopped or waits for storage only drops out of the set (its own
 * transition or the storage queue wakes it). → how many instances were woken. Never throws.
 */
export function afterOccupancy(projectId) {
  const front = `${String(projectId ?? "")}/`;
  let n = 0;
  for (const k of [...denied]) {
    if (!k.startsWith(front)) continue;
    denied.delete(k);
    const instance = instanceTheIdentifier(k);
    try {
      const z = rowOf(String(projectId), instance);
      if (z?.state !== "stopped" || z.phase === WAITING_STORAGE) continue;
      wakeProject(String(projectId), { instance });
      n += 1;
    } catch (e) { console.error(`[project] ${k}: not woken after the end of the occupancy:`, e?.message || e); }
  }
  return n;
}
const WAITING_STORAGE = "waiting_storage"; // the same phase as in ./instance-stop.js

/** The explicit lock of a project — `{ reason, since }` or null: that of the whole project, otherwise that of the main
 *  instance; with `instance` the one that applies to a start in this instance. */
export const projectLocked = (projectId, instance = MAIN) => {
  const m = lockFor(String(projectId ?? ""), instance);
  return m ? { reason: m.reason, since: m.since } : null;
};

function situationText(reason) {
  switch (reason) {
    case "relocation": return T("The project is moving into its container");
    case "recreate": return T("The project container is being recreated");
    case "create": return T("The project container is being created");
    case "setup": return T("The project is being set up (placing files, creating repos)");
    case "start": return T("The project container is starting");
    // Stopping and starting an instance.
    case "stop": return T("The instance is being stopped");
    case "stopped": return T("The instance is stopped and is being started for this run");
    case "stopped-storage": return T("The instance is stopped and starts as soon as enough memory is free");
    case "serverEnd": return T("The server is shutting down");
    case "erase": return T("The project is being deleted");
    case "freeze": return T("The project container is briefly frozen (a copy is being made)");
    // The copy of this chat is being cleared away (fetched, backed up, removed) — the turn waits and then runs in the main instance.
    case "clearAway": return T("This chat's copy is being removed (fetched and backed up) — afterwards the chat works in the main instance");
    case "unreadable": return T("The project container state cannot be read right now");
    // `waiting` — the job waits for quiet; `running`/`error` after the turnaround — the folders are being rebuilt.
    case "layout": return T("The project structure is being applied (folders are being moved)");
    case "layout-waiting": return T("The project structure is waiting for quiet to be applied");
    default: return T("The project container is not ready");
  }
}

// The purpose of a oneshot WITH an instance (projectLock `inContainer`) — it is judged like an agent (wait, error, new
// attempt out of `error`, a missing copy, unreadable), only with its own sentence; without an instance a oneshot stays `null`.
const ONESHOT_IN_PROJECT = "oneshot-in-project";

// `situationDifferent`: an own situation sentence instead of situationText(reason) — the denied start of a stopped
// instance names its reason.
function verdict(reason, purpose, projectId, situationDifferent = null) {
  const situation = situationDifferent || situationText(reason);
  const header = { reason, state: reason, projectId };
  if (purpose === "turn") {
    return { kind: "wait", ...header, text: reason === "serverEnd"
      ? T`${situation} — this turn starts after the restart.`
      : T`${situation} — this turn waits and starts as soon as it is ready.` };
  }
  if (reason === "relocation") {
    return { kind: "deny", ...header, text: purpose === "agent"
      ? T`${situation} — no agent started. Do not retry while the move is running.`
      : T`${situation} — no model call during the move.` };
  }
  if (purpose === "oneshot") return null; // oneshots run in B — no container, nothing to hold
  // A oneshot WITH an instance — the service detection in the project container — waits like an agent; woken by the
  // transition (wakeProject → ./detection.js wakeDetections), otherwise by the tick of the storage queue.
  if (purpose === ONESHOT_IN_PROJECT) {
    return { kind: "wait", ...header, text: T`${situation} — the model call in the project container waits and starts as soon as it is ready.` };
  }
  return { kind: "wait", ...header,
    text: T`${situation} — no subagent started. Do not retry right away: it works again once the project container is ready.` };
}

// The verdict of an explicit lock. For "layout" it depends on the phase of the marker — `waiting`: whatever belongs to work
// that began BEFORE the job passes (`parentSince < since`; the callers pass it along: the agent gate, the dynamic-workflow
// gate, the graph driver through doRun) — otherwise a running turn waiting for its subagent and the layout waiting for the
// turn would deadlock. Every other start waits. `running` and `error` (after the turnaround): EVERY start in the project
// waits, no matter when its work began. A oneshot without an instance runs in B as with every lock except the relocation.
// Every other lock is judged by `verdict`.
function verdictTheLock(marker, purpose, projectId, parentSince) {
  if (marker.reason !== "layout") return verdict(marker.reason, purpose, projectId);
  const waiting = marker.phase === "waiting";
  if (waiting && Number.isFinite(parentSince) && parentSince < marker.since) return null;
  if (purpose === "oneshot") return null;
  const u = verdict(waiting ? "layout-waiting" : "layout", purpose, projectId);
  return { ...u, reason: "layout", state: "layout", phase: marker.phase };
}

// `projectId`: the project of the CORE in which an agent runs — after a project switch it is no longer that of the chat.
// Without it, that of the chat (turn, oneshot, core without a project).
// `identifier`: the instance `<projectId>/<instance>` to which the core is pinned — like its project. With it the lock
// judges THIS instance (lock and row), not the one the chat stands in now: idle counts the core by its identifier too
// (idleOf `here`), and "lock first, then idle" only holds if both judge the same instance. Without an identifier (no
// instance row when the core was opened) or with that of another project, the instance of the chat.
// `parentSince`: the start time of the work this start belongs to — only the lock "layout" in `waiting` asks for it.
export function projectLock(chatId, purpose = "turn", { projectId: coreProject = null, identifier = null, inContainer = false, parentSince = null } = {}) {
  // The git view (devtools/code-route.js) asks with the purpose "view". It is judged like a turn in everything — except
  // a stopped instance: it NEVER nudges that (stoppedVerdict), it only reads.
  const view = purpose === "view";
  if (view) purpose = "turn";
  // The workspace of the chat is being deleted — checked before the ops marker (see header, workspaceDeleteLock).
  if (wsLocks.size) { const ws = workspaceVerdict(chatId, purpose); if (ws) return ws; }
  if (!projectboxOps()) return null;
  // A oneshot WITH an instance (runs/project-lock.js projectStartGate, also without a chat) is judged by its project like an agent.
  if (purpose === "oneshot" && inContainer === true && coreProject) purpose = ONESHOT_IN_PROJECT;
  // The explicit lock (in memory) BEFORE any database read — for the core the project is known without it: that of the
  // whole project, then that of the instance of the chat (unset connector: main, without the database; if it throws, the
  // path below judges — there it throws once more, and "unreadable" applies) or of the core.
  const core = coreProject ? String(coreProject) : null;
  const coreInstance = core && typeof identifier === "string" && identifier.startsWith(`${core}/`) ? instanceTheIdentifier(identifier) : null;
  const instanceOf = (pid) => {
    if (!coreInstance) return chatInstance(chatId, pid);
    copyNameOf(coreInstance); // throws for an invalid instance
    return coreInstance;
  };
  if (core) {
    let s = lock.get(core) || null;
    if (!s && instanceLocks.size) { try { s = instanceLocks.get(identifierOf(core, instanceOf(core))) || null; } catch { s = null; } }
    // An earmarking "layout" does NOT judge alone — below it the instance keeps judging (further down).
    if (s && s.reason !== "layout") return verdictTheLock(s, purpose, core, parentSince);
  }
  let projectId = core;
  let earmarking = null;
  try {
    if (!projectId) projectId = store.getChat(chatId)?.projectId || null;
    if (!projectId) return null;
    const instance = instanceOf(projectId);
    const whole = lock.get(String(projectId)) || null;
    earmarking = whole?.reason === "layout" ? whole : null;
    if (!earmarking) {
      const locked = lockFor(projectId, instance);
      if (locked) return verdictTheLock(locked, purpose, projectId, parentSince);
      return instanceVerdict(purpose, projectId, instance, chatId, view);
    }
    return withEarmarking(earmarking, { chatId, purpose, projectId, parentSince }, () => {
      const s = instanceLocks.get(identifierOf(projectId, instance)) || null;
      return s ? verdictTheLock(s, purpose, projectId, parentSince) : instanceVerdict(purpose, projectId, instance, chatId, view);
    });
  } catch (e) {
    // Unreadable under an earmarking: its verdict, and where it would let pass, closed like every unreadable case.
    if (earmarking) return verdictTheLock(earmarking, purpose, projectId, parentSince) || unreadable(e, purpose, projectId);
    return unreadable(e, purpose, projectId);
  }
}

// The verdict about the INSTANCE (without an explicit lock): row, conversion, server end, setup, `error` with the new
// attempt. Throws if the database does not answer (the caller then judges "unreadable").
// `view`: the question of the git view — a stopped instance is only read (stoppedVerdict).
function instanceVerdict(purpose, projectId, instance, chatId = null, view = false) {
  let inst = rowOf(projectId, instance);
  // A chat whose copy does not exist (any more) never runs silently in the main instance — a lock with a message.
  if (!inst) return instance === MAIN ? null : copyMissing(instance, purpose, projectId);
  if (store.PROJECT_WORK_STATES.includes(inst.state)) return verdict(inst.state, purpose, projectId);
  if (!inst.convertedAt) return null;
  if (serverEnds()) return verdict("serverEnd", purpose, projectId);
  // Whoever wants to work in a stopped instance starts it and waits (header "stopped and converted").
  if (inst.state === "stopped") return stoppedVerdict(purpose, projectId, instance, chatId, { view, row: inst });
  // Header "ready while a server step of the setup runs": only the main instance, only on `ready`.
  if (instance === MAIN && inst.state === "ready" && setupRunning(projectId)) return verdict("setup", purpose, projectId);
  if (inst.state === "error" && purpose !== "oneshot" && attemptFromError(projectId, inst)) {
    // The new attempt has begun — judge anew, by the state of NOW.
    const now = rowOf(projectId, instance);
    if (now && store.PROJECT_WORK_STATES.includes(now.state)) return verdict(now.state, purpose, projectId);
    if (now?.state !== "error") return null;
    inst = now; // failed synchronously (e.g. without the marker): the fresh reason
  }
  if (inst.state === "error" && purpose !== "oneshot") {
    const reason = String(inst.error || "").trim() || T("no reason given");
    // A copy being cleared away does not come back up — the sentence says how to go on (no silent main instance).
    // Unreadable ⇒ the plain sentence.
    let clearing = null;
    if (instance !== MAIN) { try { clearing = copyInClearAway(projectId, instance); } catch { clearing = null; } }
    if (clearing) {
      return { kind: "error", reason: "error", state: "error", projectId,
        text: T`This chat's copy "${clearing.name}" is not removed (${reason}) — nothing started, not in the main instance either. Trigger the removal again (services pill: "Remove"; a server restart resumes it by itself) — afterwards this chat works in the main instance.` };
    }
    return { kind: "error", reason: "error", state: "error", projectId,
      text: T`Project container not ready: ${reason}` };
  }
  return null;
}

// The verdict about a stopped instance — nudge, then judge by the state of NOW (`start` waits, `stopped` waits — for the
// queue or, if denied, until the next look at the lock —, `error` ends visibly, `ready` runs).
// The git view (`view`) NEVER nudges — otherwise every read of the right rail, of the code tab and of the workspace would
// restart a stopped instance and write the separator "<instance> started." as an orphaned row. It only reports: if a
// start request already stands in the storage queue it waits with it; otherwise "stopped — start it in the Instances tab".
function stoppedVerdict(purpose, projectId, instance, chatId, { view = false, row = null } = {}) {
  if (purpose === "oneshot") return null; // a oneshot without an instance runs in B
  if (view) {
    if (row?.phase === WAITING_STORAGE) return verdict("stopped-storage", purpose, projectId);
    return { kind: "error", reason: "stopped", state: "stopped", projectId,
      text: T`Instance ${instance} is stopped — start it in the "Instances" tab.` };
  }
  if (!stoppedStart) {
    return { kind: "error", reason: "stopped", state: "stopped", projectId,
      text: T`Instance ${instance} is stopped — nothing started. Start it in the project's "Instances" tab.` };
  }
  let nudge = null;
  try { nudge = stoppedStart(projectId, instance, { chatId: chatId ? String(chatId) : null }); }
  catch (e) { console.error(`[project] ${projectId}/${instance}: start from the lock not nudged:`, e?.message || e); }
  const now = rowOf(projectId, instance);
  if (!now) return instance === MAIN ? null : copyMissing(instance, purpose, projectId);
  if (store.PROJECT_WORK_STATES.includes(now.state)) return verdict(now.state, purpose, projectId);
  if (now.state === "stopped" && now.phase !== WAITING_STORAGE && nudge?.ok === false && nudge.kind === "denied") {
    // The start was DENIED (an occupancy — another copy being built, the observer's reconciliation …). The verdict says
    // why and remembers the instance: no transition of the row and no storage queue would come, so the turn would wait
    // until the check-back. The end of the occupancy (afterOccupancy) wakes its waiting chats, and their look at the lock
    // nudges the start again.
    denied.add(identifierOf(projectId, instance));
    const reason = String(nudge.reason || "").trim();
    return verdict("stopped", purpose, projectId, T`Instance ${instance} is stopped; it cannot be started right now${reason ? ` (${reason})` : ""} — the start is retried once that is over`);
  }
  if (now.state === "stopped") return verdict(now.phase === WAITING_STORAGE ? "stopped-storage" : "stopped", purpose, projectId);
  if (now.state === "error") {
    return { kind: "error", reason: "error", state: "error", projectId,
      text: T`Project container not ready: ${String(now.error || "").trim() || T("no reason given")}` };
  }
  return null;
}

// The earmarking "layout" and the instance below it.
// The instance judges first — a lock of the instance (recreate), `start`/`error`/… with error sentence and new attempt —,
// the layout only where the instance has nothing to say. If the earmarking judged alone, a recreation could never get
// past it, the new attempt out of `error` would never be reached, and an open job would lock the project forever (the
// procedure waits for `ready`, which never comes). Exception: if the procedure works IN THIS process (project occupancy
// "layout"), the instance belongs to it — then only its verdict.
// A follow-up step (`parentSince < since`) that the earmarking holds outside `waiting` (the short `running` of the quiet
// check) parks in the wait row — whose payload does not carry `parentSince`. The marker remembers it (`followUps`:
// chatId → parentSince); its wakeup and its start in doRun (both without `parentSince`) then judge with the remembered
// value — only while the chat has a run wait row or is just starting, so that a later message of the human does not ride
// along. Once started (`running` holds it) it is used up. Back in `waiting` the phase wakes exactly these chats
// (wakeFollowUps).
function withEarmarking(marker, { chatId, purpose, projectId, parentSince }, below) {
  const c = String(chatId || "");
  const remembered = purpose === "turn" && c && !Number.isFinite(parentSince) ? followUpSince(marker, c) : null;
  const since = Number.isFinite(parentSince) ? parentSince : remembered;
  const g = verdictTheLock(marker, purpose, projectId, since);
  const u = projectOccupied(projectId) === "layout" ? g : (below() || g);
  if (purpose === "turn" && c && marker.followUps) {
    if (u?.kind === "wait" && Number.isFinite(since) && since < marker.since) marker.followUps.set(c, since);
    else if (!u && running.has(c)) marker.followUps.delete(c);
  }
  return u;
}
// The remembered beginning of a follow-up step — only for the chat whose run wait row it is (or which is just starting).
function followUpSince(marker, chatId) {
  const s = marker.followUps?.get(chatId);
  if (s === undefined) return null;
  if (running.has(chatId)) return s;
  const row = store.getPendingResume(chatId);
  return row && (row.kind || "run") === "run" ? s : null;
}
// Wake the remembered follow-up steps (phase back to `waiting`, or a transition of the instance under a waiting
// earmarking). A chat without a run wait row is no longer a follow-up step. → how many.
function wakeFollowUps(pid, marker) {
  if (!marker.followUps?.size) return 0;
  const now = Date.now();
  let n = 0;
  for (const chatId of [...marker.followUps.keys()]) {
    try {
      const row = store.getPendingResume(chatId);
      if (!row || (row.kind || "run") !== "run") { if (!running.has(chatId)) marker.followUps.delete(chatId); continue; }
      if (wakeChat(chatId, now)) n += 1;
    } catch (e) { console.error(`[project] ${chatId}: follow-up step not woken:`, e?.message || e); }
  }
  if (n) console.log(`[project] ${pid}: ${n} follow-up step(s) woken (layout waits)`);
  return n;
}

// The instance of the chat is a copy and its row is missing — a turn and an agent end visibly (never a fallback to the
// main instance), a oneshot runs in B.
function copyMissing(instance, purpose, projectId) {
  if (purpose === "oneshot") return null;
  return { kind: "error", reason: "error", state: "error", projectId,
    text: T`This chat's copy "${instance}" does not exist (anymore) — nothing started, not in the main instance either.` };
}

// The database threw — closed (see header). A oneshot runs in B; it is only denied if its project is not known and a
// relocation in this process holds the lock (it could be that project). The lock of the KNOWN project was already asked
// by projectLock before the failed read.
// THE LIMIT: closed only where an instance row concerns the project or COULD concern it — the known project carries one
// (store.instanceRowPossible, the set in memory, without the database), or the project is unknown and some project
// carries one or holds an explicit lock (a relocation may lock before its first row). Otherwise null: in B without any
// row a read error parks no turn.
function unreadable(e, purpose, projectId) {
  const possible = projectId
    ? store.instanceRowPossible(projectId) || lock.has(String(projectId)) || Boolean(instanceLockAt(String(projectId)))
    : lock.size > 0 || instanceLocks.size > 0 || store.instanceRowPossible(null);
  if (!possible) {
    console.error(`[project] lock not readable (${purpose}, ${projectId || "project unknown"}): ${e?.message || e} — open: no instance row that could concern it`);
    return null;
  }
  console.error(`[project] lock not readable (${purpose}, ${projectId || "project unknown"}): ${e?.message || e} — closed`);
  if (purpose === "oneshot") {
    const relocation = !projectId && [...lock.values()].some((m) => m.reason === "relocation");
    return relocation ? verdict("relocation", "oneshot", null) : null;
  }
  return verdict("unreadable", purpose, projectId || null);
}

// The terminals the lock ends with a notice (projectLocks, `endTerminals`) and that idle therefore only counts: the
// project terminals of every instance (`projectTerminalTag`) and the terminals of the chat rail `chat:<chatId>` of every
// chat of the project. ONE list for three readers — idle, lock and the relocation plan (a process in the project folder
// in one of these terminals ends with it and does not hold the plan; if it survives, step 4 holds).
// Workspace terminals (`ws:<id>`) and sessions without a tag are not part of it (the lock does not touch them).
// The debuggers of a project route (debug.js) count and end with the same tags.
export function lockTerminalTags(projectId) {
  const pid = String(projectId ?? "");
  const copies = store.projectInstancesOf(pid).map((z) => z.instance).filter((i) => i !== MAIN);
  return [projectTerminalTag(pid), ...copies.map((i) => projectTerminalTag(pid, i)), ...store.chatIdsInProject(pid).map((chatId) => `chat:${chatId}`)];
}
/**
 * The tag of a project terminal or debugger in an instance: `proj:<id>` for the main instance (the same literal as the
 * terminal tab of the page, web/src/app/workspaces/page.tsx), `proj:<id>@copy-<name>` for a copy (like the scopeKey of
 * the browser of a copy, devtools/routes.js). The project level of the code route sets it itself — every session without
 * a tag `chat:<id>` gets the tag OF THE instance it runs in (devtools/routes.js `sessionTag`): otherwise the terminal of
 * the code tab would run in a copy without idle or lock seeing it.
 */
export function projectTerminalTag(projectId, instance = MAIN) {
  const i = String(instance || MAIN);
  return i === MAIN ? `proj:${projectId}` : `proj:${projectId}@${i}`;
}
// How many sessions (terminals and debuggers) carry these tags, and ending them with a notice.
const sessionsWith = (tags) => tags.reduce((n, tag) => n + countTerminalsByTag(tag) + countDebugByTag(tag), 0);
const endSessionsWith = (tags, notice) => tags.reduce((n, tag) => n + endTerminalsWithNotice(tag, notice) + endDebugWithNotice(tag, notice), 0);
/** End the project terminals and debuggers of ONE instance with a notice. Clearing away a copy calls this after its idle
 *  check. → how many.
 *  With `{ chats: true }` also the terminals of the chat rail (`chat:<id>`) of every chat of THIS instance — the same
 *  selection by which its idle check counts them (instanceTerminalTags; child chats of a graph run pinned there
 *  included). Otherwise an open terminal of the chat rail would keep writing through fetching and backing up, and what
 *  came afterwards would die silently with the container. A chat instance that cannot be determined throws (as in idle) —
 *  the caller reports it. */
export function endInstanceSessions(projectId, instance, notice, { chats = false } = {}) {
  const pid = String(projectId ?? "");
  const inst = String(instance || MAIN);
  const tags = chats ? instanceTerminalTags(pid, inst, store.chatIdsInProject(pid).filter((c) => chatInstance(c, pid) === inst)) : [projectTerminalTag(pid, inst)];
  endLanguageServices(pid, inst, "stop");
  return endSessionsWith(tags, notice);
}
/** End the terminal of the chat rail of a chat (`chat:<id>`) — with a notice to the viewers. Moving into a copy and moving
 *  out go through here: stacks/ does not import terminal.js. Returns how many. */
export const endChatTerminals = (chatId, notice) => endTerminalsWithNotice(`chat:${chatId}`, notice);
/** Session (pid of the shell) → tag, for every terminal from `lockTerminalTags` (terminal.js terminalPidsByTag). */
export function lockTerminalSessions(projectId) {
  const out = new Map();
  for (const tag of lockTerminalTags(projectId)) for (const sid of terminalPidsByTag(tag)) out.set(sid, tag);
  return out;
}

// What idle does NOT count: the open question (its answer is a new turn — the lock holds that). And the copy being built
// or cleared away (runs/archive.js reason "copy" — a reason of the ARCHIVE): it is not a run IN an instance but an
// operation ON it, which occupancy and instance row already carry (project occupancy, `create`/`clearAway` in
// PROJECT_WORK_STATES); counted, it would hold itself — step 0 of clearing away sets the instance row to `clearAway` and
// THEN asks the idle state of the copy, which counts its chat.
const IDLE_WITHOUT = new Set(["question", "copy"]);

export function projectIdle(projectId) {
  return idleOf(String(projectId ?? ""), null);
}

/**
 * The idle state of ONE instance (see header "PER IDENTIFIER") — `identifier` = `<projectId>/<instance>`. For the main
 * instance of a project without a copy exactly projectIdle. An invalid identifier throws.
 */
export function instanceIdle(identifier) {
  const k = String(identifier ?? "");
  const i = k.lastIndexOf("/");
  if (i <= 0) throw new TypeError(`instanceIdle: not an identifier "${k}" — <projectId>/<instance>`);
  const instance = k.slice(i + 1);
  copyNameOf(instance); // throws for an invalid instance
  return idleOf(k.slice(0, i), instance);
}

/**
 * THE WORK LOCK of an instance: a thin wrapper over instanceIdle, for the actions that stop or delete an instance or move
 * the code under it (switch branch, discard files, restart the stack). THE SAME calculation as the idle check before
 * clearing away a copy (stacks/remove.js): what is "not empty" there is "working" here.
 * → `{ quiet, chats: [{ id, title, reason, text }], open: [{ reason, text }], terminals }`:
 *   `chats`  ONE row per chat (the first reason; several reasons follow each other in `text`), the title from the store
 *            ("" if the chat cannot be read — the id stays);
 *   `open`   what works without belonging to a chat (worktree removal, service detection, a graph worktree being created);
 *   `terminals` the open sessions of the instance — they do NOT hold (as in idle; a terminal is a human watching, and
 *            clearing away ends it with a notice).
 * Unreadable (an invalid instance, a chat instance that cannot be determined) ⇒ NOT quiet, with reason "unreadable" —
 * rather wait than rebuild under running work. Synchronous, no await between question and answer.
 * What it does NOT hold: a turn that begins AFTER the question — the action itself locks no starts (see the header of
 * ./instance-actions.js).
 */
export function instanceWork(projectId, instance = MAIN) {
  const pid = String(projectId ?? "");
  const inst = String(instance || MAIN);
  let l;
  try { l = instanceIdle(identifierOf(pid, inst)); }
  catch (e) {
    return { quiet: false, chats: [], terminals: 0,
      open: [{ reason: "unreadable", text: T`The work in the instance cannot be read: ${e?.message || e}` }] };
  }
  const perChat = new Map();
  const withoutChat = [];
  for (const o of l.open) {
    if (!o.chatId) { withoutChat.push({ reason: o.reason, text: o.text || "" }); continue; }
    const existing = perChat.get(o.chatId);
    if (existing) { if (o.text && !existing.text.includes(o.text)) existing.text = `${existing.text} ${o.text}`.trim(); continue; }
    let title = "";
    try { title = String(store.getChat(o.chatId)?.title || ""); } catch { title = ""; }
    perChat.set(o.chatId, { id: o.chatId, title, reason: o.reason, text: o.text || "" });
  }
  return { quiet: l.quiet, chats: [...perChat.values()], open: withoutChat, terminals: l.terminals };
}

/**
 * The error of an occupied work lock for the routes: `status` 409, `code` "INSTANCE_WORKING", `chats` and `open` as in
 * instanceWork, the message a sentence with the chat titles. The routes answer `{ code, error, chats, open }`.
 */
export function instanceWorkingError(work, instance = MAIN) {
  const chats = work?.chats || [];
  const open = work?.open || [];
  const names = chats.map((c) => T`"${c.title || c.id}"`);
  const otherwise = open.map((o) => o.text).filter(Boolean);
  const who = [...names.length ? [T`chat(s) ${names.join(", ")}`] : [], ...otherwise].join("; ");
  const e = new Error(T`Work is still running in instance ${instance} — ${who || "unknown"}. The action is possible once it has finished.`);
  return Object.assign(e, { status: 409, code: "INSTANCE_WORKING", chats, open });
}

// The terminals of ONE instance: its project terminal (`projectTerminalTag` — main `proj:<id>`, a copy
// `proj:<id>@copy-<name>`), plus those of the chat rail of the chats of this instance. For the main instance without a
// copy exactly lockTerminalTags.
function instanceTerminalTags(pid, instance, chats) {
  return [projectTerminalTag(pid, instance), ...chats.map((chatId) => `chat:${chatId}`)];
}

// `onlyInstance` null: the whole project (projectIdle). Otherwise only what works in THIS instance.
function idleOf(pid, onlyInstance) {
  const open = [];
  const inProject = store.chatIdsInProject(pid);
  const chats = onlyInstance === null ? inProject : inProject.filter((chatId) => chatInstance(chatId, pid) === onlyInstance);
  const tags = onlyInstance === null ? lockTerminalTags(pid) : instanceTerminalTags(pid, onlyInstance, chats);
  const terminals = sessionsWith(tags);
  for (const chatId of chats) {
    const alongside = (reason, text) => open.push({ chatId, reason, text });
    for (const o of openWork(chatId)) if (!IDLE_WITHOUT.has(o.reason)) open.push({ chatId, ...o });
    const verdicts = runningVerdicts.get(chatId) || 0;
    if (verdicts) alongside("verdict", T`${verdicts} workflow verdict(s) running.`);
    const oneshots = runningOneshotsOf(chatId);
    if (oneshots) alongside("oneshot", T`${oneshots} model call(s) running.`);
    if (store.openForegroundStart(chatId)) alongside("graph-start", T("An announced graph workflow is waiting to start."));
  }
  // What a chat that is NO LONGER in the project keeps working on here (the loop above already counts the chats of the
  // project in full). Per instance also what is pinned to THIS instance while its chat stands in another. The instance of
  // a piece of work is that of its identifier; without an identifier (no instance row) that of its chat if it is in the
  // project, otherwise main. If it cannot be determined it counts everywhere (rather wait than create under it).
  const counted = new Set(chats);
  const inProjectSet = new Set(inProject);
  const here = (chatId, identifier) => {
    if (onlyInstance === null) return true;
    if (identifier) return instanceTheIdentifier(identifier) === onlyInstance;
    if (!inProjectSet.has(chatId)) return onlyInstance === MAIN;
    try { return chatInstance(chatId, pid) === onlyInstance; } catch { return true; }
  };
  for (const k of coresInProject(pid)) {
    // An outer-loop run also counts on a chat of THIS project: the loop above asks openWork, and it is deliberately not
    // listed there (archive, compaction and graph steps of the observed chat do not wait for it).
    if ((k.kind !== "outerloop" && counted.has(k.chatId)) || !here(k.chatId, k.identifier)) continue;
    const who = k.name ? T`"${k.name}" ` : "";
    const text = k.kind === "workflow"
      ? T("A dynamic workflow starts its agents here (its chat has switched projects).")
      // An outer-loop run with tools works at the location of its chat.
      : k.kind === "outerloop"
        ? T("An outer-loop run is working here (at the location of the chat it observes).")
        : T`Subagent ${who}keeps working here (its chat has switched projects).`;
    open.push({ chatId: k.chatId, reason: k.kind === "agent" ? "agent" : k.kind, ...(k.agentId ? { agentId: k.agentId } : {}), ...(k.runId ? { runId: k.runId } : {}), text });
  }
  // A running turn whose chat switched projects mid-way keeps running here, monitor and background bash included, until it
  // ends — pinned like a core (runs/instance.js turnsInProject). Without these rows it would drop out of the idle check
  // of A and a relocation would start under it. Per instance by its identifier.
  for (const chatId of turnsInProject(pid)) {
    if (counted.has(chatId) || !running.has(chatId) || !here(chatId, turnIdentifier(chatId))) continue;
    open.push({ chatId, reason: "running", text: T("A turn keeps running here (its chat has switched projects).") });
  }
  // A removal job of a worktree (runs/git-post-work.js — subagent, graph worktree, deletion path, the post-work after the
  // start) runs in the project container and belongs to no chat any more. Without this row a recreation would stop the
  // container under a running `worktree remove --force` (leaving a half-deleted worktree). Per instance — a job in main
  // holds main, one in a copy (removing one of its worktrees) that copy; the lock of the whole project (`onlyInstance`
  // null) waits for all.
  const git = openGitJobsOf(pid, onlyInstance === null ? null : onlyInstance || MAIN);
  if (git) open.push({ chatId: "", reason: "git", text: T`${git} Git job(s) (worktree removal) running in the project container.` });
  // A service detection that is COMPUTING right now (./detection.js) — it reads the project folder, in the project
  // container in the main instance (without an instance in B). A waiting one does not count: it holds nothing.
  const detections = onlyInstance === null || onlyInstance === MAIN ? runningDetectionsOf(pid) : 0;
  if (detections) open.push({ chatId: "", reason: "detection", text: T`${detections} service detection(s) running in the project.` });
  // A graph workflow is creating its own worktree right now (git in the project repo and in the runtime folder,
  // workflows/graph-start.js) — it belongs to no turn any more and would otherwise be invisible. Counted per project, in
  // every instance (rather wait than rebuild under it; creating takes seconds).
  const worktrees = worktreesBeingCreated(pid);
  if (worktrees) open.push({ chatId: "", reason: "worktree", text: T`${worktrees} graph workflow(s) are creating their worktree.` });
  return { quiet: open.length === 0, open, terminals };
}

export function projectLocks(projectId, { reason = "relocation", instance = null, terminalsLater = false, countTerminals = false, replaceLayout = false } = {}) {
  const pid = String(projectId ?? "");
  if (!pid) throw new Error("projectLocks: projectId is missing");
  if (!LOCK_REASONS.includes(reason)) throw new Error(`projectLocks: unknown reason "${reason}"`);
  if (reason === "layout") throw new Error("projectLocks: \"layout\" goes through earmarkProject (the lock over the waiting time)");
  // "recreate" and "freeze" lock ONE instance (default main; "freeze" also a copy — the template of a copy from a copy),
  // "relocation" and "erase" the whole project.
  const perInstance = PER_INSTANCE.has(reason);
  const inst = perInstance ? String(instance || MAIN) : null;
  if (!perInstance && instance && instance !== MAIN) throw new Error(`projectLocks: "${reason}" takes the whole project, not an instance (${instance})`);
  if (inst) copyNameOf(inst); // throws for an invalid instance
  if (!projectboxOps()) return { ok: false, error: ONLY_IN_OPS, open: [] };
  const deposit = perInstance ? instanceLocks : lock;
  const key = perInstance ? identifierOf(pid, inst) : pid;
  const who = perInstance && inst !== MAIN ? key : pid;
  // A lock of the whole project excludes every lock of an instance and vice versa; two instances side by side.
  // Two exceptions for the earmarking "layout" (it is not the lock of a procedure but a job that waits):
  //   "recreate" gets past it — the occupancies (layout procedure ↔ recreation, instance.js) exclude running at the same
  //       time, and without recreation a project with an open job would never get back to `ready` (which is exactly what
  //       the procedure waits for). The starts then judge the instance (withEarmarking).
  //   "erase" with `replaceLayout` TAKES OVER a waiting earmarking without waking (./erase.js): if idle refuses or
  //       something throws, it stands there again afterwards with the same `since`; likewise on release as long as the
  //       job is not withdrawn (`resolved`). Withdrawing the job BEFORE the check would let a refusal (409) silently drop
  //       the confirmed job and wake the held turns.
  const whole = lock.get(pid) || null;
  const beside = whole?.reason === "layout" && reason === "recreate";
  const replaced = whole?.reason === "layout" && reason === "erase" && replaceLayout && whole.phase === "waiting" ? whole : null;
  const old = (beside || replaced ? null : whole) || (perInstance ? instanceLocks.get(key) : instanceLockAt(pid));
  if (old) return { ok: false, open: [{ chatId: "", reason: "locked", text: T`The project is already locked (${old.reason}).` }] };
  const marker = { reason, since: Date.now() };
  // Take the own marker out of the deposit — a taken-over earmarking comes back as long as nobody has resolved it and its
  // job still waits (after a successful deletion it is gone with the project; unreadable ⇒ back, closed).
  const stillWaiting = () => { try { return store.layoutJob(pid)?.state === "waiting"; } catch { return true; } };
  const markerless = () => {
    if (deposit.get(key) !== marker) return false;
    if (replaced && !replaced.resolved && stillWaiting()) { deposit.set(key, replaced); return true; }
    deposit.delete(key);
    return false;
  };
  // 1. Set the lock — from here on no turn and no agent of the project begins —, 2. THEN idle. The other way round there
  // would be a window: a start between "quiet" and "locked" would run into the middle of the relocation.
  deposit.set(key, marker);
  // If something throws between setting and returning (a store read in idle, ending the terminals), the lock falls with
  // the throw — otherwise it would stand until the restart, and every turn of the project would wait for a procedure that
  // no longer exists. Set and released synchronously: nothing could wait in between, no waking needed.
  try {
    // "freeze" demands no idle state and ends no terminal (see LOCK_REASONS).
    if (reason === "freeze") return frozenLocked(pid, key, marker, inst);
    const idle = perInstance ? idleOf(pid, inst) : projectIdle(pid);
    // Deleting ENDS the outer-loop runs (no 409): an outer-loop run working here does not hold up ERASING — it is aborted
    // as soon as nothing else works (below). Every other reason waits for it.
    const olRuns = reason === "erase" ? idle.open.filter((o) => o.reason === "outerloop") : [];
    const withoutOl = olRuns.length ? idle.open.filter((o) => o.reason !== "outerloop") : idle.open;
    // `countTerminals`: whoever must not end an open terminal (applying a layout) lets it count as open work — the lock
    // then waits instead of closing it.
    // What the earmarking "layout" itself holds (its queue, the wait rows of the lock, an interrupted run before the
    // resumption — its turn waits at it) does not hold up the recreation beside it; otherwise each would wait for the
    // other. Everything that really works (also a follow-up step that was let through) still counts.
    const held = (o) => o.reason === "queue" || o.reason === "interrupted"
      || (o.reason === "waitRow" && isLockReason(store.getPendingResume(o.chatId)?.reason));
    const withoutHeld = beside ? withoutOl.filter((o) => !held(o)) : withoutOl;
    const open = countTerminals && idle.terminals
      ? [...withoutHeld, { chatId: "", reason: "terminal", text: T`${idle.terminals} terminal(s) of the project open.` }]
      : withoutHeld;
    if (open.length) {
      markerless();
      console.log(`[project] ${who}: not idle (${open.map((o) => o.reason).join(", ")}) — ${reason} waits`);
      return { ok: false, open };
    }
    // Only now that erasing is certain to go on (the lock stands, no run begins in the project any more): the outer-loop
    // runs working here — rows `aborted`, cores silent (outerloop/abort.js). Their agents keep running on other chats.
    if (olRuns.length) {
      abortOuterLoop({ runIds: olRuns.map((o) => o.runId).filter(Boolean), reason: T("project deleted") });
    }
    const notice = T`[cbase] ${situationText(reason)} — this terminal was closed.`;
    let ended = false;
    const endTerminals = () => {
      if (ended) return 0;
      ended = true;
      const tags = perInstance ? instanceTerminalTags(pid, inst, store.chatIdsInProject(pid).filter((c) => chatInstance(c, pid) === inst)) : lockTerminalTags(pid);
      const n = endSessionsWith(tags, notice);
      if (n) console.log(`[project] ${who}: ${n} terminal(s) ended (${reason})`);
      const sd = endLanguageServices(pid, perInstance ? inst : null, reason);
      if (sd) console.log(`[project] ${who}: ${sd} language server(s) ended (${reason})`);
      return n;
    };
    // `terminalsLater`: the caller locks SEVERAL projects and ends the terminals only when all are quiet — a 409 at a
    // later project would otherwise leave the shells of the earlier ones already ended.
    const terminalsEnded = terminalsLater ? 0 : endTerminals();
    console.log(`[project] ${who}: locked (${reason})`);
    let free = false;
    return {
      ok: true, terminalsEnded,
      ...(terminalsLater ? { endTerminals } : {}),
      resolve() {
        if (free) return false;
        free = true;
        const back = markerless();
        console.log(`[project] ${who}: lock released (${reason})${back ? " — the waiting layout stands again" : ""}`);
        wakeProject(pid, perInstance ? { instance: inst } : {});
        return true;
      },
    };
  } catch (e) {
    markerless();
    throw e;
  }
}

// The lock "freeze": it is already set — as the lock of the frozen instance (`key` = its identifier; main, or the template
// of a copy from a copy); without idle, without terminals — only `resolve` (once, wakes the chats of THIS instance).
function frozenLocked(pid, key, marker, inst = MAIN) {
  const where = inst === MAIN ? pid : key;
  console.log(`[project] ${where}: locked (freeze)`);
  let free = false;
  return {
    ok: true, terminalsEnded: 0,
    resolve() {
      if (free) return false;
      free = true;
      if (instanceLocks.get(key) === marker) instanceLocks.delete(key);
      console.log(`[project] ${where}: lock released (freeze)`);
      wakeProject(pid, { instance: inst });
      return true;
    },
  };
}

/**
 * EARMARK the lock "layout" over the waiting time — a lock of the WHOLE project, without an idle check and without
 * terminals (the layout job checks for quiet itself, again and again, until it is there). `since`: the beginning of the
 * job (the pass `parentSince < since`), `phase`: `waiting` · `running` · `error` (verdictTheLock). → `{ ok: true, marker,
 * phase(p), resolve() }` or `{ ok: false, open }` (another lock stands — relocation, recreate, erase, freeze — or without
 * ops `{ ok: false, error }`). If an earmarking "layout" already stands for the project (a restart in the same process,
 * the restart grace sets it anew), the new one takes it over. `resolve()` (once) releases it and wakes like every lock.
 */
export function earmarkProject(projectId, { reason = "layout", since = Date.now(), phase = "waiting" } = {}) {
  const pid = String(projectId ?? "");
  if (!pid) throw new Error("earmarkProject: projectId is missing");
  if (reason !== "layout") throw new Error(`earmarkProject: only "layout", not "${reason}"`);
  if (!["waiting", "running", "error"].includes(phase)) throw new Error(`earmarkProject: unknown phase "${phase}"`);
  if (!projectboxOps()) return { ok: false, error: ONLY_IN_OPS, open: [] };
  // A recreation of an instance is not in the way (it runs beside the earmarking, see projectLocks) — every other lock is.
  let old = lock.get(pid) || null;
  if (!old || old.reason === "layout") {
    const front = `${pid}/`;
    for (const [k, m] of instanceLocks) if (k.startsWith(front) && m.reason !== "recreate") { old = m; break; }
  }
  if (old && old.reason !== "layout") return { ok: false, open: [{ chatId: "", reason: "locked", text: T`The project is already locked (${old.reason}).` }] };
  // `followUps` (withEarmarking): the held follow-up steps — a taken-over earmarking passes them on.
  const marker = { reason, since: Number(since), phase, followUps: old?.followUps instanceof Map ? old.followUps : new Map(), resolved: false };
  lock.set(pid, marker);
  console.log(`[project] ${pid}: earmarked (layout, ${phase})`);
  let free = false;
  return {
    ok: true, marker,
    phase(p) {
      if (!["waiting", "running", "error"].includes(p)) return marker.phase;
      const prior = marker.phase;
      marker.phase = p;
      // Back in `waiting` — the follow-up steps held outside `waiting` may pass again. Only while this marker really
      // stands (an erase lock that took it over wakes by itself when it goes).
      if (p === "waiting" && prior !== "waiting" && lock.get(pid) === marker) wakeFollowUps(pid, marker);
      return marker.phase;
    },
    resolve() {
      if (free) return false;
      free = true;
      marker.resolved = true; // an erase lock that took it over does not give it back afterwards
      if (lock.get(pid) === marker) lock.delete(pid);
      console.log(`[project] ${pid}: earmarking released (layout)`);
      wakeProject(pid);
      return true;
    },
  };
}

export function wakeProject(projectId, { instance = null } = {}) {
  const pid = String(projectId ?? "");
  if (!pid) return 0;
  // Under a WAITING earmarking "layout" a transition only wakes the remembered follow-up steps — every other start would
  // keep waiting anyway, and waking would only write it a second wait row. The waiting workflow agents judge anew in the
  // process (one whose run began before the job may pass in `waiting`).
  const whole = lock.get(pid);
  if (whole) {
    if (whole.reason !== "layout" || whole.phase !== "waiting") return 0;
    const n = wakeFollowUps(pid, whole);
    wakeProjectWaiting();
    return n;
  }
  // Which instances may go on now — no lock of the instance, its row is not working. Either the named one (the state
  // wakeup names the instance whose row just became `ready`/`error`), otherwise main and every copy of the project.
  const candidates = instance
    ? [String(instance)]
    : [MAIN, ...store.projectInstancesOf(pid).map((z) => z.instance).filter((i) => i !== MAIN)];
  const free = new Set(candidates.filter((i) => {
    if (instanceLocks.has(identifierOf(pid, i))) return false;
    const z = rowOf(pid, i);
    if (i === MAIN && setupRunning(pid)) return false; // the end of the server step wakes
    return !(z && store.PROJECT_WORK_STATES.includes(z.state));
  }));
  if (!free.size) return 0;
  // The service detection waiting at the lock (it runs in the main instance).
  const detections = free.has(MAIN) ? wakeDetections(pid) : 0;
  const inFree = (chatId) => { try { return free.has(chatInstance(chatId, pid)); } catch { return false; } };
  const now = Date.now();
  let n = 0;
  for (const chatId of store.chatIdsInProject(pid)) {
    if (!inFree(chatId)) continue;
    if (wakeChat(chatId, now)) n += 1;
  }
  const agents = wakeProjectWaiting();
  if (n || agents || detections) console.log(`[project] ${pid}: woken — ${n} chat(s), ${agents} workflow agent(s)${detections ? `, ${detections} detection(s)` : ""}`);
  return n;
}

// Wake a chat whose start a lock held (wakeProject, workspaceDeleteLock): fire its wait row or start the next entry of its
// queue. `true` if something was triggered.
function wakeChat(chatId, now) {
  if (running.has(chatId) || compacting.has(chatId) || controlActive.has(chatId) || autoContinueFiring.has(chatId)) return false;
  const row = store.getPendingResume(chatId);
  if (row && (isLockReason(row.reason) || takeHalted(chatId) || row.dueAt <= now)) {
    fireAutoContinue(chatId).catch((e) => console.error(`[project] ${chatId}: wait row not fired:`, e?.message || e));
    return true;
  }
  // "Parked is like running": behind a run row the queue waits for its continuation; a running workflow belongs to its
  // driver (the same conditions as runInputsRestartGrace).
  if (row && (row.kind || "run") === "run") return false;
  if (store.getWorkflowRun(chatId)?.status === "running") return false;
  return Boolean(startFollowUpRun(chatId, takeNextRunInput(chatId)));
}

// ── the lock of a workspace while it is being deleted (see header, workspaceDeleteLock) ──────────────────────────────────
/** Does the delete lock of this workspace stand right now (it is being deleted)? — for the POST of a project creation: a
 *  project created during the docker steps of the deletion would afterwards lose only its project row; container,
 *  instance row and setup row would stay orphaned. */
export const workspaceGetsDeleted = (workspaceId) => wsLocks.has(String(workspaceId ?? ""));

export function workspaceDeleteLock(workspaceId) {
  const wid = String(workspaceId ?? "");
  if (!wid) throw new Error("workspaceDeleteLock: workspaceId is missing");
  if (wsLocks.has(wid)) {
    return { ok: false, error: T("The workspace is being deleted — wait until the deletion has finished.") };
  }
  const marker = { since: Date.now(), held: new Set(), agents: false };
  wsLocks.set(wid, marker);
  let free = false;
  return {
    ok: true,
    resolve() {
      if (free) return 0;
      free = true;
      if (wsLocks.get(wid) === marker) wsLocks.delete(wid);
      const now = Date.now();
      let n = 0;
      // Never throws (the route calls it in finally, after its answer): a chat whose waking fails does not hold up the
      // others — the sweeper takes its wait row at its due time, the lock itself is already gone.
      for (const chatId of marker.held) {
        try {
          const chat = store.getChat(chatId);
          if (!chat) continue; // deleted with the workspace — queue and wait row fell with it
          if (chat.projectId && lock.has(String(chat.projectId))) continue; // wakeProject wakes it when that lock is released
          if (wakeChat(chatId, now)) n += 1;
        } catch (e) { console.error(`[project] ${chatId}: not woken after the workspace delete lock:`, e?.message || e); }
      }
      let agents = 0;
      try { agents = marker.agents ? wakeProjectWaiting() : 0; }
      catch (e) { console.error(`[project] workspace ${wid}: workflow agents not woken:`, e?.message || e); }
      if (n || agents) console.log(`[project] workspace ${wid}: delete lock released — woken ${n} chat(s), ${agents} workflow agent(s)`);
      return n;
    },
  };
}

// The verdict of the workspace lock for ONE start — null if the workspace of the chat is not being deleted. A oneshot runs.
// Unreadable (the database throws) while a lock stands: closed — the start waits (reason "unreadable", the sweeper checks
// back) instead of possibly beginning in a chat that is about to fall.
function workspaceVerdict(chatId, purpose) {
  if (purpose === "oneshot") return null;
  let chat;
  try { chat = store.getChat(chatId); }
  catch (e) {
    console.error(`[project] workspace lock not readable (${purpose}, ${chatId}): ${e?.message || e} — closed`);
    return verdict("unreadable", purpose, null);
  }
  const marker = chat?.workspaceId ? wsLocks.get(String(chat.workspaceId)) : null;
  if (!marker) return null;
  const header = { reason: "workspace", state: "workspace", projectId: chat.projectId || null };
  if (purpose === "agent") {
    marker.agents = true;
    return { kind: "wait", ...header, text: T("The workspace is being deleted — no subagent started.") };
  }
  marker.held.add(String(chatId));
  return { kind: "wait", ...header, text: T("The workspace is being deleted — this turn waits; if the deletion is aborted, it starts afterwards.") };
}
