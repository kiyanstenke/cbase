// Guard for the gate marker (lib/gate-marker.mjs): a full green gate remembers the working tree; `deploy` repeats the suites
// only if the bytes changed or the marker is old. Proves (1) the hash sees EVERY change of the working tree — changed, new,
// deleted — and not ignored files, (2) the validity rule with its four reasons, (3) in the source: the marker is written ONLY
// after the green verdict of a full gate, never on the quick path, (4) SCOPE: a marker serves only a request of its own scope
// whose suites it covers.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { workingTreeHash, gateMarkerApplies, readGateMarker, writeGateMarker, markerFile, MARKER_FILES } from "./lib/gate-marker.mjs";
import { DEFAULT_PLAN, PUBLIC_PLAN, mergePlans, planSuiteNames } from "./lib/gate-plans.mjs";

// A stand-in for the private plan on top of the public one (the real one lives in the maintainer's private part): the ops scope, two more suites.
const MERGED_PLAN = mergePlans(PUBLIC_PLAN, { markerScope: "ops", suites: [{ name: "Deploy tool (private)", build() { return "x"; } }, { name: "Split tool", build() { return "x"; } }] });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const git = (repo, ...args) => execFileSync("git", ["-C", repo, ...args], { stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).toString();

function tempRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-gate-marker-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@example.invalid");
  git(repo, "config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  fs.writeFileSync(path.join(repo, ".gitignore"), "ignored/\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  return repo;
}

// The request of a plan about to be skipped: its scope and its suites.
const REQUEST = { scope: "public", suites: ["Backend", "Web"] };

test("working-tree hash: changed, new and deleted change it — ignored files and a revert do not", async () => {
  const repo = tempRepo();
  try {
    const h0 = await workingTreeHash(repo);
    assert.match(h0, /^[0-9a-f]{40}$/);
    assert.equal(await workingTreeHash(repo), h0, "same tree twice, same hash twice");

    fs.writeFileSync(path.join(repo, "a.txt"), "b\n");
    const changed = await workingTreeHash(repo);
    assert.notEqual(changed, h0, "a changed file changes the hash");
    fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
    assert.equal(await workingTreeHash(repo), h0, "reverted means the same hash");

    fs.writeFileSync(path.join(repo, "fresh.txt"), "n\n");
    assert.notEqual(await workingTreeHash(repo), h0, "an UNTRACKED new file changes the hash");
    fs.unlinkSync(path.join(repo, "fresh.txt"));

    fs.mkdirSync(path.join(repo, "ignored"));
    fs.writeFileSync(path.join(repo, "ignored", "x.log"), "x\n");
    assert.equal(await workingTreeHash(repo), h0, "ignored files do not count");

    fs.unlinkSync(path.join(repo, "a.txt"));
    assert.notEqual(await workingTreeHash(repo), h0, "a deleted file changes the hash");

    // The throwaway index must not touch the real one: the deletion is NOT staged.
    assert.equal(git(repo, "diff", "--cached", "--name-only").trim(), "");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("working-tree hash: no git repo => empty, and empty never applies", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-no-repo-"));
  try {
    assert.equal(await workingTreeHash(dir), "");
    assert.equal(gateMarkerApplies({ hash: "", stamp: Date.now(), node: process.version, scope: "public", suites: ["Backend"] }, "", REQUEST).applies, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validity: four reasons for no, and the yes names time, hash and result", () => {
  const now = 1_790_000_000_000;
  const hash = "0123456789abcdef0123456789abcdef01234567";
  const marker = { hash, stamp: now - 5 * 60_000, node: process.version, result: "Backend pass 901 fail 0 skipped 0", scope: "public", suites: ["Backend", "Web"] };
  const ask = { ...REQUEST, now };
  assert.equal(gateMarkerApplies(null, hash, ask).reason, "no marker");
  assert.match(gateMarkerApplies(marker, "f".repeat(40), ask).reason, /working tree changed/);
  assert.match(gateMarkerApplies({ ...marker, node: "v0.0.0" }, hash, ask).reason, /node changed/);
  assert.match(gateMarkerApplies({ ...marker, stamp: now - 61 * 60_000 }, hash, ask).reason, /too old \(61 min\)/);
  assert.match(gateMarkerApplies({ ...marker, stamp: now + 60_000 }, hash, ask).reason, /too old/, "a marker from the future does not apply");
  const yes = gateMarkerApplies(marker, hash, ask);
  assert.equal(yes.applies, true);
  assert.match(yes.reason, /full gate green at \d{2}:\d{2} on the same working tree \(0123456789ab, 5 min ago\): Backend pass 901/);
});

// ── scope and suites ─────────────────────────────────────────────────────────────────────────
const NOW = 1_790_000_000_000;
const HASH = "0123456789abcdef0123456789abcdef01234567";
const marker = (scope, suites) => ({ hash: HASH, stamp: NOW - 60_000, node: process.version, result: "green", scope, suites });

test("scope: a marker written for \"public\" never satisfies an \"ops\" request — and the other way round", () => {
  const suites = ["Backend", "Web"];
  assert.equal(gateMarkerApplies(marker("public", suites), HASH, { scope: "public", suites, now: NOW }).applies, true, "fixture: the matching scope applies");
  const no = gateMarkerApplies(marker("public", suites), HASH, { scope: "ops", suites, now: NOW });
  assert.equal(no.applies, false);
  assert.match(no.reason, /scope public ≠ requested scope ops$/);
  assert.equal(gateMarkerApplies(marker("ops", suites), HASH, { scope: "public", suites, now: NOW }).applies, false);
  // Old markers (no scope) and requests without scope or suites never apply: not saying what is needed is not served from a marker.
  assert.equal(gateMarkerApplies({ ...marker("public", suites), scope: undefined }, HASH, { scope: "public", suites, now: NOW }).applies, false);
  assert.equal(gateMarkerApplies(marker("public", suites), HASH, { now: NOW }).applies, false);
  assert.equal(gateMarkerApplies(marker("public", suites), HASH, { scope: "public", now: NOW }).applies, false);
});

test("suites: a marker with fewer suites does not satisfy a larger plan; more suites do satisfy a smaller one", () => {
  const small = marker("ops", ["Backend", "Web"]);
  const no = gateMarkerApplies(small, HASH, { scope: "ops", suites: ["Backend", "Web", "Split tool"], now: NOW });
  assert.equal(no.applies, false);
  assert.match(no.reason, /marker lacks suites: Split tool/);
  assert.equal(gateMarkerApplies(marker("ops", ["Backend", "Web", "Split tool"]), HASH, { scope: "ops", suites: ["Backend", "Web"], now: NOW }).applies, true);
  assert.equal(gateMarkerApplies({ ...small, suites: undefined }, HASH, { scope: "ops", suites: ["Backend"], now: NOW }).applies, false, "a marker without a suites list covers nothing");
});

// COUNTER-PROOF, built in: the same two properties against a COPY of gate-marker.mjs with the scope line, resp. the suites line,
// cut out. If the copy still refused, the tests above would measure nothing; they must turn red on the relaxed copy.
test("counter-proof: relax the scope check or the suites check in a copy of the module — the properties above break", async () => {
  const src = fs.readFileSync(path.join(HERE, "lib/gate-marker.mjs"), "utf8");
  const probes = [];
  const load = async (name, text) => {
    const p = path.join(HERE, "lib", `.probe-${process.pid}-${name}-gate-marker.mjs`);
    fs.writeFileSync(p, text);
    probes.push(p);
    return import(`${p}?x=${name}`);
  };
  const cut = (needle) => {
    const i = src.indexOf(needle);
    assert.notEqual(i, -1, `the line to relax is gone from gate-marker.mjs: ${needle} — move the counter-proof, do NOT delete it`);
    const e = src.indexOf("\n", i);
    return src.slice(0, i) + src.slice(e + 1);
  };
  try {
    const suites = ["Backend", "Web"];
    const noScope = await load("scope", cut("if (marker.scope !== scope)"));
    assert.equal(noScope.gateMarkerApplies(marker("public", suites), HASH, { scope: "ops", suites, now: NOW }).applies, true, "relaxed copy still refuses a foreign scope — the scope test is idle");
    const noSuites = await load("suites", cut("if (missing.length)"));
    assert.equal(noSuites.gateMarkerApplies(marker("ops", ["Backend"]), HASH, { scope: "ops", suites, now: NOW }).applies, true, "relaxed copy still refuses missing suites — the suites test is idle");
    // And the real module refuses both.
    assert.equal(gateMarkerApplies(marker("public", suites), HASH, { scope: "ops", suites, now: NOW }).applies, false);
    assert.equal(gateMarkerApplies(marker("ops", ["Backend"]), HASH, { scope: "ops", suites, now: NOW }).applies, false);
  } finally {
    for (const p of probes) fs.rmSync(p, { force: true });
  }
});

test("files per scope: public keeps gate-ok.json, ops has its own; an unknown scope is an error", () => {
  assert.equal(path.basename(markerFile("public")), "gate-ok.json");
  assert.equal(path.basename(markerFile("ops")), "ops-gate-ok.json");
  assert.notEqual(MARKER_FILES.public, MARKER_FILES.ops);
  assert.throws(() => markerFile("private"), /unknown marker scope/);
  // The plans' scopes are the scopes that have a file.
  for (const p of [PUBLIC_PLAN, MERGED_PLAN, DEFAULT_PLAN]) assert.ok(MARKER_FILES[p.markerScope], `${p.markerScope} has no marker file`);
  assert.equal(MERGED_PLAN.markerScope, "ops", "a plan that runs the private suites too has the ops marker");
  assert.equal(DEFAULT_PLAN, PUBLIC_PLAN, "the public gate runs the public plan");
  assert.equal(PUBLIC_PLAN.markerScope, "public");
});

test("the marker of a plan covers exactly its suites: a public marker does not cover the merged plan", () => {
  const ranPublic = marker("public", planSuiteNames(PUBLIC_PLAN));
  assert.equal(gateMarkerApplies(ranPublic, HASH, { scope: "public", suites: planSuiteNames(PUBLIC_PLAN), now: NOW }).applies, true);
  assert.equal(gateMarkerApplies(ranPublic, HASH, { scope: "ops", suites: planSuiteNames(MERGED_PLAN), now: NOW }).applies, false);
  // Same scope written, but only the public suites run: the merged request (Split tool on top) is not covered.
  assert.equal(gateMarkerApplies(marker("ops", planSuiteNames(PUBLIC_PLAN)), HASH, { scope: "ops", suites: planSuiteNames(MERGED_PLAN), now: NOW }).applies, false);
});

test("write and read: no marker without a hash; a broken file reads as none", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-marker-"));
  const file = path.join(dir, "gate-ok.json");
  try {
    assert.equal(writeGateMarker({ hash: "", result: "x", file, scope: "public", suites: ["Backend"] }), null);
    assert.equal(fs.existsSync(file), false, "nothing is written without a hash");
    const m = writeGateMarker({ hash: "a".repeat(40), result: "green", file, now: 123, scope: "ops", suites: ["Backend", "Web"] });
    assert.deepEqual(readGateMarker(file), m);
    assert.equal(m.scope, "ops");
    assert.deepEqual(m.suites, ["Backend", "Web"]);
    assert.throws(() => writeGateMarker({ hash: "a".repeat(40), result: "green", file, scope: "ops" }), /suites that were run/, "a marker without its suites is refused");
    fs.writeFileSync(file, "{broken");
    assert.equal(readGateMarker(file), null);
    fs.writeFileSync(file, JSON.stringify({ hash: 5, stamp: 1 }));
    assert.equal(readGateMarker(file), null, "a hash that is no string is no marker");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("in the source: the marker arises exactly once, after the green verdict, behind the quick path — ", () => {
  const check = fs.readFileSync(path.join(HERE, "targets", "check.mjs"), "utf8");
  const write = check.indexOf("writeGateMarker({");
  assert.notEqual(write, -1, "check.mjs writes the marker");
  assert.equal(check.indexOf("writeGateMarker({", write + 1), -1, "and exactly once");
  const verdict = check.indexOf('log.ok("all checks passed")');
  const thrown = check.lastIndexOf("throw new Error(`Checks failed");
  const fast = check.indexOf("if (quick) {");
  assert.ok(verdict !== -1 && thrown !== -1 && fast !== -1);
  assert.ok(fast < thrown && thrown < verdict && verdict < write, "order: quick-path return → throw on red → green verdict → marker");
  // The written marker names the plan's scope and the suites it ran.
  assert.match(check.slice(write, write + 200), /scope: plan\.markerScope, suites: planSuiteNames\(plan\)/, "the marker is not written with the plan's scope and suites");
  assert.match(check, /const treeHash = quick \? "" : await workingTreeHash\(\)/, "the hash is taken BEFORE the suites and not on the quick path");
});
