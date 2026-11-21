// The project repo and repo detection.
//
// The promises, each with the way that breaks it:
//   (1) isProjectRepo recognises ONLY the marker in a `.git` FOLDER: without marker, wrongly set, in a subsection, as a `.git`
//       file (worktree) or as a link to a marked folder => no.
//   (2) Creation (projectbox/projectRepo.js): marker, fixed identity "cbase" <cbase@cbase.invalid>, `core.hooksPath=.git/hooks`,
//       `commit.gpgsign=false`, no remote, branch main, first commit FIRST_COMMIT; `info/exclude` from its OWN complete search —
//       a repo with a `.git` FILE, one at depth 5, the 26th repo, one under a dot folder (everything git.js:findRepos would not
//       see) — plus the dependencies; afterwards `git status --porcelain` is EMPTY and no entry has mode 160000.
//  (2b) Unreadable files and folders (chmod 000): the first commit does not fail on them ("fatal: adding files failed"),
//       excludes them and names them (`unreadable`); a versioned file that becomes unreadable later drops out of the index.
//  (2c) The search yields the event loop and aborts at the cap WITH A MESSAGE (also during creation, no leftovers).
//  (2d) A `.gitignore` with `!certs/key.pem` (it ranks ABOVE info/exclude) would bring the unreadable file back and `add -A`
//       would abort — the own commit additionally excludes repos and unreadable files as path arguments.
//   (3) No second repo: a project folder that is a repo or lies in one — also via a LINK into a foreign repo (git searches from
//       the physical path) — gets none.
//  (3b) The environment redirects nothing: GIT_CONFIG_COUNT/_KEY_n/_VALUE_n, GIT_CONFIG_PARAMETERS and GIT_TEMPLATE_DIR neither
//       switch off the hook nor change the identity nor bring templates into `.git`.
//   (4) The hook rejects a new embedded repo and names it — also with a set GLOBAL `core.hooksPath`. Built-in sabotage: without
//       the LOCAL `core.hooksPath` the same commit goes through (the guard is not empty).
//   (5) An own commit maintains `info/exclude` BEFOREHAND; foreign lines stay; only with the marker.
//  (5b) An already versioned folder that becomes a repo after the first commit drops out of the index at the next own commit
//       (an exclusion only affects untracked files); its files stay.
//  (5c) Leftovers of the return-path program (`.cbase-back-*.tmp`) never enter the project repo; the pattern is the one of
//       stacks/returnPath.js rest_name.
//   (6) Return path only with the marker and only if HEAD is the own first commit; only `.git` is removed.
//   (7) Detection: projectRepos, readGitTree (project AND workspace level, so also findRepos, which keeps descending at the
//       marked root), the git actions (resolveRepoRoot) and okf (groupPathsByRepo) deliver the code repos, never the project
//       repo. Built-in counter-test: without the marker the repo at the project folder is THE repo of the project again.
//   (8) Main seam: a converted project (operating mark, fake docker, instance row => working folder = project folder) whose
//       project folder carries the project repo; `cbase_agent` with `isolation:"worktree"` branches off the code repo, not the
//       project repo (providers/agent-runtime.js selectRepo).
//   (9) WITH instance: the maintenance of `info/exclude` never writes through a link (the project container replaces the file
//       by one pointing at a file of B) — it throws EOUTSIDE, B's file stays; the hook is created via the descriptor, executable.
//  (9b) With instance — info/exclude is swapped for a link between reading (descriptor) and writing => EOUTSIDE, B's file stays.
//  (9c) With instance — an info/exclude above GIT_FILE_CAP is not read, abort with a message.
//  (10) WITHOUT instance every git is hardened: a decoy `core.fsmonitor` in the project repo's configuration does not run at the
//       own commit; the own `pre-commit` runs (for `commit` core.hooksPath explicitly points at `.git/hooks`).
// (10b) Likewise filters of the repo configuration (clean, process with required, a subsection with "="), `gpg.program` and
//       `diff.external` — none runs, the content goes raw into the repo.
//  (11) WITH instance: commitProjectRepo and removeProjectRepo read the marker only without a link (git.js isProjectRepo
//       `safe`, anchored at the root) — a FIFO at `.git/config` does not stop B (in a child process both end with "carries no
//       marker"), a link there does not count; WITHOUT instance today's call (the link counts). Verdict without a clock: the
//       test opens the FIFO for writing itself and writes the marker as soon as a reader is there — a blocking reader (the
//       bug) ends RED instead of hanging.
//  (12) createProjectRepo WITH instance — if a step fails after `git init`, the freshly created `.git` is removed by a `rm -rf`
//       IN the container (commandRun), never by fs.rmSync in B (the running main's container could swap a subfolder for a
//       link). If the rm fails in the container, `.git` stays and is named in the message (`gitStayed`) — B does not delete.
//  (13) removeProjectRepo WITH instance — `.git` is removed in the container; if its rm fails, it stays (`reason: "error"`).
//       Counted in the fake docker's log (`exec ... rm -rf -- <root>/.git`), failed via a fake `rm` first in the PATH.
//
// Isolated: HOME, XDG_CONFIG_HOME, GIT_CONFIG_GLOBAL=/dev/null, GIT_CONFIG_NOSYSTEM=1 for the whole test process (every git
// call in it, also the server's in (8)). The code repos of the tests get their identity per call (`-c`), never from the
// environment — it would override the project repo's local identity (GIT_CONFIG_COUNT outranks every file).
//
// Counter-tests (which sabotage turns which test red):
//   - git.js without isProjectRepo => (7) red (projectRepos delivers only the project repo), (2)/(4)/(5)/(6) red
//     (isProjectRepo missing), graph-worktree.test.js "project repo in the project folder" red;
//   - okf.js without the marker check => (7) red (notes.md belongs to the project repo);
//   - providers/agent-runtime.js without selectRepo's marker check => (8) red (the worktree belongs to the project repo);
//   - projectRepo.js without the identity, unreadable handling, cap, link check and environment hardening => (2) (identity), (2b),
//     (2c), (3) (link), (3b), (5b) red;
//   - projectRepo.js with `fs.rmSync` instead of the container `rm` => (12) and (13) red ("the .git was not removed via the
//     container — B deleted itself", 0 instead of 1 rm in the container);
//   - projectRepo.js without the explicit path exclusion => (2d) red ("adding files failed"); without the return-path
//     pattern => (5c) red (both leftovers in the index); with a plain read of info/exclude => (9c) red (the read seam counts 1);
//     with `fs.writeFileSync(file, text)` instead of writeInGit => (9b) red (B's file overwritten).
// This file imports no other test file.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import * as store from "../electron/server/store.js";
import { gitCommit, gitLog, isProjectRepo, listBranches, projectRepos, readGitTree } from "../electron/server/git.js";
import { groupPathsByRepo } from "../electron/server/okf.js";
import { setInProjectSeam } from "../electron/server/runtime/inProject.js";
import { dockerKind, dockerProgram } from "../electron/server/projectbox/docker.js";
import {
  DEPENDENCIES, FIRST_COMMIT, EXCLUDE_BEGINNING, EXCLUDE_END, GIT_FILE_CAP, HOOK_MARKER, IDENTITY, RETURN_PATH_REST,
  commitProjectRepo, embeddedRepos, removeProjectRepo, createProjectRepo, upkeepExclude,
} from "../electron/server/projectbox/projectRepo.js";
import { fakeClaude, json, withAgentsServer } from "./agent-harness.mjs";
import { fakeDocker } from "./fake-docker.mjs";

