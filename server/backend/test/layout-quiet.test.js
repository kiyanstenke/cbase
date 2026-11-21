// Job and quiet of a layout — `projectbox/layout/{job,proc-program}.js`, the lock reason "layout" (projectbox/idle.js earmarkProject,
// verdictTheLock), `parentSince` at the start paths, the table `project_layout`.
//
// The look-again tick is set to one hour in ALL server tests (CBASE_LAYOUT_CHECK_BACK_MS): every progress comes from an event (turn
// end, stop, upload message, terminal end) or an explicit checkBackLayout — no tick hides a missing observer. The execution is a
// recorder at `setLayoutExecution`.
//
// WHAT HOLDS HERE, each with its counter-test (CT) or built-in sabotage (S):
//   (P)  The container program of the /proc search: `foreground` reports a session whose tpgid is not the shell's group (CT: tpgid ==
//        group => not foreground; without a terminal -1 => not); `processes` finds cwd/fd under a path, never `old-2` (whole path
//        parts), never a process of a foreign mount namespace, never an exempt group, and carries the ancestor chain. The program text
//        runs as `node -e` with stdin and gives the same answer as the core (S: an unknown mode => ok:false). Also: a search path that
//        is a LINK never searches under its target (CT: the target itself as a search path hits the process), with `roots` not even
//        without a root boundary, and a search path outside the roots is dropped; "..old" lies under the root (by path parts); the
//        editor locations hit the VS Code server by its program (exe), never another node. Also the park state of a dynamic workflow:
//        an agent() at the project lock counts as waiting (CT: woken => 0).
//   (U)  Take over: without `check` 400, other steps 409 CHECK_STALE, rule errors 400 RULES, no change 400 NO_CHANGE — no refusal
//        creates a job. Then a job: 409 JOB_OPEN for a second take-over AND for `check`; the plan carries the final mapping and the
//        affected paths, `confirmed` the check.
//   (R)  The quiet with a running turn (at the gate): the job waits, the turn stands as holder; a turn of a second chat waits in the
//        queue and does NOT count (CT: projectIdle — the old quiet — counts it as "queue"). The start paths in `waiting`: turn
//        waits, subagent/workflow agent/graph step with `parentSince < since` pass (CT: without parentSince and with parentSince >=
//        since they wait), oneshot with instance waits, oneshot in B runs, copy 409 REBUILD_OPEN, upload 409 LAYOUT_WAITING. The turn
//        ends => the turn observer checks, the job goes to `running` with the boot id and to the execution (exactly once). From
//        `running`: the subagent with an old parentSince WAITS, upload 409 LAYOUT_RUNNING, withdrawing 409, deleting 409 OCCUPIED.
//        `error` before the turnaround: withdrawing works, the lock falls, the waiting turn of the second chat runs (CT: before, it
//        did not run).
//   (S)  Stopping: an open upload procedure holds; "stop" discards it (DELETE way) and the job starts. Unknown holder 404; after
//        starting 409 NOT_WAITING. A turn holder: "stop" ends the turn (its process is gone), the job starts.
//   (T)  Terminals: a workspace terminal (PTY in B) whose foreground group works under an affected path holds (through a fake /proc);
//        CT: foreground = shell => does not hold. A terminal in the project container: the program runs through `docker exec` (log of
//        the fake docker) and reports the command in the foreground; CT: without a command it does not hold.
//   (W)  In B (./processes-in-b.js): a process under an affected path that descends from the CLI process of a chat holds as its turn
//        (stoppable). If the turn ends and the process stays (a subagent, the bash of the loop engine, a background server — none
//        descends from the main CLI), it holds as `process` (not stoppable, 409 NOT_STOPPABLE); CT: it used to not hold then, and the
//        folder moved away from under it. Only when it is gone does the job go to the execution.
//   (D)  A dynamic workflow holds only if it computes (dynWorkflowSituation `computes`); CT: if it only waits, it is a hint.
//   (N)  Post-start: after the loss of memory (new process) there is NO lock (CT) — the hook sets it anew; `waiting` does not hold
//        `busy`; `running` before the turnaround gets `backward` and locks like `running`; `error` before the turnaround does not
//        lock. The reader (status.js) says `waiting`/`running`/`error`/null; CT: without a registered reader null.
//   (L)  Deleting: with held work 409 — the waiting job STAYS (same `since`), the earmark is back, nothing was woken (CT: it used to be
//        gone after the refusal, and the held turn started); without it 200, job and project gone, the earmark released. CT for the
//        connection (setLayoutRevert): without it the memory of the job stays.
//   (B1) Re-creating beside a waiting earmark: a start sees `error` of the instance (CT: "layout waits"), the re-creation gets past the
//        earmark and its queue (CT: "already locked (layout)"), then `ready`, and the job goes on as soon as its holder is gone.
//   (B3) A graph worktree asks the lock: the row waits (`waiting_lock`) in `waiting` and `running` (CT: it was created past it); a
//        running creation is open work and a holder (CT: none).
//   (B4) The beginning of the work of a core: a graph step carries the beginning of its run, a core without a turn that of the picked-up
//        agent, a workflow core 0 — CT: a new core without a run (opening time) waits in `waiting`.
//   (B6/B8) "Again" before the turnaround with a living copy => 409 COPY_OPEN (CT: it used to be 202), the copy holds in the quiet; a
//        failed way back counts in `layoutsOpen` (CT: `error` before the turnaround without a way back does not).
//   (B7) The quiet check at the gate of the container program: in the short `running` (step "quiet") write lock, upload and view read
//        `waiting` (CT: `running`, 409 LAYOUT_RUNNING), starts wait; a follow-up step held there (doRun with `parentSince`, like the
//        graph driver) starts after the fall back to `waiting` (CT: it stood until the end of the job), a later message of the human
//        does not.
//
// SABOTAGES ON THE PRODUCT (each red):
//   1. idle.js verdictTheLock without the pass `parentSince < since`        => (R) red ("subagent with parentSince < since: through")
//   2. job.js quietSync counts "queue" as holder                              => (R) red ("the queue does not hold")
//   3. server.js turn observer without layoutAfterChat                        => (R) red ("to the execution after the turn end" —
//      read as soon as `runs` is 0 and no check runs any more; the tick is at one hour, no hang)
//   4. job.js layoutRestartGrace without setLock                              => (N) red
//   5. erase.js without the OCCUPIED row for `running`                        => (R) red (deleting without code OCCUPIED)
//   6. idle.js pass without the phase (`waiting &&` struck)                   => (R) red ("from running the subagent waits …")
//   7. job.js quietAsync without the ancestor chain (`chain`) at the workspace chat => (W) red
//   8. processes-in-b.js: a process without a run is no holder; proc-program.js search path = realpath of the whole path
//      => (W) red ("a process without a run holds") / (P) red ("the link never searches under its target")
//   9. idle.js projectLocks `beside = false` (the earmark excludes re-creating)                  => (B1) red ("already locked")
//      idle.js withEarmarking `u = g` (the earmark judges alone)                                  => (B1) red ("layout waits")
//      graph-start.js redeem without the question to the lock                                    => (B3) red (status earmarked)
//      idle.js idleOf without the reason "worktree"                                              => (B3) red ("the idle state counts it")
//      runs/agents.js coreSince without the beginning of the workflow run                        => (B4) red
//      runs/agents.js pickUpParked without the start of the picked-up agent                      => (B4) red
//      erase.js `replaceLayout: false`                                                           => (L) red (409 "already locked")
//      store/project-layout.js layoutsOpenCount without `backward = 1`                           => (B6/B8) red
//      job.js again without layoutSituation                                                      => (B6/B8) red (202)
//      job.js viewState = state                                                                  => (B7) red ("running")
//      idle.js earmarkProject `phase` without wakeFollowUps                                      => (B7) red (the follow-up step
//      stands until the cap of the wait row, 10 min — the run misses the deadline)
//
// Note: `exec` runs LOCAL — nothing here reads the real /proc and no signal goes to a pid that does not come from an own PTY or an
// own fake CLI; the /proc search always reads a fake /proc (setProcSearchSeam, setProcessSeam).
//
// Run (one file alone, with the gate deadlines as in ./check):
//   env -u NODE_TEST_CONTEXT CBASE_LIMIT_GRACE_MS=2000 CBASE_LIMIT_MIN_WAIT_MS=2000 CBASE_SWEEP_MS=2000 \
//     CBASE_AGENT_STALL_MS=3600000 CBASE_EMBED_OFFLINE=1 node --test --test-reporter=tap server/backend/test/layout-quiet.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as store from "../electron/server/store.js";
import { BOOT_ID } from "../electron/server/app-state.js";
import { projectLocked, projectIdle, projectLock } from "../electron/server/projectbox/idle.js";
import { setProjectLock, startLock, projectStartGate } from "../electron/server/runs/project-lock.js";
import { recreateStatus, earmarkRecreate } from "../electron/server/projectbox/recreate.js";
import { setInstanceState } from "../electron/server/projectbox/instances.js";
import { containerName } from "../electron/server/projectbox/creation.js";
import { redeem, worktreesBeingCreated } from "../electron/server/workflows/graph-start.js";
import { openAgents, closeAgentsOfTheChat } from "../electron/server/runs/agents.js";
import { agentContextWithoutTurn, doRun } from "../electron/server/runs/do-run.js";
import { copyRequests } from "../electron/server/stacks/state.js";
import { layoutStatus, setLayoutReader, setLayoutRowsReader } from "../electron/server/projectbox/setup/status.js";
import { setLayoutRevert } from "../electron/server/projectbox/erase.js";
import { setProcessSeam } from "../electron/server/projectbox/relocation/processes.js";
import { createProviderPark, wakeProjectWaiting } from "../electron/server/dynworkflows/parking.js";
import { dynWorkflowSituation, stopDynWorkflow } from "../electron/server/dynworkflows/run.js";
import { createTerminal, killTerminal, terminalSessions } from "../electron/server/terminal.js";
import { runChildren } from "../electron/server/runs/state.js";
import { EDITOR_LOCATIONS, PROC_SEARCH, procCore, setProcSearchSeam } from "../electron/server/projectbox/layout/proc-program.js";
import {
  forgetJobs, layoutReader, checkBackLayout, layoutRestartGrace, quietCheckRunning, quietSync, setDynWorkflowAccess,
  setLayoutExecution, setLock, lockStands, revertWaiting,
} from "../electron/server/projectbox/layout/job.js";
import { fakeClaude, alive, waitForTruthy } from "./agent-harness.mjs";
import { FOREIGN_SPACE, fakeProc, emptyProc } from "./fake-proc.mjs";
import { active, request, create, cliEnvironment, dx, finished, inProject, withCreation, withoutAccount, runsNull, write, send, gatePath, gateClosed, turns } from "./setup-harness.mjs";
import { forgetChecks } from "../electron/server/projectbox/layout/read.js";
import { layoutRow } from "../electron/server/projectbox/layout/job.js";

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `cbase-layout-quiet-${name}-`));

