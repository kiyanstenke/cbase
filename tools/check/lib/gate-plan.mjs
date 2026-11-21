// How the gate runs its suites: in which order and how wide.
//
// All seven suites used to run at once (`Promise.all`), and only the backend had an upper limit. Web, deploy tool,
// client and macOS took the default of `node --test` (cores − 1 files at once), 60 of the 72 web files start `tsc`,
// the macOS files `swift` — in the first ≈ 22 s that put up to ≈ 49 test processes on 14 cores NEXT TO ten backend
// files with a real server and fake CLI. A backend test went red in exactly that window. The backend tests wait for
// events, not for the clock — but under this load their events arrive in a different order.
//
// Two answers, both pure calculation here (guard `tools/check/gate-plan.test.mjs`):
//
//  1. **The short suites BEFORE the backend.** Together they need seconds, the backend minutes; running them in
//     sequence costs at most the duration of the short ones, and the backend starts on a machine where nothing of
//     ours is running anymore.
//  2. **The backend width by LOAD, not only by core count.** If other builders run next to the gate (second session,
//     build, simulator), each of their busy cores counts against the budget. `CBASE_TEST_CONCURRENCY` still
//     overrides everything.

// The one long suite. Everything else counts as short and runs first.
export const LONG_SUITES = ["Backend"];

// The base load already contained in the measured 10: the measurements ran on this Mac with a running UI —
// WindowServer, the apps, Chrome. Measured without a single test process, `loadavg[0]` sat at ≈ 5.5–7 there (macOS
// counts runnable THREADS, not busy cores; the processes summed to ≈ 3.5 cores of CPU). Subtracting the raw load
// would ALWAYS give this Mac 4 instead of 10 — the backend would run twice as long without anyone else being there.
// So only the load ABOVE this base load counts, as a share of the cores (a 4-core machine has a smaller one).
export const BASE_LOAD_PER_CORE = 0.5;

/**
 * The width of the backend suite.
 *
 *   cores     `os.availableParallelism()`
 *   last      `os.loadavg()[0]` — the caller passes the smaller of two measurements (see check.mjs)
 *   preset    `CBASE_TEST_CONCURRENCY` (a number > 0 overrides)
 *
 * Formula: max(3, min(10, cores − 4 − foreign)), foreign = round(max(0, last − 0.5 · cores)).
 * The 3 at the bottom is the lower bound measured on 4 vCPU, the 10 at the top the cap, the 4 the free
 * cores for the server and fake CLI of each test file (comment in check.mjs).
 */
export function backendParallelism({ cores, last = 0, preset } = {}) {
  const k = Number(cores) > 0 ? Number(cores) : 4;
  const l = Number.isFinite(Number(last)) ? Math.max(0, Number(last)) : 0;
  const baseLoad = BASE_LOAD_PER_CORE * k;
  const foreign = Math.round(Math.max(0, l - baseLoad));
  const v = Number(preset);
  if (v > 0) return { count: Math.floor(v), source: "CBASE_TEST_CONCURRENCY", cores: k, last: l, baseLoad, foreign };
  const count = Math.max(3, Math.min(10, k - 4 - foreign));
  return { count, source: "formula", cores: k, last: l, baseLoad, foreign };
}

