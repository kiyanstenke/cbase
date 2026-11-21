// The moving-in of the chat into its copy. What is in `runs/instance.js` (instanceForChat: the copy into the starts),
// `projectbox/idle.js` (the lock per identifier) and the connection points of do-run/agents says WHERE a chat works;
// this file says what happens IN TRANSITION: the wake call, the terminal of the chat bar, the child chats of graph
// runs, the running turn. Wired to the setter (stacks/state.js setCopyState calls `copyTransition` after every change)
// and in server.js (source `kind`, restart).
//
// copyKind(chatId) → null | { identifier }
//     runs/instance.js setCopySource `kind`: the child chat of a graph run (store.graphStartOfChild) and the identifier
//     its start began in (`graph_starts.instance`, "" = main). Not a child ⇒ null.
//
// A copy belongs to no chat — which chat works in it is in `chats.instance`, changed only via runs/instance-switch.js
// chatInstanceSet. What is called "the chat" below is the chat that CREATED it (`chat_id`), and it only counts with
// `inset` (the tool cbase_copy_stack; a human creates without it — then nobody moves in, and there is no wake call:
// the copy event suffices). Moving out concerns EVERY chat that works in it.
//
// copyTransition(prior, after)   (synchronous, catches every throw — the state change has happened)
//     → ready (from build)    MOVING IN, only with `inset`. (0) `chats.instance` = `copy-<name>` for the creating chat,
//                             with a separator. (1) The terminal of the chat bar `chat:<id>` ends with a notice (a
//                             shell in the main instance no longer belongs to the chat's work; the next one opens in
//                             the copy, devtools/routes.js). (2) A running turn stays in the main instance and the
//                             marker for the next turn is set (runs/instance.js turnInstanceSwitched): its silent
//                             notice says where the previous one ran. (3) The WAKE CALL: a follow-up turn
//                             `deliverUserPrompt(chat, { cause: "event", display: <task-notification> })` — never into
//                             the running turn, because the tool set and the location of the running turn are those of
//                             the main instance. The turn after it begins in the copy (the instance row `ready` is set
//                             in the same step). It is reported ONCE (marker `wakeCall` in the journal section `inset`,
//                             survives the restart). If the row already carries a job to remove (stacks/remove.js),
//                             there is no wake call: it is cleared away right again, the clearing away reports that.
//                             If the chat is in ANOTHER project, it does not move in: no (0), (1), (2), instead of (3) a
//                             silent notice "ready, you do not work in it" with the same marker — the next turn runs in
//                             the main instance of that project. A switch back does NOT take it up again (the instance
//                             is chosen in the chat). Likewise a CHILD chat of a graph run (pinned in the instance of
//                             its start): no moving in, instead of the wake call the silent notice.
//     → error (from build/waiting_*)  only with `inset`: the same wake call with the reason (only words) — the tool
//                             answered at once "is being built, you will be woken" and never waits in the turn. If the
//                             row has a job to remove (no build), or the chat is gone or archived (a wake call would
//                             pull it out of the archive), it stays with the silent notice or the log. The sentence
//                             about the new attempt comes from `newAttemptSet` (below): a new attempt ALWAYS goes
//                             directly with cbase_copy_stack (another copy under a free name); the sentence adds what
//                             the failed one still holds and how cbase_copy_stack_remove releases it (`copyHolds`).
//                             IF THE SERVER ENDS (runs/server-end.js serverEnds), no wake call — an `error` there is
//                             mostly the freeze at the lock, and the build puts the copy back into the queue
//                             afterwards (stacks/build.js backAfterServerEnd). A wake call "NOT built" would otherwise
//                             land in the queued inputs and run in the next process although the copy was waiting —
//                             and its marker would block the wake call of the next, real error. If it stays `error`
//                             (dismantling incomplete), the build calls `wakeCopyError`.
//     → waiting_* (from error)  the return into the queue (only backAfterServerEnd). The marker `inset.wakeCall` drops
//                             (it belongs to the ATTEMPT, not the row — one wake call per state per attempt), plus a
//                             silent notice "queued again".
//
//     → removed (from clearAway/error)  MOVING OUT. EVERY chat with `chats.instance` = `copy-<name>` in its project
//                             gets NULL, the separator, a silent notice, its terminal ends and the marker for the
//                             running turn is set. The child chats pinned in this copy go back to the main instance
//                             (`graph_starts.instance` = "", store.graphStartsInstanceBack — in the SAME synchronous
//                             step as `removed`, BEFORE the waiting turns are woken: otherwise their identifier would
//                             no longer resolve and they would be locked forever), each with a silent notice and an
//                             ended terminal. The wake call "removed" is done by remove.js — to the chat that cleared
//                             away as agent; on the old tool path to the creator with `inset`; never for a human.
//
// copyHolds(k) → { worked, instance, job, procedure }   What a copy in `error` still holds (the sentence about the new
//     attempt). A failed copy stays until it is cleared away — its name becomes free once it is `removed`. The fields:
//     never built (wasReady — nobody worked in it, there are no commits, no branches `copy/<name>/…` and no bundle of
//     it), no instance row anymore (the dismantling — stacks/dismantling.js and freeze.js dismantlingClone — deletes it
//     LAST and only if container, network, helper, volume and location are gone; if it stands, something stayed), no
//     job to remove (a clearing away runs, is pending or has failed) and no live procedure (projectbox/instances.js
//     procedureAlive — the build sets `error` from within its procedure and only ends afterwards). `job` (`jobStatus`)
//     is null (none), "running" (runs, waits or is pending after a restart; its result comes as a system message),
//     "failed" (its result `error` is reported — marker `reported` in the job, stacks/remove.js — and nothing runs or
//     waits in this process anymore: it NEVER comes back by itself, no further system message — only a new call of
//     cbase_copy_stack_remove executes it once more) or "repeated" (reported, and it runs anyway — the restart takes
//     the job up again: if it succeeds, the system message comes; if it fails again, it is NOT reported once more; the
//     sentence says both).
// newAttemptSet(k, holds)   the sentence about the new attempt and about clearing the failed one — for the wake call
//     `error` and the 409 COPY_OCCUPIED of a name (stacks/state.js occupiedWhatToDo).
// neverBuilt(k)   `error`, and nobody ever worked in it (not wasReady): its clearing away is only the dismantling of
//     the leftovers of its build — it fetches and backs up nothing. ONE condition for the clearing away
//     (stacks/clearAway.js), its message (stacks/remove.js) and the notice of the tool cbase_copy_stack_remove (the
//     DELETE route names it, stacks/routes.js → mcp/tools/stacks.js). A failed dismantling leaves it never built
//     (wasReady only counts the section `clearAway` with `ready` in the log) — the next call keeps dismantling.
// waitingStill(k)   the request is still waiting (store.STACK_COPY_WAITING): a job to remove DISMISSES it — never
//     built, nothing to fetch or back up, no wake call, only a silent notice. Not a case of neverBuilt (its sentence
//     speaks of leftovers of a failed build; a waiting request has none). ONE condition for the choice in
//     stacks/remove.js (execute at once, message without wake call) and the field `dismissed` of the DELETE route, by
//     which the tool chooses its sentence; stacks/clearAway.js follows.
//
// migrateCopiesFree()   server.js at start, ONCE per store (marker `migration.copies_free` in app_settings, also if
//     nothing was to do): every live copy with `chat_id` from before copies were detached from chats gets `inset = 1`
//     (it behaves as before: moving in and wake call to its chat), and its chat `chats.instance` = `copy-<name>` if it
//     is still in its project AND the copy binds it today (ready, clearAway, error after ready — the same question as
//     stacks/remove.js copyCarriesBinding; a copy in the build only binds it at `ready`, via `inset`). A column already
//     set stays. Without a separator: nothing changes for the chat. Returns `{ copies, bound }` or null (the marker was
//     already set).
//     `inset = 1` is INTENDED, not `0`: a legacy copy still in the build at the time of the migration would, with
//     `inset = 0`, never wake its waiting agent at `ready` — it would wait forever for the wake call the tool promised.
//     Do not "correct" it to `0`, do not adjust the guard (server/backend/test/stacks-schema.test.js). On clearing
//     away, `inset` wakes the creator only on the old tool path, never for a human (stacks/remove.js).
// copiesWakeRestartGrace()   server.js, after the restart: a copy with `inset` in `ready` without the marker `wakeCall`
//     (the server ended between the transition and the wake call) is reported once more — with its binding
//     (idempotent); a binding (`chats.instance`) to a copy without a live row (a crash between `removed` and the moving
//     out) goes back to main, with separator and silent notice — otherwise the chat would be locked forever; likewise
//     a child pin on a copy that no longer exists: it goes back to the main instance as in the moving out
//     (store.graphStartsPinIdentifiers against the live copies, graphStartsInstanceBack, silent notice, turn marker).
//     Without a copy row and without a pin two queries.
//
// Guards: server/backend/test/stacks-inset.test.js; the new attempt (copyHolds, newAttemptSet, neverBuilt)
// stacks-new-attempt.test.js.
import * as store from "../store.js";
import { T } from "../i18n.js";
import { COPY_PREFIX, copyInstance, copyNameOf } from "../projectbox/creation.js";
import { procedureAlive } from "../projectbox/instances.js";
import { endChatTerminals } from "../projectbox/idle.js";
import { depositHint } from "../runs/hints.js";
import { turnInstanceSwitched } from "../runs/instance.js";
import { chatInstanceSet } from "../runs/instance-switch.js";
import { serverEnds } from "../runs/server-end.js";
import { FINISHED_MARKER } from "../runs/completionNotice.js";
import { deliverUserPrompt } from "../runs/queue.js";

