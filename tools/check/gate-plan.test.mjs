// Guard for lib/gate-plan.mjs: in which order and how wide the gate runs its suites.
//
// Three kinds:
//  1. the width of the backend as a pure calculation (cores, load, preset),
//  2. the two phases on staged suites whose end the TEST determines — no clock, no duration: whether the backend starts while
//     a short suite runs is decided by the order of events, not by how long something takes,
//  3. the binding to targets/check.mjs: without it gate-plan.mjs would be a module nobody uses.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BASE_LOAD_PER_CORE, LONG_SUITES, SUITE_CAP_MS, SUITE_STALL_MS, backendParallelism, backendParallelismText, runSuites, shortParallelism, suiteDeadlines } from "./lib/gate-plan.mjs";
import { PUBLIC_PLAN, buildSuites, suiteContext } from "./lib/gate-plans.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

test("backend width: without foreign load the same number as before the rebuild — on every core count", () => {
  // The old formula was max(3, min(10, cores − 4)). Up to the base load NOTHING may change, or the gate gets
  // slower on a quiet machine without any foreigner being there.
  for (let cores = 1; cores <= 64; cores++) {
    const old = Math.max(3, Math.min(10, cores - 4));
    for (const last of [0, BASE_LOAD_PER_CORE * cores]) {
      assert.equal(backendParallelism({ cores, last }).count, old, `cores ${cores}, load ${last}`);
    }
  }
  // This Mac: 14 cores, measured ≈ 6 without a test process — stays at 10.
  assert.equal(backendParallelism({ cores: 14, last: 6.4 }).count, 10);
});

test("backend width: foreign load above the base load shortens, down to the floor 3", () => {
  const p = backendParallelism({ cores: 14, last: 12 });
  assert.equal(p.foreign, 5);
  assert.equal(p.count, 5);
  assert.equal(p.source, "formula");
  // A second full gate alongside (loadavg around 18–25 measured) — then the floor.
  assert.equal(backendParallelism({ cores: 14, last: 20 }).count, 3);
  assert.equal(backendParallelism({ cores: 14, last: 400 }).count, 3);
  // Monotonic: more load never gives more width.
  for (const cores of [4, 8, 14, 32]) {
    let prior = Infinity;
    for (let last = 0; last <= 3 * cores; last += 0.25) {
      const z = backendParallelism({ cores, last }).count;
      assert.ok(z <= prior, `cores ${cores}: load ${last} gives ${z} after ${prior}`);
      assert.ok(z >= 3 && z <= 10);
      prior = z;
    }
  }
});

test("backend width: CBASE_TEST_CONCURRENCY overrides cores AND load", () => {
  assert.deepEqual(
    [backendParallelism({ cores: 14, last: 40, preset: "6" }).count, backendParallelism({ cores: 14, last: 40, preset: "6" }).source],
    [6, "CBASE_TEST_CONCURRENCY"],
  );
  assert.equal(backendParallelism({ cores: 4, last: 0, preset: "20" }).count, 20);
  // Empty, 0 or nonsense means "not set" — as before (`Number(x) || formula`).
  for (const preset of [undefined, "", "0", "abc"]) assert.equal(backendParallelism({ cores: 14, last: 0, preset }).source, "formula");
  // Nonsensical measurements do not throw, they count as 0.
  assert.equal(backendParallelism({ cores: 14, last: NaN }).count, 10);
  assert.equal(backendParallelism({ cores: 14, last: -3 }).count, 10);
});

