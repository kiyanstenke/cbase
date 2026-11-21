// Guard of the administration git in the project container. The fake docker (fake-docker.mjs) imitates
// `docker exec -i -u agent -w <folder> <container> cbase-wrapper … -- git …` against REAL git in throwaway repos; a `git` on the
// PATH (projectbox-git-scenario.mjs) logs every call with its place — in the fake container the environment carries
// `IN_CONTAINER=container`, in B it is missing.
//
// The promises, each with the way that breaks it:
//   (A) WITHOUT AN INSTANCE as today (G2): the scenario (every exported function of git.js) shows argv, folder, GIT_TERMINAL_PROMPT
//       and access features like the ANCHOR from before the project container (fixtures/projectbox-git/argv-without-instance.json,
//       the format arguments of `git log`/`git stash list` with %ct instead of %cr, re-recorded with the git.js of the tree — see
//       projectbox-git-scenario.mjs) — also with the operation mark, and then without a single docker call (G1).
//   (B) WITH AN INSTANCE the same commands in the project container, as agent, none in B; the access of a network command as
//       environment (`-e NAME`), never in argv. Named additionally: after every pull the LFS question (`lfs ls-files -n`, without
//       git-lfs `ls-files :(attr:filter=lfs)`), before the submodule update the three `config` readings of the hosts. The expression
//       of the remote reading takes the LFS endpoints along; the helper of the access (runtime/git-run.js gitHelper) knows `erase`
//       and sets a mark CBASE_GIT_REJECTED_<i> — it stands only in the environment (`-e GIT_CONFIG_VALUE_<i>`), this guard holds
//       only the names; its behaviour is held by git-run-deadline.test.js (10).
//   (C) Hooks (pre-commit, post-checkout) and `core.fsmonitor` of a code repo run with an instance ONLY in the container.
//   (D) The git view bundles: three repos of an instance ⇒ ONE read call in the container, the same answer as in B; an instance
//       that is not ready ⇒ "Project is starting" without docker; a stopped container ⇒ a visible error instead of empty.
//   (E) The access: the inherited helper of the container is reset (built-in counter-test: without the reset it answers), the
//       secret stands in no argv.
//   (F) okf.js and the project repo (projectbox/projectRepo.js) with an instance in the container; the readability check counts
//       what the agent can read THERE (a file that is unreadable only in the container is excluded, in B not).
//   (G) The starter (runtime/git-run.js): cap of the deadline and of the output with a message; without an instance only the named
//       fallback. Plus the fake docker itself: a lock whose holder the cap killed is released (fake-docker.mjs).
//   (H) The routes: project level and workspace level (one repo under a converted project in the container, the other in B),
//       commit through the route with a hook in the container, "Project is starting", stopped with and without waker; the list for the
//       wrapper cbase-git and the wrapper itself; without the operation mark neither source nor list.
//   (I) VS Code: `git.path` in the machine settings — new, added, unchanged, broken JSON stays, without a wrapper nothing.
//   (J) discarding an untracked file with an instance is done by the container (`rm -rf --`), B deletes nothing — not even through a
//       smuggled-in symlink; not ready ⇒ throw with `err.situation` without docker, stopped ⇒ `err.containerStands` instead of "no
//       repo". Also in (H): actions 409 and waker, the OKF verification 409, the freshness `null`; instances not readable ⇒ `error`
//       or 409, /git/creds untouched. In (A)/(B): push, pull and commit+push WITH access.
//   (K) an instance source that throws (factory or per path) is `error`, not `{ repos: [] }`.
//   (M) the list for cbase-git follows EVERY change of `converted_at` without restart and without a manual call — create with, set,
//       take back, delete; a row without `converted_at` and a change of other fields write nothing; without the operation mark no
//       list (G1). The observer sits in the data layer (store/project-instances.js), set in server.js.
//   (L) the emptying of the helper list goes as `-e GIT_CONFIG_VALUE_0=` in argv (also in (B)/(E)), even if B carries the same empty
//       value; an empty secret stays in the environment.
//   (V) the `hint` of the auto anchor follows the situation — "it is woken" only if the waker ran; stopped WITHOUT a waker and with a
//       waker that THROWS it says "does not run and was not started (<message>)"; a pause (from outside, `docker pause`) says
//       "frozen" and never wakes.
//   (W1) a ref, branch or worktree path from the body that begins with "-" (or carries a line break) is refused before git runs —
//       `stash show --output=`, `rebase --exec=`, `checkout --orphan=`.
//   (W2) an unreadable status (broken index, output cap) ⇒ `clean: false`, `counts: null`, `statusError` — never "clean".
//   (N) with a converted project B reads `.git/config` only without a link — a FIFO there does not stop B (the sidebar, projectRepos
//       → findRepos, in a child process: it ends, and the repo counts as a code repo because B read nothing from the FIFO), a link
//       there is not read, a regular file is; without an instance today's call (G2: the same link counts). Verdict without a clock:
//       the test opens the FIFO for writing itself beforehand and writes the mark of the project repo as soon as a reader is
//       there — a blocking reader (the bug) reads it and ends RED instead of hanging.
//   (O)-(U) git assignment, list and routes: (O) a converted project with an unreadable instance does not make /context/categories 409
//       (/git/stage stays 409); (P) a stopped container in the middle of /git/diff ⇒ 409 with waker, never an empty diff; (Q) the read
//       bundle runs with `-w /`, never in the first repo; (R) commondir (and the .git file) without a link, O_NONBLOCK, capped: a FIFO
//       there does not stop B; (S) a link in place of a root in the runtime folder does not make its target a root of the project;
//       (T) the list: the WHOLE runtime folder is root of the main, `copy-worktrees` locked, with the operation mark ALWAYS the lock
//       rows for `<data>/copies` and `<data>/copies-backup`; unreadable instances mark the existing list `!incomplete`, the start
//       sets the mark before the first read; (U) a failed write of the list plans ONE repetition — at most one open, doubled delay
//       per further failure, a successful write (by anyone) cancels it; 0 switches off. No clock in the test: the seam
//       `setGitListClock` catches the plan, the test runs it itself.
//
// COUNTER-TESTS (each shown red, taken back): git.js `git()` without an instance ⇒ (B) (C) (D) (H) red; repoAt without an instance ⇒
// (B) (C) (H); readGitTree per repo instead of the bundle ⇒ (B) (D) (H); access as `-c` argument ⇒ (B) (E); access without the
// reset ⇒ (B) (E); okf.js/projectRepo.js without an instance ⇒ (F); gitInB without GIT_TERMINAL_PROMPT ⇒ (A); code-route.js without
// the situation ⇒ (H); workspace route without a source ⇒ (H); vscode-tunnel.js overwrites broken JSON ⇒ (I); fake-docker.mjs
// without cleanOrphanedLock ⇒ the call after the dead lock hangs; only gitPush without an instance with the helper instead of
// askpass ⇒ (A) red; git-run.js and inProject.js without `envEmpty` ⇒ (B) (E) (L) red, (L) with "fatal: missing config value
// GIT_CONFIG_VALUE_0"; store/project-instances.js and server.js without the observer ⇒ (M) red ("the list does not follow the
// setting") and (H) red; all four files (git.js, code-route.js, okf.js, the verify branch in projects/routes.js) from before the
// repair ⇒ (B) (H) (J) (K) red; without the situation in resolveRepoRoot ⇒ (H) (J); without passing on containerStands ⇒ (H) (J);
// okf.js without containerStands ⇒ (H) (verify 400); staleInfo without `null` ⇒ (H) ("rebased"); rmSync instead of rm in the
// container ⇒ (B) (J) (B deleted through the symlink); the catch of GET /git without `error` ⇒ (K); the factory outside the try ⇒
// (H) (500) (K); projectRepos swallowing the throw ⇒ (K); projects/routes.js with `if (false)` instead of `if (a.containerStands)`
// at the auto anchor ⇒ (H) red; projects/routes.js with a fixed sentence instead of `anchorHint(stands)` ⇒ (V) red at "without waker:
// … it is woken"; git.js from before the refusal of option-like values ⇒ (W1) red (the file stands, the mark stands, the branch
// switches); git.js without `statusError` ⇒ (W2) red (`clean: true`); git.js before the isProjectRepo descriptor reading ⇒ (N) red at
// both tests (the FIFO repo is missing in the list, the link counts also with an instance); `if (!liesUnderCodeRoute(sub)) return NEXT;`
// removed in devtools/routes.js ⇒ (O) red; the line `if (e?.containerStands || e?.containerPaused || e?.situation) throw e;` removed
// in git.js raw() ⇒ (P) red (empty diff); a working folder of `roots[0]` instead of `"/"` ⇒ (Q) red; the first line read through
// readFileSync again ⇒ (R) red; `rootUnder` = realpath ⇒ (S) red (case 3); main root `location.worktrees` again ⇒ (T) red, the lock
// rows of `<data>` removed ⇒ (T) red, `gitProjectsIncomplete()` removed from the start of server.js ⇒ (T) red; `repetitionSchedule()` removed
// in the read-error branch ⇒ (U) red ("no plan"); `writtenWithoutError()` removed in the write branch ⇒ (U) red (the open one stays).
//
// No clock: waiting is for process ends and logs. The deadline in (G) is the cap of the PRODUCT (300 ms instead of 120 s), no
// criterion of the test; against a broken cap the emergency brake (ripcord.mjs) stands before the hang.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import * as store from "../electron/server/store.js";
import * as gitModule from "../electron/server/git.js";
import { BUNDLE_SCRIPT, gitCheckout, gitCommit, gitDiscard, gitStage, readGitTree } from "../electron/server/git.js";
import { commandRun, gitHelper, gitRun, accessAsEnvironment } from "../electron/server/runtime/git-run.js";
import { WRAPPER_PATH, openEscalations, setInProjectSeam } from "../electron/server/runtime/inProject.js";
import { dockerKind, dockerProgram } from "../electron/server/projectbox/docker.js";
import { staleInfo, verifyAnchors } from "../electron/server/okf.js";
import { SEARCH_PROGRAM, createProjectRepo } from "../electron/server/projectbox/projectRepo.js";
import { gitInstanceForWorkspace, writeGitProjects } from "../electron/server/projectbox/git-assignment.js";
import * as assignment from "../electron/server/projectbox/git-assignment.js";
import { DIRS } from "../electron/server/app-state.js";
import { locationFor } from "../electron/server/runs/runtime-location.js";
import { codeRoute, setGitWakeup } from "../electron/server/devtools/code-route.js";
import { enterGitPath } from "../electron/server/vscode-tunnel.js";
import { readingsFinished } from "../electron/server/gitView/cache.js";
import { json, withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import { fakeDocker } from "./fake-docker.mjs";
import { SECRET, realGit, gitLocation, readLog, normalize, createRepo, scenario, recordScenario } from "./projectbox-git-scenario.mjs";
import { RIPCORD_MS } from "./ripcord.mjs";

const TESTDIR = path.dirname(new URL(import.meta.url).pathname);
const REPO = path.resolve(TESTDIR, "..", "..", "..");
const WRAPPER_GIT = path.join(REPO, "server", "backend", "cbase-git");
const ANCHOR = JSON.parse(fs.readFileSync(path.join(TESTDIR, "fixtures", "projectbox-git", "argv-without-instance.json"), "utf8"));

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────────
async function withEnvironment(values, fn) {
  const saved = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(values)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
// Operation mark and fake docker. GIT_TERMINAL_PROMPT drops out of B: the environment allowlist carries only names whose value
// differs from that in B (runtime/inProject.js envAllowlist) — if it were already 0 in B, it would never arrive in the container.
const ops = (fd) => ({ CBASE_CONTAINER: "1", CBASE_DIND: "1", CBASE_DOCKER_BIN: fd.bin, CBASE_IN_PROJECT_ESCALATION_MS: "200", GIT_TERMINAL_PROMPT: undefined });
function containerStart(fd, name, env = {}) {
  execFileSync(fd.bin, ["run", "-d", "--name", name, ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]), "cbase-projectbox:test"],
    { env: { ...process.env, ...fd.env } });
}
const unitSeam = (location) => ({ kind: dockerKind, program: dockerProgram, processLocation: () => location, container: (i) => i.containerId });
const INST = (name) => ({ projectId: "p1", instance: "main", identifier: "p1/main", containerId: name });
const execCalls = (fd) => fd.calls({ daemon: "host" }).filter((a) => a.args[0] === "exec");
const command = (a) => a.args.slice(a.args.indexOf("--") + 1);
const argValue = (a, flag) => a.args[a.args.indexOf(flag) + 1];
const withoutRelative = (x) => JSON.parse(JSON.stringify(x, (k, v) => (k === "relative" ? undefined : v)));
const callsIn = (log) => log.filter((e) => !e.step);
// Status and body of a route (also for 4xx — `json` from the harness throws there).
async function response(url, init) {
  const r = await fetch(url, { ...init, headers: { "Content-Type": "application/json", Connection: "close", ...(init?.headers || {}) } });
  return { status: r.status, body: await r.json() };
}
// The entries of a step (up to the next marker).
function stepOf(log, name) {
  const i = log.findIndex((e) => e.step === name);
  assert.ok(i >= 0, `step ${name} is missing`);
  const result = [];
  for (const e of log.slice(i + 1)) { if (e.step) break; result.push(e); }
  return result;
}
// The unit: fake docker, a running project container with the environment of the container place, the seam, B environment.
async function unit(fn, { containerEnv = () => ({}) } = {}) {
  const fd = await fakeDocker();
  const o = gitLocation();
  const name = `cbase-p-${path.basename(o.location).replace(/[^a-z0-9]/gi, "").toLowerCase()}`;
  try {
    return await withEnvironment({ ...o.env, ...ops(fd) }, async () => {
      containerStart(fd, name, { ...o.containerEnv, ...containerEnv(o) });
      setInProjectSeam(unitSeam(path.join(o.location, "processes")));
      const r = await fn({ fd, o, name, inst: INST(name) });
      await waitForTruthy(() => openEscalations() === 0, "escalations done");
      return r;
    });
  } finally {
    setInProjectSeam(null);
    fd.cleanUp();
    fs.rmSync(o.location, { recursive: true, force: true });
  }
}
// A hook that writes place and name into a marker (on both ways).
const hookScript = (marker, name, rest = "") => `#!/bin/sh\nprintf '%s %s\\n' "\${IN_CONTAINER:-B}" '${name}' >> '${marker}'\n${rest}`;
const readMarker = (marker) => fs.readFileSync(marker, "utf8").split("\n").filter(Boolean);