const SOURCE = "stack-copy";
export const COPIES_FREE_MARKER = "migration.copies_free";
const TEXT_MAX = 300;
const RESULT_MAX = 6000;

const text = (e) => String(e?.message || e || "unknown").split("\n")[0].slice(0, 800);
const xml = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const identifierOf = (k) => `${k.projectId}/${copyInstance(k.name)}`;
// Does the row have a job to remove? (Journal section `trigger`, stacks/state.js removeJob — read here instead of
// imported: state.js calls this file.)
const hasJob = (k) => { const a = k?.journal?.data?.trigger; return Boolean(a && typeof a === "object" && !Array.isArray(a)); };
// Does the copy rest for this chat because it is in another project (or in none)? The same question as the binding in
// runs/instance.js and the moving out. A deleted chat does not rest — it gets nothing anyway.
const restsFor = (k, chat) => Boolean(chat) && String(chat.projectId || "") !== String(k.projectId);
// The child chat of a graph run is pinned in the instance of its start (the source `kind` ALWAYS wins in the binding
// of runs/instance.js) — if it created a copy with `inset`, it does not move in: `chats.instance` would have no effect
// for it, and the wake call "from this turn on … in the copy" would be wrong (the same claim that PATCH and the
// switch tool refuse with 409, runs/instance-switch.js). Instead a silent notice as for a chat in another project.
const pinned = (chat) => Boolean(chat) && Boolean(copyKind(chat.id));