// ── Isolation ───────────────────────────────────────────────────────────────────────────────────
const ISO = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cbase-project-repo-")));
after(() => fs.rmSync(ISO, { recursive: true, force: true }));
fs.mkdirSync(path.join(ISO, "home"));
fs.mkdirSync(path.join(ISO, "xdg"));
Object.assign(process.env, { HOME: path.join(ISO, "home"), XDG_CONFIG_HOME: path.join(ISO, "xdg"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"]) delete process.env[k];

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────────
const TEST_ID = ["-c", "user.name=Test", "-c", "user.email=test@example.com"];
const gitRaw = (args, cwd, env = {}) => spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...env } });
const git = (args, cwd, env = {}) => {
  const r = gitRaw(args, cwd, env);
  assert.equal(r.status, 0, `git ${args.join(" ")} in ${cwd}: ${r.stderr}`);
  return r.stdout.trim();
};
const write = (file, content = "x\n") => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };
// A code repo with one commit (identity per call).
function codeRepo(dir, file = "a.txt") {
  write(path.join(dir, file), `${path.basename(dir)}\n`);
  git(["init", "-q", "-b", "main"], dir);
  git(["add", "-A"], dir);
  git([...TEST_ID, "commit", "-qm", "start"], dir);
  return dir;
}
function temp(t, name = "p") {
  const d = fs.mkdtempSync(path.join(ISO, `${name}-`));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}
const cfg = (dir, key) => gitRaw(["config", "--local", "--get", key], dir).stdout.trim();
const exclude = (dir) => fs.readFileSync(path.join(dir, ".git", "info", "exclude"), "utf8");
const real = (p) => fs.realpathSync(p);