// The main agent writes one line per turn to main.jsonl; if “{GATE:x}” is in the text, it holds at gate x.
const CLAUDE = fakeClaude({ main: `
  fs.appendFileSync(path.join(LOCATION, "main.jsonl"), JSON.stringify({ turn, text }) + "\\n");
  const x = (/\\{GATE:([a-z0-9]+)\\}/.exec(text) || [])[1] || "";
  if (x) await gate(x);
  say({ type: "assistant", message: { id: "c-" + Date.now(), content: [{ type: "text", text: "Answer " + turn }] } });
  finished();
  say({ type: "result", result: "Answer " + turn, session_id: "main-session" });` });

const STEPS = [{ kind: "move", from: "old", to: "fresh" }];
const endTheCheck = (reader, id) => waitForTruthy(() => reader.events.find((e) => e.type === "project/layout" && e.check === id && e.state !== "running"), `check ${id} at its end`);
async function check(ctx, reader, pid, steps) {
  const r = await inProject(ctx, pid, "/layout/check", { method: "POST", body: { steps } });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  const ev = await endTheCheck(reader, r.body.check);
  assert.equal(ev.state, "finished", JSON.stringify((await inProject(ctx, pid, `/layout/check/${r.body.check}`)).body));
  return r.body.check;
}
const takeOver = (ctx, pid, body) => inProject(ctx, pid, "/layout/takeOver", { method: "POST", body });
const job = async (ctx, pid) => (await inProject(ctx, pid, "/layout/job")).body.job;
// Until no quiet check runs any more (an event, no duration) — then the state of the job is the one it left behind.
const quietFinished = (pid) => waitForTruthy(() => !quietCheckRunning(pid), "quiet check ended");

async function projectWithFolders(ctx, name = "Layout") {
  const proj = await create(ctx, { name, sources: [] });
  await finished(proj.id);
  write(path.join(proj.path, "old", "a.txt"), "a\n");
  write(path.join(proj.path, "stays", "b.txt"), "b\n");
  return proj;
}
// The frame of every server test: a recorder at the seam of the execution and the cleanup of the memory of the job.
// The look-again tick at one hour: every progress in the test comes from an event (turn end, stop, upload, terminal end) or from an
// explicit checkBackLayout — a missing observer turns the test red instead of being rescued by the tick.
async function withJob(fn, opts = {}) {
  const executed = [];
  await withoutAccount(() => withCreation(async (a) => {
    setLayoutExecution((pid, o) => { executed.push({ pid, ...o }); });
    // B ALWAYS looks for processes under the affected paths — without a seam it would read the real /proc (none on macOS: “not
    // checkable”; on Linux every process of the machine would hold there). Default: a /proc with only B in it.
    setProcessSeam({ root: emptyProc(path.join(a.ctx.root, "fake-proc-b-empty")) });
    try { await fn({ ...a, executed }); } finally {
      setLayoutExecution(null);
      // The recorder runs no procedure: a job it left in `running` would hold `projectWork` (the row carries the boot id of this
      // process) and so the quiet of the harness forever — the cleanup removes it.
      for (const x of store.layoutJobs()) if (x.state === "running") store.deleteLayoutJob(x.projectId);
      forgetJobs();
      forgetChecks();
      setProcSearchSeam();
      setProcessSeam();
    }
  }, { claude: CLAUDE, environment: (fd) => ({ ...cliEnvironment(fd), CBASE_LAYOUT_CHECK_BACK_MS: "3600000" }), ...opts }));
}

// ── (P) the container program, the park state ──────────────────────────────────────────────────────────────────────────