// ── (A) Without an instance: the anchor ─────────────────────────────────────────────────────────────────
test("(A) without an instance: every git call as recorded in the anchor (format arguments of log/stash with %ct) — also with the operation mark, then without docker", async () => {
  assert.ok(callsIn(ANCHOR).length > 100, "the anchor carries the whole scenario");
  assert.ok(callsIn(ANCHOR).every((a) => a.where === "B" && a.prompt === "0"));
  // EVERY network command with access carries askpass in B (not the helper of the container) — fetch, push (with and without
  // upstream), pull, commit+push.
  for (const [s, network] of [["access", "fetch"], ["access-push", "push"], ["access-pull", "pull"], ["access-commit-push", "push"]]) {
    const a = stepOf(ANCHOR, s).filter((x) => x.argv[0] === network);
    assert.equal(a.length, 1, `${s}: ${network} is missing in the anchor`);
    assert.equal(a[0].access, "accessaskpass", `${s}: ${network} in B without askpass`);
  }
  const without = await recordScenario(gitModule);
  assert.deepEqual(without, ANCHOR);
  const fd = await fakeDocker();
  try {
    const including = await withEnvironment(ops(fd), () => recordScenario(gitModule));
    assert.deepEqual(including, ANCHOR);
    assert.deepEqual(fd.calls(), [], "without an instance no docker call (G1/G2)");
  } finally {
    fd.cleanUp();
  }
  console.log(`# anchor: ${callsIn(ANCHOR).length} git calls in ${ANCHOR.filter((e) => e.step && !e.step.startsWith("ERROR")).length} steps`);
});

// ── (B) With an instance: the same commands in the container ─────────────────────────────────────────────
test("(B) with an instance: the same git commands in the project container as agent, none in B; the access as environment, never in argv", async () => {
  await unit(async ({ fd, o, name, inst }) => {
    await scenario(gitModule, o, { instance: inst });
    const log = normalize(readLog(o.log), o.location);
    const calls = callsIn(log);
    const inB = calls.filter((a) => a.where !== "container");
    assert.deepEqual(inB, [], `git in B despite an instance: ${JSON.stringify(inB).slice(0, 600)}`);
    assert.ok(calls.every((a) => a.prompt === "0"), "GIT_TERMINAL_PROMPT=0 also in the container");
    // The same commands in the same folders as without an instance — except the git view (the read bundle, see D).
    const comparable = (l) => {
      const result = [];
      let tree = false;
      for (const e of l) {
        if (e.step) { tree = e.step === "tree"; result.push(e.step); continue; }
        if (!tree) result.push(`${e.cwd} | ${e.argv.join(" ")}`);
      }
      return result;
    };
    // WITH an instance a pull afterwards fetches the LFS files (runtime/git-run.js: `lfs ls-files -n`, without git-lfs the question for
    // `filter=lfs`), and a submodule update reads the hosts of its submodules before (three `config` readings, for the accesses per
    // host) — otherwise the same commands as without an instance. The first reading also takes `lfs.pushurl` and
    // `remote.<n>.lfsurl`/`lfspushurl` along — only the expression became wider, no call was added. Pull and fetch in this scenario
    // carry no access list and therefore read no hosts (the code tab passes it, devtools/code-route.js — guard git-run-deadline.test.js (9)).
    const AN23_AFTER_PULL = ["lfs ls-files -n", "ls-files -z -- :(attr:filter=lfs)"];
    const AN23_BEFORE_SUBMODULE = [
      "config -z --get-regexp ^(remote\\..*\\.(url|pushurl|lfsurl|lfspushurl)|lfs\\.(url|pushurl))$",
      "config -z --local --get-regexp ^submodule\\..*\\.url$",
      "config -z --file .gitmodules --get-regexp ^submodule\\..*\\.url$",
    ];
    const withAn23 = (l) => {
      const result = [];
      for (const z of l) {
        const [cwd, cmd] = z.split(" | ");
        if (cmd === "submodule update --init --recursive") result.push(...AN23_BEFORE_SUBMODULE.map((c) => `${cwd} | ${c}`));
        result.push(z);
        if (cmd === "pull") result.push(...AN23_AFTER_PULL.map((c) => `${cwd} | ${c}`));
      }
      return result;
    };
    assert.deepEqual(comparable(log), withAn23(comparable(ANCHOR)));
    // The git view: ONE read bundle for the one repo.
    const tree = stepOf(log, "tree");
    assert.equal(tree.length, 1 + 7, JSON.stringify(tree.map((a) => a.argv.join(" "))));
    // Every exec: -i, as agent, with the wrapper, in the container of the instance, with a working folder.
    const allExecs = execCalls(fd);
    // Discarding the untracked file is ONE `rm` in the container (no rmSync in B).
    const rmExecs = allExecs.filter((e) => command(e)[0] === "rm");
    assert.deepEqual(rmExecs.map(command), [["rm", "-rf", "--", path.join(o.location, "proj", "app", "u.txt")]]);
    const execs = allExecs.filter((e) => command(e)[0] !== "rm");
    assert.equal(execs.length, calls.length - 6, `${execs.length} exec for ${calls.length} git calls (one per call, the bundle one for seven)`);
    for (const e of allExecs) {
      assert.equal(e.args[1], "-i");
      assert.equal(argValue(e, "-u"), "agent");
      assert.ok(e.args.includes(name) && e.args.includes(WRAPPER_PATH), JSON.stringify(e.args).slice(0, 300));
      assert.ok(e.args.includes("-w"), "without a working folder");
    }
    // The access of the network command: in the container as environment (helper, no askpass), the secret in no argv.
    const access = stepOf(log, "access").find((a) => a.argv[0] === "fetch");
    assert.equal(access.access, "accesshelper", "in the container: access through the helper from the environment, without GIT_ASKPASS");
    // push (without and with upstream), pull and commit+push with access likewise — only the network command carries it.
    for (const [s, network] of [["access-push", "push"], ["access-pull", "pull"], ["access-commit-push", "push"]]) {
      for (const a of stepOf(log, s)) assert.equal(a.access, a.argv[0] === network ? "accesshelper" : "", `${s}: ${a.argv.join(" ")}`);
    }
    for (const a of fd.calls()) assert.ok(!JSON.stringify(a.args).includes(SECRET), `secret in argv: ${JSON.stringify(a.args).slice(0, 300)}`);
    const fetchExec = execs.find((e) => command(e).join(" ") === "git fetch --all --prune" && e.args.includes("CBASE_GIT_PASSWORD_0"));
    assert.ok(fetchExec, "fetch with access: -e CBASE_GIT_PASSWORD_0 is missing");
    // The emptying of the helper list goes value-empty in argv (`GIT_CONFIG_VALUE_0=`, case L), not through the environment. The
    // helper applies only to the host of the remote (list form, index 0) — `GIT_CONFIG_VALUE_3` is `credential.https://<host>.helper`.
    for (const n of ["CBASE_GIT_USERNAME_0", "GIT_CONFIG_COUNT", "GIT_CONFIG_VALUE_0=", "GIT_CONFIG_VALUE_1", "GIT_CONFIG_KEY_3", "GIT_CONFIG_VALUE_3"]) {
      assert.ok(fetchExec.args.some((x, i) => x === n && fetchExec.args[i - 1] === "-e"), `-e ${n} is missing`);
    }
    assert.ok(!fetchExec.args.includes("GIT_ASKPASS"), "askpass is the way in B, not in the container");
  });
});

// ── (C) Hooks and fsmonitor ─────────────────────────────────────────────────────────────────────
test("(C) hooks and core.fsmonitor of a code repo run with an instance only in the project container — without an instance as today in B", async () => {
  await unit(async ({ o, inst }) => {
    const P = path.join(o.location, "hproj");
    const A = path.join(P, "code");
    createRepo(A, o.env);
    const marker = path.join(o.location, "hooks.marker");
    for (const h of ["pre-commit", "post-checkout"]) fs.writeFileSync(path.join(A, ".git", "hooks", h), hookScript(marker, h), { mode: 0o755 });
    const fsm = path.join(o.location, "fsmonitor-hook");
    fs.writeFileSync(fsm, hookScript(marker, "fsmonitor", "exit 1\n"), { mode: 0o755 });
    realGit(A, ["config", "core.fsmonitor", fsm], o.env);
    let n = 0;
    const run = async (opts, branch) => {
      fs.writeFileSync(marker, "");
      await readGitTree(P, opts);
      fs.writeFileSync(path.join(A, `x${++n}.txt`), String(n));
      await gitStage(P, "code", "all", opts);
      await gitCommit(P, "code", `hook ${n}`, opts);
      await gitCheckout(P, "code", branch, { ...opts, create: true });
      return readMarker(marker);
    };
    const inside = await run({ instance: inst }, "inContainer");
    for (const h of ["pre-commit", "post-checkout", "fsmonitor"]) assert.ok(inside.includes(`container ${h}`), `${h} did not run in the container: ${inside.join(" · ")}`);
    assert.deepEqual(inside.filter((z) => !z.startsWith("container ")), [], `a hook ran in B: ${inside.join(" · ")}`);
    const outside = await run({}, "in-b");
    for (const h of ["pre-commit", "post-checkout", "fsmonitor"]) assert.ok(outside.includes(`B ${h}`), `${h} without an instance not in B: ${outside.join(" · ")}`);
    assert.deepEqual(outside.filter((z) => !z.startsWith("B ")), []);
  });
});

