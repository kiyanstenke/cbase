// Guard for the gate plans (lib/gate-plans.mjs): WHAT the gate runs is data, `check({ plan })` takes it.
//
// Proves (1) the public plan is complete in itself — same suites, same order, same commands the public gate runs, (2) a suite
// without directory or without files is an ERROR with a reason, never a silent `echo 'none'`, (3) the merge (with a stand-in plan:
// the real private plan is held by the maintainer's private suite), (4) in the source: check.mjs holds no second copy of what the plan
// carries, and every search term these anchors use still exists (an anchor that runs into the void measures nothing).
//
// COUNTER-PROOFS stand beside the properties: a plan builder that is made to skip silently, and a merge that loses a suite, are caught
// by the same measurement.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { REPO } from "./config-repo.mjs";
import { PRIVATE_ROOT } from "./cleanliness.mjs";
import { shortParallelism } from "./lib/gate-plan.mjs";
import { guardInTree, readRegister } from "./lib/guard-register.mjs";
import { DEFAULT_PLAN, PUBLIC_PLAN, buildSuites, mergePlans, planGlobs, planSuiteNames, suiteContext } from "./lib/gate-plans.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(HERE, p), "utf8");
const commandOf = (c) => (typeof c === "function" ? c() : c);

function ctxFor(plan, repo = REPO, over = {}) {
  const read = fs.existsSync(path.join(repo, plan.registerFile))
    ? readRegister(path.join(repo, plan.registerFile), planGlobs(plan))
    : { raw: null, files: null };
  return suiteContext({ plan, repo, NODE_TEST: "NT", fastDeadlines: "FD", cores: 14, registerRaw: read.raw, registerFiles: read.files, getBackend: () => ({ count: 7 }), onMac: true, ...over });
}

test("the default plan is the public plan: the seven suites in the order the public gate prints them", () => {
  assert.equal(DEFAULT_PLAN, PUBLIC_PLAN);
  assert.deepEqual(planSuiteNames(PUBLIC_PLAN), ["Backend", "Gateway", "Web", "Client", "Gate tool", "Deploy tool", "macOS"]);
  assert.equal(PUBLIC_PLAN.markerScope, "public");
  assert.equal(PUBLIC_PLAN.manifest, null, "the public plan carries no manifest-diff step");
  assert.ok(fs.existsSync(path.join(REPO, PUBLIC_PLAN.registerFile)), `${PUBLIC_PLAN.registerFile} missing`);
  assert.ok(fs.existsSync(path.join(REPO, PUBLIC_PLAN.locAllowFile)), `${PUBLIC_PLAN.locAllowFile} missing`);
});

test("the public plan builds exactly the commands the public gate runs (golden, with stand-in fragments)", () => {
  const ctx = ctxFor(PUBLIC_PLAN);
  const { suites, errors } = buildSuites(PUBLIC_PLAN, ctx);
  assert.deepEqual(errors, []);
  const by = Object.fromEntries(suites.map(([n, c]) => [n, commandOf(c)]));
  const w = (suite) => `--test-concurrency=${shortParallelism({ cores: 14, files: ctx.count(suite) })}`;
  assert.equal(by.Backend, "FD NT --test-concurrency=7 server/backend/test/*.test.js");
  assert.equal(by.Gateway, `NT ${w("Gateway")} server/gateway/*.test.js`);
  assert.equal(by.Client, `NT ${w("Client")} client/test/*.test.mjs`);
  assert.equal(by["Gate tool"], `NT ${w("Gate tool")} tools/check/*.test.mjs`, "the public plan must run the whole directory by glob");
  assert.equal(by["Deploy tool"], `NT ${w("Deploy tool")} tools/deploy/*.test.mjs`, "the public plan must run the deploy tool's whole directory by glob");
  assert.match(by.Web, new RegExp(`^NT --test-concurrency=\\d+ web/test/\\S+\\.mjs( web/test/\\S+\\.mjs)*$`));
  assert.ok(!by.Web.includes("geometry-binding"), "a macOS-only file runs in the web suite");
  assert.match(by.macOS, /^NT --test-concurrency=\d+ web\/test\/\S+\.mjs/);
});

// ── missing suite directory / files fail LOUDLY ─────────────────────────────────────────────────
function emptyRepo(layout) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-plan-repo-"));
  for (const [rel, files] of Object.entries(layout)) {
    fs.mkdirSync(path.join(dir, rel), { recursive: true });
    for (const f of files) fs.writeFileSync(path.join(dir, rel, f), "");
  }
  return dir;
}