/** runs/instance.js setCopySource `kind` (head). */
export function copyKind(chatId) {
  const z = chatId ? store.graphStartOfChild(chatId) : null;
  return z ? { identifier: z.instance || "" } : null;
}

// ── The terminal of the chat bar ────────────────────────────────────────────────────────────────────────────────────

function terminalEnd(chatId, whereTo) {
  const notice = whereTo === "copy"
    ? T("[cbase] This chat's copy is ready — this terminal was closed; a new one opens in the copy.")
    : T("[cbase] This chat's copy was removed — this terminal was closed; a new one opens in the main instance.");
  try {
    const n = endChatTerminals(chatId, notice);
    if (n) console.log(`[stacks] chat ${chatId}: ${n} terminal(s) of the chat bar ended (${whereTo === "copy" ? "moving in" : "moving out"})`);
    return n;
  } catch (e) {
    console.error(`[stacks] chat ${chatId}: terminal of the chat bar not ended:`, text(e));
    return 0;
  }
}

// ── The wake call ───────────────────────────────────────────────────────────────────────────────────────────────────

/** The text of the wake call (form of the system message like stacks/remove.js copyWakeText). Only identifiers and
 *  words. Web and iOS read `<summary>` (web/src/lib/completionNotice.ts, Chat/CompletionNotice.swift) and recognise its
 *  English wording `Copy "<name>" ready` / `Copy "<name>" not built: <reason>` (hard cut: old stored German notes are rewritten by
 *  the private migration tool, there is no alias in the recognisers). */