// ── (1) ─────────────────────────────────────────────────────────────────────────────────────────
test("(1) isProjectRepo: only the marker in a .git folder — without marker, wrong, in a subsection, as a file or link: no", (t) => {
  const d = temp(t);
  const a = path.join(d, "a");
  codeRepo(a);
  assert.equal(isProjectRepo(a), false, "a code repo without marker");
  git(["config", "--local", "cbase.projectRepo", "true"], a);
  assert.equal(isProjectRepo(a), true, "with the marker as git writes it");
  git(["config", "--local", "cbase.projectRepo", "false"], a);
  assert.equal(isProjectRepo(a), false, "marker set to false");

  const cfgFile = path.join(a, ".git", "config");
  const base = fs.readFileSync(cfgFile, "utf8").replace(/\[cbase\][^[]*/, "");
  const including = (text) => { fs.writeFileSync(cfgFile, base + text); return isProjectRepo(a); };
  assert.equal(including("[cbase]\n\tProjectRepo\n"), true, "a key without \"=\" is true, names are case-insensitive");
  assert.equal(including("[cbase] projectrepo = yes ; comment\n"), true, "header and key on one line, yes, comment");
  assert.equal(including('[cbase "x"]\n\tprojectrepo = true\n'), false, "in a subsection it is a different key");
  assert.equal(including("[cbase]\n\tprojectrepo = true\n\tprojectrepo = 0\n"), false, "the last value wins");
  assert.equal(including("[cbase]\n\tprojectrepo =\n"), false, "empty is false");
  assert.equal(including("[cbase]\n\tprojectrepo = true\n"), true);

  // A `.git` FILE (worktree) and a link to the marked folder are not the project repo.
  const wt = path.join(d, "wt");
  git(["worktree", "add", "-q", "-b", "wt", wt], a);
  assert.equal(fs.statSync(path.join(wt, ".git")).isFile(), true);
  assert.equal(isProjectRepo(wt), false, "a worktree of the marked repo");
  const link = path.join(d, "link");
  fs.mkdirSync(link);
  fs.symlinkSync(path.join(a, ".git"), path.join(link, ".git"));
  assert.equal(isProjectRepo(link), false, "a link to the marked .git folder");
  assert.equal(isProjectRepo(path.join(d, "missing")), false);
  assert.equal(isProjectRepo(""), false);
});

// ── (2) ─────────────────────────────────────────────────────────────────────────────────────────
test("(2) creation: marker, identity, no remote, exclude from the complete search (.git file, depth 5, 26th repo, dot folder), status empty", async (t) => {
  const p = temp(t);
  write(path.join(p, "notes.md"), "# Notes\n");
  write(path.join(p, "deck", "slide.txt"));
  write(path.join(p, "writing-assistant", "main.py"), "print(1)\n"); // code without git
  write(path.join(p, "writing-assistant", ".venv", "lib", "x.py"));
  write(path.join(p, "node_modules", "pack", "index.js"));
  codeRepo(path.join(p, "node_modules", "git-package")); // a repo in the dependencies: the pattern covers it
  write(path.join(p, "sub", ".pptx-venv", "y"));
  write(path.join(p, ".playwright-mcp", "image.png"));
  const repos = [];
  for (let i = 1; i <= 26; i++) repos.push(codeRepo(path.join(p, "repos", `r${String(i).padStart(2, "0")}`)));
  codeRepo(path.join(p, "a", "b", "c", "d", "deep")); // depth 5 — findRepos searches down to 4
  codeRepo(path.join(p, ".werkzeug", "repo")); // under a dot folder — findRepos would skip it
  git(["worktree", "add", "-q", "-b", "onTheSide", path.join(p, "wt-app")], repos[0]); // `.git` as a FILE
  const expected = [...repos.map((r) => path.relative(p, r)), "a/b/c/d/deep", ".werkzeug/repo", "wt-app"].sort();
  assert.deepEqual(await embeddedRepos(p), expected, "the own search finds every embedded repo");

  const r = await createProjectRepo(p);
  assert.equal(r.created, true, JSON.stringify(r));
  assert.equal(r.branch, "main");
  assert.deepEqual(r.repos, expected);
  assert.deepEqual(r.unreadable, [], "nothing unreadable");
  assert.deepEqual(IDENTITY, { name: "cbase", email: "cbase@cbase.invalid" }, "the fixed identity (RFC 2606, never deliverable)");
  assert.equal(isProjectRepo(p), true, "the marker");
  assert.equal(cfg(p, "cbase.projectRepo"), "true");
  assert.equal(cfg(p, "user.name"), IDENTITY.name);
  assert.equal(cfg(p, "user.email"), IDENTITY.email);
  assert.equal(cfg(p, "core.hooksPath"), ".git/hooks");
  assert.equal(cfg(p, "commit.gpgsign"), "false");
  assert.equal(git(["remote"], p), "", "no remote");
  assert.equal(git(["symbolic-ref", "--short", "HEAD"], p), "main");
  assert.equal(git(["log", "--format=%an|%ae|%s"], p), `${IDENTITY.name}|${IDENTITY.email}|${FIRST_COMMIT}`, "exactly one commit, by cbase");
  assert.equal(git(["rev-parse", "HEAD"], p), r.commit);

  const ex = exclude(p);
  const block = ex.slice(ex.indexOf(EXCLUDE_BEGINNING), ex.indexOf(EXCLUDE_END));
  for (const rel of expected) assert.ok(block.includes(`\n/${rel}/\n`), `info/exclude: /${rel}/ missing\n${block}`);
  for (const z of DEPENDENCIES) assert.ok(block.includes(`\n${z}\n`), `info/exclude: ${z} missing`);

  assert.equal(git(["status", "--porcelain", "--untracked-files=all"], p), "", "nothing stays unversioned or changed");
  const index = git(["ls-files", "-s"], p).split("\n");
  assert.deepEqual(index.filter((z) => z.startsWith("160000")), [], "no embedded repo in the index");
  const files = git(["ls-files"], p).split("\n").sort();
  assert.deepEqual(files, ["deck/slide.txt", "notes.md", "writing-assistant/main.py"], "exactly what lies next to the repos");
  const hook = path.join(p, ".git", "hooks", "pre-commit");
  assert.ok(fs.readFileSync(hook, "utf8").includes(HOOK_MARKER));
  assert.ok((fs.statSync(hook).mode & 0o111) !== 0, "the hook is executable");
});

// ── (3) ─────────────────────────────────────────────────────────────────────────────────────────
test("(3) no second repo: a repo as project folder, a project folder inside a repo — created:false, nothing changed", async (t) => {
  const d = temp(t);
  const itself = codeRepo(path.join(d, "itself"));
  const prior = fs.readFileSync(path.join(itself, ".git", "config"), "utf8");
  assert.deepEqual(await createProjectRepo(itself), { created: false, reason: "repo", repo: itself });
  assert.equal(fs.readFileSync(path.join(itself, ".git", "config"), "utf8"), prior, "the configuration stays");
  const inside = path.join(itself, "subfolder");
  fs.mkdirSync(inside);
  assert.deepEqual(await createProjectRepo(inside), { created: false, reason: "in-repo", repo: itself });
  assert.equal(fs.existsSync(path.join(inside, ".git")), false);
  await assert.rejects(createProjectRepo(path.join(d, "missing")), /is missing or not a folder/);

  // A link into a foreign repo: lexically ws/proj lies in no repo, physically in the monorepo — git searches from the physical
  // path, an `init` there would put a second repo into the foreign one, and its git view would lose the monorepo.
  const mono = codeRepo(path.join(d, "mono"));
  write(path.join(mono, "proj", "a.txt"));
  const ws = path.join(d, "ws");
  fs.mkdirSync(ws);
  fs.symlinkSync(path.join(mono, "proj"), path.join(ws, "proj"));
  assert.deepEqual(await createProjectRepo(path.join(ws, "proj")), { created: false, reason: "in-repo", repo: mono });
  assert.equal(fs.existsSync(path.join(mono, "proj", ".git")), false, "no .git is created in the foreign repo");
  assert.deepEqual((await projectRepos(path.join(ws, "proj"))).map((x) => real(x.root)), [real(mono)], "the monorepo stays the project's repo");
});

// ── (2b) ────────────────────────────────────────────────────────────────────────────────────────
test("(2b) unreadable files and folders: the first commit does not fail, excludes and names them; becoming unreadable later drops out of the index", async (t) => {
  const p = temp(t);
  write(path.join(p, "note.md"));
  const key = path.join(p, "certs", "key.pem");
  const empty = path.join(p, "ends with space ");
  const sec = path.join(p, "sec");
  write(key);
  write(empty);
  write(path.join(sec, "x"));
  write(path.join(p, "later.txt"), "readable\n");
  const reset = () => {
    for (const [f, m] of [[key, 0o644], [empty, 0o644], [sec, 0o755], [path.join(p, "later.txt"), 0o644]]) { try { fs.chmodSync(f, m); } catch { /* missing */ } }
  };
  try {
    fs.chmodSync(key, 0);
    fs.chmodSync(empty, 0);
    fs.chmodSync(sec, 0);
    const r = await createProjectRepo(p);
    assert.equal(r.created, true, JSON.stringify(r));
    assert.deepEqual(r.unreadable, ["certs/key.pem", "ends with space ", "sec/"], "the omitted paths are in the result");
    assert.deepEqual(git(["ls-files"], p).split("\n").sort(), ["later.txt", "note.md"]);
    const st = gitRaw(["status", "--porcelain", "--untracked-files=all"], p);
    assert.equal(st.stdout, "", "nothing stays unversioned");
    assert.doesNotMatch(st.stderr, /could not open|Permission denied/, st.stderr);
    const ex = exclude(p);
    for (const z of ["/certs/key.pem", "/ends with space\\ ", "/sec/"]) assert.ok(ex.split("\n").includes(z), `info/exclude: ${z} missing\n${ex}`);

    // A versioned file becomes unreadable: the next own commit does not fail, it drops out of the index, the file stays.
    fs.chmodSync(path.join(p, "later.txt"), 0);
    const c = await commitProjectRepo(p, "afterwards");
    assert.deepEqual(c.unreadable, ["certs/key.pem", "ends with space ", "later.txt", "sec/"]);
    assert.deepEqual(git(["ls-files"], p).split("\n"), ["note.md"]);
    assert.equal(fs.existsSync(path.join(p, "later.txt")), true, "the file stays");
    // … and once it is readable again, the next commit takes it up again.
    reset();
    const c2 = await commitProjectRepo(p, "readable again");
    assert.deepEqual(c2.unreadable, []);
    assert.deepEqual(git(["ls-files"], p).split("\n").sort(), ["certs/key.pem", "ends with space ", "later.txt", "note.md", "sec/x"]);
  } finally {
    reset();
  }
});

// ── (2c) ────────────────────────────────────────────────────────────────────────────────────────
test("(2c) the search yields the event loop and aborts at the cap with a message — also during creation, no leftovers", async (t) => {
  const p = temp(t);
  for (let i = 0; i < 40; i++) for (let j = 0; j < 40; j++) fs.mkdirSync(path.join(p, "venv", `a${i}`, `b${j}`), { recursive: true });
  write(path.join(p, "note.md"));
  // A tick that only runs when the event loop is free in between (order, no duration).
  let run = true;
  let ticks = 0;
  const tick = () => { if (run) { ticks++; setImmediate(tick); } };
  setImmediate(tick);
  const repos = await embeddedRepos(p);
  run = false;
  assert.deepEqual(repos, []);
  assert.ok(ticks > 0, "the search over 1,642 folders never yielded the event loop");

  await assert.rejects(embeddedRepos(p, { cap: 100 }), /reached the cap of 100 folders .*aborted instead of cut/);
  await withEnvironment({ CBASE_PROJECT_REPO_FOLDER_CAP: "100" }, async () => {
    await assert.rejects(createProjectRepo(p), /reached the cap of 100 folders/);
  });
  assert.equal(fs.existsSync(path.join(p, ".git")), false, "the creation rolled back without leftovers");
});

// ── (3b) ────────────────────────────────────────────────────────────────────────────────────────
test("(3b) the environment redirects nothing: GIT_CONFIG_* and GIT_TEMPLATE_DIR switch neither hook nor identity", async (t) => {
  const p = temp(t);
  write(path.join(p, "note.md"));
  // Gets a code repo past the exclusion — only the hook stops it. The own commit also excludes every repo FOUND BY THE SEARCH
  // as a path argument (`!/code/` no longer suffices); so use one the search does not see: it does not descend into the
  // dependencies (their pattern covers it at any depth), and `!node_modules` cancels the pattern.
  write(path.join(p, ".gitignore"), "!node_modules\n");
  codeRepo(path.join(p, "node_modules", "code"));
  const template = temp(t, "template");
  write(path.join(template, "foreign.txt"));
  write(path.join(template, "hooks", "post-commit"), "#!/bin/sh\nexit 0\n");
  const foreign = {
    GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "/nonexistent",
    GIT_CONFIG_KEY_1: "user.email", GIT_CONFIG_VALUE_1: "foreign@example.com",
    GIT_CONFIG_PARAMETERS: "'user.name'='Foreign'", GIT_TEMPLATE_DIR: template,
  };
  await withEnvironment(foreign, async () => {
    await assert.rejects(createProjectRepo(p), /embedded repos \(mode 160000\)[\s\S]*\n {2}node_modules\/code\n/, "the hook rejects");
  });
  assert.equal(fs.existsSync(path.join(p, ".git")), false, "rolled back without leftovers");

  fs.rmSync(path.join(p, ".gitignore"));
  const r = await withEnvironment(foreign, () => createProjectRepo(p));
  assert.equal(r.created, true, JSON.stringify(r));
  assert.equal(git(["log", "-1", "--format=%an|%ae|%cn|%ce"], p), "cbase|cbase@cbase.invalid|cbase|cbase@cbase.invalid", "the local identity");
  assert.equal(fs.existsSync(path.join(p, ".git", "foreign.txt")), false, "no foreign template in .git");
  assert.equal(fs.existsSync(path.join(p, ".git", "hooks", "post-commit")), false, "no foreign hook");
  assert.deepEqual(git(["ls-files", "-s"], p).split("\n").filter((z) => z.startsWith("160000")), []);
});

// ── (4) ─────────────────────────────────────────────────────────────────────────────────────────
test("(4) hook: a fresh embedded repo is rejected and named, also with a global core.hooksPath; without the local one it goes through", async (t) => {
  const p = temp(t);
  write(path.join(p, "notes.md"));
  codeRepo(path.join(p, "app"));
  assert.equal((await createProjectRepo(p)).created, true);

  codeRepo(path.join(p, "new-repo")); // after creation: not in info/exclude
  git(["add", "-A"], p); // takes it up as mode 160000 (git only warns)
  assert.match(git(["ls-files", "-s", "new-repo"], p), /^160000 /);
  const rejected = gitRaw(["commit", "-qm", "with repo"], p);
  assert.notEqual(rejected.status, 0, "the hook rejects");
  assert.match(rejected.stderr, /embedded repos \(mode 160000\)/);
  assert.match(rejected.stderr, /^ {2}new-repo$/m, `it names it: ${rejected.stderr}`);

  // A global core.hooksPath (pointing at an empty folder) — the own one set locally wins.
  const empty = fs.mkdtempSync(path.join(ISO, "hooks-empty-"));
  const global = path.join(ISO, "global.gitconfig");
  fs.writeFileSync(global, `[core]\n\thooksPath = ${empty}\n`);
  const withGlobal = gitRaw(["commit", "-qm", "with repo"], p, { GIT_CONFIG_GLOBAL: global });
  assert.notEqual(withGlobal.status, 0, `local wins: ${withGlobal.stderr}`);
  assert.match(withGlobal.stderr, /new-repo/);

  // Built-in sabotage: without the local core.hooksPath the global one silently switches the hook off — the commit goes through.
  git(["config", "--local", "--unset", "core.hooksPath"], p);
  const through = gitRaw(["commit", "-qm", "with repo"], p, { GIT_CONFIG_GLOBAL: global });
  assert.equal(through.status, 0, `without a local core.hooksPath the commit goes through: ${through.stderr}`);
  assert.match(git(["ls-tree", "HEAD", "new-repo"], p), /^160000 commit /, "and carries the embedded repo");
});

// ── (5) ─────────────────────────────────────────────────────────────────────────────────────────
test("(5) own commit: info/exclude maintained beforehand, foreign lines stay, only with the marker", async (t) => {
  const p = temp(t);
  write(path.join(p, "notes.md"));
  codeRepo(path.join(p, "app"));
  const r = await createProjectRepo(p);
  fs.appendFileSync(path.join(p, ".git", "info", "exclude"), "*.tmp\n");
  codeRepo(path.join(p, "second", "repo"));
  write(path.join(p, "fresh.md"), "new\n");
  write(path.join(p, "way.tmp"));
  fs.rmSync(path.join(p, "app"), { recursive: true, force: true }); // a repo disappears: its line too
  write(path.join(p, "app", "now-file.txt"), "no repo any more\n");
  const c = await commitProjectRepo(p, "Second state");
  assert.notEqual(c.commit, r.commit);
  assert.deepEqual(c.repos, ["second/repo"]);
  const ex = exclude(p);
  assert.ok(ex.includes("\n/second/repo/\n") && !ex.includes("\n/app/\n"), ex);
  assert.ok(ex.includes("*.tmp\n"), "the foreign line stays");
  assert.equal(ex.split(EXCLUDE_BEGINNING).length, 2, "exactly one cbase block");
  assert.deepEqual(git(["ls-files"], p).split("\n").sort(), ["app/now-file.txt", "fresh.md", "notes.md"]);
  assert.equal(git(["status", "--porcelain", "--untracked-files=all"], p), "");
  await assert.rejects(commitProjectRepo(p, "  "), /message missing/);
  const foreign = codeRepo(path.join(temp(t, "foreign"), "r"));
  await assert.rejects(commitProjectRepo(foreign, "x"), /carries no marker/);
});

// ── (5b) ────────────────────────────────────────────────────────────────────────────────────────
test("(5b) a versioned folder becomes a repo after the first commit: the next own commit takes it out of the index", async (t) => {
  const p = temp(t);
  write(path.join(p, "note.md"));
  write(path.join(p, "notes", "x.md"), "one\n");
  assert.equal((await createProjectRepo(p)).created, true);
  assert.deepEqual(git(["ls-files"], p).split("\n").sort(), ["note.md", "notes/x.md"]);
  git(["init", "-q", "-b", "main"], path.join(p, "notes"));
  write(path.join(p, "notes", "x.md"), "two\n");
  const c = await commitProjectRepo(p, "second");
  assert.deepEqual(c.repos, ["notes"]);
  assert.deepEqual(git(["ls-files"], p).split("\n"), ["note.md"], "notes/ now belongs to its own repo");
  assert.equal(git(["show", "--format=", "--name-status", "HEAD"], p), "D\tnotes/x.md", "the commit takes the old version out, it does not add the new one");
  assert.equal(fs.readFileSync(path.join(p, "notes", "x.md"), "utf8"), "two\n", "the file stays");
  assert.equal(git(["status", "--porcelain", "--untracked-files=all"], p), "");
});

// ── (5c) P2C-A5 ─────────────────────────────────────────────────────────────────────────────────
test("(5c) leftovers of the return-path program (`.cbase-back-*.tmp`, file or folder, any depth) never enter the project repo", async (t) => {
  // The pattern is the program's (stacks/returnPath.js rest_name) — projectbox/ never imports stacks/, the guard holds both.
  const rw = fs.readFileSync(path.join(import.meta.dirname, "../electron/server/stacks/returnPath.js"), "utf8");
  assert.match(rw, /def rest_name\(z, rel\):\n\s+return os\.path\.join\(os\.path\.dirname\(z\), b"\.cbase-back-" \+ [^\n]+ \+ b"\.tmp"\)/, "rest_name has a different pattern than RETURN_PATH_REST");
  assert.equal(RETURN_PATH_REST, ".cbase-back-*.tmp");
  const p = temp(t);
  write(path.join(p, "note.md"));
  assert.equal((await createProjectRepo(p)).created, true);
  write(path.join(p, ".cbase-back-abc.tmp"), "rest\n");
  write(path.join(p, "sub", ".cbase-back-def.tmp", "x"), "rest\n");
  write(path.join(p, "sub", "real.md"), "real\n");
  await commitProjectRepo(p, "after a killed return path");
  assert.deepEqual(git(["ls-files"], p).split("\n").sort(), ["note.md", "sub/real.md"], "a leftover of the return-path program was committed");
  assert.ok(exclude(p).split("\n").includes(RETURN_PATH_REST), "the line is missing in the block");
});

// ── (2d) ~D3-NB-8 ───────────────────────────────────────────────────────────────────────────────
test("(2d) a .gitignore with `!certs/key.pem` does not bring the unreadable file back — created, `unreadable`, not in the index", async (t) => {
  const p = temp(t);
  write(path.join(p, "note.md"));
  write(path.join(p, ".gitignore"), "!certs/key.pem\n");
  const key = path.join(p, "certs", "key.pem");
  write(key);
  try {
    fs.chmodSync(key, 0);
    const r = await createProjectRepo(p);
    assert.equal(r.created, true, JSON.stringify(r));
    assert.deepEqual(r.unreadable, ["certs/key.pem"]);
    assert.deepEqual(git(["ls-files"], p).split("\n").sort(), [".gitignore", "note.md"], "the unreadable file is in the index");
    // The next own commit too.
    write(path.join(p, "fresh.md"), "new\n");
    const c = await commitProjectRepo(p, "afterwards");
    assert.deepEqual(c.unreadable, ["certs/key.pem"]);
    assert.deepEqual(git(["ls-files"], p).split("\n").sort(), [".gitignore", "fresh.md", "note.md"]);
  } finally { fs.chmodSync(key, 0o644); }
});

// ── (6) ─────────────────────────────────────────────────────────────────────────────────────────
test("(6) return path: only with the marker and only if HEAD is the own first commit — only .git is removed", async (t) => {
  const p = temp(t);
  write(path.join(p, "notes.md"), "stays\n");
  const r = await createProjectRepo(p);
  assert.deepEqual(await removeProjectRepo(p, {}), { removed: false, reason: "without-commit" });
  assert.deepEqual(await removeProjectRepo(p, { commit: r.commit }), { removed: true });
  assert.equal(fs.existsSync(path.join(p, ".git")), false);
  assert.equal(fs.readFileSync(path.join(p, "notes.md"), "utf8"), "stays\n", "the files stay");

  const r2 = await createProjectRepo(p);
  write(path.join(p, "afterwards.md"));
  const c = await commitProjectRepo(p, "afterwards");
  const further = await removeProjectRepo(p, { commit: r2.commit });
  assert.equal(further.removed, false);
  assert.equal(further.reason, "head-continue");
  assert.equal(further.head, c.commit);
  assert.equal(isProjectRepo(p), true, "the repo stays");

  const foreign = codeRepo(path.join(temp(t, "foreign"), "r"));
  const head = git(["rev-parse", "HEAD"], foreign);
  assert.deepEqual(await removeProjectRepo(foreign, { commit: head }), { removed: false, reason: "without-marker" });
  assert.equal(fs.existsSync(path.join(foreign, ".git")), true, "a foreign repo is never removed");
});

// ── (7) ─────────────────────────────────────────────────────────────────────────────────────────
test("(7) detection: projectRepos, readGitTree (project and workspace), git actions, okf — the code repos; without the marker as before", async (t) => {
  const w = temp(t, "ws");
  const p = path.join(w, "till");
  write(path.join(p, "notes.md"));
  const app = codeRepo(path.join(p, "app"));
  const lib = codeRepo(path.join(p, "packages", "lib"));
  codeRepo(path.join(w, "depot", "app2"));
  assert.equal((await createProjectRepo(p)).created, true);

  const codeRepos = [{ name: "app", relPath: "app", root: real(app) }, { name: "packages/lib", relPath: "packages/lib", root: real(lib) }];
  const norm = (list) => list.map((x) => ({ name: x.name, relPath: x.relPath, root: real(x.root) }));
  assert.deepEqual(norm(await projectRepos(p)), codeRepos, "projectRepos: the code repos below the project repo");
  assert.deepEqual((await readGitTree(p)).repos.map((x) => x.relPath), ["app", "packages/lib"], "git view of the project");
  const wsTree = (await readGitTree(w)).repos.map((x) => x.relPath);
  assert.deepEqual(wsTree, ["depot/app2", "till/app", "till/packages/lib"], "git view of the workspace: findRepos keeps descending at the marked root");

  // Git actions: the project folder ("") and a folder next to the repos do not hit the project repo.
  await assert.rejects(listBranches(p, ""), /Kein Git-Repository an diesem Pfad/);
  fs.mkdirSync(path.join(p, "deck"));
  await assert.rejects(gitLog(p, "deck"), /Kein Git-Repository an diesem Pfad/);
  await assert.rejects(gitCommit(p, "", "via the view", { all: true }), /Kein Git-Repository an diesem Pfad/);
  await assert.rejects(listBranches(w, "till"), /Kein Git-Repository an diesem Pfad/, "also from the workspace level");
  assert.deepEqual((await listBranches(p, "app")).locals, ["main"], "a code repo works as before");

  // okf: a note next to the repos belongs to no repo (otherwise it would be "stale" after every cbase commit).
  const { groups } = groupPathsByRepo(p, ["notes.md", "app/a.txt"]);
  assert.deepEqual([...groups.keys()], ["app"], "okf: only the code repo");

  // Built-in counter-test: without the marker the repo at the project folder is THE project repo again.
  git(["config", "--local", "--unset", "cbase.projectRepo"], p);
  assert.deepEqual((await projectRepos(p)).map((x) => x.relPath), [""], "without marker: the one repo of the project folder");
  assert.deepEqual([...groupPathsByRepo(p, ["notes.md"]).groups.keys()], ["."], "without marker: okf as before");
  assert.deepEqual((await readGitTree(w)).repos.map((x) => x.relPath), ["depot/app2", "till"], "without marker: findRepos as before");
});

// ── (8) Main seam ───────────────────────────────────────────────────────────────────────────────
async function withEnvironment(values, fn) {
  const saved = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(values)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
// Operating mark, fake docker, CLI homes in B in a throwaway folder (as in project-working-folder.test.js).
const ops = (fd) => ({
  CBASE_CONTAINER: "1", CBASE_DIND: "1", CBASE_DOCKER_BIN: fd.bin, CBASE_IN_PROJECT_ESCALATION_MS: "200",
  CLAUDE_CONFIG_DIR: path.join(fd.dir, "b-home", ".claude"), CODEX_HOME: path.join(fd.dir, "b-home", ".codex"),
});
const containerStart = (fd, name) =>
  execFileSync(fd.bin, ["run", "-d", "--name", name, "cbase-projectbox:test"], { env: { ...process.env, ...fd.env } });

// The main agent: stores its working folder and starts the calls from the message (after "CALLS:") in the foreground; every
// result is stored under its `tag` in the throwaway folder, an error result with "ERROR " in front.
const MAIN = `
  fs.writeFileSync(path.join(LOCATION, "main-cwd.txt"), process.cwd());
  const everything = ((msg.message && msg.message.content) || []).map((c) => (c && c.text) || "").join("\\n");
  const calls = JSON.parse(everything.slice(everything.indexOf("CALLS:") + 6).split("\\n")[0]);
  for (let i = 0; i < calls.length; i++) {
    const { tag, ...rest } = calls[i];
    const id = "toolu_" + tag;
    const input = { run_in_background: false, description: "Part " + tag, ...rest };
    say({ type: "assistant", message: { id: "m_" + tag, content: [{ type: "tool_use", id, name: "mcp__cbase__cbase_agent", input }] } });
    const r = await mcpCall("cbase_agent", input);
    const t = (r.result && r.result.isError ? "ERROR " : "") + textOf(r);
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: t }] } });
    fs.writeFileSync(path.join(LOCATION, "res-" + tag + ".txt"), t);
  }
  finished();
  say({ type: "result", result: "finished", session_id: "main-session" });`;
const SUB = `
  if (text.includes("CHANGE")) fs.writeFileSync(path.join(process.cwd(), "new.txt"), "from the subagent\\n");
  finished();
  say({ type: "result", result: "cwd=" + process.cwd(), session_id: "sub-session" });`;

test("(8) main seam: working folder = project folder with project repo — isolation:'worktree' branches off the code repo, never the project repo", async () => {
  const fd = await fakeDocker();
  try {
    await withAgentsServer(async (ctx) => {
      const { base, chat, ws, root } = ctx;
      await withEnvironment(ops(fd), async () => {
        const projPath = path.join(ws.path, "till");
        fs.mkdirSync(projPath, { recursive: true });
        const p = await ctx.projectWithoutInstance({ name: "Checkout", path: projPath });
        write(path.join(projPath, "notes.md"));
        const app = codeRepo(path.join(projPath, "app"));
        const created = await createProjectRepo(projPath);
        assert.equal(created.created, true, JSON.stringify(created));
        const name = `cbase-p-${p.id}`;
        containerStart(fd, name);
        store.createProjectInstance({ projectId: p.id, state: "ready", convertedAt: Date.now(), containerId: name });
        await json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ projectId: p.id }) });

        const calls = [{ tag: "wt", isolation: "worktree", prompt: "CHANGE please" }];
        await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: `CALLS:${JSON.stringify(calls)}` }) });
        // Wait for QUIET (turn including subagent), THEN check — a failed start would otherwise hang waiting for `meta`.
        await ctx.waitForQuiet();
        const log = await json(`${base}/api/chats/${chat.id}/log`);
        assert.ok(log.some((m) => m.role === "meta"), `the turn did not run through (log: ${JSON.stringify(log).slice(-600)})`);

        assert.equal(real(fs.readFileSync(path.join(root, "main-cwd.txt"), "utf8")), real(projPath), "the main run works in the project folder");
        const t = fs.readFileSync(path.join(root, "res-wt.txt"), "utf8");
        assert.doesNotMatch(t, /^ERROR /, t);
        const b = JSON.parse(t);
        assert.ok(b.worktree, `the changed worktree is in the report: ${t}`);
        assert.equal(real(git(["rev-parse", "--git-common-dir"], b.worktree)), real(path.join(app, ".git")), "the worktree belongs to the code repo app");
        assert.equal(real(/cwd=(\S+)/.exec(b.report)?.[1] || ""), real(b.worktree), "the subagent worked in the worktree");
        assert.equal(git(["worktree", "list", "--porcelain"], projPath).split("\n").filter((l) => l.startsWith("worktree ")).length, 1, "the project repo got no worktree");
        assert.equal(git(["branch", "--list", "cbase/*"], projPath), "", "and no branch");
        assert.ok(git(["branch", "--list", "cbase/*", "--format=%(refname:short)"], app).includes(`cbase/agent-${b.agentId}`), "the branch is in the code repo");
        const sub = fd.calls({ daemon: "host" }).find((a) => a.args[0] === "exec" && (a.args.includes(b.worktree) || a.args.includes(real(b.worktree))));
        assert.ok(sub, "the subagent started in the project container, with the worktree as -w");
      });
    }, { claude: fakeClaude({ main: MAIN, sub: SUB }) });
  } finally {
    fd.cleanUp();
  }
});