// ── (D) The git view ─────────────────────────────────────────────────────────────────────────
test("(D) git view: three repos of an instance ⇒ ONE read bundle with the answer of B; not ready ⇒ \"Project is starting\" without docker; stopped ⇒ error", async () => {
  await unit(async ({ fd, o, name, inst }) => {
    const P = path.join(o.location, "three");
    createRepo(path.join(P, "one"), o.env, { remote: path.join(o.location, "one.git") });
    createRepo(path.join(P, "two"), o.env);
    fs.writeFileSync(path.join(P, "two", "fresh.txt"), "n\n");
    fs.writeFileSync(path.join(P, "two", "a.txt"), "changed\n");
    createRepo(path.join(P, "three"), o.env);
    realGit(path.join(P, "three"), ["checkout", "-q", "--detach"], o.env);
    const inB = await readGitTree(P);
    assert.equal(inB.repos.length, 3);
    fs.writeFileSync(o.log, "");
    const prior = execCalls(fd).length;
    const inside = await readGitTree(P, { instance: inst });
    assert.deepEqual(withoutRelative(inside), withoutRelative(inB), "the same answer as in B");
    const fresh = execCalls(fd).slice(prior);
    const bundle = fresh.filter((e) => command(e)[0] === "sh");
    assert.equal(bundle.length, 1, `read calls: ${bundle.length} instead of ONE`);
    assert.deepEqual(command(bundle[0]).slice(0, 3), ["sh", "-c", BUNDLE_SCRIPT]);
    assert.equal(fresh.length, 2, `exec: ${fresh.map((e) => command(e).slice(0, 3).join(" ")).join(" · ")} (expected: the question for the repo, the bundle)`);
    const calls = callsIn(readLog(o.log));
    assert.equal(calls.length, 1 + 3 * 7);
    assert.ok(calls.every((a) => a.where === "container"));

    // Workspace form: one repo belongs to the instance, the others stay in B.
    fs.writeFileSync(o.log, "");
    const n1 = execCalls(fd).length;
    const one = fs.realpathSync(path.join(P, "one"));
    const mixed = await readGitTree(P, { instanceFor: (p) => (p === one ? inst : null) });
    assert.deepEqual(withoutRelative(mixed), withoutRelative(inB));
    const n1new = execCalls(fd).slice(n1);
    assert.equal(n1new.length, 1, "only the bundle for one");
    assert.deepEqual(command(n1new[0]).slice(5), [one], "the bundle carries only the repo of the instance");
    const mixedLog = callsIn(readLog(o.log));
    for (const a of mixedLog) assert.equal(a.where, a.cwd.startsWith(one) ? "container" : "B", `${a.cwd}: ${a.argv.join(" ")}`);

    // Not ready: no docker, "Project is starting" instead of empty.
    const n2 = fd.calls().length;
    const situation = await readGitTree(P, { instance: inst, situation: () => ({ starts: true, notice: "Projekt startet" }) });
    assert.deepEqual(situation, { repos: [], projects: [{ projectId: "p1", starts: true, notice: "Projekt startet" }] });
    assert.equal(fd.calls().length, n2, "no docker against a container that is not ready");

    // Stopped: the error is there (not silently `{ repos: [] }`).
    execFileSync(fd.bin, ["stop", name], { env: { ...process.env, ...fd.env } });
    const way = await readGitTree(P, { instance: inst });
    assert.deepEqual(way.repos, []);
    assert.equal(way.projects.length, 1);
    assert.match(way.projects[0].error, /is not running/);
  });
});

// ── (E) The access ──────────────────────────────────────────────────────────────────────────────
test("(E) access: in the container only as environment, the inherited helper is reset, the secret in no argv", async () => {
  await unit(async ({ fd, o, inst }) => {
    const dir = path.join(o.location, "empty");
    fs.mkdirSync(dir);
    const question = "protocol=https\nhost=example.invalid\n\n";
    // A secret with characters that a shell or an echo would interpret.
    const secret = `${SECRET}\\n$HOME'"*`;
    // Only the list form — the helper applies to the host `example.invalid` (see git-run-deadline.test.js for port and foreign host).
    const r = await gitRun(inst, dir, ["credential", "fill"], { stdin: question, env: accessAsEnvironment([{ host: "example.invalid", access: { username: "user", secret } }]) });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.split("\n").includes(`password=${secret}`), r.stdout);
    assert.ok(r.stdout.split("\n").includes("username=user"), r.stdout);
    // Built-in counter-test: without the reset (only the helper from the environment) the INHERITED helper answers first.
    const without = await gitRun(inst, dir, ["credential", "fill"], {
      stdin: question, env: { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "credential.https://example.invalid.helper", GIT_CONFIG_VALUE_0: gitHelper(0), CBASE_GIT_USERNAME_0: "user", CBASE_GIT_PASSWORD_0: secret },
    });
    assert.ok(without.stdout.split("\n").includes("password=inherited-secret"), `the container inherits no helper — the counter-test proves nothing: ${without.stdout}`);
    for (const a of fd.calls()) assert.ok(!JSON.stringify(a.args).includes(SECRET), `secret in argv: ${JSON.stringify(a.args).slice(0, 300)}`);
    const ex = execCalls(fd)[0];
    // `GIT_CONFIG_VALUE_0=`: the emptying value-empty in argv (case L); all values of the access only as a name.
    for (const n of ["CBASE_GIT_USERNAME_0", "CBASE_GIT_PASSWORD_0", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0=", "GIT_CONFIG_KEY_1", "GIT_CONFIG_VALUE_1", "GIT_CONFIG_KEY_3", "GIT_CONFIG_VALUE_3"]) {
      assert.ok(ex.args.some((x, i) => x === n && ex.args[i - 1] === "-e"), `-e ${n} is missing: ${JSON.stringify(ex.args).slice(0, 400)}`);
    }
    // Without access no helper environment (git then asks nobody — as today without access); an entry without a user does not count.
    assert.deepEqual(accessAsEnvironment(null), {});
    assert.deepEqual(accessAsEnvironment([{ host: "example.invalid", access: { secret: "x" } }]), {});
    // The old form (an access without a host) no longer exists: it throws instead of silently setting a helper for every host.
    assert.throws(() => accessAsEnvironment({ username: "user", secret: "x" }), /list form/);
  });
});

// ── (F) okf.js and project repo ─────────────────────────────────────────────────────────────────
test("(F) OKF anchor and project repo with an instance: git in the container; the readability check counts what the agent can read THERE", async () => {
  // In the fake container `only-there.txt` is unreadable (a preloader for node), in B not.
  const preloader = (o) => {
    const f = path.join(o.location, "only-there.cjs");
    fs.writeFileSync(f, `const fs = require("node:fs"); const path = require("node:path"); const orig = fs.accessSync;
fs.accessSync = function (p, m) { if (path.basename(String(p)) === "only-there.txt") { const e = new Error("EACCES: permission denied, access"); e.code = "EACCES"; throw e; } return orig.apply(this, arguments); };
`);
    return { NODE_OPTIONS: `--require ${f}` };
  };
  await unit(async ({ fd, o, inst }) => {
    // OKF
    const P = path.join(o.location, "okf");
    createRepo(path.join(P, "app"), o.env);
    fs.writeFileSync(o.log, "");
    const a = await verifyAnchors(P, ["app/a.txt"], { instance: inst });
    assert.match(String(a.commits.app || ""), /^[0-9a-f]{7,}$/, JSON.stringify(a));
    const s = await staleInfo(P, { codePaths: ["app/a.txt"], lastVerified: { commits: a.commits, at: 1 } }, { instance: inst });
    assert.equal(s.stale, false, JSON.stringify(s));
    const okfLog = callsIn(readLog(o.log));
    assert.deepEqual(okfLog.map((x) => `${x.where} ${x.argv[0]}`), ["container rev-parse", "container log"]);

    // Project repo with an instance: the search as `node -e` in the container, all git there.
    const Q = path.join(o.location, "prepo");
    fs.mkdirSync(Q);
    fs.writeFileSync(path.join(Q, "open.txt"), "o\n");
    fs.writeFileSync(path.join(Q, "only-there.txt"), "x\n");
    fs.writeFileSync(o.log, "");
    const r = await createProjectRepo(Q, { instance: inst });
    assert.equal(r.created, true, JSON.stringify(r));
    assert.deepEqual(r.unreadable, ["only-there.txt"], "the check did not run in the container");
    assert.match(fs.readFileSync(path.join(Q, ".git", "info", "exclude"), "utf8"), /^\/only-there\.txt$/m);
    const prLog = callsIn(readLog(o.log));
    assert.ok(prLog.length >= 6, `${prLog.length} git calls`);
    assert.deepEqual(prLog.filter((x) => x.where !== "container"), [], "git of the project repo in B");
    const search = execCalls(fd).filter((e) => command(e)[0] === process.execPath && command(e)[1] === "-e");
    assert.equal(search.length, 1, "the search did not run as node -e in the container");
    assert.equal(command(search[0])[2], SEARCH_PROGRAM);
    const tree = realGit(Q, ["ls-files"], o.env).trim().split("\n");
    assert.deepEqual(tree, ["open.txt"]);

    // Without an instance: the same file is readable in B — nothing excluded, all git in B.
    const R = path.join(o.location, "prepo-b");
    fs.mkdirSync(R);
    fs.writeFileSync(path.join(R, "open.txt"), "o\n");
    fs.writeFileSync(path.join(R, "only-there.txt"), "x\n");
    fs.writeFileSync(o.log, "");
    const n = execCalls(fd).length;
    const rb = await createProjectRepo(R);
    assert.deepEqual(rb.unreadable, []);
    assert.equal(execCalls(fd).length, n);
    assert.ok(callsIn(readLog(o.log)).every((x) => x.where === "B"));
  }, { containerEnv: preloader });
});

// ── (G) The starter ─────────────────────────────────────────────────────────────────────────────
test("(G) the starter: cap of the deadline and of the output with a message; without an instance only the named fallback; the fake docker survives the cap", async () => {
  await unit(async ({ fd, o, inst }) => {
    // The fake docker itself: a lock whose holder is dead is released — otherwise the next call would spin forever (the cap hit the
    // fake docker in the middle of the lock). Counter-test: fake-docker.mjs without cleanOrphanedLock hangs here (a hang, no
    // red — the suite deadline of the gate reports it).
    const tot = execFileSync("/bin/sh", ["-c", "sh -c 'echo $$' ; true"], { encoding: "utf8" }).trim();
    const lock = path.join(fd.dir, "daemon", "host", "lock");
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, "holders"), tot);
    execFileSync(fd.bin, ["run", "-d", "--name", "probe-lock", "cbase-projectbox:test"], { env: { ...process.env, ...fd.env } });
    assert.equal(fs.existsSync(lock), false, "the orphaned lock still stands");
    assert.ok(fd.state("host").container, "the call after the orphaned lock ran");

    // Deadline: `cat` on a FIFO without a writer waits forever — only the cap can end it. Output: first 200 kB, then it waits on the
    // same FIFO (so the cap hits the docker child while it passes the output on, not after the end). The emergency brake opens the
    // FIFO only after RIPCORD_MS (then cat ends with 0, and the test turns red instead of hanging).
    const gate = path.join(o.location, "gate");
    execFileSync("mkfifo", [gate]);
    const emergencyBrake = setTimeout(() => { try { fs.closeSync(fs.openSync(gate, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK)); } catch { /* no reader any more */ } }, RIPCORD_MS);
    emergencyBrake.unref();
    try {
      const r = await commandRun(inst, o.location, "sh", ["-c", `cat '${gate}'`], { timeout: 300 });
      assert.equal(r.cap, "deadline", JSON.stringify(r));
      assert.equal(r.code, null);
      assert.match(r.stderr, /cap of 0\.3 s reached — ended/);
      const a = await commandRun(inst, o.location, "sh", ["-c", `head -c 200000 /dev/zero; cat '${gate}'`], { maxBuffer: 1000 });
      assert.equal(a.cap, "output", JSON.stringify({ ...a, stdout: a.stdout.length }));
      assert.match(a.stderr, /output cap \(1000 bytes\) reached/);
    } finally {
      clearTimeout(emergencyBrake);
    }
    // Without an instance: commandRun does not exist, gitRun only with the named fallback.
    await assert.rejects(commandRun(null, o.location, "true", []), /without an instance/);
    assert.throws(() => gitRun(null, o.location, ["status"]), /fallback/);
    let called = 0;
    assert.equal(await gitRun(null, o.location, ["status"], { fallback: () => { called++; return "today"; } }), "today");
    assert.equal(called, 1);
  });
});

