// Guard: "git and worktrees of the copy" (project container stage 2). The same tool as projectbox-git-worktree.test.js: the fake
// docker (fake-docker.mjs) simulates `docker exec … -- git …` against REAL git in throwaway repos; the `git` on the PATH
// (projectbox-git-scenario.mjs gitLocation) logs every call with its place. New here: TWO containers, the main (`IN_CONTAINER=main`)
// and a copy `k1` (`IN_CONTAINER=copy`) — so the log says WHICH container a git call went to, and "in B" lacks the environment.
// (In the fake both see the same disk; whether a call went to the RIGHT container is recorded by the log — the physical
// separation of main and clone is not simulated, that is the limit of these guards.) This file imports no other test file.
//
// The promises, each with the way that breaks it:
//   (1) ASSIGNMENT (git-assignment.js). The copy's worktree root lies NEXT TO `worktrees/`: `<runtime>/copy-worktrees/<name>/`.
//       The list for `cbase-git` carries the line `<pid>/<name>\t<root>` for it (the key `cbase-project` resolves — `<pid>/copy-<name>`
//       would not be found), the main keeps its lines; a path under a copy's root belongs to THAT copy, one under `worktrees/` to the
//       main. If the copy's line does not exist (any more), the assignment THROWS — also for a leftover under `copy-worktrees/`,
//       whose shared git directory would otherwise be the original in B and thus the main. Held against the real wrapper
//       `server/backend/cbase-git` and the real resolution `resolve` up to the EXIT CODE: the real wrapper calls the real `cbase-project`
//       (API of this server, fake docker), git from a worktree of the copy runs in the copy container with `-w` in the worktree, exit 0.
//   (2) SUBAGENT (agent-runtime.js). `isolation:"worktree"` in a copy core: `git worktree add` via exec in the COPY container, under
//       `copy-worktrees/<name>/` (counter-test under `worktrees/` ⇒ the main's root, red); unchanged it falls at the end of the turn with
//       its branch (`worktree remove`, `worktree prune`, `branch -D` — all in the copy container), changed it stays. Not a single git call
//       in the main container and none in B: after the cleanup no `git worktree prune` runs in the main. The main's core in the same
//       setup works as before in the main under `worktrees/` and never touches the copy.
//   (3) POST-WORK PER IDENTIFIER (git-post-work.js). While the copy's container stands, the job goes into `<data>/git-post-work/
//       <pid>.copy-<name>.jsonl` (not the main's file, not the runtime folder); the main's post-work never reads it, the copy's runs in
//       the copy container — including the question about the repo INSIDE the container (`rev-parse --git-dir`, the clone is not in the
//       file system for B). The limit of a line is the worktree root of its instance: a copy's job under `worktrees/`, a main's under
//       `copy-worktrees/` and one under the root of ANOTHER copy are neither entered nor executed.
//   (4) COUNTER PER INSTANCE. An open teardown job in the copy holds the copy (`instanceIdle`) and the whole project, never the main;
//       one in the main holds the main, never the copy (see projectbox-git-worktree.test.js).
//   (5) CLOSING PATH. The deletion path of a chat's worktrees (`cleanUpWorktreesInRuntimeFolder`) cleans up the worktree in the main
//       as before and NEVER touches a copy's — neither git nor files, in no container: the copy's cleanup secures its work first and
//       then removes the place itself.
//   (6) REPOS OF A COPY (git.js). `projectRepos` for a copy is the snapshot's repo list — without git, without searching B's file
//       system (a repo that exists only in the main is not in it); without a source, when the source throws and for a path outside the
//       project it THROWS, never the main's list.
//   (7) MAIN SEAM, a chat in its copy (copy `k1` through the real setters up to `ready`, the chat moves in): a subagent with
//       `isolation:"worktree"` creates its worktree via the real MCP server and runs/agents.js in the copy container under
//       `copy-worktrees/k1/` and cleans it up there.
//   (8) GRAPH CHILD. A graph run with `worktree:true` in the background from a copy chat branches off the CLONE: the run folder
//       `graph-<id>` under `copy-worktrees/k1/`, the repos from the snapshot, every git in the copy container, the copy's identifier in
//       `worktree_info`; unchanged it goes back there at the end.
//   (9) GIT VIEW of a copy chat (devtools/code-route.js gitOptions with `?chat=`): the snapshot's repos, read in the copy container;
//       without `?chat` (and for a chat in the main) as before the main; while the copy stands, the view wakes THE COPY. The answer
//       names the copy (`instance: "copy-k1"`, also after an action like `/git/stage` and in the "starting" state), the main never
//       carries the field; the 409 of a locked copy carries `error` and `instance` — that is how the chat's git bar (web, iOS) shows
//       the copy and its lock.
//   (10) SETUP WAITS (stacks/queue.js). If the chat has an open graph worktree, its copy's setup waits until it is closed.
//   (11) Opposite direction of (10): a foreground start with worktree does not begin (409, "copy") while the chat's copy waits or is
//       being built — otherwise its worktree would lie in the main and the move-in would tie the chat to the copy in the middle of the
//       run; without worktree and in the background (child pin) the start remains.
//   (12) A foreground row with a worktree that does not stand yet (reserved) also holds the copy's setup (graphWorktreeOpenFor).
//   (13) If the copy request arrives DURING the start's repo check (await, git), the start checks once more directly before creating
//       the row — 409 "copy", no row. The window is held by a gate in the `git` on the PATH.
// The main's post-work after `thawOut` (stacks/freeze.js) is held by stacks-freeze.test.js; the copy's way through cbase-project
// (exit 128 in copy worktrees before the fix) is driven by (1) up to the exit code.
//
// No clock: we wait for process ends, for `openGitJobs()`, for gates and states (waitForTruthy without a deadline).
//
// COUNTER-TESTS (one place in the product code each, shown red). Paths under server/backend/electron/server/:
//   runs/agents.js              worktreeRoot without the identifier (`() => worktreeRoot(runLocation)`)               ⇒ (7) red
//   runs/agents.js              closing path also finds worktrees under copy-worktrees/ (places.find)                 ⇒ (5) red
//   providers/agent-runtime.js  rootFor does not pass the identifier on (worktreeRoot(null))                          ⇒ (2) (7) red
//   runs/git-post-work.js       postWorkFile: the same file for main and copy                                         ⇒ (3) red
//                               limitFor: always the main's root                                                      ⇒ (3) red
//                               jobError: always the main's limit                                                     ⇒ (3) red
//                               a copy's repo question not in the container (`const copy = false`)                    ⇒ (3) red
//                               keyOf: chain/counter only per project                                                 ⇒ (4) red
//                               openGitJobsOf: the project's counter instead of the instance's                        ⇒ (4) red
//   projectbox/idle.js          instanceIdle counts only the main's jobs                                              ⇒ (4) red
//   git.js                      projectRepos without the copy branch (search in B's file system)                      ⇒ (6) (7) (8) (9) red
//                               withStatus does not set err.instance (wake timer without a copy)                      ⇒ (9) red
//   devtools/routes.js          targetInstance ignores ?chat (always instanceForProject)                              ⇒ (9) red
//   devtools/code-route.js      gitStandsSituation wakes without an instance                                          ⇒ (9) red
//                               gitResponse does not name the copy (`copyTheRequest` always null)                     ⇒ (9) red
//   projectbox/git-assignment.js no copy roots in the list                                                            ⇒ (1) red
//                               collective root without a throw (a leftover under copy-worktrees/ falls to the main)  ⇒ (1) red
//                               a missing copy line falls back to the main                                            ⇒ (1) red
//                               key `<pid>/copy-<name>` (`resolve` does not find it)                                    ⇒ (1) red
//   stacks/queue.js             without the condition of the open graph worktree                                      ⇒ (10) red
//                               condition graphWorktreeOpenFor removed (only `active` left)                           ⇒ (12) red
//   workflows/graph-start.js    rejection at a waiting/built copy removed (`if (false && …)`)                         ⇒ (11) red
//                               worktree root without the chat's instance (main)                                      ⇒ (8) red
//                               the second check before createGraphStart removed                                      ⇒ (13) red
//   runs/runtime-location.js    worktreeRoot of a copy returns the main's root                                        ⇒ (1) (2) (3) (5) (7) (8) red
//   server.js                   wake timer without an instance or without setCopyRepoSource                           ⇒ instance-resolution.test.js red
//   server/backend/cbase-project  copy branch of ziel() again only `[project.path]`                                   ⇒ (1) red (exit 128)
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as store from "../electron/server/store.js";
import { DIRS, setDirs } from "../electron/server/app-state.js";
import { setGitWakeup } from "../electron/server/devtools/code-route.js";
import { projectRepos, setCopyRepoSource } from "../electron/server/git.js";
import { createAgentRuntime } from "../electron/server/providers/agent-runtime.js";
import { copyInstance } from "../electron/server/projectbox/creation.js";
import { dockerKind, dockerProgram } from "../electron/server/projectbox/docker.js";
import { gitInstanceForWorkspace, writeGitProjects } from "../electron/server/projectbox/git-assignment.js";
import { instanceIdle, projectIdle } from "../electron/server/projectbox/idle.js";
import { cleanUpWorktreesInRuntimeFolder } from "../electron/server/runs/agents.js";
import { deliverUserPrompt } from "../electron/server/runs/queue.js";
import { gitInProject, gitPostWork, postWorkFile, openGitJobs, openGitJobsOf, worktreeTeardown } from "../electron/server/runs/git-post-work.js";
import { instanceNameForChat, setInstanceSource } from "../electron/server/runs/instance.js";
import { locationFor, worktreeRoot as worktreeRootValue } from "../electron/server/runs/runtime-location.js";
import { openEscalations, setInProjectSeam } from "../electron/server/runtime/inProject.js";
import { SNAPSHOT_VERSION } from "../electron/server/stacks/code-snapshot.js";
import { copyLocation } from "../electron/server/stacks/location.js";
import { setCopyProcedure } from "../electron/server/stacks/queue.js";
import { copyRequests, setCopyState } from "../electron/server/stacks/state.js";
import { wakeStorageQueue } from "../electron/server/workflows/storage-queue.js";
import { readingsFinished } from "../electron/server/gitView/cache.js";
import { fakeClaude, json, withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import { fakeDocker } from "./fake-docker.mjs";
import { readJsonl } from "./jsonl.mjs";
import { realGit, gitLocation, readLog, createRepo } from "./projectbox-git-scenario.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");
const WRAPPER_GIT = path.join(REPO, "server", "backend", "cbase-git");
const WRAPPER_PROJECT = path.join(REPO, "server", "backend", "cbase-project");