// ── (9) With instance: no writing through a link in .git ─────────────────────────────────────────────────
test("(9) with instance: info/exclude is never written through a link (EOUTSIDE, B's file stays); the hook is created via the descriptor", async (t) => {
  const fd = await fakeDocker();
  const location = temp(t, "processes");
  const name = `cbase-p-seven${path.basename(location).replace(/[^a-z0-9]/gi, "").toLowerCase()}`;
  try {
    await withEnvironment({ ...ops(fd), GIT_TERMINAL_PROMPT: undefined }, async () => {
      containerStart(fd, name);
      setInProjectSeam({ kind: dockerKind, program: dockerProgram, processLocation: () => location, container: (i) => i.containerId });
      const inst = { projectId: "p7", instance: "main", identifier: "p7/main", containerId: name };
      const p = temp(t);
      write(path.join(p, "notes.md"));
      const r = await createProjectRepo(p, { instance: inst });
      assert.equal(r.created, true, JSON.stringify(r));
      const hook = path.join(p, ".git", "hooks", "pre-commit");
      assert.ok(fs.readFileSync(hook, "utf8").includes(HOOK_MARKER), "the hook is missing");
      assert.equal(fs.statSync(hook).mode & 0o777, 0o755, "the hook is not executable");
      assert.ok(exclude(p).includes(EXCLUDE_BEGINNING), "info/exclude without block");

      // The project container replaces info/exclude by a link to a file of B (~/.bashrc, the database …).
      const bFile = path.join(temp(t, "b"), "b-file");
      fs.writeFileSync(bFile, "B-FILE\n");
      const ex = path.join(p, ".git", "info", "exclude");
      fs.rmSync(ex);
      fs.symlinkSync(bFile, ex);
      codeRepo(path.join(p, "new-repo")); // the block changes — so it would be written
      await assert.rejects(commitProjectRepo(p, "Second state", { instance: inst }), (e) => e.code === "EOUTSIDE", "the maintenance followed the link");
      assert.equal(fs.readFileSync(bFile, "utf8"), "B-FILE\n", "B wrote through the link into .git/info/exclude");
      assert.ok(fs.lstatSync(ex).isSymbolicLink(), "the link was replaced");
    });
  } finally {
    setInProjectSeam(null);
    fd.cleanUp();
  }
});

