// The setter of the instance state and the restart grace. The data layer is store/project-instances.js.
//
// Three things live here, because store/ is domain-free and knows no stream:
//   setInstanceState(projectId, instance, state, fields)
//       THE way to set a state: creates the row if missing, changes it otherwise, and on every change of state, phase or error
//       writes the event `{ type: "project/instance", projectId, instance, state, phase, error }` to the global stream. A change
//       only to other fields (network, `target`, …) is no change. A state other than `error` clears the error text when the caller
//       gives none (an old reason would otherwise sit next to "ready").
//       When the state changes into a NON-working one (`ready`, `error`), it then calls the state wakeup (`setStateWakeup`, set in
//       server.js to projectbox/idle.js `wakeProject`) — the waiting turns and workflow agents of the project begin, or visibly end
//       on `error`. As a microtask: the caller (creation, relocation, restart grace) has finished writing its step before a run
//       begins. A setter instead of an import keeps this module a leaf of the data side.
//   withProcedure(projectId, instance, fn)
//       A LIVING procedure of this instance in this process (creation, start, recreation, relocation): while `fn` runs, the
//       instance counts as being worked on. Counted, not a set — two overlapping procedures would otherwise end each other's mark.
//       Bookkeeping only; whether two procedures may overlap at all is the per-project lock.
//   instancesRestartGrace()
//       Consumer of the hook "restart grace" (registered in server.js): a row in `create`, `start` or `recreate` WITHOUT a living
//       procedure is a leftover of the last server run — it becomes `error` with a reason, and `busy` falls. No working state holds
//       `busy` across a restart. `relocation` stays: the relocation journal decides it. A row in `stop` WITHOUT a living procedure
//       (the server ended in the middle of a human's stop) becomes `stopped` — the intent was the stop, and the server-end stop
//       chain has halted the container anyway. If it came up again after a hard end of B, the observer's reconciliation stops it
//       again (projectbox/resumption.js → instance-stop.js keepTrackOfStopped); never a silent `ready`.
//   setRelocationDecider(fn)
//       The hook for the relocation decider (projectbox/journal.js `decide`: backwards before the turning point, forwards after it).
//       `instancesRestartGrace` hands it EVERY half relocation without a living procedure — an instance in state `relocation` OR an
//       open journal in `project_relocations` (also one from the steps before creation, when there was no instance row yet) — as
//       `{ projectId, instance, row, journal }` (null where there is none), synchronously and BEFORE the rule "working without a
//       procedure becomes error": an instance with an open journal (say `create` in step 3) belongs to the decider, not to this
//       rule. It should enter its procedure synchronously (`withProcedure`); a promise is not awaited. WITHOUT a decider the row
//       stays and holds `busy` — a half relocation is no `error` that a restart forgives — and the log says nobody decides.
//   The SECOND WAY: a rejection of the decider (or of a later resume) is not only in console.error. `relocationResumeFailed`
//       remembers the reason (`relocationResumeError` reads it, GET …/relocation shows it) and puts a row still in `relocation` on
//       the phase `hold-resume` with reason and way out (`relocationWayOut`: POST …/relocation/resume, else the next start of B) —
//       the row keeps holding `busy`, but named. A row in another state (say `ready` after the turning point) stays.
//   Who is already DECIDED (`relocationDecided`, `relocationElsewhere`): an open journal of ANOTHER project holds back a new
//       relocation (`POST …/relocation` 409 RELOCATION_ELSEWHERE) while its procedure lives (it needs the heavy load) or while it is
//       not yet decided in THIS process (it comes from the previous server run and the restart grace has not taken it over — a new
//       relocation would grab the heavy load, and the decider would find it occupied). Decided is a journal that the restart grace
//       handed over or that a procedure of this process created or resumed. After that an open journal left standing (with a reason)
//       does NOT hold back another project's relocation — the promise of store/project-relocations.js ("never lock forever") holds.
import * as store from "../store.js";
import { broadcast } from "../runtime/sse.js";
import { T } from "../i18n.js";

const procedures = new Map(); // "<projectId>/<instance>" → number of living procedures

export const procedureAlive = (projectId, instance = "main") => (procedures.get(store.instanceIdentifier(projectId, instance)) || 0) > 0;

export async function withProcedure(projectId, instance, fn) {
  const k = store.instanceIdentifier(projectId, instance || "main");
  procedures.set(k, (procedures.get(k) || 0) + 1);
  try {
    return await fn();
  } finally {
    const n = (procedures.get(k) || 1) - 1;
    if (n > 0) procedures.set(k, n); else procedures.delete(k);
  }
}

