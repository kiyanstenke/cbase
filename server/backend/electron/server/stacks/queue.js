// The queue of the copies: waiting, gate, heavy load, start. A request (stacks/state.js copyRequests, `waiting_queue`)
// waits until its project is free, no heavy disk operation runs in the user container and the RAM gate is open, and
// then builds by itself — the oldest first.
//
// THE THREE CONDITIONS (per attempt, in this order; the first one that does not hold is the reason):
//   (1) the project is free: no other copy of the same project in the build (also an orphaned one from the last server
//       run whose dismantling is still pending) and no occupancy on the project (relocation, creation, delete, restore,
//       recreate — projectbox/instance.js occupancyOfProject; without this look the project occupancy below would
//       fail) ⇒ otherwise `waiting_queue` with a reason; likewise as long as the project's main row is not `ready` or
//       not converted (the freeze would otherwise fail at MAIN_NOT_READY, and the copy would go to `error` although the
//       main instance was running again right away). It is woken as soon as the main instance becomes `ready`
//       (wakeMainReady, in server.js on the state wake-up of projectbox/instances.js). Without a main row no waiting
//       (it would never end) — the freeze judges there. On entering this reason a silent notice to the chat, once per
//       reason; if the main instance is in `error`, it names the way out (stacks/state.js mainErrorWay — it does not
//       come back by itself), and the 409 COPY_OCCUPIED of a name it carries says the same.
//       A copy from a copy (`baseInstance` ≠ main) waits for its TEMPLATE instead of the main instance — as long as
//       the template's instance row is not `ready` (woken like the main instance when it becomes so). If the template
//       is gone as a copy, failed or being cleared away, the new one is never created: `error` with a reason and a
//       silent notice (templateGone) instead of waiting forever;
//   (2) the heavy-load lock is free (projectbox/heavyLoad.js: one volume clone or relocation per user container) ⇒
//       otherwise `waiting_queue` with a reason;
//   (3) the storage gate is open (workflows/storage-gate.js storageSituation) ⇒ otherwise `waiting_storage` with the
//       reason of the situation and, on entering, a silent notice to the chat (runs/hints.js).
// Only what changes is reported (the copy event); the reason is in the row.
// BEFORE THAT: if the server ends (runs/server-end.js serverEnds), nothing begins — no build, no dismantling of an
// orphan; the row waits unchanged for the next process (like the relocation tick and the creation).
//
// THE START is ONE synchronous step, without an await in between: occupy the heavy load "copy-clone", project
// occupancy "copy" (withProjectOccupancy), procedure marker (projectbox/instances.js withProcedure, instance
// `copy-<name>`), row `build`/`clone1` — in the SAME step the instance row `copy-<name>` is created in `create`
// (stacks/state.js: `busy`, idle reaper and delete lock see the work already in `clone1`) —, then enter the procedure.
// The start occupies the heavy load itself, not only the procedure: otherwise condition (2) would be just a look, and a
// relocation in between would find it free. The procedure gets `releaseHeavyLoad` and releases after the volume clone;
// at the latest the end of the build releases (idempotent). The project occupancy is held by the WHOLE build
// (createInstance with `build` requires it).
// IF THE SETTER THROWS in the start step (e.g. an instance row `copy-<name>` that already exists — a leftover,
// stacks/state.js INSTANCE_CONFLICT), repeating the start would be an ENDLESS MICROTASK CHAIN (the throw releases the
// heavy load, whose wake-up schedules the next pass, which throws again — no timer, no I/O would get a turn): hence
// `error` with the reason and a silent notice; if that fails too, the queue postpones the row in this process, named
// and counted (postponedStarts), and no longer takes it as a candidate. An OCCUPANCY in between (withProjectOccupancy
// throws) is not an error — the row keeps waiting.
//
// THE PROCEDURE is an injected function (setCopyProcedure; stacks/build.js copyBuild, wired in server.js). WITHOUT a
// procedure the queue starts nothing: no request becomes a build (the candidates are empty). Contract of the procedure:
//     procedure({ copy, instance, journal, releaseHeavyLoad }) → Promise
//       copy              the row in `build`/`clone1` (stacks/state.js); the procedure sets phases via setCopyState
//       instance          `copy-<name>`
//       journal           copyJournal(id) (projectbox/journal.js over the column `journal`)
//       releaseHeavyLoad  releases the heavy load (idempotent; never releases a successor's)
//     It ends in `ready` or `error` (dismantled by itself before, including the instance row). If it ends differently —
//     a throw without a final state, or resolved in `build` —, the queue dismantles itself (the dismantling wiring,
//     still under the occupancy) and sets `error` with a reason and a silent notice. EXCEPT when the server ends: then
//     the copy stays in `build`, and the restart of the next process dismantles (below) — no dismantling next to the
//     stop chain, no race against process.exit.
//
// THE DISMANTLING is the second wiring (setCopyDismantling; stacks/dismantling.js dismantleCopy, in server.js):
//     dismantling({ copy, instance, journal, reason }) → Promise   `reason` "restart" | "procedure-without-end"
//     It removes copy container, network, volume, the layer (root helper) and LAST the instance row — and occupies
//     nothing itself: the queue holds the project occupancy in the build, and after a restart the instance occupancy
//     `copy-dismantling` of the copy (next to the restore of the main instance) and the procedure marker.
//
// AFTER A RESTART (copiesRestartGrace, server.js in the restart-grace timer before the graph starts; no hook):
// `waiting_*` stays; a row in `build` without a live procedure in this process is dismantled and goes back to
// `waiting_queue` — with its old `requested_at`, i.e. its old place — with a silent notice. If the project is occupied
// at the restart, every pass of the queue tries again. The dismantling only begins once the clean-up of the orphaned
// helpers is through (projectbox/helper.js helperCleanedUp — like the relocation): a clone helper of the last server
// run would otherwise still hang on the copy's volume. Until the row waits again, `/api/runs/active` counts it in
// `copiesWaiting` (its instance row no longer works, `busy` is false — without the number the idle reaper would put
// the user container to sleep in the middle of the dismantling). Without a dismantling wiring nothing is safely
// dismantled: `error` with a reason instead of a queue over half leftovers. If the dismantling leaves the instance
// row, likewise `error` (back into the queue is only possible without it — the setter would otherwise take it along
// as a leftover).
//
// WAKING: the queue is the source "copies" (copyCandidates) of the shared arbiter workflows/storage-queue.js
// (registered in server.js next to the source "graph" — per pass at most ONE start out of the storage wait across
// both, the oldest first). It is woken via the wiring setQueueWakeup (server.js: one pass in the next microtask,
// bundled): tick and trigger wake-up (server.js), the heavy load (projectbox/heavyLoad.js setHeavyLoadWakeup — end of
// a relocation or clone), the end of a build (here) and of a clearing away (which calls `wakeQueue`).
//
// `busy`: waiting does not hold it (no instance row); `build` holds it from the first step via the instance row in
// `create`, also while the main instance pauses; in addition the heavy load is listed in `projectWork`
// (runs/routes.js).
//
// JOB TO REMOVE: a waiting row whose journal carries the section `trigger` (stacks/state.js removeJob — written by
// stacks/remove.js before anything takes effect) is not a candidate and never begins; stacks/remove.js sets it to
// `removed`. A build that was already running runs to its end (ready or error), and the end also wakes the removal
// via `wakeQueue` (server.js setQueueWakeup).
//
// Guards: server/backend/test/stacks-queue.test.js (arbiter, one build per project, heavy load, restart),
// server/backend/test/stacks-busy.test.js (`busy` in `clone1` and `freeze`, delete lock);
// server/backend/test/graph-save-gate.test.js.
import * as store from "../store.js";
import { T } from "../i18n.js";
import { MAIN, copyInstance, copyNameOf } from "../projectbox/creation.js";
import { occupancyOfProject, occupancySentence, instanceOccupied, withInstanceOccupancy, withProjectOccupancy } from "../projectbox/instance.js";
import { helperCleanedUp } from "../projectbox/helper.js";
import { procedureAlive, withProcedure } from "../projectbox/instances.js";
import { occupyHeavyLoad, heavyLoadStatus } from "../projectbox/heavyLoad.js";
import { depositHint } from "../runs/hints.js";
import { serverEnds } from "../runs/server-end.js";
import { storageSituation } from "../workflows/storage-gate.js";
import { baseStopped, removeJob, stoppedWay, mainErrorWay, copyJournal, setCopyState } from "./state.js";