// With instance (as in (9)): a project repo in the fake container, `fn({ p, inst, ex })`.
async function withInstanceRepo(t, identifier, fn) {
  const fd = await fakeDocker();
  const location = temp(t, "processes");
  const name = `cbase-p-${identifier}${path.basename(location).replace(/[^a-z0-9]/gi, "").toLowerCase()}`;
  try {
    await withEnvironment({ ...ops(fd), GIT_TERMINAL_PROMPT: undefined }, async () => {
      containerStart(fd, name);
      setInProjectSeam({ kind: dockerKind, program: dockerProgram, processLocation: () => location, container: (i) => i.containerId });
      const inst = { projectId: identifier, instance: "main", identifier: `${identifier}/main`, containerId: name };
      const p = temp(t);
      write(path.join(p, "notes.md"));
      assert.equal((await createProjectRepo(p, { instance: inst })).created, true);
      await fn({ p, inst, ex: path.join(p, ".git", "info", "exclude") });
    });
  } finally {
    setInProjectSeam(null);
    fd.cleanUp();
  }
}

// The project container swaps `info/exclude` EXACTLY between reading and writing for a link to a file of B — the read seam
// `fs.readFileSync(<fd>)` in readInGit does the swap. The write reopens, without a link.
// Counter-test: writeInGit replaced by `fs.writeFileSync(file, text)` => red (B-FILE overwritten).
test("(9b) with instance — info/exclude is swapped for a link between reading and writing => EOUTSIDE, B's file stays", async (t) => {
  await withInstanceRepo(t, "nineb", async ({ p, inst, ex }) => {
    const bFile = path.join(temp(t, "b"), "b-file");
    fs.writeFileSync(bFile, "B-FILE\n");
    const ino = fs.statSync(ex).ino;
    codeRepo(path.join(p, "new-repo")); // the block changes — so it would be written
    const orig = fs.readFileSync;
    let swapped = 0;
    t.mock.method(fs, "readFileSync", function (file, ...rest) {
      if (typeof file === "number" && !swapped && fs.fstatSync(file).ino === ino) {
        swapped += 1;
        fs.rmSync(ex);
        fs.symlinkSync(bFile, ex);
      }
      return orig.call(fs, file, ...rest);
    });
    try {
      await assert.rejects(commitProjectRepo(p, "Second state", { instance: inst }), (e) => e.code === "EOUTSIDE", "the maintenance wrote through the link");
    } finally { t.mock.restoreAll(); }
    assert.equal(swapped, 1, "the read seam was not passed");
    assert.equal(fs.readFileSync(bFile, "utf8"), "B-FILE\n", "B wrote through the swapped link");
    assert.ok(fs.lstatSync(ex).isSymbolicLink());
  });
});

