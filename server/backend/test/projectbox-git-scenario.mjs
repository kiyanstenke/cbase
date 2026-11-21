// Scenario for the administration git: EVERY exported function of electron/server/git.js once, on a repo with a remote, in a
// fixed order — plus a `git` on the PATH that logs every call before it starts the real git. Not a test (hence .mjs): harness
// AND program in one file (like fake-docker.mjs).
//
// WHAT FOR. Without an instance every git call must be byte-equal to the recorded one. "Today" cannot be kept as a second
// version in the tree (a comparison of two versions dies with the second one) — so the anchor is the recording:
// `fixtures/projectbox-git/argv-without-instance.json`, and projectbox-git.test.js holds the current state against it. With an
// instance the SAME scenario runs in the wrong project container and must show the same commands (except the read bundle of
// the git view, which differs on purpose).
//
// WHAT IS LOGGED (per call, top level only — a git started by git, and hooks, do not count): where it ran (`B` or, in the wrong
// container, its `IN_CONTAINER`), the physical working directory, GIT_TERMINAL_PROMPT, whether access was present (`access` =
// CBASE_GIT_USERNAME, `askpass` = GIT_ASKPASS, `helper` = GIT_CONFIG_COUNT — only the NAMES), and the argv. A marker
// `STEP <name>` precedes every step. Normalized: the throwaway folder as `<T>`, commit hashes as `<H>` (date and container
// environment change them, not the command).
//
// The anchor grew only by appending steps (access-push, access-pull, access-commit-push, show-files, show-file, show-info,
// diff-content*, show-content, apply-working-tree, stage-block); the old part stayed byte-equal. Deliberate re-recordings
// changed exactly:
//  - `%cr` → `%ct` in the format arguments of `git log` (twice) and `git stash list` (relative time is rendered by the product);
//  - `stash show -p stash@{0}` carries the five switches of `WITHOUT_PROGRAM` after the stash;
//  - the status of the git view reads with `-z` (umlauts, spaces and " -> " in paths), and every diff with `WITHOUT_PROGRAM`
//    carries `-U3` (`diff.context=0` would give hunks that `git apply` rejects): six inserted lines, none removed;
//  - step `stage-block`: all calls start with `-c core.hooksPath=/dev/null -c core.fsmonitor=false` (no program from the repo
//    configuration), plus `check-attr` (400 FILTER before writing) and a second `ls-files` right before `update-index` (the
//    index must not have moved); the body carries `baseSha`;
//  - EVERY reading call (status, diff, diff-tree, show, log, blame, ls-files, check-attr, check-ignore, stash show) carries
//    `-c core.hooksPath=/dev/null -c core.fsmonitor=false` in front and `--no-ext-diff`/`--no-textconv` after the subcommand
//    unless it already did (runtime/git-run.js readingArgs): exactly 30 calls changed, each is `readingArgs(<old argv>)`,
//    place, prompt and access unchanged, 227 entries before and after. Guard of that promise: git-read-paths.test.js.
//
// RE-RECORD (deliberately, with the current tree's git.js only):
//   node server/backend/test/projectbox-git-scenario.mjs <path-to-git.js> > server/backend/test/fixtures/projectbox-git/argv-without-instance.json
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The real git, absolute — the wrapper below calls it without a PATH search (it would find itself otherwise).
export const REAL_GIT = execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
export const SECRET = "SECRET-S1-29-7f3a";
// The host of the access (gitAuthCtx sets it from the origin remote; here the remote is a local folder, nobody ever asks).
export const ACCESS_HOST = "example.invalid";
const FESTE_TIME = "2026-01-01T12:00:00+0000";

/**
 * Creates the throwaway folder: home, git configuration for B (`b.gitconfig`) and for the wrong container (`c.gitconfig`,
 * with an INHERITED access helper that a network command must reset), the logging wrapper `bin/git` and the log.
 * → { location, bin, log, env (for B), containerEnv (for `docker run -e`) }
 */