test("(P) the container program of the /proc search: foreground and processes on the fake /proc, as core and as program text — with counter-tests", () => {
  const dir = tmp("proc");
  const w = tmp("root");
  try {
    fs.mkdirSync(path.join(w, "old", "deep"), { recursive: true });
    fs.mkdirSync(path.join(w, "old-2"), { recursive: true });
    fs.writeFileSync(path.join(w, "old", "f.txt"), "f");
    const p = fakeProc(dir, { itself: 10, ancestors: [9] });
    p.process({ pid: 100, comm: "bash", pgid: 100, sid: 100, tpgid: 120, cwd: w });
    p.process({ pid: 120, comm: "npm run dev", ppid: 100, pgid: 120, sid: 100, cwd: path.join(w, "old", "deep") });
    p.process({ pid: 200, comm: "bash", pgid: 200, sid: 200, tpgid: 200, cwd: w });
    p.process({ pid: 300, comm: "zsh", pgid: 300, sid: 300, cwd: w }); // tpgid -1: no terminal
    p.process({ pid: 130, comm: "siblings", cwd: path.join(w, "old-2") });
    p.process({ pid: 140, comm: "foreign", cwd: path.join(w, "old"), space: FOREIGN_SPACE });
    p.process({ pid: 150, comm: "service", cwd: path.join(w, "old"), pgid: 150 });
    p.process({ pid: 160, comm: "open", cwd: "/", fd: { 3: path.join(w, "old", "f.txt"), 4: "socket:[1]" }, ppid: 120 });

    const v = procCore(fs, path, "foreground", { root: dir, pids: [100, 200, 300, 999] });
    assert.deepEqual(v.sessions, [
      { pid: 100, pgid: 100, tpgid: 120, foreground: true, name: "npm run dev" },
      { pid: 200, pgid: 200, tpgid: 200, foreground: false },
      { pid: 300, pgid: 300, tpgid: -1, foreground: false },
    ], "CT: tpgid == group (200) and without a terminal (300) are not foreground; a vanished pid is missing");

    const r = procCore(fs, path, "processes", { root: dir, paths: [path.join(w, "old")], exempt: [150] });
    assert.deepEqual(r.processes.map((x) => [x.pid, x.name]), [[120, "npm run dev"], [160, "open"]],
      "cwd under the path and an open descriptor — never old-2, never a foreign namespace, never an exempt group");
    assert.deepEqual(r.processes.find((x) => x.pid === 160).chain, [120, 100], "the ancestor chain");
    assert.equal(r.truncated, undefined);
    // CT for “exempt”: without group 150 the service is there.
    assert.ok(procCore(fs, path, "processes", { root: dir, paths: [path.join(w, "old")] }).processes.some((x) => x.pid === 150));

    // The program text: the same answer through `node -e` with stdin (this is how it runs in the project container).
    const run = (mode, one) => JSON.parse(spawnSync(process.execPath, ["-e", PROC_SEARCH, "--", mode], { input: JSON.stringify(one), encoding: "utf8" }).stdout.trim());
    assert.deepEqual(run("foreground", { root: dir, pids: [100, 200, 300, 999] }), { ok: true, ...v });
    assert.deepEqual(run("processes", { root: dir, paths: [path.join(w, "old")], exempt: [150] }), { ok: true, ...r });
    // S: an unknown mode is an error with a code, not an empty answer.
    assert.deepEqual(run("nonexistent", { root: dir }), { ok: false, code: "EOP", message: "Unknown mode nonexistent" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(w, { recursive: true, force: true });
  }
});

test("(P) the /proc search follows no link, keeps the root boundary, reads “..old” by path parts and finds the editor locations — with counter-tests", () => {
  const dir = tmp("proc-reference");
  const w = tmp("root-reference");
  const outside = tmp("outside");
  try {
    fs.mkdirSync(path.join(w, "..old"), { recursive: true });
    fs.mkdirSync(path.join(w, "inside"), { recursive: true });
    fs.symlinkSync(outside, path.join(w, "tool"));
    const p = fakeProc(dir, { itself: 10 });
    p.process({ pid: 400, comm: "foreign", cwd: outside });
    p.process({ pid: 410, comm: "points", cwd: path.join(w, "..old") });
    p.process({ pid: 420, comm: "node", cwd: "/", exe: "/home/agent/.vscode-server/bin/abc123/node" });
    p.process({ pid: 430, comm: "node", cwd: "/", exe: "/usr/local/bin/node" });
    const search = (o) => procCore(fs, path, "processes", { root: dir, ...o }).processes.map((x) => x.pid).sort((x, y) => x - y);
    const link = path.join(w, "tool");
    // A link that is moved or left out counts itself — its target stays.
    assert.deepEqual(search({ paths: [link], roots: [w] }), [], "the link never searches under its target");
    assert.deepEqual(search({ paths: [link] }), [], "… also without a root boundary (only the parent folder is resolved)");
    assert.deepEqual(search({ paths: [outside] }), [400], "CT: the target itself as a search path hits the process");
    // With `roots` a search path outside is dropped.
    assert.deepEqual(search({ paths: [outside], roots: [w] }), [], "outside the root the search path is dropped");
    // “..old” is a folder UNDER the root.
    assert.deepEqual(search({ paths: [path.join(w, "..old")], roots: [w] }), [410], "“..old” lies under the root");
    // The locations of the VS Code server hit its program, no other node.
    assert.ok(EDITOR_LOCATIONS.includes("/home/agent/.vscode-server"), EDITOR_LOCATIONS.join(", "));
    assert.deepEqual(search({ paths: [...EDITOR_LOCATIONS] }), [420], "the VS Code server — never another node");
    // The program text computes the same (this is how it runs in the project container).
    const run = (mode, one) => JSON.parse(spawnSync(process.execPath, ["-e", PROC_SEARCH, "--", mode], { input: JSON.stringify(one), encoding: "utf8" }).stdout.trim());
    assert.deepEqual(run("processes", { root: dir, paths: [link], roots: [w] }).processes, []);
    assert.deepEqual(run("processes", { root: dir, paths: [...EDITOR_LOCATIONS] }).processes.map((x) => x.pid), [420]);
  } finally {
    for (const x of [dir, w, outside]) fs.rmSync(x, { recursive: true, force: true });
  }
});

test("(P) the park state: an agent() at the project lock counts as waiting — CT: woken => 0", async () => {
  const park = createProviderPark();
  assert.equal(park.waiting(), 0);
  const wait = park.atProject({ until: Date.now() + 3_600_000, wakeup: () => () => {} });
  assert.equal(park.waiting(), 1);
  wakeProjectWaiting();
  await wait;
  assert.equal(park.waiting(), 0);
  park.close();
});

// ── (U) take over: the refusals ─────────────────────────────────────────────────────────────────────────────────────────

test("(U) take over: CHECK, CHECK_STALE, RULES, NO_CHANGE; a job turns take-over and check into JOB_OPEN", async () => {
  await withJob(async ({ ctx, reader, executed }) => {
    const proj = await projectWithFolders(ctx);
    const pid = proj.id;
    let r = await takeOver(ctx, pid, { steps: STEPS });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body.code, "CHECK");
    const id = await check(ctx, reader, pid, STEPS);
    r = await takeOver(ctx, pid, { steps: [{ kind: "move", from: "old", to: "different" }], check: id });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.code, "CHECK_STALE");
    const rule = [{ kind: "move", from: "old", to: "line\nbreak" }];
    const idRule = await check(ctx, reader, pid, rule);
    r = await takeOver(ctx, pid, { steps: rule, check: idRule });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body.code, "RULES");
    assert.ok(r.body.error.some((f) => f.code === "NAME_INVALID"), JSON.stringify(r.body.error));
    const idEmpty = await check(ctx, reader, pid, []);
    r = await takeOver(ctx, pid, { steps: [], check: idEmpty });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body.code, "NO_CHANGE");
    assert.equal(store.layoutJob(pid), null, "no refusal created a job");

    // A job (without holder: it starts at once — the execution is only a recorder here).
    r = await takeOver(ctx, pid, { steps: STEPS, check: id });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    await waitForTruthy(() => executed.length === 1, "handed to the execution");
    assert.equal(store.layoutJob(pid).state, "running");
    r = await takeOver(ctx, pid, { steps: STEPS, check: id });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.code, "JOB_OPEN");
    r = await inProject(ctx, pid, "/layout/check", { method: "POST", body: { steps: STEPS } });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.code, "JOB_OPEN");
    const a = store.layoutJob(pid);
    assert.deepEqual(a.plan.finalMapping.ways, [{ old: "old", fresh: "fresh" }]);
    assert.deepEqual(a.plan.affected, ["old"]);
    assert.equal(a.confirmed.check, id);
    assert.notEqual(a.confirmed.confirmable, null, "docker was readable during the check");
    assert.equal(a.since > 0 && a.state === "running" && a.process === BOOT_ID, true);
  });
});

// ── (R) the quiet with a running turn, the start paths, the turnaround in `running` ──────────────────────────────────────