// A sparse `info/exclude` of 2 GB (the project container can write it) is never read by B — fstat on the descriptor before
// reading, abort with a message above GIT_FILE_CAP. The read seam counts every read of this file and does not read itself.
test("(9c) with instance — an info/exclude above the cap (sparse, 2 GB) is not read, upkeepExclude aborts with a message", async (t) => {
  await withInstanceRepo(t, "ninec", async ({ p, inst, ex }) => {
    fs.truncateSync(ex, 2 * 1024 ** 3);
    const ino = fs.statSync(ex).ino;
    const orig = fs.readFileSync;
    let read = 0;
    t.mock.method(fs, "readFileSync", function (file, ...rest) {
      if (typeof file === "number" && fs.fstatSync(file).ino === ino) { read += 1; throw new Error("read seam: the 2 GB file was read"); }
      return orig.call(fs, file, ...rest);
    });
    try {
      await assert.rejects(upkeepExclude(p, { instance: inst }), (e) => e.code === "ETOOLARGE" && e.message.includes(String(GIT_FILE_CAP)) && /cap/.test(e.message), "no abort with a message");
    } finally { t.mock.restoreAll(); }
    assert.equal(read, 0, "the file above the cap was read");
    assert.equal(fs.statSync(ex).size, 2 * 1024 ** 3, "the file was touched");
  });
});