export function moveInWakeText(k, state) {
  const inst = copyInstance(k.name);
  if (state === "ready") {
    const e = k.result && typeof k.result === "object" ? k.result : null;
    const rows = [
      `Copy ${k.projectId}/${inst} is ready.`,
      e?.branchSpace ? `Branch space in the main instance: ${e.branchSpace}` : `Branch space in the main instance: copy/${k.name}/`,
      e?.dnsName ? `Address from the project containers: ${e.dnsName}` : "",
      ...(Array.isArray(e?.hints) ? e.hints.map((h) => `- ${h}`) : []),
    ].filter(Boolean).join("\n");
    const note = `This is a system message about the copy ${k.projectId}/${inst}, not a user reply. From this turn on everything you start ANEW ` +
      "(CLI, file tools, subagents, terminal, browser, services) runs in the copy; what ran in the main instance before stays there. " +
      "Fetching works without removing via cbase_copy_stack_fetch, removing (fetch and back up first) via cbase_copy_stack_remove — without loss (copy X becomes copy/X/… in the main instance).";
    return [FINISHED_MARKER, `<task-id>${xml(inst)}</task-id>`, `<summary>${xml(`Copy "${k.name}" ready`)}</summary>`,
      `<result>${xml(rows.slice(0, RESULT_MAX))}</result>`, `<note>${xml(note)}</note>`, "</task-notification>"].join("\n");
  }
  const reason = String(k.error || k.reason || "no reason given").split("\n")[0].slice(0, TEXT_MAX);
  // The wake call comes from the setter, often in the middle of the build procedure that ends right after — its procedure does not count here.
  let further;
  try { further = newAttemptSet(k, { ...copyHolds(k), procedure: false }); }
  catch { further = "A new attempt goes with cbase_copy_stack — if it answers COPY_OCCUPIED, it says what to do first."; } // not readable ≠ clean
  const note = `This is a system message about the copy ${k.projectId}/${inst}, not a user reply. It was NOT built; the main instance is unchanged and thawed, ` +
    `this chat keeps working in the main instance. ${further}`;
  return [FINISHED_MARKER, `<task-id>${xml(inst)}</task-id>`, `<summary>${xml(`Copy "${k.name}" not built: ${reason}`)}</summary>`,
    `<result>${xml(reason)}</result>`, `<note>${xml(note)}</note>`, "</task-notification>"].join("\n");
}

function hint(k, text, chatId = k.chatId) {
  try { if (chatId && store.getChat(chatId)) depositHint(chatId, text, { source: SOURCE }); }
  catch (e) { console.error(`[stacks] notice ${identifierOf(k)}:`, text(e)); }
}

// The marker holds for ITS state — an `error` wake call after which the copy (server end, backAfterServerEnd) went
// back into the queue and became ready after all does not block the "ready". Once per state.
function woken(k, state) {
  const d = store.stackCopy(k.id)?.journal?.data?.inset;
  return Boolean(d && d.wakeCall && d.wakeCall.state === state);
}
function wakeCallRemember(k, state) {
  try { store.writeStackCopyJournal(k.id, { data: { inset: { wakeCall: { state, at: Date.now() } } } }); }
  catch (e) { console.error(`[stacks] copy ${identifierOf(k)}: wake call not recorded (${text(e)}) — a restart reports once more`); }
}