// ── (H) The routes ──────────────────────────────────────────────────────────────────────────────
test("(H) routes: project and workspace level, commit with a hook, \"Project is starting\", waker; the list and the wrapper cbase-git", async () => {
  const fd = await fakeDocker();
  const o = gitLocation();
  try {
    await withAgentsServer(async (ctx) => {
      const { base } = ctx;
      // G1: without the operation mark no instance source and no list.
      await withEnvironment({ CBASE_CONTAINER: undefined, CBASE_DIND: undefined }, async () => {
        assert.equal(gitInstanceForWorkspace(), null);
        assert.deepEqual(writeGitProjects(), { ops: false });
      });
      const listFile = path.join(o.location, "git-projects");
      await withEnvironment({ ...o.env, ...ops(fd), CBASE_GIT_PROJECTS: listFile }, async () => {
        const K = path.join(ctx.root, "workspace", "till");
        const L = path.join(ctx.root, "workspace", "stock");
        createRepo(K, o.env);
        createRepo(L, o.env);
        const marker = path.join(o.location, "route.marker");
        fs.writeFileSync(path.join(K, ".git", "hooks", "pre-commit"), hookScript(marker, "pre-commit"), { mode: 0o755 });
        assert.equal(gitInstanceForWorkspace(), null, "without a converted project no source");
        const p = await ctx.projectWithoutInstance({ name: "Till", path: K });
        const name = `cbase-p-${p.id}`;
        containerStart(fd, name, o.containerEnv);
        store.createProjectInstance({ projectId: p.id, state: "ready", convertedAt: Date.now(), containerId: name });
        const kReal = fs.realpathSync(K);
        const lReal = fs.realpathSync(L);

        // Project level: in the container.
        fs.writeFileSync(o.log, "");
        const pb = await json(`${base}/api/projects/${p.id}/git`);
        assert.equal(pb.repos.length, 1, JSON.stringify(pb));
        assert.equal(pb.repos[0].branch, "main");
        assert.equal(pb.starts, undefined);
        const pLog = callsIn(readLog(o.log));
        assert.ok(pLog.length > 0 && pLog.every((a) => a.where === "container"), JSON.stringify(pLog).slice(0, 400));

        // Commit through the route: the hook of the code repo runs in the container.
        fs.writeFileSync(path.join(K, "y.txt"), "y\n");
        fs.writeFileSync(marker, "");
        const c = await json(`${base}/api/projects/${p.id}/git/commit`, { method: "POST", body: JSON.stringify({ repo: "", message: "via the route", all: true }) });
        assert.equal(c.repos[0].lastCommit.subject, "via the route");
        assert.deepEqual(readMarker(marker), ["container pre-commit"]);

        // A knowledge entry with an anchor (OKF): the auto anchor runs in the container as long as it runs.
        const entry = await json(`${base}/api/projects/${p.id}/context`, { method: "POST", body: JSON.stringify({ category: "architecture", title: "Till", body: "x", codePaths: ["a.txt"], force: true }) });
        assert.ok(entry.lastVerified?.commits?.["."], JSON.stringify(entry));

        // Workspace level: till in the container, stock in B. GET …/git never waits for the reading of the small view — it keeps running
        // in the background and would write its git calls into the log of the NEXT check. Before every emptying of the log therefore:
        // finish the open readings first.
        await readingsFinished();
        fs.writeFileSync(o.log, "");
        const wb = await json(`${base}/api/workspaces/${ctx.ws.id}/git`);
        assert.deepEqual(wb.repos.map((r) => r.relPath).sort(), ["stock", "till"]);
        assert.equal(wb.projects, undefined);
        const wLog = callsIn(readLog(o.log));
        assert.ok(wLog.some((a) => a.cwd.startsWith(kReal)) && wLog.some((a) => a.cwd.startsWith(lReal)));
        for (const a of wLog) {
          if (a.cwd.startsWith(kReal)) assert.equal(a.where, "container", `till in B: ${a.argv.join(" ")}`);
          else assert.equal(a.where, "B", `${a.cwd} in the container: ${a.argv.join(" ")}`);
        }

        // The list for cbase-git — and the wrapper itself: in till through cbase-project, in stock the git of B. The list already stands
        // without a manual call: the observer of the data layer wrote it when the row was created ((M)).
        assert.ok(fs.readFileSync(listFile, "utf8").split("\n").includes(`${p.id}\t${kReal}`), "the list does not follow the creation");
        assert.equal(writeGitProjects().written, false, "unchanged ⇒ not written again");
        const projectLog = path.join(o.location, "cbase-project.log");
        const projectBin = path.join(o.location, "cbase-project");
        fs.writeFileSync(projectBin, `#!/bin/sh\nprintf '%s|%s\\n' "$(pwd -P)" "$*" >> '${projectLog}'\n`, { mode: 0o755 });
        const wrapper = (cwd, args) => execFileSync("/bin/sh", [WRAPPER_GIT, ...args], { cwd, env: { ...process.env, CBASE_PROJECT_BIN: projectBin }, encoding: "utf8" });
        await readingsFinished();
        fs.writeFileSync(o.log, "");
        wrapper(K, ["status", "--porcelain"]);
        assert.deepEqual(fs.readFileSync(projectLog, "utf8").trim().split("\n"), [`${kReal}|${p.id} --git-access -- git status --porcelain`]); // --git-access
        wrapper(L, ["status", "--porcelain"]);
        assert.deepEqual(callsIn(readLog(o.log)).map((a) => `${a.where} ${a.cwd} ${a.argv.join(" ")}`), [`B ${lReal} status --porcelain`]);

        // Not ready: "Project is starting", without a docker call; the workspace level names the project, stock stays.
        // `start` is a WORKING state (`/api/runs/active` reports busy): back to `ready` in the finally — otherwise the clean-up of the
        // server after a failure would wait here forever for quiet.
        store.changeProjectInstance(p.id, "main", { state: "start" });
        try {
          await readingsFinished();
          const n = fd.calls().length;
          const st = await json(`${base}/api/projects/${p.id}/git`);
          assert.equal(st.starts, true, JSON.stringify(st));
          assert.equal(st.reason, "start");
          assert.match(st.notice, /Projekt startet/);
          assert.deepEqual(st.repos, []);
          assert.equal(fd.calls().length, n, "docker against a starting container");
          const wst = await json(`${base}/api/workspaces/${ctx.ws.id}/git`);
          assert.deepEqual(wst.repos.map((r) => r.relPath), ["stock"]);
          assert.deepEqual(wst.projects.map((x) => [x.projectId, x.starts]), [[p.id, true]]);
          // An ACTION also asks the situation — 409 "Project is starting" without docker (otherwise the checkout would run through in the
          // starting container). The workspace level likewise for till; stock (B) stays untouched.
          const n3 = fd.calls().length;
          const ak = await response(`${base}/api/projects/${p.id}/git/checkout`, { method: "POST", body: JSON.stringify({ repo: "", branch: "during-start", create: true }) });
          assert.equal(ak.status, 409, JSON.stringify(ak.body));
          assert.deepEqual([ak.body.starts, ak.body.reason], [true, "start"]);
          assert.match(ak.body.notice, /Projekt startet/);
          assert.equal(ak.body.error, ak.body.notice, "`error` for the clients that only read it");
          const wak = await response(`${base}/api/workspaces/${ctx.ws.id}/git/checkout`, { method: "POST", body: JSON.stringify({ repo: "till", branch: "during-start", create: true }) });
          assert.equal(wak.status, 409, JSON.stringify(wak.body));
          assert.equal(wak.body.starts, true);
          assert.equal(fd.calls().length, n3, "docker against a starting container (action)");
          const lagerBranches = await response(`${base}/api/workspaces/${ctx.ws.id}/git/branches?repo=stock`);
          assert.equal(lagerBranches.status, 200, JSON.stringify(lagerBranches.body));
        } finally {
          store.changeProjectInstance(p.id, "main", { state: "ready" });
        }

        // Stopped: without a waker the error of the docker CLI, with a waker "Project is starting" and the waker got the project.
        // server.js connects the real waker (the restoration) — detached here so both cases are measurable.
        execFileSync(fd.bin, ["stop", name], { env: { ...process.env, ...fd.env } });
        setGitWakeup(null);
        const f = await json(`${base}/api/projects/${p.id}/git`);
        assert.match(String(f.error || ""), /is not running/, JSON.stringify(f));
        // An ACTION against the stopped container reports it (409) — never "no git repository at this path".
        const fa = await response(`${base}/api/projects/${p.id}/git/commit`, { method: "POST", body: JSON.stringify({ repo: "", message: "x", all: true }) });
        assert.equal(fa.status, 409, JSON.stringify(fa.body));
        assert.match(String(fa.body.error || ""), /is not running/);
        assert.equal(fa.body.error, fa.body.error);
        const woken = [];
        setGitWakeup((id) => { woken.push(id); });
        try {
          const w = await json(`${base}/api/projects/${p.id}/git`);
          assert.equal(w.starts, true, JSON.stringify(w));
          assert.deepEqual(woken, [p.id]);
          // Every action wakes like the view — project level, workspace level, the OKF verification.
          const wa = await response(`${base}/api/projects/${p.id}/git/checkout`, { method: "POST", body: JSON.stringify({ repo: "", branch: "stopped", create: true }) });
          assert.equal(wa.status, 409, JSON.stringify(wa.body));
          assert.deepEqual([wa.body.starts, wa.body.reason], [true, "stopped"]);
          assert.match(wa.body.error, /Projekt startet/);
          const wwa = await response(`${base}/api/workspaces/${ctx.ws.id}/git/stage`, { method: "POST", body: JSON.stringify({ repo: "till", all: true }) });
          assert.equal(wwa.status, 409, JSON.stringify(wwa.body));
          assert.equal(wwa.body.starts, true);
          const v = await response(`${base}/api/projects/${p.id}/context/${entry.id}/verify`, { method: "POST", body: "{}" });
          assert.equal(v.status, 409, `Verify: ${JSON.stringify(v.body)}`);
          assert.equal(v.body.starts, true);
          assert.deepEqual(woken, [p.id, p.id, p.id, p.id]);
          // The AUTO ANCHOR at creation wakes like the verification — the entry arises unanchored, 201 with `containerStands` (the
          // situation) and `hint`.
          const fresh = await response(`${base}/api/projects/${p.id}/context`, { method: "POST", body: JSON.stringify({ category: "architecture", title: "Till stopped", body: "y", codePaths: ["a.txt"], force: true }) });
          assert.equal(fresh.status, 201, JSON.stringify(fresh.body));
          assert.equal(fresh.body.lastVerified ?? null, null, "an anchor from a standing container");
          assert.deepEqual(woken, [p.id, p.id, p.id, p.id, p.id], "the auto anchor did not wake the project");
          assert.equal(fresh.body.containerStands?.starts, true, JSON.stringify(fresh.body));
          assert.match(String(fresh.body.hint || ""), /ohne Anker/);
          // The freshness of an entry is then "not assessable" (null) — no "rebased" from a standing container.
          const it = await json(`${base}/api/projects/${p.id}/context/${entry.id}`);
          assert.equal(it.freshness, null, JSON.stringify(it.freshness));
        } finally {
          setGitWakeup(null);
        }

        // Instances not readable — the workspace level names the error (instead of 500 or silently "no repo"), an action answers 409
        // with it, and /git/creds does not ask the factory at all.
        const raw = new DatabaseSync(path.join(ctx.dataRoot, "data", "automater.db"), { timeout: 2_147_483_647 });
        try {
          raw.exec("ALTER TABLE project_instances RENAME TO project_instances_way_gita");
          try {
            const u = await response(`${base}/api/workspaces/${ctx.ws.id}/git`);
            assert.equal(u.status, 200, JSON.stringify(u.body));
            assert.deepEqual(u.body.repos, []);
            assert.match(String(u.body.error || ""), /not readable/, JSON.stringify(u.body));
            const cr = await response(`${base}/api/workspaces/${ctx.ws.id}/git/creds`);
            assert.equal(cr.status, 200, JSON.stringify(cr.body));
            const ua = await response(`${base}/api/workspaces/${ctx.ws.id}/git/stage`, { method: "POST", body: JSON.stringify({ repo: "stock", all: true }) });
            assert.equal(ua.status, 409, JSON.stringify(ua.body));
            assert.match(String(ua.body.error || ""), /not readable/);
          } finally {
            raw.exec("ALTER TABLE project_instances_way_gita RENAME TO project_instances");
          }
        } finally {
          raw.close();
        }
      });
    });
  } finally {
    fd.cleanUp();
    fs.rmSync(o.location, { recursive: true, force: true });
  }
});