// ── (10) Without instance: every git hardened ────────────────────────────────────────────────────────────────────
test("(10) without instance: a decoy core.fsmonitor in the project repo does not run at the own commit — the own pre-commit runs", async (t) => {
  const p = temp(t);
  write(path.join(p, "notes.md"));
  codeRepo(path.join(p, "app"));
  assert.equal((await createProjectRepo(p)).created, true);
  const markerF = path.join(ISO, `fsmonitor-${path.basename(p)}`);
  const markerC = path.join(ISO, `pre-commit-${path.basename(p)}`);
  git(["config", "core.fsmonitor", `touch '${markerF}'; false`], p);
  const hook = path.join(p, ".git", "hooks", "pre-commit");
  fs.writeFileSync(hook, fs.readFileSync(hook, "utf8").replace(/\nexit 0\n$/, `\ntouch '${markerC}'\nexit 0\n`));
  write(path.join(p, "fresh.md"), "new\n");
  await commitProjectRepo(p, "Second state");
  assert.equal(fs.existsSync(markerF), false, "core.fsmonitor of the repo configuration ran in B");
  assert.equal(fs.existsSync(markerC), true, "the own pre-commit did not run (core.hooksPath for commit)");
  assert.deepEqual(git(["ls-files"], p).split("\n").sort(), ["fresh.md", "notes.md"]);
});