// One wake call per transition: `ready` and `error` of the build. Returns whether it woke.
function wakeCall(k, state) {
  if (!k.inset) return false; // without `inset` (a human created it) there is no wake call — the copy event suffices
  if (woken(k, state)) return false;
  const now = store.stackCopy(k.id) || k;
  if (hasJob(now)) return false; // it is cleared away right away; the clearing away reports
  const chat = store.getChat(k.chatId);
  if (!chat) { console.log(`[stacks] copy ${identifierOf(k)}: "${state}" — the chat is deleted, no wake call`); return false; }
  if (chat.archivedAt) { // a wake call would pull the chat out of the archive
    hint(k, state === "ready" ? T`Your copy "${k.name}" is ready.` : T`Your copy "${k.name}" was not built: ${String(now.error || "").slice(0, TEXT_MAX)}`);
    wakeCallRemember(k, state);
    return false;
  }
  if (state === "ready" && restsFor(k, chat)) { // the wake call would say "from this turn on in the copy" — wrong
    const name = (pid) => store.getProject(pid)?.name || pid;
    const where = chat.projectId ? T`in the project "${name(chat.projectId)}"` : T("without a project");
    hint(k, T`Your copy "${k.name}" in the project "${name(k.projectId)}" is ready. This chat is ${where} and does not work in it — nothing from here runs in it; a chat of that project gets into it by choosing its instance. It is only removed explicitly.`);
    wakeCallRemember(k, state);
    return false;
  }
  if (state === "ready" && pinned(chat)) { // a child chat does not move in (above)
    hint(k, T`Your copy "${k.name}" is ready. This chat is the child chat of a graph run and stays in the instance its run began in — nothing from here runs in it; another chat of the project gets into it by choosing its instance. It is only removed explicitly.`);
    wakeCallRemember(k, state);
    return false;
  }
  const t = moveInWakeText(now, state);
  deliverUserPrompt(chat, { prompt: t, display: t, cause: "event" });
  wakeCallRemember(k, state);
  return true;
}

/** stacks/build.js backAfterServerEnd: the copy stays `error` (dismantling incomplete) — the wake call skipped at
 *  server end (copyTransition) now. Catches every throw. */
export function wakeCopyError(k) {
  try { return wakeCall(store.stackCopy(k.id) || k, "error"); }
  catch (e) { console.error(`[stacks] copy ${identifierOf(k)}: wake call "error":`, text(e)); return false; }
}

// The return from `error` into the queue begins a new attempt — the marker of the old one drops, and the chat learns
// silently that the copy waits again (it got no wake call: at server end none goes out).
function backInTheQueue(k) {
  const d = store.stackCopy(k.id)?.journal?.data?.inset;
  if (d && typeof d === "object" && d.wakeCall) {
    const { wakeCall: _old, ...rest } = d;
    try { store.writeStackCopyJournal(k.id, { data: { inset: Object.keys(rest).length ? rest : null } }); }
    catch (e) { console.error(`[stacks] copy ${identifierOf(k)}: marker of the wake call not released:`, text(e)); }
  }
  const reason = String(k.reason || "").slice(0, TEXT_MAX);
  hint(k, T`Your copy "${k.name}" is queued again${reason ? `: ${reason}` : ""}. It builds by itself — nothing to do.`);
}

// ── The transitions ─────────────────────────────────────────────────────────────────────────────────────────────────

// The binding of the creating chat to its copy (moving in) — only with `inset`, only if the chat is still in its
// project (otherwise its terminal and its turn belong to the other project). Idempotent: if the column is already set,
// nothing changes (no second separator after a restart).
function bindOne(k) {
  const chat = k.inset && k.chatId ? store.getChat(k.chatId) : null;
  if (!chat || restsFor(k, chat) || pinned(chat)) return false;
  const inst = copyInstance(k.name);
  if (chat.instance === inst) return false;
  chatInstanceSet(chat.id, inst); // separator, event, marker on the running turn
  terminalEnd(chat.id, "copy");
  return true;
}

function inset(k) {
  if (!k.inset) return; // a human created it — nobody moves in, no wake call (the copy event suffices)
  bindOne(k);
  wakeCall(k, "ready");
}

