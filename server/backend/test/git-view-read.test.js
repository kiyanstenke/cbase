// Guards for the per-instance reading of the git overview — gitView/read.js and gitView/mainBranch.js. The read script runs LOCALLY
// here via `sh -c` (under dash when available — as in the container, where /bin/sh is dash) on real throwaway repos: bare origin,
// clone, second remote, worktrees, detached HEAD.
//
// What it proves, each with the sabotage that breaks it:
//   (1) The numbers are git's: for EVERY tip (local, remote, detached) ahead/back to the main branch match `rev-list --left-right
//       --count` and the branch point matches the time of `merge-base`, the numbers to the upstream match `rev-list --left-right
//       --count <b>...<u>` — broken by any shortcut in the graph computation of the read script.
//   (2) Upstream via the configuration (differing name, second remote), unpushed points hollow, not-fetched counted, worktrees with
//       `notBackedUp`, detached HEAD with its last commit, `remoteState` from FETCH_HEAD.
//   (3) Main branch: origin/HEAD -> main (remote before local) -> master -> none; the script chooses like the pure computation
//       (parseReading throws otherwise). Without a main branch toMain/branchPoint/points are null, the upstream numbers stay.
//   (4) Copy: with the snapshot oids on stdin every tip carries `inSnapshot`, a moved one `sinceCreation` (ahead AND back); a branch
//       moved in main is unchanged in the copy. `copyComparison` takes only branches and remote refs of the named repo.
//   (5) DEPTH: above the cap the script counts `back` itself — the same numbers, `deep: true`.
//   (6) readInstance: deadline => "time", container stopped => "stopped", paused => "frozen", else "error"; the snapshot oids go
//       as stdin, GIT_OPTIONAL_LOCKS=0 goes along.
//   (7) The script is POSIX (`sh -n`, `dash -n`).
//   (8) Orphan: a branch without shared history with the main branch (local and as a remote ref) carries toMain/branchPoint/points/
//       count/notFetched/sinceCreation = null; M comes from the remaining tips (the main line reaches only to their branch point),
//       and the counting loop of the DEPTH path does not ask it. Sabotage: the exclusion `without` before `merge-base --octopus`
//       struck => (8) red (main line 12 instead of 2); the `case` in the counting loop struck => (8) red.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { READ_SCRIPT, WITHOUT_AWK, copyComparison, readInstance, parseReading, snapshotStdin } from "../electron/server/gitView/read.js";
import { MAIN_SH, CANDIDATES, selectMainBranch } from "../electron/server/gitView/mainBranch.js";
import { rowsFrom } from "../electron/server/gitView/groups.js";
import { REASONS, MAIN_BRANCH_SOURCES, POINTS_MAX } from "../electron/server/gitView/contract.js";

const SHELL = spawnSync("sh", ["-c", "command -v dash"], { encoding: "utf8" }).stdout.trim() || "sh";
const MARKER = "cbase-0123456789abcdef";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-git-view-"));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

let clock = 1_790_000_000;
const ENV = {
  ...process.env, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(root, "gitconfig"),
  GIT_AUTHOR_NAME: "Ada", GIT_AUTHOR_EMAIL: "ada@x", GIT_COMMITTER_NAME: "Ada", GIT_COMMITTER_EMAIL: "ada@x", GIT_TERMINAL_PROMPT: "0",
};
const git = (cwd, ...args) => {
  clock += 60;
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...ENV, GIT_AUTHOR_DATE: `${clock} +0000`, GIT_COMMITTER_DATE: `${clock} +0000` } }).trim();
};
let seq = 0;
const commit = (cwd, msg = `c${++seq}`) => {
  fs.writeFileSync(path.join(cwd, `f${seq}.txt`), `${msg}\n`);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", msg);
  return git(cwd, "rev-parse", "HEAD");
};

function read(repo, { depth = 20000, snapshot = null } = {}) {
  const r = spawnSync(SHELL, ["-c", READ_SCRIPT, "sh", MARKER, repo, String(depth), snapshot ? "1" : "0"], {
    encoding: "utf8", env: { ...ENV, GIT_OPTIONAL_LOCKS: "0" }, maxBuffer: 64 * 1024 * 1024,
    input: snapshot ? snapshotStdin(snapshot) : "",
  });
  assert.equal(r.status, 0, `read script: exit ${r.status}\n${r.stderr}`);
  return parseReading(r.stdout, { marker: MARKER, snapshot, depth });
}