let stateWakeup = null;
export function setStateWakeup(fn) {
  stateWakeup = typeof fn === "function" ? fn : null;
}
function wake(row, priorState) {
  if (!stateWakeup || !row || row.state === priorState) return;
  if (store.PROJECT_WORK_STATES.includes(row.state)) return;
  const w = stateWakeup;
  queueMicrotask(() => {
    try { w(row.projectId, { instance: row.instance, state: row.state, prior: priorState ?? null }); }
    catch (e) { console.error(`[projectbox] wakeup ${row.identifier}:`, e?.message || e); }
  });
}

function report(row) {
  broadcast({ type: "project/instance", projectId: row.projectId, instance: row.instance, state: row.state, phase: row.phase, error: row.error });
}

/**
 * Sets the state (create or change) and reports a change. Returns the row afterwards.
 * `fields.ifState`: only from this prior state — the condition sits in the UPDATE (store/project-instances.js); if the row is
 * missing or stands otherwise, the setter THROWS (`code: "INSTANCE_STATE"`) without creating or reporting anything.
 */
export function setInstanceState(projectId, instance, state, fields = {}) {
  const inst = instance || "main";
  const f = { ...fields };
  if (state !== "error" && f.error === undefined) f.error = "";
  const prior = store.projectInstance(projectId, inst);
  const conditional = f.ifState !== undefined;
  const notApplied = (actual) => Object.assign(new Error(`Instance ${store.instanceIdentifier(projectId, inst)}: “${state}” only from “${f.ifState}” — the row ${actual ? `is in “${actual}”` : "does not exist"}, nothing changed`), { code: "INSTANCE_STATE" });
  if (!prior) {
    if (conditional) throw notApplied(null);
    const fresh = store.createProjectInstance({ ...f, projectId, instance: inst, state });
    report(fresh);
    wake(fresh, null);
    return fresh;
  }
  const { after, applied } = store.changeProjectInstance(projectId, inst, { ...f, state });
  if (conditional && !applied) throw notApplied(after?.state ?? null);
  if (after && (after.state !== prior.state || after.phase !== prior.phase || after.error !== prior.error)) report(after);
  wake(after, prior.state);
  return after;
}

// The states the restart grace sets to `error` without a procedure — not `relocation`.
const WITHOUT_PROCEDURE_ERROR = ["create", "start", "recreate"];

let relocationDecider = null;
export function setRelocationDecider(fn) {
  relocationDecider = typeof fn === "function" ? fn : null;
}

// ── Decided, way out, second way (see header) ───────────────────────────────────────────────────────────────────────
const decided = new Set(); // identifiers (id and location) of open relocation journals decided in THIS process
// Id, location AND creation time: an id alone would keep a mark across a change of database (tests open a new one per server, and
// the ids start at 1 again there).
const journalIdentifier = (j) => `${Number(j.id)}|${j.location || ""}|${Number(j.startedAt) || 0}`;
const resumeError = new Map(); // identifier → { text, at }

/** The way out of a held relocation — ONE wording for row, journal and response. */
export const relocationWayOut = (projectId) =>
  T`continue with POST /api/projects/${projectId}/relocation/resume once the cause is fixed (otherwise at the next start of the server)`;

/** A procedure of this process created or took over the journal (restart grace, resume): it is decided. */
export function relocationDecided(relocationId, projectId = null, instance = "main") {
  const j = relocationId !== null && relocationId !== undefined ? store.readRelocation(relocationId) : null;
  if (j) decided.add(journalIdentifier(j));
  if (projectId) resumeError.delete(store.instanceIdentifier(String(projectId), instance || "main"));
}

/** An open journal of ANOTHER project that holds back a new relocation (see header), or null. */
export function relocationElsewhere(projectId) {
  for (const j of store.openRelocations()) {
    if (String(j.projectId) === String(projectId)) continue;
    const fields = { projectId: j.projectId, instance: j.instance, relocationId: j.id, step: j.step || null, direction: j.direction };
    if (procedureAlive(j.projectId, j.instance)) return { ...fields, reason: "running" };
    if (!decided.has(journalIdentifier(j))) return { ...fields, reason: "restart-grace-pending" };
  }
  return null;
}

