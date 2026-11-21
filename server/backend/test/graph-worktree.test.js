// The worktree of a graph-workflow run: `workflows/worktree.js` without a server, on temp repos.
//
// The test repos take their git configuration from the ENVIRONMENT (`GIT_CONFIG_COUNT`, GLOBAL/NOSYSTEM switched off) as in
// `agent-level-repo.test.js` - `GIT_CONFIG_GLOBAL=/dev/null` alone does not cover `core.excludesFile`, and a global ignore
// pattern of the machine would otherwise change what `ls-files --ignored` reports. The leaf inherits it.
//
// Counter-tests (which sabotage turns which test red):
//   - `graphWorktreeChanged` without the comparison with `info.own`  => "unchanged despite the links" red (the link
//     `node_modules` is an unversioned FILE for git - the pattern `node_modules/` only hits folders). Since the links stand
//     in `info/exclude`, status no longer shows them; the comparison stays as a second wall.
//   - drop the cleanup in the `catch` of `createGraphWorktree`  => "half failure" red (branch and folder stay).
//   - do not call `closeLinksFrom` in `createGraphWorktree`  => "git add -A does not take the links" red:
//     `A  .venv`, `A  node_modules` - the branch would carry absolute links to the main folder.
// This file imports no other test file.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { removeGraphWorktree, graphWorktreeChanged, createGraphWorktree } from "../electron/server/workflows/worktree.js";
import { createProjectRepo } from "../electron/server/projectbox/projectRepo.js";

const GIT_ENV = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_COUNT: "5",
  GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "Test",
  GIT_CONFIG_KEY_1: "user.email", GIT_CONFIG_VALUE_1: "test@example.com",
  GIT_CONFIG_KEY_2: "core.excludesFile", GIT_CONFIG_VALUE_2: "/dev/null",
  GIT_CONFIG_KEY_3: "core.attributesFile", GIT_CONFIG_VALUE_3: "/dev/null",
  GIT_CONFIG_KEY_4: "init.defaultBranch", GIT_CONFIG_VALUE_4: "main",
};
Object.assign(process.env, GIT_ENV);

const git = (args, cwd) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")} in ${cwd}: ${r.stderr}`);
  return r.stdout.trim();
};
const write = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };

// A repo with a versioned file, `.gitignore` (node_modules/, .venv/, .env*) and the ignored entries that the worktree
// handles - plus one that lies too deep.
function repo(dir) {
  write(path.join(dir, "README.md"), "# repo\n");
  write(path.join(dir, "src/app.js"), "export const a = 1;\n");
  write(path.join(dir, ".gitignore"), "node_modules/\n.venv/\n.env*\n");
  git(["init", "-q"], dir);
  git(["add", "-A"], dir);
  git(["commit", "-qm", "start"], dir);
  write(path.join(dir, ".env"), "SECRET=1\n");
  write(path.join(dir, ".env.local"), "LOCAL=1\n");
  write(path.join(dir, "src/.env"), "DEPTH2=1\n");
  write(path.join(dir, "src/deep/.env"), "DEPTH3=1\n");
  write(path.join(dir, "node_modules/package/index.js"), "module.exports = 1;\n");
  write(path.join(dir, ".venv/bin/python"), "#!/bin/sh\n");
  return dir;
}
const branches = (r) => git(["branch", "--list", "--format=%(refname:short)"], r).split("\n").filter(Boolean);
const worktrees = (r) => git(["worktree", "list", "--porcelain"], r).split("\n").filter((l) => l.startsWith("worktree ")).length;

function temp(t) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cbase-graph-wt-")));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return { base: d, root: path.join(d, "worktrees") };
}