const SOURCE = "stack-copy";
const REASON_MAX = 400;

let procedure = null;
let dismantling = null;
let wakeup = null;

/** The build. `null` ⇒ the queue starts nothing. */
export function setCopyProcedure(fn) { procedure = typeof fn === "function" ? fn : null; }
/** The dismantling of a half-built copy including its instance row. `null` ⇒ after a restart `error` is set. */
export function setCopyDismantling(fn) { dismantling = typeof fn === "function" ? fn : null; }
/** How the queue is woken (server.js: one bundled pass of the arbiter). */
export function setQueueWakeup(fn) { wakeup = typeof fn === "function" ? fn : null; }

/**
 * server.js hooks this to the state wake-up of the instances (projectbox/instances.js setStateWakeup, next to
 * wakeProject). If the MAIN instance of a project a copy waits for becomes `ready`, it wakes the queue. Without a
 * waiting copy nothing (no extra pass of the arbiter). Likewise a COPY that a waiting copy names as its template
 * (`baseInstance`) — only those waiting for exactly this instance count.
 */
export function wakeMainReady(projectId, { instance = null, state = null } = {}) {
  if (!instance || state !== "ready") return false;
  const waiting = store.liveStackCopies(projectId).filter((k) => store.STACK_COPY_WAITING.includes(k.state));
  if (!waiting.some((k) => (k.baseInstance || MAIN) === instance)) return false;
  wakeQueue();
  return true;
}

