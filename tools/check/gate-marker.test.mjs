// Guard for the gate marker (lib/gate-marker.mjs): a full green gate remembers the working tree; `deploy` repeats the suites
// only if the bytes changed or the marker is old. Proves (1) the hash sees EVERY change of the working tree — changed, new,
// deleted — and not ignored files, (2) the validity rule with its four reasons, (3) in the source: the marker is written ONLY
// after the green verdict of a full gate, never on the quick path, (4) SCOPE: a marker serves only a request of its own scope
// whose suites it covers, (5) ONE PER MACHINE: the files lie outside the clone, and the key a second clone is asked with holds
// what such a clone can have differently — the ops working tree and the installed dependencies.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { workingTreeHash, gateKey, depsFingerprint, DEP_DIRS, gateMarkerApplies, readGateMarker, writeGateMarker, markerFile, MARKER_FILES, MARKER_DIR } from "./lib/gate-marker.mjs";
import { REPO } from "./config-repo.mjs";
import { PRIVATE_ROOT } from "./cleanliness.mjs";
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
  assert.match(check, /const treeHash = quick \? "" : await gateKey\(\)/, "the key is taken BEFORE the suites and not on the quick path");
  // Writer and both readers use the same key — a reader on the bare tree hash would never match a written key (or worse, the other way round).
  for (const f of [path.join(HERE, "run.mjs"), path.join(HERE, "..", "deploy", "deploy.mjs")]) {
    const src = fs.readFileSync(f, "utf8");
    assert.match(src, /readGateMarker\(markerFile\([^)]*\)\), await gateKey\(\)/, `${path.basename(f)} asks the marker with gateKey()`);
    assert.doesNotMatch(src, /workingTreeHash/, `${path.basename(f)} still uses the bare tree hash`);
  }
});

