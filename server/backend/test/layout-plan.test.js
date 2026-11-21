// The server version of the layout computation against the ONE fixture set.
//
// `projectbox/layout/plan.js` computes, for an inventory, steps → final tree, final mapping, errors and warnings — the same
// computation that web (`web/src/lib/project-layout.ts`, `web/test/project-layout-plan.test.mjs`) and iOS
// (`Code/ProjectLayout.swift`, `web/test/layout-ios-binding.test.mjs`) run in the preview. If the server computed differently, the
// project tab would show one final tree and applying it would execute another — a folder would silently end up elsewhere.
//
// What holds here (per case `server/backend/test/fixtures/layout-plan/<name>.json`, form in the README there):
//   - EVERY case of the set, both modes: the fields finalTree, mapping, finalMapping, codeRepos, repos, error, warnings and the
//     target paths (`targetOf`) — field by field, so the message says WHICH statement differs. The creation cases run with the tree
//     of their expectation (`expected.tree`): the selection in the client (`treeFromSelection`) does not exist on the server, the web
//     test holds that the selection yields EXACTLY this tree. `tree`, `hints`, `omitted` and `upload` are the client's business.
//   - the mandatory cases of the spec are in the set (as in the web test);
//   - the rules of the set (`_rules.json`) are `rulesResponse()` of the server without `reserveBytes`.
//
// COUNTER-TESTS
//   (a) built-in sabotage: an expectation with swapped target paths turns the comparison red (below, runs every time).
//   (b) run against the code: `targetOf` with the SHORTEST instead of the longest prefix (`e.from.length < best.from.length`)
//       => 5 red (child-from-moved-parent-folder, longest-prefix, folder-empty, steps-and-names, leave-out-in-parent); NOT carrying
//       the children along through the parent link (`const carriedOver = x.start;` — every child of a moved folder would get its own
//       entry) => 8 red, among them the inventory case inventory-final-mapping ("only the topmost affected nodes"). Not covered: a
//       term in the condition of the final mapping — without it a child would drop out that is pushed back to EXACTLY its old
//       path when the parent folder moves; the set has no such case (gap).
//
// Run (one file alone, with the gate deadlines as in ./check):
//   env -u NODE_TEST_CONTEXT CBASE_LIMIT_GRACE_MS=2000 CBASE_LIMIT_MIN_WAIT_MS=2000 CBASE_SWEEP_MS=2000 \
//     CBASE_AGENT_STALL_MS=3600000 CBASE_EMBED_OFFLINE=1 node --test --test-reporter=tap server/backend/test/layout-plan.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { mappingFromEnd, computePlan, targetOf } from "../electron/server/projectbox/layout/plan.js";
import { rulesResponse } from "../electron/server/projectbox/setup/rules.js";

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "layout-plan");
const rules = JSON.parse(fs.readFileSync(path.join(FIX, "_rules.json"), "utf8"));
const cases = fs.readdirSync(FIX).filter((f) => f.endsWith(".json") && !f.startsWith("_")).sort()
  .map((f) => JSON.parse(fs.readFileSync(path.join(FIX, f), "utf8")));

// What only the client computes (treeFromSelection) — not compared on the server (see header).
const ONLY_CLIENT = new Set(["tree", "hints", "omitted", "upload"]);

/** One case computed, in the form of its expectation (without the client's fields). */
function compute(fall) {
  const tree = fall.selection ? fall.expected.tree : fall.tree;
  assert.ok(Array.isArray(tree), `${fall.name}: no tree`);
  const plan = computePlan(structuredClone(tree), fall.steps, rules, fall.mode);
  const holds = {
    finalTree: plan.finalTree, mapping: plan.mapping, finalMapping: plan.finalMapping,
    codeRepos: plan.codeRepos, repos: plan.repos, error: plan.error, warnings: plan.warnings,
  };
  holds.targets = fall.expected.targets.map(({ source, origin }) => {
    const z = targetOf(plan.mapping[String(source)] || [], origin);
    return z === undefined ? { source, origin } : { source, origin, target: z };
  });
  return holds;
}

function compare(fall, holds) {
  for (const field of Object.keys(fall.expected)) {
    if (ONLY_CLIENT.has(field)) continue;
    assert.deepStrictEqual(holds[field], fall.expected[field], `${fall.name}: ${field}`);
  }
}

test("the fixture set carries the mandatory cases of the spec and cases of both modes", () => {
  const names = new Set(cases.map((f) => f.name));
  for (const n of ["longest-prefix", "child-from-moved-parent-folder", "leave-out-in-parent", "swap", "repo-in-repo", "repo-locations-and-26-repos", "inventory-swap-and-subtree", "inventory-final-mapping"]) {
    assert.ok(names.has(n), `mandatory case “${n}” is missing — whoever renames it updates this list`);
  }
  assert.ok(cases.some((f) => f.mode === "inventory"), "at least one inventory case");
  assert.ok(cases.some((f) => f.mode === "creation"), "at least one creation case");
  for (const f of cases) assert.ok(f.expected && Array.isArray(f.expected.finalTree), `${f.name}: without expectation`);
  console.log(`# fixture set: ${cases.length} cases (${cases.filter((f) => f.mode === "inventory").length} inventory)`);
});

for (const fall of cases) {
  test(`case ${fall.name} (${fall.mode}): ${fall.description}`, () => {
    compare(fall, compute(fall));
  });
}

test("the rules of the fixtures are those of the server (rulesResponse() without reserveBytes)", () => {
  const r = rulesResponse();
  delete r.reserveBytes;
  // `mode` (container | folder) is a statement about the operation, not a rule — `rulesResponse` does not carry it; the route adds it
  // (creationMode). If it ever appears in the response, it shows here.
  assert.deepStrictEqual(rules, r);
});

test("built-in sabotage: an expectation with swapped target paths turns the comparison red", () => {
  const fall = structuredClone(cases.find((f) => f.name === "longest-prefix"));
  const list = fall.expected.mapping["1"];
  assert.ok(list.length >= 2, "the case needs two entries to swap");
  [list[0].to, list[1].to] = [list[1].to, list[0].to];
  assert.throws(() => compare(fall, compute(fall)), /longest-prefix: mapping/);
  // The same in the inventory: a swapped target of the final mapping shows.
  const b = structuredClone(cases.find((f) => f.name === "inventory-swap-and-subtree"));
  const w = b.expected.finalMapping.ways;
  assert.ok(w.length >= 2, "the inventory case needs two ways to swap");
  [w[0].fresh, w[1].fresh] = [w[1].fresh, w[0].fresh];
  assert.throws(() => compare(b, compute(b)), /inventory-swap-and-subtree: finalMapping/);
});

test("mappingFromEnd + targetOf: the inventory maps every path through the longest old prefix", () => {
  // The check procedure (read.js) computes with it where a Compose folder, a bind source or a service folder moves to.
  const fall = cases.find((f) => f.name === "inventory-swap-and-subtree");
  const plan = computePlan(structuredClone(fall.tree), fall.steps, rules, "inventory");
  const abb = mappingFromEnd(plan.finalMapping);
  for (const { old, fresh } of plan.finalMapping.ways) {
    assert.equal(targetOf(abb, old), fresh);
    assert.equal(targetOf(abb, `${old}/deep/file`), `${fresh}/deep/file`);
  }
  for (const old of plan.finalMapping.gone) assert.equal(targetOf(abb, `${old}/x`), null);
  assert.equal(targetOf(abb, "exists/es/not"), undefined, "an untouched path stays (undefined)");
});
