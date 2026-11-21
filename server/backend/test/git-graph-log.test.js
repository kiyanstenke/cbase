// The graph of the git bar: `POST …/git/log` with `graph: "all" | "current"` (electron/server/git.js gitGraphLog). Measured on a REAL
// repo in a temp folder — git itself is the oracle (`rev-list --parents`), not a transcript of the expected graph.
//
// What hangs here and why it is a guard:
//   (a) "all" shows every commit reachable from a local or remote branch, a tag or HEAD — also a local-only one (orphan branch) and a
//       remote-only one (remote branch without a local); if one is missing the web draws a gap as the truth.
//   (b) `parents` are the parents git knows, in its order (first parent first — the lane hangs on it).
//   (c) Children before parents, and a line in one piece (`--topo-order`): the lane computation in the web (web/src/lib/git-graph.ts)
//       presupposes it; a parent above its child would tear the lane.
//   (d) Badges from `%D` with `--decorate=full`: HEAD (`kind: "head"`, `head: true` on the commit), local, remote, tag (light and
//       annotated), special characters in the name (comma, umlaut, plus); `origin/HEAD` drops out.
//   (e) The cap says it is one: `clipped` true exactly when there are older ones; never more than 500.
//   (f) "current" is HEAD with its upstream — not all branches; without upstream only HEAD.
//   (g) Without `graph` the answer stays that of today (history sheet, iOS): only `{ commits }` with five fields.
//   (h) The route passes `graph` through and rejects an unknown value with 400.
//
// COUNTER-TESTS built in (test "Counter-test"): the same checks over answers from deliberately wrong versions — without `--branches`,
// without `--remotes`, without `--topo-order`, with `--date-order`, with `--decorate=short`, without parents, `-n` without the one more.
// Each must throw; if one stays green the check measures nothing at that place.
//
// Alone:  CBASE_LIMIT_GRACE_MS=2000 CBASE_LIMIT_MIN_WAIT_MS=2000 CBASE_SWEEP_MS=2000 CBASE_AGENT_STALL_MS=3600000 \
//         CBASE_MAIN_AGENT_WAIT_MS=3600000 CBASE_EMBED_OFFLINE=1 node --test server/backend/test/git-graph-log.test.js
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import { GRAPH_FORMAT, LOG_CAP, gitLog, graphLogArgs, parseGraphLog, refsFromDeco } from "../electron/server/git.js";
import { json, makeProject, makeWorkspace, withServer } from "./server-harness.mjs";