test("(R) quiet: a running turn holds, the queue does not; the start paths in `waiting` and `running`; turn end => `running`; withdrawing after `error` before the turnaround wakes", async () => {
  await withJob(async ({ ctx, reader, executed }) => {
    const proj = await projectWithFolders(ctx);
    const pid = proj.id;
    const id = await check(ctx, reader, pid, STEPS);
    assert.equal((await request(`${ctx.base}/api/chats/${ctx.chat.id}`, { method: "PATCH", body: { projectId: pid } })).status, 200);
    const c2 = await request(`${ctx.base}/api/chats`, { method: "POST", body: { workspaceId: ctx.ws.id, projectId: pid } });
    assert.equal(c2.status, 201, JSON.stringify(c2.body));
    const chat2 = c2.body.id;
    // A title by hand: without it the first message would start the title oneshot (runs/routes.js maybeAutoTitle) — a holder.
    assert.equal((await request(`${ctx.base}/api/chats/${chat2}`, { method: "PATCH", body: { title: "Zweiter" } })).status, 200);

    // A turn runs and holds at the gate.
    let r = await send(ctx, "WORK {GATE:t1}");
    assert.equal(r.body.queued, false, JSON.stringify(r.body));
    await ctx.gate.reached("t1");

    r = await takeOver(ctx, pid, { steps: STEPS, check: id });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    await quietFinished(pid);
    let a = await job(ctx, pid);
    assert.equal(a.state, "waiting", JSON.stringify(a));
    assert.deepEqual(a.holders.map((h) => [h.kind, h.id, h.stoppable]), [["turn", ctx.chat.id, true]]);
    const since = store.layoutJob(pid).since;
    // The project list carries the job with the number of holders — CT: without the reader no field.
    const row = async () => (await request(`${ctx.base}/api/projects`)).body.find((p) => p.id === pid)?.layout;
    assert.deepEqual(await row(), { state: "waiting", turned: false, backward: false, step: "", error: null, since, holders: 1 });
    setLayoutRowsReader(null);
    try { assert.equal(await row(), undefined, "CT: without the reader no field is there"); } finally { setLayoutRowsReader(layoutRow); }

    // A turn of the second chat waits (queue) — and does not count.
    r = await request(`${ctx.base}/api/chats/${chat2}/message`, { method: "POST", body: { text: "SECOND" } });
    assert.equal(r.body.queued, true, JSON.stringify(r.body));
    assert.equal(r.body.locked, true, JSON.stringify(r.body));
    assert.deepEqual(quietSync(pid).holders.map((h) => [h.kind, h.id]), [["turn", ctx.chat.id]], "the queue does not hold");
    assert.ok(projectIdle(pid).open.some((o) => o.chatId === chat2 && o.reason === "queue"), "CT: the old quiet (projectIdle) counted the queue");

    // The start paths in `waiting`.
    const identifier = `${pid}/main`;
    assert.equal(startLock(chat2, "turn")?.reason, "layout", "a new turn waits");
    assert.equal(startLock(chat2, "turn")?.kind, "wait");
    assert.equal(startLock(ctx.chat.id, "agent", { projectId: pid, identifier, parentSince: since - 1 }), null, "subagent with parentSince < since: through");
    assert.equal(startLock(ctx.chat.id, "agent", { projectId: pid, identifier })?.kind, "wait", "CT: without parentSince it waits");
    assert.equal(startLock(ctx.chat.id, "agent", { projectId: pid, identifier, parentSince: since + 1 })?.kind, "wait", "CT: with parentSince >= since it waits");
    assert.equal(startLock(chat2, "turn", { parentSince: since - 1 }), null, "the next step of a running graph workflow: through");
    assert.equal(projectStartGate({ chatId: ctx.chat.id, purpose: "agent", projectId: pid, identifier, parentSince: since - 1 }), null, "workflow agent through the start gate: through");
    assert.equal(projectStartGate({ purpose: "oneshot", instance: { projectId: pid, instance: "main" } })?.ok, false, "oneshot with instance waits");
    assert.equal(projectStartGate({ chatId: ctx.chat.id, purpose: "oneshot" }), null, "oneshot in B runs");
    assert.throws(() => copyRequests({ projectId: pid, name: "k1", chatId: chat2 }), (e) => e.code === "REBUILD_OPEN" && e.status === 409);
    r = await inProject(ctx, pid, "/upload/begin", { method: "POST", body: { paths: [{ path: "x.txt", size: 1 }] } });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.code, "LAYOUT_WAITING");
    assert.equal(layoutStatus(pid), "waiting");

    // The quiet is re-checked only after an event: while the turn runs, the job stays `waiting` (a check by hand).
    checkBackLayout(pid);
    await quietFinished(pid);
    assert.equal(store.layoutJob(pid).state, "waiting");
    assert.equal(executed.length, 0);

    // The turn ends => the turn observer checks => `running` and to the execution (exactly once).
    // `running` is removed in the same synchronous block in which the observer is called (runs/do-run.js finally → release the turn):
    // if `runs` is 0, the check is triggered — then wait for its end and READ the result (no waiting for the execution).
    ctx.gate.open("t1");
    await runsNull(ctx);
    await quietFinished(pid);
    assert.deepEqual(executed, [{ pid, resume: false }], "to the execution after the turn end");
    a = store.layoutJob(pid);
    assert.equal(a.state, "running");
    assert.equal(a.process, BOOT_ID);
    assert.equal((await row())?.state, "running");
    assert.equal((await row())?.holders, 0, "holders count only in `waiting`");
    assert.equal(turns(ctx.root).filter((t) => t.text.includes("SECOND")).length, 0, "the second turn keeps waiting");

    // From `running` every start waits — also a follow-up step of old work.
    assert.equal(startLock(ctx.chat.id, "agent", { projectId: pid, identifier, parentSince: since - 1 })?.kind, "wait", "from running the subagent with an old parentSince waits");
    assert.equal(startLock(ctx.chat.id, "agent", { projectId: pid, identifier, parentSince: since - 1 })?.phase, "running");
    r = await inProject(ctx, pid, "/upload/begin", { method: "POST", body: { paths: [{ path: "x.txt", size: 1 }] } });
    assert.equal(r.body.code, "LAYOUT_RUNNING", JSON.stringify(r.body));
    r = await inProject(ctx, pid, "/layout/job", { method: "DELETE" });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.code, "JOB_RUNNING");
    r = await request(`${ctx.base}/api/projects/${pid}`, { method: "DELETE" });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.code, "OCCUPIED");

    // Failed before the turnaround (the execution sets that — by hand here): withdrawing works, the lock falls, the second turn runs.
    store.layoutSet(pid, { state: "error", turned: false, error: "Test" });
    assert.equal(layoutStatus(pid), null, "error before the turnaround does not lock");
    assert.deepEqual([(await row())?.state, (await row())?.turned, (await row())?.error], ["error", false, "Test"], "the row also shows `error` before the turnaround (“no longer fits”)");
    assert.equal(turns(ctx.root).filter((t) => t.text.includes("SECOND")).length, 0, "CT: before withdrawing it did not run");
    r = await inProject(ctx, pid, "/layout/job", { method: "DELETE" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(store.layoutJob(pid), null);
    assert.equal(await row(), undefined, "withdrawn => no field");
    await waitForTruthy(() => turns(ctx.root).some((t) => t.text.includes("SECOND")), "the waiting turn runs after withdrawing");
    assert.equal(startLock(chat2, "turn"), null);
  });
});

// ── (S) stopping ─────────────────────────────────────────────────────────────────────────────────────────────────────────

