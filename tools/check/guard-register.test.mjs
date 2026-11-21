// The guard over the guard register.
//
// Three kinds, and the third is what makes the register trustworthy at all:
//
//  1. The pure computation (two lists, no file system).
//  2. The real register against the real tree.
//  3. The globs of every gate PLAN against the suites of that plan (lib/gate-plans.mjs). Without this corner the register would be
//     a second truth next to the gate: if a suite dropped out of a plan or one was added, the register would silently guard the
//     wrong set. The globs are an argument of every register function now (one code path for the public and the ops plan; the ops
//     plan and its register are held by the maintainer's private suite).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { guardInTree, readRegister, guardRegister, guardRegisterText, suiteOf } from "./lib/guard-register.mjs";
import { PUBLIC_PLAN, buildSuites, planGlobs, planSuiteNames, suiteContext } from "./lib/gate-plans.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const REGISTER = path.join(REPO, "tools/check/latch.json");

test("the pure computation: disappeared, unregistered, duplicate", () => {
  const equal = guardRegister(["a/x.test.js", "b/y.test.mjs"], ["a/x.test.js", "b/y.test.mjs"]);
  assert.equal(equal.ok, true);
  assert.equal(equal.count, 2);

  const way = guardRegister(["a/x.test.js"], ["a/x.test.js", "b/y.test.mjs"]);
  assert.equal(way.ok, false);
  assert.deepEqual(way.disappeared, ["b/y.test.mjs"]);
  assert.match(way.violations[0], /latch\.json/, "the message must say where to fix it");
  assert.match(way.violations[0], /justif/, "and that a deletion needs a justification");

  const fresh = guardRegister(["a/x.test.js", "b/y.test.mjs"], ["a/x.test.js"]);
  assert.equal(fresh.ok, false);
  assert.deepEqual(fresh.loggedOut, ["b/y.test.mjs"]);

  const two = guardRegister(["a/x.test.js"], ["a/x.test.js", "a/x.test.js"]);
  assert.equal(two.ok, false);
  assert.deepEqual(two.duplicate, ["a/x.test.js"]);
});

// The real register against the real tree, with the globs of the public plan. The register file carries the public suites only: the
// private part has its own register, read together with this one by the merged plan.
test("the real register covers the real tree, both directions — public plan", (t) => {
  const globs = planGlobs(PUBLIC_PLAN);
  const { files } = readRegister(path.join(REPO, PUBLIC_PLAN.registerFile), globs);
  const tree = guardInTree(REPO, globs);
  const r = guardRegister(tree, files);
  t.diagnostic(`[guard register public] ${guardRegisterText(r)}`);
  assert.equal(r.ok, true, r.violations.join("\n"));
  // The count goes in the printed line, NOT in the title: a number in a title ages silently.
  assert.ok(r.count > 100, `only ${r.count} test files found — did a glob move?`);
});

test("the public register names no file of the private part", () => {
  const raw = JSON.parse(fs.readFileSync(REGISTER, "utf8"));
  // The `.ops.test.mjs` halves (the half of a split test that touches the deploy tool) live beside the deploy tool in tools/deploy,
  // never in another public suite; the private remainder's tests stand in the private register alone.
  for (const [suite, list] of Object.entries(raw)) {
    if (!Array.isArray(list) || suite === "Deploy tool") continue;
    assert.ok(!list.some((n) => n.endsWith(".ops.test.mjs")), `${suite} registers an .ops test`);
  }
  for (const s of ["Deploy tool (private)", "Split tool", "Migration tool", "Export tool", "Overlay tool"]) assert.ok(!(s in raw), `the private suite ${s} stands in the public register`);
});

// The drift between a plan's suites and its globs: the suites that have a glob are exactly the glob suites, the others are macOS.
// Pure over the plan, so the counter-proof below can hand it a damaged copy.
function suiteGlobDrift(plan) {
  const globSuites = planGlobs(plan).map((g) => g.suite).sort();
  const withGlob = plan.suites.filter((s) => s.glob).map((s) => s.name).sort();
  const without = plan.suites.filter((s) => !s.glob).map((s) => s.name).sort();
  const out = [];
  if (JSON.stringify(globSuites) !== JSON.stringify(withGlob)) out.push("globs and glob suites differ");
  if (JSON.stringify(without) !== JSON.stringify(["macOS"])) out.push(`suites without a glob must be exactly macOS, found: ${without.join(", ") || "none"}`);
  if (new Set(planSuiteNames(plan)).size !== plan.suites.length) out.push("a suite name stands twice");
  return out;
}