// Filters (`clean`, `process` with `required`, also a subsection with "=" that `-c` splits wrongly) and `gpg.program` from the
// repo configuration must not run at the own commit in B.
// Counter-test: projectRepo.js without the hardening => red (the decoy markers exist or `add` dies on the required filter).
test("(10b) without instance: filters (clean, process+required, subsection with \"=\"), gpg.program and diff.external of the repo configuration do not run at the own commit — the content goes raw into the repo", async (t) => {
  const p = temp(t);
  write(path.join(p, "notes.md"));
  assert.equal((await createProjectRepo(p)).created, true);
  const markers = fs.mkdtempSync(path.join(ISO, "n23-"));
  const decoy = (name) => `touch '${path.join(markers, name)}'; cat`;
  git(["config", "filter.malicious.clean", decoy("clean")], p);
  git(["config", "filter.malicious.smudge", decoy("smudge")], p);
  git(["config", "filter.x=y.clean", decoy("equal")], p);
  git(["config", "filter.proz.process", `touch '${path.join(markers, "process")}'; false`], p);
  git(["config", "filter.proz.required", "true"], p);
  git(["config", "diff.external", decoy("diff-external")], p);
  git(["config", "commit.gpgSign", "true"], p);
  git(["config", "gpg.program", `${path.join(markers, "gpg.sh")}`], p);
  fs.writeFileSync(path.join(markers, "gpg.sh"), `#!/bin/sh\ntouch '${path.join(markers, "gpg")}'\nexit 1\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(p, ".git", "info", "attributes"), "*.txt filter=malicious\n*.md filter=x=y\n*.bin filter=proz\n");
  write(path.join(p, "a.txt"), "content a\n");
  write(path.join(p, "b.md"), "content b\n");
  write(path.join(p, "c.bin"), "content c\n");
  await commitProjectRepo(p, "Second state");
  const run = fs.readdirSync(markers).filter((n) => n !== "gpg.sh").sort();
  assert.deepEqual(run, [], `commands of the repo configuration ran in B: ${run.join(", ")}`);
  assert.deepEqual(git(["ls-files"], p).split("\n").sort(), ["a.txt", "b.md", "c.bin", "notes.md"]);
  assert.equal(git(["log", "-1", "--format=%s"], p), "Second state");
  for (const [file, content] of [["a.txt", "content a"], ["b.md", "content b"], ["c.bin", "content c"]]) {
    assert.equal(git(["-c", "filter.malicious.smudge=", "-c", "filter.proz.process=", "-c", "filter.proz.required=false", "cat-file", "-p", `HEAD:${file}`], p), content);
  }
});

// ── (11) The marker of a converted project only without a link ──────────────────────────────────────
const MARKER_PROJECT_REPO = "[cbase]\n\tprojectrepo = true\n";
const INST_N2 = { projectId: "p9", instance: "main", identifier: "p9/main", containerId: "cbase-p-p9" };
const PROJECT_REPO_JS = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "electron", "server", "projectbox", "projectRepo.js");
// A FIFO without a writer, read in a CHILD PROCESS (`script`, ESM) — same build as projectbox-git.test.js: the test opens the
// FIFO for writing ITSELF beforehand (that waits in the thread pool for a reader) and writes `content` as soon as that succeeds;
// a blocking reader (the bug) thus gets the content and ends with it, a reader with O_NONBLOCK that accepts only regular files
// never reads from it. After the child ends, an own reader (O_NONBLOCK) releases a still waiting writer.
async function fifoInChild(fifo, content, script, env) {
  const writer = fs.promises.open(fifo, "w").then(async (fh) => {
    try { await fh.write(content); } catch { /* the reader is already gone (EPIPE) */ } finally { await fh.close(); }
  });
  const subprocess = spawn(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const r = await new Promise((resolve) => {
    let out = "", err = "";
    subprocess.stdout.on("data", (d) => { out += d; });
    subprocess.stderr.on("data", (d) => { err += d; });
    subprocess.on("close", (code, signal) => resolve({ out, err, code, signal }));
  });
  const fd = fs.openSync(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  try { await writer; } finally { fs.closeSync(fd); }
  return r;
}

test("(11) with instance: a FIFO at .git/config does not stop B — commitProjectRepo and removeProjectRepo end with \"carries no marker\"", async (t) => {
  const p = temp(t);
  fs.mkdirSync(path.join(p, ".git"));
  const fifo = path.join(p, ".git", "config");
  execFileSync("mkfifo", [fifo]);
  // ONE child per function (a second blocking read in the same child would find no writer). Without the seam every git in the
  // container fails at once — if B reads the marker (the bug), the call ends there instead of at "carries no marker".
  const env = { PR_JS: PROJECT_REPO_JS, PROJ: p, INST: JSON.stringify(INST_N2) };
  const commit = await fifoInChild(fifo, MARKER_PROJECT_REPO, `const { commitProjectRepo } = await import(process.env.PR_JS);
    try { await commitProjectRepo(process.env.PROJ, "Second state", { instance: JSON.parse(process.env.INST) }); process.stdout.write("committed"); }
    catch (e) { process.stdout.write(String(e?.message || e)); }`, env);
  assert.equal(commit.code, 0, `Kind: ${commit.signal || commit.code} ${commit.err}`);
  assert.match(commit.out, /carries no marker/, `B read .git/config from the FIFO (the marker arrived): ${commit.out}`);
  const way = await fifoInChild(fifo, MARKER_PROJECT_REPO, `const { removeProjectRepo } = await import(process.env.PR_JS);
    process.stdout.write(JSON.stringify(await removeProjectRepo(process.env.PROJ, { commit: "a".repeat(40), instance: JSON.parse(process.env.INST) })));`, env);
  assert.equal(way.code, 0, `Kind: ${way.signal || way.code} ${way.err}`);
  assert.deepEqual(JSON.parse(way.out), { removed: false, reason: "without-marker" }, `B read .git/config from the FIFO (the marker arrived): ${way.out}`);
  assert.ok(fs.existsSync(path.join(p, ".git")), ".git stayed");
});

test("(11) with instance: a link at .git/config does not count as marker — without instance as before", async (t) => {
  const p = temp(t);
  const outside = path.join(temp(t, "b"), "b-file");
  fs.writeFileSync(outside, MARKER_PROJECT_REPO);
  fs.mkdirSync(path.join(p, ".git"));
  fs.symlinkSync(outside, path.join(p, ".git", "config"));
  const commit = "a".repeat(40);
  await assert.rejects(commitProjectRepo(p, "Second state", { instance: INST_N2 }), /carries no marker/, "commitProjectRepo followed the link");
  assert.deepEqual(await removeProjectRepo(p, { commit, instance: INST_N2 }), { removed: false, reason: "without-marker" }, "removeProjectRepo followed the link");
  // Without instance the plain call: the marker behind the link counts (HEAD missing => "head-continue", nothing is removed).
  const today = await removeProjectRepo(p, { commit });
  assert.equal(today.reason, "head-continue", `without instance the call changed: ${JSON.stringify(today)}`);
  assert.ok(fs.lstatSync(path.join(p, ".git", "config")).isSymbolicLink(), "the link stayed");
  assert.equal(fs.readFileSync(outside, "utf8"), MARKER_PROJECT_REPO);
});

// ── (12)/(13) With instance the container deletes, never B ───────────────────────────────────────────────────────
// An `rm` that fails in the "container": the fake docker runs exec locally with the test process's PATH — an `rm` first on the
// PATH therefore hits ONLY the way via the container; B deletes with fs.rmSync and never sees it.
function brokenRm(t) {
  const bin = temp(t, "rm-bin");
  fs.writeFileSync(path.join(bin, "rm"), "#!/bin/sh\necho 'rm: refused in container' >&2\nexit 1\n", { mode: 0o755 });
  return bin;
}
const rmInContainer = (fd, from, target) => fd.calls().slice(from).filter((a) => a.args[0] === "exec" && a.args.includes("rm") && a.args.at(-1) === target);

test("(12) createProjectRepo with instance — if a step fails after `git init`, the container removes the .git; if its rm fails, .git stays and is named in the message (B does not delete afterwards)", async (t) => {
  const fd = await fakeDocker();
  const location = temp(t, "processes");
  const name = `cbase-p-twelve${path.basename(location).replace(/[^a-z0-9]/gi, "").toLowerCase()}`;
  try {
    await withEnvironment({ ...ops(fd), GIT_TERMINAL_PROMPT: undefined, CBASE_PROJECT_REPO_FOLDER_CAP: "1" }, async () => {
      containerStart(fd, name);
      setInProjectSeam({ kind: dockerKind, program: dockerProgram, processLocation: () => location, container: (i) => i.containerId });
      const inst = { projectId: "p12", instance: "main", identifier: "p12/main", containerId: name };
      const project = () => { const p = temp(t); write(path.join(p, "a", "b", "note.md")); return p; };

      const p = project();
      const from = fd.calls().length;
      await assert.rejects(createProjectRepo(p, { instance: inst }), /reached the cap of 1 folders/);
      assert.equal(fs.existsSync(path.join(p, ".git")), false, "the freshly created .git stayed");
      assert.equal(rmInContainer(fd, from, path.join(p, ".git")).length, 1, "the .git was not removed via the container — B deleted itself");

      const p2 = project();
      await withEnvironment({ PATH: `${brokenRm(t)}:${process.env.PATH}` }, async () => {
        await assert.rejects(createProjectRepo(p2, { instance: inst }),
          (e) => /reached the cap of 1 folders/.test(e.message) && /stayed behind/.test(e.message) && e.gitStayed === path.join(p2, ".git"));
      });
      assert.equal(fs.existsSync(path.join(p2, ".git")), true, "B deleted the .git itself after the container failed");
    });
  } finally {
    setInProjectSeam(null);
    fd.cleanUp();
  }
});

test("(13) removeProjectRepo with instance — `.git` is removed in the container; if its rm fails, it stays (reason \"error\"), B does not delete", async (t) => {
  const fd = await fakeDocker();
  const location = temp(t, "processes");
  const name = `cbase-p-thirteen${path.basename(location).replace(/[^a-z0-9]/gi, "").toLowerCase()}`;
  try {
    await withEnvironment({ ...ops(fd), GIT_TERMINAL_PROMPT: undefined }, async () => {
      containerStart(fd, name);
      setInProjectSeam({ kind: dockerKind, program: dockerProgram, processLocation: () => location, container: (i) => i.containerId });
      const inst = { projectId: "p13", instance: "main", identifier: "p13/main", containerId: name };
      const create = async () => {
        const p = temp(t);
        write(path.join(p, "notes.md"), "stays\n");
        const r = await createProjectRepo(p, { instance: inst });
        assert.equal(r.created, true, JSON.stringify(r));
        return { p, commit: r.commit };
      };

      const a = await create();
      const from = fd.calls().length;
      assert.deepEqual(await removeProjectRepo(a.p, { commit: a.commit, instance: inst }), { removed: true });
      assert.equal(fs.existsSync(path.join(a.p, ".git")), false);
      assert.equal(fs.readFileSync(path.join(a.p, "notes.md"), "utf8"), "stays\n", "the files stay");
      assert.equal(rmInContainer(fd, from, path.join(a.p, ".git")).length, 1, "the .git was not removed via the container — B deleted itself");

      const b = await create();
      const r = await withEnvironment({ PATH: `${brokenRm(t)}:${process.env.PATH}` }, () => removeProjectRepo(b.p, { commit: b.commit, instance: inst }));
      assert.equal(r.removed, false, JSON.stringify(r));
      assert.equal(r.reason, "error");
      assert.match(r.error, /rm in container p13\/main: exit 1/);
      assert.equal(isProjectRepo(b.p), true, "B deleted the .git itself when the container failed");
    });
  } finally {
    setInProjectSeam(null);
    fd.cleanUp();
  }
});
