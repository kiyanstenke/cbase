// The progress of a copy that is being created. Read by `GET /api/active-runs` (runs/routes.js, field `copies` — the "Active runs"
// pill in the web) and by the instance tree (projectbox/instances-tree.js, field `progress` per copy — the "Instances" tab in web and
// iOS).
//
// WHAT IS SHOWN — three items, each from a source that already exists:
//   step/steps   the phase of the copy among the six of the build (store `STACK_COPY_PHASES.build`; the same list stands here as
//                `BUILD_PHASES`, a test keeps both equal). A waiting copy (waiting_queue/waiting_storage) has step 0.
//   stage        in the last step ("start") the stage of the compose start, as the instance row carries it ("stage 2/3", see
//                stageFrom).
//   share, restMs  an ESTIMATE from the last finished copy of the SAME project (preferably with the same base): its journal carries
//                per step the time from "announced" to "done" (stacks/build.js `journal.step`). Measured on a real project: freeze
//                (clone including pause) 312 s, creation 3 s, prepare 4 s, start 69 s — a bar by steps would stand at 1/6 for 80 %
//                of the time. Without a finished predecessor there is NO estimate (`share` null): the client then shows an
//                indeterminate bar and the step, never an invented number. If the running step takes longer than back then, the share
//                stays just below and `overrun` says so.
//
// ONLY THE LAST ATTEMPT COUNTS. The journal of a copy is never reset; the restart grace and the server end put it back in the queue
// and write only `note`. The new attempt begins with `journal.step("freeze")`, and if the journal already stood in "freeze", NO new
// row arises for it — without a cut the copy would show 76 % ten seconds after the new beginning and "takes longer than last time"
// (beginning before the deploy), and as a predecessor its "freeze" would count the whole time since the FIRST attempt. The cut is the
// separator `fresh_start` (STACK_COPY_FRESH_START) that store/stack-copies.js `changeStackCopy` appends on entering the build from a
// waiting state (the reasoning and the other readers are there): `lastAttempt` takes the rows after it; if the announcement of
// "freeze" is missing in them, it began with the separator. Why a separator and not the time of the instance row `copy-<name>`
// (`created_at` — it arises anew in the same step): it exists only while the copy lives, and a predecessor is mostly removed already;
// the server-end teardown leaves no other trace in the journal. A predecessor without separator but with a `dismantling` section is a
// second attempt from the time before: it does not count (which row belongs to which attempt is not said there).
//
// The computation (`copyProgress`) is pure — time and predecessors come in; `progressOf` reads them from the store.
//
// The place: projectbox/, not stacks/ — the tree (projectbox/instances-tree.js) and the pill (runs/routes.js) read it, and neither
// ever reaches up into stacks/ (import-direction.test.js). Only the store is read; nothing is written.
import * as store from "../store.js";

/** The phases of the build in order — twin of store `STACK_COPY_PHASES.build` (copy-progress.test.js). */
export const BUILD_PHASES = Object.freeze(["clone1", "freeze", "clone2", "creation", "prepare", "start"]);
/** The steps of the journal (stacks/build.js) — "freeze" covers the phases clone1, freeze and clone2. */
export const JOURNAL_STEPS = Object.freeze(["freeze", "creation", "prepare", "start", "ready"]);
const WAITING = Object.freeze({ waiting_queue: "queue", waiting_storage: "storage" });
// A running step that reaches its estimate does not advance beyond here — a full bar would mean "done".
const CAP_IN_STEP = 0.95;
const CAP_TOTAL = 0.97;

// The predecessors the estimate reads at most (filtered and capped in SQL, store `stackCopiesFinishedBuilt`).
export const PREDECESSORS_MAX = 5;

/**
 * The last attempt of a journal (see header, "ONLY THE LAST ATTEMPT COUNTS"): `since` = the time of the last separator (null without
 * — then the whole log is one attempt), `forward` = its forward rows (if the announcement of "freeze" is missing after a separator,
 * it stands at the front at the time of the separator), `backward` = whether it carries a row of another direction.
 */
function lastAttempt(journal) {
  const p = Array.isArray(journal?.log) ? journal.log : [];
  let i = p.length - 1;
  while (i >= 0 && !(p[i] && p[i].what === store.STACK_COPY_FRESH_START && Number.isFinite(p[i].at))) i--;
  const since = i >= 0 ? p[i].at : null;
  const rows = p.slice(i + 1).filter((e) => e && typeof e === "object");
  const before = rows.filter((e) => e.direction === "forward" && Number.isFinite(e.at));
  const first = JOURNAL_STEPS[0];
  if (since !== null && !before.some((e) => e.step === first && e.what === "announced")) {
    before.unshift({ direction: "forward", step: first, what: "announced", at: since });
  }
  return { since, forward: before, backward: rows.some((e) => e.direction && e.direction !== "forward") };
}

/** The duration of every journal step in the last attempt of a FINISHED copy (`{ freeze: ms, … }`), or null if it did not run fully
 *  forward (aborted, torn down, from the time before the journal) or is a second attempt without a separator (see header). */
