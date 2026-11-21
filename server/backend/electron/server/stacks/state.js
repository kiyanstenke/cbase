// The setter of a copy's state. The data layer is store/stack-copies.js; the pattern is projectbox/instances.js
// `setInstanceState` — whoever changes the state of a copy goes through THIS file.
//
// copyRequests({ projectId, name, chatId = null, inset = Boolean(chatId), baseInstance = "main", base, reason, state = "waiting_queue" })
//     creates the row (only in a waiting state — `build` begins via the transition below) and reports it. The name must
//     have the form (stacks/names.js `nameError`, otherwise TypeError); a live name of the same project throws
//     `CopyError` with `code: "COPY_OCCUPIED"`, 409 (the partial index) — the sentence says what is up with the carrier
//     of the name (`occupiedWhatToDo`). `chatId` is optional (the chat that creates it), `inset` says whether it moves in
//     at `ready` (default: exactly when a chat creates it; a human without a chat never sets it). A failed copy stays
//     until it is cleared away (its name becomes free once it is `removed`); a new attempt is another copy under a
//     free name.
// setCopyState(id, state, { phase, reason, error, base, result })
//     THE way to set the state. Checks the transition (TRANSITIONS; the same state with another phase is always
//     allowed) and the phase BEFORE anything is written; every state except `error` clears the error (like
//     setInstanceState). On every change of state, phase or error it writes the event
//     `{ type: "project/copy", id, projectId, name, chatId, state, phase, error }` to the global stream — only
//     identifiers and words, never a value. And in the SAME synchronous step it keeps the instance row `copy-<name>` in
//     `project_instances` in line (via projectbox/instances.js — `busy`, idle reaper and delete lock read only it):
//       waiting_* → build        the instance row is created in `create`, with the copy's phase, `chat_id` and
//                                `copy_name` — so already in `clone1` and in the pause something is working. If a row
//                                is already there, it is a leftover: `CopyError` INSTANCE_CONFLICT (409), nothing taken
//                                over;
//       build, new phase         the phase moves along (the sub-phases of the creation are set by createInstance);
//       → ready                  the instance row becomes `ready` with `converted_at` — restore and server end then
//                                carry the copy without a special path; ONE UPDATE conditioned on `create` (if it
//                                stands differently, it throws, and the copy stays as it was);
//       clearAway                only from the start of the phase `fetch` is the instance row in `clearAway` (with the
//                                phase); `earmarked` exists only here;
//       → error, → waiting_*     a WORKING instance row (create, clearAway) becomes `error` with the reason — `busy`
//                                drops; the dismantling (container, network, row) is done by the procedure;
//       → removed                only if there is no instance row anymore (the clear-away path removes it first) —
//                                otherwise the setter throws without writing anything.
//     If the instance row fails, the setter takes the copy's row back (state, phase, reason, error and any passed
//     base/result) and throws.
// copyJournal(id)
//     the copy's journal via the leaf projectbox/journal.js (`createJournal`, one mechanism for relocation and copy);
//     the storage is the column `journal` (store/stack-copies.js).
// After every change of state the setter calls stacks/inset.js copyTransition (moving in at `ready`, moving out at
//     `removed`, the wake call at `ready` and at `error` of the build). The fourth argument `{ returnPathAtServerEnd }`:
//     ONLY the setter after which a return path into the queue can follow at server end (stacks/freeze.js — the build
//     then puts back or wakes, build.js backAfterServerEnd) holds the error wake call; every other `error` wakes at
//     server end too (queued, the next process delivers).
// removeJob(copy)
//     the job to remove (journal section `trigger`, written by stacks/remove.js) or null. Here because the queue
//     (stacks/queue.js) must read it and stacks/remove.js imports the queue (no cycle): a row with a job never starts
//     (the build would otherwise wake a deleted or archived chat).
import * as store from "../store.js";
import { T } from "../i18n.js";
import { MAIN, copyInstance } from "../projectbox/creation.js";
import { setInstanceState } from "../projectbox/instances.js";
import { createJournal } from "../projectbox/journal.js";
import { broadcast } from "../runtime/sse.js";
import { copyTransition, newAttemptSet } from "./inset.js";
import { nameError } from "./names.js";

export class CopyError extends Error {
  constructor(message, { code, status = 409, rootCause = null } = {}) {
    super(message);
    this.name = "CopyError";
    this.code = code;
    this.status = status;
    if (rootCause) this.cause = rootCause;
  }
}

/** The allowed transitions (the same state with another phase is always allowed; `removed` is the end). */
export const TRANSITIONS = Object.freeze({
  waiting_queue: Object.freeze(["waiting_storage", "build", "error", "removed"]),
  waiting_storage: Object.freeze(["waiting_queue", "build", "error", "removed"]),
  build: Object.freeze(["ready", "error", "waiting_queue"]), // a restart in the middle of the build ⇒ back into the queue
  ready: Object.freeze(["clearAway", "error"]),
  clearAway: Object.freeze(["removed", "error"]),
  error: Object.freeze(["clearAway", "removed", "waiting_queue"]),
  removed: Object.freeze([]),
});
const INSTANCE_WORKING = ["create", "clearAway"];