// When the gate aborts a suite.
//
// A TOTAL deadline (900 s per suite, growing with the backend width, cap 1 h) used to kill backends in which no test
// was red ("deadline 900 s expired — aborted after 2662 reported tests"): the duration depends on width, load and
// number of tests, and every number on top of it ages with the suite. A HANG, on the other hand, shows as silence.
// So the same rule applies to EVERY suite (short and long):
//
//   stillness    abort if `SUITE_STALL_MS` (300 s) pass with NO test result on the TAP stream — counted by
//                lib/test-output.mjs `isTapResult` (a line `ok N` / `not ok N`, any indentation, so also a subtest).
//                Knob `CBASE_SUITE_STALL_MS`.
//   hard cap     over the total duration one hour remains (`SUITE_CAP_MS`) — it catches what never goes quiet (a suite
//                that keeps reporting in a loop). Knob `CBASE_SUITE_TIMEOUT_MS`, as the total deadline before.
//
// What "silence" really means with `node --test` (22.17.1, measured): the reporter writes the files in command-line
// order. Only the FRONTMOST file not yet reported reports live, test by test (subtests individually); what the others
// finish meanwhile sits in the buffer and appears at once when they are in front. The silence between two results is
// therefore at most as long as the longest SINGLE (leaf) test plus the load time of the file — not the duration of a
// file or of the suite. The longest single test in the gate logs was 141.7 s (width 10), the same tests otherwise
// 23–55 s. 300 s rather than 180 s: 180 s left only 40 s of air above 141.7 s, and under heavy load a test grows past
// it easily — an abort without a red test is exactly what this rule is meant to end. A real hang costs two minutes
// more. The ripcord of the fake CLIs (server/backend/test/ripcord.mjs, 120 s) sits below — a hanging fake becomes a
// red test, not a suite abort.
export const SUITE_STALL_MS = 300_000;
export const SUITE_CAP_MS = 3_600_000;
export function suiteDeadlines({ defaultStillMs, defaultCapMs } = {}) {
  const still = Number(defaultStillMs) > 0 ? Number(defaultStillMs) : 0;
  const cap = Number(defaultCapMs) > 0 ? Number(defaultCapMs) : 0;
  return {
    stillMs: still || SUITE_STALL_MS,
    stillSource: still ? "CBASE_SUITE_STALL_MS" : "preset",
    capMs: cap || SUITE_CAP_MS,
    capSource: cap ? "CBASE_SUITE_TIMEOUT_MS" : "preset",
  };
}

// The rule as text for the log line — so that an abort is readable later.
export function suitesDeadlinesText(f) {
  const s = (ms) => `${Math.round(ms / 1000)} s`;
  const q = (source) => (source === "preset" ? "" : ` (${source})`);
  return `abort after ${s(f.stillMs)} without a test result${q(f.stillSource)}, hard cap ${s(f.capMs)}${q(f.capSource)}`;
}

// The log line for the width: chosen number AND measured load, so a red run is readable later
// ("ran with 3 because something ran next door") — and the abort rule of the suites.
export function backendParallelismText(p, { lastStart, lastBackend, deadlines = null } = {}) {
  const count = (x) => (Number.isFinite(x) ? x.toFixed(1).replace(".", ",") : "—");
  const measured = `load 1 min ${count(lastStart)} at gate start, ${count(lastBackend)} before the backend — counted ${count(p.last)}`;
  const f = deadlines ? `; ${suitesDeadlinesText(deadlines)}` : "";
  if (p.source !== "formula") return `${p.count} (${p.source}; ${measured}${f})`;
  return `${p.count} (${p.cores} cores − 4 − foreign ${p.foreign}; base load ${count(p.baseLoad)}; ${measured}${f})`;
}

/**
 * The width of a SHORT suite. They run together first, so they share the machine; each gets an explicit
 * number instead of the `node --test` default (cores − 1 per suite). Half the cores, at most as many as the
 * suite has files, at least 1 — the two big ones (web, deploy tool) thus together sit at the core count, the
 * small ones hardly matter.
 */
export function shortParallelism({ cores, files } = {}) {
  const k = Number(cores) > 0 ? Number(cores) : 4;
  const half = Math.max(1, Math.floor(k / 2));
  const n = Number(files);
  return Math.max(1, Number.isFinite(n) && n > 0 ? Math.min(half, n) : half);
}

/**
 * Run the suites: all short ones together, THEN the long one(s) — none overlaps another.
 *
 *   suites      [[name, command]] in output order; `command` may be a function, then it is built only
 *               at start (so the backend measures the load when it really starts)
 *   start       (name, command) → Promise<result>
 *   beforeLang  optional, runs once between the phases (load measurement, log line)
 *
 * Result: the results in the order of `suites`, whenever each finished.
 */
export async function runSuites(suites, start, { beforeLang = null } = {}) {
  const result = new Map();
  const commandOf = (b) => (typeof b === "function" ? b() : b);
  const short = suites.filter(([name]) => !LONG_SUITES.includes(name));
  const lang = suites.filter(([name]) => LONG_SUITES.includes(name));
  await Promise.all(short.map(async ([name, command]) => result.set(name, await start(name, commandOf(command)))));
  if (lang.length && beforeLang) await beforeLang();
  for (const [name, command] of lang) result.set(name, await start(name, commandOf(command)));
  return suites.map(([name]) => result.get(name));
}