// ── Helpers (built like projectbox-git-worktree.test.js — a test file imports no other) ──────────────────────────
async function withEnvironment(values, fn) {
  const saved = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(values)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
const ops = (fd) => ({ CBASE_CONTAINER: "1", CBASE_DIND: "1", CBASE_DOCKER_BIN: fd.bin, CBASE_IN_PROJECT_ESCALATION_MS: "200", GIT_TERMINAL_PROMPT: undefined });
const unitSeam = (location) => ({ kind: dockerKind, program: dockerProgram, processLocation: () => location, container: (i) => i.containerId });
const dockerDo = (fd, ...args) => execFileSync(fd.bin, args, { env: { ...process.env, ...fd.env }, encoding: "utf8" }).trim();
const IMAGE = "cbase-projectbox:test";
// A container that reports itself as `who` in the log of the git on the PATH (`IN_CONTAINER`).
const containerStart = (fd, o, name, who) => dockerDo(fd, "run", "-d", "--name", name, ...Object.entries({ ...o.containerEnv, IN_CONTAINER: who }).flatMap(([k, v]) => ["-e", `${k}=${v}`]), IMAGE);

const callsValue = (o) => readLog(o.log).filter((e) => !e.step);
const desc = (a) => `${a.where}: git ${a.argv.join(" ")}`;
// The calls that did NOT run in container `who` (B counts as "B") — empty means: everything ran there.
const outside = (o, who) => callsValue(o).filter((a) => a.where !== who).map(desc);
const has = (o, who, ...part) => callsValue(o).some((a) => a.where === who && part.every((t, i) => a.argv[i] === t));
const branches = (repo, env) => realGit(repo, ["branch", "--list", "--format=%(refname:short)"], env).split("\n").filter(Boolean);
// A child process WITHOUT blocking the event loop (this test's server runs in the same process) → { code, out, err }.
const run = (cmd, args, opts) => new Promise((resolve) => {
  const k = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  k.stdout.on("data", (d) => { out += d; });
  k.stderr.on("data", (d) => { err += d; });
  k.once("close", (code) => resolve({ code, out, err }));
});
const worktreeList = (repo, env) => realGit(repo, ["worktree", "list", "--porcelain"], env).split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9));

// The unit: fake docker, TWO running containers — the main and copy k1 of project p1 —, the seam, B environment, a
// data folder of its own (the project's runtime folder lies below it) and the instance source for p1 (main and copy).
async function unit(fn, { docker = {} } = {}) {
  const fd = await fakeDocker(docker);
  const o = gitLocation("cbase-kwt-");
  const short = path.basename(o.location).replace(/[^a-z0-9]/gi, "").toLowerCase();
  const names = { main: `cbase-p-${short}`, copy: `cbase-k-${short}-k1` };
  const savedDirs = DIRS;
  try {
    return await withEnvironment({ ...o.env, ...ops(fd) }, async () => {
      containerStart(fd, o, names.main, "main");
      containerStart(fd, o, names.copy, "copy");
      setInProjectSeam(unitSeam(path.join(o.location, "processes")));
      const data = path.join(o.location, "data");
      setDirs({ ...(savedDirs || {}), data, scratch: path.join(data, "scratch"), attachments: path.join(data, "attachments"), outputs: path.join(data, "outputs") });
      const main = { projectId: "p1", instance: "main", identifier: "p1/main", containerId: names.main };
      const copy = { projectId: "p1", instance: "copy-k1", identifier: "p1/copy-k1", containerId: names.copy };
      setInstanceSource((pid, instance) => (pid === "p1" ? (instance === "copy-k1" ? copy : main) : null));
      const r = await fn({ fd, o, names, main, copy });
      await openGitJobs();
      await waitForTruthy(() => openEscalations() === 0, "escalations done");
      return r;
    });
  } finally {
    setInstanceSource(null);
    setDirs(savedDirs);
    setInProjectSeam(null);
    fd.cleanUp();
    fs.rmSync(o.location, { recursive: true, force: true });
  }
}

// A core (providers/agent-runtime.js) with a fake dispatcher: `tun(spec)` runs in the subagent's turn.
function core({ cwd, instance = null, gitFor, worktreeRoot, tun = () => {} }) {
  const calls = [];
  const rt = createAgentRuntime({
    chatId: "chat-kwt", cwd, parentProvider: "third",
    agentDefs: () => [],
    hosts: () => [{ id: "third", label: "third", models: [{ id: "mini", label: "mini" }] }],
    resolveRef: () => ({ providerId: "third", connector: { id: "third" }, model: "mini", unknownProvider: false }),
    resolveSkills: () => ({ skills: [], missing: [], available: [] }),
    buildSpec: (o) => ({ ...o }),
    runChat: async ({ spec, onEvent, onSpawn }) => {
      calls.push(spec);
      onSpawn?.({ kill: () => {}, cbaseEndInput: () => {} });
      await tun(spec);
      onEvent({ type: "result", result: "finished", session_id: `s-${calls.length}` });
      return { code: 0, sessionId: `s-${calls.length}`, resultText: "finished", stderr: "" };
    },
    onEvent: () => {},
    worktreeRoot,
    instance,
    gitFor,
  });
  return { rt, calls };
}
const START = { run_in_background: false, prompt: "Subtask", model: "third::mini", isolation: "worktree" };
// How runs/agents.js determines the root per identifier, here via the project's location (the owner is the core's seam).
const rootPerIdentifier = (location) => (identifier) => worktreeRootValue(location, String(identifier).slice(String(identifier).indexOf("/") + 1));