// ── Isolation: no foreign ~/.gitconfig (log.showSignature, colors, identity) ─────────────────────────
const ISO = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cbase-git-graph-")));
after(() => {
  try { fs.rmSync(ISO, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
  catch (e) { console.warn(`[test] ${ISO} was left behind (${e.code || e.message}) — test unaffected.`); }
});
fs.mkdirSync(path.join(ISO, "home"));
fs.mkdirSync(path.join(ISO, "xdg"));
Object.assign(process.env, { HOME: path.join(ISO, "home"), XDG_CONFIG_HOME: path.join(ISO, "xdg"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS", "GIT_AUTHOR_DATE", "GIT_COMMITTER_DATE"]) delete process.env[k];

const ID = ["-c", "user.name=Testerin", "-c", "user.email=t@example.com"];
let clock = 1_790_000_000; // fixed times: the order of the tips hangs on the date
const git = (cwd, args, env = {}) => {
  // Without auto-gc/maintenance: a detached `git gc` would still write in the temp folder while `after` clears it.
  const r = spawnSync("git", ["-c", "gc.auto=0", "-c", "maintenance.auto=false", ...args], { cwd, encoding: "utf8", env: { ...process.env, ...env } });
  assert.equal(r.status, 0, `git ${args.join(" ")} in ${cwd}: ${r.stderr}`);
  return r.stdout;
};
// A commit with a file of its own; `time` (seconds) overrides the clock — for the time shift in (c).
function commit(cwd, name, time = (clock += 60)) {
  fs.writeFileSync(path.join(cwd, `${name.replace(/\W/g, "_")}.txt`), `${name}\n`);
  git(cwd, ["add", "-A"]);
  const d = `@${time} +0000`;
  git(cwd, [...ID, "commit", "-q", "-m", name], { GIT_AUTHOR_DATE: d, GIT_COMMITTER_DATE: d });
  return git(cwd, ["rev-parse", "HEAD"]).trim();
}
const SONDER = "feat/ä,b+c";

// The test repo — ONE setup for all tests (the graph is only read):
//
//   * m2           (main, HEAD)                          main is 1 ahead of origin/main
//   | * o1         (feat/ä,b+c, origin/feat/ä,b+c)       committer date OLDER than M (time shift, (c))
//   |/
//   *   M          (origin/main, tag v2 annotated)       merge of feature
//   |\
//   | * f2         (feature)                             f1, m1, f2 created alternately: interleaved by date
//   * | m1
//   | * f1
//   |/
//   | * r1         (origin/foreign)                      remote only (the local branch is deleted)
//   |/
//   * c2
//   * c1           (tag v1 light)
//   * s1           (pages)                               own root, local only (orphan)
function buildRepo() {
  const bare = path.join(ISO, "origin.git");
  const work = path.join(ISO, "proj");
  fs.mkdirSync(work);
  git(ISO, ["init", "-q", "--bare", "-b", "main", bare]);
  git(work, ["init", "-q", "-b", "main"]);
  git(work, ["remote", "add", "origin", bare]);
  const h = {};
  h.c1 = commit(work, "c1 Beginning");
  git(work, ["tag", "v1"]);
  h.c2 = commit(work, "c2 Second");
  git(work, ["checkout", "-q", "-b", "foreign"]);
  h.r1 = commit(work, "r1 remote only");
  git(work, ["push", "-q", "origin", "foreign"]);
  git(work, ["checkout", "-q", "main"]);
  git(work, ["branch", "-q", "-D", "foreign"]);
  git(work, ["checkout", "-q", "-b", "feature"]);
  h.f1 = commit(work, "f1 feature one");
  git(work, ["checkout", "-q", "main"]);
  h.m1 = commit(work, "m1 main");
  git(work, ["checkout", "-q", "feature"]);
  h.f2 = commit(work, "f2 feature two");
  git(work, ["checkout", "-q", "main"]);
  const dm = `@${(clock += 60)} +0000`;
  git(work, [...ID, "merge", "-q", "--no-ff", "-m", "M Merge feature", "feature"], { GIT_AUTHOR_DATE: dm, GIT_COMMITTER_DATE: dm });
  h.M = git(work, ["rev-parse", "HEAD"]).trim();
  git(work, [...ID, "tag", "-a", "v2", "-m", "Version 2"], { GIT_COMMITTER_DATE: dm });
  git(work, ["checkout", "-q", "-b", SONDER]);
  h.o1 = commit(work, "o1 open, dated older", clock - 3600); // (c): child with an older date than its parent
  git(work, ["push", "-q", "origin", "main", SONDER]);
  git(work, ["remote", "set-head", "origin", "main"]);
  git(work, ["checkout", "-q", "main"]);
  git(work, ["branch", "-q", "-u", "origin/main", "main"]);
  h.m2 = commit(work, "m2 local ahead");
  git(work, ["checkout", "-q", "--orphan", "pages"]);
  git(work, ["rm", "-rq", "--cached", "."]);
  for (const f of fs.readdirSync(work)) if (f !== ".git") fs.rmSync(path.join(work, f), { recursive: true, force: true });
  h.s1 = commit(work, "s1 own root", 1_780_000_000);
  git(work, ["checkout", "-q", "-f", "main"]);
  return { work, h };
}
const { work: REPO, h: H } = buildRepo();
const NAME = Object.fromEntries(Object.entries(H).map(([k, v]) => [v, k]));

// The oracle: what git itself says about these revisions.
function oracle(revs) {
  const rows = git(REPO, ["rev-list", "--parents", ...revs]).trim().split("\n").filter(Boolean);
  return new Map(rows.map((z) => { const [c, ...p] = z.split(" "); return [c, p]; }));
}
const ALL = oracle(["--branches", "--remotes", "--tags", "HEAD"]);

// ── The checks (over the ANSWER — so the counter-tests run through them too) ────────────────────────────────────────────────
function checkSet(response, expected) {
  const hashes = response.commits.map((c) => c.hash);
  assert.equal(new Set(hashes).size, hashes.length, "a commit appears twice");
  assert.deepEqual([...hashes].sort(), [...expected.keys()].sort(), `the set of commits differs: missing ${[...expected.keys()].filter((h) => !hashes.includes(h)).map((h) => NAME[h] || h).join(", ") || "—"}, too many ${hashes.filter((h) => !expected.has(h)).map((h) => NAME[h] || h).join(", ") || "—"}`);
}
function checkParent(response, expected) {
  for (const c of response.commits) assert.deepEqual(c.parents, expected.get(c.hash), `parents of ${NAME[c.hash] || c.hash}`);
}
function checkOrder(response) {
  const pos = new Map(response.commits.map((c, i) => [c.hash, i]));
  for (const c of response.commits) for (const p of c.parents) if (pos.has(p)) assert.ok(pos.get(p) > pos.get(c.hash), `${NAME[p] || p} stands before its child ${NAME[c.hash] || c.hash}`);
  // A line in one piece (--topo-order): f2 and f1 directly below each other although m1 lies between them in time.
  const i = pos.get(H.f2);
  assert.equal(response.commits[i + 1]?.hash, H.f1, `after f2 comes ${NAME[response.commits[i + 1]?.hash] || "nothing"} instead of f1 — the feature line is not in one piece`);
}
// The badges of a commit, sorted — git fixes the order in `%D` (not alphabetical), the web orders them itself.
const arrange = (refs) => [...refs].sort((x, y) => `${x.kind}\u0000${x.name}`.localeCompare(`${y.kind}\u0000${y.name}`));
const refsOf = (response, h) => { const r = response.commits.find((c) => c.hash === h)?.refs; return r ? arrange(r) : null; };
function checkRefs(response) {
  const header = response.commits.filter((c) => c.head);
  assert.deepEqual(header.map((c) => NAME[c.hash]), ["m2"], "head: true stands exactly on the commit of HEAD");
  assert.deepEqual(refsOf(response, H.m2), [{ name: "main", kind: "head" }]);
  assert.deepEqual(refsOf(response, H.M), arrange([{ name: "origin/main", kind: "remote" }, { name: "v2", kind: "tag" }]), "origin/HEAD drops out, the annotated tag stands on the commit");
  assert.deepEqual(refsOf(response, H.o1), arrange([{ name: SONDER, kind: "local" }, { name: `origin/${SONDER}`, kind: "remote" }]), "comma, umlaut and plus in the name");
  assert.deepEqual(refsOf(response, H.f2), [{ name: "feature", kind: "local" }]);
  assert.deepEqual(refsOf(response, H.r1), [{ name: "origin/foreign", kind: "remote" }]);
  assert.deepEqual(refsOf(response, H.c1), [{ name: "v1", kind: "tag" }]);
  assert.deepEqual(refsOf(response, H.s1), [{ name: "pages", kind: "local" }]);
  assert.deepEqual(refsOf(response, H.m1), []);
}
function checkAll(response) {
  assert.equal(response.extent, "all");
  assert.equal(response.clipped, false, `all ${ALL.size} commits fit under the limit — nothing is clipped`);
  checkSet(response, ALL);
  checkParent(response, ALL);
  checkOrder(response);
  checkRefs(response);
  for (const c of response.commits) {
    assert.equal(c.short, c.hash.slice(0, c.short.length));
    assert.ok(Number.isInteger(c.time) && c.time > 0, "time in Unix seconds");
    assert.equal(typeof c.relative, "string");
  }
  assert.equal(response.commits.find((c) => c.hash === H.M).subject, "M Merge feature");
}
// The cap on a window smaller than the history.
function checkClipped(response, n) {
  assert.equal(response.commits.length, n);
  assert.equal(response.clipped, true, "there are older commits — the cap must say so");
}

// ── Tests ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
test("(a)–(d) \"all\": every branch, every tag, remote branches; parents like git; children before parents, line in one piece; badges", async () => {
  checkAll(await gitLog(REPO, "", { graph: "all", limit: 100 }));
});

test("(e) cap: clipped exactly when there are older ones; at most 500 (with a longer history from fast-import)", async () => {
  checkClipped(await gitLog(REPO, "", { graph: "all", limit: 3 }), 3);
  assert.equal((await gitLog(REPO, "", { graph: "all", limit: ALL.size })).clipped, false, "exactly as many as there are: not clipped");
  checkClipped(await gitLog(REPO, "", { graph: "all", limit: ALL.size - 1 }), ALL.size - 1);
  // 520 commits in one line — fast-import, so the setup costs no seconds.
  const lang = path.join(ISO, "lang");
  fs.mkdirSync(lang);
  git(lang, ["init", "-q", "-b", "main"]);
  let stream = "";
  for (let i = 1; i <= 520; i++) {
    const msg = `c${i}`;
    // Without `from`: fast-import attaches each commit to the tip that the same stream last wrote for the branch.
    stream += `commit refs/heads/main\ncommitter T <t@example.com> ${1_790_000_000 + i} +0000\ndata ${Buffer.byteLength(msg)}\n${msg}\n\n`;
  }
  const r = spawnSync("git", ["fast-import", "--quiet"], { cwd: lang, input: stream, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  git(lang, ["reset", "-q", "--hard", "main"]);
  const full = await gitLog(lang, "", { graph: "all", limit: 9999 });
  checkClipped(full, LOG_CAP);
  assert.equal(full.commits[0].subject, "c520");
  assert.equal(full.commits.at(-1).subject, `c${520 - LOG_CAP + 1}`);
  assert.deepEqual(full.commits.at(-1).parents, [git(lang, ["rev-parse", `main~${LOG_CAP}`]).trim()], "the parent of the last one lies outside the window — it is there anyway (the web draws the line to the edge)");
  assert.equal((await gitLog(lang, "", { graph: "all" })).commits.length, 100, "without limit the default 100");
});

test("(f) \"current\": HEAD and its upstream — without the other branches; without upstream only HEAD", async () => {
  const a = await gitLog(REPO, "", { graph: "current", limit: 100 });
  assert.equal(a.extent, "current");
  const expected = oracle(["HEAD", "@{upstream}"]);
  checkSet(a, expected);
  checkParent(a, expected);
  checkOrder(a);
  assert.ok(!a.commits.some((c) => [H.o1, H.r1, H.s1].includes(c.hash)), "foreign branches are not in the current one");
  assert.equal(a.commits[0].hash, H.m2);
  assert.deepEqual(refsOf(a, H.M), arrange([{ name: "origin/main", kind: "remote" }, { name: "v2", kind: "tag" }]));
  // A branch without upstream: only HEAD (an `@{upstream}` would break the call).
  git(REPO, ["checkout", "-q", "feature"]);
  try {
    const f = await gitLog(REPO, "", { graph: "current", limit: 100 });
    checkSet(f, oracle(["HEAD"]));
    assert.deepEqual(f.commits[0].refs, [{ name: "feature", kind: "head" }]);
    assert.equal(f.commits[0].head, true);
  } finally { git(REPO, ["checkout", "-q", "main"]); }
});

test("detached HEAD, empty repo, empty clone with remote branches", async () => {
  git(REPO, ["checkout", "-q", "--detach", H.m1]);
  try {
    const d = await gitLog(REPO, "", { graph: "all", limit: 100 });
    assert.deepEqual(refsOf(d, H.m1), [{ name: "HEAD", kind: "head" }]);
    assert.deepEqual(d.commits.filter((c) => c.head).map((c) => NAME[c.hash]), ["m1"]);
    assert.deepEqual(refsOf(d, H.m2), [{ name: "main", kind: "local" }], "main is no longer checked out");
  } finally { git(REPO, ["checkout", "-q", "main"]); }
  const empty = path.join(ISO, "empty");
  fs.mkdirSync(empty);
  git(empty, ["init", "-q", "-b", "main"]);
  for (const graph of ["all", "current"]) assert.deepEqual(await gitLog(empty, "", { graph }), { commits: [], clipped: false, extent: graph }, `leeres Repo, ${graph}`);
  git(empty, ["remote", "add", "origin", path.join(ISO, "origin.git")]);
  git(empty, ["fetch", "-q", "origin"]);
  const k = await gitLog(empty, "", { graph: "all", limit: 100 });
  checkSet(k, oracle(["--remotes=origin"]));
  assert.ok(!k.commits.some((c) => c.head), "without a commit at HEAD none carries head");
  assert.deepEqual((await gitLog(empty, "", { graph: "current" })).commits, []);
});

test("(g) without graph the answer of today — only { commits } with five fields; unknown scope and file filter throw", async () => {
  const old = await gitLog(REPO, "", { limit: 5 });
  assert.deepEqual(Object.keys(old), ["commits"]);
  assert.equal(old.commits.length, 5);
  for (const c of old.commits) assert.deepEqual(Object.keys(c), ["hash", "short", "subject", "author", "relative"]);
  assert.equal(old.commits[0].hash, H.m2);
  for (const graph of ["bunt", true, "", "ALL"]) await assert.rejects(gitLog(REPO, "", { graph }), /Unbekannter Umfang des Graphen|Unknown graph scope/, `graph ${JSON.stringify(graph)}`);
  await assert.rejects(gitLog(REPO, "", { graph: "all", file: "c1_Beginning.txt" }), /keinen Dateifilter|no file filter/);
});

test("refsFromDeco: symbolic refs, foreign ref kinds, duplicates", () => {
  assert.deepEqual(refsFromDeco(""), { refs: [], head: false });
  assert.deepEqual(refsFromDeco("HEAD -> refs/heads/a, refs/heads/a"), { refs: [{ name: "a", kind: "head" }], head: true }, "the same branch only once");
  assert.deepEqual(refsFromDeco("refs/remotes/origin/HEAD -> refs/remotes/origin/main"), { refs: [{ name: "origin/main", kind: "remote" }], head: false }, "the arrow spelling (depending on git) — the pointer drops out, the target stands");
  assert.deepEqual(refsFromDeco("refs/stash, refs/notes/commits, refs/cbase/x, tag: refs/tags/v,1"), { refs: [{ name: "v,1", kind: "tag" }], head: false });
  assert.deepEqual(refsFromDeco("refs/heads/origin/x"), { refs: [{ name: "origin/x", kind: "local" }], head: false }, "a local branch \"origin/x\" stays local (--decorate=full)");
});

test("(h) the route: graph goes through, an unknown value is 400, without graph the old form", async () => {
  await withServer(async ({ base, wsPath, projPath }) => {
    git(projPath, ["init", "-q", "-b", "main"]);
    commit(projPath, "one");
    git(projPath, ["checkout", "-q", "-b", "two"]);
    const two = commit(projPath, "two");
    git(projPath, ["checkout", "-q", "main"]);
    const ws = await makeWorkspace(base, "G", wsPath);
    const proj = await makeProject(base, ws.id, projPath);
    const log = (body) => json(`${base}/api/projects/${proj.id}/git/log`, { method: "POST", body: JSON.stringify({ repo: "", ...body }) });
    const a = await log({ graph: "all", limit: 10 });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(a.body.extent, "all");
    assert.equal(a.body.clipped, false);
    assert.deepEqual(a.body.commits.map((c) => c.subject), ["two", "one"], "the branch not checked out is in the graph");
    assert.deepEqual(a.body.commits[0].refs, [{ name: "two", kind: "local" }]);
    assert.equal(a.body.commits[0].hash, two);
    const k = await log({ graph: "current" });
    assert.deepEqual(k.body.commits.map((c) => c.subject), ["one"]);
    const b = await log({ graph: "bunt" });
    assert.equal(b.status, 400);
    assert.match(b.body.error, /Unbekannter Umfang des Graphen|Unknown graph scope/);
    const old = await log({});
    assert.equal(old.status, 200);
    assert.deepEqual(Object.keys(old.body), ["commits"]);
    assert.deepEqual(old.body.commits.map((c) => c.subject), ["one"]);
  });
});

// ── Counter-test: the checks over answers of wrong versions ──────────────────────────────────────────────────────────────
// The same computation as gitGraphLog (argv → git → parseGraphLog → cap), with ONE place twisted each.
function revision(argv, n, afterValue = (c) => c) {
  const out = execFileSync("git", argv, { cwd: REPO, encoding: "utf8", env: process.env });
  const commits = parseGraphLog(out).map(afterValue);
  return { commits: commits.slice(0, n), clipped: commits.length > n, extent: "all" };
}
test("counter-test: every wrong version turns the check red", () => {
  const real = graphLogArgs("all", 100);
  assert.ok(real.includes("--branches") && real.includes("--remotes") && real.includes("--topo-order") && real.includes("--decorate=full") && real.includes(`--format=${GRAPH_FORMAT}`) && real.includes("101"), `argv of the graph: ${real.join(" ")}`);
  checkAll(revision(real, 100)); // the real version over the same way is green — otherwise the counter-test measures the way, not the place
  const without = (x) => real.filter((a) => a !== x);
  const instead = (x, y) => real.map((a) => (a === x ? y : a));
  const fake = {
    "without --branches (the orphan branch is missing)": revision(without("--branches"), 100),
    "without --remotes (the remote-only branch is missing)": revision(without("--remotes"), 100),
    "without --topo-order (a child dated older would stand below its parent)": revision(without("--topo-order"), 100),
    "--date-order (the feature line interleaves with main)": revision(instead("--topo-order", "--date-order"), 100),
    "--decorate=short (badges would be lost)": revision(instead("--decorate=full", "--decorate=short"), 100),
    "without parents": revision(real, 100, (c) => ({ ...c, parents: [] })),
    "only the first parent": revision(real, 100, (c) => ({ ...c, parents: c.parents.slice(0, 1) })),
  };
  for (const [name, response] of Object.entries(fake)) assert.throws(() => checkAll(response), `version "${name}" stays green — the check does not measure this place`);
  // The cap: `-n n` instead of `n + 1` would never say "clipped".
  const n = 3;
  checkClipped(revision(graphLogArgs("all", n), n), n);
  const withoutOneMore = graphLogArgs("all", n).map((a, i, l) => (l[i - 1] === "-n" ? String(n) : a));
  assert.throws(() => checkClipped(revision(withoutOneMore, n), n), "\"-n n\" stays green — the cap never said it is one");
});