// ── one marker per machine, valid across clones ───────────────────────────────────────────────
const writeInstalled = (repo, dir, packages, extra = {}) => {
  fs.mkdirSync(path.join(repo, dir, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(repo, dir, "node_modules", ".package-lock.json"), JSON.stringify({ name: "x", lockfileVersion: 3, ...extra, packages }, null, 2));
};

test("the marker files lie outside the clone, so a rollout clone reads what the development clone wrote", () => {
  for (const f of Object.values(MARKER_FILES)) {
    assert.equal(path.dirname(f), MARKER_DIR);
    assert.ok(!path.resolve(f).startsWith(path.resolve(REPO) + path.sep), `${f} lies inside the clone — a second clone never sees it`);
  }
});

test("deps fingerprint: same installed packages = same, whatever the root name or formatting; another version or a missing install = different", () => {
  const a = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-deps-a-"));
  const b = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-deps-b-"));
  try {
    const pk = { "": { name: "x" }, "node_modules/left-pad": { version: "1.3.0", integrity: "sha512-AAA", resolved: "https://r/left-pad-1.3.0.tgz" } };
    for (const d of DEP_DIRS) { writeInstalled(a, d, pk, { name: "old-name" }); writeInstalled(b, d, pk); }
    fs.appendFileSync(path.join(b, "web", "node_modules", ".package-lock.json"), "\n  ");
    assert.equal(depsFingerprint(a), depsFingerprint(b), "root name and whitespace do not count");
    writeInstalled(b, "web", { ...pk, "node_modules/left-pad": { ...pk["node_modules/left-pad"], version: "1.3.1", integrity: "sha512-BBB" } });
    assert.notEqual(depsFingerprint(a), depsFingerprint(b), "another installed version counts");
    writeInstalled(b, "web", pk);
    assert.equal(depsFingerprint(a), depsFingerprint(b));
    fs.rmSync(path.join(b, "client", "node_modules"), { recursive: true });
    assert.notEqual(depsFingerprint(a), depsFingerprint(b), "a folder without npm ci never matches one with");
  } finally {
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  }
});

test("gate key: two clones of the same commit match; ops working tree and installed deps each make them differ", async () => {
  const dev = tempRepo();
  const roll = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-gate-roll-"));
  try {
    execFileSync("git", ["clone", "-q", dev, roll], { stdio: "ignore" });
    for (const r of [dev, roll]) {
      fs.mkdirSync(path.join(r, PRIVATE_ROOT));
      git(path.join(r, PRIVATE_ROOT), "init", "-q", "-b", "main");
      git(path.join(r, PRIVATE_ROOT), "-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
      fs.writeFileSync(path.join(r, PRIVATE_ROOT, "note.md"), "n\n");
      for (const d of DEP_DIRS) writeInstalled(r, d, { "node_modules/a": { version: "1.0.0" } });
    }
    // The private folder is ignored by the outer repo in the real tree; here too.
    for (const r of [dev, roll]) fs.appendFileSync(path.join(r, ".git", "info", "exclude"), `${PRIVATE_ROOT}/\nnode_modules/\n`);
    const kd = await gateKey(dev);
    assert.match(kd, /^[0-9a-f]{40}\+ops:[0-9a-f]{16}\+deps:[0-9a-f]{16}\+env:[0-9a-f]{16}$/);
    assert.equal(await gateKey(roll), kd, "same commit, same ops, same deps — the rollout clone is served by the dev clone's marker");
    fs.writeFileSync(path.join(roll, PRIVATE_ROOT, "note.md"), "older\n");
    const opsDiff = await gateKey(roll);
    assert.notEqual(opsDiff, kd, "another ops working tree is another key");
    const marker = { hash: kd, stamp: NOW - 60_000, node: process.version, result: "green", scope: "ops", suites: ["Backend"] };
    assert.match(gateMarkerApplies(marker, opsDiff, { scope: "ops", suites: ["Backend"], now: NOW }).reason, /working tree changed \(ops [0-9a-f]{12} → [0-9a-f]{12}\)$/, "the reason names the part that differs");
    fs.writeFileSync(path.join(roll, PRIVATE_ROOT, "note.md"), "n\n");
    writeInstalled(roll, "server/backend", { "node_modules/a": { version: "2.0.0" } });
    const depsDiff = await gateKey(roll);
    assert.notEqual(depsDiff, kd, "other installed dependencies are another key");
    assert.match(gateMarkerApplies(marker, depsDiff, { scope: "ops", suites: ["Backend"], now: NOW }).reason, /\(deps /);
    // A git repository the private clone keeps ignored (the old-history bare clone its suites read): missing in one clone = other key.
    writeInstalled(roll, "server/backend", { "node_modules/a": { version: "1.0.0" } });
    for (const r of [dev, roll]) fs.appendFileSync(path.join(r, PRIVATE_ROOT, ".git", "info", "exclude"), "/.history.git/\n");
    fs.mkdirSync(path.join(dev, PRIVATE_ROOT, ".history.git", "objects"), { recursive: true });
    fs.writeFileSync(path.join(dev, PRIVATE_ROOT, ".history.git", "HEAD"), "ref: refs/heads/main\n");
    assert.notEqual(await gateKey(roll), await gateKey(dev), "the ignored history clone missing in one clone counts");
    fs.cpSync(path.join(dev, PRIVATE_ROOT, ".history.git"), path.join(roll, PRIVATE_ROOT, ".history.git"), { recursive: true });
    assert.equal(await gateKey(roll), await gateKey(dev));
    // Without an ops clone the key has no ops part (the public tree on its own).
    fs.rmSync(path.join(roll, PRIVATE_ROOT), { recursive: true });
    assert.doesNotMatch(await gateKey(roll), /\+ops:/);
  } finally {
    fs.rmSync(dev, { recursive: true, force: true });
    fs.rmSync(roll, { recursive: true, force: true });
  }
});

test("gate key, environment: a CBASE_* variable, an ignored symlink and a native file's mode each change it; a private folder without git is unknown", async () => {
  const repo = tempRepo();
  const saved = process.env.CBASE_GATE_KEY_PROBE;
  try {
    fs.appendFileSync(path.join(repo, ".git", "info", "exclude"), "node_modules/\nlinked\n");
    const helper = path.join(repo, "server/backend/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper");
    fs.mkdirSync(path.dirname(helper), { recursive: true });
    fs.writeFileSync(helper, "bin");
    fs.chmodSync(helper, 0o755);
    const k0 = await gateKey(repo);
    assert.match(k0, /\+env:[0-9a-f]{16}$/);
    assert.equal(await gateKey(repo), k0, "stable");
    process.env.CBASE_GATE_KEY_PROBE = "1";
    assert.notEqual(await gateKey(repo), k0, "a CBASE_* variable in the caller's environment counts");
    delete process.env.CBASE_GATE_KEY_PROBE;
    assert.equal(await gateKey(repo), k0);
    fs.symlinkSync("a.txt", path.join(repo, "linked"));
    assert.notEqual(await gateKey(repo), k0, "an ignored symlink (the private overlay) counts");
    fs.unlinkSync(path.join(repo, "linked"));
    assert.equal(await gateKey(repo), k0);
    fs.chmodSync(helper, 0o644);
    assert.notEqual(await gateKey(repo), k0, "spawn-helper without +x after an npm ci counts — the lockfile alone would not see it");
    fs.chmodSync(helper, 0o755);
    assert.equal(await gateKey(repo), k0);
    fs.mkdirSync(path.join(repo, PRIVATE_ROOT));
    fs.writeFileSync(path.join(repo, PRIVATE_ROOT, "x"), "copied\n");
    assert.equal(await gateKey(repo), "", "a private folder without its own git cannot be hashed: unknown, never served");
  } finally {
    if (saved === undefined) delete process.env.CBASE_GATE_KEY_PROBE; else process.env.CBASE_GATE_KEY_PROBE = saved;
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("in the source: the key is taken again after the suites — a changed tree gets no marker; the suites run without deploy.local.json", () => {
  const check = fs.readFileSync(path.join(HERE, "targets", "check.mjs"), "utf8");
  const write = check.indexOf("writeGateMarker({");
  const again = check.indexOf("const keyAfter = treeHash ? await gateKey() : \"\";");
  assert.ok(again !== -1 && again < write, "the key is not re-taken before the marker is written");
  assert.match(check.slice(again, write), /if \(treeHash && keyAfter !== treeHash\) \{\n\s+log\.detail\([^\n]*\n\s+return;\n\s+\}/, "a changed key must end without a marker");
  assert.match(check, /testEnv\.CBASE_DEPLOY_LOCAL = "off";/, "the suites must not read the installation's deploy.local.json");
  const config = fs.readFileSync(path.join(HERE, "..", "deploy", "config.mjs"), "utf8");
  const from = config.slice(config.indexOf("function fromFile()"), config.indexOf("function fromEnv()"));
  assert.ok(from.indexOf('process.env.CBASE_DEPLOY_LOCAL === "off"') !== -1 && from.indexOf('process.env.CBASE_DEPLOY_LOCAL === "off"') < from.indexOf("readFileSync"), "config.mjs reads deploy.local.json although the gate switched it off");
});

test("a marker that cannot be written leaves the gate green: it says why and is not there", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-marker-ro-"));
  try {
    fs.writeFileSync(path.join(dir, "file"), "x");
    const m = writeGateMarker({ hash: "a".repeat(40), result: "green", file: path.join(dir, "file", "gate-ok.json"), scope: "public", suites: ["Backend"] });
    assert.match(m.notWritten, /ENOTDIR|EEXIST|not a directory/i);
    const check = fs.readFileSync(path.join(HERE, "targets", "check.mjs"), "utf8");
    assert.match(check, /if \(marker\?\.notWritten\) log\.detail\(/, "check.mjs must report the unwritten marker, not throw");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// COUNTER-PROOF, built in: a copy of gate-marker.mjs whose key leaves out the ops part, resp. the deps part, gives the two clones
// above the SAME key although they differ — the key test would then be idle.
test("counter-proof: without the ops, deps or environment part in the key, differing clones would share a marker", async () => {
  const src = fs.readFileSync(path.join(HERE, "lib/gate-marker.mjs"), "utf8");
  const probes = [];
  const load = async (name, text) => {
    const p = path.join(HERE, "lib", `.probe-${process.pid}-${name}-gate-marker.mjs`);
    fs.writeFileSync(p, text);
    probes.push(p);
    return import(`${p}?x=${name}`);
  };
  const swap = (from, to) => { assert.ok(src.includes(from), `gone from gate-marker.mjs: ${from} — move the counter-proof, do NOT delete it`); return src.replace(from, to); };
  const a = tempRepo();
  const b = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-gate-cp-"));
  try {
    execFileSync("git", ["clone", "-q", a, b], { stdio: "ignore" });
    for (const r of [a, b]) {
      fs.mkdirSync(path.join(r, PRIVATE_ROOT));
      git(path.join(r, PRIVATE_ROOT), "init", "-q", "-b", "main");
      git(path.join(r, PRIVATE_ROOT), "-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
      fs.appendFileSync(path.join(r, ".git", "info", "exclude"), `${PRIVATE_ROOT}/\nnode_modules/\n`);
    }
    fs.writeFileSync(path.join(a, PRIVATE_ROOT, "x"), "1\n");
    fs.writeFileSync(path.join(b, PRIVATE_ROOT, "x"), "2\n");
    const noOps = await load("noops", swap("key += `+ops:${ops.slice(0, 16)}`;", ""));
    assert.equal(await noOps.gateKey(a), await noOps.gateKey(b), "relaxed copy still tells the ops trees apart — the ops test is idle");
    assert.notEqual(await gateKey(a), await gateKey(b));
    fs.writeFileSync(path.join(b, PRIVATE_ROOT, "x"), "1\n");
    writeInstalled(b, "web", { "node_modules/a": { version: "9.9.9" } });
    const noDeps = await load("nodeps", swap("return `${key}+deps:${depsFingerprint(repo)}+env:${env}`;", "return `${key}+env:${env}`;"));
    assert.equal(await noDeps.gateKey(a), await noDeps.gateKey(b), "relaxed copy still tells the installs apart — the deps test is idle");
    assert.notEqual(await gateKey(a), await gateKey(b));
    writeInstalled(b, "web", {});
    fs.rmSync(path.join(b, "web"), { recursive: true });
    assert.equal(await gateKey(a), await gateKey(b), "fixture: the two clones match again");
    process.env.CBASE_GATE_KEY_PROBE = "x";
    const kb = await gateKey(b);
    delete process.env.CBASE_GATE_KEY_PROBE;
    assert.notEqual(kb, await gateKey(a));
    const noEnv = await load("noenv", swap("for (const k of Object.keys(process.env).filter((k) => k.startsWith(\"CBASE_\")).sort()) h.update(`env\\t${k}=${process.env[k]}\\n`);", ""));
    process.env.CBASE_GATE_KEY_PROBE = "x";
    const relaxed = await noEnv.gateKey(b);
    delete process.env.CBASE_GATE_KEY_PROBE;
    assert.equal(relaxed, await noEnv.gateKey(a), "relaxed copy still sees the CBASE_* variable — the environment test is idle");
  } finally {
    for (const p of probes) fs.rmSync(p, { force: true });
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  }
});