// ── (1) Assignment ────────────────────────────────────────────────────────────────────────────────────────────────────
test("(1) Assignment: copy-worktrees/<name> belongs to the copy, worktrees/ to the main; the list for cbase-git and the real wrapper; a missing line throws", async () => {
  const fd = await fakeDocker();
  const o = gitLocation("cbase-kwt-assign-");
  try {
    await withAgentsServer(async (ctx) => {
      const list = path.join(o.location, "git-projects");
      await withEnvironment({ ...o.env, ...ops(fd), CBASE_GIT_PROJECTS: list }, async () => {
        const K = path.join(ctx.root, "workspace", "till");
        fs.mkdirSync(K, { recursive: true });
        const p = await ctx.projectWithoutInstance({ name: "Kasse", path: K });
        const pid = p.id;
        const location = locationFor({ projectId: pid, converted: true });
        store.createProjectInstance({ projectId: pid, state: "ready", convertedAt: Date.now(), containerId: "main-c" });
        store.createProjectInstance({ projectId: pid, instance: "copy-k1", state: "ready", convertedAt: Date.now(), containerId: "copy-c" });
        const wtK = worktreeRootValue(location, "copy-k1");
        assert.equal(wtK, path.join(location.root, "copy-worktrees", "k1"), "the copy's root lies NEXT TO worktrees/");
        for (const d of [path.join(wtK, "agent-a"), path.join(location.worktrees, "agent-b"), path.join(location.copyWorktrees, "k2", "agent-c"), path.join(K, "app")]) fs.mkdirSync(d, { recursive: true });
        const real = (x) => fs.realpathSync(x);

        // The source of the workspace level: by path.
        const per = gitInstanceForWorkspace();
        assert.ok(per, "with the operating mark and a converted project there is a source");
        const copyInst = per(path.join(wtK, "agent-a"));
        assert.deepEqual([copyInst?.projectId, copyInst?.instance], [pid, "copy-k1"], "under copy-worktrees/k1 ⇒ the copy");
        assert.equal(per(path.join(location.worktrees, "agent-b"))?.instance, "main", "under worktrees/ ⇒ the main");
        assert.equal(per(path.join(K, "app"))?.instance, "main", "in the project folder ⇒ the main (the original path stays the main in B)");
        assert.equal(per(path.join(location.copyWorktrees, "k1", "agent-a", "deep", "bottom"))?.instance, "copy-k1", "also deep below");
        // k2 has no line: a path below it is neither main nor B — the assignment throws.
        assert.throws(() => per(path.join(location.copyWorktrees, "k2", "agent-c")), /k2.*does not exist \(any more\)|cannot be resolved/);

        // The list for cbase-git: the copy's line carries the key `<pid>/<name>`, the main keeps its two.
        writeGitProjects();
        const rows = fs.readFileSync(list, "utf8").split("\n").filter(Boolean);
        assert.ok(rows.includes(`${pid}/k1\t${real(wtK)}`), rows.join("\n"));
        // The WHOLE runtime folder is the main's root (worktrees/ lies inside it); copy-worktrees is
        // a lock line, the root of the live copy below it is longer and wins.
        assert.ok(rows.includes(`${pid}\t${real(K)}`) && rows.includes(`${pid}\t${real(location.root)}`), "the main keeps the project folder and its runtime folder");
        assert.ok(rows.includes(`!locked\t${real(location.copyWorktrees)}`), "copy-worktrees is locked");
        assert.ok(!rows.some((z) => z.startsWith(`${pid}\t`) && z.includes("copy-worktrees")), "the copy's root never stands under the main's key");
        assert.ok(!rows.some((z) => z.includes(`${pid}/k2`)), "a copy without a line has no root in the list");

        // The real wrapper: from the copy's root ⇒ `cbase-project <pid>/k1 …`, from worktrees/ and the project folder ⇒ `<pid>`.
        const projectLog = path.join(o.location, "cbase-project.log");
        const projectBin = path.join(o.location, "cbase-project");
        fs.writeFileSync(projectBin, `#!/bin/sh\nprintf '%s|%s\\n' "$(pwd -P)" "$*" >> '${projectLog}'\n`, { mode: 0o755 });
        const wrapper = (cwd, args) => execFileSync("/bin/sh", [WRAPPER_GIT, ...args], { cwd, env: { ...process.env, CBASE_PROJECT_BIN: projectBin }, encoding: "utf8" });
        wrapper(path.join(wtK, "agent-a"), ["status", "--porcelain"]);
        wrapper(path.join(location.worktrees, "agent-b"), ["status", "--porcelain"]);
        wrapper(path.join(K, "app"), ["status", "--porcelain"]);
        assert.deepEqual(fs.readFileSync(projectLog, "utf8").trim().split("\n"), [
          `${real(path.join(wtK, "agent-a"))}|${pid}/k1 --git-access -- git status --porcelain`,
          `${real(path.join(location.worktrees, "agent-b"))}|${pid} --git-access -- git status --porcelain`,
          `${real(path.join(K, "app"))}|${pid} --git-access -- git status --porcelain`,
        ]);

        // And the key resolves in `cbase-project` — the form `<pid>/copy-k1` would not find the copy.
        const { resolve } = await import(pathToFileURL(WRAPPER_PROJECT).href);
        const projects = [{ id: pid, name: "Kasse", path: K, instance: { converted: true, state: "ready", container: `cbase-p-${pid}`, copies: [{ identifier: `${pid}/copy-k1`, name: "k1.till", state: "ready" }] } }];
        const key = rows.find((z) => z.endsWith(`\t${real(wtK)}`)).split("\t")[0];
        assert.equal(resolve({ projects, target: key, pwd: wtK }).copy?.short, "k1", "the list's key resolves a copy");
        assert.throws(() => resolve({ projects, target: `${pid}/copy-k1`, pwd: wtK }), /has no copy/, "the other form would not find it");

        // Up to the EXIT CODE — the real wrapper calls the REAL cbase-project (this server's API, the fake docker with the
        // copy's container). From a worktree of the copy git runs IN the copy container, `-w` in the worktree (the root of the
        // list under `<pid>/k1` — the runtime folder hangs at the same path in the copy), exit 0. Formerly the copy branch of
        // ziel() counted only the project folder as root: exit 128 "not in the project container", no docker call. Started async —
        // the server runs in THIS process and must be able to answer (a spawnSync would run into the fallback "backend not reachable").
        const kid = dockerDo(fd, "run", "-d", "--name", `cbase-k-${pid}-k1`, "--label", `cbase.project=${pid}`, "--label", "cbase.instance=copy-k1",
          ...Object.entries({ ...o.containerEnv, IN_CONTAINER: "copy" }).flatMap(([k, v]) => ["-e", `${k}=${v}`]), IMAGE);
        const agentA = real(path.join(wtK, "agent-a"));
        realGit(agentA, ["init", "-q", "-b", "main"], o.env);
        const realBin = path.join(o.location, "cbase-project-real");
        fs.writeFileSync(realBin, `#!/bin/sh\nexec '${process.execPath}' '${WRAPPER_PROJECT}' "$@"\n`, { mode: 0o755 });
        const from = fd.calls().length;
        const r = await run("/bin/sh", [WRAPPER_GIT, "status", "--porcelain"], { cwd: agentA, env: { ...process.env, CBASE_PROJECT_BIN: realBin, CBASE_PROJECT_API: ctx.base } });
        assert.equal(r.code, 0, `git from the copy's worktree ended with ${r.code}: ${r.err}`);
        assert.doesNotMatch(r.err, /nicht erreichbar/, "the way ran through the fallback without a backend, not through ziel()");
        const ex = fd.calls().slice(from).map((a) => a.args).filter((a) => a[0] === "exec");
        assert.equal(ex.length, 1, JSON.stringify(ex));
        // `-w` in the form of the root as it hangs in the container (the store form of the runtime folder, not the physical one — cbase-project inContainer).
        assert.deepEqual(ex[0].slice(0, 11), ["exec", "-i", "-u", "agent", "-w", path.join(wtK, "agent-a"), "-e", "TERM", kid, "git", "status"], "not in the copy container with -w in the worktree");
        assert.ok(callsValue(o).some((a) => a.where === "copy" && a.cwd === agentA && a.argv[0] === "status"), callsValue(o).map(desc).join("\n"));

        // The copy's line falls (cleanup): the already built source throws, a new one too; the main stays.
        store.deleteProjectInstance(pid, "copy-k1");
        assert.throws(() => per(path.join(wtK, "agent-a")), /cannot be resolved/, "the built source no longer finds the line");
        const fresh = gitInstanceForWorkspace();
        assert.throws(() => fresh(path.join(wtK, "agent-a")), /k1.*does not exist \(any more\)/, "a new source throws for the leftover under copy-worktrees/ — no main, no B");
        assert.equal(fresh(path.join(location.worktrees, "agent-b"))?.instance, "main");
        writeGitProjects();
        assert.ok(!fs.readFileSync(list, "utf8").includes(`${pid}/k1`), "the copy's line falls out of the list");
      });
    });
  } finally {
    fd.cleanUp();
    fs.rmSync(o.location, { recursive: true, force: true });
  }
});

// ── (2) Subagent ─────────────────────────────────────────────────────────────────────────────────────────────────────
test("(2) Subagent in the copy: worktree add in the copy container under copy-worktrees/<name>, never in the main and never in B; unchanged with prune only there, changed stays", async () => {
  await unit(async ({ o, main, copy }) => {
    const K = path.join(o.location, "proj", "till");
    createRepo(K, o.env);
    const location = locationFor({ projectId: "p1", converted: true });
    const insts = { "p1/main": main, "p1/copy-k1": copy };
    const asked = [];
    const gitFor = (k) => { asked.push(k); return insts[k] ? gitInProject(insts[k]) : null; };
    let change = false;
    const { rt, calls } = core({ cwd: K, instance: "p1/copy-k1", gitFor, worktreeRoot: rootPerIdentifier(location), tun: (spec) => { if (change) fs.writeFileSync(path.join(spec.cwd, "fresh.txt"), "arbeit\n"); } });
    const rootK = path.join(location.copyWorktrees, "k1");

    fs.writeFileSync(o.log, "");
    const a = await rt.start(START);
    const dirA = calls[0].cwd;
    assert.equal(path.dirname(dirA), rootK, `the worktree lies under copy-worktrees/k1, not under worktrees/: ${dirA}`);
    assert.match(path.basename(dirA), /^agent-/);
    assert.equal(a.worktree, "", "unchanged: not in the report");
    assert.equal(fs.existsSync(dirA), false, "unchanged: gone");
    assert.deepEqual(branches(K, o.env), ["main"], "unchanged: the branch falls with it");
    const add = callsValue(o).filter((x) => x.argv[0] === "worktree" && x.argv[1] === "add");
    assert.equal(add.length, 1, callsValue(o).map(desc).join("\n"));
    assert.equal(add[0].where, "copy", "worktree add did not run in the copy container");
    assert.ok(add[0].argv.includes(dirA), "and creates the folder under copy-worktrees/");
    for (const part of [["worktree", "remove"], ["worktree", "prune"], ["branch", "-D"]]) assert.ok(has(o, "copy", ...part), `${part.join(" ")} is missing in the copy container`);
    assert.deepEqual(outside(o, "copy"), [], "not a single git call in the main container or in B — no prune in the main either");
    assert.ok(asked.length > 0 && asked.every((k) => k === "p1/copy-k1"), `the core asks gitFor only with the copy's identifier: ${asked}`);

    change = true;
    const b = await rt.start(START);
    const dirB = calls[1].cwd;
    assert.equal(path.dirname(dirB), rootK);
    assert.equal(b.worktree, dirB, "changed: in the report");
    assert.ok(fs.existsSync(path.join(dirB, "fresh.txt")), "changed: stays");
    assert.ok(branches(K, o.env).some((z) => z.startsWith("cbase/agent-")), "changed: the branch stays");
    assert.deepEqual(outside(o, "copy"), []);
    await rt.close?.();

    // The main's core in the same setup: `worktrees/`, only in the main container, the copy stays untouched.
    const main2 = core({ cwd: K, instance: "p1/main", gitFor, worktreeRoot: rootPerIdentifier(location) });
    fs.writeFileSync(o.log, "");
    const c = await main2.rt.start(START);
    assert.equal(path.dirname(main2.calls[0].cwd), location.worktrees, "the main's core takes worktrees/");
    assert.equal(c.worktree, "");
    assert.ok(has(o, "main", "worktree", "add") && has(o, "main", "worktree", "prune"));
    assert.deepEqual(outside(o, "main"), [], "the main works only in the main container — nothing in the copy");
    await main2.rt.close?.();
  });
});