/** Wakes the queue (end of a build here, of a clearing away elsewhere). Without wiring: nothing. */
export function wakeQueue() {
  const w = wakeup;
  if (!w) return;
  try { w(); } catch (e) { console.error("[stacks] waking the queue:", e?.message || e); }
}

// A live build or dismantling in THIS process, per row. The key carries more than the id: tests run several databases
// in the same process, and there the ids each begin at 1.
const runKey = (k) => `${k.id}|${k.projectId}|${k.name}|${k.requestedAt}`;
const running = new Map(); // key → { id, projectId, instance, since }
const dismantlingRunning = new Set(); // key
const pending = new Map(); // key → id: orphaned, occupied at the restart — every pass tries again

/** Is the build of this copy alive in this process? */
export const buildAlive = (k) => Boolean(k) && running.has(runKey(k));

const text = (e) => String(e?.message || e || "unknown").split("\n")[0].slice(0, REASON_MAX);

function hint(k, text) {
  if (!k.chatId) return; // a copy without a chat (a human created it) — the copy event shows the reason
  try { depositHint(k.chatId, text, { source: SOURCE }); }
  catch (e) { console.error(`[stacks] notice ${k.projectId}/${k.name}:`, e?.message || e); }
}

// ── Waiting ──────────────────────────────────────────────────────────────────────────────────────────────────────

// Sets the waiting state — only if state or reason change. On entering the storage wait a silent notice; likewise on
// entering a reason that brings one along (`atEntrance` = the finished text) — once per reason: the same reason in
// the next pass changes nothing and leaves no second one.
function wait(k, state, reason, atEntrance = null) {
  if (k.state === state && k.reason === reason) return null;
  setCopyState(k.id, state, { reason });
  if (state === "waiting_storage" && k.state !== "waiting_storage") {
    hint(k,
      T`Your copy "${k.name}" is ${reason} and then builds by itself — nothing to do.`);
  } else if (atEntrance) hint(k, atEntrance);
  return null;
}