// The check for (1): every tip against git itself.
function againstGit(repo, reading) {
  const h = reading.mainBranch.ref;
  for (const s of reading.tips) {
    const target = s.ref || s.oid;
    const [rear, front] = git(repo, "rev-list", "--left-right", "--count", `${h}...${target}`).split(/\s+/).map(Number);
    assert.deepEqual(s.toMain, { ahead: front, back: rear, merged: front === 0 }, `toMain ${target}`);
    const mbT = Number(git(repo, "log", "-1", "--format=%ct", git(repo, "merge-base", h, target))) * 1000;
    assert.equal(s.branchPoint, mbT, `abzweig ${target}`);
    assert.equal(s.count, front, `anzahl ${target}`);
    if (s.upstream) {
      const [lv, uz] = git(repo, "rev-list", "--left-right", "--count", `${target}...${s.upstream}`).split(/\s+/).map(Number);
      assert.deepEqual(s.toUpstream, { ahead: lv, back: uz }, `toUpstream ${target}`);
      // Exact over the read graph; only under DEPTH may the list be missing — it must never be shorter.
      if (!reading.deep || s.notFetched !== null) assert.equal(s.notFetched.length, uz, `notFetched ${target}`);
    }
  }
}

// ── The world: origin, second, helper clone, clone with worktrees ─────────────────────────────────────────────────────────
const origin = path.join(root, "origin.git");
const second = path.join(root, "second.git");
const helper = path.join(root, "helper");
const clone = path.join(root, "clone");
const world = {};
{
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "init", "-q", "--bare", "-b", "main", second);
  git(root, "clone", "-q", origin, helper);
  git(helper, "checkout", "-q", "-b", "main");
  for (let i = 0; i < 3; i++) commit(helper);
  git(helper, "push", "-q", "origin", "main");
  git(root, "clone", "-q", origin, clone);
  git(clone, "remote", "add", "second", second);
  // feature/a: two pushed, one local only
  git(clone, "checkout", "-q", "-b", "feature/a");
  commit(clone); commit(clone);
  git(clone, "push", "-q", "-u", "origin", "feature/a");
  world.aLocal = commit(clone, "a local");
  // feature/b: pushed, then two new ones on origin (from the helper) — fetched, not pulled
  git(clone, "checkout", "-q", "main");
  git(clone, "checkout", "-q", "-b", "feature/b");
  commit(clone);
  git(clone, "push", "-q", "-u", "origin", "feature/b");
  git(helper, "fetch", "-q", "origin");
  git(helper, "checkout", "-q", "-b", "feature/b", "origin/feature/b");
  commit(helper); commit(helper);
  git(helper, "push", "-q", "origin", "feature/b");
  // feature/c -> origin/c-new (differing name), x2 -> second/x (second remote), origin/x exists too (same name, other remote)
  git(clone, "checkout", "-q", "main");
  git(clone, "checkout", "-q", "-b", "feature/c");
  commit(clone);
  git(clone, "push", "-q", "-u", "origin", "feature/c:c-new");
  git(clone, "checkout", "-q", "main");
  git(clone, "checkout", "-q", "-b", "x2");
  commit(clone);
  git(clone, "push", "-q", "-u", "second", "x2:x");
  git(clone, "push", "-q", "origin", "x2:x");
  // local only
  git(clone, "checkout", "-q", "main");
  git(clone, "checkout", "-q", "-b", "only-local");
  commit(clone);
  // A merge on main (second parents on the main line) and feature/m, which pulled main back in (two entries, the younger counts).
  git(helper, "checkout", "-q", "main");
  git(helper, "checkout", "-q", "-b", "page");
  commit(helper); commit(helper);
  git(helper, "checkout", "-q", "main");
  commit(helper);
  git(helper, "merge", "-q", "--no-ff", "page", "-m", "page in");
  git(helper, "push", "-q", "origin", "main");
  git(clone, "fetch", "-q", "origin");
  git(clone, "checkout", "-q", "-b", "feature/m", "origin/main~2");
  commit(clone);
  git(clone, "merge", "-q", "--no-ff", "origin/main", "-m", "main in");
  commit(clone);
  // remote only: origin/spike from the helper; main advances two on origin
  git(helper, "checkout", "-q", "main");
  git(helper, "checkout", "-q", "-b", "spike");
  commit(helper);
  git(helper, "push", "-q", "origin", "spike");
  git(helper, "checkout", "-q", "main");
  commit(helper); commit(helper);
  git(helper, "push", "-q", "origin", "main");
  git(clone, "fetch", "-q", "--all");
  // Worktrees: cbase/agent-1 with a new file, feature/wt, detached on main~1 (local)
  git(clone, "checkout", "-q", "main");
  git(clone, "worktree", "add", "-q", "-b", "cbase/agent-1", path.join(root, "wt-agent"));
  fs.writeFileSync(path.join(root, "wt-agent", "fresh.txt"), "x\n");
  git(clone, "worktree", "add", "-q", "-b", "feature/wt", path.join(root, "wt-feat"));
  world.detachedOid = git(clone, "rev-parse", "main~1");
  git(clone, "worktree", "add", "-q", "--detach", path.join(root, "wt-detached"), world.detachedOid);
  // Main worktree on feature/a with two unsaved files
  git(clone, "checkout", "-q", "feature/a");
  fs.writeFileSync(path.join(clone, "f1.txt"), "changed\n");
  fs.writeFileSync(path.join(clone, "free.txt"), "new\n");
}