// ── (I) VS Code ─────────────────────────────────────────────────────────────────────────────────
test("(I) VS Code: git.path in the machine settings — new, added, unchanged; broken JSON stays; without a wrapper nothing; before the tunnel", async () => {
  const o = gitLocation("cbase-vscode-");
  try {
    const wrapper = path.join(o.location, "cbase-git");
    const file = path.join(o.location, "vs", "data", "Machine", "settings.json");
    await withEnvironment({ CBASE_GIT_WRAPPER: wrapper, CBASE_VSCODE_MACHINE: file }, async () => {
      assert.ok(enterGitPath().skipped, "without an executable wrapper no git.path into the void");
      assert.equal(fs.existsSync(file), false);
      fs.writeFileSync(wrapper, "#!/bin/sh\n", { mode: 0o755 });
      assert.equal(enterGitPath().written, true);
      assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { "git.path": wrapper });
      fs.writeFileSync(file, JSON.stringify({ "editor.fontSize": 13, "git.path": "/usr/bin/git" }));
      assert.equal(enterGitPath().written, true);
      assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { "editor.fontSize": 13, "git.path": wrapper });
      assert.equal(enterGitPath().unchanged, true);
      for (const broken of ["{ // comment\n \"a\": 1 }", "[1, 2]", "{ broken"]) {
        fs.writeFileSync(file, broken);
        const r = enterGitPath();
        assert.ok(r.error, `${broken}: ${JSON.stringify(r)}`);
        assert.equal(fs.readFileSync(file, "utf8"), broken, "not overwritten");
      }
    });
    // It is written where the tunnel starts: in startTunnel, before the start of the tunnel or the login.
    const source = fs.readFileSync(path.join(REPO, "server", "backend", "electron", "server", "vscode-tunnel.js"), "utf8");
    const body = source.slice(source.indexOf("export async function startTunnel("));
    const until = body.indexOf("\n}\n");
    const start = body.slice(0, until);
    assert.ok(start.includes("enterGitPath()"), "startTunnel does not write git.path");
    assert.ok(start.indexOf("enterGitPath()") < start.indexOf("startTunnelValue()"), "git.path only after the start of the tunnel");
  } finally {
    fs.rmSync(o.location, { recursive: true, force: true });
  }
});

// ── (J) discarding in the container, not ready, stopped (git.js) ─────────────────────
test("(J) an untracked file is discarded by the project container with an instance (B deletes nothing, not even through a smuggled-in symlink); not ready ⇒ throw without docker; stopped ⇒ feature instead of \"no repo\"", async () => {
  // The `rm` OF THE CONTAINER logs place and arguments and deletes NOTHING — so it shows whether B itself deleted (the fake
  // container shares the file system with B; a real one would not see the folder of B at all).
  const rmMarker = (o) => path.join(o.location, "rm.marker");
  const onlyInContainer = (o) => {
    const d = path.join(o.location, "only-in-container");
    fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, "rm"), `#!/bin/sh\nprintf '%s %s\\n' "\${IN_CONTAINER:-B}" "$*" >> '${rmMarker(o)}'\n`, { mode: 0o755 });
    return { PATH: `${d}${path.delimiter}${o.env.PATH}` };
  };
  await unit(async ({ fd, o, name, inst }) => {
    const P = path.join(o.location, "vproj");
    const A = path.join(P, "app");
    createRepo(A, o.env);
    fs.writeFileSync(rmMarker(o), "");
    // The container swapped `dir` between status and click for a symlink to a folder of B.
    const ofB = path.join(o.location, "b-data");
    fs.mkdirSync(ofB);
    fs.writeFileSync(path.join(ofB, "cbase.db"), "B");
    fs.symlinkSync(ofB, path.join(A, "dir"));
    await gitDiscard(P, "app", "dir/cbase.db", { untracked: true, instance: inst });
    assert.equal(fs.readFileSync(path.join(ofB, "cbase.db"), "utf8"), "B", "B deleted through the symlink outside the project");
    const target = path.join(A, "dir", "cbase.db");
    assert.deepEqual(readMarker(rmMarker(o)), [`container -rf -- ${target}`], "the deletion did not run in the container");
    assert.deepEqual(execCalls(fd).filter((e) => command(e)[0] === "rm").map(command), [["rm", "-rf", "--", target]]);
    // Without an instance as today (G2): rmSync in B, no docker.
    const n = fd.calls().length;
    fs.writeFileSync(path.join(A, "u.txt"), "u\n");
    await gitDiscard(P, "app", "u.txt", { untracked: true });
    assert.equal(fs.existsSync(path.join(A, "u.txt")), false);
    assert.equal(fd.calls().length, n, "a docker call without an instance");

    // Not ready: the situation throws BEFORE the first docker call, with `err.situation`.
    const n2 = fd.calls().length;
    const situation = () => ({ starts: true, reason: "start", notice: "Projekt startet" });
    await assert.rejects(gitCheckout(P, "app", "never", { instance: inst, create: true, situation }),
      (e) => e.situation?.projectId === "p1" && e.situation.starts === true && e.message === "Projekt startet");
    assert.equal(fd.calls().length, n2, "docker against a container that is not ready");
    // Stopped: the feature `containerStands` with the project, the message of the docker CLI — never "no repo".
    execFileSync(fd.bin, ["stop", name], { env: { ...process.env, ...fd.env } });
    for (const run of [() => gitCheckout(P, "app", "main", { instance: inst }), () => gitDiscard(P, "app", "u.txt", { untracked: true, instance: inst })]) {
      await assert.rejects(run(), (e) => e.containerStands === true && e.projectId === "p1" && /is not running/.test(e.message) && !/Kein Git-Repository/.test(e.message));
    }
  }, { containerEnv: onlyInContainer });
});

// ── (K) an instance source that throws (codeRoute) ─────────────────────────────────
test("(K) if the instance source throws (factory or per path), the git view names the error instead of silently \"no repo\" — without a source as today", async () => {
  const o = gitLocation("cbase-gita5-");
  try {
    await withEnvironment(o.env, async () => {
      const W = path.join(o.location, "ws");
      createRepo(path.join(W, "till"), o.env);
      const calls = async (opts) => {
        const res = { writeHead(c) { this.status = c; }, end(b) { this.body = JSON.parse(b); } };
        const done = await codeRoute(W, "/git", "GET", {}, res, new URL("http://127.0.0.1/api/workspaces/w/git"), opts);
        return { done, status: res.status, body: res.body };
      };
      const thrown = () => { throw new Error("Instance of project p1 not readable (SQLITE_BUSY) — no start in B at the old path"); };
      for (const [kind, opts] of [["per path", { gitInstanceSource: () => thrown }], ["factory", { gitInstanceSource: thrown }]]) {
        const r = await calls(opts);
        assert.equal(r.status, 200, `${kind}: ${JSON.stringify(r)}`);
        assert.deepEqual(r.body.repos, [], kind);
        assert.match(String(r.body.error || ""), /not readable/, `${kind}: silently "no repo" — ${JSON.stringify(r.body)}`);
      }
      // The same question one level deeper: projectRepos does not swallow the throw as "no repo".
      await assert.rejects(gitModule.projectRepos(W, { instanceFor: thrown }), /not readable/);
      const today = await calls({});
      assert.deepEqual(today.body.repos.map((x) => x.relPath), ["till"]);
      assert.equal(today.body.error, undefined);
      assert.equal(today.body.projects, undefined);
    });
  } finally {
    fs.rmSync(o.location, { recursive: true, force: true });
  }
});

// ── (L) the emptying of the helper list value-empty in argv (runtime/git-run.js) ─────────────
test("(L) the emptying of the helper list goes as -e GIT_CONFIG_VALUE_0= in argv — even if B already carries the same empty value; no value of the access in argv, not even an empty one", async () => {
  await unit(async ({ fd, o, inst }) => {
    const dir = path.join(o.location, "empty-l");
    fs.mkdirSync(dir);
    const question = "protocol=https\nhost=example.invalid\n\n";
    const secretValue = `${SECRET}-L`;
    // B already carries GIT_CONFIG_VALUE_0 empty: the allowlist (deviations only) would drop the name through the environment, and in
    // the container GIT_CONFIG_COUNT=2 would stand without GIT_CONFIG_VALUE_0 (git aborts).
    const list = (secret) => [{ host: "example.invalid", access: { username: "user", secret } }];
    const r = await withEnvironment({ GIT_CONFIG_VALUE_0: "" }, () => gitRun(inst, dir, ["credential", "fill"], { stdin: question, env: accessAsEnvironment(list(secretValue)) }));
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.split("\n").includes(`password=${secretValue}`), `the inherited helper answered (or none): ${r.stdout}`);
    const ex = execCalls(fd).at(-1);
    const flags = ex.args.slice(0, ex.args.indexOf(WRAPPER_PATH));
    assert.ok(flags.some((x, i) => x === "GIT_CONFIG_VALUE_0=" && flags[i - 1] === "-e"), `-e GIT_CONFIG_VALUE_0= is missing: ${JSON.stringify(flags)}`);
    assert.ok(!flags.includes("GIT_CONFIG_VALUE_0"), "the emptying not additionally through the environment");
    // An EMPTY secret still stays in the environment: of the values of the access only the name stands in argv.
    await gitRun(inst, dir, ["credential", "fill"], { stdin: question, env: accessAsEnvironment(list("")) });
    const ex2 = execCalls(fd).at(-1);
    const flags2 = ex2.args.slice(0, ex2.args.indexOf(WRAPPER_PATH));
    for (const n of ["CBASE_GIT_USERNAME_0", "CBASE_GIT_PASSWORD_0"]) {
      assert.ok(flags2.some((x, i) => x === n && flags2[i - 1] === "-e"), `-e ${n} is missing: ${JSON.stringify(flags2)}`);
      assert.ok(!flags2.some((x) => x.startsWith(`${n}=`)), `${n} with a value in argv: ${JSON.stringify(flags2)}`);
    }
    for (const a of fd.calls()) assert.ok(!JSON.stringify(a.args).includes(SECRET), `secret in argv: ${JSON.stringify(a.args).slice(0, 300)}`);
  });
});