test("a repo as project folder: run folder = worktree, .env copied, node_modules/.venv linked, unchanged despite the links", async (t) => {
  const { base, root } = temp(t);
  const proj = repo(path.join(base, "app"));
  const info = await createGraphWorktree({ startId: "abcdef1234567890", project: { name: "App", path: proj }, root });

  assert.equal(info.dir, path.join(root, "graph-abcdef1234567890"));
  assert.equal(info.branch, "cbase/graph-abcdef12");
  assert.equal(info.repos.length, 1);
  const [r] = info.repos;
  assert.deepEqual({ name: r.name, relPath: r.relPath, root: r.root, target: r.target }, { name: "app", relPath: "", root: proj, target: info.dir });
  assert.equal(r.base, git(["rev-parse", "HEAD"], proj));
  assert.ok(branches(proj).includes(info.branch), "the branch is in the repo");
  assert.equal(fs.readFileSync(path.join(info.dir, "src/app.js"), "utf8"), "export const a = 1;\n", "checkedOut");

  for (const [rel, content] of [[".env", "SECRET=1\n"], [".env.local", "LOCAL=1\n"], ["src/.env", "DEPTH2=1\n"]]) {
    const p = path.join(info.dir, rel);
    assert.equal(fs.lstatSync(p).isSymbolicLink(), false, `${rel} is a copy, not a link`);
    assert.equal(fs.readFileSync(p, "utf8"), content, `${rel} copied`);
  }
  assert.equal(fs.existsSync(path.join(info.dir, "src/deep/.env")), false, "deeper than two levels: not copied");
  for (const rel of ["node_modules", ".venv"]) {
    const p = path.join(info.dir, rel);
    assert.equal(fs.lstatSync(p).isSymbolicLink(), true, `${rel} is a link`);
    assert.equal(fs.readlinkSync(p), path.join(proj, rel), `${rel} points absolutely to the main folder`);
  }
  assert.deepEqual(info.own.map((e) => [path.relative(info.dir, e.path), e.kind]).sort(),
    [[".env", "copy"], [".env.local", "copy"], [".venv", "link"], ["node_modules", "link"], ["src/.env", "copy"]]);
  assert.equal(JSON.parse(JSON.stringify(info)).repos[0].target, info.dir, "info is plain JSON (worktree_info)");

  assert.equal(await graphWorktreeChanged(info), false, "unchanged - the own copies and links do not count");

  // A changed file => true; reverted => false again.
  fs.writeFileSync(path.join(info.dir, "src/app.js"), "export const a = 2;\n");
  assert.equal(await graphWorktreeChanged(info), true, "changed file");
  git(["checkout", "--", "src/app.js"], info.dir);
  assert.equal(await graphWorktreeChanged(info), false);
  // A new, unversioned file in a new folder => true.
  write(path.join(info.dir, "fresh/file.txt"), "x\n");
  assert.equal(await graphWorktreeChanged(info), true, "new file");
  fs.rmSync(path.join(info.dir, "fresh"), { recursive: true });
  // A commit in the worktree (tree clean again) => true.
  fs.writeFileSync(path.join(info.dir, "README.md"), "# changed\n");
  git(["commit", "-qam", "work"], info.dir);
  assert.equal(git(["status", "--porcelain", "--", "README.md"], info.dir), "");
  assert.equal(await graphWorktreeChanged(info), true, "a commit in base..HEAD");

  // Without force a changed worktree stays.
  const without = await removeGraphWorktree(info);
  assert.deepEqual(without, { removed: false, changed: true, error: [] });
  assert.ok(fs.existsSync(info.dir));
  // With force: branch, worktree and folder gone - and the dependencies of the main folder untouched.
  const including = await removeGraphWorktree(info, { force: true });
  assert.deepEqual(including, { removed: true, changed: false, error: [] });
  assert.equal(fs.existsSync(info.dir), false, "run folder gone");
  assert.equal(branches(proj).includes(info.branch), false, "branch gone");
  assert.equal(worktrees(proj), 1, "only the main worktree left");
  assert.equal(fs.readFileSync(path.join(proj, "node_modules/package/index.js"), "utf8"), "module.exports = 1;\n", "node_modules of the main folder untouched");
  assert.ok(fs.existsSync(path.join(proj, ".venv/bin/python")), ".venv of the main folder untouched");
  assert.equal(fs.readFileSync(path.join(proj, ".env"), "utf8"), "SECRET=1\n");
});