// Condition (1): another copy of the same project in the build, or an occupancy on the project — `{ reason, hint? }` or null.
function projectReason(k) {
  const other = store.liveStackCopies(k.projectId).find((x) => x.id !== k.id && x.state === "build");
  if (other) {
    return { reason: T`waiting for the copy "${other.name}" of the same project (being built) — one at a time per project` };
  }
  const occupied = occupancyOfProject(k.projectId);
  if (occupied) {
    const where = occupied.instance ? ` (Instance ${occupied.instance})` : "";
    return { reason: T`waiting: the project${where} is busy (${occupancySentence(occupied.what)})` };
  }
  // From a template the template counts, not the main instance (it is not frozen).
  if (k.baseInstance && k.baseInstance !== MAIN) {
    const gone = templateGone(k);
    if (gone) return { error: gone };
    const vi = store.projectInstance(k.projectId, k.baseInstance);
    if (vi?.state !== "ready") {
      const like = vi ? vi.state : T("no row");
      const name = copyNameOf(k.baseInstance);
      // A STOPPED template does not come back by itself — the notice names the way out (stacks/state.js stoppedWay)
      // instead of promising "it begins by itself".
      const stopped = baseStopped(k);
      return {
        reason: stopped
          ? T`waiting: template "${name}" not ready (${like}) — it does not start by itself: start it in the "Instances" tab, then the copy starts`
          : T`waiting: template "${name}" not ready (${like}) — the copy starts once it is ready`,
        hint: stopped
          ? T`Your copy "${k.name}" is waiting: its template "${name}" is stopped. ${stoppedWay(k, stopped)}`
          : T`Your copy "${k.name}" is waiting: its template "${name}" is not ready (${like}) — it starts by itself once the template is ready.`,
      };
    }
  }
  // The main instance must be ready and converted. No row ⇒ no waiting (empty here means "never converted").
  const main = k.baseInstance && k.baseInstance !== MAIN ? null : store.projectInstance(k.projectId, MAIN);
  if (main && (main.state !== "ready" || !main.convertedAt)) {
    const like = main.state !== "ready" ? main.state : T("not converted");
    // On entering, a silent notice — a main instance in `error` does not come back by itself: then it names the way out
    // (stacks/state.js mainErrorWay, the same sentence as in the 409 COPY_OCCUPIED of its name). A STOPPED main instance
    // likewise — it is not a transitional state; "nothing to do" would be wrong.
    const stopped = baseStopped(k);
    const hintSet = main.state === "error"
      ? T`Your copy "${k.name}" is waiting. ${mainErrorWay(k)}`
      : stopped
        ? T`Your copy "${k.name}" is waiting. ${stoppedWay(k, stopped)}`
        : T`Your copy "${k.name}" is waiting: the project's main instance is not ready (${like}) — it starts by itself once it is ready; nothing to do.`;
    return {
      reason: stopped
        ? T`waiting: main instance not ready (${like}) — it does not start by itself: start it in the "Instances" tab, then the copy starts`
        : T`waiting: main instance not ready (${like}) — the copy starts once it is ready`,
      hint: hintSet,
    };
  }
  // An OPEN graph worktree of the chat (its run is in the main instance). If the chat moved into the copy now, the rest
  // of the run would work in a folder of the main instance, but its git in the copy (a run never switches mid-run).
  // `active`: the run is alive — a changed worktree left standing after the run does not hold the copy. Also a row
  // whose worktree does not stand yet (earmarked, being created) — it would be created in the main instance while the
  // copy begins.
  const graph = k.chatId ? store.graphWorktreeFor(k.chatId) : null;
  if (graph?.active || (k.chatId && store.graphWorktreeOpenFor(k.chatId))) {
    return { reason: T("waiting for this chat's graph run (its worktree is open) — the copy starts once it is done") };
  }
  return null;
}