test("(M) the list for cbase-git follows every change of converted_at — without restart, without a manual call; without the operation mark no list", async () => {
  const location = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cbase-git-m-")));
  // After creating, changing or deleting: ONE round of the event loop — the observer runs as a microtask.
  const round = () => new Promise((r) => setImmediate(r));
  try {
    await withAgentsServer(async (ctx) => {
      const listFile = path.join(location, "git-projects");
      // The rows of the projects — the lock rows of the copies (`!locked`) are ALWAYS in it with the operation mark; "empty" here
      // means: no project.
      const list = () => (fs.existsSync(listFile) ? fs.readFileSync(listFile, "utf8").split("\n").filter((z) => z && !z.startsWith("!locked\t")) : null);
      const K = path.join(ctx.root, "workspace", "till-m");
      fs.mkdirSync(K, { recursive: true });
      const p = await json(`${ctx.base}/api/workspaces/${ctx.ws.id}/projects`, { method: "POST", body: JSON.stringify({ name: "Till M", path: K }) });
      const row = `${p.id}\t${fs.realpathSync(K)}`;
      try {
        await withEnvironment({ CBASE_CONTAINER: "1", CBASE_DIND: "1", CBASE_GIT_PROJECTS: listFile }, async () => {
          // A row WITHOUT converted_at (in the middle of a creation or relocation) converts nothing — nothing to write.
          store.createProjectInstance({ projectId: p.id, state: "ready" });
          await round();
          assert.equal(list(), null, "a row without converted_at wrote the list");
          // The relocation sets converted_at.
          store.changeProjectInstance(p.id, "main", { convertedAt: Date.now() });
          await round();
          assert.ok(list()?.includes(row), `the list does not follow the setting: ${JSON.stringify(list())}`);
          // Taken back (a way back): the project drops out — the list is EMPTY, not gone.
          store.changeProjectInstance(p.id, "main", { convertedAt: null });
          await round();
          assert.deepEqual(list(), [], "the list does not follow the taking back");
          // Set again, then deleted.
          store.changeProjectInstance(p.id, "main", { convertedAt: Date.now() });
          await round();
          assert.ok(list()?.includes(row));
          store.deleteProjectInstance(p.id);
          await round();
          assert.deepEqual(list(), [], "the list does not follow the deletion");
          // Create WITH converted_at; afterwards a change of other fields triggers nothing (the file stays gone if one removes it).
          store.createProjectInstance({ projectId: p.id, state: "ready", convertedAt: Date.now() });
          await round();
          assert.ok(list()?.includes(row), "the list does not follow the creation");
          fs.rmSync(listFile);
          store.changeProjectInstance(p.id, "main", { phase: "x", error: "" });
          await round();
          assert.equal(list(), null, "a change without converted_at wrote the list");
          // Deleting an instance (with a name) — the same way.
          store.deleteProjectInstance(p.id, "main");
          await round();
          assert.deepEqual(list(), []);
        });
        // G1: without the operation mark the observer calls, but no list arises.
        const without = path.join(location, "git-projects-without");
        await withEnvironment({ CBASE_CONTAINER: undefined, CBASE_DIND: undefined, CBASE_GIT_PROJECTS: without }, async () => {
          store.createProjectInstance({ projectId: p.id, state: "ready", convertedAt: Date.now() });
          await round();
          assert.equal(fs.existsSync(without), false, "a list without the operation mark");
        });
      } finally {
        store.deleteProjectInstance(p.id);
      }
    });
  } finally {
    fs.rmSync(location, { recursive: true, force: true });
  }
});

// ── (N) `.git/config` of a converted project only without a link ────────────────────────────────────────
const MARKER_PROJECT_REPO = "[cbase]\n\tprojectrepo = true\n";
const INST_N2 = { projectId: "p9", instance: "main", identifier: "p9/main", containerId: "cbase-p-p9" };
// A FIFO without a writer, read in a CHILD PROCESS (`script`, ESM). No verdict over a clock: the test opens the FIFO for writing
// itself BEFOREHAND (that blocks in the thread pool until a reader opens) and writes `content` as soon as that succeeds — a reader
// that waited blocking (the bug) thus gets the content and ends with it (red at the result, no hang); a reader with O_NONBLOCK that
// takes only regular files never reads from it. After the end of the child an own reader (O_NONBLOCK) releases a still waiting writer.
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

test("(N) a FIFO at .git/config of a converted project does not stop B — the sidebar (projectRepos) ends, B reads nothing from it", async () => {
  const location = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-git-fifo-"));
  try {
    const proj = path.join(location, "till");
    fs.mkdirSync(path.join(proj, "fifo", ".git"), { recursive: true });
    execFileSync("mkfifo", [path.join(proj, "fifo", ".git", "config")]);
    // The workspace level: the folder itself without an instance (rev-parse in B, no repo), what lies below belongs to the project.
    const script = `const { projectRepos } = await import(process.env.GIT_JS);
      const proj = process.env.PROJ;
      const inst = JSON.parse(process.env.INST);
      const list = await projectRepos(proj, { instanceFor: (p) => (p === proj ? null : inst) });
      process.stdout.write(JSON.stringify(list.map((r) => r.relPath)));`;
    const r = await fifoInChild(path.join(proj, "fifo", ".git", "config"), MARKER_PROJECT_REPO, script, {
      GIT_JS: path.resolve(TESTDIR, "..", "electron", "server", "git.js"), PROJ: proj, INST: JSON.stringify(INST_N2),
    });
    assert.equal(r.code, 0, `Kind: ${r.signal || r.code} ${r.err}`);
    assert.deepEqual(JSON.parse(r.out), ["fifo"], `B read .git/config from the FIFO (the mark arrived): ${r.out}`);
  } finally {
    fs.rmSync(location, { recursive: true, force: true });
  }
});

test("(N) a link at .git/config of a converted project is not read, a regular file is — without an instance as today (G2)", async () => {
  const location = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-git-reference-"));
  try {
    const proj = path.join(location, "till");
    const outside = path.join(location, "b-file");
    fs.writeFileSync(outside, MARKER_PROJECT_REPO);
    for (const d of ["real", "link"]) fs.mkdirSync(path.join(proj, d, ".git"), { recursive: true });
    fs.writeFileSync(path.join(proj, "real", ".git", "config"), MARKER_PROJECT_REPO);
    fs.symlinkSync(outside, path.join(proj, "link", ".git", "config"));
    const { isProjectRepo, findRepos, projectRepos } = gitModule;
    const safe = { safe: true, anchor: proj };
    // The function itself: with `safe` only the regular file counts; without it today's call (it follows the link).
    assert.equal(isProjectRepo(path.join(proj, "real"), safe), true, "the regular file is read without a link");
    assert.equal(isProjectRepo(path.join(proj, "link"), safe), false, "B read the file behind the link");
    assert.equal(isProjectRepo(path.join(proj, "link")), true, "without `safe` today's call changed (G2)");
    // The search and the sidebar: with an instance `link` is a code repo (its mark does not count), without as today.
    assert.deepEqual(findRepos(proj, { safe: () => true }).map((d) => path.basename(d)), ["link"]);
    assert.deepEqual(findRepos(proj), [], "findRepos without `safe` changed (G2)");
    const including = await projectRepos(proj, { instanceFor: (p) => (p === proj ? null : INST_N2) });
    assert.deepEqual(including.map((r) => r.relPath), ["link"], `projectRepos does not pass the instance on as \`safe\`: ${JSON.stringify(including)}`);
    assert.deepEqual(await projectRepos(proj, {}), [], "projectRepos without an instance changed (G2)");
    // An instance source that throws also reads only without a link (not readable is not "not converted").
    const raises = await projectRepos(proj, { instanceFor: (p) => { if (p === proj) return null; throw new Error("not readable"); } });
    assert.deepEqual(raises.map((r) => r.relPath), ["link"]);
  } finally {
    fs.rmSync(location, { recursive: true, force: true });
  }
});

// ══ Git assignment, list and routes (O)-(U) — the promises are in the header ═══════════════════════════════════════════════

const rawDb = (ctx) => new DatabaseSync(path.join(ctx.dataRoot, "data", "automater.db"), { timeout: 2_147_483_647 });
async function withoutInstanceTable(ctx, marker, fn) {
  const raw = rawDb(ctx);
  try {
    raw.exec(`ALTER TABLE project_instances RENAME TO project_instances_way_${marker}`);
    try { return await fn(); } finally { raw.exec(`ALTER TABLE project_instances_way_${marker} RENAME TO project_instances`); }
  } finally { raw.close(); }
}
async function convertedProject(ctx, fd, o, name, filePath) {
  const p = await ctx.projectWithoutInstance({ name, path: filePath });
  containerStart(fd, `cbase-p-${p.id}`, o.containerEnv);
  store.createProjectInstance({ projectId: p.id, state: "ready", convertedAt: Date.now(), containerId: `cbase-p-${p.id}` });
  return p;
}

test("(O) an unreadable instance does not make /context/categories 409 — /git/stage still answers 409", async () => {
  const fd = await fakeDocker();
  const o = gitLocation("cbase-git-o-");
  try {
    await withAgentsServer(async (ctx) => {
      await withEnvironment({ ...o.env, ...ops(fd), CBASE_GIT_PROJECTS: path.join(o.location, "git-projects") }, async () => {
        const K = path.join(ctx.root, "workspace", "till-o");
        createRepo(K, o.env);
        const p = await convertedProject(ctx, fd, o, "Till O", K);
        await withoutInstanceTable(ctx, "o", async () => {
          const k = await response(`${ctx.base}/api/projects/${p.id}/context/categories`);
          assert.equal(k.status, 200, `/context/categories: ${JSON.stringify(k.body)}`);
          const s = await response(`${ctx.base}/api/projects/${p.id}/git/stage`, { method: "POST", body: JSON.stringify({ repo: "", all: true }) });
          assert.equal(s.status, 409, `/git/stage: ${JSON.stringify(s.body)}`);
        });
      });
    });
  } finally {
    fd.cleanUp();
    fs.rmSync(o.location, { recursive: true, force: true });
  }
});

test("(P) a stopped container in the middle of /git/diff ⇒ 409 \"Project is starting\" with a waker — never 200 with an empty diff", async () => {
  const fd = await fakeDocker();
  const o = gitLocation("cbase-git-p-");
  try {
    await withAgentsServer(async (ctx) => {
      await withEnvironment({ ...o.env, ...ops(fd), CBASE_GIT_PROJECTS: path.join(o.location, "git-projects") }, async () => {
        // In the container git runs through, only `diff` reports the daemon error of a stopped container (exit 1). The subcommand of a
        // reading path no longer stands first (in front `-c core.hooksPath=… -c core.fsmonitor=false`, runtime/git-run.js readingArgs) —
        // it is searched as a word of its own.
        const front = path.join(o.location, "front");
        fs.mkdirSync(front);
        fs.writeFileSync(path.join(front, "git"), `#!/bin/sh\nfor a in "$@"; do case "$a" in diff) echo "Error response from daemon: container 0123abcd is not running" >&2; exit 1 ;; esac; done\nexec '${path.join(o.bin, "git")}' "$@"\n`, { mode: 0o755 });
        const K = path.join(ctx.root, "workspace", "till-p");
        createRepo(K, o.env);
        fs.writeFileSync(path.join(K, "a.txt"), "changed\n");
        const p = await ctx.projectWithoutInstance({ name: "Till P", path: K });
        containerStart(fd, `cbase-p-${p.id}`, { ...o.containerEnv, PATH: `${front}${path.delimiter}${o.env.PATH}` });
        store.createProjectInstance({ projectId: p.id, state: "ready", convertedAt: Date.now(), containerId: `cbase-p-${p.id}` });
        const woken = [];
        setGitWakeup((id) => { woken.push(id); });
        try {
          const d = await response(`${ctx.base}/api/projects/${p.id}/git/diff`, { method: "POST", body: JSON.stringify({ repo: "", file: "a.txt" }) });
          assert.equal(d.status, 409, `silently empty instead of "Project is starting": ${JSON.stringify(d.body)}`);
          assert.equal(d.body.starts, true);
          assert.deepEqual(woken, [p.id]);
        } finally {
          setGitWakeup(null);
        }
      });
    });
  } finally {
    fd.cleanUp();
    fs.rmSync(o.location, { recursive: true, force: true });
  }
});