test("(7) the read script is POSIX (sh -n, dash -n) and the main-branch part comes from the same list", () => {
  for (const sh of new Set(["sh", SHELL])) {
    const r = spawnSync(sh, ["-n", "-c", READ_SCRIPT], { encoding: "utf8" });
    assert.equal(r.status, 0, `${sh} -n: ${r.stderr}`);
  }
  assert.deepEqual(["origin/HEAD", ...CANDIDATES.map((k) => k.name)], [...MAIN_BRANCH_SOURCES]);
  for (const k of CANDIDATES) for (const ref of k.refs) assert.ok(MAIN_SH.includes(`'${ref}^{commit}'`), ref);
  assert.ok(READ_SCRIPT.includes(MAIN_SH));
});

test("(1)(2) clone with origin, second remote and worktrees: numbers like git, pairing via the configuration", () => {
  const l = read(clone);
  assert.equal(l.read, true);
  assert.equal(l.deep, false);
  assert.deepEqual({ ...l.mainBranch, oid: undefined }, { name: "main", source: "origin/HEAD", ref: "refs/remotes/origin/main", oid: undefined });
  assert.equal(l.mainBranch.oid, git(clone, "rev-parse", "origin/main"));
  againstGit(clone, l);

  const sp = (ref) => l.tips.find((s) => s.ref === ref);
  // feature/a: up 1 to the upstream, the youngest point hollow
  const a = sp("refs/heads/feature/a");
  assert.equal(a.upstream, "refs/remotes/origin/feature/a");
  assert.deepEqual(a.toUpstream, { ahead: 1, back: 0 });
  assert.deepEqual(a.points.map((p) => p.pushed), [true, true, false]);
  assert.ok(a.points[0].t < a.points[2].t, "points ascending");
  assert.deepEqual(a.last, { t: a.points[2].t, author: "Ada", subject: "a local" });
  // feature/b: down 2 not fetched
  const b = sp("refs/heads/feature/b");
  assert.deepEqual(b.toUpstream, { ahead: 0, back: 2 });
  assert.equal(b.notFetched.length, 2);
  // feature/c -> origin/c-new, x2 -> second/x (the same-named origin/x is another ref)
  assert.equal(sp("refs/heads/feature/c").upstream, "refs/remotes/origin/c-new");
  assert.equal(sp("refs/heads/x2").upstream, "refs/remotes/second/x");
  assert.equal(sp("refs/heads/only-local").upstream, null);
  assert.equal(sp("refs/heads/only-local").toUpstream, null);
  assert.ok(sp("refs/remotes/origin/spike"));
  assert.ok(!l.tips.some((s) => s.ref === "refs/remotes/origin/HEAD"), "the symref is no tip");
  // Worktrees
  const wt = (p) => l.worktrees.find((w) => fs.realpathSync(w.path) === fs.realpathSync(p));
  assert.deepEqual({ ...wt(clone), path: undefined, oid: undefined }, { path: undefined, main: true, branch: "refs/heads/feature/a", oid: undefined, detached: false, notBackedUp: 2 });
  assert.equal(wt(path.join(root, "wt-agent")).notBackedUp, 1);
  assert.equal(wt(path.join(root, "wt-agent")).branch, "refs/heads/cbase/agent-1");
  assert.equal(wt(path.join(root, "wt-feat")).notBackedUp, 0);
  assert.equal(wt(path.join(root, "wt-detached")).detached, true);
  const detachedRef = l.tips.find((s) => s.kind === "detached");
  assert.equal(detachedRef.oid, world.detachedOid);
  assert.equal(detachedRef.last.author, "Ada");
  assert.ok(detachedRef.last.t > 0);
  assert.equal(detachedRef.toMain.merged, true);
  // remoteState from FETCH_HEAD, main line up to the tip of origin/main
  assert.equal(l.remoteState.source, "fetch-head");
  assert.ok(Math.abs(l.remoteState.at - Date.now()) < 10 * 60 * 1000, "FETCH_HEAD just written");
  assert.equal(l.line.commits.at(-1), Number(git(clone, "log", "-1", "--format=%ct", "origin/main")) * 1000);
  assert.equal(l.line.count, l.line.commits.length);

  // A look through groups.js: the four groups stand, pairing without duplicates.
  const { rows } = rowsFrom({ main: l });
  const g = (n) => rows.find((z) => z.name === n)?.group;
  assert.equal(g("feature/a"), "checkedOut");
  assert.equal(g("feature/wt"), "checkedOut");
  assert.equal(g(`detached @ ${world.detachedOid.slice(0, 7)}`), "checkedOut");
  assert.equal(g("cbase/agent-1"), "cbase");
  assert.equal(g("only-local"), "branches");
  assert.equal(g("origin/spike"), "remote");
  assert.equal(g("origin/x"), "remote");
  assert.equal(g("origin/c-new"), undefined, "paired, no row of its own");
  assert.equal(g("origin/main"), undefined, "the main branch is the line");
});