function report(k) {
  broadcast({ type: "project/copy", id: k.id, projectId: k.projectId, name: k.name, chatId: k.chatId, state: k.state, phase: k.phase, error: k.error });
}

/**
 * The second part of the 409 COPY_OCCUPIED (head): what is up with the live copy `k` that carries the name. Only words,
 * identifiers and tool names.
 */
export function occupiedWhatToDo(k) {
  switch (k.state) {
    case "error": return newAttemptSet(k);
    case "ready": return T`It is ready; its name becomes free once it is removed (cbase_copy_stack_remove with name "${k.name}") — without name cbase picks a free one.`;
    case "clearAway": return k.phase === "earmarked"
      ? T("It is marked for removal and is removed as soon as nothing runs in it anymore — afterwards its name is free; without name cbase picks a free one right away.")
      : T("It is being removed; the result comes as a system message — afterwards its name is free; without name cbase picks a free one right away.");
    case "build": return T("It is being built — cbase wakes the chat that created it at \"ready\" or, if the build fails, with the reason; without name cbase picks a free one.");
    default: {
      // Waiting, the sentence names the reason — and, if the main instance is in `error`, the way out (otherwise the chat
      // would wait for a wake call that never comes by itself).
      const reason = k.reason ? ` (${k.reason})` : "";
      if (mainInError(k)) return T`It is waiting for its build${reason}. ${mainErrorWay(k)}`;
      const stopped = baseStopped(k);
      if (stopped) return T`It is waiting for its build${reason}. ${stoppedWay(k, stopped)}`;
      return T`It is waiting for its build${reason} — cbase wakes the chat that created it at "ready" or, if the build fails, with the reason; without name cbase picks a free one.`;
    }
  }
}

/** Is the main instance of the copy's project in `error`? (A copy then waits in `waiting_queue`.) */
export const mainInError = (k) => store.projectInstance(k.projectId, MAIN)?.state === "error";

/**
 * The way out when the main instance is in `error` — ONE sentence for the silent notice of the queue (stacks/queue.js)
 * and the 409 COPY_OCCUPIED (occupiedWhatToDo). A main instance in `error` does not come back by itself: only a turn of
 * a chat in the project retries it (projectbox/recreate.js, after the check interval). Only words, name and tool names.
 */
export function mainErrorWay(k) {
  return T`The project's main instance is in "error" and does not come back by itself: the next turn of a chat in this project retries it (after the check interval), then the copy starts by itself — or withdraw the request with cbase_copy_stack_remove (name "${k.name}").`;
}

/**
 * Is the instance this copy is created from (main, for a copy from a copy its template) STOPPED (or just stopping)? →
 * its name or null. `stopped` is not a transitional state: only "Start" or a turn in it brings it back — a waiting copy
 * would otherwise wait forever.
 */
export function baseStopped(k) {
  const instance = k?.baseInstance && k.baseInstance !== MAIN ? String(k.baseInstance) : MAIN;
  const z = store.projectInstance(k.projectId, instance)?.state;
  return z === "stopped" || z === "stop" ? instance : null;
}

/** The way out when the base is stopped — the same sentence for the silent notice of the queue and the 409. */
export function stoppedWay(k, instance) {
  return T`The instance ${instance} of the project is stopped (by hand) and does not start by itself: start it in the project's "Instances" tab (or the next turn of a chat working in ${instance} starts it), then the copy starts by itself — or withdraw the request with cbase_copy_stack_remove (name "${k.name}").`;
}

export function copyRequests({ projectId, name, chatId = null, inset = Boolean(chatId), baseInstance = "main", base = null, reason = "", state = "waiting_queue" } = {}) {
  const f = nameError(name);
  if (f) throw new TypeError(`copy: ${f}`);
  if (!store.STACK_COPY_WAITING.includes(state)) throw new TypeError(`copy: a request begins waiting (${store.STACK_COPY_WAITING.join(", ")}), not in "${state}"`);
  // As long as a layout job is open (waiting, running, failed after the point of no return), no copy is created — it
  // would clone a tree that is about to be rebuilt.
  if (projectId && store.layoutOpen(projectId)) {
    throw new CopyError(T("The project structure is being applied or waiting to be — a copy only afterwards."), { code: "REBUILD_OPEN", status: 409 });
  }
  let fresh;
  try {
    fresh = store.createStackCopy({ projectId, name, chatId: chatId || null, inset, baseInstance, base, state, reason });
  } catch (e) {
    if (!store.isUniqueViolation(e)) throw e;
    const carrier = store.liveStackCopy(projectId, name);
    throw new CopyError(T`In project ${projectId} a copy "${name}" already lives${carrier ? ` (${carrier.state})` : ""} — one name per project.${carrier ? ` ${occupiedWhatToDo(carrier)}` : ""}`,
      { code: "COPY_OCCUPIED", status: 409, rootCause: e });
  }
  report(fresh);
  return fresh;
}