test("(Q) the read bundle runs with -w /, not in the first repo (a linked worktree outside that sorts first)", async () => {
  const fd = await fakeDocker();
  const o = gitLocation("cbase-git-q-");
  try {
    await withAgentsServer(async (ctx) => {
      await withEnvironment({ ...o.env, ...ops(fd), CBASE_GIT_PROJECTS: path.join(o.location, "git-projects") }, async () => {
        const K = path.join(ctx.root, "workspace", "till");
        createRepo(path.join(K, "app"), o.env);
        const wt = path.join(ctx.root, "workspace", "aaa-wt");
        realGit(path.join(K, "app"), ["worktree", "add", "-q", "-b", "wt-q", wt], o.env);
        const p = await convertedProject(ctx, fd, o, "Till", K);
        const n = execCalls(fd).length;
        const wb = await json(`${ctx.base}/api/workspaces/${ctx.ws.id}/git`);
        assert.ok(wb.repos.some((r) => r.relPath === "till/app"), JSON.stringify(wb));
        const bundle = execCalls(fd).slice(n).filter((a) => command(a)[0] === "sh" && command(a)[2] === BUNDLE_SCRIPT);
        assert.equal(bundle.length, 1, `bundle: ${bundle.length}`);
        assert.equal(argValue(bundle[0], "-w"), "/", `the bundle runs in the first repo: ${argValue(bundle[0], "-w")}`);
        assert.ok(command(bundle[0]).includes(fs.realpathSync(wt)) || command(bundle[0]).includes(wt), "the worktree belongs to the group of the project");
        assert.ok(p.id);
      });
    });
  } finally {
    fd.cleanUp();
    fs.rmSync(o.location, { recursive: true, force: true });
  }
});

test("(R) a FIFO at commondir does not stop B — the common git directory is then the gitdir; a regular commondir counts", async () => {
  const location = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cbase-git-r-")));
  try {
    const proj = path.join(location, "till");
    const gitdir = path.join(proj, ".git", "worktrees", "n");
    fs.mkdirSync(gitdir, { recursive: true });
    const outside = path.join(location, "hotfix");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, ".git"), `gitdir: ${gitdir}\n`);
    execFileSync("mkfifo", [path.join(gitdir, "commondir")]);
    const script = `const { commonGitDirectory } = await import(process.env.ASSIGNMENT_JS);
      process.stdout.write(JSON.stringify(commonGitDirectory(process.env.OUTSIDE)));`;
    const r = await fifoInChild(path.join(gitdir, "commondir"), "/nowhere-in-b\n", script, {
      ASSIGNMENT_JS: path.resolve(TESTDIR, "..", "electron", "server", "projectbox", "git-assignment.js"), OUTSIDE: outside,
    });
    assert.equal(r.code, 0, `Kind: ${r.signal || r.code} ${r.err}`);
    assert.equal(JSON.parse(r.out), gitdir, `B read commondir from the FIFO: ${r.out}`);
    // Counter-test: a regular commondir is read — the common directory is the .git of the project.
    fs.rmSync(path.join(gitdir, "commondir"));
    fs.writeFileSync(path.join(gitdir, "commondir"), "../..\n");
    assert.equal(assignment.commonGitDirectory(outside), path.join(proj, ".git"));
    // A link at commondir is not read (like a FIFO: the gitdir stays).
    fs.rmSync(path.join(gitdir, "commondir"));
    fs.writeFileSync(path.join(location, "b-file"), "/nowhere-in-b\n");
    fs.symlinkSync(path.join(location, "b-file"), path.join(gitdir, "commondir"));
    assert.equal(assignment.commonGitDirectory(outside), gitdir);
    // A .git FILE as a link: no hit (null) instead of following a file of B.
    fs.rmSync(path.join(outside, ".git"));
    fs.writeFileSync(path.join(location, "b-git-file"), `gitdir: ${gitdir}\n`);
    fs.symlinkSync(path.join(location, "b-git-file"), path.join(outside, ".git"));
    assert.equal(assignment.commonGitDirectory(outside), null);
  } finally {
    fs.rmSync(location, { recursive: true, force: true });
  }
});

test("(S) <runtime A>/worktrees as a link to the repo of B or to / ⇒ the repo belongs to B or to nobody; the list carries no foreign root for A", async () => {
  const fd = await fakeDocker();
  const o = gitLocation("cbase-git-s-");
  try {
    await withAgentsServer(async (ctx) => {
      const listFile = path.join(o.location, "git-projects");
      await withEnvironment({ ...o.env, ...ops(fd), CBASE_GIT_PROJECTS: listFile }, async () => {
        const A = path.join(ctx.root, "workspace", "till-a");
        const B = path.join(ctx.root, "workspace", "till-b");
        const L = path.join(ctx.root, "workspace", "stock");
        createRepo(A, o.env);
        createRepo(B, o.env);
        createRepo(L, o.env);
        const pa = await convertedProject(ctx, fd, o, "Till A", A);
        const pb = await convertedProject(ctx, fd, o, "Till B", B);
        const locationA = locationFor({ projectId: pa.id, converted: true });
        fs.mkdirSync(locationA.root, { recursive: true });
        const bReal = fs.realpathSync(B);
        const rowsOfA = () => fs.readFileSync(listFile, "utf8").split("\n").filter((z) => z.startsWith(`${pa.id}\t`)).map((z) => z.slice(pa.id.length + 1));
        // Case 1: worktrees → the repo of B.
        fs.rmSync(locationA.worktrees, { recursive: true, force: true });
        fs.symlinkSync(B, locationA.worktrees);
        assert.equal(gitInstanceForWorkspace()(B)?.projectId, pb.id, "the repo of B belongs to A");
        writeGitProjects();
        assert.ok(!rowsOfA().some((x) => x === bReal || x === B), `the list carries the repo of B for A: ${JSON.stringify(rowsOfA())}`);
        // Case 2: worktrees → /.
        fs.rmSync(locationA.worktrees);
        fs.symlinkSync("/", locationA.worktrees);
        assert.equal(gitInstanceForWorkspace()(L), null, "a repo in B belongs to A (worktrees → /)");
        writeGitProjects();
        assert.ok(!rowsOfA().includes("/"), `the list carries / for A: ${JSON.stringify(rowsOfA())}`);
        // Case 3: copy-worktrees (the collecting root of the copies, an ordinary subfolder of the runtime folder) → the repo "stock" in B:
        // it is neither assigned to A nor locked — the lock row applies to the LITERAL place (rootUnder).
        const lReal = fs.realpathSync(L);
        fs.rmSync(locationA.copyWorktrees, { recursive: true, force: true });
        fs.symlinkSync(L, locationA.copyWorktrees);
        assert.equal(gitInstanceForWorkspace()(L), null, "a repo in B belongs to A (copy-worktrees → stock)");
        writeGitProjects();
        const allRows = fs.readFileSync(listFile, "utf8").split("\n").map((z) => z.split("\t").slice(1).join("\t"));
        assert.ok(!allRows.some((x) => x === lReal || x === L), `the list carries the repo "stock" (root or lock): ${JSON.stringify(allRows)}`);
        fs.rmSync(locationA.copyWorktrees);
        // Counter-test: a real worktrees folder stays with A.
        fs.rmSync(locationA.worktrees);
        const wt = path.join(locationA.worktrees, "agent-x");
        realGit(A, ["worktree", "add", "-q", "-b", "wt-s", wt], o.env);
        assert.equal(gitInstanceForWorkspace()(wt)?.projectId, pa.id);
      });
    });
  } finally {
    fd.cleanUp();
    fs.rmSync(o.location, { recursive: true, force: true });
  }
});