// ── (3) Post-work per identifier ────────────────────────────────────────────────────────────────────────────────────────
test("(3) Post-work per identifier: file and chain of the copy, the limit is its root, the container is asked about the repo; the main's never reads it", async () => {
  await unit(async ({ fd, o, names, main, copy }) => {
    const K = path.join(o.location, "proj", "till");
    createRepo(K, o.env);
    const location = locationFor({ projectId: "p1", converted: true });
    const wtK = worktreeRootValue(location, "copy-k1");
    const dirK = path.join(wtK, "agent-k1");
    realGit(K, ["worktree", "add", "-q", "-b", "cbase/agent-k1", dirK, "HEAD"], o.env);
    const job = (dir, branch) => ({ who: "Test", worktrees: [{ repo: K, dir, branch, deleteBranch: true }] });

    // 1. The copy stands: the job goes into THE COPY'S FILE, the worktree stays, no git anywhere.
    dockerDo(fd, "stop", names.copy);
    fs.writeFileSync(o.log, "");
    const r = await worktreeTeardown(copy, job(dirK, "cbase/agent-k1"));
    assert.equal(r.postWork, true, JSON.stringify(r));
    const file = postWorkFile("p1", "copy-k1");
    assert.equal(path.basename(file), "p1.copy-k1.jsonl");
    assert.equal(path.relative(location.root, file).split(path.sep)[0], "..", `NOT in the project's runtime folder: ${file}`);
    assert.equal(fs.existsSync(postWorkFile("p1")), false, "the main's file stays empty");
    assert.deepEqual(fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((z) => JSON.parse(z).worktrees[0].dir), [dirK]);
    assert.ok(fs.existsSync(dirK), "the worktree stays until the start");
    assert.deepEqual(callsValue(o).map(desc), [], "no git — neither in B nor in the main");

    // 2. The main's post-work never reads the copy's file (even when the main runs).
    const hn = await gitPostWork(main);
    assert.deepEqual({ read: hn.read, removed: hn.removed, dismissed: hn.dismissed, error: hn.error }, { read: 0, removed: 0, dismissed: 0, error: [] });
    assert.ok(fs.existsSync(file) && fs.existsSync(dirK), "the copy's line and its worktree still stand");
    assert.deepEqual(callsValue(o).map(desc), []);

    // 3. The copy runs again: its post-work removes it — in the copy container, including the question about the repo IN the container.
    dockerDo(fd, "start", names.copy);
    fs.writeFileSync(o.log, "");
    const kn = await gitPostWork(copy);
    assert.deepEqual({ read: kn.read, removed: kn.removed, changed: kn.changed, again: kn.again, dismissed: kn.dismissed, error: kn.error },
      { read: 1, removed: 1, changed: 0, again: 0, dismissed: 0, error: [] });
    assert.equal(fs.existsSync(dirK), false);
    assert.deepEqual(branches(K, o.env), ["main"], "with its branch");
    assert.equal(fs.existsSync(file) || fs.existsSync(`${file}.running`), false, "done is done");
    assert.deepEqual(outside(o, "copy"), [], "the copy's post-work ran only in the copy container");
    assert.ok(has(o, "copy", "rev-parse", "--git-dir"), "whether the repo is there is asked of the container (the clone is not in the file system for B)");
    for (const part of [["worktree", "remove"], ["worktree", "prune"], ["branch", "-D"]]) assert.ok(has(o, "copy", ...part), `${part.join(" ")} is missing`);

    // 4. The limit of a line is the root of ITS instance: none of it is entered (the main and the copy stand).
    dockerDo(fd, "stop", names.copy);
    dockerDo(fd, "stop", names.main);
    const dirH = path.join(location.worktrees, "agent-h1");
    const dirK2 = path.join(worktreeRootValue(location, "copy-k2"), "agent-x");
    const toForeign = async (inst, dir, who) => {
      const e = await worktreeTeardown(inst, job(dir, "cbase/x"));
      assert.equal(e.postWork, false, `${who}: ${JSON.stringify(e)}`);
      assert.ok(e.error.some((f) => f.includes("outside the instance's worktree root")), `${who}: ${e.error.join(" · ")}`);
      assert.equal(fs.existsSync(postWorkFile("p1", inst.instance)), false, `${who}: something entered`);
    };
    await toForeign(copy, dirH, "copy with a path under worktrees/");
    await toForeign(main, dirK, "main with a path under copy-worktrees/k1");
    await toForeign(copy, dirK2, "copy with a path under another copy's root");

    // 5. A foreign line in the copy's file is also discarded when executing (not only when entering).
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.mkdirSync(path.dirname(dirH), { recursive: true });
    fs.mkdirSync(dirH, { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(job(dirH, "cbase/agent-h1"))}\n`);
    dockerDo(fd, "start", names.copy);
    dockerDo(fd, "start", names.main);
    fs.writeFileSync(o.log, "");
    const foreign = await gitPostWork(copy);
    assert.deepEqual({ read: foreign.read, dismissed: foreign.dismissed, removed: foreign.removed }, { read: 1, dismissed: 1, removed: 0 }, JSON.stringify(foreign));
    assert.ok(fs.existsSync(dirH), "the folder under worktrees/ stayed");
    assert.deepEqual(callsValue(o).map(desc), [], "a discarded line starts no git");

    // 6. A name outside the form is no instance: the file does not exist.
    assert.throws(() => postWorkFile("p1", "copy-../x"), /no instance|worktree root/);
  });
});

// ── (4) Counter per instance ────────────────────────────────────────────────────────────────────────────────────────────
test("(4) An open teardown job in the copy holds the copy and the whole project, never the main", async () => {
  await unit(async ({ fd, o, copy }) => {
    fs.mkdirSync(DIRS.data, { recursive: true });
    store.initStore(DIRS.data);
    const K = path.join(o.location, "proj", "till");
    createRepo(K, o.env);
    const dir = path.join(worktreeRootValue(locationFor({ projectId: "p1", converted: true }), "copy-k1"), "agent-zz");
    realGit(K, ["worktree", "add", "-q", "-b", "cbase/agent-zz", dir, "HEAD"], o.env);
    assert.deepEqual(projectIdle("p1").open, [], "quiet before");
    const p = worktreeTeardown(copy, { who: "Test", worktrees: [{ repo: K, dir, branch: "cbase/agent-zz", deleteBranch: true }] });
    await fd.gateReached("git"); // the first git in the copy container stands at the gate
    assert.equal(openGitJobsOf("p1"), 0, "the main does not count the copy's job");
    assert.equal(openGitJobsOf("p1", "copy-k1"), 1);
    assert.equal(openGitJobsOf("p1", "copy-k2"), 0, "another copy does not either");
    assert.equal(openGitJobsOf("p1", null), 1, "the whole project does");
    assert.deepEqual(instanceIdle("p1/copy-k1").open.map((x) => x.reason), ["git"], "the copy is not quiet");
    assert.deepEqual(instanceIdle("p1/main").open.map((x) => x.reason), [], "the main is quiet");
    assert.deepEqual(instanceIdle("p1/copy-k2").open.map((x) => x.reason), []);
    assert.deepEqual(projectIdle("p1").open.map((x) => x.reason), ["git"], "the project as a whole waits for it");
    fd.openGate("git");
    const r = await p;
    assert.equal(r.removed, true, JSON.stringify(r));
    await openGitJobs();
    assert.equal(openGitJobsOf("p1", null), 0);
    assert.equal(projectIdle("p1").quiet, true, "quiet afterwards");
    assert.deepEqual(outside(o, "copy"), []);
  }, { docker: { execGate: "git" } });
});

// ── (5) Closing path ───────────────────────────────────────────────────────────────────────────────────────────────────
test("(5) The deletion path cleans up the worktree in the main and never touches a copy's", async () => {
  await unit(async ({ o }) => {
    const K = path.join(o.location, "proj", "till");
    createRepo(K, o.env);
    const location = locationFor({ projectId: "p1", converted: true });
    fs.mkdirSync(location.worktrees, { recursive: true });
    const dirH = path.join(location.worktrees, "agent-h1");
    const dirK = path.join(worktreeRootValue(location, "copy-k1"), "agent-k1");
    realGit(K, ["worktree", "add", "-q", "-b", "cbase/agent-h1", dirH, "HEAD"], o.env);
    realGit(K, ["worktree", "add", "-q", "-b", "cbase/agent-k1", dirK, "HEAD"], o.env);
    fs.writeFileSync(o.log, "");
    const warn = [];
    const immediately = cleanUpWorktreesInRuntimeFolder("chat-x", () => [{ dir: dirH, repo: K, agentId: "h1" }, { dir: dirK, repo: K, agentId: "k1" }], { warn: (w) => warn.push(w) });
    assert.deepEqual(immediately, []);
    await openGitJobs();
    assert.equal(fs.existsSync(dirH), false, "the worktree in the main is gone");
    assert.ok(fs.existsSync(dirK), "the copy's worktree still stands");
    assert.ok(worktreeList(K, o.env).some((w) => w.endsWith("agent-k1")), "and stays registered with git (no prune)");
    assert.ok(has(o, "main", "worktree", "remove"), "the one in the main went through the main container");
    assert.deepEqual(outside(o, "main"), [], "nothing in the copy container, nothing in B");
    assert.ok(!callsValue(o).some((a) => a.argv.some((x) => String(x).includes("copy-worktrees"))), "no call names the copy's worktree");
    assert.deepEqual(warn, []);

    // If only a copy's worktree is in the list, nothing happens at all.
    fs.writeFileSync(o.log, "");
    cleanUpWorktreesInRuntimeFolder("chat-y", () => [{ dir: dirK, repo: K, agentId: "k1" }], { warn: (w) => warn.push(w) });
    await openGitJobs();
    assert.ok(fs.existsSync(dirK));
    assert.deepEqual(callsValue(o).map(desc), [], "no git — neither in the main nor in the copy nor in B");
    assert.deepEqual(warn, []);
  });
});

// ── (6) The repos of a copy ────────────────────────────────────────────────────────────────────────────────────────
test("(6) projectRepos for a copy = the snapshot's repo list, without git and without searching B; without a source, when it throws and on an escape it throws", async () => {
  await unit(async ({ o, main, copy }) => {
    const P = path.join(o.location, "proj", "till");
    for (const r of ["app", "stock", "only-in-main"]) createRepo(path.join(P, r), o.env);
    try {
      setCopyRepoSource((inst) => {
        assert.equal(inst.instance, "copy-k1", "the source gets the copy's instance");
        return [{ rel: "stock", projectRepo: false }, { rel: "app", projectRepo: false }, { rel: ".", projectRepo: true }];
      });
      fs.writeFileSync(o.log, "");
      const k = await projectRepos(P, { instance: copy });
      assert.deepEqual(k.map((r) => [r.name, r.relPath, r.root]), [["app", "app", path.join(P, "app")], ["stock", "stock", path.join(P, "stock")]],
        "the snapshot's list, sorted as in the original; cbase keeps the project repo itself");
      assert.deepEqual(callsValue(o).map(desc), [], "no git, no search in B's file system");

      // For comparison the main: the same question finds what exists in the main — also `only-in-main`.
      const h = await projectRepos(P, { instance: main });
      assert.ok(h.map((r) => r.relPath).includes("only-in-main"), h.map((r) => r.relPath).join(","));

      // The project folder itself as a code repo (rel ".").
      setCopyRepoSource(() => [{ rel: ".", projectRepo: false }]);
      assert.deepEqual((await projectRepos(P, { instance: copy })).map((r) => [r.relPath, r.root]), [["", P]]);

      // No source, a throwing source, a path outside — never the main's list.
      setCopyRepoSource(null);
      await assert.rejects(projectRepos(P, { instance: copy }), /repos of copy p1\/copy-k1 cannot be read/);
      setCopyRepoSource(() => { throw new Error("snapshot not readable"); });
      await assert.rejects(projectRepos(P, { instance: copy }), /snapshot not readable/);
      setCopyRepoSource(() => [{ rel: "../outside", projectRepo: false }]);
      await assert.rejects(projectRepos(P, { instance: copy }), /outside the project/);
    } finally { setCopyRepoSource(null); }
  });
});

// ── The main seam: a chat in its copy (7)–(9) ──────────────────────────────────────────────────────────────────
// A project `till` with a running main `cbase-p-<pid>` and a copy `k1` with container `cbase-k-<pid>-k1`, built through the
// REAL setters (stacks/state.js copyRequests, setCopyState — the move-in hangs on them). The project folder holds two
// code repos, `app` and `stock`; the copy's snapshot knows only `app` (like a copy built before `stock`): so the copy's list and
// the main's can be told apart. The fake main agent calls cbase_agent with isolation:"worktree" on "SUBAGENT:<tag>" (result under
// res-<tag>.txt), cbase_workflow_start on "GS[<tag>]:{json}§" (gs-<tag>.jsonl), and holds at the gate on "HALT:<x>" in a
// workflow step. The subagent writes new.txt if its job contains "CHANGE".
const MAIN_CLAUDE = `
  const step = String(text).includes("[cbase workflow");
  fs.appendFileSync(path.join(LOCATION, "turns.jsonl"), JSON.stringify({ n: turn, text, step, cwd: process.cwd() }) + "\\n");
  const sm = /SUBAGENT:(\\w+)( CHANGE)?/.exec(text);
  if (sm && !step) {
    const input = { run_in_background: false, description: "Part", prompt: "Subtask " + sm[1] + (sm[2] || ""), isolation: "worktree" };
    say({ type: "assistant", message: { id: "m_wt" + turn, content: [{ type: "tool_use", id: "toolu_wt" + turn, name: "mcp__cbase__cbase_agent", input }] } });
    let t = "";
    try { const r = await mcpCall("cbase_agent", input); t = (r.result && r.result.isError ? "ERROR " : "") + textOf(r); }
    catch (e) { t = "ERROR " + (e && e.message ? e.message : String(e)); }
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_wt" + turn, content: t }] } });
    fs.writeFileSync(path.join(LOCATION, "res-" + sm[1] + ".txt"), t);
  }
  const g = text.indexOf("GS[");
  if (g >= 0 && !step) {
    const gtag = text.slice(g + 3, text.indexOf("]:", g));
    const args = JSON.parse(text.slice(text.indexOf("]:", g) + 2, text.indexOf("§", g)));
    const id = "toolu_gs_" + gtag;
    // Before a "hold…" start arm the repo gate — the next "git rev-parse --show-toplevel" (the start's repo check)
    // then waits until the test opens it.
    if (gtag.startsWith("hold")) { fs.mkdirSync(path.join(LOCATION, "repo-gate"), { recursive: true }); fs.writeFileSync(path.join(LOCATION, "repo-gate", "armed"), ""); }
    say({ type: "assistant", message: { id: "a-" + gtag + "-" + turn, content: [{ type: "tool_use", id, name: "mcp__cbase__cbase_workflow_start", input: args }] } });
    let t = "";
    try { const r = await mcpCall("cbase_workflow_start", args); t = (r.result && r.result.isError ? "ERROR " : "") + textOf(r); }
    catch (e) { t = "ERROR " + (e && e.message ? e.message : String(e)); }
    fs.appendFileSync(path.join(LOCATION, "gs-" + gtag + ".jsonl"), JSON.stringify({ t }) + "\\n");
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: t }] } });
  }
  const hold = (String(text).match(/HALT:(\\w+)/) || [])[1];
  if (hold && step) await gate(hold);
  finished();
  say({ type: "result", result: step ? "DONE" : "finished", session_id: "main-session" });`;
const SUB_CLAUDE = `
  fs.appendFileSync(path.join(LOCATION, "sub.jsonl"), JSON.stringify({ cwd: process.cwd(), text }) + "\\n");
  if (text.includes("CHANGE")) fs.writeFileSync(path.join(process.cwd(), "new.txt"), "from the subagent\\n");
  finished();
  say({ type: "result", result: "cwd=" + process.cwd(), session_id: "sub-session" });`;

// Lay down a copy's snapshot (what stacks/code-snapshot.js writes during setup, here only `repos`).
function writeSnapshot(pid, name, repos) {
  const location = copyLocation({ data: DIRS.data, projectId: pid, name });
  fs.mkdirSync(location.root.base, { recursive: true });
  fs.writeFileSync(location.root.snapshot, `${JSON.stringify({ version: SNAPSHOT_VERSION, projectId: pid, name, repos })}\n`, { mode: 0o600 });
}
// After every test: no copy is working any more (the server's quiet counts a working instance row as work).
function clearAwayCopies() {
  for (const k of store.liveStackCopies()) {
    try {
      if (["build", "ready", "clearAway"].includes(k.state)) setCopyState(k.id, "error", { error: "end of test" });
      store.deleteProjectInstance(k.projectId, copyInstance(k.name));
      setCopyState(k.id, "removed");
    } catch { /* already gone */ }
  }
}
// Setup of a test environment: fake docker, git log, server, environment; `fn(ctx, e)`; everything restored in the finally.
async function withCopyChat(fn, { claude = fakeClaude({ main: MAIN_CLAUDE, sub: SUB_CLAUDE }) } = {}) {
  const fd = await fakeDocker();
  const o = gitLocation("cbase-kwt-e2e-");
  try {
    await withAgentsServer(async (ctx) => {
      const env = { ...o.env, ...ops(fd), CLAUDE_CONFIG_DIR: path.join(fd.dir, "b-home", ".claude"), CODEX_HOME: path.join(fd.dir, "b-home", ".codex") };
      try {
        await withEnvironment(env, async () => {
          const projPath = path.join(ctx.root, "workspace", "till");
          fs.mkdirSync(projPath, { recursive: true });
          const p = await ctx.projectWithoutInstance({ name: "till", path: projPath });
          for (const r of ["app", "stock"]) createRepo(path.join(projPath, r), o.env);
          const main = `cbase-p-${p.id}`;
          const copy = `cbase-k-${p.id}-k1`;
          containerStart(fd, o, main, "main");
          store.createProjectInstance({ projectId: p.id, state: "ready", convertedAt: Date.now(), containerId: main });
          await json(`${ctx.base}/api/chats/${ctx.chat.id}`, { method: "PATCH", body: JSON.stringify({ projectId: p.id }) });
          // The copy up to just before `ready` (container already running, as after the start of the setup), the wake-call mark in advance.
          const k = copyRequests({ projectId: p.id, name: "k1", chatId: ctx.chat.id });
          setCopyState(k.id, "build", { phase: "clone1" });
          containerStart(fd, o, copy, "copy");
          store.writeStackCopyJournal(k.id, { data: { inset: { wakeCall: { state: "ready", at: 0 } } } });
          writeSnapshot(p.id, "k1", [{ part: "t1", rel: "app", projectRepo: false }]);
          setCopyState(k.id, "ready", { result: { branchSpace: "copy/k1/", hints: [] } });
          assert.equal(instanceNameForChat(ctx.chat.id, p.id), "copy-k1", "the chat has moved into the copy");
          await fn(ctx, { fd, o, p, pid: p.id, projPath, main, copy, k, location: locationFor({ projectId: p.id, converted: true }) });
        });
      } finally { clearAwayCopies(); }
    }, { claude });
  } finally {
    fd.cleanUp();
    fs.rmSync(o.location, { recursive: true, force: true });
  }
}
const send = (ctx, text, chatId = ctx.chat.id) => json(`${ctx.base}/api/chats/${chatId}/message`, { method: "POST", body: JSON.stringify({ text }) });
// Red instead of a hang: we wait for the file OR for the end of the runs — if the run ends without it, that is the finding.
async function resultFile(ctx, name) {
  const file = path.join(ctx.root, name);
  await waitForTruthy(async () => (fs.existsSync(file) || (await json(`${ctx.base}/api/runs/active`)).runs === 0 ? true : null), `${name} or end of run`);
  assert.ok(fs.existsSync(file), `the run ended without the fake CLI writing ${name} — its start failed`);
  return fs.readFileSync(file, "utf8");
}
const onlyCopyGit = (o, part) => callsValue(o).filter((a) => a.where !== "copy" && part(a)).map(desc);

// ── (7) A subagent in a copy's chat ─────────────────────────────────────────────────────────────────────────────
test("(7) Main seam: a subagent with isolation:worktree in a copy's chat creates its worktree in the copy container under copy-worktrees/k1 and cleans it up there", async () => {
  await withCopyChat(async (ctx, e) => {
    const root = path.join(e.location.copyWorktrees, "k1");
    const App = path.join(e.projPath, "app");
    // Unchanged: gone, with its branch; every worktree git in the copy container, none in the main and none in B.
    fs.writeFileSync(e.o.log, "");
    await send(ctx, "SUBAGENT:one");
    const t1 = await resultFile(ctx, "res-one.txt");
    assert.ok(!t1.startsWith("ERROR "), t1);
    await ctx.waitForQuiet();
    await openGitJobs();
    const [sub1] = readJsonl(path.join(ctx.root, "sub.jsonl"));
    assert.equal(path.dirname(sub1.cwd), fs.realpathSync(root), `the subagent works under copy-worktrees/k1: ${sub1.cwd}`);
    assert.equal(fs.existsSync(sub1.cwd), false, "unchanged: the worktree is gone");
    assert.deepEqual(branches(App, e.o.env), ["main"], "and its branch");
    const add = callsValue(e.o).filter((a) => a.argv[0] === "worktree" && a.argv[1] === "add");
    assert.equal(add.length, 1, callsValue(e.o).map(desc).join("\n"));
    assert.equal(add[0].where, "copy");
    assert.ok(add[0].argv.some((x) => x.startsWith(root)), add[0].argv.join(" "));
    for (const part of [["worktree", "remove"], ["worktree", "prune"], ["branch", "-D"]]) assert.ok(has(e.o, "copy", ...part), `${part.join(" ")} is missing in the copy container`);
    assert.deepEqual(onlyCopyGit(e.o, (a) => a.argv[0] === "worktree" || a.argv[0] === "branch"), [], "a worktree/branch call in the main container or in B");

    // Changed: stays, under copy-worktrees/k1, in the report.
    await send(ctx, "SUBAGENT:two CHANGE");
    const t2 = await resultFile(ctx, "res-two.txt");
    assert.ok(!t2.startsWith("ERROR "), t2);
    await ctx.waitForQuiet();
    await openGitJobs();
    const sub2 = readJsonl(path.join(ctx.root, "sub.jsonl")).find((s) => s.text.includes("CHANGE"));
    assert.equal(path.dirname(sub2.cwd), fs.realpathSync(root));
    assert.ok(fs.existsSync(path.join(sub2.cwd, "new.txt")), "changed: stays");
    assert.ok(t2.includes(sub2.cwd), `and stands in the report: ${t2.slice(0, 300)}`);
    assert.equal(fs.existsSync(path.join(e.location.worktrees, path.basename(sub2.cwd))), false, "nothing under worktrees/");
    assert.deepEqual(onlyCopyGit(e.o, (a) => a.argv[0] === "worktree" || a.argv[0] === "branch"), []);
  });
});

// The same for a gate of the fake CLI: at the gate OR end of run (a start that fails turns red instead of a hang).
async function atGate(ctx, name) {
  const marker = path.join(ctx.root, "gates", `${name}.waiting`);
  await waitForTruthy(async () => (fs.existsSync(marker) || (await json(`${ctx.base}/api/runs/active`)).runs === 0 ? true : null), `gate ${name} or end of run`);
  assert.ok(fs.existsSync(marker), `the run ended without the fake CLI reaching the gate "${name}" — its start failed`);
}
function newWorkflow(ws, projectId, name, text) {
  const now = Date.now();
  const w = store.createWorkflow({ id: crypto.randomUUID(), workspaceId: ws.id, projectId, name, createdAt: now, updatedAt: now, graph: {
    nodes: [{ id: "s", type: "start", title: "Start" }, { id: "n1", type: "instruction", title: "Step", text }, { id: "e", type: "end", title: "End" }],
    edges: [{ from: "s", to: "n1" }, { from: "n1", to: "e" }],
  } });
  return store.updateWorkflow(w.id, { run: { doneAll: false } });
}
// Trigger the start of a graph run (the fake main agent calls cbase_workflow_start) and read its result.
async function graphStart(ctx, w, tag, options, chat = ctx.chat) {
  const text = `Go GS[${tag}]:${JSON.stringify({ workflow: "background", input: "x", ...options })}§`;
  deliverUserPrompt(store.getChat(chat.id), { prompt: text, display: text, cause: "user",
    announcement: { id: `an-${tag}`, workflows: [{ workflowId: w.id, shortName: "background", name: w.name }], attachments: [] } });
  const file = path.join(ctx.root, `gs-${tag}.jsonl`);
  await waitForTruthy(async () => (readJsonl(file).length || (await json(`${ctx.base}/api/runs/active`)).runs === 0 ? true : null), "tool result of the start or end of run");
  const [outcome] = readJsonl(file);
  assert.ok(outcome, "the orchestrator does not call cbase_workflow_start — its start failed");
  assert.ok(!outcome.t.startsWith("ERROR "), outcome.t);
  return JSON.parse(outcome.t).start;
}

// ── (8) Graph child from a copy chat ──────────────────────────────────────────────────────────────────────────────
test("(8) A graph run with worktree:true from a copy chat branches off the clone: run folder under copy-worktrees/k1, the snapshot's repos, every git in the copy container", async () => {
  await withCopyChat(async (ctx, e) => {
    const w = newWorkflow(ctx.ws, e.pid, "Background", "BACKGROUND HALT:k");
    const App = path.join(e.projPath, "app");
    fs.writeFileSync(e.o.log, "");
    const start = await graphStart(ctx, w, "a", { background: true, worktree: true });
    await atGate(ctx, "k"); // the child chat's step is running — in the worktree
    const z = store.graphStart(start.startId);
    const identifier = `${e.pid}/${copyInstance("k1")}`;
    assert.equal(z.instance, identifier, "the child chat runs in its orchestrator's copy");
    const root = path.join(e.location.copyWorktrees, "k1");
    assert.equal(z.worktreePath, path.join(root, `graph-${z.id}`), `the run folder lies under copy-worktrees/k1: ${z.worktreePath}`);
    const info = JSON.parse(z.worktreeInfo);
    assert.equal(info.identifier, identifier, "the copy's identifier is in worktree_info");
    assert.deepEqual(info.repos.map((r) => [r.relPath, r.root, r.target]), [["app", App, path.join(z.worktreePath, "app")]], "the snapshot's repos — `stock` exists only in the main");
    assert.ok(fs.existsSync(path.join(z.worktreePath, "app", "a.txt")), "the worktree is checked out");
    const add = callsValue(e.o).filter((a) => a.argv[0] === "worktree" && a.argv[1] === "add");
    assert.equal(add.length, 1, callsValue(e.o).map(desc).join("\n"));
    assert.equal(add[0].where, "copy", "worktree add did not run in the copy container");
    assert.equal(fs.realpathSync(add[0].cwd), fs.realpathSync(App), "and branches off the repo `app`");
    const [step] = readJsonl(path.join(ctx.root, "turns.jsonl")).filter((t) => t.step);
    assert.equal(fs.realpathSync(step.cwd), fs.realpathSync(z.worktreePath), "the child chat's step runs in the copy's worktree");

    // The end: unchanged it goes back — in the copy container, with its branch.
    ctx.gate.open("k");
    await ctx.waitForQuiet();
    await waitForTruthy(() => (store.graphStart(z.id).worktreePath === "" ? true : null), "unchanged worktree cleaned up");
    await openGitJobs();
    assert.equal(fs.existsSync(z.worktreePath), false);
    assert.deepEqual(branches(App, e.o.env), ["main"], "its branch is gone");
    for (const part of [["worktree", "remove"], ["worktree", "prune"], ["branch", "-D"]]) assert.ok(has(e.o, "copy", ...part), `${part.join(" ")} is missing in the copy container`);
    assert.deepEqual(callsValue(e.o).filter((a) => a.where !== "copy").map(desc), [], "no git in the main container or in B");
    assert.ok(!callsValue(e.o).some((a) => a.cwd.startsWith(fs.realpathSync(path.join(e.projPath, "stock")))), "`stock` was never touched");
  });
});

// ── (9) The git view of a copy chat ────────────────────────────────────────────────────────────────────────────
test("(9) Git view with ?chat=: the snapshot's repos, read in the copy container; without ?chat and for a chat in the main the main; while the copy stands, it wakes THE COPY", async () => {
  await withCopyChat(async (ctx, e) => {
    // GET …/git triggers a reading in the background (gitView/small.js); its git calls would otherwise land in the log
    // of the NEXT check — wait for it before every clearing.
    const clear = async () => { await readingsFinished(); fs.writeFileSync(e.o.log, ""); };
    const load = async (query) => { await clear(); return json(`${ctx.base}/api/projects/${e.pid}/git${query}`); };
    const only = (who) => { const a = callsValue(e.o); assert.ok(a.length > 0, "no git call"); assert.deepEqual(a.filter((x) => x.where !== who).map(desc), [], `not everything in container "${who}"`); };

    const fromCopy = await load(`?chat=${ctx.chat.id}`);
    assert.deepEqual(fromCopy.repos.map((r) => r.relPath), ["app"], JSON.stringify(fromCopy).slice(0, 400));
    only("copy");
    // The tree of a copy NAMES it — the chat bar shows "Copy k1" from it, and the same answer tells it that this chat's
    // browser runs in the copy. Execution side = description side: the name comes from the instance in which git just ran,
    // not from a second question.
    assert.equal(fromCopy.instance, "copy-k1", "the copy's tree does not name it (`instance`)");
    const fromMain = await load("");
    assert.deepEqual(fromMain.repos.map((r) => r.relPath).sort(), ["app", "stock"], "without ?chat: the main's repos");
    only("main");
    assert.equal("instance" in fromMain, false, "the main stays unchanged: no field `instance`");
    // Another chat in the project, without a copy: the main.
    const other = await json(`${ctx.base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ctx.ws.id, projectId: e.pid, provider: "claude", model: "claude-haiku-4-5-20251001", permissionMode: "bypassPermissions" }) });
    const withoutCopy = await load(`?chat=${other.id}`);
    assert.deepEqual(withoutCopy.repos.map((r) => r.relPath).sort(), ["app", "stock"]);
    only("main");
    assert.equal("instance" in withoutCopy, false, "a chat in the main: no field `instance`");
    // An action of the bar (it answers with the fresh tree that goes to ALL readers) names the copy likewise.
    await clear();
    const afterAction = await json(`${ctx.base}/api/projects/${e.pid}/git/stage?chat=${ctx.chat.id}`, { method: "POST", body: JSON.stringify({ repo: "app", all: true }) });
    only("copy");
    assert.equal(afterAction.instance, "copy-k1", "the tree after an action does not name the copy");

    // While the copy stands: the view wakes the copy (second argument), never the main in its place.
    const woken = [];
    setGitWakeup((pid, instance) => { woken.push([pid, instance]); });
    try {
      dockerDo(e.fd, "stop", e.copy);
      const stands = await load(`?chat=${ctx.chat.id}`);
      assert.equal(stands.starts, true, JSON.stringify(stands));
      assert.equal(stands.instance, "copy-k1", "the \"starting\" state of a copy does not name it");
      assert.deepEqual(woken, [[e.pid, "copy-k1"]], "it was not the copy that was woken");
      // The same for a single git action (git.js withStatus carries the copy in the error): 409 "starting", the copy is woken.
      woken.length = 0;
      const res = await fetch(`${ctx.base}/api/projects/${e.pid}/git/log?chat=${ctx.chat.id}`, { method: "POST", headers: { "Content-Type": "application/json", Connection: "close" }, body: JSON.stringify({ repo: "app" }) });
      const action = await res.json();
      assert.equal(res.status, 409, JSON.stringify(action));
      assert.equal(action.starts, true, JSON.stringify(action));
      assert.deepEqual(woken, [[e.pid, "copy-k1"]], "the git action did not wake the copy");
      dockerDo(e.fd, "start", e.copy);
      dockerDo(e.fd, "stop", e.main);
      woken.length = 0;
      const mainStands = await load("");
      assert.equal(mainStands.starts, true, JSON.stringify(mainStands));
      assert.deepEqual(woken, [[e.pid, undefined]], "the main wakes as before with the project id alone");
      dockerDo(e.fd, "start", e.main);
    } finally { setGitWakeup(null); }

    // The copy's line is gone, the chat is still bound to it — the view names the error, it never shows the main's repos.
    store.deleteProjectInstance(e.pid, copyInstance("k1"));
    // The route (devtools/routes.js targetInstance) answers 409 before any git route does anything: never the main's repos.
    await clear();
    const res = await fetch(`${ctx.base}/api/projects/${e.pid}/git?chat=${ctx.chat.id}`, { headers: { Connection: "close" } });
    const way = await res.json();
    assert.equal(res.status, 409, JSON.stringify(way).slice(0, 400));
    assert.equal(way.repos, undefined, "no repos of the main");
    assert.match(String(way.error || ""), /Kopie/, JSON.stringify(way).slice(0, 400));
    // The bar's git view shows `error` (like the throw of gitOptions in code-route.js), and the locked copy names itself —
    // the bar says "Copy k1" with the error, never "no repository".
    assert.ok(String(way.error || "").length > 0, "the 409 of a locked copy does not carry `error`");
    assert.equal(way.instance, "copy-k1", "the 409 of a locked copy does not name it");
    assert.deepEqual(callsValue(e.o), [], "no git — neither in the main nor in B");
  });
});