test("the log line names the chosen number AND both measured loads", () => {
  const p = backendParallelism({ cores: 14, last: 12.3 });
  const t = backendParallelismText(p, { lastStart: 12.3, lastBackend: 21.7 });
  assert.match(t, /^5 \(/);
  assert.match(t, /14 cores − 4 − foreign 5/);
  assert.match(t, /12,3 at gate start/);
  assert.match(t, /21,7 before the backend/);
  assert.match(t, /counted 12,3/);
  const v = backendParallelismText(backendParallelism({ cores: 14, last: 2, preset: "7" }), { lastStart: 2, lastBackend: 9 });
  assert.match(v, /^7 \(CBASE_TEST_CONCURRENCY; load 1 min 2,0 at gate start, 9,0 before the backend/);
});

test("short suites: explicit width, at most half the cores and the file count", () => {
  assert.equal(shortParallelism({ cores: 14, files: 58 }), 7);
  assert.equal(shortParallelism({ cores: 14, files: 3 }), 3);
  assert.equal(shortParallelism({ cores: 14, files: 1 }), 1);
  assert.equal(shortParallelism({ cores: 4, files: 58 }), 2);
  assert.equal(shortParallelism({ cores: 1, files: 58 }), 1);
  // Unknown file count (register missing — the gate is red anyway): half the cores.
  assert.equal(shortParallelism({ cores: 14, files: 0 }), 7);
  assert.equal(shortParallelism({ cores: 14 }), 7);
});

// Staged suites: each ends only when the test says `finished(name)`.
function provided() {
  const events = [];
  const open = new Map();
  const start = (name, command) => {
    events.push(`start ${name}`);
    return new Promise((resolve) => open.set(name, () => { events.push(`end ${name}`); resolve(`${name}: ${command}`); }));
  };
  const finished = (name) => {
    const f = open.get(name);
    assert.ok(f, `${name} is not running (started: ${[...open.keys()].join(", ") || "no"})`);
    open.delete(name);
    f();
  };
  const running = () => [...open.keys()];
  return { events, start, finished, running };
}

// A microtask pass until nothing follows — no timer, just drain the queue.
async function quiet() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

test("two phases: the backend starts only when the LAST short suite is finished", async () => {
  const g = provided();
  let built = 0;
  let between = 0;
  const suites = [
    ["Backend", () => { built++; return "backend-command"; }],
    ["Gateway", "g"],
    ["Web", "w"],
    ["Deploy tool", "d"],
    ["macOS", "m"],
  ];
  const run = runSuites(suites, g.start, { beforeLang: () => { between++; assert.deepEqual(g.running(), [], "beforeLang runs while a short suite is still running"); } });
  await quiet();
  assert.deepEqual(g.running().sort(), ["Deploy tool", "Gateway", "Web", "macOS"], "all short ones run together");
  assert.equal(built, 0, "the backend command is built only at start (the load is measured then)");

  // Finished in a different order than started — after each end the backend does NOT run.
  for (const name of ["Web", "macOS", "Gateway"]) {
    g.finished(name);
    await quiet();
    assert.ok(!g.running().includes("Backend"), `Backend ran after the end of ${name} although ${g.running().join(", ")} were still running`);
    assert.equal(between, 0);
  }
  g.finished("Deploy tool");
  await quiet();
  assert.deepEqual(g.running(), ["Backend"]);
  assert.equal(built, 1);
  assert.equal(between, 1, "beforeLang exactly once, between the phases");
  g.finished("Backend");
  const result = await run;

  // The results in the order of `suites` — the table prints them so.
  assert.deepEqual(result, ["Backend: backend-command", "Gateway: g", "Web: w", "Deploy tool: d", "macOS: m"]);
  const startBackend = g.events.indexOf("start Backend");
  for (const name of ["Gateway", "Web", "Deploy tool", "macOS"]) {
    assert.ok(g.events.indexOf(`end ${name}`) < startBackend, `${name} ended after the start of the backend: ${g.events.join(" · ")}`);
  }
});

// The suites are the PLAN's (lib/gate-plans.mjs): the long one is found by its name, and its builder must be a FUNCTION — built only
// at the moment it starts, so the backend measures the load then. Pure over a plan, so the counter-proof can damage a copy.
function longSuiteProblems(plan, ctx) {
  const out = [];
  for (const name of LONG_SUITES) {
    const s = plan.suites.find((x) => x.name === name);
    if (!s) { out.push(`${name} is not a suite of the plan`); continue; }
    if (typeof s.build(ctx, s) !== "function") out.push(`${name} builds a string, not a function — the load would not be measured at start`);
  }
  return out;
}
const planCtx = (plan) => suiteContext({
  plan, repo: path.resolve(HERE, "../.."), NODE_TEST: "NT", fastDeadlines: "FD", cores: 14,
  registerRaw: { onlyMacOS: { files: [], tests: [] } }, registerFiles: [], getBackend: () => ({ count: 7 }), onMac: false,
});

test("the long suite is called Backend — the same string as in the plans, and built lazily", () => {
  assert.deepEqual(LONG_SUITES, ["Backend"]);
  for (const plan of [PUBLIC_PLAN]) {
    assert.deepEqual(longSuiteProblems(plan, planCtx(plan)), [], `${plan.markerScope} plan`);
    assert.equal(plan.suites[0].name, "Backend");
  }
  // COUNTER-PROOF: a Backend that builds eagerly, and a plan that renamed it, are reported.
  const eager = { ...PUBLIC_PLAN, suites: PUBLIC_PLAN.suites.map((s) => (s.name === "Backend" ? { ...s, build: () => "node --test" } : s)) };
  assert.match(longSuiteProblems(eager, planCtx(eager)).join(), /not a function/);
  const renamed = { ...PUBLIC_PLAN, suites: PUBLIC_PLAN.suites.map((s) => (s.name === "Backend" ? { ...s, name: "Server" } : s)) };
  assert.match(longSuiteProblems(renamed, planCtx(renamed)).join(), /not a suite of the plan/);
});

// The binding: check.mjs runs through runSuites, every suite carries an explicit width, and the backend width comes from
// the load. The CODE is read (comments stripped) — the comments talk about the `Promise.all` that used to stand there.
function withoutComments(src) {
  return src.replace(/^[ \t]*\/\/.*$/gm, "").replace(/[ \t]\/\/ .*$/gm, "");
}

test("check.mjs runs the suites through runSuites, each with an explicit width, the backend by load", () => {
  const check = withoutComments(fs.readFileSync(path.join(HERE, "targets", "check.mjs"), "utf8"));
  assert.match(check, /import \{[^}]*\brunSuites\b[^}]*\} from "\.\.\/lib\/gate-plan\.mjs"/);
  assert.match(check, /await runSuites\(suites, /);
  assert.doesNotMatch(check, /Promise\.all\(suites\.map/, "the suites all run at the same time again");

  // The suites come from the plan: no literal list in check.mjs any more (a second source of suites would run beside the plan).
  assert.doesNotMatch(check, /const suites = \[/, "check.mjs holds its own suite list again — the plan is no longer the only source");
  assert.match(check, /const built = buildSuites\(plan, ctx\);/);
  assert.match(check, /getBackend: \(\) => backend/, "the backend width is not handed to the builders lazily");
  // Every suite command that starts `NODE_TEST` carries its width: `--test-concurrency=` directly behind it. READ off the built
  // commands of both plans, not off source text.
  for (const plan of [PUBLIC_PLAN]) {
    const { suites, errors } = buildSuites(plan, { ...planCtx(plan), webFiles: ["web/test/a.mjs"], onMac: true, onlyMac: { files: ["web/test/m.mjs"], tests: [] } });
    assert.deepEqual(errors, []);
    assert.ok(suites.length >= 6, `only ${suites.length} suites built`);
    for (const [name, command] of suites) {
      const cmd = typeof command === "function" ? command() : command;
      const calls = cmd.split("NT").slice(1);
      assert.ok(calls.length >= 1, `${name}: no NODE_TEST call`);
      for (const a of calls) assert.match(a, /^ --test-concurrency=\d+ /, `${name}: node --test without an explicit --test-concurrency`);
    }
    console.log(`  [width] ${plan.markerScope}: ${suites.length} suites, each with an explicit --test-concurrency`);
    // COUNTER-PROOF: a command without the width is what the regex above would catch.
    assert.doesNotMatch(" server/x/*.test.js", /^ --test-concurrency=\d+ /);
  }

  // The backend takes the number from backendParallelism, measured with the smaller of the two loads.
  // ...the number comes from the width measured when the backend starts (the builder reads it lazily from check.mjs's `backend`).
  const backendCommand = PUBLIC_PLAN.suites[0].build(planCtx(PUBLIC_PLAN))();
  assert.match(backendCommand, /^FD NT --test-concurrency=7 server\/backend\/test\/\*\.test\.js$/, "the backend command no longer takes its width from getBackend()");
  assert.match(fs.readFileSync(path.join(HERE, "lib", "gate-plans.mjs"), "utf8"), /--test-concurrency=\$\{ctx\.backend\(\)\.count\}/);
  assert.match(check, /backend = backendParallelism\(\{ cores, last: Math\.min\(lastStart, lastBackend\), preset: process\.env\.CBASE_TEST_CONCURRENCY \}\)/);
  assert.match(check, /const lastBackend = os\.loadavg\(\)\[0\];/);
  // The start measurement comes BEFORE everything that generates load in the gate itself (node --check, tsc).
  const start = check.indexOf("let lastStart = os.loadavg()[0];");
  assert.ok(start !== -1 && start < check.indexOf('probe("node", ["--check"'), "lastStart is not measured before the gate's own checks");
  // The log line.
  assert.match(check, /\["Backend parallelism", backendParallelismText\(backend, \{ lastStart, lastBackend, deadlines \}\), null\]/);
  // Stall instead of total duration: ONE rule for every suite — the same `deadlines` at every start, progress is a TAP result.
  // There is no per-suite switch any more.
  assert.match(check, /const deadlines = suiteDeadlines\(\{ defaultStillMs: process\.env\.CBASE_SUITE_STALL_MS, defaultCapMs: process\.env\.CBASE_SUITE_TIMEOUT_MS \}\);/);
  assert.match(check, /shProbe\(cmd, \{ cwd: REPO, timeout: deadlines\.capMs, stall: \{ ms: deadlines\.stillMs, progress: isTapResult \}, env: testEnv \}\)/);
  assert.equal((check.match(/shProbe\(cmd,/g) || []).length, 1, "a second start path for suites — then the stall rule does not apply to all");
  assert.doesNotMatch(check, /deadlineOf|backendDeadline/, "the total deadline per suite is back");
});

// Stall instead of total duration: a total deadline once aborted a backend three times without a red test. The rule is now a
// silence of 300 s and an emergency cap of one hour — for every suite. Whether sh.mjs really enforces it so is measured by
// suite-stall.test.mjs on staged suites.
test("suite deadlines: 300 s stall, emergency cap 1 h; the regulators override each on its own", () => {
  assert.equal(SUITE_STALL_MS, 300_000);
  assert.equal(SUITE_CAP_MS, 3_600_000);
  assert.deepEqual(suiteDeadlines(), { stillMs: 300_000, stillSource: "preset", capMs: 3_600_000, capSource: "preset" });
  assert.deepEqual(suiteDeadlines({ defaultStillMs: "60000", defaultCapMs: "7200000" }), {
    stillMs: 60_000, stillSource: "CBASE_SUITE_STALL_MS", capMs: 7_200_000, capSource: "CBASE_SUITE_TIMEOUT_MS",
  });
  for (const v of [undefined, "", "0", "abc", "-5"]) {
    const f = suiteDeadlines({ defaultStillMs: v, defaultCapMs: v });
    assert.deepEqual([f.stillMs, f.capMs], [300_000, 3_600_000], `default ${v}`);
  }
  // The measured aborts: after 900 s 2,662 tests had been reported, so the suite ran steadily. COUNTER-PROOF: the old total
  // deadline (900 s × 10 / width) would have torn at width 10; the new rule tears only on silence — and the longest SINGLE test
  // in the gate logs of that day (141.7 s) lies below it.
  const oldDeadline = (width) => Math.min(3_600_000, Math.round(900_000 * Math.max(1, 10 / width)));
  const runtime = (900 / 0.78) * 1000;
  assert.ok(runtime > oldDeadline(10), "counter-proof: the old deadline would have sufficed — then the guard measures nothing");
  assert.ok(141_700 < suiteDeadlines().stillMs, "the longest measured single test is longer than the stall deadline");
  // The log line names the rule.
  const t = backendParallelismText(backendParallelism({ cores: 14, last: 20 }), { lastStart: 20, lastBackend: 20, deadlines: suiteDeadlines() });
  assert.match(t, /^3 \(.*; abort after 300 s without a test result, hard cap 3600 s\)$/, t);
  const v = backendParallelismText(backendParallelism({ cores: 14, last: 0 }), { lastStart: 0, lastBackend: 0, deadlines: suiteDeadlines({ defaultStillMs: 60000, defaultCapMs: 600000 }) });
  assert.match(v, /; abort after 60 s without a test result \(CBASE_SUITE_STALL_MS\), hard cap 600 s \(CBASE_SUITE_TIMEOUT_MS\)\)$/, v);
});
