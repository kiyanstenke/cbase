// The layout of a project as a pure computation (src/lib/project-layout.ts).
//
// It is in the GATE because it decides where every uploaded file goes: the preview shows the final tree, and the upload puts each file
// at the target path that `targetOf` computes from the mapping. If the preview computed differently from the upload, a file would
// silently land somewhere other than where the human put it, or be missing entirely — without any UI showing it.
//
// The fixture set `server/backend/test/fixtures/layout-plan/` is ONE for three calculators: this module, the Swift model
// (`layout-ios-binding.test.mjs`, macOS only) and the server (`layout-plan.test.js`). Each case carries its input (selection in the
// client or inventory tree, steps) and the expectation (tree, final tree, mapping, final mapping, error, warnings, target paths of
// single files). The rules of the cases (`_rules.json`) are those of the server — the test below holds that.
//
// Counter-test: the built-in sabotage swaps two target paths of an expectation and requires the comparison to fail. Run against the
// code (then reverted): `targetOf` with the SHORTEST instead of the longest prefix ⇒ five red (longest-prefix,
// child-from-moved-parent-folder, leave-out-in-parent, steps-and-names, targetOf); taking the children along via the PATH instead of
// the parent reference when moving ⇒ "same-names" red — only there do two nodes lie on one path, and only there would the first take
// the children of the second along.
//
// Run:  node --test web/test/project-layout-plan.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const repo = path.resolve(webDir, "..");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");
const FIX = path.join(repo, "server", "backend", "test", "fixtures", "layout-plan");

const out = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-layout-"));
execFileSync(process.execPath, [
  tsc, path.join(webDir, "src", "lib", "project-layout.ts"),
  "--outDir", out, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler",
], { stdio: "pipe" });
const { computePlan, treeFromSelection, targetOf, freeName } = await import(pathToFileURL(path.join(out, "project-layout.js")).href);
try { fs.rmSync(out, { recursive: true, force: true }); }
catch (e) { console.warn("[test] temp directory was left behind:", String(e?.message || e).slice(0, 120)); }

const rules = JSON.parse(fs.readFileSync(path.join(FIX, "_rules.json"), "utf8"));
const cases = fs.readdirSync(FIX).filter((f) => f.endsWith(".json") && !f.startsWith("_")).sort()
  .map((f) => JSON.parse(fs.readFileSync(path.join(FIX, f), "utf8")));

/** A case computed, in the form of its expectation. */
function compute(fall) {
  const holds = {};
  let tree = fall.tree;
  if (fall.selection) {
    const output = treeFromSelection(fall.selection, rules, fall.gitFiles || {});
    tree = output.node;
    holds.tree = output.node;
    holds.hints = output.hints;
    holds.omitted = output.omitted;
    holds.upload = Object.fromEntries(Object.entries(output.upload).map(([k, v]) => [k, v.map((x) => x.origin)]));
  }
  const plan = computePlan(tree, fall.steps, rules, fall.mode);
  Object.assign(holds, {
    finalTree: plan.finalTree, mapping: plan.mapping, finalMapping: plan.finalMapping,
    codeRepos: plan.codeRepos, repos: plan.repos, error: plan.error, warnings: plan.warnings,
  });
  holds.targets = fall.expected.targets.map(({ source, origin }) => {
    const z = targetOf(plan.mapping[String(source)] || [], origin);
    return z === undefined ? { source, origin } : { source, origin, target: z };
  });
  return holds;
}

/** Field by field, so the message says WHICH statement deviates. */
function compare(fall, holds) {
  for (const field of Object.keys(fall.expected)) {
    assert.deepStrictEqual(holds[field], fall.expected[field], `${fall.name}: ${field}`);
  }
}

test("the fixture set carries the mandatory cases", () => {
  const names = new Set(cases.map((f) => f.name));
  for (const n of ["longest-prefix", "child-from-moved-parent-folder", "leave-out-in-parent", "swap", "repo-in-repo", "repo-locations-and-26-repos"]) {
    assert.ok(names.has(n), `mandatory case "${n}" missing — whoever renames it updates this list`);
  }
  assert.ok(cases.some((f) => f.mode === "inventory"), "at least one inventory case");
  for (const f of cases) assert.ok(f.expected && Array.isArray(f.expected.finalTree), `${f.name}: without expectation`);
});

for (const fall of cases) {
  test(`case ${fall.name}: ${fall.description}`, () => {
    compare(fall, compute(fall));
  });
}

test("the rules of the fixtures are those of the server (GET /api/projectCreation/rules, without reserveBytes)", () => {
  // The route returns `rulesResponse()` from projectbox/setup/rules.js — the same function, called here without a server. If someone
  // changes a limit there, this test is red until the fixtures are updated and their expectations re-read.
  const source = pathToFileURL(path.join(repo, "server", "backend", "electron", "server", "projectbox", "setup", "rules.js")).href;
  const env = { ...process.env };
  delete env.CBASE_SPACE_RESERVE_BYTES;
  delete env.NODE_TEST_CONTEXT;
  const raw = execFileSync(process.execPath, ["--input-type=module", "-e",
    `const m = await import(${JSON.stringify(source)}); const r = m.rulesResponse(); delete r.reserveBytes; process.stdout.write(JSON.stringify(r));`,
  ], { env, encoding: "utf8" });
  assert.deepStrictEqual(rules, JSON.parse(raw));
});

test("built-in sabotage: an expectation with swapped target paths turns the comparison red", () => {
  const fall = structuredClone(cases.find((f) => f.name === "longest-prefix"));
  const list = fall.expected.mapping["1"];
  assert.ok(list.length >= 2, "the case needs two entries to swap");
  [list[0].to, list[1].to] = [list[1].to, list[0].to];
  assert.throws(() => compare(fall, compute(fall)), /longest-prefix: mapping/);
});

test("targetOf: no entry means undefined (caller error), an omitted prefix means null", () => {
  const mapping = [{ from: "a", to: "b" }, { from: "a/x", to: null }];
  assert.equal(targetOf(mapping, "a/y.txt"), "b/y.txt");
  assert.equal(targetOf(mapping, "a/x/z.txt"), null);
  assert.equal(targetOf(mapping, "ab/y.txt"), undefined, "\"a\" is not a prefix of \"ab\"");
  assert.equal(targetOf(mapping, "c.txt"), undefined);
});

test("freeName: suffix before the last extension, dot files and folders at the end", () => {
  const occupied = new Set(["README.md", "README-2.md", ".env", "src", "a.tar.gz"]);
  assert.equal(freeName("README.md", occupied, false), "README-3.md");
  assert.equal(freeName(".env", occupied, false), ".env-2");
  assert.equal(freeName("src", occupied, true), "src-2");
  assert.equal(freeName("a.tar.gz", occupied, false), "a.tar-2.gz");
  assert.equal(freeName("fresh", occupied, true), "fresh");
});
