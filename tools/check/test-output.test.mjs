// The verdict on a test suite — against REAL `node --test` output.
//
// Why own tests: `valuesSuite` is the only place where `./check` decides whether a run is green. All four guards in it come
// from a failure that was previously reported GREEN (the fourth, "readable form", was measured with Electron 44 as node) — and a
// guard tested against hand-made strings would not have found exactly that: the fixtures here arise by really running `node --test`.
//
// The environment pre-check of check.mjs (`environmentVerdict`, `environmentMeasure`, lib/git.mjs `isFlat`) — a shallow clone, root
// and a node-pty that does not load turn whole groups of tests red without anything being wrong in the code; every reason stands as
// its own row, the shallow clone ends the gate immediately. `isFlat` against a real temp repo and its `git clone --depth 1`.
// COUNTER-TEST: in check.mjs, delete the line `if (environment.flat) throw …` => "check.mjs runs the pre-check …" red.
//
// Run:  node --test --test-reporter=tap tools/check/test-output.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { NO_TESTS, isTapResult, openSubtests, valuesSuite } from "./lib/test-output.mjs";
import { isFlat } from "./lib/git.mjs";
import { FLAT_SENTENCE, ROOT_DEPENDENT, environmentVerdict, playwrightMcpPackage } from "./targets/check.mjs";
import { PUBLIC_PLAN, buildSuites, suiteContext } from "./lib/gate-plans.mjs";
import { PRIVATE_ROOT } from "./cleanliness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");