test("git add -A does not take the links (info/exclude), the main folder stays as it was, no line twice", async (t) => {
  const { base, root } = temp(t);
  const proj = repo(path.join(base, "app"));
  const ignoredPrior = git(["ls-files", "--others", "--ignored", "--exclude-standard", "--directory"], proj);
  const info = await createGraphWorktree({ startId: "1111aaaa2222", project: { name: "App", path: proj }, root });

  // Exactly the scenario: the agent commits EVERYTHING in the worktree.
  git(["add", "-A"], info.dir);
  assert.equal(git(["diff", "--cached", "--name-only"], info.dir), "", "nothing staged - neither node_modules nor .venv");
  assert.equal(git(["status", "--porcelain", "--untracked-files=all"], info.dir), "", "the links do not appear at all");
  assert.equal(await graphWorktreeChanged(info), false);
  // Real work stays visible and is committed - without the links.
  write(path.join(info.dir, "src/fresh.js"), "export const n = 1;\n");
  git(["add", "-A"], info.dir);
  git(["commit", "-qm", "work"], info.dir);
  assert.equal(git(["show", "--name-only", "--format=", "HEAD"], info.dir), "src/fresh.js", "the commit carries only the work");

  // The main folder: the same ignored entries, no new status.
  assert.equal(git(["status", "--porcelain"], proj), "");
  assert.equal(git(["ls-files", "--others", "--ignored", "--exclude-standard", "--directory"], proj), ignoredPrior);

  // A second run on the same repo writes no line twice.
  const two = await createGraphWorktree({ startId: "3333bbbb4444", project: { name: "App", path: proj }, root });
  git(["add", "-A"], two.dir);
  assert.equal(git(["diff", "--cached", "--name-only"], two.dir), "");
  const rows = fs.readFileSync(path.join(proj, ".git/info/exclude"), "utf8").split("\n");
  for (const z of ["/node_modules", "/.venv"]) assert.equal(rows.filter((l) => l === z).length, 1, `${z} exactly once`);
  assert.equal(rows.filter((l) => l.startsWith("# cbase:")).length, 1, "the header exactly once");

  assert.deepEqual((await removeGraphWorktree(two)).error, []);
  assert.deepEqual((await removeGraphWorktree(info, { force: true })).error, []);
});

test("two nested repos: one each under its relative path, the same branch name, removing without force cleans up both", async (t) => {
  const { base, root } = temp(t);
  const proj = path.join(base, "mono");
  const front = repo(path.join(proj, "frontend"));
  const back = repo(path.join(proj, "backend"));
  write(path.join(proj, "notes.txt"), "outside the repos\n");
  const info = await createGraphWorktree({ startId: "0123456789ab", project: { name: "Mono", path: proj }, root });

  assert.deepEqual(info.repos.map((r) => [r.name, r.relPath, r.root, r.target]), [
    ["backend", "backend", back, path.join(info.dir, "backend")],
    ["frontend", "frontend", front, path.join(info.dir, "frontend")],
  ]);
  for (const r of [front, back]) assert.ok(branches(r).includes("cbase/graph-01234567"));
  assert.equal(fs.readFileSync(path.join(info.dir, "frontend/.env"), "utf8"), "SECRET=1\n");
  assert.equal(fs.readlinkSync(path.join(info.dir, "backend/node_modules")), path.join(back, "node_modules"));
  assert.equal(fs.existsSync(path.join(info.dir, "notes.txt")), false, "files outside the repos are not copied");
  for (const sub of ["frontend", "backend"]) {
    git(["add", "-A"], path.join(info.dir, sub));
    assert.equal(git(["diff", "--cached", "--name-only"], path.join(info.dir, sub)), "", `${sub}: the links stay out of git`);
  }
  assert.equal(await graphWorktreeChanged(info), false);

  // A change in ONLY one repo is enough.
  fs.writeFileSync(path.join(info.dir, "backend/src/app.js"), "x\n");
  assert.equal(await graphWorktreeChanged(info), true);
  git(["checkout", "--", "src/app.js"], path.join(info.dir, "backend"));

  const r = await removeGraphWorktree(info);
  assert.deepEqual(r, { removed: true, changed: false, error: [] });
  assert.equal(fs.existsSync(info.dir), false);
  for (const repoRoot of [front, back]) {
    assert.equal(branches(repoRoot).includes(info.branch), false);
    assert.equal(worktrees(repoRoot), 1);
  }
});

