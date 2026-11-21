// The journal of an unsecured multi-step procedure. A LEAF: only node:fs and node:path, no store, no docker — the caller hands in the
// storage (relocation: table `project_relocations`, store/project-relocations.js; copy: `stack_copies.journal`). There is ONE journal
// mechanism, not one per procedure.
//
// Three rules:
//   1. Write BEFORE the effect. `journal.step(name, effect)` writes the step as announced, THEN the effect runs, THEN it stands as
//      done. If the process dies in between, the journal knows every step that may already have taken effect — the return path can
//      miss nothing. What a step changes (old values, paths, ids) goes along through `data` in the SAME write before the effect
//      (`note` for values that arise one after another within a step — each before its own effect).
//   2. The decider: BEFORE the turnaround backward, FROM the turnaround forward (`decide`). The turnaround is the step from which it
//      only goes forward (relocation: step 14, the start inside). An announced but unconfirmed turnaround step counts as reached — it
//      is repeated forward. A begun return path stays a return path.
//   3. Resume idempotently (`run`): done steps never run twice; an announced, unconfirmed step runs once more (its effect has to
//      tolerate that — "maybe already happened" is its normal case). An error BEFORE the turnaround turns the procedure around at once
//      (return path from the first return-path step on), an error FROM the turnaround leaves it standing forward (the next call or the
//      restart grace resumes there).
//
//   journalPlan({ forward, backward, pivot })
//       The step names of both directions (unique, both lists disjoint — a name alone says in which direction it stands) and the
//       turnaround (∈ forward). Frozen.
//   createJournal({ read, write })
//       `read()` returns the state `{ direction, step, done }` or null (no row / nothing announced); `write(fields)` holds
//       `{ direction, step, done, data? }` — synchronous or as a promise, both are awaited before going on. Returns
//       `{ snapshot(), step(name, effect, { direction, data }), note(data) }`. For the relocation:
//         createJournal({ read: () => store.readRelocation(id), write: (f) => store.writeRelocation(id, f) })
//   decide(plan, state) → { direction: "forward" | "backward", from: <step> | null }   (`from: null` = nothing left)
//   nextStep(list, state) → the step that runs next (again), or null
//   run(plan, journal, effects, { fresh, atTurnAround }) — runs from `decide` to the end of the direction; with `fresh: true` (the
//       first call of a procedure, nothing announced — else it throws) forward from the first step. Without `fresh` an empty journal
//       means "nothing took effect" and thus return path (the restart grace). `effects` has a function for EVERY step of both lists
//       (checked before anything takes effect). Returns `{ direction, run }`; an error before the turnaround is thrown after the return
//       path as `JournalTurned` (with `cause`), every other unchanged. Three additions:
//         - `atTurnAround({ step, error, cause })` (optional, awaited) runs BEFORE the first return-path step, whenever the procedure
//           turns around NOW — after an error before the turnaround (`cause: "error"`, `step` = the failed one, `error` = its error)
//           or in the restart grace of a journal standing forward before the turnaround (`cause: "restartGrace"`, `step` = the last
//           announced or null). A resumed return path does not call it again. So the reason is in the journal before the return path
//           does anything — a failing return-path step does not lose it. If `atTurnAround` throws, NO return path runs (the error goes
//           out unchanged; the state stays forward before the turnaround, and the restart grace turns around).
//         - An error IN the turnaround step with `turnaroundNotReached === true` counts as before the turnaround: the step itself knows
//           whether it has already crossed the point of no return (relocation: `converted_at` is not set yet, nothing ran inside). Every
//           other error from the turnaround on leaves the procedure standing forward as before.
//         - If the return path fails after an error before the turnaround, `JournalReturnPathFailed` goes out (`step` = the one that
//           failed forward, `origin` = its error, `cause` = the return path's error) — otherwise the original error would be lost.
//
// The place of a relocation's files (`~/cbase/data/relocations/<projectId>/<time>/`, never mounted — the backup of the `.env*`
// originals lies there, 0600): `relocationTime`, `relocationLocation`, `createRelocationLocation`, plus `relocationFolderOf` (the
// folder of a project with all relocations — it falls with the project, projectbox/erase.js). The folder's name is `RELOCATION_FOLDER`
// here; projectbox/creation.js `neverMounted` names it as a literal (this leaf imports nothing — its sabotage probe copies it alone),
// bound in server/backend/test/projectbox-journal.test.js "place …".
//
// Guard: server/backend/test/projectbox-journal.test.js.
import fs from "node:fs";
import path from "node:path";