// Was the chat ever in this copy? The log knows `ready` as done — or `ready` was announced (stacks/build.js announces
// the step BEFORE the transition, and only this path leads to `ready`: the transition ran, the process died before
// "done") and the clearing away has begun (journal `clearAway`).
// The section `clearAway` ALONE does not count: a failed dismantling on the "never built" path could write it, and a
// second clearing away would then write its run over it — a never built copy would count as occupied afterwards and
// hold chat, new attempt (409 COPY_OCCUPIED) and delete (409) forever. Without `ready` in the log the copy was never
// ready: nobody worked in it. REMAINING RISK: a row whose transition to `ready` was announced and THREW (the instance
// row was not in `create`), and which an older release then described that way, keeps counting as occupied.
const readyInLog = (k, what = null) => (k?.journal?.log || []).some((p) => p.step === "ready" && (what === null || p.what === what));
export const wasReady = (k) => readyInLog(k, "done") || (readyInLog(k) && Boolean(k?.journal?.data?.clearAway));

/** Never built (head): `error` without wasReady — its clearing away is only the dismantling of the leftovers of its build, it fetches and backs up nothing. */
export const neverBuilt = (k) => k?.state === "error" && !wasReady(k);

/** The request is still waiting (head): a job to remove dismisses it — never built, nothing to fetch, no wake call. */
export const waitingStill = (k) => store.STACK_COPY_WAITING.includes(k?.state);

// ── A new attempt ───────────────────────────────────────────────────────────────────────────────────────────────────

// Does the clearing away of this copy run in THIS process, or does it wait there (for idle, for the end of its build)?
// Only stacks/remove.js knows (the ONLY caller of clearAwayCopy) — it registers here when loaded (remove.js imports
// this file; an import in the opposite direction would be a cycle). Without registration remove.js is not loaded,
// and then no clearing away runs in this process either.
let clearAwayRunning = () => false;
export function setClearAwayRunning(fn) { clearAwayRunning = typeof fn === "function" ? fn : () => false; }

// The job to remove (head, copyHolds `job`): null, "running", "failed" or "repeated".
function jobStatus(k) {
  if (!hasJob(k)) return null;
  if (k.journal.data.trigger.reported?.state !== "error") return "running";
  return clearAwayRunning(k) ? "repeated" : "failed";
}

/** What a copy (in `error`) still holds (head) — `instance` is the instance row `copy-<name>` or null. */
export function copyHolds(k) {
  return {
    worked: wasReady(k),
    instance: store.projectInstance(k.projectId, copyInstance(k.name)),
    job: jobStatus(k),
    procedure: procedureAlive(k.projectId, copyInstance(k.name)),
  };
}

/**
 * The sentence about the new attempt (head) — with the tool names, only identifiers and words. A new attempt ALWAYS
 * goes directly (another copy); the sentence says what the failed one still holds and how cbase_copy_stack_remove
 * releases it — until then it carries its name, a new attempt without `name` takes a free one.
 */
export function newAttemptSet(k, h = copyHolds(k)) {
  const name = `name "${k.name}"`;
  const fresh = `A new attempt goes directly with cbase_copy_stack at any time (another copy; without name cbase picks a free name — "${k.name}" stays taken until this one is removed).`;
  if (h.job === "failed") {
    return `Its removal failed (the reason is in its error) and no longer runs — no further system message comes about it: ` +
      `call cbase_copy_stack_remove with ${name} again (a new run, nothing is lost). ${fresh}`;
  }
  if (h.job === "repeated") {
    return "Its removal had failed and is running once more right now: if it succeeds, a system message comes; if it fails again, NONE comes — " +
      `then call cbase_copy_stack_remove with ${name} again. ${fresh}`;
  }
  if (h.job) return `It is being removed; the result comes as a system message. ${fresh}`;
  if (h.worked) {
    return `Work was done in it: cbase_copy_stack_remove with ${name} fetches and backs up its work to copy/${k.name}/… in the main instance and then removes it. ${fresh}`;
  }
  if (h.instance) {
    return `Its dismantling left something standing (instance ${copyInstance(k.name)}: ${h.instance.state}): cbase_copy_stack_remove with ${name} removes the leftovers. ${fresh}`;
  }
  if (h.procedure) return `Its procedure is just ending. ${fresh}`;
  return `Nothing of it is left except its row: cbase_copy_stack_remove with ${name} releases the name. ${fresh}`;
}