test("(S) stopping: an open upload holds, “stop” discards it and the job starts; a turn holder ends through the turn stop", async () => {
  await withJob(async ({ ctx, reader, executed }) => {
    const proj = await projectWithFolders(ctx);
    const pid = proj.id;
    const id = await check(ctx, reader, pid, STEPS);
    let r = await inProject(ctx, pid, "/upload/begin", { method: "POST", body: { paths: [{ path: "x.txt", size: 1 }] } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const operation = r.body.operation;
    r = await takeOver(ctx, pid, { steps: STEPS, check: id });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    await quietFinished(pid);
    let a = await job(ctx, pid);
    assert.deepEqual(a.holders.map((h) => [h.kind, h.id, h.stoppable]), [["upload", operation, true]]);
    r = await inProject(ctx, pid, "/layout/holders/stop", { method: "POST", body: { kind: "upload", id: "exists-not" } });
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.equal(r.body.code, "HOLDER_UNKNOWN");
    r = await inProject(ctx, pid, "/layout/holders/stop", { method: "POST", body: { kind: "upload", id: operation } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
    assert.ok(!store.projectUpload(operation), "the procedure is discarded");
    await waitForTruthy(() => executed.length === 1, "handed to the execution after discarding");
    r = await inProject(ctx, pid, "/layout/holders/stop", { method: "POST", body: { kind: "upload", id: operation } });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.code, "NOT_WAITING");
    // Cleanup for the second part: the job finished (by hand), the lock gone.
    store.layoutSet(pid, { state: "finished" });
    forgetJobs();

    // A turn holder.
    assert.equal((await request(`${ctx.base}/api/chats/${ctx.chat.id}`, { method: "PATCH", body: { projectId: pid } })).status, 200);
    r = await send(ctx, "ARBEIT {GATE:t2}");
    await ctx.gate.reached("t2");
    const fakePid = Number(fs.readFileSync(path.join(ctx.root, "gates", "t2.waiting"), "utf8"));
    assert.ok(alive(fakePid), "the turn works at the gate");
    const id2 = await check(ctx, reader, pid, STEPS);
    r = await takeOver(ctx, pid, { steps: STEPS, check: id2 });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    await quietFinished(pid);
    a = await job(ctx, pid);
    assert.deepEqual(a.holders.map((h) => [h.kind, h.id]), [["turn", ctx.chat.id]]);
    r = await inProject(ctx, pid, "/layout/holders/stop", { method: "POST", body: { kind: "turn", id: ctx.chat.id } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await waitForTruthy(() => executed.length === 2, "handed to the execution after the turn stop");
    assert.equal((await active(ctx.base)).runs, 0);
    // The stop hit the process itself (the gate stays closed — a living fake would stand there forever).
    await waitForTruthy(() => !alive(fakePid), "the stopped turn process is gone");
  });
});

// ── (T) terminals ───────────────────────────────────────────────────────────────────────────────────────────────────────

test("(T) terminals: a workspace terminal with a command under an affected path holds, one with the shell in front does not; in the project container the program asks through docker exec", async () => {
  await withJob(async ({ ctx, fd, reader, executed }) => {
    const proj = await projectWithFolders(ctx);
    const pid = proj.id;
    const id = await check(ctx, reader, pid, STEPS);
    const open = [];
    const dir = tmp("proc-b");
    const shellPrior = process.env.SHELL;
    process.env.SHELL = "/bin/sh";
    try {
      // A workspace terminal (PTY in B) — its /proc is fake (setProcessSeam): the shell has a command in old/ in front.
      const t = createTerminal({ cwd: ctx.root, shell: "/bin/sh", tag: "" });
      open.push(t.id);
      const shell = terminalSessions().find((s) => s.id === t.id).pid;
      assert.ok(shell > 1, "the shell has a pid");
      const p = fakeProc(dir, { itself: process.pid });
      p.process({ pid: shell, comm: "sh", pgid: shell, sid: shell, tpgid: 777001, cwd: ctx.root });
      p.process({ pid: 777001, comm: "npm", ppid: shell, pgid: 777001, sid: shell, cwd: path.join(proj.path, "old") });
      setProcessSeam({ root: dir });
      let r = await takeOver(ctx, pid, { steps: STEPS, check: id });
      assert.equal(r.status, 202, JSON.stringify(r.body));
      await quietFinished(pid);
      let a = await job(ctx, pid);
      assert.equal(a.state, "waiting", JSON.stringify(a));
      assert.deepEqual(a.holders.map((h) => [h.kind, h.id, h.name]), [["terminal", t.id, "npm"]]);
      assert.equal(executed.length, 0);
      // CT: the shell in front => does not hold (a check by hand — the tick would do the same).
      p.process({ pid: shell, comm: "sh", pgid: shell, sid: shell, tpgid: shell, cwd: ctx.root });
      checkBackLayout(pid);
      await quietFinished(pid);
      assert.equal(executed.length, 1, "to the execution as soon as the shell is in front");
      store.layoutSet(pid, { state: "finished" });
      forgetJobs();
      killTerminal(t.id);
      // Without its terminal 777001 would be a process in B without a run — it would hold; with the terminal its /proc entry ends too.
      p.gone(777001);
      p.gone(shell);

      // In the project container: a terminal through the route (the shell wrapper writes the group); the program runs through docker exec.
      const ct = await inProject(ctx, pid, "/terminal", { method: "POST", body: { cols: 80, rows: 24 } });
      assert.equal(ct.status, 201, JSON.stringify(ct.body));
      open.push(ct.body.id);
      const pgid = await waitForTruthy(() => terminalSessions().find((s) => s.id === ct.body.id)?.pgid || null, "the group of the shell in the container");
      const c = fakeProc(path.join(dir, "c"), { itself: process.pid });
      c.process({ pid: pgid, comm: "sh", pgid, sid: pgid, tpgid: 777002, cwd: proj.path });
      c.process({ pid: 777002, comm: "make", ppid: pgid, pgid: 777002, sid: pgid, cwd: proj.path });
      setProcSearchSeam({ root: path.join(dir, "c") });
      const id2 = await check(ctx, reader, pid, STEPS);
      const prior = fd.calls({ daemon: "host" }).length;
      r = await takeOver(ctx, pid, { steps: STEPS, check: id2 });
      assert.equal(r.status, 202, JSON.stringify(r.body));
      await quietFinished(pid);
      a = await job(ctx, pid);
      assert.deepEqual(a.holders.map((h) => [h.kind, h.id, h.name]), [["terminal", ct.body.id, "make"]]);
      assert.ok(fd.calls({ daemon: "host" }).slice(prior).some((x) => x.args[0] === "exec" && x.args.includes("foreground")), "the program ran in the project container");
      // CT: without a command in front it does not hold.
      c.process({ pid: pgid, comm: "sh", pgid, sid: pgid, tpgid: pgid, cwd: proj.path });
      checkBackLayout(pid);
      await quietFinished(pid);
      assert.equal(executed.length, 2, "to the execution without a command in the container terminal");
    } finally {
      for (const x of open) killTerminal(x);
      if (shellPrior === undefined) delete process.env.SHELL; else process.env.SHELL = shellPrior;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── (W) a workspace chat in B ─────────────────────────────────────────────────────────────────────────────────────────

test("(W) in B: a process under an affected path holds as the turn of its chat, after the turn as a process without a run (not stoppable) — only without it does the job go to the execution", async () => {
  await withJob(async ({ ctx, reader, executed }) => {
    const proj = await projectWithFolders(ctx);
    const pid = proj.id;
    const id = await check(ctx, reader, pid, STEPS);
    const dir = tmp("proc-w");
    try {
      // ctx.chat stays in the workspace (no project): its turn runs in B and holds at the gate.
      const r0 = await send(ctx, "ARBEIT {GATE:w1}");
      assert.equal(r0.body.queued, false, JSON.stringify(r0.body));
      await ctx.gate.reached("w1");
      const childPid = runChildren.get(ctx.chat.id)?.pid;
      assert.ok(childPid > 1, "the CLI process of the workspace chat");
      const p = fakeProc(dir, { itself: process.pid });
      p.process({ pid: 777010, comm: "vite", ppid: childPid, cwd: path.join(proj.path, "old") });
      setProcessSeam({ root: dir });
      let r = await takeOver(ctx, pid, { steps: STEPS, check: id });
      assert.equal(r.status, 202, JSON.stringify(r.body));
      await quietFinished(pid);
      let a = await job(ctx, pid);
      assert.equal(a.state, "waiting", JSON.stringify(a));
      assert.deepEqual(a.holders.map((h) => [h.kind, h.id, h.stoppable]), [["turn", ctx.chat.id, true]]);
      assert.equal(executed.length, 0);

      // The turn ends — the process stays, now without descent from a running CLI (this is how a subagent, the bash of the loop
      // engine or a background server stands there). The turn observer checks the quiet: it holds as a process without a run.
      ctx.gate.open("w1");
      await runsNull(ctx);
      p.process({ pid: 777010, comm: "vite", ppid: 1, cwd: path.join(proj.path, "old") });
      checkBackLayout(pid);
      await quietFinished(pid);
      a = await job(ctx, pid);
      assert.equal(a.state, "waiting", `a process without a run holds (it used to not hold — the folder moved away from under it): ${JSON.stringify(a)}`);
      assert.deepEqual(a.holders.map((h) => [h.kind, h.id, h.stoppable]), [["process", "b:777010", false]]);
      assert.match(a.holders[0].text, /vite.*777010/);
      assert.equal(executed.length, 0);
      r = await inProject(ctx, pid, "/layout/holders/stop", { method: "POST", body: { kind: "process", id: "b:777010" } });
      assert.deepEqual([r.status, r.body?.code], [409, "NOT_STOPPABLE"], JSON.stringify(r.body));

      // CT: without it the job goes to the execution.
      p.gone(777010);
      checkBackLayout(pid);
      await quietFinished(pid);
      assert.equal(executed.length, 1, "to the execution as soon as no process works there any more");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── (D) dynamic workflows ────────────────────────────────────────────────────────────────────────────────────────────

test("(D) a dynamic workflow holds only if it computes — CT: if it only waits, it is a hint", async () => {
  await withJob(async ({ ctx }) => {
    const proj = await projectWithFolders(ctx);
    const pid = proj.id;
    assert.equal((await request(`${ctx.base}/api/chats/${ctx.chat.id}`, { method: "PATCH", body: { projectId: pid } })).status, 200);
    let computes = true;
    setDynWorkflowAccess({ situation: () => [{ chatId: ctx.chat.id, runId: "r1", name: "wf", open: 1, waiting: computes ? 0 : 1, computes }], stop: () => true });
    try {
      assert.deepEqual(quietSync(pid).holders.map((h) => [h.kind, h.id]), [["dynworkflow", "r1"]]);
      computes = false;
      const s = quietSync(pid);
      assert.deepEqual(s.holders, [], "a waiting workflow does not hold");
      assert.deepEqual(s.hints.map((h) => [h.kind, h.id]), [["dynworkflow", "r1"]]);
      // A workflow of a chat outside the project does not count.
      setDynWorkflowAccess({ situation: () => [{ chatId: "foreign", runId: "r2", name: "x", computes: true }] });
      assert.deepEqual(quietSync(pid).holders, []);
    } finally {
      setDynWorkflowAccess({ situation: dynWorkflowSituation, stop: (chatId, runId) => stopDynWorkflow(chatId, runId, { from: "human" })?.status === 200 });
    }
  });
});

// ── (N) post-start and reader ─────────────────────────────────────────────────────────────────────────────────────────────

test("(N) restart grace: without the hook no lock (CT), with it again; `running` before the turnaround => backward; `error` before the turnaround does not lock; the reader", async () => {
  await withJob(async ({ ctx }) => {
    const proj = await projectWithFolders(ctx);
    const pid = proj.id;
    assert.equal((await request(`${ctx.base}/api/chats/${ctx.chat.id}`, { method: "PATCH", body: { projectId: pid } })).status, 200);
    store.createLayout({ projectId: pid, plan: { finalMapping: { ways: [{ old: "old", fresh: "fresh" }], gone: [] } }, confirmed: {}, since: Date.now() - 1000 });
    // A new process: nothing in memory.
    forgetJobs();
    assert.equal(startLock(ctx.chat.id, "turn"), null, "CT: without the post-start hook there is no lock after a restart");
    assert.equal(layoutRestartGrace(), undefined, "synchronous, without a return value");
    assert.equal(startLock(ctx.chat.id, "turn")?.reason, "layout");
    assert.equal(layoutStatus(pid), "waiting");
    // A waiting job does NOT hold `busy`: it is stored, the post-start takes it up again.
    const a0 = await active(ctx.base);
    assert.equal(a0.busy, false, JSON.stringify(a0));

    store.layoutSet(pid, { state: "running", process: "old-process" });
    forgetJobs();
    layoutRestartGrace();
    const a = store.layoutJob(pid);
    assert.equal(a.backward, true, "running before the turnaround => backward");
    assert.equal(startLock(ctx.chat.id, "agent", { projectId: pid, identifier: `${pid}/main`, parentSince: a.since - 1 })?.phase, "running", "and locks like running");
    assert.equal(layoutStatus(pid), "running");

    store.layoutSet(pid, { state: "error", backward: false, turned: false });
    forgetJobs();
    layoutRestartGrace();
    assert.equal(startLock(ctx.chat.id, "turn"), null, "error before the turnaround does not lock");
    assert.equal(layoutStatus(pid), null);
    store.layoutSet(pid, { state: "error", turned: true });
    layoutRestartGrace();
    assert.equal(startLock(ctx.chat.id, "turn")?.phase, "error", "error after the turnaround locks");
    assert.equal(layoutStatus(pid), "error");
    // CT for the reader: without a registered reader null.
    setLayoutReader(null);
    try { assert.equal(layoutStatus(pid), null); } finally { setLayoutReader(layoutReader); }
  });
});

// ── (L) deleting ─────────────────────────────────────────────────────────────────────────────────────────────────────────

test("(L) deleting: with held work 409 — the waiting job stays, the earmark is back, nothing woken; without it 200 and everything gone", async () => {
  await withJob(async ({ ctx }) => {
    const proj = await projectWithFolders(ctx);
    const pid = proj.id;
    assert.equal((await request(`${ctx.base}/api/chats/${ctx.chat.id}`, { method: "PATCH", body: { projectId: pid } })).status, 200);
    const since = Date.now();
    store.createLayout({ projectId: pid, plan: { finalMapping: { ways: [{ old: "old", fresh: "fresh" }], gone: [] } }, confirmed: {}, since });
    assert.equal(setLock(pid, store.layoutJob(pid)).ok, true);
    // A turn of the project waits at the earmark (queue) — the normal case while the job waits.
    let r = await send(ctx, "HELD");
    assert.equal(r.body.locked, true, JSON.stringify(r.body));
    const entry = r.body.entryId;
    r = await request(`${ctx.base}/api/projects/${pid}`, { method: "DELETE" });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.match(r.body.error, /Gliederungsauftrag bleibt bestehen/);
    const a = store.layoutJob(pid);
    assert.deepEqual([a?.state, a?.since], ["waiting", since], "the job stays — CT: deleting used to withdraw it BEFORE the check");
    assert.equal(startLock(ctx.chat.id, "turn")?.reason, "layout", "the earmark is back");
    assert.equal(lockStands(pid), true);
    assert.equal((await active(ctx.base)).runs, 0, "nothing woken — CT: releasing the earmark started the held turn");
    assert.equal(turns(ctx.root).filter((t) => t.text.includes("HELD")).length, 0);

    // Without the held work: 200, job, project and earmark gone.
    r = await request(`${ctx.base}/api/chats/${ctx.chat.id}/message/queue/${entry}`, { method: "DELETE" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await request(`${ctx.base}/api/projects/${pid}`, { method: "DELETE" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(store.layoutJob(pid), null, "job gone");
    assert.ok(!store.getProject(pid), "Projekt fort");
    assert.equal(lockStands(pid), false, "the memory of the job is gone");
    assert.equal(projectLocked(pid), null, "no lock stays");

    // CT for the connection: without setLayoutRevert the memory of the job stays (the row falls anyway).
    const p2 = (await projectWithFolders(ctx, "Zweites")).id;
    store.createLayout({ projectId: p2, plan: { finalMapping: { ways: [{ old: "old", fresh: "fresh" }], gone: [] } }, confirmed: {}, since: Date.now() });
    assert.equal(setLock(p2, store.layoutJob(p2)).ok, true);
    setLayoutRevert(null);
    try {
      r = await request(`${ctx.base}/api/projects/${p2}`, { method: "DELETE" });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(lockStands(p2), true, "CT: without the connection the memory of the job stays");
      assert.equal(projectLocked(p2), null, "… but the earmark does not come back (its job is gone)");
    } finally { setLayoutRevert(revertWaiting); forgetJobs(); }
  });
});

// ── (B1) re-creating beside a waiting earmark ────────────────────────────────────────────────────────────────────

test("(B1) re-creating beside a waiting layout: a start sees `error` of the instance, the re-creation gets past, `ready`, and the job goes on", async () => {
  await withJob(async ({ ctx, fd, reader, executed }) => {
    const proj = await projectWithFolders(ctx);
    const pid = proj.id;
    const id = await check(ctx, reader, pid, STEPS);
    assert.equal((await request(`${ctx.base}/api/chats/${ctx.chat.id}`, { method: "PATCH", body: { projectId: pid } })).status, 200);
    // An open upload holds the job in `waiting` (it does not hold the instance).
    let r = await inProject(ctx, pid, "/upload/begin", { method: "POST", body: { paths: [{ path: "x.txt", size: 1 }] } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const operation = r.body.operation;
    r = await takeOver(ctx, pid, { steps: STEPS, check: id });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    await quietFinished(pid);
    assert.equal(store.layoutJob(pid).state, "waiting");
    // A turn of the project waits at the earmark (queue).
    r = await send(ctx, "HELD");
    assert.equal(r.body.locked, true, JSON.stringify(r.body));

    // The container is missing, the instance is in `error`.
    dx(fd, "stop", containerName(pid));
    dx(fd, "rm", containerName(pid));
    setInstanceState(pid, "main", "error", { error: "Container missing (test)" });
    const u = startLock(ctx.chat.id, "turn");
    assert.equal(u?.kind, "error", `the reason of the instance — CT: it used to be “layout waits”: ${JSON.stringify(u)}`);
    assert.match(u.text, /Container missing \(test\)/);

    // The re-creation gets past the earmark and its queue (synchronously up to the lock).
    assert.equal(earmarkRecreate(pid, { reason: "Test B1" }), true);
    const state = recreateStatus(pid);
    assert.equal(state.last?.ok, true, `CT — it used to be “already locked (layout)”, earmarked forever: ${JSON.stringify(state)}`);
    await waitForTruthy(() => store.projectInstance(pid, "main")?.state === "ready" && !recreateStatus(pid).active, "re-created and ready");
    // `ready` => the quiet is checked: the upload keeps holding, the turn keeps waiting.
    await quietFinished(pid);
    assert.equal(store.layoutJob(pid).state, "waiting");
    assert.equal(executed.length, 0);
    assert.equal(turns(ctx.root).filter((t) => t.text.includes("HELD")).length, 0, "the held turn keeps waiting for the layout");
    // The holder gone => to the execution.
    r = await inProject(ctx, pid, "/layout/holders/stop", { method: "POST", body: { kind: "upload", id: operation } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await waitForTruthy(() => executed.length === 1, "to the execution after the re-creation");
    assert.deepEqual(executed, [{ pid, resume: false }]);
  });
});

// ── (B3) the worktree of a graph start ────────────────────────────────────────────────────────────────────────────────

test("(B3) the worktree of a graph start asks the lock (the row waits in the queue), and a running creation holds the quiet", async () => {
  await withJob(async ({ ctx }) => {
    const proj = await projectWithFolders(ctx);
    const pid = proj.id;
    assert.equal((await request(`${ctx.base}/api/chats/${ctx.chat.id}`, { method: "PATCH", body: { projectId: pid } })).status, 200);
    const now = Date.now();
    const w = store.createWorkflow({ id: crypto.randomUUID(), workspaceId: ctx.ws.id, projectId: pid, name: "wt", createdAt: now, updatedAt: now, graph: {
      nodes: [{ id: "s", type: "start", title: "Start" }, { id: "n1", type: "instruction", title: "Step", text: "Step" }, { id: "e", type: "end", title: "End" }],
      edges: [{ from: "s", to: "n1" }, { from: "n1", to: "e" }],
    } });
    store.createLayout({ projectId: pid, plan: { finalMapping: { ways: [{ old: "old", fresh: "fresh" }], gone: [] } }, confirmed: {}, since: now });
    assert.equal(setLock(pid, store.layoutJob(pid)).ok, true);
    const row = store.createGraphStart({ id: "gs-b3", chatId: ctx.chat.id, workflowId: w.id, workflowName: w.name, shortName: "wt", worktree: true, status: "earmarked" });
    assert.equal(redeem(row), null);
    let z = store.graphStart("gs-b3");
    assert.deepEqual([z.status, worktreesBeingCreated(pid)], ["waiting_lock", 0], `the row waits — CT: the worktree used to be created past the lock: ${JSON.stringify(z)}`);
    assert.match(z.reason, /Gliederung/);
    // Likewise in `running`.
    store.layoutSet(pid, { state: "running" });
    assert.equal(setLock(pid, store.layoutJob(pid)).ok, true);
    assert.equal(redeem(store.graphStart("gs-b3")), null);
    assert.equal(store.graphStart("gs-b3").status, "waiting_lock");
    assert.equal(worktreesBeingCreated(pid), 0);

    // Without a job it creates — and while that runs, it is open work and a holder (not stoppable).
    store.deleteLayoutJob(pid);
    forgetJobs();
    assert.equal(redeem(store.graphStart("gs-b3")), null);
    z = store.graphStart("gs-b3");
    assert.equal(z.status, "earmarked", JSON.stringify(z));
    assert.equal(worktreesBeingCreated(pid), 1, "the creation runs");
    assert.ok(projectIdle(pid).open.some((o) => o.reason === "worktree"), "the idle state counts it");
    assert.deepEqual(quietSync(pid).holders.map((h) => [h.kind, h.stoppable]), [["worktree", false]], "CT — it used to not hold the quiet");
    // The row stops waiting — the creation clears its worktree (if one was created) and ends.
    store.changeGraphStart("gs-b3", { status: "stopped" });
    await waitForTruthy(() => worktreesBeingCreated(pid) === 0, "the creation ended");
    assert.ok(!projectIdle(pid).open.some((o) => o.reason === "worktree"));
  });
});

// ── (B4) the beginning of the work of a core ──────────────────────────────────────────────────────────────────────────────

test("(B4) the beginning of the work of a core: graph step = beginning of its run, core without a turn = start of the picked-up agent, workflow core 0 — CT: a new core waits", async () => {
  await withJob(async ({ ctx }) => {
    const proj = await projectWithFolders(ctx);
    const pid = proj.id;
    assert.equal((await request(`${ctx.base}/api/chats/${ctx.chat.id}`, { method: "PATCH", body: { projectId: pid } })).status, 200);
    const run = store.startWorkflowRun({ id: crypto.randomUUID(), chatId: ctx.chat.id, workflowId: "wf-b4", workflowName: "B4", workspaceId: ctx.ws.id, projectId: pid });
    const since = run.startedAt + 1;
    store.createLayout({ projectId: pid, plan: { finalMapping: { ways: [{ old: "old", fresh: "fresh" }], gone: [] } }, confirmed: {}, since });
    assert.equal(setLock(pid, store.layoutJob(pid)).ok, true);
    // Every core below opens AFTER the job (its opening time is above `since`) — the clock is awaited, not a duration.
    await waitForTruthy(() => Date.now() > since, "the clock is past since");
    // The spy at the seam of the lock: it notes every verdict on a subagent (with the REAL one) and stops it — nothing starts.
    const asked = [];
    setProjectLock((chatId, purpose, o) => {
      const real = projectLock(chatId, purpose, o);
      if (purpose !== "agent") return real;
      asked.push({ parentSince: o?.parentSince ?? null, real });
      return { kind: "wait", reason: "test", state: "test", projectId: pid, text: "TEST-HOLD" };
    });
    const own = [];
    const empty = { event: () => {}, atEnd: () => {} };
    let n = 0;
    const start = (k) => assert.rejects(k.start({ description: "Review", prompt: "check" }, { parentToolUseId: `toolu_b4_${++n}` }), /TEST-HOLD/);
    try {
      const context = agentContextWithoutTurn(ctx.chat.id);
      // The core of a graph step (doRun: booking with the run id).
      const step = openAgents({ ...context, booking: { chatId: ctx.chat.id, runId: run.id, step: 1 }, hold: true, deliver: null }, empty);
      await start(step);
      assert.deepEqual(asked.at(-1), { parentSince: run.startedAt, real: null }, "the beginning of the run, through in `waiting` — CT: the opening time waited");
      // A core without a turn that picks up an agent from earlier.
      const without = openAgents({ ...context, hold: false, deliver: null }, empty);
      without.releaseFromTurn(); // like runs/do-run.js coreWithoutTurn
      without.pickUpParked({ agentId: "old-b4", status: "completed", startedAt: run.startedAt - 5, provider: "claude" });
      await start(without);
      assert.deepEqual(asked.at(-1), { parentSince: run.startedAt - 5, real: null }, "the start of the picked-up agent");
      // The own core of a dynamic workflow: 0 — the gate of its run judges beforehand with its beginning.
      const dyn = openAgents({ ...context, hold: true, deliver: null }, empty, { own: true, workflowAgent: true, sink: () => {}, deposit: { remember: () => {}, row: () => {} } });
      own.push(dyn);
      await start(dyn);
      assert.deepEqual(asked.at(-1), { parentSince: 0, real: null });
      // CT: a new core without a run — the opening time, it waits in `waiting`.
      const fresh = openAgents({ ...context, hold: true, deliver: null }, empty);
      await start(fresh);
      assert.ok(asked.at(-1).parentSince > since, JSON.stringify(asked.at(-1)));
      assert.equal(asked.at(-1).real?.kind, "wait", "CT: new work waits in `waiting`");
    } finally {
      setProjectLock(projectLock);
      closeAgentsOfTheChat(ctx.chat.id);
      for (const k of own) { try { k.close(); } catch { /* already closed */ } }
      store.updateWorkflowRunById(run.id, { status: "done" });
    }
  });
});

// ── (B6/B8) “again” before the turnaround, the failed way back ────────────────────────────────────────────────────────────

test("(B6/B8) “again” before the turnaround with a living copy => 409 COPY_OPEN, the copy holds in the quiet; a failed way back counts in layoutsOpen", async () => {
  await withJob(async ({ ctx, executed }) => {
    const proj = await projectWithFolders(ctx);
    const pid = proj.id;
    store.createLayout({ projectId: pid, plan: { finalMapping: { ways: [{ old: "old", fresh: "fresh" }], gone: [] } }, confirmed: {}, since: Date.now() });
    store.layoutSet(pid, { state: "error", turned: false, backward: false, error: "Test" });
    // `error` before the turnaround without a way back does not count for the rollback lock (CT), a failed way back does.
    assert.equal((await active(ctx.base)).layoutsOpen, 0, "CT: error before the turnaround without a way back");
    store.layoutSet(pid, { backward: true });
    assert.equal((await active(ctx.base)).layoutsOpen, 1, "it used to be 0 — a rollback to a release without layout went through");
    store.layoutSet(pid, { backward: false });

    // In `error` before the turnaround the job does not lock — a copy is created (here in the data layer, in `error`: no queue
    // builds it up). “Again” checks the situation like take-over.
    const k = store.createStackCopy({ projectId: pid, name: "k1", chatId: ctx.chat.id, state: "error" });
    let r = await inProject(ctx, pid, "/layout/job/again", { method: "POST" });
    assert.deepEqual([r.status, r.body?.code, r.body?.name], [409, "COPY_OPEN", "k1"], `CT — it used to be 202, the rebuild ran beside the copy: ${JSON.stringify(r.body)}`);
    assert.equal(store.layoutJob(pid).state, "error", "nothing changed");
    assert.equal(lockStands(pid), false);
    // The quiet knows the copy as a holder (not stoppable) — for one that is created between situation and procedure.
    assert.deepEqual(quietSync(pid).holders.map((h) => [h.kind, h.id, h.stoppable]), [["copy", String(k.id), false]]);
    // Without the copy it works: `waiting`, quiet => to the execution.
    store.changeStackCopy(k.id, { state: "removed" });
    r = await inProject(ctx, pid, "/layout/job/again", { method: "POST" });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    await waitForTruthy(() => executed.length === 1, "to the execution after “again”");
  });
});

// ── (B7) the short `running` of the quiet check ────────────────────────────────────────────────────────────────────────────

test("(B7) the quiet check at the gate: in the short `running` the readers read `waiting`, starts wait; a follow-up step held there starts after the fall back, a new message does not", async () => {
  await withJob(async ({ ctx, fd, reader, executed }) => {
    fd.openGate("exec");
    const open = [];
    const dir = tmp("proc-b7");
    try {
      const proj = await projectWithFolders(ctx);
      const pid = proj.id;
      assert.equal((await request(`${ctx.base}/api/chats/${ctx.chat.id}`, { method: "PATCH", body: { projectId: pid } })).status, 200);
      // A terminal in the project container with a command in front — only the ASYNCHRONOUS check (the container program) finds it.
      const ct = await inProject(ctx, pid, "/terminal", { method: "POST", body: { cols: 80, rows: 24 } });
      assert.equal(ct.status, 201, JSON.stringify(ct.body));
      open.push(ct.body.id);
      const pgid = await waitForTruthy(() => terminalSessions().find((s) => s.id === ct.body.id)?.pgid || null, "the group of the shell in the container");
      const c = fakeProc(dir, { itself: process.pid });
      c.process({ pid: pgid, comm: "sh", pgid, sid: pgid, tpgid: 777020, cwd: proj.path });
      c.process({ pid: 777020, comm: "vite", ppid: pgid, pgid: 777020, sid: pgid, cwd: proj.path });
      setProcSearchSeam({ root: dir });
      const id = await check(ctx, reader, pid, STEPS);
      let r = await takeOver(ctx, pid, { steps: STEPS, check: id });
      assert.equal(r.status, 202, JSON.stringify(r.body));
      await quietFinished(pid);
      assert.equal(store.layoutJob(pid).state, "waiting");
      const since = store.layoutJob(pid).since;

      // The next check holds at the exec of the container program — in the middle of the short `running`.
      gateClosed(fd, "exec");
      checkBackLayout(pid);
      await waitForTruthy(() => fs.existsSync(`${gatePath(fd, "exec")}.waiting`), "the check at the exec");
      const a = store.layoutJob(pid);
      assert.deepEqual([a.state, a.step, a.process], ["running", "quiet", BOOT_ID], "the check runs");
      assert.equal(layoutStatus(pid), "waiting", "readers see `waiting` — CT: it used to be `running` (409 LAYOUT_RUNNING)");
      assert.equal((await job(ctx, pid)).state, "waiting");
      r = await inProject(ctx, pid, "/upload/begin", { method: "POST", body: { paths: [{ path: "x.txt", size: 1 }] } });
      assert.equal(r.body?.code, "LAYOUT_WAITING", JSON.stringify(r.body));
      assert.equal(startLock(ctx.chat.id, "turn")?.phase, "running", "a start waits during the check");
      // The next step of a graph run that began before the job (the driver passes `parentSince`): it parks.
      await doRun(store.getChat(ctx.chat.id), "FOLLOW_UP", { parentSince: since - 1 });
      assert.equal(store.getPendingResume(ctx.chat.id)?.reason, "project", "the follow-up step waits in the wait row");

      // The program answers: the terminal holds => back to `waiting` => the follow-up step starts.
      fd.openGate("exec");
      await waitForTruthy(() => turns(ctx.root).some((t) => t.text.includes("FOLLOW_UP")), "the follow-up step runs after the fall back — CT: it stood until the end of the job");
      await runsNull(ctx);
      await quietFinished(pid);
      assert.equal(store.layoutJob(pid).state, "waiting", "the terminal keeps holding");
      assert.equal(executed.length, 0);
      // Used up: a later message is new work and waits.
      assert.equal(startLock(ctx.chat.id, "turn")?.kind, "wait");
    } finally {
      fd.openGate("exec");
      for (const x of open) killTerminal(x);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, { fdOpts: { execGate: "exec" } });
});