export const DIRECTIONS = Object.freeze(["forward", "backward"]);

export class JournalTurned extends Error {
  constructor(step, cause) {
    super(`step “${step}” failed before the turnaround — the return path has run: ${cause?.message || cause}`, { cause });
    this.name = "JournalTurned";
    this.code = "JOURNAL_TURNED";
    this.step = step;
  }
}

export class JournalReturnPathFailed extends Error {
  constructor(step, origin, cause) {
    super(`step “${step}” failed before the turnaround (${origin?.message || origin}), and the return path failed: ${cause?.message || cause}`, { cause });
    this.name = "JournalReturnPathFailed";
    this.code = "JOURNAL_RETURN_PATH_FAILED";
    this.step = step;
    this.origin = origin;
  }
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

export function journalPlan({ forward, backward = [], pivot } = {}) {
  const checkList = (list, what) => {
    if (!Array.isArray(list) || (what === "forward" && !list.length)) throw new TypeError(`journalPlan: ${what} must be a list of step names`);
    for (const n of list) if (typeof n !== "string" || !NAME.test(n)) throw new TypeError(`journalPlan: invalid step name “${n}” in ${what}`);
    if (new Set(list).size !== list.length) throw new TypeError(`journalPlan: duplicate step in ${what}`);
  };
  checkList(forward, "forward");
  checkList(backward, "backward");
  const both = forward.filter((n) => backward.includes(n));
  if (both.length) throw new TypeError(`journalPlan: ${both.join(", ")} is in both directions`);
  if (!forward.includes(pivot)) throw new TypeError(`journalPlan: the turnaround “${pivot}” is no forward step`);
  return Object.freeze({ forward: Object.freeze([...forward]), backward: Object.freeze([...backward]), pivot });
}

/** The step that runs next (again) in `list`: an announced, unconfirmed one is repeated. */
export function nextStep(list, state) {
  const step = state?.step || "";
  const i = list.indexOf(step);
  if (i < 0) return list[0] ?? null;
  if (state.done !== step) return step;
  return list[i + 1] ?? null;
}

export function decide(plan, state) {
  const direction = state?.direction || "forward";
  if (!DIRECTIONS.includes(direction)) throw new Error(`journal: unknown direction “${direction}”`);
  const step = state?.step || "";
  if (direction === "backward") {
    if (step && !plan.backward.includes(step)) throw new Error(`journal: “${step}” is no step of the return path — a journal of another state is not guessed`);
    return { direction, from: nextStep(plan.backward, state) };
  }
  // Nothing announced: nothing took effect — that too lies before the turnaround.
  if (!step) return { direction: "backward", from: plan.backward[0] ?? null };
  const i = plan.forward.indexOf(step);
  if (i < 0) throw new Error(`journal: “${step}” is no forward step — a journal of another state is not guessed`);
  if (i < plan.forward.indexOf(plan.pivot)) return { direction: "backward", from: plan.backward[0] ?? null };
  return { direction: "forward", from: nextStep(plan.forward, state) };
}

export function createJournal({ read, write } = {}) {
  if (typeof read !== "function" || typeof write !== "function") throw new TypeError("createJournal: read and write are mandatory");
  return {
    snapshot: () => read(),
    async note(data) {
      await write({ data });
    },
    async step(name, effect, { direction = "forward", data } = {}) {
      if (!DIRECTIONS.includes(direction)) throw new TypeError(`journal: unknown direction “${direction}”`);
      if (typeof effect !== "function") throw new TypeError(`journal: step “${name}” without effect`);
      const prior = read();
      // A change of direction starts the list of done steps anew.
      const done = prior?.direction === direction ? prior.done || "" : "";
      await write({ direction, step: name, done: done === name ? "" : done, ...(data === undefined ? {} : { data }) });
      const result = await effect();
      await write({ direction, step: name, done: name });
      return result;
    },
  };
}

function checkEffects(plan, effects) {
  const missing = [...plan.forward, ...plan.backward].filter((n) => typeof effects?.[n] !== "function");
  if (missing.length) throw new TypeError(`journal: no effect for ${missing.join(", ")}`);
}

async function runList(list, from, direction, journal, effects, run2) {
  if (from === null) return;
  for (let i = list.indexOf(from); i >= 0 && i < list.length; i++) {
    const n = list[i];
    await journal.step(n, () => effects[n](), { direction });
    run2.push(n);
  }
}

export async function run(plan, journal, effects, { fresh = false, atTurnAround = null } = {}) {
  checkEffects(plan, effects);
  if (atTurnAround !== null && typeof atTurnAround !== "function") throw new TypeError("journal: atTurnAround must be a function");
  const state = journal.snapshot();
  if (fresh && state?.step) throw new Error(`journal: “fresh”, but “${state.step}” is already announced — resume, do not begin anew`);
  const { direction, from } = fresh ? { direction: "forward", from: plan.forward[0] } : decide(plan, state);
  const run2 = [];
  if (direction === "backward") {
    // If the procedure turns around NOW (restart grace before the turnaround), the reason is in the journal before the first return-path step.
    if ((state?.direction || "forward") !== "backward" && atTurnAround) await atTurnAround({ step: state?.step || null, error: null, cause: "restartGrace" });
    await runList(plan.backward, from, "backward", journal, effects, run2);
    return { direction, run: run2 };
  }
  const pivot = plan.forward.indexOf(plan.pivot);
  if (from === null) return { direction, run: run2 };
  for (let i = plan.forward.indexOf(from); i < plan.forward.length; i++) {
    const n = plan.forward[i];
    try {
      await journal.step(n, () => effects[n](), { direction: "forward" });
      run2.push(n);
    } catch (e) {
      // From the turnaround only forward — unless the turnaround step itself reports that it has not reached the point of no return.
      if (i > pivot || (i === pivot && e?.turnaroundNotReached !== true)) throw e;
      if (atTurnAround) await atTurnAround({ step: n, error: e, cause: "error" });
      try {
        await runList(plan.backward, plan.backward[0] ?? null, "backward", journal, effects, run2);
      } catch (r) {
        throw new JournalReturnPathFailed(n, e, r);
      }
      throw new JournalTurned(n, e);
    }
  }
  return { direction, run: run2 };
}

// ── The place of a relocation ───────────────────────────────────────────────────────────────────────────────────────────

export const RELOCATION_FOLDER = "relocations";
const VALID_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/; // like runs/runtime-location.js
const TIME = /^\d{8}-\d{6}-\d{3}$/;

/** The time stamp of a relocation, UTC: `YYYYMMDD-HHMMSS-mmm` (sorts like the time). */
export function relocationTime(ms = Date.now()) {
  const d = new Date(ms);
  const z = (n, l = 2) => String(n).padStart(l, "0");
  return `${d.getUTCFullYear()}${z(d.getUTCMonth() + 1)}${z(d.getUTCDate())}-${z(d.getUTCHours())}${z(d.getUTCMinutes())}${z(d.getUTCSeconds())}-${z(d.getUTCMilliseconds(), 3)}`;
}

// The check of data folder and project id — ONE for `relocationLocation` and `relocationFolderOf` (`who` names the caller in the throw).
function projectFolder(who, { data, projectId }) {
  if (typeof data !== "string" || !path.isAbsolute(data)) throw new TypeError(`${who}: data must be an absolute path`);
  if (typeof projectId !== "string" || !VALID_ID.test(projectId)) throw new TypeError(`${who}: invalid project id “${projectId}”`);
  return path.join(data, RELOCATION_FOLDER, projectId);
}

/** `<data>/relocations/<projectId>/<time>` — throws on an id or time that could lead out of the folder. */
export function relocationLocation({ data, projectId, time }) {
  const folder = projectFolder("relocationLocation", { data, projectId });
  if (typeof time !== "string" || !TIME.test(time)) throw new TypeError(`relocationLocation: invalid time stamp “${time}”`);
  return path.join(folder, time);
}

/**
 * `<data>/relocations/<projectId>` — the relocation folder of ONE project with all its relocations (per `<time>/` plan, report, log,
 * the `.env*` backup). It falls with the deletion of the project (projectbox/erase.js). Throws on an id that could lead out of the
 * folder — like `relocationLocation`.
 */
export const relocationFolderOf = ({ data, projectId }) => projectFolder("relocationFolderOf", { data, projectId });

/**
 * Create the place: 0700 (the `.env*` originals lie there), and none of the three own levels (`relocations`, `<projectId>`,
 * `<time>`) may be a symlink — the data folder itself is B's business. Returns the place.
 */
export function createRelocationLocation({ data, projectId, time }) {
  const location = relocationLocation({ data, projectId, time });
  fs.mkdirSync(location, { recursive: true, mode: 0o700 });
  for (const stage of [path.join(data, RELOCATION_FOLDER), path.dirname(location), location]) {
    const st = fs.lstatSync(stage);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`relocation location: ${stage} is not a folder (symlink or file) — nothing created`);
  }
  fs.chmodSync(location, 0o700);
  return location;
}