// Is the template of a waiting copy from a copy GONE (no live copy of the name, failed, being cleared away)? → the
// reason (the new copy is then never created) or null. An invalid `baseInstance` (never via the request) is gone too.
function templateGone(k) {
  let name;
  try { name = copyNameOf(k.baseInstance); } catch { return T`Template "${String(k.baseInstance).slice(0, 80)}" is not an instance`; }
  const v = store.liveStackCopy(k.projectId, name);
  if (!v) return T`Template "${name}" no longer exists (removed) — without it this copy is never created`;
  if (v.state === "error" || v.state === "clearAway") return T`Template "${name}" is ${v.state === "error" ? "failed" : T("being removed")} — without it this copy is never created`;
  return null;
}

// Condition (2): the heavy load — or null.
function heavyLoadReason() {
  const s = heavyLoadStatus();
  if (!s) return null;
  return T`waiting for a heavy disk operation (${s.kind} for ${s.projectId}/${s.instance}) — one per user container`;
}

// ── Start ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Attempts a start (from a pass of the arbiter). `{ started: true }` or null. */
function attempts(id) {
  const k = store.stackCopy(id);
  if (!k || !store.STACK_COPY_WAITING.includes(k.state) || !procedure) return null;
  // A row with a job to remove never begins — its chat is deleted or archived, or someone cleared it away;
  // stacks/remove.js sets it to `removed` (also after a restart dismantling that handed it back here).
  if (removeJob(k)) return null;
  // In the ending process no build begins — tick and wake-ups run until `server.close`, the stop chain would no longer
  // see the clone helper and the copy container. The row waits unchanged; the next process takes it.
  if (serverEnds()) return null;
  const p = projectReason(k);
  if (p?.error) return templateLost(k, p.error);
  if (p) return wait(k, "waiting_queue", p.reason, p.hint);
  const s = heavyLoadReason();
  if (s) return wait(k, "waiting_queue", s);
  const situation = storageSituation();
  if (!situation.free) return wait(k, "waiting_storage", situation.reason);
  return start(k);
}

function start(k) {
  const pid = k.projectId;
  const instance = copyInstance(k.name);
  const run = procedure;
  const key = runKey(k);
  // The synchronous step (head): no await until runProcedure. withProjectOccupancy, withProcedure and the body run
  // synchronously up to their first await — `begun` says afterwards whether the step went through completely.
  const releaseHeavyLoad = occupyHeavyLoad("copy-clone", { projectId: pid, instance });
  let begun = false;
  let setterWarf = null;
  const run2 = withProjectOccupancy(pid, "copy", () => withProcedure(pid, instance, async () => {
    let row;
    try { row = setCopyState(k.id, "build", { phase: "clone1", reason: "" }); }
    catch (e) { setterWarf = e; throw e; }
    running.set(key, { id: k.id, projectId: pid, instance, since: Date.now() });
    begun = true;
    await runProcedure(run, row, instance, releaseHeavyLoad);
  }));
  if (!begun) {
    // The step did not get through — nothing has begun. An occupancy in between: the row keeps waiting (the next pass
    // tries). If the SETTER threw (e.g. an instance row in conflict), every pass would repeat the same throw — via the
    // wake-up of the heavy load without end: then `error` with a reason.
    releaseHeavyLoad();
    run2.catch((e) => { if (!setterWarf) console.error(`[stacks] start ${pid}/${instance}:`, text(e)); });
    if (setterWarf) startFailed(k, setterWarf);
    return null;
  }
  run2.catch((e) => console.error(`[stacks] build ${pid}/${instance}:`, text(e)))
    .finally(() => {
      running.delete(key);
      releaseHeavyLoad();
      wakeQueue();
    });
  return { started: true };
}

// The template of a waiting copy is gone (templateGone) — `error` with a reason and a silent notice; if setting fails,
// it is logged to the console (the next pass tries again).
function templateLost(k, reason) {
  try { setCopyState(k.id, "error", { error: reason }); } catch (e) {
    console.error(`[stacks] copy ${k.projectId}/${k.name}: error state not set (${reason}): ${text(e)}`);
    return null;
  }
  hint(k, T`Your copy "${k.name}" will not be built: its template is gone (${reason}).`);
  return null;
}