function checkTransition(prior, state, phase) {
  if (!store.STACK_COPY_STATES.includes(state)) throw new TypeError(`copy: unknown state "${state}"`);
  if (state !== prior.state && !TRANSITIONS[prior.state]?.includes(state)) {
    throw new TypeError(`copy ${prior.projectId}/${copyInstance(prior.name)}: no transition "${prior.state}" → "${state}" (${(TRANSITIONS[prior.state] || []).join(", ") || "none"})`);
  }
  const phases = store.STACK_COPY_PHASES[state];
  if (phases ? !phases.includes(phase) : phase) throw new TypeError(`copy: "${phase}" is not a phase of "${state}"${phases ? ` (${phases.join(", ")})` : ""}`);
}

// Keeps the instance row in line (head). Throws if it is missing where it must exist.
function coupleInstance(prior, after) {
  const pid = after.projectId;
  const instance = copyInstance(after.name);
  const inst = store.projectInstance(pid, instance);
  const changeover = after.state !== prior.state || after.phase !== prior.phase;
  if (!changeover) return;
  switch (after.state) {
    case "build":
      // Entering the build never takes over an existing row — it is a leftover (a dismantling that left it, a row made
      // by hand), and its container or network would not belong to this build. The throw takes the copy back (below);
      // the queue then sets it to `error` with the reason (stacks/queue.js).
      if (prior.state !== "build" && inst) {
        throw new CopyError(T`Instance ${pid}/${instance} already exists ("${inst.state}") — a leftover, not of this build; clear it away first`, { code: "INSTANCE_CONFLICT", status: 409 });
      }
      setInstanceState(pid, instance, "create", { phase: after.phase, chatId: after.chatId, copyName: after.name });
      return;
    case "ready":
      if (!inst) throw new Error(`instance ${pid}/${instance} is missing — a copy only becomes ready with its instance row`);
      // ONE UPDATE conditioned on the prior state — `ready` with `converted_at` only from `create`.
      setInstanceState(pid, instance, "ready", { phase: "", convertedAt: Date.now(), ifState: "create" });
      return;
    case "clearAway":
      if (after.phase === "earmarked") return; // only in stack_copies
      if (!inst) throw new Error(`instance ${pid}/${instance} is missing — the clearing away fetches and backs up from it`);
      setInstanceState(pid, instance, "clearAway", { phase: after.phase });
      return;
    case "removed":
      return; // checked before writing (no instance row anymore)
    default: // error, waiting_*
      // Coming from a waiting state, an instance row never belongs to this copy (it is only created with `build`) — a
      // leftover the start failed on (INSTANCE_CONFLICT) stays as it is.
      if (inst && INSTANCE_WORKING.includes(inst.state) && !store.STACK_COPY_WAITING.includes(prior.state)) {
        setInstanceState(pid, instance, "error", { error: after.error || after.reason || `copy ${after.state}` });
      }
  }
}

export function setCopyState(id, state, fields = {}, { returnPathAtServerEnd = false } = {}) {
  const prior = store.stackCopy(id);
  if (!prior) throw new Error(`copy ${id}: no row`);
  const phase = fields.phase !== undefined ? String(fields.phase) : (state === prior.state ? prior.phase : "");
  checkTransition(prior, state, phase);
  if (state === "removed" && prior.state !== "removed" && store.projectInstance(prior.projectId, copyInstance(prior.name))) {
    throw new TypeError(`copy ${prior.projectId}/${copyInstance(prior.name)}: removed only without an instance row — the clear-away path removes it first`);
  }
  // Like setInstanceState: every state except `error` clears the error if none is given (a new attempt from `error`
  // would otherwise carry the old reason on).
  const f = { ...fields };
  if (state !== "error" && f.error === undefined) f.error = "";
  const { after } = store.changeStackCopy(id, { ...f, state, phase });
  try {
    coupleInstance(prior, after);
  } catch (e) {
    // Back as it was — the copy would otherwise be in a state the instance row does not carry.
    const old = { state: prior.state, phase: prior.phase, reason: prior.reason, error: prior.error };
    if (f.base !== undefined) old.base = prior.base;
    if (f.result !== undefined) old.result = prior.result;
    try { store.changeStackCopy(id, old); }
    catch (x) { console.error(`[stacks] copy ${id}: taking back failed: ${x?.message || x}`); }
    throw e;
  }
  if (after.state !== prior.state || after.phase !== prior.phase || after.error !== prior.error) report(after);
  copyTransition(prior, after, { returnPathAtServerEnd }); // moving in (wake call, terminal), moving out (child chats back) — catches every throw
  return after;
}

/** The job to remove a copy (head) — the journal section `trigger` or null. */
export function removeJob(k) {
  const a = k?.journal?.data?.trigger;
  return a && typeof a === "object" && !Array.isArray(a) ? a : null;
}

export const copyJournal = (id) => createJournal({
  read: () => store.stackCopyJournalStatus(id),
  write: (f) => store.writeStackCopyJournal(id, f),
});