// ── (10) A copy's setup waits for the chat's open graph worktree ─────────────────────────────────────
test("(10) If the chat has an open graph worktree, its copy's setup waits until it is closed", async () => {
  const o = gitLocation("cbase-kwt-queue-");
  const runs = [];
  let copyId = null;
  try {
    await withEnvironment({ ...o.env, CBASE_GRAPH_TICK_MS: String(24 * 3_600_000) }, () => withAgentsServer(async (ctx) => {
      // A controllable procedure: holds until the test ends it (like stacks-queue.test.js, only what is needed here).
      setCopyProcedure((a) => new Promise((resolve) => {
        runs.push(a);
        a.end = () => { store.deleteProjectInstance(a.copy.projectId, a.instance); setCopyState(a.copy.id, "error", { error: "probe: setup failed" }); resolve(); };
      }));
      try {
        const projPath = path.join(ctx.root, "workspace", "till");
        fs.mkdirSync(projPath, { recursive: true });
        const project = await json(`${ctx.base}/api/workspaces/${ctx.ws.id}/projects`, { method: "POST", body: JSON.stringify({ name: "till", path: projPath }) });
        createRepo(projPath, o.env);
        await json(`${ctx.base}/api/chats/${ctx.chat.id}`, { method: "PATCH", body: JSON.stringify({ projectId: project.id }) });
        const w = newWorkflow(ctx.ws, project.id, "Background", "FRONT HALT:v");
        // A foreground graph run with its own worktree: the chat drives it itself, the worktree is open.
        const start = await graphStart(ctx, w, "v", { worktree: true });
        // In the foreground the run begins only AFTER the orchestrator's turn (creating the worktree, redeeming): red instead of a
        // hang here is the discarded row, not the end of the run.
        const marker = path.join(ctx.root, "gates", "v.waiting");
        await waitForTruthy(() => (fs.existsSync(marker) || store.graphStart(start.startId).status === "dismissed" ? true : null), "gate v or the discarded row");
        assert.ok(fs.existsSync(marker), `the run did not start: ${store.graphStart(start.startId).reason}`);
        const z = store.graphStart(start.startId);
        assert.equal(z.status, "started");
        assert.ok(z.worktreePath && fs.existsSync(z.worktreePath), "the run's worktree stands");
        assert.equal(store.graphWorktreeFor(ctx.chat.id)?.active, true);

        const k = copyRequests({ projectId: project.id, name: "k1", chatId: ctx.chat.id });
        copyId = k.id;
        wakeStorageQueue();
        const waiting = store.stackCopy(k.id);
        assert.equal(waiting.state, "waiting_queue", JSON.stringify(waiting));
        assert.match(waiting.reason, /wartet auf den Graph-Lauf dieses Chats/);
        assert.equal(runs.length, 0, "the setup began although the chat's worktree is open");

        // The run ends, the worktree goes back: the setup begins.
        ctx.gate.open("v");
        await waitForTruthy(() => (store.graphStart(z.id).worktreePath === "" ? true : null), "unchanged worktree cleaned up");
        await waitForTruthy(() => { wakeStorageQueue(); return store.stackCopy(k.id).state === "build" ? true : null; }, "the copy begins after the graph run");
        assert.equal(runs.length, 1);
        assert.equal(store.graphWorktreeFor(ctx.chat.id), null);
      } finally {
        ctx.gate.open("v");
        for (const a of runs) { try { a.end(); } catch { /* already ended */ } }
        setCopyProcedure(null);
        if (copyId) { try { setCopyState(copyId, "removed"); } catch { /* already gone */ } }
      }
    }, { claude: fakeClaude({ main: MAIN_CLAUDE, sub: SUB_CLAUDE }) }));
  } finally { fs.rmSync(o.location, { recursive: true, force: true }); }
});