function extract(k, prior) {
  const identifier = identifierOf(k);
  const children = store.graphStartsInstanceBack(identifier);
  for (const id of children) {
    terminalEnd(id, "main");
    turnInstanceSwitched(id);
    try {
      if (store.getChat(id)) {
        depositHint(id, T`The copy "${k.name}" in which this run began was removed — this chat's next turn works in the main instance (its commits and open work are there under copy/${k.name}/…).`, { source: SOURCE });
      }
    } catch (e) { console.error(`[stacks] child chat ${id}: notice:`, text(e)); }
  }
  if (children.length) console.log(`[stacks] copy ${identifier} removed: ${children.length} child chat(s) back in the main instance`);
  // EVERY chat that works in it goes back to main — separator, silent notice, terminal, turn marker. `chats.instance`
  // says who that is (a dismissed waiting or never built copy never bound anyone — no column binds to it).
  for (const id of store.chatsInInstance(k.projectId, copyInstance(k.name))) {
    try {
      chatInstanceSet(id, null);
      terminalEnd(id, "main");
      hint(k, T`The copy "${k.name}" this chat worked in was removed — its next turn works in main (its commits and open work are there under copy/${k.name}/…).`, id);
    } catch (e) { console.error(`[stacks] moving out ${identifier}: chat ${id}:`, text(e)); }
  }
  // Open: the browser profile of the copy (`proj-<id>@copy-<name>`, devtools/routes.js) stays in the runtime folder —
  // the user container never deletes recursively there (a container can swap a subfolder for a symlink), and the path
  // via the root helper belongs to the clearing away of the copy. It drops with the project's runtime folder.
}

/**
 * stacks/state.js setCopyState, after every change (head). Catches every throw: the state change has happened.
 * `returnPathAtServerEnd`: the setter announces that at server end a return into the queue can follow (only
 * stacks/freeze.js — build.js backAfterServerEnd puts back or wakes). Only THEN is the error wake call skipped at
 * server end; every other `error` (dismantling after a step, start of the queue, restart) is final and wakes at
 * server end too — queued, the next process delivers.
 */
export function copyTransition(prior, after, { returnPathAtServerEnd = false } = {}) {
  try {
    if (!after || prior.state === after.state) return;
    if (after.state === "ready" && prior.state === "build") inset(after);
    else if (after.state === "error" && (prior.state === "build" || store.STACK_COPY_WAITING.includes(prior.state))) {
      if (returnPathAtServerEnd && serverEnds()) console.log(`[stacks] copy ${identifierOf(after)}: "error" at server end — no wake call (the build puts back or wakes)`);
      else wakeCall(after, "error");
    }
    else if (prior.state === "error" && store.STACK_COPY_WAITING.includes(after.state)) backInTheQueue(after);
    else if (after.state === "removed" && prior.state !== "removed") extract(after, prior);
  } catch (e) {
    console.error(`[stacks] transition ${prior?.state} → ${after?.state} (${after ? identifierOf(after) : "?"}): moving in/out:`, text(e));
  }
}