// The setter of the start step threw (head of `start`): the row goes to `error` with a reason and a silent notice. If
// that fails too, the queue postpones it in THIS process — named (logged once, with the reason) and counted
// (postponedStarts), and copyCandidates no longer takes it: never one pass after another against the same throw.
const postponed = new Map(); // key → { id, projectId, name, reason }
/** Test seam and insight: the starts the queue has postponed in this process (see startFailed). */
export const postponedStarts = () => [...postponed.values()];
function startFailed(k, e) {
  const code = typeof e?.code === "string" && /^[A-Z][A-Z0-9_]*$/.test(e.code) ? ` (${e.code})` : "";
  const reason = T`Start failed: ${text(e)}${code}`;
  try {
    setCopyState(k.id, "error", { error: reason });
  } catch (x) {
    postponed.set(runKey(k), { id: k.id, projectId: k.projectId, name: k.name, reason: `${reason} — error state not set: ${text(x)}` });
    console.error(`[stacks] start ${k.projectId}/${k.name} postponed (${postponed.size} in this process): ${reason} — error state not set: ${text(x)}`);
    return;
  }
  hint(k, T`Your copy "${k.name}" was not built: ${reason}.`);
}

// Runs the procedure — STILL under project occupancy and procedure marker. If it ends without a final state, the queue dismantles.
async function runProcedure(run, row, instance, releaseHeavyLoad) {
  let thrown = null;
  try {
    await run({ copy: row, instance, journal: copyJournal(row.id), releaseHeavyLoad });
  } catch (e) { thrown = e; }
  const now = store.stackCopy(row.id);
  if (!now || now.state !== "build") {
    if (thrown) console.error(`[stacks] build ${now?.projectId || row.projectId}/${instance} threw after its final state:`, text(thrown));
    return;
  }
  // If the process ends, the build leaves the copy in `build` (stacks/build.js) — no dismantling next to the stop
  // chain, no `error`: the restart of the next process dismantles and puts it back in its old place
  // (copiesRestartGrace). The safety net would otherwise strike here and decide the race against process.exit.
  if (serverEnds()) {
    console.log(`[stacks] build ${now.projectId}/${instance} ends with the server (phase "${now.phase}") — the restart dismantles`);
    return;
  }
  const reason = thrown ? T`Build failed (phase "${now.phase}"): ${text(thrown)}` : T`Build ended without a result (phase "${now.phase}")`;
  let rest = "";
  if (dismantling) {
    try { await dismantling({ copy: now, instance, journal: copyJournal(now.id), reason: "procedure-without-end" }); }
    catch (e) { rest = T` — dismantling failed: ${text(e)}`; }
  } else rest = T(" — no dismantling wired, leftovers stay");
  try { setCopyState(now.id, "error", { error: `${reason}${rest}`.slice(0, REASON_MAX * 2) }); }
  catch (e) { console.error(`[stacks] build ${now.projectId}/${instance}: error state not set:`, text(e)); }
  hint(now, T`Your copy "${now.name}" was not built: ${reason}${rest}.`);
}

// ── Candidates for the arbiter ────────────────────────────────────────────────────────────────────────────────────

/**
 * The source "copies" of the arbiter (workflows/storage-queue.js, registered in server.js): every waiting request, waitingSince =
 * `requested_at`, `storage` = is now in `waiting_storage`. Before that the orphaned builds whose dismantling hung on an
 * occupancy at the restart (retry). Empty without a procedure wiring.
 */
export function copyCandidates() {
  for (const [key, id] of [...pending]) {
    const k = store.stackCopy(id);
    if (!k || runKey(k) !== key || k.state !== "build") { pending.delete(key); continue; }
    backInTheQueue(k);
  }
  if (!procedure) return [];
  return store.stackCopiesInState(store.STACK_COPY_WAITING).filter((k) => !postponed.has(runKey(k)) && !removeJob(k)).map((k) => ({
    waitingSince: k.requestedAt,
    storage: k.state === "waiting_storage",
    attempts: () => attempts(k.id),
  }));
}

// ── After a restart ──────────────────────────────────────────────────────────────────────────────────────────────