// A real run: write a file, `node --test` on it, return stdout and exit code.
//
// The reporter is stated EXPLICITLY, as on every suite in check.mjs: from Node 23 on `node --test` writes spec instead of TAP
// without a terminal. Without the flag four tests of this file turned red under Electron 44 as node — not because the guard was
// wrong but because the fixture spoke another language. `reporter: "spec"` builds exactly that output with the node that is
// running; `env` lays variables ON TOP of the cleaned environment (for the NODE_TEST_CONTEXT corner).
function run(content, { reporter = "tap", env: extra = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-testoutput-"));
  try {
    const file = path.join(dir, "probe.test.mjs");
    fs.writeFileSync(file, content);
    // `NODE_TEST_CONTEXT` must GO: it is in the environment of every test, and a child run that inherits it reports not TAP but the
    // child protocol to a runner that does not know it — empty output and exit 0, even for a failure.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    Object.assign(env, extra);
    try {
      const stdout = execFileSync(process.execPath, ["--test", `--test-reporter=${reporter}`, file], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env });
      return { stdout, code: 0 };
    } catch (e) {
      return { stdout: String(e.stdout || ""), code: e.status ?? 1 };
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const HEADER = 'import { test } from "node:test";\nimport assert from "node:assert/strict";\n';

test("green is green — and the row names the skipped ones, even when there are none", () => {
  const r = run(`${HEADER}test("one", () => assert.ok(true));\ntest("two", () => assert.ok(true));\n`);
  const u = valuesSuite("Probe", r.stdout, r.code);
  console.log(`  [green] ${u.line}`);
  assert.equal(u.red, false, `a clean run was reported red: ${u.reason}`);
  assert.equal(u.skips, 0);
  assert.match(u.line, /# skipped 0/, "the number of skipped is missing from the row — then \"nothing skipped\" cannot be told from \"not measured\"");
});

test("a SKIPPED test is red — node --test counts it as passed", () => {
  const r = run(`${HEADER}test("runs", () => assert.ok(true));\ntest("conditional", (t) => { t.skip("node_modules missing (tsc)"); });\n`);
  const u = valuesSuite("Probe", r.stdout, r.code);
  console.log(`  [skip] exit ${r.code} · ${u.line}`);
  // The counter-test to the guard: node reports exit 0 and "# fail 0". Whoever only looks at that sees a green run.
  assert.equal(r.code, 0, "node --test no longer reports a skip via exit 0 — then the guard is obsolete");
  assert.match(r.stdout, /^# fail 0$/m);
  assert.equal(u.skips, 1);
  assert.equal(u.red, true, "a skipped test passed");
  assert.match(u.reason, /skipped/);
});

test("a real failure is red — even when the shell returns exit 0", () => {
  const r = run(`${HEADER}test("fails", () => assert.equal(1, 2));\n`);
  assert.notEqual(r.code, 0, "a failure must be red from node on");
  const real = valuesSuite("Probe", r.stdout, r.code);
  assert.equal(real.red, true);
  assert.equal(real.reason, "Probe tests failed");
  // The measured case: the same output, but the shell shorthand swallowed the exit code. Only the line `# fail 1` still stops the run.
  const swallowed = valuesSuite("Probe", r.stdout, 0);
  console.log(`  [exit 0 despite failure] ${swallowed.line} → ${swallowed.red ? "red" : "GREEN"}`);
  assert.equal(swallowed.red, true, "a failure with a swallowed exit code passed");
  assert.equal(swallowed.reason, "Probe tests failed");
});

// ── The readable form ────────────────────────────────────────────────────────────────────────
//
// From Node 23 on, `node --test` writes spec instead of TAP without a terminal. Measured with Electron 44.4.4 as node: `valuesSuite`
// on a run with a skipped test gave `{fail:0, skips:0, titles:[], red:false}`. The output below is the measured one verbatim
// (stdout redirected to a file, so without a terminal; the first two lines are console.log of the probe).
const SPEC_ELECTRON_44 =
  "node 24.21.0 electron 44.4.4 ctx true\nkind 24.21.0\n✔ versions (0.524917ms)\n✔ kind execPath (56.596708ms)\n﹣ skip (0.085792ms) # x\nℹ tests 3\nℹ suites 0\nℹ pass 2\nℹ fail 0\nℹ cancelled 0\nℹ skipped 1\nℹ todo 0\nℹ duration_ms 123.591875\n";

test("an output in spec format is never green — even less so with a skipped test", () => {
  // Really produced: Node 22 with `--test-reporter=spec` writes the same form that Node >= 23 writes by itself without a terminal.
  const r = run(`${HEADER}test("runs", () => assert.ok(true));\ntest("conditional", (t) => { t.skip("node_modules missing (tsc)"); });\n`, { reporter: "spec" });
  assert.equal(r.code, 0, "a skip is passed for node --test — the corner would otherwise measure something else");
  assert.match(r.stdout, /^ℹ skipped 1$/m, "the spec format counts the skip with ℹ — otherwise the fixture is no longer right");
  assert.doesNotMatch(r.stdout, /^# (fail|skipped) \d+$/m, "spec output has no TAP metric — that is exactly what the silent green hung on");
  const u = valuesSuite("Probe", r.stdout, r.code);
  console.log(`  [spec, real] ${u.line} → ${u.red ? "red" : "GREEN"}`);
  assert.equal(u.red, true, "a spec output with a skipped test was reported green");
  assert.equal(u.form, "spec");
  assert.match(u.reason, /--test-reporter=tap/, "the reason must say what is missing from the call");
  assert.match(u.line, /ℹ skipped 1/, "the red row should show what the run counted");

  // The measured bytes of Electron 44 — the same form, another node.
  const e44 = valuesSuite("Probe", SPEC_ELECTRON_44, 0);
  console.log(`  [spec, Electron 44.4.4 measured] ${e44.line} → ${e44.red ? "red" : "GREEN"}`);
  assert.equal(e44.red, true, "the output measured under Electron 44 was reported green");
  assert.equal(e44.skips, 1, "the ℹ metric is read as well");

  // And without a skip: clean, but unreadable for the skip titles. Red, because it only arises when a call is missing the reporter —
  // otherwise the first skip after the switch would slip through.
  const clean = run(`${HEADER}test("one", () => assert.ok(true));\n`, { reporter: "spec" });
  const s = valuesSuite("Probe", clean.stdout, clean.code);
  assert.equal(s.red, true, "a clean spec output passed — the missing reporter would go unnoticed");
  assert.match(s.reason, /spec format/);
});

test("an EMPTY output with exit 0 is not green — the inherited NODE_TEST_CONTEXT", () => {
  // Measured, not built: with an inherited NODE_TEST_CONTEXT `node --test` writes nothing to stdout, only a warning to stderr, and
  // ends with exit 0 — for a FAILURE.
  const r = run(`${HEADER}test("fails", () => assert.equal(1, 2));\n`, { env: { NODE_TEST_CONTEXT: "child-v8" } });
  console.log(`  [NODE_TEST_CONTEXT inherited] exit ${r.code} · stdout ${r.stdout.length} characters`);
  assert.equal(r.code, 0, "node no longer reports the swallowed failure with exit 0 — the corner would otherwise measure something else");
  assert.equal(r.stdout.trim(), "", "the output is no longer empty — the corner would otherwise measure something else");
  const u = valuesSuite("Probe", r.stdout, r.code);
  assert.equal(u.red, true, "a red test behind an empty output was reported green");
  assert.equal(u.form, "unreadable");
  assert.match(u.reason, /not measured is not passed/);
  // And a foreign form without metrics is the same.
  assert.equal(valuesSuite("Probe", "something\nwithout numbers\n", 0).red, true);
});

test("the none-found notice is green — and check.mjs writes exactly this word", () => {
  const u = valuesSuite("Split tool", `${NO_TESTS}\n`, 0);
  assert.equal(u.red, false, u.reason);
  assert.equal(u.form, "no");
  assert.equal(u.line, NO_TESTS);
  // The other side of the binding: every `echo '…'` in the suites (now in the PLANS, lib/gate-plans.mjs) writes NO_TESTS. If a suite wrote
  // "nothing", it would be red from today on — right so, but with a message pointing at the wrong place.
  const plans = fs.readFileSync(path.join(repo, "tools", "check", "lib", "gate-plans.mjs"), "utf8");
  const echos = [...withoutComments(plans).matchAll(/echo '([^']*)'/g)].map((m) => m[1]);
  assert.ok(echos.length >= 1, `no echo in gate-plans.mjs — is the anchor still right?`);
  assert.deepEqual([...new Set(echos)], [NO_TESTS], "a suite reports \"nothing found\" with a word other than NO_TESTS");
  // The ONLY legitimate "none" is the macOS suite on a foreign platform. A silent skip for a missing directory (`if ls …; else echo`)
  // is gone: a suite without files is an error of the plan builder.
  const check = fs.readFileSync(path.join(repo, "tools", "check", "targets", "check.mjs"), "utf8");
  for (const [name, src] of [["gate-plans.mjs", plans], ["check.mjs", check]]) {
    assert.doesNotMatch(withoutComments(src), /else echo|\bls [^\n]*>\/dev\/null/, `${name} skips a missing suite directory silently again`);
  }
  assert.equal(echos.length, 1, "more than one `echo 'none'` in the plans — only macOS on a foreign platform may report none");
});

// The abort of a suite: the last row of a cut-off TAP output once stood in the table as "bad  Backend tests    ..." with no word that the
// deadline had killed the process group. The row now also says WHICH deadline: the silence (hang) or the emergency cap (ran, but too long).
test("an aborted suite says so — stall or emergency cap, reported tests, last reported, open group", () => {
  const r = run(`${HEADER}test("first", () => assert.ok(true));\ntest("group", async (t) => {\n  await t.test("child one", () => assert.ok(true));\n  await t.test("child two", () => assert.ok(true));\n});\n`);
  // Cut off as in the gate, in the middle of the group: up to just past the result of "child one" including the YAML block, i.e. before
  // "# Subtest: child two" — this is what a stream looks like that goes silent during "child two".
  const raw = r.stdout.slice(0, r.stdout.indexOf("    # Subtest: child two"));
  assert.match(raw.trim().split("\n").pop(), /^\s*\.\.\.$/, "the cut-off output no longer ends with \"...\" — the fixture would otherwise measure something else");
  // COUNTER-TEST: without knowing the abort, the row is exactly the "..." from the gate.
  assert.equal(valuesSuite("Backend", raw, 124).line.trim(), "...");
  assert.deepEqual(openSubtests(raw), ["group"]);
  const u = valuesSuite("Backend", raw, 124, { abort: { kind: "stall", ms: 180000 } });
  assert.equal(u.red, true);
  assert.equal(u.line, "Stall: 180 s without a test result — aborted after 1 reported tests; last reported: „child one“; open: „group“");
  assert.match(u.reason, /^Backend tests: Stall: 180 s without a test result — .* — process group killed, no metrics; a test or hook hangs/);
  const d = valuesSuite("Web", raw, 124, { abort: { kind: "cap", ms: 3600000 } });
  assert.match(d.line, /^Emergency cap 3600 s total duration expired — aborted after 1 reported tests; last reported: „child one“/);
  // Without a single result the row says that too.
  assert.match(valuesSuite("Backend", "TAP version 13\n", 124, { abort: { kind: "stall", ms: 180000 } }).line, /after 0 reported tests; no test result yet$/);
  // And check.mjs passes the abort in exactly when sh.mjs reports it — both kinds.
  const check = fs.readFileSync(path.join(repo, "tools", "check", "targets", "check.mjs"), "utf8");
  assert.match(check, /const abort = r\.stall \? \{ kind: "stall", ms: deadlines\.stillMs \} : r\.timedOut \? \{ kind: "cap", ms: deadlines\.capMs \} : null;/);
  assert.match(check, /valuesSuite\(name, r\.stdout, r\.code, \{[^}]*abort \}\)/, "check.mjs no longer passes the abort to valuesSuite — then \"...\" stands there again");
  const sh = fs.readFileSync(path.join(repo, "tools", "check", "lib", "sh.mjs"), "utf8");
  assert.match(sh, /timedOut: true/);
  assert.match(sh, /stall: true/);
});

// What counts as progress, on REAL output: every result line, also indented; nothing else — above all not what a test itself writes
// to stdout (that shows up as a comment).
test("progress in the TAP stream: ok/not ok N at any indentation, no comment, no subtest header", () => {
  const r = run(`${HEADER}test("loud", () => { console.log("ok 99 - faked"); assert.ok(true); });\ntest("group", async (t) => { await t.test("child", () => assert.ok(true)); });\ntest("red", () => assert.ok(false));\n`);
  const hits = r.stdout.split("\n").filter(isTapResult).map((z) => z.trim().replace(/ - .*/, ""));
  assert.deepEqual(hits, ["ok 1", "ok 1", "ok 2", "not ok 3"], r.stdout);
  for (const z of ["# Subtest: x", "    # Subtest: x", "# ok 1 - x", "# tests 3", "  ---", "  duration_ms: 1", "1..3", "okay 1", "ok", "not ok"]) {
    assert.equal(isTapResult(z), false, z);
  }
  for (const z of ["ok 1 - a", "not ok 12 - b # SKIP", "        ok 3 - tief", "ok 4"]) assert.equal(isTapResult(z), true, z);
});

// The call itself: EVERY suite in check.mjs carries the reporter. The CODE is read, not the comments — they talk about `node --test`
// in sentences that are no calls. Whole comment lines, JSDoc blocks at line start and ` // …` after code are stripped; a general
// `/* … */` is not, because `server/gateway/*.test.js` in a command would look the same.
function withoutComments(src) {
  return src
    .replace(/^[ \t]*\/\*\*[\s\S]*?\*\/[ \t]*$/gm, "")
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/[ \t]\/\/ .*$/gm, "");
}

test("EVERY node --test call in check.mjs carries --test-reporter=tap", () => {
  const check = fs.readFileSync(path.join(repo, "tools", "check", "targets", "check.mjs"), "utf8");
  const code = withoutComments(check);
  const calls = [...code.matchAll(/node --test\b.*$/gm)].map((m) => m[0]);
  assert.ok(calls.length >= 1, "no `node --test` in check.mjs's code — fix the anchor, do NOT delete the test");
  const without = calls.filter((a) => !a.startsWith("node --test --test-reporter=tap"));
  assert.deepEqual(without, [], "a node --test call without --test-reporter=tap: under Node >= 23 spec would come instead of TAP");
  // The array form (`probe("node", ["--test", …])`) would slip past the string above.
  assert.doesNotMatch(code, /["'`]--test["'`]/, "node --test in array form — the reporter guard does not see it; go through NODE_TEST");

  // And every suite really goes through the bound call — a suite with its own command (e.g. `npx …`) would otherwise slip past the
  // string above. The suites are the plans' now: READ off the built commands of both plans with a sentinel in place of the real
  // NODE_TEST (whose value is held to the reporter by the lines above), and keep the literal `node --test` out of the plans.
  const NODE_TEST_VALUE = /const NODE_TEST = "([^"]+)";/.exec(code)?.[1];
  assert.equal(NODE_TEST_VALUE, "node --test --test-reporter=tap --import=./tools/check/lib/test-stdout-guard.mjs", "the NODE_TEST constant in check.mjs is not the bound call");
  const plansCode = withoutComments(fs.readFileSync(path.join(repo, "tools", "check", "lib", "gate-plans.mjs"), "utf8"));
  assert.doesNotMatch(plansCode, /node --test|["'`]--test["'`]/, "a plan starts node --test on its own, past NODE_TEST");
  const withoutBindingOf = (plan) => {
    const ctx = suiteContext({
      plan, repo, NODE_TEST: "@@NT@@", fastDeadlines: "FD", cores: 8,
      registerRaw: { onlyMacOS: { files: ["web/test/m.mjs"], tests: [] } }, registerFiles: ["web/test/a.mjs"], getBackend: () => ({ count: 3 }), onMac: true,
    });
    const { suites, errors } = buildSuites(plan, ctx);
    assert.deepEqual(errors, []);
    return { n: suites.length, without: suites.filter(([, c]) => !(typeof c === "function" ? c() : c).includes("@@NT@@")).map(([n]) => n) };
  };
  for (const plan of [PUBLIC_PLAN]) {
    const { n, without } = withoutBindingOf(plan);
    console.log(`  [reporter] ${calls.length} call site(s) in code · ${plan.markerScope}: ${n} suites · without NODE_TEST: ${without.join(", ") || "no"}`);
    assert.ok(n >= 6, `only ${n} suites read — is the anchor still right?`);
    assert.deepEqual(without, [], "a suite does not start its tests via NODE_TEST");
  }
  // COUNTER-PROOF: a plan with a suite of its own command is reported by the same measurement.
  const rogue = { ...PUBLIC_PLAN, suites: [...PUBLIC_PLAN.suites, { name: "Rogue", build: () => "npx vitest run" }] };
  assert.deepEqual(withoutBindingOf(rogue).without, ["Rogue"]);
});

// ── The recorder switches ────────────────────────────────────────────────────────────────────
//
// Three anchor tests REWRITE their fixtures when an environment variable is set. If one of them stays set in the shell after a
// deliberate re-recording, the gate measures itself against what it just wrote — and reports green. `check.mjs` therefore strips
// them from the child environment. The LIST is bound here: whoever introduces a fourth switch goes red until it is named there.
test("check.mjs strips EVERY recorder switch from the test environment", () => {
  const check = fs.readFileSync(path.join(repo, "tools", "check", "targets", "check.mjs"), "utf8");
  const m = check.match(/const RECORDER = \[([^\]]*)\];/);
  assert.ok(m, "the RECORDER list is in tools/check/targets/check.mjs — fix the anchor, do NOT delete the test.");
  const struck = (m[1].match(/"([^"]+)"/g) || []).map((x) => x.slice(1, -1)).sort();
  assert.ok(struck.length, "RECORDER is empty — does the regex still match?");
  assert.match(check, /env: testEnv/, "the stripped environment is no longer passed to the suites");

  // Measured instead of copied: which switches do the gate's tests REALLY read?
  const files = [];
  for (const [folder, pattern] of [["server/backend/test", /\.(test\.js|mjs)$/], ["web/test", /\.mjs$/], ["tools/check", /\.mjs$/], ["tools/deploy", /\.mjs$/], [`${PRIVATE_ROOT}/deploy`, /\.mjs$/], ["server/gateway", /\.test\.js$/]]) {
    const abs = path.join(repo, folder);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs)) if (pattern.test(f)) files.push(path.join(abs, f));
  }
  assert.ok(files.length > 50, `only ${files.length} test files found — are the folders still right?`);
  const read = new Set();
  for (const f of files) {
    for (const t of fs.readFileSync(f, "utf8").match(/process\.env\.(\w*_RECORD)\b/g) || []) read.add(t.split(".").pop());
  }
  console.log(`  [recorder] ${files.length} test files · read ${[...read].sort().join(", ")} · stripped ${struck.join(", ")}`);
  assert.deepEqual([...read].sort(), struck, "a recorder switch is read but not stripped from the gate environment (or vice versa)");
});

// The network does not belong in the gate. Almost every test file sets HOME to a temp directory, and `embeddings.js` caches the model
// under HOME — without the switch EVERY test process loaded ~130 MB from Hugging Face, and on a slow line a test hung for 15 min.
// Both sides are bound: the gate sets the switch, and the product still reads it.
test("check.mjs switches the embedding model offline for the suites — and embeddings.js reads the switch", () => {
  const check = fs.readFileSync(path.join(repo, "tools", "check", "targets", "check.mjs"), "utf8");
  assert.match(check, /testEnv\.CBASE_EMBED_OFFLINE = "1";/, "check.mjs no longer sets CBASE_EMBED_OFFLINE — every test process loads the model from the network again");
  const embeddings = fs.readFileSync(path.join(repo, "server", "backend", "electron", "server", "embeddings.js"), "utf8");
  assert.match(embeddings, /process\.env\.CBASE_EMBED_OFFLINE === "1"/, "embeddings.js no longer reads CBASE_EMBED_OFFLINE — the switch in the gate would be decoration");
});

// The same trap with the OpenRouter catalog: every server start with its own data folder has no catalog file and would otherwise
// fetch it from openrouter.ai. Bound as above: the gate sets the switch, and providers/openrouter-catalog.js still reads it (what it
// blocks — only the REAL base — is held by openrouter-catalog.test.js).
// COUNTER-TEST: delete the line `testEnv.CBASE_OPENROUTER_OFFLINE = "1";` in check.mjs => this test red ("check.mjs no longer sets CBASE_OPENROUTER_OFFLINE").
test("check.mjs switches the OpenRouter catalog offline for the suites — and openrouter-catalog.js reads the switch", () => {
  const check = fs.readFileSync(path.join(repo, "tools", "check", "targets", "check.mjs"), "utf8");
  assert.match(check, /testEnv\.CBASE_OPENROUTER_OFFLINE = "1";/, "check.mjs no longer sets CBASE_OPENROUTER_OFFLINE — every test process fetches the catalog from the network again");
  const catalog = fs.readFileSync(path.join(repo, "server", "backend", "electron", "server", "providers", "openrouter-catalog.js"), "utf8");
  assert.match(catalog, /process\.env\.CBASE_OPENROUTER_OFFLINE === "1"/, "openrouter-catalog.js no longer reads CBASE_OPENROUTER_OFFLINE — the switch in the gate would be decoration");
});

// The gate's time dials. They are the reason the suite runs in minutes instead of hours — and each one is a number in the PRODUCT that
// must be smaller in the test. Both are checked: the gate sets them, and the product READS them. A variable that only appears in the
// call is decoration; one that only the product knows never takes effect. Plus the two dials for foreign machines: check.mjs must
// READ them, otherwise a set variable has no effect.
test("the time dials are set in the gate AND read in the product", () => {
  const check = fs.readFileSync(path.join(repo, "tools/check/targets/check.mjs"), "utf8");
  assert.match(check, /process\.env\.CBASE_SUITE_TIMEOUT_MS/, "check.mjs does not read the suites' emergency cap — the variable has no effect");
  assert.match(check, /process\.env\.CBASE_SUITE_STALL_MS/, "check.mjs does not read the suites' stall deadline — the variable has no effect");
  assert.match(check, /process\.env\.CBASE_TEST_CONCURRENCY/, "check.mjs does not read the concurrency — the variable has no effect");
  const slider = [
    // Wait before resuming after a limit — ten tests each waited 45 s of real wall clock.
    ["CBASE_LIMIT_GRACE_MS", "server/backend/electron/server/limits.js"],
    ["CBASE_LIMIT_MIN_WAIT_MS", "server/backend/electron/server/limits.js"],
    // The auto-continue sweeper. 60 s in production; the gate's most expensive test spent 60 of 72 s on it because a row hit a running
    // chat and went on by ONE beat.
    ["CBASE_SWEEP_MS", "server/backend/electron/server/runs/limit-gate.js"],
    // The subagents' stall deadline — here LARGER than in production: in the gate only the test seam triggers a stall, never a fake
    // child waiting under load.
    ["CBASE_AGENT_STALL_MS", "server/backend/electron/server/providers/agent-runtime.js"],
    // The limit per section of a dynamic workflow — fixed in the gate so a guard with an endless loop does not hold the test process for 30 s.
    ["CBASE_DYNWF_SECTION_MS", "server/backend/electron/server/dynworkflows/sandbox.js"],
    // The workflow agents' concurrency: both caps machine-independent, the staggering off.
    ["CBASE_DYNWF_RUN_CAP", "server/backend/electron/server/dynworkflows/cap.js"],
    ["CBASE_DYNWF_USER_CAP", "server/backend/electron/server/dynworkflows/cap.js"],
    ["CBASE_DYNWF_STAGGER_MS", "server/backend/electron/server/dynworkflows/cap.js"],
    // The workflow agents' stall deadline — like the subagents' LARGER than in production.
    ["CBASE_DYNWF_STALL_MS", "server/backend/electron/server/providers/agent-runtime.js"],
    // The cap per restore stage of the project containers — LARGER than in production (clock seam in the test).
    ["CBASE_PROJECT_STAGE_MS", "server/backend/electron/server/projectbox/restore.js"],
    // How long the main agent waits for a subagent — never in production, in the gate as before.
    ["CBASE_MAIN_AGENT_WAIT_MS", "server/backend/electron/server/providers/agent-wait.js"],
  ];
  for (const [name, source] of slider) {
    assert.match(check, new RegExp(name), `${name} is not set by the gate — the suite waits out the production time again`);
    const src = fs.readFileSync(path.join(repo, source), "utf8");
    // The NAME must occur, not a particular access form: `limits.js` goes through the helper `envMs("NAME", default)`, `limit-gate.js`
    // directly through `process.env`. Both are right; a guarantee on `process.env.NAME` would only have measured my own spelling.
    assert.ok(src.includes(name), `${source} does not read ${name} — the line in the gate has no effect`);
    // LAZY, not at module load: a test sets its environment at the file head, and the import order would otherwise decide the value.
    // Hence the access sits in a function (arrow or declaration), never in a `const X = Number(process.env…)` at the edge.
    const row = src.split("\n").find((z) => z.includes(name)) || "";
    assert.match(row, /=>|function|return/, `${name} is read in ${source} at module load: ${row.trim().slice(0, 100)}`);
  }
});

// ---------------------------------------------------------------------------------------------
// The named exception. On Linux the gate unavoidably skips four tests; their TITLES are in `latch.json` under `onlyMacOS`. The guard
// stays sharp because it measures in BOTH directions — and because the titles are read, not counted.

test("expected skips pass, every other one stays red", () => {
  const r = run(`${HEADER}test("runs", () => assert.ok(true));
test("macOS only", (t) => { t.skip("the window comes from \`security\` (macOS only)"); });
`);
  const without = valuesSuite("Probe", r.stdout, r.code);
  assert.equal(without.red, true, "without the list every skip must be red — otherwise today's guard is gone");

  const including = valuesSuite("Probe", r.stdout, r.code, { expectedSkips: ["macOS only"] });
  console.log(`  [expected skip] ${including.line} → ${including.red ? "red" : "green"}`);
  assert.equal(including.red, false, including.reason);
  assert.deepEqual(including.title, ["macOS only"], "the titles are read, not just counted");

  // The decisive corner: a SECOND, unregistered skip does not slip through the same list. Without it the exception would be a free
  // pass for the whole suite.
  const two = run(`${HEADER}test("macOS only", (t) => { t.skip("x"); });
test("something else entirely", (t) => { t.skip("node_modules missing (tsc)"); });
`);
  const u = valuesSuite("Probe", two.stdout, two.code, { expectedSkips: ["macOS only"] });
  assert.equal(u.red, true, "an unregistered skip passed next to a registered one");
  assert.deepEqual(u.unexpected, ["something else entirely"]);
  assert.match(u.reason, /skipped unexpectedly/);
});

test("a registered skip that no longer skips at all is red — the list may only shrink", () => {
  const r = run(`${HEADER}test("macOS only", () => assert.ok(true));\n`);
  const u = valuesSuite("Probe", r.stdout, r.code, { expectedSkips: ["macOS only"] });
  console.log(`  [exception obsolete] ${u.reason}`);
  assert.equal(u.red, true, "an exception that covers nothing any more would otherwise stay invisible forever");
  assert.deepEqual(u.absent, ["macOS only"]);
  assert.match(u.reason, /latch\.json/);
});

test("when the skip detection no longer fits the output, the hard rule applies again", () => {
  // Built, not measured: exactly the case that cannot be produced without changing node — `# skipped 2`, but no readable `# SKIP`
  // line. A guard that a format change dulls would be worse than one that fires too often.
  const stdout = "TAP version 13\nok 1 - anything\n1..1\n# tests 1\n# pass 1\n# fail 0\n# skipped 2\n";
  const u = valuesSuite("Probe", stdout, 0, { expectedSkips: ["macOS only"] });
  assert.equal(u.red, true);
  assert.match(u.reason, /skip detection no longer fits/);
});

test("the onlyMacOS list in latch.json is well-formed and names real files", () => {
  const raw = JSON.parse(fs.readFileSync(path.join(repo, "tools/check/latch.json"), "utf8"));
  const n = raw.onlyMacOS;
  assert.ok(n && Array.isArray(n.files) && Array.isArray(n.tests), "latch.json needs onlyMacOS with files and tests");
  for (const d of n.files) {
    assert.ok(fs.existsSync(path.join(repo, d)), `${d} is under onlyMacOS but does not exist`);
    const text = fs.readFileSync(path.join(repo, d), "utf8");
    assert.match(text, /xcrun/, `${d} is under onlyMacOS but calls no xcrun — the reason is missing`);
  }
  for (const t of n.tests) {
    assert.equal(typeof t.title, "string");
    assert.ok(t.file && fs.existsSync(path.join(repo, t.file)), `${t.file} is missing`);
    // The title must REALLY occur in its file — otherwise the exception guards nothing, and the Linux run would be red with a message
    // pointing at the wrong test.
    const text = fs.readFileSync(path.join(repo, t.file), "utf8");
    assert.ok(text.includes(t.title), `the title "${t.title}" is not in ${t.file} — renamed?`);
  }
  console.log(`  [onlyMacOS] ${n.files.length} files · ${n.tests.length} single tests`);
});

// ── The environment pre-check ────────────────────────────────────────────────────────────────────────────────
test("isFlat — a `git clone --depth 1` is flat, the full clone is not, a folder without a repo is unknown", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-flat-"));
  try {
    const g = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null" } });
    const source = path.join(dir, "source");
    fs.mkdirSync(source);
    g(source, "init", "-q");
    for (const n of [1, 2]) {
      fs.writeFileSync(path.join(source, "file"), String(n));
      g(source, "add", "file");
      g(source, "commit", "-q", "-m", `c${n}`);
    }
    g(dir, "clone", "-q", "--depth", "1", `file://${source}`, "flat");
    g(dir, "clone", "-q", `file://${source}`, "full");
    const without = path.join(dir, "without");
    fs.mkdirSync(without);
    assert.equal(await isFlat(path.join(dir, "flat")), true);
    assert.equal(await isFlat(path.join(dir, "full")), false);
    assert.equal(await isFlat(without), null, "no repo is unknown, not \"full\"");
    // The verdict: the flat clone is red (and ends the gate), the full one green.
    const flat = environmentVerdict({ flat: await isFlat(path.join(dir, "flat")), uid: 501, pty: { ok: true } });
    assert.equal(flat.flat, true);
    assert.deepEqual(flat.rows[0], ["Environment: clone", FLAT_SENTENCE, "bad"]);
    assert.equal(FLAT_SENTENCE, "shallow clone — run `git fetch --unshallow` first");
    assert.deepEqual(flat.failures, [`Environment: ${FLAT_SENTENCE}`]);
    const full = environmentVerdict({ flat: await isFlat(path.join(dir, "full")), uid: 501, pty: { ok: true } });
    assert.deepEqual([full.flat, full.failures, full.rows.map((z) => z[2])], [false, [], ["ok", "ok", "ok"]]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("environment probes: injected samples (flat, root, no pty) => one named row each — red, warn, red; unknown is never ok", () => {
  const u = environmentVerdict({ flat: true, uid: 0, pty: { ok: false, error: "Error: The module '/x/pty.node'\nwas compiled against a different Node.js version using NODE_MODULE_VERSION 137." } });
  const byLabel = Object.fromEntries(u.rows.map(([l, text, st]) => [l, { text, st }]));
  assert.equal(byLabel["Environment: clone"].st, "bad");
  assert.equal(byLabel["Environment: user"].st, "warn");
  assert.match(byLabel["Environment: user"].text, /^uid 0 \(root\) — chmod does not lock root out, these turn red: hosts-file\.test\.js, /);
  for (const f of ROOT_DEPENDENT) {
    assert.ok(byLabel["Environment: user"].text.includes(path.basename(f)), f);
    assert.ok(fs.existsSync(path.join(repo, f)), `${f} no longer exists — update ROOT_DEPENDENT`);
  }
  assert.equal(byLabel["Environment: node-pty"].st, "bad");
  assert.match(byLabel["Environment: node-pty"].text, /^require\('node-pty'\) does not load \(Error: The module .*\) — `npm rebuild node-pty` in server\/backend\/$/);
  assert.equal(u.failures.length, 2, "flat and pty are failures, root a warning");
  // Unknown: neither clone nor uid to ask, pty without an answer.
  const unknown = environmentVerdict({ flat: null, uid: null, pty: null });
  assert.deepEqual(unknown.rows.map((z) => z[2]), ["warn", "warn", "bad"]);
  assert.match(unknown.rows[0][1], /^unknown/);
});

test("check.mjs runs the pre-check before the first suite, a flat clone ends immediately", () => {
  const src = fs.readFileSync(path.join(here, "targets/check.mjs"), "utf8");
  const body = src.slice(src.indexOf("export async function check("));
  const i = body.indexOf("const environment = environmentVerdict(await environmentMeasure());");
  assert.ok(i > 0, "check() does not measure the environment");
  assert.ok(i < body.indexOf("// 1. Syntax of every backend file"), "the pre-check is not before the checks");
  assert.match(body.slice(i), /^const environment = environmentVerdict\(await environmentMeasure\(\)\);\n\s*log\.table\(environment\.rows\);\n\s*if \(environment\.flat\) throw new Error\([^\n]*FLAT_SENTENCE[^\n]*\);\n\s*failures\.push\(\.\.\.environment\.failures\);/);
});

// The account does not belong in the gate. `account/usage.js` reads the keychain on macOS via the `security` command; a test without
// its own replacement thus read the Mac's real account state, and at 100 % in the session window a test turn parked until the reset.
// Both are bound: the gate puts a `security` that finds nothing at the front of the PATH and strips the token from the shell — and
// usage.js still calls the command under that name (otherwise the replacement would be decoration).
test("check.mjs keeps the keychain and the account token out of the suites — and usage.js still calls `security`", () => {
  const check = fs.readFileSync(path.join(repo, "tools", "check", "targets", "check.mjs"), "utf8");
  assert.match(check, /fs\.writeFileSync\(path\.join\(fakeAccount, "security"\), "#!\/bin\/sh\\nexit 1\\n"/, "check.mjs no longer creates a `security` that finds nothing — a test reads the real account state again");
  assert.match(check, /testEnv\.PATH = `\$\{fakeAccount\}\$\{path\.delimiter\}/, "the replacement is no longer at the FRONT of the suites' PATH");
  assert.match(check, /delete testEnv\.CLAUDE_CODE_OAUTH_TOKEN;/, "check.mjs passes CLAUDE_CODE_OAUTH_TOKEN from the shell through to the suites");
  const usage = fs.readFileSync(path.join(repo, "server", "backend", "electron", "server", "account", "usage.js"), "utf8");
  assert.match(usage, /execFile\("security", args/, "usage.js no longer calls the keychain via `security` — the replacement in the gate would be decoration");
  assert.match(usage, /process\.env\.CLAUDE_CODE_OAUTH_TOKEN/, "usage.js no longer reads CLAUDE_CODE_OAUTH_TOKEN — the strip in the gate would be decoration");
});

// The machine's git-lfs: on a machine with git-lfs installed (the GitHub ubuntu runner: /usr/bin/git-lfs and `filter.lfs.process`
// in /etc/gitconfig) every checkout of a `filter=lfs` repo in the suites went to the tests' fake git-lfs, which speaks no filter
// protocol (project-clone hung), and "without git-lfs" cases took the LFS path. Bound: the gate switches git's system file off and
// puts a `git-lfs` in front that answers EXACTLY what the product reads as "no git-lfs" (runtime/git-run.js lfsFetch) — if
// the product's recognition changes, the stub would silently stop meaning "absent".
// COUNTER-TEST: delete the line `testEnv.GIT_CONFIG_NOSYSTEM = "1";` or the stub line in check.mjs, or the GIT_CONFIG_NOSYSTEM part of
// the exec env in fake-docker.mjs => this test red (and project-clone (K1) stalls again on a machine with system-wide git-lfs).
test("check.mjs takes the machine's git-lfs out of the suites — system config off, a git-lfs that answers like a git without it", () => {
  const check = fs.readFileSync(path.join(repo, "tools", "check", "targets", "check.mjs"), "utf8");
  assert.match(check, /testEnv\.GIT_CONFIG_NOSYSTEM = "1";/, "check.mjs no longer switches git's system configuration off — a system-wide git-lfs hands every test checkout to the fake git-lfs");
  const stub = /fs\.writeFileSync\(path\.join\(fakeAccount, "git-lfs"\), "#!\/bin\/sh\\necho \\"(.+?)\\" >&2\\nexit 1\\n"/.exec(check);
  assert.ok(stub, "check.mjs no longer puts its git-lfs in front of PATH — a machine's git-lfs is found by every test again");
  const gitRun = fs.readFileSync(path.join(repo, "server", "backend", "electron", "server", "runtime", "git-run.js"), "utf8");
  const recognition = /if \(!\/(.+?)\/\.test\(String\(ls\.stderr \|\| ""\)\)\) return/.exec(gitRun);
  assert.ok(recognition, "runtime/git-run.js lfsFetch: the recognition of a missing git-lfs is not found — update this guard");
  assert.match(stub[1], new RegExp(recognition[1]), "the gate's git-lfs no longer answers what the product reads as \"no git-lfs\"");
  // The fake docker's "container" is this machine and gets only PATH, HOME and the -e values — the switch has to ride along, or
  // every git the product runs in a project container reads /etc/gitconfig again (project-clone hung exactly there).
  const fakeDocker = fs.readFileSync(path.join(repo, "server", "backend", "test", "fake-docker.mjs"), "utf8");
  assert.match(fakeDocker, /const env = \{ PATH: process\.env\.PATH, HOME: process\.env\.HOME, \.\.\.\(process\.env\.GIT_CONFIG_NOSYSTEM \? \{ GIT_CONFIG_NOSYSTEM: process\.env\.GIT_CONFIG_NOSYSTEM \} : \{\}\), \.\.\.c\.env \};/,
    "fake-docker.mjs exec no longer hands GIT_CONFIG_NOSYSTEM into its container — the gate's switch stops at the container boundary");
});

// The Playwright MCP in the npx cache: every server start prewarms it in the background, in the suites hundreds at once — on a cold
// cache (fresh CI runner) concurrent npx installs into one folder, and a real MCP start died with MODULE_NOT_FOUND. The gate warms
// it once before the suites, with the package read from the product's pin. Bound: the read gives exactly the product's package (the
// one the real-MCP test starts too), a renamed pin throws instead of warming nothing, and check.mjs warms BEFORE runSuites.
// COUNTER-TEST: delete the `npx -y` probe line in check.mjs => "warms before the suites" red; rename PLAYWRIGHT_MCP_VERSION in a
// copy => the throw.
test("check.mjs warms the pinned Playwright MCP in the npx cache before the suites — the package read from toolchain/playwright.js", () => {
  const source = fs.readFileSync(path.join(repo, "server", "backend", "electron", "server", "toolchain", "playwright.js"), "utf8");
  const pin = /^const PLAYWRIGHT_MCP_VERSION = "([^"]+)";$/m.exec(source)[1];
  assert.equal(playwrightMcpPackage(), `@playwright/mcp@${pin}`);
  const realMcpTest = fs.readFileSync(path.join(repo, "server", "backend", "test", "agent-user-browser.test.js"), "utf8");
  assert.match(realMcpTest, new RegExp(`const PW_MCP = "${playwrightMcpPackage().replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}";`), "the real-MCP test starts a different package than the one the gate warms");
  assert.throws(() => playwrightMcpPackage(source.replace("PLAYWRIGHT_MCP_VERSION = ", "PLAYWRIGHT_MCP_PIN = ")), /not found/, "sabotage: a renamed pin warms nothing and stays green");
  assert.throws(() => playwrightMcpPackage(source.replace("`@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`", "`@playwright/mcp@latest`")), /not found/, "sabotage: a package that no longer follows the pin");
  const check = fs.readFileSync(path.join(repo, "tools", "check", "targets", "check.mjs"), "utf8");
  const warm = check.indexOf('probe(process.env.NPX_BIN || "npx", ["-y", mcp, "--version"]');
  const suites = check.indexOf("results = await runSuites(");
  assert.ok(warm > 0 && suites > 0 && warm < suites, "check.mjs no longer warms the Playwright MCP before the suites");
});

// The chats' browser: every turn of a coding chat starts it — in the suites a real Chromium per test turn. Bound as above: the gate switches it
// off, and devtools/user-browser.js reads the switch.
test("check.mjs switches the chats' browser off for the suites — and user-browser.js reads the switch", () => {
  const check = fs.readFileSync(path.join(repo, "tools", "check", "targets", "check.mjs"), "utf8");
  assert.match(check, /testEnv\.CBASE_CHAT_BROWSER_OFF = "1";/, "check.mjs does not switch the chats' browser off — every test turn would start a Chromium");
  const nb = fs.readFileSync(path.join(repo, "server", "backend", "electron", "server", "devtools", "user-browser.js"), "utf8");
  assert.match(nb, /process\.env\.CBASE_CHAT_BROWSER_OFF === "1"/, "user-browser.js does not read CBASE_CHAT_BROWSER_OFF — the switch in the gate would be decoration");
});