// ── (11) The opposite direction — a foreground run with a worktree does not begin while the chat's copy is being built ──
// The worktree of a foreground run without a pin would lie in the main (graph-start.js: the chat is still bound to the
// main), but the move-in (`build` → `ready`) would tie the chat to the copy in the middle of the run: a run across two
// instances. So the start rejects (409, word "Kopie") while its copy waits or is being built; without worktree the start goes
// as always. And (12): a row with a worktree that does not stand yet (reserved, waiting) holds the copy's setup just as
// the open worktree does — otherwise it would arise in the main while the copy begins.
async function graphAttempt(ctx, w, tag, options) {
  const text = `Go GS[${tag}]:${JSON.stringify({ workflow: "background", input: "x", ...options })}§`;
  deliverUserPrompt(store.getChat(ctx.chat.id), { prompt: text, display: text, cause: "user",
    announcement: { id: `an-${tag}`, workflows: [{ workflowId: w.id, shortName: "background", name: w.name }], attachments: [] } });
  const file = path.join(ctx.root, `gs-${tag}.jsonl`);
  await waitForTruthy(async () => (readJsonl(file).length || (await json(`${ctx.base}/api/runs/active`)).runs === 0 ? true : null), "tool result of the start or end of run");
  const [outcome] = readJsonl(file);
  assert.ok(outcome, "the orchestrator does not call cbase_workflow_start — its start failed");
  return outcome.t;
}