test("(3) main branch: origin/HEAD -> main (remote before local) -> master -> none", () => {
  const fall = (name, build) => { const d = path.join(root, name); fs.mkdirSync(d); build(d); return d; };
  // only a local main, no remote, no FETCH_HEAD
  const onlyMain = fall("only-main", (d) => { git(d, "init", "-q", "-b", "main"); commit(d); git(d, "checkout", "-q", "-b", "feature/z"); commit(d); });
  const l1 = read(onlyMain);
  assert.deepEqual({ ...l1.mainBranch, oid: undefined }, { name: "main", source: "main", ref: "refs/heads/main", oid: undefined });
  assert.deepEqual(l1.remoteState, { at: null, source: "unknown" });
  againstGit(onlyMain, l1);
  // only master
  const onlyMaster = fall("only-master", (d) => { git(d, "init", "-q", "-b", "master"); commit(d); git(d, "checkout", "-q", "-b", "dev"); commit(d); });
  const l2 = read(onlyMaster);
  assert.deepEqual({ ...l2.mainBranch, oid: undefined }, { name: "master", source: "master", ref: "refs/heads/master", oid: undefined });
  againstGit(onlyMaster, l2);
  // none: only develop
  const none = fall("none", (d) => { git(d, "init", "-q", "-b", "develop"); commit(d); commit(d); });
  const l3 = read(none);
  assert.equal(l3.mainBranch, null);
  const dev = l3.tips.find((s) => s.ref === "refs/heads/develop");
  assert.deepEqual([dev.toMain, dev.branchPoint, dev.points, dev.count, dev.notFetched], [null, null, null, null, null]);
  assert.equal(dev.last.author, "Ada");
  // origin/HEAD gone, origin/main there, local main behind: the remote ref wins
  const withoutHead = fall("without-head", (d) => {
    git(d, "clone", "-q", origin, ".");
    git(d, "remote", "set-head", "origin", "-d");
    git(d, "checkout", "-q", "main");
    git(d, "reset", "-q", "--hard", "HEAD~2");
  });
  const l4 = read(withoutHead);
  assert.deepEqual({ ...l4.mainBranch, oid: undefined }, { name: "main", source: "main", ref: "refs/remotes/origin/main", oid: undefined });
  assert.deepEqual(l4.tips.find((s) => s.ref === "refs/heads/main").toMain, { ahead: 0, back: 2, merged: true });
  // the pure selection alone
  assert.equal(selectMainBranch({ originHead: "refs/remotes/origin/trunk", refs: ["refs/remotes/origin/trunk", "refs/heads/main"] }).source, "origin/HEAD");
  assert.equal(selectMainBranch({ originHead: "refs/remotes/origin/gone", refs: ["refs/heads/master"] }).ref, "refs/heads/master");
  assert.equal(selectMainBranch({ originHead: null, refs: ["refs/heads/main", "refs/heads/master"] }).name, "main");
  assert.equal(selectMainBranch({ originHead: null, refs: [] }), null);
});