export function gitLocation(prefix = "cbase-git-") {
  const location = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const home = path.join(location, "home");
  fs.mkdirSync(path.join(home, ".config"), { recursive: true });
  const ident = "[user]\n\tname = cbase Test\n\temail = test@cbase.invalid\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n[advice]\n\tdetachedHead = false\n[pull]\n\trebase = false\n";
  fs.writeFileSync(path.join(location, "b.gitconfig"), ident);
  fs.writeFileSync(path.join(location, "c.gitconfig"), `${ident}[credential]\n\thelper = "!f() { echo username=geerbt; echo password=inherited-secret; }; f"\n`);
  const bin = path.join(location, "bin");
  fs.mkdirSync(bin);
  const log = path.join(location, "git.log");
  fs.writeFileSync(log, "");
  // ONE write per call (printf of a finished string with O_APPEND): parallel calls do not interleave.
  fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh
if [ -z "$CBASE_GITWRAP_IN" ]; then
  CBASE_GITWRAP_IN=1; export CBASE_GITWRAP_IN
  r="CALL	\${IN_CONTAINER:-B}	$(pwd -P)	\${GIT_TERMINAL_PROMPT-}	\${CBASE_GIT_USERNAME:+access}\${CBASE_GIT_USERNAME_0:+access}\${GIT_ASKPASS:+askpass}\${GIT_CONFIG_COUNT:+helper}"
  for a in "$@"; do r="$r
ARG	$a"; done
  printf '%s\\n' "$r" >> '${log}'
fi
exec '${REAL_GIT}' "$@"
`, { mode: 0o755 });
  const env = {
    HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), GIT_CONFIG_GLOBAL: path.join(location, "b.gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_DATE: FESTE_TIME, GIT_COMMITTER_DATE: FESTE_TIME, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
  };
  const containerEnv = { IN_CONTAINER: "container", GIT_CONFIG_GLOBAL: path.join(location, "c.gitconfig"), GIT_CONFIG_NOSYSTEM: "1" };
  return { location, bin, log, env, containerEnv };
}

/** The real git WITHOUT log (building the repos). `env` as from gitLocation. */
export function realGit(cwd, args, env) {
  return execFileSync(REAL_GIT, args, { cwd, env: { ...process.env, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** A repo with one file and one commit; with `remote` (bare) including upstream `origin/main`. */
export function createRepo(dir, env, { remote = null, file = "a.txt", content = "a\n" } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  realGit(dir, ["init", "-q", "-b", "main"], env);
  fs.writeFileSync(path.join(dir, file), content);
  realGit(dir, ["add", "-A"], env);
  realGit(dir, ["commit", "-q", "-m", "erster Stand"], env);
  if (remote) {
    realGit(path.dirname(remote), ["init", "-q", "--bare", "-b", "main", remote], env);
    realGit(dir, ["remote", "add", "origin", remote], env);
    realGit(dir, ["push", "-q", "-u", "origin", "main"], env);
  }
}

/** The log as a list: `{ step }` or `{ where, cwd, prompt, access, argv }`. */
export function readLog(log) {
  const out = [];
  let cur = null;
  for (const z of fs.readFileSync(log, "utf8").split("\n")) {
    if (z.startsWith("STEP\t")) { cur = null; out.push({ step: z.slice(5) }); continue; }
    if (z.startsWith("CALL\t")) {
      const [, where, cwd, prompt, access] = z.split("\t");
      cur = { where, cwd, prompt, access, argv: [] };
      out.push(cur);
      continue;
    }
    if (z.startsWith("ARG\t") && cur) cur.argv.push(z.slice(4));
  }
  return out;
}

/** Throwaway folder as `<T>`, commit hashes as `<H>`. */
export function normalize(entries, location) {
  const n = (s) => String(s).split(location).join("<T>").replace(/\b[0-9a-f]{7,40}\b/g, "<H>");
  return entries.map((e) => (e.step ? e : { ...e, cwd: n(e.cwd), argv: e.argv.map(n) }));
}

/**
 * The scenario: `g` is the git.js module, `opts` the instance info (`{}` = without), `env` from gitLocation (stands in
 * process.env during the run — the caller sets it). Creates a repo with a remote under `<location>/proj/app`. A step that
 * throws writes `ERROR` to the log (the calls before it remain the proof).
 */
export async function scenario(g, { location, log, env }, opts = {}) {
  const P = path.join(location, "proj");
  const A = path.join(P, "app");
  createRepo(A, env, { remote: path.join(location, "remote.git") });
  const write = (n, t) => fs.writeFileSync(path.join(A, n), t);
  const including = (o = {}) => ({ ...o, ...opts });
  const results = {};
  const step = async (name, fn) => {
    fs.appendFileSync(log, `STEP\t${name}\n`);
    try { results[name] = await fn(); } catch (e) { fs.appendFileSync(log, `STEP\tERROR ${name}\n`); results[name] = { error: String(e?.message || e) }; }
  };
  await step("tree", () => g.readGitTree(P, including()));
  await step("repos", () => g.projectRepos(P, including()));
  await step("branches", () => g.listBranches(P, "app", including()));
  await step("stage", () => { write("a.txt", "a\ntwo\n"); return g.gitStage(P, "app", ["a.txt"], including()); });
  await step("diff-staged", () => g.gitDiff(P, "app", "a.txt", including({ staged: true })));
  await step("unstage", () => g.gitUnstage(P, "app", ["a.txt"], including()));
  await step("diff", () => g.gitDiff(P, "app", "a.txt", including()));
  await step("diff-new", () => { write("fresh.txt", "n\n"); return g.gitDiff(P, "app", "fresh.txt", including()); });
  await step("stage-all", () => g.gitStage(P, "app", "all", including()));
  await step("commit", () => g.gitCommit(P, "app", "zweiter Stand", including()));
  await step("log", () => g.gitLog(P, "app", including({ limit: 5 })));
  await step("show", () => g.gitShow(P, "app", results.log.commits[0].hash, including()));
  await step("blame", () => g.gitBlame(P, "app", "a.txt", including()));
  await step("push", () => g.gitPush(P, "app", null, including()));
  await step("fetch", () => g.gitFetch(P, "app", null, including()));
  await step("pull", () => g.gitPull(P, "app", null, including()));
  await step("host", () => g.gitRemoteHost(P, "app", including()));
  await step("stash", async () => {
    write("a.txt", "a\nthree\n");
    await g.gitStashPush(P, "app", including({ message: "between" }));
    const l = await g.gitStashList(P, "app", including());
    await g.gitStashShow(P, "app", "stash@{0}", including());
    await g.gitStashOp(P, "app", "pop", "stash@{0}", including());
    return l.stashes.map((s) => s.message);
  });
  await step("dismiss", () => g.gitDiscard(P, "app", "a.txt", including()));
  await step("branch", async () => {
    await g.gitCheckout(P, "app", "beside", including({ create: true }));
    write("b.txt", "b\n");
    await g.gitCommit(P, "app", "auf neben", including({ all: true }));
    return g.gitCheckout(P, "app", "main", including());
  });
  await step("merge", () => g.gitMerge(P, "app", "beside", including()));
  await step("cherry", async () => {
    await g.gitCheckout(P, "app", "third", including({ create: true }));
    write("c.txt", "c\n");
    await g.gitCommit(P, "app", "auf dritter", including({ all: true }));
    const h = (await g.gitLog(P, "app", including({ limit: 1 }))).commits[0].hash;
    await g.gitCheckout(P, "app", "main", including());
    return g.gitCherryPick(P, "app", h, including());
  });
  await step("rebase", () => g.gitRebase(P, "app", "main", including()));
  await step("abort", () => g.gitMergeAbort(P, "app", including()));
  await step("apply", async () => {
    write("a.txt", "a\nfour\n");
    const d = await g.gitDiff(P, "app", "a.txt", including());
    await g.gitApply(P, "app", d.diff, including());
    return g.gitApply(P, "app", d.diff, including({ reverse: true }));
  });
  await step("worktree", async () => {
    await g.gitWorktreeList(P, "app", including());
    await g.gitWorktreeAdd(P, "app", path.join(location, "wt"), undefined, including({ newBranch: "wt-branch" }));
    return g.gitWorktreeRemove(P, "app", path.join(location, "wt"), including());
  });
  await step("submodule", async () => { await g.gitSubmoduleStatus(P, "app", including()); return g.gitSubmoduleUpdate(P, "app", including()); });
  await step("commit-push", () => g.gitCommit(P, "app", "mit push", including({ all: true, push: true })));
  await step("push-new", async () => { await g.gitCheckout(P, "app", "without-upstream", including({ create: true })); return g.gitPush(P, "app", null, including()); });
  // The access carries the host of its remote (workspaces/git-auth.js gitAuthCtx) — in the container only that host gets a helper,
  // without a host none. Without an instance (askpass) nobody reads `host`: the anchor stays the same.
  await step("access", () => g.gitFetch(P, "app", { askpass: path.join(location, "askpass"), username: "user", secret: SECRET, host: ACCESS_HOST }, including()));
  await step("dismiss-all", () => { write("a.txt", "x\n"); write("free.txt", "f\n"); return g.gitDiscard(P, "app", null, including({ all: true })); });
  await step("amend", async () => { write("d.txt", "d\n"); await g.gitStage(P, "app", ["d.txt"], including()); return g.gitCommit(P, "app", "", including({ amend: true })); });
  await step("untracked", () => { write("u.txt", "u\n"); return g.gitDiscard(P, "app", "u.txt", including({ untracked: true })); });
  // push, pull and commit+push WITH access — the same switch as fetch (`access()` in repoAt). Appended at the END so the old part
  // of the anchor stays byte-equal. Its own branch: "without-upstream" was rewritten by "amend" (a `push` there would be rejected).
  // Covers both ways of pushRepo: without upstream (`push -u origin <branch>`) and with (`push`).
  const access = () => ({ askpass: path.join(location, "askpass"), username: "user", secret: SECRET, host: ACCESS_HOST });
  await step("access-push", async () => { await g.gitCheckout(P, "app", "access-branch", including({ create: true })); return g.gitPush(P, "app", access(), including()); });
  await step("access-pull", () => g.gitPull(P, "app", access(), including()));
  await step("access-commit-push", () => { write("z.txt", "z\n"); return g.gitCommit(P, "app", "mit Zugang", including({ all: true, push: true, auth: access() })); });
  // The expanded commit in the graph of the git bar: the options `files` and `file` of gitShow — same switch (repoAt), so in the
  // container with an instance. Appended at the END; an old git.js does not know the options and shows the whole commit (`show --stat -p`).
  await step("show-files", async () => { const h = (await g.gitLog(P, "app", including({ limit: 1 }))).commits[0].hash; return g.gitShow(P, "app", h, including({ files: true })); });
  await step("show-file", async () => { const h = (await g.gitLog(P, "app", including({ limit: 1 }))).commits[0].hash; return g.gitShow(P, "app", h, including({ file: "z.txt" })); });
  // The hovered commit: option `info` — head, message and numbers, again via repoAt. Appended at the END.
  await step("show-info", async () => { const h = (await g.gitLog(P, "app", including({ limit: 1 }))).commits[0].hash; return g.gitShow(P, "app", h, including({ info: true })); });
  // The diff tab of the code tabs in the chat: option `content` of gitDiff (unstaged, staged, untracked) and gitShow, plus
  // `workingTree` of gitApply ("discard block") — via repoAt, so in the container with an instance. Appended at the END.
  await step("diff-content", () => { write("a.txt", "a\nfive\n"); return g.gitDiff(P, "app", "a.txt", including({ content: true })); });
  await step("diff-content-staged", async () => { await g.gitStage(P, "app", ["a.txt"], including()); return g.gitDiff(P, "app", "a.txt", including({ staged: true, content: true })); });
  await step("diff-content-new", () => { write("i.txt", "i\n"); return g.gitDiff(P, "app", "i.txt", including({ content: true })); });
  await step("show-content", async () => { const h = (await g.gitLog(P, "app", including({ limit: 1 }))).commits[0].hash; return g.gitShow(P, "app", h, including({ file: "z.txt", content: true })); });
  await step("apply-working-tree", async () => {
    write("a.txt", "a\nsix\n");
    const d = await g.gitDiff(P, "app", "a.txt", including({ content: true }));
    return g.gitApply(P, "app", d.diff, including({ reverse: true, workingTree: true }));
  });
  // The quick-diff peek in the editor margin: gitStageBlock — `ls-files`, `check-attr`, `cat-file`, `hash-object --no-filters`,
  // the second `ls-files` and `update-index --cacheinfo` via repoAt, so in the container with an instance. The index holds
  // "a\nfive\n" here (diff-content-staged; apply-working-tree took the working tree back). Appended at the END; an old git.js does not
  // know the function and writes `ERROR stage-block`.
  await step("stage-block", () => {
    write("a.txt", "a\nseven\n");
    return g.gitStageBlock(P, "app", "a.txt", { from: 1, until: 2, old: ["five"], rows: ["seven"], rowCount: 3, lineEnding: "\n",
      baseSha: "9c03b32590c1c2eebbde78b5a24ce1652441d3c6144f4bb3af839c703193332d" /* sha256 of "a\nfive\n" */ }, including());
  });
  return { P, A, results };
}

/** The scenario including environment in its own throwaway folder → the normalized log. */
export async function recordScenario(g, opts = {}) {
  const o = gitLocation();
  const saved = Object.fromEntries(Object.keys(o.env).map((k) => [k, process.env[k]]));
  try {
    Object.assign(process.env, o.env);
    await scenario(g, o, opts);
    return normalize(readLog(o.log), o.location);
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(o.location, { recursive: true, force: true });
  }
}

// As a program: `node projectbox-git-scenario.mjs <git.js>` prints the log (see header, RE-RECORD).
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const target = process.argv[2];
  if (!target) { console.error("Usage: node projectbox-git-scenario.mjs <path-to-git.js>"); process.exit(2); }
  const g = await import(pathToFileURL(path.resolve(target)).href);
  process.stdout.write(`${JSON.stringify(await recordScenario(g), null, 1)}\n`);
}