test("(11) While the chat's copy is in build, a foreground start with worktree is rejected (409, copy) and creates nothing; without worktree it starts", async () => {
  const o = gitLocation("cbase-kwt-gl2d0-");
  const runs = [];
  let copyId = null;
  try {
    await withEnvironment({ ...o.env, CBASE_GRAPH_TICK_MS: String(24 * 3_600_000) }, () => withAgentsServer(async (ctx) => {
      setCopyProcedure((a) => new Promise((resolve) => {
        runs.push(a);
        a.end = () => { store.deleteProjectInstance(a.copy.projectId, a.instance); setCopyState(a.copy.id, "error", { error: "probe: setup failed" }); resolve(); };
      }));
      try {
        const projPath = path.join(ctx.root, "workspace", "till");
        fs.mkdirSync(projPath, { recursive: true });
        const project = await json(`${ctx.base}/api/workspaces/${ctx.ws.id}/projects`, { method: "POST", body: JSON.stringify({ name: "till", path: projPath }) });
        createRepo(projPath, o.env);
        await json(`${ctx.base}/api/chats/${ctx.chat.id}`, { method: "PATCH", body: JSON.stringify({ projectId: project.id }) });
        const w = newWorkflow(ctx.ws, project.id, "Background", "FRONT HALT:v");
        const k = copyRequests({ projectId: project.id, name: "k1", chatId: ctx.chat.id });
        copyId = k.id;
        wakeStorageQueue();
        assert.equal(store.stackCopy(k.id).state, "build", JSON.stringify(store.stackCopy(k.id)));
        assert.equal(runs.length, 1);

        const t = await graphAttempt(ctx, w, "a", { worktree: true });
        assert.ok(t.startsWith("ERROR "), `the start with a worktree was accepted: ${t.slice(0, 300)}`);
        assert.match(t, /Kopie/, t.slice(0, 300));
        assert.deepEqual(store.graphStartsOf(ctx.chat.id).filter((z) => z.worktree), [], "a row with a worktree arose despite the rejection");

        // Without worktree the start is untouched (this concerns only the worktree in the main).
        const t2 = await graphAttempt(ctx, w, "b", {});
        assert.ok(!t2.startsWith("ERROR "), t2.slice(0, 300));
      } finally {
        ctx.gate.open("v");
        for (const a of runs) { try { a.end(); } catch { /* already ended */ } }
        setCopyProcedure(null);
        if (copyId) { try { setCopyState(copyId, "removed"); } catch { /* already gone */ } }
      }
    }, { claude: fakeClaude({ main: MAIN_CLAUDE, sub: SUB_CLAUDE }) }));
  } finally { fs.rmSync(o.location, { recursive: true, force: true }); }
});