// If the project folder carries the project repo of cbase, the run branches exactly the code repos - never the project repo
// that encloses them all. Counter-test: with git.js without that rule the run consists of ONE repo with relPath "" (the
// project repo) - red.
test("project repo in the project folder: the run branches the code repos, never the project repo; without a code repo no run", async (t) => {
  const { base, root } = temp(t);
  const proj = path.join(base, "relocated");
  const front = repo(path.join(proj, "frontend"));
  const back = repo(path.join(proj, "backend"));
  write(path.join(proj, "notes.txt"), "next to the repos\n");
  const created = await createProjectRepo(proj);
  assert.equal(created.created, true, JSON.stringify(created));

  const info = await createGraphWorktree({ startId: "feedc0de12345678", project: { name: "Relocated", path: proj }, root });
  assert.deepEqual(info.repos.map((r) => [r.relPath, r.root]), [["backend", back], ["frontend", front]], "exactly the code repos");
  assert.equal(fs.existsSync(path.join(info.dir, ".git")), false, "the run folder is no worktree of the project repo");
  assert.equal(worktrees(proj), 1, "the project repo got no worktree");
  assert.equal(branches(proj).includes(info.branch), false, "... and no branch");
  assert.deepEqual(await removeGraphWorktree(info), { removed: true, changed: false, error: [] });

  // A project folder that carries ONLY the project repo has no code repo: the same error as without any repo.
  const only = path.join(base, "only-notes");
  write(path.join(only, "file.txt"), "x\n");
  assert.equal((await createProjectRepo(only)).created, true);
  await assert.rejects(createGraphWorktree({ startId: "s2", project: { name: "Only", path: only }, root }), (e) => e.reason === "repo");
  assert.equal(worktrees(only), 1);
});

test("no repo: the error text with reason \"repo\", nothing created", async (t) => {
  const { base, root } = temp(t);
  const proj = path.join(base, "empty");
  write(path.join(proj, "file.txt"), "x\n");
  await assert.rejects(createGraphWorktree({ startId: "s1", project: { name: "Empty", path: proj }, root }), (e) => {
    assert.equal(e.message, "Das Projekt „Empty“ hat kein Git-Repository — ein eigener Worktree geht nur mit Repo.");
    assert.equal(e.reason, "repo");
    return true;
  });
  assert.equal(fs.existsSync(root), false, "no root created");
});

test("half failure: the second repo already has the branch => the first is cleaned up, the foreign branch stays", async (t) => {
  const { base, root } = temp(t);
  const proj = path.join(base, "mono");
  const a = repo(path.join(proj, "a"));
  const b = repo(path.join(proj, "b"));
  git(["branch", "cbase/graph-halfhalf"], b); // the remnant of another run
  await assert.rejects(createGraphWorktree({ startId: "halfhalf-99", project: { name: "Mono", path: proj }, root }),
    /besteht der Branch cbase\/graph-halfhalf schon/);
  assert.equal(fs.existsSync(path.join(root, "graph-halfhalf-99")), false, "run folder gone");
  assert.equal(branches(a).includes("cbase/graph-halfhalf"), false, "branch in the first repo gone");
  assert.equal(worktrees(a), 1, "worktree in the first repo gone");
  assert.ok(branches(b).includes("cbase/graph-halfhalf"), "the foreign branch stays");
});

test("an existing run folder is neither used nor cleaned up", async (t) => {
  const { base, root } = temp(t);
  const proj = repo(path.join(base, "app"));
  const foreign = path.join(root, "graph-duplicate");
  write(path.join(foreign, "content.txt"), "foreign\n");
  await assert.rejects(createGraphWorktree({ startId: "duplicate", project: { name: "App", path: proj }, root }), /besteht schon/);
  assert.equal(fs.readFileSync(path.join(foreign, "content.txt"), "utf8"), "foreign\n");
  assert.equal(branches(proj).includes("cbase/graph-duplicate"), false);
});

test("removing never throws: a folder deleted by hand is cleaned up via prune, a missing repo stands in error", async (t) => {
  const { base, root } = temp(t);
  const proj = repo(path.join(base, "app"));
  const info = await createGraphWorktree({ startId: "byhand1", project: { name: "App", path: proj }, root });
  fs.rmSync(info.dir, { recursive: true, force: true });
  assert.equal(await graphWorktreeChanged(info), false, "a missing folder carries no work");
  const r = await removeGraphWorktree(info);
  assert.deepEqual(r, { removed: true, changed: false, error: [] });
  assert.equal(worktrees(proj), 1, "prune cleaned the administrative data");
  assert.equal(branches(proj).includes(info.branch), false);

  const broken = { ...info, repos: [{ ...info.repos[0], root: path.join(base, "exists-not") }] };
  const r2 = await removeGraphWorktree(broken, { force: true });
  assert.equal(r2.error.length, 1);
  assert.match(r2.error[0], /missing/);
  assert.deepEqual(await removeGraphWorktree(null), { removed: false, changed: false, error: [] });
});