test("(T) the list — runtime folder as root, lock rows (also without a converted project), `!incomplete` for unreadable instances and before the first read; the wrapper follows", async () => {
  const fd = await fakeDocker();
  const o = gitLocation("cbase-git-t-");
  try {
    await withAgentsServer(async (ctx) => {
      const listFile = path.join(o.location, "git-projects");
      const list = () => fs.readFileSync(listFile, "utf8").split("\n").filter(Boolean);
      const data = DIRS.data;
      const dReal = fs.realpathSync(data);
      const lockLines = [...new Set([`!locked\t${path.join(dReal, "copies")}`, `!locked\t${path.join(data, "copies")}`,
        `!locked\t${path.join(dReal, "copies-backup")}`, `!locked\t${path.join(data, "copies-backup")}`])].sort();
      await withEnvironment({ ...o.env, ...ops(fd), CBASE_GIT_PROJECTS: listFile }, async () => {
        // Without a converted project: the list stands anyway — only with the lock rows.
        writeGitProjects();
        assert.deepEqual(list().sort(), lockLines, "without a converted project the lock rows are missing");
        // With a converted project: the whole runtime folder, copy-worktrees locked.
        const K = path.join(ctx.root, "workspace", "till-t");
        createRepo(K, o.env);
        const p = await convertedProject(ctx, fd, o, "Till T", K);
        const location = locationFor({ projectId: p.id, converted: true });
        const c1 = path.join(location.root, "outputs", "c1");
        fs.mkdirSync(c1, { recursive: true });
        realGit(c1, ["init", "-q"], o.env);
        writeGitProjects();
        const lz = fs.realpathSync(location.root);
        for (const z of [`${p.id}\t${lz}`, `!locked\t${path.join(lz, "copy-worktrees")}`, ...lockLines]) assert.ok(list().includes(z), `${z} is missing: ${JSON.stringify(list())}`);
        // The wrapper: the runtime folder goes into the project container, a copy layer neither and not to B either.
        const projectLog = path.join(o.location, "cbase-project.log");
        const projectBin = path.join(o.location, "cbase-project");
        fs.writeFileSync(projectBin, `#!/bin/sh\nprintf '%s|%s\\n' "$(pwd -P)" "$*" >> '${projectLog}'\n`, { mode: 0o755 });
        const wrapper = (cwd) => spawnSyncWrapper(cwd, projectBin);
        fs.writeFileSync(o.log, "");
        assert.equal(wrapper(c1).status, 0);
        assert.deepEqual(fs.readFileSync(projectLog, "utf8").trim().split("\n"), [`${fs.realpathSync(c1)}|${p.id} --git-access -- git status`]);
        assert.deepEqual(callsIn(readLog(o.log)), [], "git ran in B in the runtime folder");
        const layer = path.join(data, "copies", p.id, "k1", "layer", "p");
        fs.mkdirSync(layer, { recursive: true });
        realGit(layer, ["init", "-q"], o.env);
        fs.writeFileSync(o.log, "");
        const gs = wrapper(layer);
        assert.equal(gs.status, 128, gs.stderr);
        assert.deepEqual(callsIn(readLog(o.log)), []);
        // Instances not readable ⇒ the existing list is marked (not left standing), the wrapper refuses.
        await withoutInstanceTable(ctx, "t", async () => {
          const r = writeGitProjects();
          assert.ok(r.error, JSON.stringify(r));
          assert.equal(list()[0], "!incomplete", `the list stayed standing: ${JSON.stringify(list())}`);
          const u = wrapper(c1);
          assert.equal(u.status, 128, u.stderr);
        });
        writeGitProjects();
        assert.ok(!list().includes("!incomplete"), "the mark stays after the next write");
        // The mark of the start: before the first read of the instances, the rows stay below it.
        const prior = list();
        assert.equal(typeof assignment.gitProjectsIncomplete, "function", "gitProjectsIncomplete is missing");
        assignment.gitProjectsIncomplete();
        assert.deepEqual(list(), ["!incomplete", ...prior]);
        writeGitProjects();
        const source = fs.readFileSync(path.resolve(TESTDIR, "..", "electron", "server", "server.js"), "utf8");
        const marker = source.indexOf("gitProjectsIncomplete();");
        assert.ok(marker > 0 && marker < source.indexOf("store.initStore(DIRS.data);"), "the start does not mark the list before the first read");
      });
    });
  } finally {
    fd.cleanUp();
    fs.rmSync(o.location, { recursive: true, force: true });
  }
});
function spawnSyncWrapper(cwd, projectBin) {
  try {
    const out = execFileSync("/bin/sh", [WRAPPER_GIT, "status"], { cwd, env: { ...process.env, CBASE_PROJECT_BIN: projectBin }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { status: 0, stdout: out, stderr: "" };
  } catch (e) { return { status: e.status, stdout: String(e.stdout || ""), stderr: String(e.stderr || "") }; }
}

// (U) a failed write of the list plans ONE repetition — otherwise `!incomplete` would stay until `converted_at` changed the next
//     time (maybe never), and the wrapper would refuse every git until then. At most one open, doubled delay per further failure, a
//     successful write (by anyone) cancels it; 0 switches off. No clock in the test: the seam `setGitListClock` catches the plan, the
//     test runs it itself.
test("(U) the list is repeated after a failure until it stands — one open, doubled delay, cancelled by success", async () => {
  const fd = await fakeDocker();
  const o = gitLocation("cbase-git-u-");
  const scheduled = [];
  const aborted = [];
  assert.equal(typeof assignment.setGitListClock, "function", "the seam setGitListClock is missing — a failure is never repeated");
  assignment.setGitListClock({ schedule: (f, ms) => { scheduled.push({ f, ms }); return scheduled.length; }, abort: (id) => { aborted.push(id); } });
  try {
    await withAgentsServer(async (ctx) => {
      const listFile = path.join(o.location, "git-projects");
      const list = () => fs.readFileSync(listFile, "utf8").split("\n").filter(Boolean);
      await withEnvironment({ ...o.env, ...ops(fd), CBASE_GIT_PROJECTS: listFile, CBASE_GIT_LIST_REPEAT_MS: undefined }, async () => {
        // A converted project: without any instance row a missing table is "no instance possible", no read error.
        const K = path.join(ctx.root, "workspace", "till-u");
        createRepo(K, o.env);
        await convertedProject(ctx, fd, o, "Till U", K);
        assert.ok(!writeGitProjects().error);
        assert.equal(scheduled.length, 0, "a successful write plans nothing");
        await withoutInstanceTable(ctx, "u", async () => {
          assert.ok(writeGitProjects().error);
          assert.equal(list()[0], "!incomplete");
          assert.equal(scheduled.length, 1, "no plan after the failure — the mark would stay until the next change of converted_at");
          assert.equal(scheduled[0].ms, assignment.GIT_LIST_REPEAT_DEFAULT_MS);
          assert.ok(writeGitProjects().error);
          assert.equal(scheduled.length, 1, "a second failure plans a second one although one is open");
          // The open one runs and fails again (the third failure in a row): the next one with four times the delay.
          scheduled[0].f();
          assert.equal(scheduled.length, 2);
          assert.equal(scheduled[1].ms, 4 * assignment.GIT_LIST_REPEAT_DEFAULT_MS);
          assert.equal(list()[0], "!incomplete");
        });
        // The table is back, nobody wrote: the mark still stands — only the repetition clears it.
        assert.equal(list()[0], "!incomplete");
        scheduled[1].f();
        assert.ok(!list().includes("!incomplete"), `the repetition did not write the list: ${JSON.stringify(list())}`);
        assert.equal(scheduled.length, 2, "after the success a new plan stands");
        // A success from elsewhere cancels an open one, and the delay starts again at the default.
        await withoutInstanceTable(ctx, "u2", async () => { assert.ok(writeGitProjects().error); });
        assert.equal(scheduled.length, 3);
        assert.equal(scheduled[2].ms, assignment.GIT_LIST_REPEAT_DEFAULT_MS, "the delay did not start from the beginning after the success");
        assert.ok(!writeGitProjects().error);
        assert.deepEqual(aborted, [3], "the success did not cancel the open repetition");
        // Switched off: no plan.
        await withEnvironment({ CBASE_GIT_LIST_REPEAT_MS: "0" }, async () => {
          await withoutInstanceTable(ctx, "u3", async () => { assert.ok(writeGitProjects().error); });
        });
        assert.equal(scheduled.length, 3, "CBASE_GIT_LIST_REPEAT_MS=0 planned anyway");
        writeGitProjects();
      });
    });
  } finally {
    assignment.setGitListClock(null);
    fd.cleanUp();
    fs.rmSync(o.location, { recursive: true, force: true });
  }
});

// ── (V) the hint of the auto anchor follows the situation ────────────────────────────────
test("(V) the hint of the auto anchor says \"is being woken\" only when it is woken — not without a waker, not with a failing one, not in a pause", async () => {
  const fd = await fakeDocker();
  const o = gitLocation("cbase-git-u-");
  try {
    await withAgentsServer(async (ctx) => {
      await withEnvironment({ ...o.env, ...ops(fd), CBASE_GIT_PROJECTS: path.join(o.location, "git-projects") }, async () => {
        const K = path.join(ctx.root, "workspace", "till-u");
        createRepo(K, o.env);
        const p = await convertedProject(ctx, fd, o, "Till U", K);
        const name = `cbase-p-${p.id}`;
        const docker = (...args) => execFileSync(fd.bin, args, { env: { ...process.env, ...fd.env } });
        const create = (title) => response(`${ctx.base}/api/projects/${p.id}/context`, { method: "POST", body: JSON.stringify({ category: "architecture", title, body: "u", codePaths: ["a.txt"], force: true }) });
        const woken = [];
        try {
          // Witness: with a running container the anchor arises — the way through the container measures something.
          const ok = await create("Till running");
          assert.equal(ok.status, 201, JSON.stringify(ok.body));
          assert.ok(ok.body.lastVerified?.commits?.["."], JSON.stringify(ok.body));
          assert.equal(ok.body.hint, undefined, JSON.stringify(ok.body));

          // a: stopped, WITHOUT a waker — the situation carries only `error`, nothing is woken.
          docker("stop", name);
          setGitWakeup(null);
          const a = await create("Till without waker");
          assert.equal(a.status, 201, JSON.stringify(a.body));
          assert.match(String(a.body.containerStands?.error || ""), /is not running/, JSON.stringify(a.body));
          assert.doesNotMatch(String(a.body.hint || ""), /wird geweckt/, `without waker: ${a.body.hint}`);
          assert.match(String(a.body.hint || ""), /nicht gestartet.*is not running/, `without waker: ${a.body.hint}`);

          // b: stopped, the waker THROWS — the situation carries `error` with "Start gescheitert".
          setGitWakeup((id) => { woken.push(id); throw new Error("Restoration broken"); });
          const b = await create("Till waker throws");
          assert.equal(b.status, 201, JSON.stringify(b.body));
          assert.deepEqual(woken, [p.id], "the waker was not asked — the case measures nothing");
          assert.doesNotMatch(String(b.body.hint || ""), /wird geweckt/, `waker throws: ${b.body.hint}`);
          assert.match(String(b.body.hint || ""), /nicht gestartet.*Start gescheitert: Restoration broken/, `waker throws: ${b.body.hint}`);

          // c: PAUSED (a pause that cbase does not hold) — the situation is "frozen", the waker is never asked.
          docker("start", name);
          docker("pause", name);
          woken.length = 0;
          setGitWakeup((id) => { woken.push(id); });
          const c = await create("Till paused");
          assert.equal(c.status, 201, JSON.stringify(c.body));
          assert.equal(c.body.containerStands?.reason, "frozen", JSON.stringify(c.body));
          assert.deepEqual(woken, [], "a pause was woken");
          assert.doesNotMatch(String(c.body.hint || ""), /wird geweckt/, `pause: ${c.body.hint}`);
          assert.match(String(c.body.hint || ""), /eingefroren/, `pause: ${c.body.hint}`);
          docker("unpause", name);

          // d: stopped WITH a waker — only here "is being woken" (the way from (H)).
          docker("stop", name);
          const d = await create("Till woken");
          assert.equal(d.status, 201, JSON.stringify(d.body));
          assert.deepEqual(woken, [p.id]);
          assert.equal(d.body.containerStands?.reason, "stopped", JSON.stringify(d.body));
          assert.match(String(d.body.hint || ""), /wird geweckt/, `with waker: ${d.body.hint}`);
        } finally {
          setGitWakeup(null);
        }
      });
    });
  } finally {
    fd.cleanUp();
    fs.rmSync(o.location, { recursive: true, force: true });
  }
});

// ── (W1) a value from the body never becomes an option ─────────────────────────────────────
// `stash show -p <ref>`, `rebase <branch>`, `checkout <branch>` and `worktree add <path>` wrote the value into argv without `--`:
// `--output=<file>` wrote an arbitrary file, `--exec=<command>` ran a command (measured with git 2.50: on a branch ahead of its
// upstream it runs per commit), `--orphan=x` created a branch. Valid values go as before (anchor (A)).
// COUNTER-TEST: git.js without the refusal ⇒ red (the file stands, the marker stands, the branch switches).
test("(W1) stash show --output, rebase --exec, checkout --orphan, worktree add --lock — refused, nothing written, nothing executed; valid values as before", async () => {
  const o = gitLocation("cbase-w1-");
  try {
    await withEnvironment(o.env, async () => {
      const repo = path.join(o.location, "repo");
      createRepo(repo, o.env, { remote: path.join(o.location, "remote.git") });
      fs.writeFileSync(path.join(repo, "a.txt"), "two\n");
      realGit(repo, ["commit", "-qam", "second state"], o.env); // a commit ahead of the upstream: `--exec` runs there
      fs.writeFileSync(path.join(repo, "a.txt"), "in the stash\n");
      await gitModule.gitStashPush(repo, "", {});
      const option = /darf nicht mit „-“ beginnen/;

      const file = path.join(o.location, "written.txt");
      await assert.rejects(gitModule.gitStashShow(repo, "", `--output=${file}`), option);
      assert.equal(fs.existsSync(file), false, "stash show wrote an arbitrary file");
      const marker = path.join(o.location, "exec-ran");
      await assert.rejects(gitModule.gitRebase(repo, "", `--exec=touch ${marker}`), option);
      assert.equal(fs.existsSync(marker), false, "rebase ran a command from the body");
      await assert.rejects(gitModule.gitCheckout(repo, "", "--orphan=foreign"), option);
      assert.equal(realGit(repo, ["branch", "--show-current"], o.env).trim(), "main", "checkout switched to a new branch");
      await assert.rejects(gitModule.gitWorktreeAdd(repo, "", "--lock", "", {}), option);
      await assert.rejects(gitModule.gitWorktreeRemove(repo, "", "--force", {}), option);
      await assert.rejects(gitModule.gitStashOp(repo, "", "drop", "--quiet", {}), option);
      await assert.rejects(gitModule.gitMerge(repo, "", "--strategy=ours", {}), option);
      await assert.rejects(gitModule.gitStashShow(repo, "", "stash@{0}\n--output=x"), /Zeilenumbruch/);

      // Valid values: as before.
      assert.match((await gitModule.gitStashShow(repo, "", "stash@{0}")).diff, /\+in the stash/);
      assert.deepEqual(await gitModule.gitCheckout(repo, "", "main"), { ok: true });
      assert.equal(realGit(repo, ["stash", "list"], o.env).trim().split("\n").length, 1, "the stash stayed");
    });
  } finally {
    fs.rmSync(o.location, { recursive: true, force: true });
  }
});

// ── (W2) a status that cannot be read is not "clean" ──────────────────────────
// readRepoInfo swallowed every error of `git status` and reported `clean: true` with zero changes — with a broken index and at the
// cap of the output (85,000 untracked files) the view showed "clean". Now `clean: false`, `counts: null` and `statusError`.
// COUNTER-TEST: git.js without `statusError` ⇒ red (`clean: true`).
test("(W2) a broken index ⇒ clean false, counts null, statusError — never \"clean\"; a readable status as before", async () => {
  const o = gitLocation("cbase-w2-");
  try {
    await withEnvironment(o.env, async () => {
      const intact = path.join(o.location, "ws", "intact");
      const broken = path.join(o.location, "ws", "broken");
      createRepo(intact, o.env);
      createRepo(broken, o.env);
      fs.writeFileSync(path.join(broken, ".git", "index"), "not an index, just garbage\n");
      const tree = await readGitTree(path.join(o.location, "ws"));
      const r = Object.fromEntries(tree.repos.map((x) => [path.basename(x.root), x]));
      assert.equal(r.broken.clean, false, "an unreadable status said \"clean\"");
      assert.equal(r.broken.counts, null);
      assert.match(String(r.broken.statusError || ""), /Status nicht lesbar/);
      assert.equal(r.intact.clean, true);
      assert.deepEqual(r.intact.counts, { staged: 0, unstaged: 0, untracked: 0, total: 0 });
      assert.equal(r.intact.statusError, undefined);
    });
  } finally {
    fs.rmSync(o.location, { recursive: true, force: true });
  }
});