test("(12) A foreground row with a worktree that does not stand yet (reserved) holds the chat's copy setup like an open worktree", async () => {
  const o = gitLocation("cbase-kwt-gl2d0r-");
  const runs = [];
  let copyId = null;
  try {
    await withEnvironment({ ...o.env, CBASE_GRAPH_TICK_MS: String(24 * 3_600_000) }, () => withAgentsServer(async (ctx) => {
      setCopyProcedure((a) => new Promise((resolve) => {
        runs.push(a);
        a.end = () => { store.deleteProjectInstance(a.copy.projectId, a.instance); setCopyState(a.copy.id, "error", { error: "probe: setup failed" }); resolve(); };
      }));
      try {
        const projPath = path.join(ctx.root, "workspace", "till");
        fs.mkdirSync(projPath, { recursive: true });
        const project = await json(`${ctx.base}/api/workspaces/${ctx.ws.id}/projects`, { method: "POST", body: JSON.stringify({ name: "till", path: projPath }) });
        await json(`${ctx.base}/api/chats/${ctx.chat.id}`, { method: "PATCH", body: JSON.stringify({ projectId: project.id }) });
        const w = newWorkflow(ctx.ws, project.id, "Background", "FRONT HALT:v");
        const row = store.createGraphStart({ id: `gs-${crypto.randomUUID()}`, chatId: ctx.chat.id, workflowId: w.id, workflowName: w.name, shortName: "background",
          input: "x", attachments: [], background: false, worktree: true, announcementId: "ann-z", callId: "", status: "earmarked" });
        assert.equal(store.graphWorktreeFor(ctx.chat.id), null, "precondition: its worktree does not stand yet");
        const k = copyRequests({ projectId: project.id, name: "k1", chatId: ctx.chat.id });
        copyId = k.id;
        wakeStorageQueue();
        const waiting = store.stackCopy(k.id);
        assert.equal(waiting.state, "waiting_queue", JSON.stringify(waiting));
        assert.match(waiting.reason, /wartet auf den Graph-Lauf dieses Chats/);
        assert.equal(runs.length, 0, "the setup began although the chat's worktree is about to arise");
        // The row falls (discarded): the setup begins.
        store.changeGraphStart(row.id, { status: "dismissed", reason: "probe" });
        await waitForTruthy(() => { wakeStorageQueue(); return store.stackCopy(k.id).state === "build" ? true : null; }, "the copy begins after the row");
        assert.equal(runs.length, 1);
      } finally {
        for (const a of runs) { try { a.end(); } catch { /* already ended */ } }
        setCopyProcedure(null);
        if (copyId) { try { setCopyState(copyId, "removed"); } catch { /* already gone */ } }
      }
    }, { claude: fakeClaude({ main: MAIN_CLAUDE, sub: SUB_CLAUDE }) }));
  } finally { fs.rmSync(o.location, { recursive: true, force: true }); }
});

// ── (13) The copy request in the window of the repo check ─────────────────────────────────────
// The chat's copy used to be checked BEFORE the await of the repo check (graphWorktreeRepos — git) and the row was created
// afterwards without a second check. A copy request exactly in this window (a subagent of the same chat may call cbase_copy_stack)
// found no row yet (stacks/queue.js: graphWorktreeOpenFor) and began the setup — afterwards the foreground row with a worktree
// arose anyway: the run across two instances that (11) forbids. The window is held by a GATE in the `git` on the PATH: the fake
// CLI arms it before the start (tag "hold…"), the next `git rev-parse --show-toplevel` (the repo check) reports and
// waits until the test opens it — no duration. Expected: the check directly before creating sees the copy in `build` ⇒ 409
// with "Kopie", no row with a worktree.
test("(13) A copy request DURING the repo check of a foreground start with worktree — the copy is checked once more directly before creating (409, copy), no row", async () => {
  const o = gitLocation("cbase-kwt-toctou-");
  const gateBin = path.join(o.location, "gate-bin");
  fs.mkdirSync(gateBin);
  const runs = [];
  let copyId = null;
  let gate = null;
  try {
    await withEnvironment({ ...o.env, PATH: `${gateBin}${path.delimiter}${o.env.PATH}`, CBASE_GRAPH_TICK_MS: String(24 * 3_600_000) }, () => withAgentsServer(async (ctx) => {
      setCopyProcedure((a) => new Promise((resolve) => {
        runs.push(a);
        a.end = () => { store.deleteProjectInstance(a.copy.projectId, a.instance); setCopyState(a.copy.id, "error", { error: "probe: setup failed" }); resolve(); };
      }));
      gate = path.join(ctx.root, "repo-gate");
      fs.mkdirSync(gate, { recursive: true });
      // The gate: only ONE call takes the arming (mv is atomic), reports and waits for `open`; all others pass through.
      fs.writeFileSync(path.join(gateBin, "git"), `#!/bin/sh
if [ "$1" = rev-parse ] && [ "$2" = --show-toplevel ] && mv '${gate}/armed' '${gate}/taken' 2>/dev/null; then
  : > '${gate}/waiting'
  while [ ! -e '${gate}/open' ]; do sleep 0.02; done
fi
exec '${path.join(o.bin, "git")}' "$@"
`, { mode: 0o755 });
      try {
        const projPath = path.join(ctx.root, "workspace", "till");
        fs.mkdirSync(projPath, { recursive: true });
        const project = await json(`${ctx.base}/api/workspaces/${ctx.ws.id}/projects`, { method: "POST", body: JSON.stringify({ name: "till", path: projPath }) });
        createRepo(projPath, o.env);
        await json(`${ctx.base}/api/chats/${ctx.chat.id}`, { method: "PATCH", body: JSON.stringify({ projectId: project.id }) });
        const w = newWorkflow(ctx.ws, project.id, "Background", "FRONT HALT:v");
        assert.deepEqual(store.liveStackCopiesOfChat(ctx.chat.id), [], "precondition: the chat has no copy");

        const text = `Go GS[hold-a]:${JSON.stringify({ workflow: "background", input: "x", worktree: true })}§`;
        deliverUserPrompt(store.getChat(ctx.chat.id), { prompt: text, display: text, cause: "user",
          announcement: { id: "ann-hold-a", workflows: [{ workflowId: w.id, shortName: "background", name: w.name }], attachments: [] } });
        const file = path.join(ctx.root, "gs-hold-a.jsonl");
        await waitForTruthy(async () => (fs.existsSync(path.join(gate, "waiting")) || readJsonl(file).length || (await json(`${ctx.base}/api/runs/active`)).runs === 0 ? true : null),
          "the repo check at the gate, the tool result or the end of the run");
        assert.ok(fs.existsSync(path.join(gate, "waiting")), `the repo check never reached the gate: ${JSON.stringify(readJsonl(file))}`);

        // In the window: the chat's copy is requested and begins (no row yet that could hold it).
        const k = copyRequests({ projectId: project.id, name: "k1", chatId: ctx.chat.id });
        copyId = k.id;
        wakeStorageQueue();
        assert.equal(store.stackCopy(k.id).state, "build", `precondition: the copy begins in the window — ${JSON.stringify(store.stackCopy(k.id))}`);
        assert.equal(runs.length, 1);

        fs.writeFileSync(path.join(gate, "open"), "");
        await waitForTruthy(async () => (readJsonl(file).length || (await json(`${ctx.base}/api/runs/active`)).runs === 0 ? true : null), "tool result of the start or end of run");
        const [outcome] = readJsonl(file);
        assert.ok(outcome, "the orchestrator does not call cbase_workflow_start — its start failed");
        assert.ok(outcome.t.startsWith("ERROR "), `the start with a worktree was accepted although the copy is being built meanwhile: ${outcome.t.slice(0, 300)}`);
        assert.match(outcome.t, /Kopie/, outcome.t.slice(0, 300));
        assert.deepEqual(store.graphStartsOf(ctx.chat.id).filter((z) => z.worktree), [], "a row with a worktree arose next to the copy's setup");
      } finally {
        if (gate) fs.writeFileSync(path.join(gate, "open"), "");
        ctx.gate.open("v");
        for (const a of runs) { try { a.end(); } catch { /* already ended */ } }
        setCopyProcedure(null);
        if (copyId) { try { setCopyState(copyId, "removed"); } catch { /* already gone */ } }
      }
    }, { claude: fakeClaude({ main: MAIN_CLAUDE, sub: SUB_CLAUDE }) }));
  } finally {
    // On the red path (the row arose) the run still creates its worktree, and the logging git writes into that folder
    // while it falls (ENOTEMPTY) — the cleanup must not mask the verdict.
    try { fs.rmSync(o.location, { recursive: true, force: true }); } catch (e) { console.error(`[copy-worktrees (13)] ${o.location} stays: ${e?.message || e}`); }
  }
});