function contextFor(plan, over = {}) {
  const globs = planGlobs(plan);
  const read = readRegister(path.join(REPO, plan.registerFile), globs);
  return suiteContext({
    plan, repo: REPO, NODE_TEST: "NT", fastDeadlines: "FD", cores: 14, registerRaw: read.raw, registerFiles: read.files,
    getBackend: () => ({ count: 7 }), onMac: true, ...over,
  });
}
const commandOf = (c) => (typeof c === "function" ? c() : c);

test("every suite of every plan is covered by its globs, and every glob is the directory its suite command runs", () => {
  for (const plan of [PUBLIC_PLAN]) {
    assert.deepEqual(suiteGlobDrift(plan), [], `${plan.markerScope}: suites and globs have drifted apart`);
    const built = buildSuites(plan, contextFor(plan));
    assert.deepEqual(built.errors, [], `${plan.markerScope}: a suite cannot be built`);
    assert.deepEqual(built.suites.map(([n]) => n), planSuiteNames(plan));
    for (const [name, cmd] of built.suites) {
      const g = planGlobs(plan).find((x) => x.suite === name);
      // Web runs over the register's list, macOS over onlyMacOS; every other suite names its directory with the extension pattern
      // (or, for a part of a directory, its files).
      if (name === "macOS") assert.match(commandOf(cmd), /^NT --test-concurrency=\d+ web\/test\//, "the macOS suite does not run the register's macOS files");
      else if (name === "Web") assert.match(commandOf(cmd), new RegExp(`${g.dir}/`));
      else assert.match(commandOf(cmd), new RegExp(`${g.dir.replace(/\//g, "\\/")}\\/(\\*${g.ext.replace(".", "\\.")}|[^ ]+${g.ext.replace(".", "\\.")})`), `the command of ${name} does not run ${g.dir}`);
    }
  }
  // The macOS suite must not start on a foreign machine: it would fail at xcrun instead of not starting, and the Linux run would
  // always be red.
  const mac = buildSuites(PUBLIC_PLAN, contextFor(PUBLIC_PLAN, { onMac: false })).suites.find(([n]) => n === "macOS");
  assert.equal(commandOf(mac[1]), "echo 'none'", "the macOS suite starts on a foreign platform");
  // And the register's glob of each suite maps files back to that suite.
  for (const g of planGlobs(PUBLIC_PLAN)) assert.equal(suiteOf(`${g.dir}/x${g.ext}`, planGlobs(PUBLIC_PLAN)), g.suite);
});

test("counter-proof: a plan that lost a glob, gained a suite without one, or repeats a name is reported", () => {
  const noGlob = { ...PUBLIC_PLAN, suites: PUBLIC_PLAN.suites.map((s) => (s.name === "Client" ? { name: s.name, build: s.build } : s)) };
  assert.ok(suiteGlobDrift(noGlob).some((d) => /exactly macOS/.test(d)), "a suite without a glob went unnoticed");
  const extra = { ...PUBLIC_PLAN, suites: [...PUBLIC_PLAN.suites, { name: "Extra", build: () => "true" }] };
  assert.ok(suiteGlobDrift(extra).length > 0, "a suite added without a glob went unnoticed");
  const twice = { ...PUBLIC_PLAN, suites: [...PUBLIC_PLAN.suites, PUBLIC_PLAN.suites[0]] };
  assert.ok(suiteGlobDrift(twice).some((d) => /twice/.test(d)), "a repeated suite went unnoticed");
  assert.deepEqual(suiteGlobDrift(PUBLIC_PLAN), []);
});

test("both directions per plan: a vanished or an unregistered file is red with the globs of THAT plan", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-register-plan-"));
  try {
    fs.mkdirSync(path.join(dir, "d"));
    for (const n of ["a.test.mjs", "b.test.mjs", "b.ops.test.mjs"]) fs.writeFileSync(path.join(dir, "d", n), "");
    const pub = [{ suite: "D", dir: "d", matches: (n) => n.endsWith(".test.mjs") && !n.endsWith(".ops.test.mjs") }];
    const ops = [{ suite: "D", dir: "d", matches: (n) => n.endsWith(".test.mjs") }];
    const file = path.join(dir, "latch.json");
    fs.writeFileSync(file, JSON.stringify({ D: ["a.test.mjs", "b.test.mjs", "b.ops.test.mjs"] }));
    // The same register, two plans: each is green for itself when it reads with its globs.
    assert.equal(guardRegister(guardInTree(dir, pub), readRegister(file, pub, { strict: false }).files).ok, true);
    assert.equal(guardRegister(guardInTree(dir, ops), readRegister(file, ops).files).ok, true);
    // Strict reading of the PUBLIC globs sees the ops line as a stray registration (the gate with a full plan relies on this).
    assert.equal(guardRegister(guardInTree(dir, pub), readRegister(file, pub).files).ok, false);
    // A file in the tree that no line registers: red for the plan whose glob matches it, silent for the plan whose glob does not.
    fs.writeFileSync(path.join(dir, "d", "c.ops.test.mjs"), "");
    assert.equal(guardRegister(guardInTree(dir, ops), readRegister(file, ops).files).loggedOut.length, 1);
    assert.equal(guardRegister(guardInTree(dir, pub), readRegister(file, pub, { strict: false }).files).ok, true);
    // A vanished file: red.
    fs.rmSync(path.join(dir, "d", "a.test.mjs"));
    assert.deepEqual(guardRegister(guardInTree(dir, pub), readRegister(file, pub, { strict: false }).files).disappeared, ["d/a.test.mjs"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the register names only files that exist: no directory, no helper", () => {
  const { files } = readRegister(REGISTER, planGlobs(PUBLIC_PLAN));
  for (const rel of files) {
    const p = path.join(REPO, rel);
    assert.ok(fs.existsSync(p) && fs.statSync(p).isFile(), `${rel} is not a file`);
    assert.match(rel, /\.(test\.m?js|mjs)$/, `${rel} does not look like a test file`);
  }
  // Harness files do NOT belong in: they carry no tests, and a register listing them would claim promises nobody gives.
  assert.ok(!files.includes("server/backend/test/server-harness.mjs"));
  assert.ok(!files.includes("server/backend/test/golden-harness.mjs"));
});

test("a missing register is a failure, not \"then without\"", () => {
  const check = fs.readFileSync(path.join(REPO, "tools/check/targets/check.mjs"), "utf8");
  // Without this branch the file list would be empty and the gate would report GREEN because it ran nothing.
  assert.match(check, /const regMissing = regRel\.find\(\(f, i\) => !fs\.existsSync\(reg2Files\[i\]\)\);\s*\n\s*if \(regMissing\)/, "check.mjs does not treat a missing register file as an error");
  assert.match(check, /failures\.push\(`Guard register: \$\{regMissing\} missing`\)/);
  assert.match(check, /readRegister\(reg2Files, planGlobs\(plan\)\)/, "check.mjs reads the register with the plan's globs");
  assert.match(check, /guardInTree\(REPO, planGlobs\(plan\)\)/, "check.mjs reads the tree with the plan's globs");
  // The search term of every anchor above must still exist in the plan module too (a rename that leaves these void is the danger).
  assert.ok(!/GLOBS/.test(check), "check.mjs still names a hard-coded GLOBS");
  // Behaviour: with no register (registerRaw/Files null) the Web suite is an ERROR, never "none".
  const noRegister = buildSuites(PUBLIC_PLAN, suiteContext({ plan: PUBLIC_PLAN, repo: REPO, NODE_TEST: "NT", fastDeadlines: "FD", cores: 4, registerRaw: null, registerFiles: null, getBackend: () => ({ count: 3 }), onMac: true }));
  assert.ok(noRegister.errors.some((e) => e.name === "Web" && /silently run nothing/.test(e.message)), "Web without a register must be an error");
  // The web suite takes its files from the register, minus the macOS ones (else the onlyMacOS exception is void and the two Swift
  // files would run on Linux too).
  const ctx = contextFor(PUBLIC_PLAN);
  assert.ok(ctx.webFiles.length > 100);
  for (const f of ctx.onlyMac.files) assert.ok(!ctx.webFiles.includes(f), `${f} runs in the web suite although it is macOS-only`);
});