export function stepDurations(journal) {
  const v = lastAttempt(journal);
  if (v.backward) return null;
  if (v.since === null && journal?.data?.dismantling) return null;
  const p = v.forward;
  const durations = {};
  for (const s of JOURNAL_STEPS) {
    const enabled = p.find((e) => e.step === s && e.what === "announced");
    const finished = p.find((e) => e.step === s && e.what === "done");
    if (!enabled || !finished || finished.at < enabled.at) return null;
    durations[s] = finished.at - enabled.at;
  }
  return durations;
}

/** The running journal step (`{ step, since }`) in the forward rows of an attempt: the last announced one without a "done" after it,
 *  else null. */
function runningStep(p) {
  for (let i = p.length - 1; i >= 0; i--) {
    const e = p[i];
    if (e.what !== "announced") continue;
    const done = p.slice(i + 1).some((x) => x.step === e.step && x.what === "done");
    return done ? null : { step: e.step, since: e.at };
  }
  return null;
}

const stageFrom = (phase) => {
  const m = /^stage (\d+)\/(\d+)$/.exec(String(phase || ""));
  return m ? { seq: Number(m[1]), from: Number(m[2]) } : null;
};

/**
 * The progress of a copy in `waiting_*` or `build`, else null.
 *   k            the row from stack_copies (store `mapStackCopy`: state, phase, requestedAt, journal, baseInstance)
 *   previous     finished copies of the same project, NEWEST first — or those with the same base first, the newest among them (that is how
 *                store `stackCopiesFinishedBuilt` delivers them; the choice below gives the same in both orders) — only `journal` and
 *                `baseInstance` are read
 *   instancePhase the phase of the copy's instance row (in the step "start" the stage)
 * → { kind: "waiting" | "create", reason, step, steps, phase, stage, begin, share, restMs, estimateMs, overrun }
 */
export function copyProgress(k, { previous = [], instancePhase = "", now = Date.now() } = {}) {
  if (!k) return null;
  const steps = BUILD_PHASES.length;
  const empty = { stage: null, share: null, restMs: null, estimateMs: null, overrun: false };
  if (WAITING[k.state]) {
    return { kind: "waiting", reason: WAITING[k.state], step: 0, steps, phase: "", begin: k.requestedAt ?? null, ...empty };
  }
  if (k.state !== "build") return null;
  const idx = BUILD_PHASES.indexOf(k.phase);
  const attempt = lastAttempt(k.journal);
  const base = {
    kind: "create", reason: "", step: idx >= 0 ? idx + 1 : 0, steps, phase: k.phase || "",
    begin: attempt.since ?? attempt.forward[0]?.at ?? k.requestedAt ?? null, ...empty,
    stage: k.phase === "start" ? stageFrom(instancePhase) : null,
  };
  const running = runningStep(attempt.forward);
  if (!running) return base;
  // The predecessor: first one with the same base (a copy of a copy clones its state, not the main's), else any.
  const finished = previous.map((v) => ({ v, d: stepDurations(v.journal) })).filter((x) => x.d);
  const equal = finished.find((x) => (x.v.baseInstance || "main") === (k.baseInstance || "main"));
  const durations = (equal || finished[0])?.d;
  if (!durations || !(running.step in durations)) return base;
  const total = JOURNAL_STEPS.reduce((s, x) => s + durations[x], 0);
  if (!(total > 0)) return base;
  const before = JOURNAL_STEPS.slice(0, JOURNAL_STEPS.indexOf(running.step)).reduce((s, x) => s + durations[x], 0);
  const elapsed = Math.max(0, now - running.since);
  const desired = durations[running.step];
  const share = Math.min(CAP_TOTAL, Math.max(0, (before + Math.min(elapsed, desired * CAP_IN_STEP)) / total));
  return {
    ...base,
    share: Math.round(share * 1000) / 1000,
    restMs: Math.max(0, Math.round(total - before - elapsed)),
    estimateMs: total,
    overrun: elapsed > desired,
  };
}

/**
 * The progress of a copy from the store, or null. Only what the computation needs is read: a waiting copy has no estimate (neither
 * predecessors nor instance row), one in the build at most PREDECESSORS_MAX finished predecessors — filtered in SQL, same base first —,
 * the instance row only in the step "start" (the stage). `read` is the test seam of the query (copy-progress.test.js (8): what is
 * read, and that a waiting copy reads nothing).
 */
export function progressOf(k, { now = Date.now(), read = store.stackCopiesFinishedBuilt } = {}) {
  if (!k || !(WAITING[k.state] || k.state === "build")) return null;
  let previous = [];
  let instancePhase = "";
  if (k.state === "build") {
    try {
      previous = read(k.projectId, { withoutId: k.id, baseInstance: k.baseInstance || "main", limit: PREDECESSORS_MAX });
    } catch { previous = []; }
    if (k.phase === "start") {
      try { instancePhase = store.projectInstance(k.projectId, `copy-${k.name}`)?.phase || ""; } catch { instancePhase = ""; }
    }
  }
  return copyProgress(k, { previous, instancePhase, now });
}