const orphaned = (k) => !running.has(runKey(k)) && !procedureAlive(k.projectId, copyInstance(k.name));

/**
 * After the restart (server.js, restart-grace timer, BEFORE the graph starts): dismantle orphaned builds and put them
 * back into the queue. Does not wake itself — the waiting requests are taken by the pass at the end of the graph
 * starts' restart handling (ONE pass for graph starts and copies); a dismantled build wakes at the end of its
 * dismantling. Returns the number of dismantlings kicked off or earmarked (for tests).
 */
export function copiesRestartGrace() {
  let n = 0;
  for (const k of store.stackCopiesInState(["build"])) {
    try { if (orphaned(k)) { backInTheQueue(k); n += 1; } }
    catch (e) { console.error(`[stacks] restart ${k.projectId}/${k.name}:`, text(e)); }
  }
  return n;
}

function backInTheQueue(k) {
  const pid = k.projectId;
  const instance = copyInstance(k.name);
  const key = runKey(k);
  if (dismantlingRunning.has(key) || !orphaned(k)) return;
  // In the ending process no dismantling begins either — earmarked, the next restart takes it.
  if (serverEnds()) { pending.set(key, k.id); return; }
  const where = T`Server restart in the middle of the build (phase "${k.phase}")`;
  if (!dismantling) {
    pending.delete(key);
    setCopyState(k.id, "error", { error: T`${where} — no dismantling wired, the leftovers are not dismantled` });
    hint(k, T`Your copy "${k.name}" was not built: the server restarted mid-build (phase "${k.phase}"); it was not rolled back.`);
    return;
  }
  // The instance occupancy of the copy: next to the restore of the main instance, but never next to a relocation,
  // delete or build of the same project. Occupied ⇒ the next pass tries once more.
  if (projectOccupiedFor(pid, instance)) { pending.set(key, k.id); return; }
  pending.delete(key);
  dismantlingRunning.add(key);
  const build = dismantling;
  let begun = false;
  withInstanceOccupancy(pid, instance, "copy-dismantling", () => withProcedure(pid, instance, async () => {
    begun = true;
    // First await the clean-up of the orphaned helpers (projectbox/helper.js, asynchronous) — like the relocation. A
    // clone helper of the last server run still hangs on the copy's volume ("volume is in use"), and two `rm -f` on
    // the same helper id would otherwise run against each other. The occupancy already stands (synchronously above): a
    // relocation or delete in between finds it occupied.
    await helperCleanedUp();
    await build({ copy: k, instance, journal: copyJournal(k.id), reason: "restart" });
    const now = store.stackCopy(k.id);
    if (!now || now.state !== "build") return;
    if (store.projectInstance(pid, instance)) throw new Error(T("the dismantling left the instance row standing"));
    setCopyState(k.id, "waiting_queue", { reason: T`server restart mid-build (phase "${k.phase}") — rolled back, queued again (same place)` });
    hint(k, T`Your copy "${k.name}": the server restarted mid-build (phase "${k.phase}"). It was rolled back and is queued again at its old place; it builds by itself.`);
  })).catch((e) => {
    if (!begun) { pending.set(key, k.id); return; } // occupied between look and occupancy: next pass
    const now = store.stackCopy(k.id);
    try { if (now?.state === "build") setCopyState(k.id, "error", { error: T`${where} — dismantling failed: ${text(e)}` }); }
    catch (x) { console.error(`[stacks] restart ${pid}/${instance}: error state not set:`, text(x)); }
    hint(k, T`Your copy "${k.name}" was not built: the server restarted mid-build (phase "${k.phase}"); rolling back failed (${text(e)}).`);
  }).finally(() => {
    dismantlingRunning.delete(key);
    wakeQueue();
  });
}

// Is the project occupied for the dismantling? The project occupancy (relocation, delete, another build) or an
// occupancy of THIS instance — not that of the main instance.
const projectOccupiedFor = (pid, instance) => {
  const b = occupancyOfProject(pid);
  if (b && b.instance === null) return true;
  return Boolean(instanceOccupied(pid, instance));
};