// A child pin (`graph_starts.instance`) on a copy without a live row — the moving out threw while re-pinning
// (copyTransition only catches and logs), or the server ended between `removed` and the re-pinning. Without repair the
// child chat would stay locked forever; here it goes back to the main instance as in the moving out (silent notice,
// turn marker). Only copy identifiers (`<projectId>/copy-<name>`) — another identifier is not a pin of this file.
function deadPinsBack(live) {
  const liveness = new Set(live.map(identifierOf));
  for (const identifier of store.graphStartsPinIdentifiers()) {
    const inst = identifier.slice(identifier.lastIndexOf("/") + 1);
    if (liveness.has(identifier) || !inst.startsWith(COPY_PREFIX)) continue;
    const name = inst.slice(COPY_PREFIX.length);
    try {
      const children = store.graphStartsInstanceBack(identifier);
      for (const id of children) {
        turnInstanceSwitched(id);
        try {
          if (store.getChat(id)) {
            depositHint(id, T`The copy "${name}" in which this run began no longer exists — this chat's next turn works in the main instance (its commits are there under copy/${name}/…, if it was saved).`, { source: SOURCE });
          }
        } catch (e) { console.error(`[stacks] child chat ${id}: notice:`, text(e)); }
      }
      console.log(`[stacks] restart: pin on the copy ${identifier} without a row — ${children.length} child chat(s) back in the main instance`);
    } catch (e) { console.error(`[stacks] restart: pin ${identifier}:`, text(e)); }
  }
}

// A binding (`chats.instance`) to a copy without a live row in its project — the moving out threw while resetting, or
// the server ended between `removed` and it. Without repair the chat would be locked forever; here it goes back to
// main as in the moving out.
function deadBindingsBack(live) {
  const liveness = new Set(live.map(identifierOf));
  for (const b of store.chatInstanceBindings()) {
    let name = null;
    try { name = copyNameOf(b.instance); } catch { name = null; } // a broken column is dead too
    if (name && b.projectId && liveness.has(`${b.projectId}/${copyInstance(name)}`)) continue;
    try {
      chatInstanceSet(b.id, null);
      hint({ projectId: b.projectId, name: name || b.instance }, T`The copy "${name || b.instance}" this chat worked in no longer exists — its next turn works in main (its commits are there under copy/${name || b.instance}/…, if it was saved).`, b.id);
      console.log(`[stacks] restart: chat ${b.id} was bound to ${b.projectId}/${b.instance} without a live copy — back to main`);
    } catch (e) { console.error(`[stacks] restart: binding ${b.id}:`, text(e)); }
  }
}

/** server.js, after the restart (head). Returns how many wake calls were caught up. */
export function copiesWakeRestartGrace() {
  let n = 0;
  const live = store.liveStackCopies();
  for (const k of live) {
    try {
      if (k.state === "ready" && k.inset && !woken(k, "ready")) {
        bindOne(k); // the server ended between transition and wake call — the binding belongs to the moving in (idempotent)
        if (wakeCall(k, "ready")) n += 1;
      }
    } catch (e) { console.error(`[stacks] restart ${identifierOf(k)}: wake call:`, text(e)); }
  }
  try { deadBindingsBack(live); } catch (e) { console.error("[stacks] restart: bindings:", text(e)); }
  try { deadPinsBack(live); } catch (e) { console.error("[stacks] restart: child pins:", text(e)); }
  return n;
}

// Does the copy bind its chat today? The same question as stacks/remove.js copyCarriesBinding (here without import:
// remove.js imports this file).
const carriesBinding = (k) => ["ready", "clearAway"].includes(k.state) || (k.state === "error" && wasReady(k));

/** The one-time migration of the legacy rows (head). */
export function migrateCopiesFree() {
  if (store.getSetting(COPIES_FREE_MARKER, "")) return null;
  const tally = { copies: 0, bound: 0 };
  for (const k of store.liveStackCopies()) {
    if (!k.chatId) continue;
    if (!k.inset) { store.setStackCopyMoveIn(k.id, true); tally.copies += 1; }
    const chat = store.getChat(k.chatId);
    if (!chat || chat.projectId !== k.projectId || chat.instance || !carriesBinding(k)) continue;
    store.updateChat(chat.id, { instance: copyInstance(k.name) }); // without a separator: nothing changes for the chat
    tally.bound += 1;
  }
  store.setSetting(COPIES_FREE_MARKER, new Date().toISOString());
  if (tally.copies || tally.bound) console.log(`[stacks] migration copies_free: ${tally.copies} copy/copies with inset, ${tally.bound} chat(s) bound to their copy`);
  return tally;
}