/** The message for `relocationElsewhere` — ONE wording for route and procedure. */
export const relocationElsewhereText = (a) => (a?.reason === "running"
  ? T`A relocation is running for project ${a.projectId} (step “${a.step || "—"}”) — at most one per user container; then try again`
  : T`Project ${a?.projectId} has a half relocation from the last server run (step “${a?.step || "—"}”) that the restart grace has not yet decided — it needs the heavy load first; ${relocationWayOut(a?.projectId)}`);

/** The remembered reason why resuming a half relocation failed (or null). */
export const relocationResumeError = (projectId, instance = "main") =>
  resumeError.get(store.instanceIdentifier(String(projectId), instance || "main")) || null;

/** The second way: remember the reason and put a row in `relocation` on `hold-resume` (see header). Never throws. */
export function relocationResumeFailed(projectId, instance, error) {
  const inst = instance || "main";
  const text = String(error?.message || error || "unknown").split("\n")[0].slice(0, 400);
  try {
    resumeError.set(store.instanceIdentifier(String(projectId), inst), { text, at: Date.now() });
    const z = store.projectInstance(String(projectId), inst);
    if (z?.state === "relocation") {
      setInstanceState(String(projectId), inst, "relocation", { phase: "hold-resume", error: T`Relocation not resumed: ${text} — ${relocationWayOut(projectId)}` });
    }
  } catch (e) { console.error(`[projectbox] relocation ${projectId}/${inst}: reason not remembered:`, e?.message || e); }
}

// The half relocations without a living procedure — instances in `relocation` and open journals, once per identifier.
function halfRelocations() {
  const byKey = new Map();
  for (const z of store.projectInstancesInState(["relocation"])) byKey.set(z.identifier, { projectId: z.projectId, instance: z.instance, row: z, journal: null });
  for (const j of store.openRelocations()) {
    const k = store.instanceIdentifier(j.projectId, j.instance);
    const e = byKey.get(k) || { projectId: j.projectId, instance: j.instance, row: store.projectInstance(j.projectId, j.instance), journal: null };
    e.journal = j;
    byKey.set(k, e);
  }
  return [...byKey.values()].filter((e) => !procedureAlive(e.projectId, e.instance));
}

function decideRelocations() {
  const half = halfRelocations();
  if (!half.length) return new Set();
  if (!relocationDecider) {
    console.error(`[projectbox] restart grace: ${half.length} half relocation(s) without a decider (${half.map((e) => store.instanceIdentifier(e.projectId, e.instance)).join(", ")}) — stays and holds busy`);
    return new Set(half.map((e) => store.instanceIdentifier(e.projectId, e.instance)));
  }
  const w = relocationDecider;
  for (const e of half) {
    if (e.journal) relocationDecided(e.journal.id);
    const failed = (x) => {
      console.error(`[projectbox] relocation decider ${e.projectId}/${e.instance}:`, x?.message || x);
      relocationResumeFailed(e.projectId, e.instance, x);
    };
    try {
      const r = w(e);
      if (r && typeof r.then === "function") r.catch(failed);
    } catch (x) { failed(x); }
  }
  return new Set(half.map((e) => store.instanceIdentifier(e.projectId, e.instance)));
}

export function instancesRestartGrace() {
  let relocationIdentifiers = new Set();
  try { relocationIdentifiers = decideRelocations(); } catch (e) { console.error("[projectbox] restart grace of the relocations:", e?.message || e); }
  // An interrupted stop ends `stopped` (see header).
  for (const z of store.projectInstancesInState(["stop"])) {
    if (procedureAlive(z.projectId, z.instance)) continue;
    console.log(`[projectbox] restart grace ${z.identifier}: the stop was interrupted by the restart — stopped (the reconciliation halts the container if it runs)`);
    try { setInstanceState(z.projectId, z.instance, "stopped", { phase: "" }); }
    catch (e) { console.error(`[projectbox] restart grace ${z.identifier}:`, e?.message || e); }
  }
  for (const z of store.projectInstancesInState(WITHOUT_PROCEDURE_ERROR)) {
    if (procedureAlive(z.projectId, z.instance)) continue;
    if (relocationIdentifiers.has(z.identifier)) continue; // belongs to the relocation journal
    const reason = T`Server restarted during “${z.state}”${z.phase ? T` (phase “${z.phase}”)` : ""} — the procedure is no longer alive`;
    try { setInstanceState(z.projectId, z.instance, "error", { error: reason }); }
    catch (e) { console.error(`[projectbox] restart grace ${z.identifier}:`, e?.message || e); }
  }
}