test("(4) copy: snapshot refs via stdin, inSnapshot per tip, sinceCreation ahead and back", () => {
  const copy = path.join(root, "copy");
  git(root, "clone", "-q", origin, copy);
  git(copy, "checkout", "-q", "-b", "feature/b", "origin/feature/b");
  git(copy, "checkout", "-q", "-b", "back", "origin/main");
  // The snapshot: the refs at freeze time (shape like stacks/code-snapshot.js)
  const refsNow = git(copy, "for-each-ref", "--format=%(refname) %(objectname) %(symref)").split("\n")
    .map((z) => z.split(" ")).map(([name, oid, symref]) => ({ name, oid, symref: symref || null }));
  const snapshotJson = {
    version: 1,
    repos: [
      { part: "p", rel: ".", projectRepo: true, refs: [{ name: "refs/heads/project", oid: "f".repeat(40), symref: null }] },
      { part: "r0", rel: ".", projectRepo: false, refs: [...refsNow, { name: "refs/tags/v1", oid: refsNow[0].oid, symref: null }] },
      { part: "r1", rel: "other", projectRepo: false, refs: [] },
    ],
  };
  const comparison = copyComparison(snapshotJson, "");
  assert.ok(comparison.every((r) => /^refs\/(heads|remotes)\//.test(r.name)), "only branches and remote refs");
  assert.ok(!comparison.some((r) => r.name === "refs/remotes/origin/HEAD"), "no symref");
  assert.equal(comparison.length, refsNow.filter((r) => !r.symref).length);
  assert.deepEqual(copyComparison(snapshotJson, "other"), []);
  assert.equal(copyComparison(snapshotJson, "missing"), null);

  // Work in the copy: feature/b ahead, back two behind, a new branch; in main feature/b moves too (invisible here).
  const bOld = git(copy, "rev-parse", "feature/b");
  git(copy, "checkout", "-q", "feature/b");
  commit(copy, "copy b");
  git(copy, "branch", "-f", "back", "origin/main~2");
  git(copy, "checkout", "-q", "-b", "fresh/x");
  commit(copy, "copy new");
  git(copy, "checkout", "-q", "feature/b");
  // a snapshot oid that does not exist in the copy must not break the reading
  const withForeign = [...comparison, { name: "refs/heads/deleted", oid: "e".repeat(40) }];
  const l = read(copy, { snapshot: withForeign });
  againstGit(copy, l);
  const sp = (ref) => l.tips.find((s) => s.ref === ref);
  assert.equal(sp("refs/heads/feature/b").inSnapshot, bOld);
  assert.deepEqual(sp("refs/heads/feature/b").sinceCreation, { ahead: 1, back: 0 });
  assert.deepEqual(sp("refs/heads/back").sinceCreation, { ahead: 0, back: 2 });
  assert.equal(sp("refs/heads/fresh/x").inSnapshot, null);
  assert.equal(sp("refs/heads/fresh/x").sinceCreation, null);
  const main = sp("refs/heads/main");
  assert.equal(main.inSnapshot, main.oid, "unchanged");
  assert.equal(main.sinceCreation, null);
  // In main there is no snapshot: inSnapshot stays undefined.
  assert.equal(read(clone).tips[0].inSnapshot, undefined);
  // (5) also for the copy: above the cap the script counts sinceCreation itself — the same numbers.
  const deep = read(copy, { snapshot: withForeign, depth: 1 });
  assert.equal(deep.deep, true);
  againstGit(copy, deep);
  const a = (x) => Object.fromEntries(x.tips.map((s) => [s.ref || s.oid, [s.inSnapshot, s.sinceCreation]]));
  assert.deepEqual(a(deep), a(l));
});

test("(5) DEPTH: above the cap the script counts back itself — the same numbers", () => {
  const full = read(clone);
  const deep = read(clone, { depth: 1 });
  assert.equal(deep.deep, true);
  assert.equal(full.deep, false);
  againstGit(clone, deep);
  const z = (l) => Object.fromEntries(l.tips.map((s) => [s.ref || s.oid, [s.toMain, s.count, s.toUpstream]]));
  assert.deepEqual(z(deep), z(full));
  // The not-fetched part of main lies on the main line below the read part: unknown, never a shorter list.
  const main = (l) => l.tips.find((s) => s.ref === "refs/heads/main");
  assert.equal(main(full).toUpstream.back, 6);
  assert.equal(main(full).notFetched.length, 6);
  assert.equal(main(deep).notFetched, null);
});

test("(6) readInstance: reasons, stdin, environment", async () => {
  const calls = [];
  const run = (response) => async (inst, cwd, cmd, args, opts) => { calls.push({ inst, cwd, cmd, args, opts }); if (response instanceof Error) throw response; return response; };
  const inst = { identifier: "p1/main" };
  const fall = async (response, opts = {}) => readInstance(inst, { path: "/project/repo", run: run(response), ...opts });
  assert.equal((await fall({ code: null, cap: "deadline", stdout: "", stderr: "cap of 20 s" })).reason, "time");
  assert.equal((await fall({ code: 1, stdout: "", stderr: "Error response from daemon: container x is not running" })).reason, "stopped");
  assert.equal((await fall({ code: 1, stdout: "", stderr: "Error response from daemon: container x is paused" })).reason, "frozen");
  const broken = await fall({ code: 4, stdout: "", stderr: "/project/repo is not a git repo" });
  assert.deepEqual([broken.read, broken.reason, broken.error], [false, "error", "/project/repo is not a git repo"]);
  assert.equal((await fall(new TypeError("no instance"))).reason, "error");
  assert.equal((await fall({ code: 0, stdout: "half", stderr: "" })).reason, "error", "incomplete output is an error, not an empty list");
  for (const g of ["time", "stopped", "frozen", "error"]) assert.ok(REASONS.includes(g));

  // Success: the real output under the marker of the call; stdin carries the snapshot oids.
  calls.length = 0;
  const real = async (i, cwd, cmd, args, opts) => {
    calls.push({ args, opts });
    const r = spawnSync(SHELL, args, { encoding: "utf8", input: opts.stdin ?? "", env: { ...ENV, ...opts.env }, maxBuffer: opts.maxBuffer });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr, cap: null };
  };
  const snap = [{ name: "refs/heads/main", oid: git(clone, "rev-parse", "main") }];
  const l = await readInstance(inst, { path: clone, snapshot: snap, run: real });
  assert.equal(l.read, true, l.error);
  assert.equal(calls[0].args[0], "-c");
  assert.equal(calls[0].args[4], clone);
  assert.equal(calls[0].args[6], "1");
  assert.equal(calls[0].opts.stdin, `${snap[0].oid} refs/heads/main\n`);
  assert.equal(calls[0].opts.env.GIT_OPTIONAL_LOCKS, "0");
  assert.deepEqual(calls[0].opts.envAlways, ["GIT_OPTIONAL_LOCKS"]);
  assert.equal(l.tips.find((s) => s.ref === "refs/heads/main").inSnapshot, snap[0].oid);
  const without = await readInstance(inst, { path: clone, run: real });
  assert.equal(calls[1].args[6], "0");
  assert.equal(calls[1].opts.stdin, undefined, "no stdin in main");
  assert.equal(without.read, true);
});

test("points: at most POINTS_MAX+1 of the youngest, ascending", () => {
  const d = path.join(root, "many");
  fs.mkdirSync(d);
  git(d, "init", "-q", "-b", "main");
  commit(d);
  git(d, "checkout", "-q", "-b", "lang");
  for (let i = 0; i < POINTS_MAX + 5; i++) commit(d);
  const s = read(d).tips.find((x) => x.ref === "refs/heads/lang");
  assert.equal(s.count, POINTS_MAX + 5);
  assert.equal(s.points.length, POINTS_MAX + 1);
  assert.equal(s.points.at(-1).t, s.last.t, "the youngest is included");
  assert.deepEqual(s.points.map((p) => p.t), [...s.points.map((p) => p.t)].sort((a, b) => a - b));
});

test("(8) orphan branch (local and remote): null instead of numbers, M and main line from the remaining tips, the counting loop does not ask it", () => {
  const o = path.join(root, "orphan-origin.git");
  const r = path.join(root, "orphan");
  git(root, "init", "-q", "--bare", "-b", "main", o);
  git(root, "init", "-q", "-b", "main", r);
  git(r, "remote", "add", "origin", o);
  for (let i = 0; i < 12; i++) commit(r);
  git(r, "push", "-q", "-u", "origin", "main");
  git(r, "checkout", "-q", "-b", "feature/recent", "main~2");
  commit(r);
  git(r, "checkout", "-q", "--orphan", "gh-pages");
  commit(r, "page"); commit(r, "page 2");
  git(r, "push", "-q", "-u", "origin", "gh-pages");
  git(r, "checkout", "-q", "main");
  assert.equal(spawnSync("git", ["merge-base", "main", "gh-pages"], { cwd: r, env: ENV }).status, 1, "seed: no shared history");

  const l = read(r);
  const sp = (ref) => l.tips.find((s) => s.ref === ref);
  for (const ref of ["refs/heads/gh-pages", "refs/remotes/origin/gh-pages"]) {
    const s = sp(ref);
    assert.deepEqual([s.toMain, s.branchPoint, s.points, s.count, s.notFetched, s.sinceCreation], [null, null, null, null, null, null], ref);
  }
  assert.deepEqual(sp("refs/heads/gh-pages").toUpstream, { ahead: 0, back: 0 }, "the numbers to the upstream still come from git");
  // The remaining tips like git — and the main line reaches only to the branch point of feature/recent (main~2), not over all twelve
  // (with the orphan in `merge-base --octopus`, M was empty and G the whole main line).
  againstGit(r, { ...l, tips: l.tips.filter((s) => !String(s.ref).endsWith("/gh-pages")) });
  assert.equal(l.deep, false);
  assert.equal(l.line.count, 2, `the main line read ${l.line.count} commits — M did not come from the tips with shared history`);

  // DEPTH: the counting loop (one process per ref) does not ask the orphan — it would stand there with the whole main line.
  const raw = spawnSync(SHELL, ["-c", READ_SCRIPT, "sh", MARKER, r, "1", "0"], { encoding: "utf8", env: { ...ENV, GIT_OPTIONAL_LOCKS: "0" } });
  assert.equal(raw.status, 0, raw.stderr);
  const back = raw.stdout.split(`${MARKER} back\n`)[1]?.split(`${MARKER} creation`)[0] ?? null;
  assert.ok(back !== null && back.includes("refs/heads/feature/recent"), `no DEPTH path: ${raw.stdout.slice(-400)}`);
  assert.ok(!back.includes("gh-pages"), `the counting loop asked the orphan: ${back}`);
  const lt = parseReading(raw.stdout, { marker: MARKER, depth: 1 });
  assert.equal(lt.deep, true);
  assert.equal(lt.tips.find((s) => s.ref === "refs/heads/gh-pages").toMain, null);
  assert.deepEqual(lt.tips.find((s) => s.ref === "refs/heads/feature/recent").toMain, { ahead: 1, back: 2, merged: false });
  // WITHOUT_AWK is POSIX awk without single quotes (it sits in the script between such).
  assert.ok(!WITHOUT_AWK.includes("'"));
});