test("a suite whose directory is missing or holds no test files is an error with a reason — never a silent 'none'", () => {
  const full = { "server/backend/test": ["a.test.js"], "server/gateway": ["g.test.js"], "client/test": ["c.test.mjs"], "tools/check": ["d.test.mjs"], "tools/deploy": ["e.test.mjs"], "web/test": ["w.mjs"] };
  const ctxIn = (repo) => suiteContext({
    plan: PUBLIC_PLAN, repo, NODE_TEST: "NT", fastDeadlines: "FD", cores: 4,
    registerRaw: { onlyMacOS: { files: [], tests: [] } }, registerFiles: ["web/test/w.mjs"], getBackend: () => ({ count: 3 }), onMac: false,
  });
  const green = emptyRepo(full);
  try {
    assert.deepEqual(buildSuites(PUBLIC_PLAN, ctxIn(green)).errors, [], "fixture: a complete repo builds");
  } finally { fs.rmSync(green, { recursive: true, force: true }); }

  for (const [dir, suite] of [["server/gateway", "Gateway"], ["client/test", "Client"], ["tools/check", "Gate tool"], ["tools/deploy", "Deploy tool"], ["server/backend/test", "Backend"]]) {
    // (a) the directory is gone
    const without = Object.fromEntries(Object.entries(full).filter(([k]) => k !== dir));
    const repo = emptyRepo(without);
    try {
      const e = buildSuites(PUBLIC_PLAN, ctxIn(repo)).errors.find((x) => x.name === suite);
      assert.ok(e, `${suite}: a missing ${dir} is not an error`);
      assert.match(e.message, /missing|silently run nothing/, `${suite}: the reason does not say what is wrong`);
    } finally { fs.rmSync(repo, { recursive: true, force: true }); }
    // (b) the directory is there, without a single test file
    const empty = emptyRepo({ ...full, [dir]: ["README.md"] });
    try {
      const e = buildSuites(PUBLIC_PLAN, ctxIn(empty)).errors.find((x) => x.name === suite);
      assert.ok(e, `${suite}: a directory without test files is not an error`);
      assert.match(e.message, /holds no test file/);
    } finally { fs.rmSync(empty, { recursive: true, force: true }); }
  }
  // The web suite without register files, a plan suite without a builder: errors too.
  const repo = emptyRepo(full);
  try {
    const noWeb = suiteContext({ plan: PUBLIC_PLAN, repo, NODE_TEST: "NT", fastDeadlines: "FD", cores: 4, registerRaw: null, registerFiles: null, getBackend: () => ({ count: 3 }), onMac: false });
    assert.ok(buildSuites(PUBLIC_PLAN, noWeb).errors.some((x) => x.name === "Web"));
    const bare = { ...PUBLIC_PLAN, suites: [{ name: "Naked", glob: { dir: "x", ext: ".mjs", matches: () => true } }] };
    assert.match(buildSuites(bare, noWeb).errors[0].message, /no builder/);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test("the register reads a missing suite directory as an error, not as an empty direction", () => {
  const repo = emptyRepo({ "server/gateway": ["g.test.js"] });
  try {
    assert.throws(() => guardInTree(repo, planGlobs(PUBLIC_PLAN)), /directory .* is missing/);
    assert.throws(() => guardInTree(repo, []), /no globs/);
    assert.deepEqual(guardInTree(repo, planGlobs(PUBLIC_PLAN).filter((g) => g.suite === "Gateway")), ["server/gateway/g.test.js"]);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test("check.mjs turns a suite that cannot be built into a red row and a failure — before the verdict", () => {
  const check = read("targets/check.mjs");
  const loop = check.indexOf("for (const e of built.errors) {");
  assert.notEqual(loop, -1, "the loop over build errors is gone — a suite without files would run nothing silently");
  assert.match(check.slice(loop, loop + 300), /log\.table\(\[\[`\$\{e\.name\} tests`, e\.message, "bad"\]\]\);\s*failures\.push\(`\$\{e\.name\} tests: \$\{e\.message\}`\);/);
  assert.ok(loop < check.indexOf("await runSuites(suites"), "the errors are reported after the suites ran");
  assert.ok(check.indexOf("await runSuites(suites") < check.lastIndexOf("if (failures.length) throw new Error(`Checks failed:\\n  - ${failures.join"), "order: suites → verdict");
});

test("check.mjs turns a suite that cannot be built into a red row and a failure — before the verdict", () => {
  const check = read("targets/check.mjs");
  const loop = check.indexOf("for (const e of built.errors) {");
  assert.notEqual(loop, -1, "the loop over build errors is gone — a suite without files would run nothing silently");
  assert.match(check.slice(loop, loop + 300), /log\.table\(\[\[`\$\{e\.name\} tests`, e\.message, "bad"\]\]\);\s*failures\.push\(`\$\{e\.name\} tests: \$\{e\.message\}`\);/);
  assert.ok(loop < check.indexOf("await runSuites(suites"), "the errors are reported after the suites ran");
  assert.ok(check.indexOf("await runSuites(suites") < check.lastIndexOf("if (failures.length) throw new Error(`Checks failed:\\n  - ${failures.join"), "order: suites → verdict");
});

// ── the merge ──────────────────────────────────────────────────────────────────────────────────────
// A stand-in for the private plan (the real one lives in the maintainer's private part, held by its own suite).
const EXTRA = { markerScope: "ops", registerFile: "x/latch.json", manifest: "x/manifest.json", suites: [
  { name: "Gate tool", glob: { dir: "tools/check", ext: ".test.mjs", matches: (n) => n.endsWith(".extra.test.mjs") } },
  { name: "Extra", build() { return "echo extra"; }, after: "Gate tool" },
] };

test("mergePlans: widens a suite of the same name, inserts a new one after its predecessor, refuses a bad one — and loses nothing", () => {
  const m = mergePlans(PUBLIC_PLAN, EXTRA);
  const gw = planGlobs(m).find((g) => g.suite === "Gate tool");
  assert.equal(gw.matches("x.test.mjs"), true);
  assert.equal(gw.matches("x.extra.test.mjs"), true);
  assert.equal(planGlobs(PUBLIC_PLAN).find((g) => g.suite === "Gate tool").matches("x.extra.test.mjs"), true, "fixture: the public matcher takes every .test.mjs");
  assert.equal(PUBLIC_PLAN.suites.length, 7, "the merge changed the public plan in place");
  assert.deepEqual(planSuiteNames(m).slice(-4), ["Gate tool", "Extra", "Deploy tool", "macOS"]);
  assert.equal(m.markerScope, "ops");
  assert.throws(() => mergePlans(PUBLIC_PLAN, { ...EXTRA, suites: [{ name: "Y", build() {}, after: "Nope" }] }), /wants to follow Nope/);
  assert.throws(() => mergePlans(PUBLIC_PLAN, { ...EXTRA, suites: [{ name: "Web", glob: { dir: "elsewhere", ext: ".mjs", matches: () => true } }] }), /different directory/);
  // COUNTER-PROOF: every public suite survives the merge — dropping one would be seen here.
  for (const n of planSuiteNames(PUBLIC_PLAN)) assert.ok(planSuiteNames(m).includes(n), `${n} fell out of the merge`);
  assert.deepEqual(planSuiteNames(mergePlans(PUBLIC_PLAN, { markerScope: "ops", suites: [] })), planSuiteNames(PUBLIC_PLAN));
});

// ── the source: no second copy of what the plan carries ─────────────────────────────────────────────
const without = (src) => src.replace(/^[ \t]*\/\/.*$/gm, "").replace(/[ \t]\/\/ .*$/gm, "");

test("check.mjs takes the plan: no hard-coded register file, line-count file, manifest or marker scope", () => {
  const check = read("targets/check.mjs");
  const code = without(check);
  assert.match(check, /export async function check\(\{ quick = false, quickReason = "--quick", plan = DEFAULT_PLAN, short = false \} = \{\}\)/);
  assert.match(code, /\[\]\.concat\(plan\.registerFile\)/);
  assert.match(code, /locGate\(REPO, path\.join\(REPO, plan\.locAllowFile\)\)/);
  assert.match(code, /const MANIFEST = plan\.manifest \? path\.join\(REPO, plan\.manifest\) : null;/);
  assert.match(code, /if \(MANIFEST && manifest && manifestOpen\(manifest\)\)/);
  assert.match(code, /scope: plan\.markerScope, suites: planSuiteNames\(plan\)/);
  for (const hardcoded of ["latch.json", "loc-allow.json", `${PRIVATE_ROOT}/`, "Split tool", "Deploy tool", "Gate tool", "tools/deploy"]) {
    assert.ok(!code.includes(hardcoded), `check.mjs still names ${hardcoded} in code — that belongs to the plan`);
  }
  // The plan module holds what is public, and nothing of the private part in code.
  const plans = read("lib/gate-plans.mjs");
  for (const term of ["tools/check/latch.json", "tools/check/loc-allow.json", "Gate tool", "\"Deploy tool\", \"tools/deploy\""]) {
    assert.ok(plans.includes(term), `${term} is not in gate-plans.mjs — the plan lost it`);
  }
  // The deploy tool is public (tools/deploy, suite "Deploy tool"); its private remainder is the private plan's.
  for (const term of [`${PRIVATE_ROOT}/`, "Deploy tool (private)", "Split tool", "Migration tool", "Export tool", "Overlay tool"]) {
    assert.ok(!without(plans).includes(term), `gate-plans.mjs names ${term} in code — the private plan belongs to the private part`);
  }
});

test("gate-plans.mjs stands on public ground: node built-ins and the gate's own libraries only", () => {
  const imports = [...read("lib/gate-plans.mjs").matchAll(/^import .* from "([^"]+)"/gm)].map((m) => m[1]);
  assert.deepEqual(imports.sort(), ["./gate-plan.mjs", "./guard-register.mjs", "node:fs", "node:path"]);
});
