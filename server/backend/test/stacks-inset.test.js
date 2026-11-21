// The chat moves into its copy (stacks/inset.js). Main seam over `withAgentsServer` on the fake docker
// (server/backend/test/fake-docker.mjs): a project with main container `cbase-p-<pid>` and a copy `k1` with container
// `cbase-k-<pid>-k1`, built through the REAL setters (stacks/state.js copyRequests, setCopyState) — the move-in, the wake-up
// and the move-out hang on them. The fake main agent writes one line per turn to turns.jsonl: the identifier of the instance
// from its MCP configuration (`CBASE_INSTANCE`), whether a token is present, the prompt, and whether the copy paragraph is in
// the system prompt. WHERE a turn ran is also told by the fake docker's log (`exec … <container> …`).
//
// The promises, each with the way that breaks it:
//   (1) MOVE-IN. Copy `ready` => a wake turn in the chat (occasion "event", <task-notification> with the copy) runs in the COPY
//       (identifier `<pid>/copy-k1` and a token in the MCP configuration, exec in `cbase-k-…`), the copy paragraph is in its system
//       prompt, and a later user message runs in the copy as well. Reported ONCE (mark in the journal).
//   (2) A running turn stays in main; the wake-up waits (occasion "event", never into the running turn) and becomes a follow-up
//       turn of its own in the copy that carries the silent hint where the previous one ran. A living subagent stays in main and
//       gets the silent hint (runs/agents.js reportAgentsElsewhere).
//   (3) A message to a chat whose copy is in phase `fetch` waits at the lock of ITS identifier and runs in main after `removed`.
//   (4) `ready` without an instance row => no start, a message with the word "Kopie", no docker call — neither copy nor main.
//       Two layers, each checked alone: the lock (projectbox/idle.js) and, if it is missing, doRun (instanceOfChat throws).
//   (5) Terminal of the chat bar: `chat:<id>` ends at move-in and move-out; a new terminal with this tag starts in the copy
//       (docker exec in `cbase-k-…`), the project terminal without a chat in main. The pty is a stand-in — the test holds WHERE the
//       shell starts and WHO ends it, not the shell. (12)/(12b): move-out only ends the terminal of a chat that was ever in the
//       copy and still stands in the copy's project.
//   (6) A child chat of a background graph run is pinned to the instance of its orchestrator (`graph_starts.instance`), runs there
//       after a switch too and goes back to main with the clearing away (silent hint). (6c)/(6d): the instance of the start is that
//       of the STARTING TURN — if the copy becomes ready in the middle of the turn, the child stays in main, and the repo check of
//       a worktree asks main, not the copy's snapshot.
//   (7) The core of a dynamic workflow keeps the instance of its start (agentContextWithoutTurn with an identifier). (7b) ACROSS A
//       RESTART the identifier is stored on the run (dyn_workflow_runs.instance_identifier): a workflow begun in main continues in
//       main after move-in and restart of B (dynWorkflowsRestartGrace), every agent. (7c) A workflow begun in the copy whose instance
//       is gone after the restart fails at the next agent() — no agent in main.
//   (8) Wake-up on failure of the build, on a job to remove, and in the restart grace; the failure wake-up names the DIRECT new attempt.
//   (9) Browser tab of a copy chat. (10) Fork of a chat with a copy. (11) The mark of the error wake-up blocks no later "ready"
//       (one wake-up per state). (13)/(14) The wait phase of a turn running in another instance than the chat now carries takes no
//       new turn; a waiting input ends it, a due wakeup or a monitor event becomes a queue entry, what falls with the process is
//       a notice in the log and in the next turn; the wakeup belongs to the CHAT (wakeup-over-the-turn.test.js). (15) The move-in
//       asks the project binding: a chat in another project keeps terminal and turn mark, instead of the wake-up a silent hint
//       "ready, this chat does not work in it". (16) A failed clearing away leaves the chat bound to its copy. (17) The restart
//       grace hangs a child pin on a dead copy back into main. (18) An `error` at server end does not wake; the way back into the
//       queue releases the mark and leaves a silent hint. (19) If the copy stays `error` there, the build makes up the wake-up.
//   The promises of the instance binding itself (`chats.instance`) are held by chat-instance.test.js.
//
// No clock: waits on gates, quiet and states — and EITHER on the event OR on the end of the runs (waitingForTurns, atGate): a
// start that fails turns red instead of hanging. Every connection, fake docker, environment and working instance row is taken back
// in the harness body (clearAwayCopies): the server's quiet counts them as work.
//
// COUNTER-TESTS (each shown red by one sabotage on the real tree, then reverted):
//   runs/queue.js: turnInstanceDifferent removed before injectNextRunInput               => (2) red (the wake-up would go into main's process)
//   stacks/inset.js: wake-up with occasion "agent" instead of "event"                    => (2) red (injected into the turn)
//                    mark `wakeCall` ignored (woken() removed)                             => (1), (3), (8), (10) red
//                    terminal of the bar not ended at move-in                              => (5) red
//                    woken(): mark valid for every state                                   => (1) red: (11)
//                    terminal kill condition removed entirely (`if (true)`)                => (2) red: (12), (12b)
//                    only the "ever in the copy" check removed                             => (1) red: (12)
//                    move-in(): terminal and mark without project comparison               => (1) red: (15) (terminal)
//                    wake-up() without the branch "does not work in it"                    => (1) red: (15) (wake turn)
//                    copyTransition: `if (serverEnds())` replaced by `if (false)`          => (18) red
//                    without the branch `error` -> `waiting_*` (backInTheQueue)            => (18) red
//                    copiesWakeRestartGrace does not call deadPinsBack                     => (1) red: (17)
//                    deadPinsBack without the comparison with the living copies            => (1) red: (17)
//   server.js: setInstanceForChat(instanceNameForChat) removed                            => (3) red (the turn starts in the copy being cleared away)
//   runs/do-run.js: instance of the turn via the project (main) instead of the chat       => (1), (2), (2b), (3b) red
//                   agentContextWithoutTurn without the throw on an unknown identifier    => (7) red
//   runs/instance.js: binding without a row falls back to main (G11)                      => (4), (7) red
//   projectbox/idle.js: copyMissing `return null` (the missing copy lets it through)       => (4) red (layer 1)
//   stacks/state.js: copyTransition not called                                            => (1), (2), (2b), (5), (6), (8) red
//   workflows/graph-start.js: graph_starts.instance stays empty                           => (6) red
//   store/graph-starts.js: graphStartsInstanceBack without UPDATE                         => (6) red
//   devtools/code-route.js: terminal of the bar takes the project's instance              => (5) red
//   devtools/routes.js: browser of the copy with scopeKey and profile of main             => (9) red
//   runs/system-prompt.js: no copy paragraph                                              => (1) red
//   dynworkflows/run.js: identifierTheRow always returns undefined                        => (7b), (7c) red
//   store/dynworkflow-runs.js: createDynRun always writes instance_identifier NULL         => (7b), (7c) red
//   workflows/graph-start.js: backgroundLocation without the turn branch                  => (2) red: (6c), (6d); repo check via instanceOfChat => (1) red: (6d)
//   runs/queue.js: deliverUserPrompt does not call the wait-phase yield                   => (2) red: (13), (14)
//                  injectEntry without turnInstanceDifferent                              => (1) red: (13c)
//   runs/do-run.js: injectWakeup / injectPendingMonitors without turnInstanceDifferent     => (1) red: (14b), (14c)
//                   result microtask without waitPhaseYield()                              => (1) red: (13b)
//   runs/wait-phase-yield.js: yieldNotice always null                                     => (4) red: (13), (13b), (14), (14c)
//   stacks/remove.js: copyOfTheChat without the branch `error && wasReady`                => (1) red: (16)
//                     `error` without wasReady (a never fetched copy binds too)           => (3) red: (8), (11), (12)
//   stacks/build.js: backAfterServerEnd without wakeCopyError(now)                        => (19) red
// Without the mark in the journal the guards of other files (stacks-busy, stacks-remove, stacks-remove-notice) would run into a real
// wake turn — they set the mark beforehand.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import * as store from "../electron/server/store.js";
import { copyInstance } from "../electron/server/projectbox/creation.js";
import { projectLock, wakeProject, setInstanceForChat } from "../electron/server/projectbox/idle.js";
import { setProjectLock, startLock } from "../electron/server/runs/project-lock.js";
import { instanceNameForChat } from "../electron/server/runs/instance.js";
import { agentContextWithoutTurn } from "../electron/server/runs/do-run.js";
import { deliverUserPrompt } from "../electron/server/runs/queue.js";
import { pendingRunInputs } from "../electron/server/runs/state.js";
import { wakeupNow as wakeupFire, wakeupOf } from "../electron/server/runs/wakeup.js";
import { copiesWakeRestartGrace } from "../electron/server/stacks/inset.js";
import { backAfterServerEnd } from "../electron/server/stacks/build.js";
import { serverEndMarkerForTest } from "../electron/server/runs/server-end.js";
import { PROGRAM as FILE_ACCESS_PROGRAM } from "../electron/server/runtime/fileAccess.js";
import { copyRequests, setCopyState } from "../electron/server/stacks/state.js";
import { setInstanceState } from "../electron/server/projectbox/instances.js";
import { dynWorkflowsRestartGrace } from "../electron/server/dynworkflows/run.js";
import { fakeClaude, json, withAgentsServer, LOCATION, waitForTruthy } from "./agent-harness.mjs";
import { fakeDocker } from "./fake-docker.mjs";
import { readJsonl } from "./jsonl.mjs";
import { gitLocation, createRepo } from "./projectbox-git-scenario.mjs";

// ── A fake pty ───────────────────────────────────────────────────────────────────────────────────────────────────────
// terminal.js loads node-pty lazily through require; an entry in the module cache turns that into this stand-in. It records the
// calls (program, arguments) and lives until kill() ends it — like a shell nobody closes.
const ptys = [];
let ptyHook = null; // (args) at the start of a pty — the test writes the shell's pgid file with it
{
  const req = createRequire(import.meta.url);
  const filePath = req.resolve("node-pty");
  const fake = {
    spawn(program, args) {
      const p = { program, args, killed: false, end: null, pid: 90_000 + ptys.length };
      p.kill = () => { p.killed = true; p.end?.({ exitCode: 0 }); };
      ptys.push(p);
      ptyHook?.(args);
      return {
        pid: p.pid, onData() {}, write() {}, resize() {},
        onExit(cb) { p.end = cb; },
        kill: p.kill,
      };
    },
  };
  req.cache[filePath] = { id: filePath, filename: filePath, loaded: true, exports: fake, children: [], paths: [] };
}

// ── Environment, fake docker, project ────────────────────────────────────────────────────────────────────────────────
async function withEnvironment(values, fn) {
  const saved = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(values)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
const ops = (fd) => ({ CBASE_CONTAINER: "1", CBASE_DIND: "1", CBASE_DOCKER_BIN: fd.bin, CBASE_IN_PROJECT_ESCALATION_MS: "200",
  CLAUDE_CONFIG_DIR: path.join(fd.dir, "b-home", ".claude"), CODEX_HOME: path.join(fd.dir, "b-home", ".codex") });
function containerStart(fd, name) {
  execFileSync(fd.bin, ["run", "-d", "--name", name, "cbase-projectbox:test"], { env: { ...process.env, ...fd.env } });
}
const execCalls = (fd) => fd.calls({ daemon: "host" }).filter((a) => a.args[0] === "exec");
const dockerCalls = (fd) => fd.calls({ daemon: "host" }).filter((a) => a.args[0] !== "info" && a.args[0] !== "version");
// How many `exec` into this container were a turn (the wrapper) — without the file accesses (runtime/fileAccess.js): the
// project memory of a copy chat is read by the turn start through the container, and that is not a turn (memory-copy.test.js).
const turnsIn = (fd, container) => execCalls(fd).filter((a) => a.args.includes(container) && a.args.some((x) => String(x).includes("cbase-wrapper")) && !a.args.includes(FILE_ACCESS_PROGRAM)).length;

// A project with a running main and its instance row; the harness's chat stands in it.
async function projectInOps(ctx, fd, { chat = ctx.chat } = {}) {
  const projPath = path.join(ctx.root, "workspace", "till");
  fs.mkdirSync(projPath, { recursive: true });
  const p = await ctx.projectWithoutInstance({ name: "Kasse", path: projPath });
  const main = `cbase-p-${p.id}`;
  containerStart(fd, main);
  store.createProjectInstance({ projectId: p.id, state: "ready", convertedAt: Date.now(), containerId: main });
  if (chat) await json(`${ctx.base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ projectId: p.id }) });
  return { p, main, copy: `cbase-k-${p.id}-k1`, pid: p.id, projPath };
}
// The copy through the real setters up to just before `ready` (the container already runs, as after the build start).
function copyUntilFastReady(fd, o, chatId, { withoutWakeCall = false } = {}) {
  const k = copyRequests({ projectId: o.pid, name: "k1", chatId });
  setCopyState(k.id, "build", { phase: "clone1" });
  containerStart(fd, o.copy);
  // The wake-up mark beforehand: the test then holds a copy in which the chat works without a wake turn in between.
  if (withoutWakeCall) store.writeStackCopyJournal(k.id, { data: { inset: { wakeCall: { state: "ready", at: 0 } } } });
  return k;
}
const copyReady = (k) => setCopyState(k.id, "ready", { result: { branchSpace: "copy/k1/", hints: ["Reflogs did not come along."] } });

// ── The fake main agent ──────────────────────────────────────────────────────────────────────────────────────────────
// Writes one line per turn: prompt, instance identifier (MCP configuration), token, copy paragraph. "HOLD" holds at the gate
// "hold" (a turn that is computing); "BACKGROUND" starts a background subagent that lives at the gate "sub-alive".
const MAIN = `
  { const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")).mcpServers.cbase; const env = cfg.env || {};
    fs.appendFileSync(path.join(LOCATION, "turns.jsonl"), JSON.stringify({ n: turn, text, all: JSON.stringify(msg.message.content),
      instance: env.CBASE_INSTANCE || null, token: Boolean(env.CBASE_TOKEN), copyParagraph: joined.includes("# Your copy"), cwd: process.cwd() }) + "\\n"); }
  if (text.includes("HOLD")) { await gate("hold"); }
  if (text.includes("WAKEUP")) {
    const args = { delaySeconds: 3600, prompt: "Please check", reason: "Test wakeup" };
    say({ type: "assistant", message: { id: "m-wk", content: [{ type: "tool_use", id: "toolu_wk", name: "mcp__cbase__cbase_wakeup", input: args }] } });
    const r = await mcpCall("cbase_wakeup", args);
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_wk", content: textOf(r) }] } });
  }
  if (text.includes("MONITOR_START")) {
    const args = { command: "cat '" + path.join(LOCATION, "monitor.fifo") + "'", description: "Testmonitor", persistent: true };
    say({ type: "assistant", message: { id: "m-mon", content: [{ type: "tool_use", id: "toolu_mon", name: "mcp__cbase__cbase_monitor", input: args }] } });
    const r = await mcpCall("cbase_monitor", args);
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_mon", content: textOf(r) }] } });
  }
  if (text.includes("BACKGROUND")) {
    const args = { description: "On the side", prompt: "Take a look", run_in_background: true };
    say({ type: "assistant", message: { id: "m-bg", content: [{ type: "tool_use", id: "toolu_bg", name: "mcp__cbase__cbase_agent", input: args }] } });
    const r = await mcpCall("cbase_agent", args);
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_bg", content: textOf(r) }] } });
  }
  finished();
  say({ type: "result", result: "finished", session_id: "main-session" });`;
const SUB = `
    await gate("sub-alive");
    finished();
    say({ type: "result", result: "Befund", session_id: "sub-session" });`;
const claude = fakeClaude({ main: MAIN, sub: SUB });

const turnsFile = (ctx) => path.join(ctx.root, "turns.jsonl");
const turns = (ctx) => readJsonl(turnsFile(ctx));
const quiet = (ctx) => ctx.waitForQuiet();
const send = (ctx, text, chatId = ctx.chat.id) => json(`${ctx.base}/api/chats/${chatId}/message`, { method: "POST", body: JSON.stringify({ text }) });
const runs = async (ctx) => (await json(`${ctx.base}/api/runs/active`)).runs;
// Red instead of a hang: waits on the event OR on the end of the runs — if the run ends without the fake CLI having seen its turn
// (a start that fails, e.g. under a sabotage), that is the finding, not an endless wait.
async function waitingForTurns(ctx, n, what) {
  await waitForTruthy(async () => (turns(ctx).length >= n || (await runs(ctx)) === 0 ? true : null), what);
  assert.ok(turns(ctx).length >= n, `${what}: the run ended without the fake CLI seeing a turn (${turns(ctx).length} of ${n}) — its start failed or never came`);
  return turns(ctx);
}
// The same for a gate of the fake CLI: at the gate OR run end (with `agents`: also no living subagents any more).
async function atGate(ctx, name, { agents = false } = {}) {
  const marker = path.join(ctx.root, "gates", `${name}.waiting`);
  await waitForTruthy(async () => {
    if (fs.existsSync(marker)) return true;
    const s = await json(`${ctx.base}/api/runs/active`);
    return s.runs === 0 && (!agents || !(s.agents || []).length) ? true : null;
  }, `gate ${name} or run end`);
  assert.ok(fs.existsSync(marker), `the run ended without the fake CLI reaching the gate "${name}" — its start failed`);
}

// After each test: no copy works any more — the server's quiet (harness) counts a working instance row as work
// and would otherwise wait endlessly. This belongs IN the harness body, before its quiet.
function clearAwayCopies() {
  for (const k of store.liveStackCopies()) {
    try {
      if (["build", "ready", "clearAway"].includes(k.state)) setCopyState(k.id, "error", { error: "Testende" });
      store.deleteProjectInstance(k.projectId, copyInstance(k.name));
      setCopyState(k.id, "removed");
    } catch { /* already gone */ }
  }
}

// Setting up a test environment: fake docker, server, environment; `fn(ctx, fd)`; everything back in the finally.
async function withInset(fn, opts = {}) {
  const fd = await fakeDocker();
  try {
    await withAgentsServer(async (ctx) => {
      try { await withEnvironment(ops(fd), () => fn(ctx, fd)); } finally { clearAwayCopies(); }
    }, { claude, ...opts });
  } finally { fd.cleanUp(); }
}

// ── (1) move-in and wake-up ──────────────────────────────────────────────────────────────────────────────────────────
test("(1) copy ready => wake turn (occasion event) IN the copy with copy paragraph, identifier and token; a user message afterwards likewise; the wake-up comes once", async () => {
  await withInset(async (ctx, fd) => {
    const o = await projectInOps(ctx, fd);
    const k = copyUntilFastReady(fd, o, ctx.chat.id);
    copyReady(k);
    await waitingForTurns(ctx, 1, "the wake turn");
    await quiet(ctx);
    const [wake] = turns(ctx);
    assert.match(wake.text, /^<task-notification>/, wake.text.slice(0, 200));
    assert.ok(wake.text.includes('Copy "k1" ready') && wake.text.includes("copy/k1/"), wake.text.slice(0, 600));
    assert.equal(wake.instance, `${o.pid}/${copyInstance("k1")}`, "the wake turn does not run with the copy's identifier");
    assert.equal(wake.token, true, "no token of the copy in the MCP configuration");
    assert.equal(wake.copyParagraph, true, "the copy paragraph is missing in the system prompt");
    assert.equal(turnsIn(fd, o.copy), 1, "the wake turn did not run in the copy container");
    assert.equal(turnsIn(fd, o.main), 0, "the wake turn ran in main");
    assert.equal(store.stackCopy(k.id).journal.data.inset.wakeCall.state, "ready", "the wake-up mark is missing");

    // A user message afterwards: likewise in the copy (from the turn after "ready").
    await send(ctx, "Continue");
    await waitingForTurns(ctx, 2, "the turn after the move-in");
    await quiet(ctx);
    assert.equal(turns(ctx)[1].instance, `${o.pid}/${copyInstance("k1")}`);
    assert.equal(turns(ctx)[1].copyParagraph, true);
    assert.equal(turnsIn(fd, o.copy), 2);

    // A second transition of the same copy reports nothing any more (mark); the restart grace makes up nothing.
    assert.equal(copiesWakeRestartGrace(), 0, "the restart grace woke a second time");
    await quiet(ctx);
    assert.equal(turns(ctx).length, 2);
  });
});

// ── (2) the running turn stays in main, the wake-up waits, the subagent stays ────────────────────────────────────────
test("(2) a running turn stays in main; the wake-up (occasion event) waits for its end and gets a follow-up turn of its own in the copy, with the silent hint", async () => {
  await withInset(async (ctx, fd) => {
    const o = await projectInOps(ctx, fd);
    await send(ctx, "HOLD");
    await atGate(ctx, "hold");
    assert.equal(turns(ctx)[0].instance, `${o.pid}/main`, "the running turn has the identifier of main");
    const k = copyUntilFastReady(fd, o, ctx.chat.id);
    copyReady(k); // IN THE MIDDLE of the turn
    // The turn holds at the gate: nothing else can have begun meanwhile. The wake-up stands in the chat's queue.
    assert.equal(turns(ctx).length, 1, "a second turn began while the first ran");
    ctx.gate.open("hold");
    await quiet(ctx);
    const t = turns(ctx);
    assert.equal(t.length, 2, `the wake turn is missing or went into the running turn: ${JSON.stringify(t.map((x) => x.text.slice(0, 60)))}`);
    assert.equal(t[0].instance, `${o.pid}/main`);
    assert.ok(t[1].text.includes("<task-notification>"), "the wake-up is not in the prompt of the follow-up turn");
    assert.equal(t[1].instance, `${o.pid}/${copyInstance("k1")}`, "the wake turn does not run in the copy");
    // The turn that experienced a move-in in the middle leaves the hint where it ran.
    assert.ok(t[1].all.includes("instance-switch"), "no silent hint about the move-in");
    assert.ok(t[1].all.includes("This chat's copy became ready or was cleared away"), t[1].all.slice(0, 900));
    assert.equal(turnsIn(fd, o.main), 1);
    assert.equal(turnsIn(fd, o.copy), 1);
  });
});

test("(2b) a living subagent stays in main and gets the silent hint at move-in; the follow-up turn runs in the copy", async () => {
  await withInset(async (ctx, fd) => {
    const o = await projectInOps(ctx, fd);
    await send(ctx, "BACKGROUND");
    await atGate(ctx, "sub-alive", { agents: true });
    await waitForTruthy(async () => (await json(`${ctx.base}/api/runs/active`)).runs === 0, "the turn is over (the subagent lives)");
    assert.equal(turnsIn(fd, o.main), 2, "main run and subagent in main");
    const k = copyUntilFastReady(fd, o, ctx.chat.id);
    copyReady(k);
    await waitingForTurns(ctx, 2, "the wake turn");
    const wake = turns(ctx)[1];
    assert.equal(wake.instance, `${o.pid}/${copyInstance("k1")}`);
    assert.ok(wake.all.includes("instance-switch"), "no silent hint about the subagent");
    assert.ok(wake.all.includes(`in the project container ${o.pid}/main`) && wake.all.includes(`in the project container ${o.pid}/${copyInstance("k1")}`), wake.all.slice(0, 900));
    assert.equal(turnsIn(fd, o.main), 2, "the subagent no longer ran in main");
    ctx.gate.open("sub-alive");
    await quiet(ctx);
  });
});

// ── (3) the lock per identifier ──────────────────────────────────────────────────────────────────────────────────────
test("(3) message to a chat whose copy is in phase fetch: the turn waits (nothing starts) and runs in main after removed", async () => {
  await withInset(async (ctx, fd) => {
    const o = await projectInOps(ctx, fd);
    const k = copyUntilFastReady(fd, o, ctx.chat.id, { withoutWakeCall: true });
    copyReady(k);
    setCopyState(k.id, "clearAway", { phase: "save" });
    assert.equal(store.projectInstance(o.pid, copyInstance("k1")).state, "clearAway", "the instance row goes to clearAway with `fetch`");
    await send(ctx, "After the clearing away");
    assert.equal((await json(`${ctx.base}/api/runs/active`)).runs, 0, "a turn began despite the copy's lock");
    assert.deepEqual(turns(ctx), [], "a turn ran despite the copy's lock");
    assert.deepEqual(execCalls(fd), [], "a docker exec despite the copy's lock");
    // The end of the clearing away (stacks/clearAway.js step 5): instance row gone, `removed`, then the waking.
    store.deleteProjectInstance(o.pid, copyInstance("k1"));
    setCopyState(k.id, "removed");
    wakeProject(o.pid);
    await waitingForTurns(ctx, 1, "the waiting turn after removed");
    await quiet(ctx);
    assert.equal(turns(ctx).length, 1);
    assert.equal(turns(ctx)[0].instance, `${o.pid}/main`, "the waiting turn did not run in main");
    assert.equal(turnsIn(fd, o.main), 1);
    assert.equal(turnsIn(fd, o.copy), 0, "the waiting turn ran in the cleared-away copy");
  });
});

test("(3b) built-in counter-test: if the lock judges by main (connection taken off), the turn starts in the copy that is being cleared away", async () => {
  await withInset(async (ctx, fd) => {
    const o = await projectInOps(ctx, fd);
    const k = copyUntilFastReady(fd, o, ctx.chat.id, { withoutWakeCall: true });
    copyReady(k);
    setCopyState(k.id, "clearAway", { phase: "save" });
    setInstanceForChat(null); // the error that was rejected: the lock judges by the row of main
    try {
      await send(ctx, "After the clearing away");
      // The server's quiet would never come here: the copy stands on clearAway and counts as work. Waits on the turn.
      const running = (await json(`${ctx.base}/api/runs/active`)).runs;
      assert.equal(running, 1, "even without the connection the turn waited: the counter-test shows nothing");
      await waitForTruthy(async () => (await json(`${ctx.base}/api/runs/active`)).runs === 0, "the turn is over");
    } finally { setInstanceForChat(instanceNameForChat); }
    // Without the lock of the identifier the turn begins — in the copy it would not survive: so the guard (3) is not green
    // by chance.
    assert.equal(turnsIn(fd, o.copy), 1, "even without the connection the turn waited: the counter-test shows nothing");
    assert.equal(turnsIn(fd, o.main), 0);
  });
});

// ── (4) `ready` without an instance row => lock with message, never a fallback to main ──────────────────────────────
test("(4) `ready` without an instance row: the lock reports the missing copy; if it fails, doRun throws — both times no start, no docker, nothing in main", async () => {
  await withInset(async (ctx, fd) => {
    const o = await projectInOps(ctx, fd);
    const k = copyUntilFastReady(fd, o, ctx.chat.id, { withoutWakeCall: true });
    copyReady(k);
    store.deleteProjectInstance(o.pid, copyInstance("k1")); // the row is gone, the copy stands on ready
    assert.equal(store.stackCopy(k.id).state, "ready");
    const prior = dockerCalls(fd).length;

    // Layer 1: the lock.
    const u = startLock(ctx.chat.id, "turn");
    assert.equal(u?.kind, "error", JSON.stringify(u));
    assert.ok(/Kopie/.test(u.text) && /nicht im Haupt/.test(u.text), u.text);
    await send(ctx, "Los");
    await quiet(ctx);
    assert.deepEqual(turns(ctx), [], "a turn ran without the copy");
    assert.equal(dockerCalls(fd).length, prior, "a docker call without the copy");

    // Layer 2: if the lock is missing, the start (instanceOfChat) throws — it does not fall back to main.
    setProjectLock(null);
    try {
      await send(ctx, "Go once more");
      await quiet(ctx);
    } finally { setProjectLock(projectLock); }
    assert.deepEqual(turns(ctx), [], "without the lock a turn ran in main");
    assert.equal(turnsIn(fd, o.main), 0);
    assert.equal(dockerCalls(fd).length, prior, "without the lock a docker call went out");
  });
});

// ── (5) the terminal of the chat bar ─────────────────────────────────────────────────────────────────────────────────
test("(5) terminal `chat:<id>`: ends at move-in and at move-out; a fresh one starts in the copy (or again in main); the project terminal stays", async () => {
  const corpses = [];
  await withInset(async (ctx, fd) => {
    const o = await projectInOps(ctx, fd);
    const before = ptys.length;
    // The fake pty writes the shell's pgid file like the real wrapper in the container: a real group (sleep) that the group
    // kill hits. Otherwise the kill would wait forever for a file nobody writes.
    const group = (args) => {
      const i = args.indexOf("--pgid-file");
      if (i < 0) return;
      const subprocess = spawn("/bin/sleep", ["100000"], { detached: true, stdio: "ignore" });
      corpses.push(subprocess);
      fs.mkdirSync(path.dirname(args[i + 1]), { recursive: true });
      fs.writeFileSync(args[i + 1], String(subprocess.pid));
    };
    ptyHook = group;
    const open = async (tag) => {
      const t = await json(`${ctx.base}/api/projects/${o.pid}/terminal`, { method: "POST", body: JSON.stringify({ cols: 80, rows: 24, ...(tag ? { tag } : {}) }) });
      assert.equal(t.available, true, JSON.stringify(t));
      return ptys[ptys.length - 1];
    };
    const bar = await open(`chat:${ctx.chat.id}`);
    const project = await open("");
    assert.ok(bar.args.includes(o.main) && project.args.includes(o.main), "without a copy both start in main");

    const k = copyUntilFastReady(fd, o, ctx.chat.id, { withoutWakeCall: true });
    copyReady(k); // move-in
    assert.equal(bar.killed, true, "the chat bar's terminal lives after the move-in");
    assert.equal(project.killed, false, "the project terminal was ended");
    const fresh = await open(`chat:${ctx.chat.id}`);
    assert.ok(fresh.args.includes(o.copy) && !fresh.args.includes(o.main), "the bar's new terminal does not start in the copy");
    const other = await open("chat:ffffffff-0000-4000-8000-000000000000");
    assert.ok(other.args.includes(o.main), "the terminal of a foreign chat starts in the copy");

    setCopyState(k.id, "clearAway", { phase: "save" });
    store.deleteProjectInstance(o.pid, copyInstance("k1"));
    setCopyState(k.id, "removed"); // move-out
    assert.equal(fresh.killed, true, "the terminal in the copy lives after the move-out");
    assert.equal(project.killed, false);
    const back = await open(`chat:${ctx.chat.id}`);
    assert.ok(back.args.includes(o.main), "the terminal after the move-out does not start in main");
    assert.ok(ptys.length > before);
    for (const p of ptys.slice(before)) if (!p.killed) p.kill?.();
  }).finally(() => { ptyHook = null; for (const l of corpses) { try { process.kill(-l.pid, "SIGKILL"); } catch { /* gone */ } } });
});

// ── (6) child chats of graph runs ────────────────────────────────────────────────────────────────────────────────────
// The orchestrator stands in the copy and starts a workflow in the background (cbase_workflow_start through the real MCP server):
// the row carries the copy's identifier, the child chat runs there — and goes back to main with the clearing away.
const GRAPH = `
  { const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")).mcpServers.cbase; const env = cfg.env || {};
    fs.appendFileSync(path.join(LOCATION, "turns.jsonl"), JSON.stringify({ n: turn, text, all: JSON.stringify(msg.message.content),
      instance: env.CBASE_INSTANCE || null, token: Boolean(env.CBASE_TOKEN), copyParagraph: joined.includes("# Your copy") }) + "\\n"); }
  const step = String(text).includes("[cbase workflow");
  const before = (String(text).match(/TORVOR:(\\w+)/) || [])[1];
  if (before && !step) await gate(before);
  const g = text.indexOf("GS[");
  if (g >= 0 && !step) {
    const gtag = text.slice(g + 3, text.indexOf("]:", g));
    const args = JSON.parse(text.slice(text.indexOf("]:", g) + 2, text.indexOf("§", g)));
    const id = "toolu_gs_" + gtag;
    say({ type: "assistant", message: { id: "a-" + gtag + "-" + turn, content: [{ type: "tool_use", id, name: "mcp__cbase__cbase_workflow_start", input: args }] } });
    let t = "";
    try { const r = await mcpCall("cbase_workflow_start", args); t = (r.result && r.result.isError ? "FEHLER " : "") + textOf(r); }
    catch (e) { t = "FEHLER " + (e && e.message ? e.message : String(e)); }
    fs.appendFileSync(path.join(LOCATION, "gs-" + gtag + ".jsonl"), JSON.stringify({ t }) + "\\n");
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: t }] } });
  }
  const hold = (String(text).match(/HALT:(\\w+)/) || [])[1];
  if (hold && step) await gate(hold);
  finished();
  say({ type: "result", result: step ? "DONE" : "Gestartet.", session_id: "s-main" });`;

function newWorkflow(ws, projectId, name, text) {
  const now = Date.now();
  const w = store.createWorkflow({ id: crypto.randomUUID(), workspaceId: ws.id, projectId, name, createdAt: now, updatedAt: now, graph: {
    nodes: [{ id: "s", type: "start", title: "Start" }, { id: "n1", type: "instruction", title: "Step", text }, { id: "e", type: "end", title: "End" }],
    edges: [{ from: "s", to: "n1" }, { from: "n1", to: "e" }],
  } });
  return store.updateWorkflow(w.id, { run: { doneAll: false } });
}

test("(6) a background run in a copy's chat: graph_starts.instance carries the copy, the child chat runs there; after the clearing away the column is empty and the child chat runs in main", async () => {
  await withInset(async (ctx, fd) => {
    const o = await projectInOps(ctx, fd);
    const w = newWorkflow(ctx.ws, o.pid, "Hinter Grund", "HINTER HALT:k");
    const k = copyUntilFastReady(fd, o, ctx.chat.id, { withoutWakeCall: true });
    copyReady(k);
    const orch = store.getChat(ctx.chat.id);
    const text = `In the background please GS[a]:{"workflow":"back-ground","input":"in the back","background":true}§`;
    deliverUserPrompt(orch, { prompt: text, display: text, cause: "user",
      announcement: { id: "ann-h", workflows: [{ workflowId: w.id, shortName: "back-ground", name: w.name }], attachments: [] } });
    await waitForTruthy(async () => (readJsonl(path.join(ctx.root, "gs-a.jsonl")).length || (await runs(ctx)) === 0 ? true : null), "tool result of the start or run end");
    const [res] = readJsonl(path.join(ctx.root, "gs-a.jsonl"));
    assert.ok(res, "the orchestrator does not call cbase_workflow_start — its start failed");
    assert.ok(!res.t.startsWith("FEHLER "), res.t);
    const { start } = JSON.parse(res.t);
    const row = store.graphStart(start.startId);
    const identifier = `${o.pid}/${copyInstance("k1")}`;
    assert.equal(row.instance, identifier, "the row of the background start does not carry the orchestrator's copy");
    const childId = row.childChatId;
    assert.ok(childId && childId !== ctx.chat.id);
    await atGate(ctx, "k"); // the child chat's step runs
    const kindTurn = turns(ctx).find((t) => t.text.includes("[cbase workflow"));
    assert.equal(kindTurn.instance, identifier, "the child chat does not run in the instance of its orchestrator");
    assert.equal(instanceNameForChat(childId, o.pid), copyInstance("k1"));
    ctx.gate.open("k");
    await quiet(ctx);

    // The move-out: the copy is cleared away — the column goes back to main, the child chat gets a silent hint.
    setCopyState(k.id, "clearAway", { phase: "save" });
    store.deleteProjectInstance(o.pid, copyInstance("k1"));
    setCopyState(k.id, "removed");
    assert.equal(store.graphStart(start.startId).instance, "", "the column stayed on the cleared-away copy");
    assert.equal(instanceNameForChat(childId, o.pid), "main");
    assert.ok(store.openHints(childId).some((h) => h.text.includes("abgeräumt")), "no silent hint in the child chat");
    const prior = turns(ctx).length;
    await send(ctx, "Nachlauf", childId);
    await waitingForTurns(ctx, prior + 1, "the child chat's turn in main");
    await quiet(ctx);
    assert.equal(turns(ctx)[prior].instance, `${o.pid}/main`, "the child chat does not run in main after the clearing away");
  }, { claude: fakeClaude({ main: GRAPH }) });
});

test("(6b) a child chat without a copy identifier (started in main or before the column) stays in main even if its orchestrator has a copy — a child never switches in the middle of a run", async () => {
  await withInset(async (ctx, fd) => {
    const o = await projectInOps(ctx, fd);
    const w = newWorkflow(ctx.ws, o.pid, "Hinter Grund", "HINTER");
    // The background start begins in MAIN …
    const orch = store.getChat(ctx.chat.id);
    const text = `In the background please GS[b]:{"workflow":"back-ground","input":"x","background":true}§`;
    deliverUserPrompt(orch, { prompt: text, display: text, cause: "user",
      announcement: { id: "ann-b", workflows: [{ workflowId: w.id, shortName: "back-ground", name: w.name }], attachments: [] } });
    await waitForTruthy(async () => (readJsonl(path.join(ctx.root, "gs-b.jsonl")).length || (await runs(ctx)) === 0 ? true : null), "tool result of the start or run end");
    const [res] = readJsonl(path.join(ctx.root, "gs-b.jsonl"));
    assert.ok(res, "the orchestrator does not call cbase_workflow_start — its start failed");
    const { start } = JSON.parse(res.t);
    await quiet(ctx);
    assert.equal(store.graphStart(start.startId).instance, "", "started in main: no identifier");
    // … then the orchestrator moves into a copy: the child stays in main.
    const k = copyUntilFastReady(fd, o, ctx.chat.id, { withoutWakeCall: true });
    copyReady(k);
    const childId = store.graphStart(start.startId).childChatId;
    assert.equal(instanceNameForChat(ctx.chat.id, o.pid), copyInstance("k1"));
    assert.equal(instanceNameForChat(childId, o.pid), "main", "the child switched into the copy with the orchestrator");
  }, { claude: fakeClaude({ main: GRAPH }) });
});

// ── (6c)/(6d) the pin of a background start is the instance of the STARTING TURN ──────────────────────────────────────────────
// If the copy becomes ready in the middle of the turn, the turn stays in main (the running turn stays) — and with it everything it
// starts (dynworkflows/run.js, the turn's subagents). graph-start.js used to take the chat's BINDING (instanceOfChat) for
// `graph_starts.instance` and for the repo check of a worktree, which already points at the copy after move-in: the child ran in the
// copy, its orchestrator turn in main, and a worktree was checked against the repos of the snapshot in which the turn never works.
// The orchestrator holds BEFORE its start at a gate ("before"), meanwhile the copy becomes ready.
async function startAfterInset(ctx, fd, { tag, worktree = false }) {
  const o = await projectInOps(ctx, fd);
  if (worktree) createRepo(o.projPath, worktree.env);
  const w = newWorkflow(ctx.ws, o.pid, "Hinter Grund", "HINTER HALT:k");
  const text = `TORVOR:before In the background please GS[${tag}]:${JSON.stringify({ workflow: "back-ground", input: "x", background: true, ...(worktree ? { worktree: true } : {}) })}§`;
  deliverUserPrompt(store.getChat(ctx.chat.id), { prompt: text, display: text, cause: "user",
    announcement: { id: `an-${tag}`, workflows: [{ workflowId: w.id, shortName: "back-ground", name: w.name }], attachments: [] } });
  await atGate(ctx, "before");
  assert.equal(turns(ctx)[0].instance, `${o.pid}/main`, "precondition: the orchestrator's turn runs in main");
  const k = copyUntilFastReady(fd, o, ctx.chat.id, { withoutWakeCall: true });
  copyReady(k); // IN THE MIDDLE of the turn: the chat binds to the copy from now on, the turn stays in main
  assert.equal(instanceNameForChat(ctx.chat.id, o.pid), copyInstance("k1"), "precondition: the chat has moved into the copy");
  ctx.gate.open("before");
  const file = path.join(ctx.root, `gs-${tag}.jsonl`);
  await waitForTruthy(async () => (readJsonl(file).length || (await runs(ctx)) === 0 ? true : null), "tool result of the start or run end");
  const [res] = readJsonl(file);
  assert.ok(res, "the orchestrator does not call cbase_workflow_start — its start failed");
  assert.ok(!res.t.startsWith("FEHLER "), `the start failed: ${res.t.slice(0, 300)}`);
  const row = store.graphStart(JSON.parse(res.t).start.startId);
  assert.equal(row.instance, "", `the child chat was pinned to the chat's binding (${row.instance}), not to the instance of the starting turn (main)`);
  await atGate(ctx, "k"); // the child chat's step runs
  const kindTurn = turns(ctx).find((t) => t.text.includes("[cbase workflow"));
  assert.equal(kindTurn.instance, `${o.pid}/main`, "the child chat does not run in the instance of the turn that started it");
  assert.equal(instanceNameForChat(row.childChatId, o.pid), "main");
  return { o, row };
}

test("(6c) when the copy becomes ready in the middle of the turn, a background start pins its child to the instance of the TURN (main), not to the chat's new binding", async () => {
  await withInset(async (ctx, fd) => {
    try { await startAfterInset(ctx, fd, { tag: "c" }); }
    finally { ctx.gate.open("before"); ctx.gate.open("k"); }
    await quiet(ctx);
  }, { claude: fakeClaude({ main: GRAPH }) });
});

test("(6d) the same with a worktree — the repo check asks the instance of the turn (main, its repo), not the copy (whose snapshot is missing here); the worktree arises in main", async () => {
  const g = gitLocation("cbase-inset7-");
  try {
    await withInset(async (ctx, fd) => {
      try {
        const { row } = await startAfterInset(ctx, fd, { tag: "d", worktree: g });
        const z = store.graphStart(row.id);
        assert.ok(z.worktreePath && !z.worktreePath.includes("copy-worktrees"), `the worktree is not in main: ${z.worktreePath}`);
      } finally { ctx.gate.open("before"); ctx.gate.open("k"); }
      await quiet(ctx);
    }, { claude: fakeClaude({ main: GRAPH }) });
  } finally { fs.rmSync(g.location, { recursive: true, force: true }); }
});

// ── (7) the core without a turn ──────────────────────────────────────────────────────────────────────────────────────
test("(7) agentContextWithoutTurn: without an argument the instance of the chat (the copy), with an identifier the named one; a copy that no longer exists throws — no core in main", async () => {
  await withInset(async (ctx, fd) => {
    const o = await projectInOps(ctx, fd);
    const k = copyUntilFastReady(fd, o, ctx.chat.id, { withoutWakeCall: true });
    copyReady(k);
    const copy = `${o.pid}/${copyInstance("k1")}`;
    assert.equal(agentContextWithoutTurn(ctx.chat.id).instance.identifier, copy, "the core of a chat in the copy does not open in the copy");
    assert.equal(agentContextWithoutTurn(ctx.chat.id, { identifier: `${o.pid}/main` }).instance.identifier, `${o.pid}/main`, "the pinned identifier of main does not apply");
    assert.equal(agentContextWithoutTurn(ctx.chat.id, { identifier: null }).instance, null);
    assert.throws(() => agentContextWithoutTurn(ctx.chat.id, { identifier: `${o.pid}/copy-away` }), /gibt es nicht mehr/);
    // The copy is gone, the chat still binds to it (ready without a row): the core throws instead of opening in main.
    store.deleteProjectInstance(o.pid, copyInstance("k1"));
    assert.throws(() => agentContextWithoutTurn(ctx.chat.id), (e) => e.code === "COPY_LOCKED", "the core opened despite the missing copy");
  });
});

// ── (7b)/(7c) the instance across the restart of B ────────────────────────────────────────────────────────────────────────────
// A main agent that calls "WF[<tag>] {json}" as cbase_dynamic_workflow (result under wf-<tag>), and workflow agents that write their
// instance (CBASE_INSTANCE of the MCP configuration) to wf-agents.jsonl on each spawn; {TAG x} names, {GATE x} holds at the gate
// x-<spawn count>. A completion message is only answered by the main agent.
const WF_MAIN = `
  const wf = text.indexOf("WF[");
  if (wf >= 0 && !text.includes("<task-notification>")) {
    const tag = text.slice(wf + 3, text.indexOf("]:", wf));
    const args = JSON.parse(text.slice(text.indexOf("]:", wf) + 2));
    const id = "toolu_wf_" + tag;
    say({ type: "assistant", message: { id: "a-" + tag, content: [{ type: "tool_use", id, name: "mcp__cbase__cbase_dynamic_workflow", input: args }] } });
    let t = "";
    try { const r = await mcpCall("cbase_dynamic_workflow", args); t = (r.result && r.result.isError ? "FEHLER " : "") + textOf(r); } catch (e) { t = "FEHLER " + (e && e.message ? e.message : String(e)); }
    { const z = path.join(LOCATION, "wf-" + tag); fs.writeFileSync(z + ".teil", t); fs.renameSync(z + ".teil", z); }
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: t }] } });
  }
  say({ type: "assistant", message: { id: "c-" + Date.now(), content: [{ type: "text", text: "Antwort " + turn }] } });
  finished();
  say({ type: "result", result: "Antwort " + turn, session_id: "main-session" });`;
const WF_SUB = `
    const ab = text.lastIndexOf("Here is the task:");
    const job = ab >= 0 ? text.slice(ab) : text;
    const tag = job.includes("{TAG:") ? job.split("{TAG:")[1].split("}")[0] : "x";
    fs.appendFileSync(path.join(LOCATION, "sub-start-" + tag), "x");
    const seq = fs.readFileSync(path.join(LOCATION, "sub-start-" + tag), "utf8").length;
    { const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")).mcpServers.cbase; const env = cfg.env || {};
      fs.appendFileSync(path.join(LOCATION, "wf-agents.jsonl"), JSON.stringify({ tag, seq, instance: env.CBASE_INSTANCE || null }) + "\\n"); }
    say({ type: "assistant", message: { id: "s-" + tag + seq, content: [{ type: "text", text: "arbeite " + tag }] } });
    if (job.includes("{GATE:")) await gate(job.split("{GATE:")[1].split("}")[0] + "-" + seq);
    finished();
    say({ type: "result", result: "Befund " + tag + " #" + seq, session_id: "sub-" + tag + seq });`;
const WF_CLAUDE = fakeClaude({ main: WF_MAIN, sub: WF_SUB });
const wfAgents = (ctx) => readJsonl(path.join(ctx.root, "wf-agents.jsonl"));
const WF_SCRIPT = [
  "export const meta = { name: 'gl33', description: 'Instance across the restart', phases: [{ title: 'One' }] }",
  "const a = await agent('A {TAG:a} {GATE:a}', { label: 'a' });",
  "const b = await agent('B {TAG:b}', { label: 'b' });",
  "return { a, b };",
].join("\n");
async function wfStart(ctx) {
  await json(`${ctx.base}/api/chats/${ctx.chat.id}`, { method: "PATCH", body: JSON.stringify({ model: "claude-opus-5-5", ultracode: true }) });
  await send(ctx, `WF[w]:${JSON.stringify({ script: WF_SCRIPT })}`);
  const file = path.join(ctx.root, "wf-w");
  await waitForTruthy(async () => (fs.existsSync(file) || (await runs(ctx)) === 0 ? true : null), "the tool result");
  assert.ok(fs.existsSync(file), "the turn ended without the tool answering");
  const t = fs.readFileSync(file, "utf8");
  assert.ok(!t.startsWith("FEHLER "), t);
  return JSON.parse(t);
}
// Red instead of a hang: at the gate OR the run is over (the resumed agent failed before the spawn).
async function atWfGate(ctx, runId, name) {
  const marker = path.join(ctx.root, "gates", `${name}.waiting`);
  await waitForTruthy(() => (fs.existsSync(marker) || store.readDynRun(runId)?.status !== "running" ? true : null), `gate ${name} or run end`);
}
// The restart of B: startServer earmarks the converted rows as `start` BEFORE listening (projectbox/restore.js) — here without
// restoration back to `ready`, afterwards the restart grace of the dynamic workflows (the hook "dyn-workflows") alone.
async function restartWithResumption(ctx, o, runId, instances) {
  await ctx.restart({ withBackground: true });
  assert.equal(store.readDynRun(runId).status, "interrupted");
  for (const inst of instances) setInstanceState(o.pid, inst, "ready");
  dynWorkflowsRestartGrace();
}

test("(7b) across the restart: a workflow begun in main continues in MAIN after move-in and restart of B — the identifier is stored on the run (dyn_workflow_runs)", async () => {
  await withInset(async (ctx, fd) => {
    const o = await projectInOps(ctx, fd);
    const r = await wfStart(ctx);
    assert.equal(r.status, "started", JSON.stringify(r));
    await atWfGate(ctx, r.runId, "a-1");
    assert.deepEqual(wfAgents(ctx).map((z) => [z.tag, z.seq, z.instance]), [["a", 1, `${o.pid}/main`]]);
    // Move-in while the workflow runs: from now on the chat works in the copy.
    const k = copyUntilFastReady(fd, o, ctx.chat.id, { withoutWakeCall: true });
    copyReady(k);
    assert.equal(instanceNameForChat(ctx.chat.id, o.pid), copyInstance("k1"));

    await restartWithResumption(ctx, o, r.runId, ["main", copyInstance("k1")]);
    await atWfGate(ctx, r.runId, "a-2");
    ctx.gate.open("a-2");
    const end = await waitForTruthy(() => (store.readDynRun(r.runId)?.status !== "running" ? store.readDynRun(r.runId) : null), "run finished");
    await quiet(ctx);
    // Every agent of the workflow ran in main — before the restart AND after, although the chat meanwhile works in the copy.
    assert.deepEqual(wfAgents(ctx).map((z) => [z.tag, z.seq, z.instance]), [["a", 1, `${o.pid}/main`], ["a", 2, `${o.pid}/main`], ["b", 1, `${o.pid}/main`]],
      "after the restart the workflow ran in the chat's current instance (W23: split across two instances)");
    assert.equal(end.status, "finished", end.error);
    assert.equal(end.instanceIdentifier, `${o.pid}/main`, "the identifier is not on the run");
    // (The completion message afterwards is a turn of the CHAT — it runs in its copy; hence only the agents count here.)
  }, { claude: WF_CLAUDE });
});

test("(7c) across the restart: a workflow begun in the copy whose instance is gone after the restart fails — no agent in main", async () => {
  await withInset(async (ctx, fd) => {
    const o = await projectInOps(ctx, fd);
    const k = copyUntilFastReady(fd, o, ctx.chat.id, { withoutWakeCall: true });
    copyReady(k);
    const copy = `${o.pid}/${copyInstance("k1")}`;
    const r = await wfStart(ctx);
    assert.equal(r.status, "started", JSON.stringify(r));
    await atWfGate(ctx, r.runId, "a-1");
    assert.deepEqual(wfAgents(ctx).map((z) => [z.tag, z.seq, z.instance]), [["a", 1, copy]]);

    // The copy is cleared away while B restarts: the chat works in main afterwards — but the workflow began in the copy.
    await ctx.restart({ withBackground: true });
    assert.equal(store.readDynRun(r.runId).status, "interrupted");
    setCopyState(k.id, "clearAway", { phase: "save" });
    store.deleteProjectInstance(o.pid, copyInstance("k1"));
    setCopyState(k.id, "removed");
    setInstanceState(o.pid, "main", "ready");
    assert.equal(instanceNameForChat(ctx.chat.id, o.pid), "main");
    dynWorkflowsRestartGrace();
    await atWfGate(ctx, r.runId, "a-2");
    // Checked at once, not only at the run end: an agent that started in main stands at the gate and would hold the run open.
    assert.deepEqual(wfAgents(ctx).map((z) => [z.tag, z.seq, z.instance]), [["a", 1, copy]],
      "the resumed workflow started an agent — in main instead of its copy");
    const end = await waitForTruthy(() => (store.readDynRun(r.runId)?.status !== "running" ? store.readDynRun(r.runId) : null), "run finished");
    await quiet(ctx);
    assert.equal(end.status, "failed", JSON.stringify(end));
    assert.match(end.error, /gibt es nicht mehr/, end.error);
    assert.equal(end.instanceIdentifier, copy, "the identifier is not on the run");
  }, { claude: WF_CLAUDE });
});

// ── (8) the wake-up on failure, on a job to remove, and in the restart grace ─────────────────────────────────────────────────
test("(8) failure of the build => wake turn in main with the reason; a row with a job to remove never wakes; the restart grace makes up a lost wake-up", async () => {
  await withInset(async (ctx, fd) => {
    const o = await projectInOps(ctx, fd);
    // Failure: the chat learns it (occasion event) and keeps working in main.
    const f = copyRequests({ projectId: o.pid, name: "k1", chatId: ctx.chat.id });
    setCopyState(f.id, "build", { phase: "clone1" });
    setCopyState(f.id, "error", { error: "not enough memory" });
    await waitingForTurns(ctx, 1, "the wake turn after the failure");
    await quiet(ctx);
    const [t1] = turns(ctx);
    assert.ok(t1.text.includes("not built") && t1.text.includes("not enough memory"), t1.text.slice(0, 500));
    // A new attempt goes DIRECTLY with cbase_copy_stack (another copy); cbase_copy_stack_remove removes the leftovers or releases the
    // name — that both succeed is held by stacks-routes.test.js (3) and stacks-new-attempt.test.js (1).
    assert.ok(t1.text.includes("cbase_copy_stack_remove") && /A new attempt goes directly with cbase_copy_stack at any time \(/.test(t1.text),
      `the failure wake-up does not name cbase_copy_stack_remove and the direct new attempt: ${t1.text.slice(0, 800)}`);
    assert.equal(t1.instance, `${o.pid}/main`, "the wake turn after the failure does not run in main");
    assert.equal(t1.copyParagraph, false);
    store.deleteProjectInstance(o.pid, copyInstance("k1"));
    setCopyState(f.id, "removed");

    // With a job to remove ("clear away right after ready"): no wake-up.
    const g = copyRequests({ projectId: o.pid, name: "k2", chatId: ctx.chat.id });
    setCopyState(g.id, "build", { phase: "clone1" });
    containerStart(fd, `cbase-k-${o.pid}-k2`);
    // Reason "project-deleted".
    store.writeStackCopyJournal(g.id, { data: { trigger: { reason: "project-deleted", from: { who: "cbase" }, retrieve: [], automatic: true, since: 1 } } });
    copyReady(g);
    await quiet(ctx);
    assert.equal(turns(ctx).length, 1, "a copy with a job to remove woke the chat");
    assert.equal(store.stackCopy(g.id).journal.data.inset, undefined);
    store.deleteProjectInstance(o.pid, copyInstance("k2"));
    setCopyState(g.id, "error", { error: "Testende" });
    setCopyState(g.id, "removed");

    // Restart grace: ready, but the wake-up was lost (no mark) => made up once.
    const h = copyRequests({ projectId: o.pid, name: "k3", chatId: ctx.chat.id });
    setCopyState(h.id, "build", { phase: "clone1" });
    containerStart(fd, `cbase-k-${o.pid}-k3`);
    store.writeStackCopyJournal(h.id, { data: { inset: { wakeCall: { state: "ready", at: 0 } } } });
    copyReady(h);
    await quiet(ctx);
    assert.equal(turns(ctx).length, 1, "the mark did not hold the wake-up back");
    store.writeStackCopyJournal(h.id, { data: { inset: null } }); // the server ended between transition and wake-up
    assert.equal(copiesWakeRestartGrace(), 1);
    await waitingForTurns(ctx, 2, "the made-up wake turn");
    await quiet(ctx);
    assert.equal(turns(ctx)[1].instance, `${o.pid}/${copyInstance("k3")}`);
    assert.equal(copiesWakeRestartGrace(), 0, "the restart grace woke a second time");
  });
});

// ── (9) the browser tab of a copy chat ───────────────────────────────────────────────────────────────────────────────────
test("(9) /browser/ensure?chat=: the Chromium of a copy's chat starts in its container with its OWN profile; without ?chat (and in main) it stays proj-<id> in main", async () => {
  await withInset(async (ctx, fd) => {
    const chromium = path.join(ctx.root, "chromium");
    fs.writeFileSync(chromium, "#!/bin/sh\necho no Chromium >&2\nexit 1\n");
    fs.chmodSync(chromium, 0o755);
    await withEnvironment({ CBASE_CHROMIUM: chromium }, async () => {
      const o = await projectInOps(ctx, fd);
      const k = copyUntilFastReady(fd, o, ctx.chat.id, { withoutWakeCall: true });
      copyReady(k);
      // A browser start needs the instance's IP (the DevTools port is read from B).
      store.changeProjectInstance(o.pid, "main", { ip: "127.0.0.1" });
      store.changeProjectInstance(o.pid, copyInstance("k1"), { ip: "127.0.0.1" });
      const starts = async (query) => {
        const prior = execCalls(fd).length;
        await fetch(`${ctx.base}/api/projects/${o.pid}/browser/ensure${query}`, { method: "POST", headers: { "Content-Type": "application/json", Connection: "close" }, body: "{}" }).then((r) => r.json());
        return execCalls(fd).slice(prior).filter((a) => a.args.some((x) => String(x).includes(chromium)));
      };
      const inCopy = await starts(`?chat=${ctx.chat.id}`);
      assert.ok(inCopy.length && inCopy.every((a) => a.args.includes(o.copy) && !a.args.includes(o.main)), "the browser does not start in the copy");
      assert.ok(inCopy.some((a) => a.args.some((x) => String(x).includes(`proj-${o.pid}@${copyInstance("k1")}`))), "the copy shares main's profile");
      const inMain = await starts("");
      assert.ok(inMain.length && inMain.every((a) => a.args.includes(o.main) && !a.args.includes(o.copy)), "without ?chat the browser does not start in main");
      assert.ok(inMain.every((a) => !a.args.some((x) => String(x).includes("@copy-"))), "the profile of main carries the copy in its name");
    });
  });
});

// ── (10) fork of a chat with a copy ──────────────────────────────────────────────────────────────────────────────────────
test("(10) a fork of a chat in the copy runs in main — the silent hint says so; a fork without a copy gets none", async () => {
  await withInset(async (ctx, fd) => {
    const o = await projectInOps(ctx, fd);
    const without = await json(`${ctx.base}/api/chats/${ctx.chat.id}/fork`, { method: "POST", body: "{}" });
    assert.deepEqual(store.openHints(without.id), [], "a fork without a copy got a hint");
    const k = copyUntilFastReady(fd, o, ctx.chat.id, { withoutWakeCall: true });
    copyReady(k);
    const fork = await json(`${ctx.base}/api/chats/${ctx.chat.id}/fork`, { method: "POST", body: "{}" });
    assert.equal(instanceNameForChat(fork.id, o.pid), "main", "the fork belongs to the original's copy");
    const h = store.openHints(fork.id);
    assert.equal(h.length, 1);
    assert.ok(h[0].text.includes("Fork eines Chats") && h[0].text.includes("„k1“") && h[0].text.includes("im Haupt"), h[0].text);
    // A copy belongs to no chat — the old sentence "the copy belongs to the original" made the fork agent take it for foreign property.
    // The hint now names where the original works, where the fork works, and the way in. Counter-test (old sentence inserted into
    // runs/routes.js): red with "the fork takes the copy for the original's property". (The anchor is the German text under uiLang "de".)
    assert.ok(!h[0].text.includes("gehört dem Original"), `the fork takes the copy for the original's property: ${h[0].text}`);
    assert.ok(h[0].text.includes("in copy-k1 arbeitet") && h[0].text.includes("Dieser Fork arbeitet in main"), h[0].text);
    assert.ok(h[0].text.includes("cbase_switch_instance") && h[0].text.includes("„copy-k1“"), `the way into the copy is missing: ${h[0].text}`);
    await send(ctx, "In the fork", fork.id);
    await waitingForTurns(ctx, 1, "the fork's turn");
    await quiet(ctx);
    assert.equal(turns(ctx)[0].instance, `${o.pid}/main`, "the fork did not run in main");
    assert.ok(turns(ctx)[0].all.includes("Fork eines Chats"), "the hint did not reach the fork's turn");
  });
});

// ── (11) the mark of the error wake-up blocks no later "ready" ───────────────────────────────────────────────────────────────
test("(11) error (wake-up) -> back into the queue (server end) -> built again -> ready: the chat also gets the ready wake-up, one per state", async () => {
  await withInset(async (ctx, fd) => {
    const o = await projectInOps(ctx, fd);
    const k = copyRequests({ projectId: o.pid, name: "k1", chatId: ctx.chat.id });
    setCopyState(k.id, "build", { phase: "clone1" });
    setCopyState(k.id, "error", { error: "server end in the middle of the freeze" });
    await waitingForTurns(ctx, 1, "the error wake-up");
    await quiet(ctx);
    assert.equal(store.stackCopy(k.id).journal.data.inset.wakeCall.state, "error");
    // backAfterServerEnd (stacks/build.js): the same row back into the queue, instance row gone, the mark stays.
    store.deleteProjectInstance(o.pid, copyInstance("k1"));
    setCopyState(k.id, "waiting_queue", { reason: "server end in the middle of the build" });
    setCopyState(k.id, "build", { phase: "clone1" });
    containerStart(fd, o.copy);
    copyReady(k);
    await waitingForTurns(ctx, 2, "the ready wake-up after the error wake-up");
    await quiet(ctx);
    const t = turns(ctx);
    assert.ok(t[1].text.includes('Copy "k1" ready'), t[1].text.slice(0, 300));
    assert.equal(t[1].instance, `${o.pid}/${copyInstance("k1")}`);
    assert.equal(store.stackCopy(k.id).journal.data.inset.wakeCall.state, "ready");
    assert.equal(copiesWakeRestartGrace(), 0, "the restart grace woke a second time");
    await quiet(ctx);
    assert.equal(turns(ctx).length, 2);
  });
});

// ── (12) move-out only ends terminals of a chat that was ever in the copy ───────────────────────────────────────────────────
// The same fake pty as (5). A terminal `chat:<id>` in main survives a copy that is discarded without ever having been ready
// (waiting -> removed; build -> error -> removed) and likewise the removal of the copy of a project the chat has left.
function terminalOpener(ctx, pid, corpses) {
  ptyHook = (args) => {
    const i = args.indexOf("--pgid-file");
    if (i < 0) return;
    const subprocess = spawn("/bin/sleep", ["100000"], { detached: true, stdio: "ignore" });
    corpses.push(subprocess);
    fs.mkdirSync(path.dirname(args[i + 1]), { recursive: true });
    fs.writeFileSync(args[i + 1], String(subprocess.pid));
  };
  return async (tag) => {
    const t = await json(`${ctx.base}/api/projects/${pid}/terminal`, { method: "POST", body: JSON.stringify({ cols: 80, rows: 24, tag }) });
    assert.equal(t.available, true, JSON.stringify(t));
    return ptys[ptys.length - 1];
  };
}
const corpsesClean = (corpses) => { ptyHook = null; for (const l of corpses) { try { process.kill(-l.pid, "SIGKILL"); } catch { /* gone */ } } };

test("(12) the chat bar's terminal in main survives a never fetched copy (discarded from waiting_queue, error without ready)", async () => {
  const corpses = [];
  await withInset(async (ctx, fd) => {
    const o = await projectInOps(ctx, fd);
    const before = ptys.length;
    const open = terminalOpener(ctx, o.pid, corpses);
    const bar = await open(`chat:${ctx.chat.id}`);
    assert.ok(bar.args.includes(o.main), "without a copy the bar starts in main");
    // waiting -> removed (discarded)
    const a = copyRequests({ projectId: o.pid, name: "k1", chatId: ctx.chat.id });
    setCopyState(a.id, "removed");
    assert.equal(bar.killed, false, "the terminal in main ended when a waiting copy was discarded");
    // build -> error (never ready) -> removed
    const b = copyRequests({ projectId: o.pid, name: "k2", chatId: ctx.chat.id });
    setCopyState(b.id, "build", { phase: "clone1" });
    setCopyState(b.id, "error", { error: "Testfehler" });
    await waitingForTurns(ctx, 1, "the error wake-up");
    await quiet(ctx);
    store.deleteProjectInstance(o.pid, copyInstance("k2"));
    setCopyState(b.id, "removed");
    assert.equal(bar.killed, false, "the terminal in main ended when a never built copy was removed");
    for (const p of ptys.slice(before)) if (!p.killed) p.kill?.();
  }).finally(() => corpsesClean(corpses));
});

test("(12b) if the chat switched project, its terminal in the other project survives the removal of the old project's idle copy", async () => {
  const corpses = [];
  await withInset(async (ctx, fd) => {
    const o = await projectInOps(ctx, fd);
    const k = copyUntilFastReady(fd, o, ctx.chat.id, { withoutWakeCall: true });
    copyReady(k);
    const other = path.join(ctx.root, "workspace", "other");
    fs.mkdirSync(other, { recursive: true });
    const q = await ctx.projectWithoutInstance({ name: "Anderes", path: other });
    containerStart(fd, `cbase-p-${q.id}`);
    store.createProjectInstance({ projectId: q.id, state: "ready", convertedAt: Date.now(), containerId: `cbase-p-${q.id}` });
    await json(`${ctx.base}/api/chats/${ctx.chat.id}`, { method: "PATCH", body: JSON.stringify({ projectId: q.id }) });
    const before = ptys.length;
    const open = terminalOpener(ctx, q.id, corpses);
    const bar = await open(`chat:${ctx.chat.id}`);
    setCopyState(k.id, "clearAway", { phase: "save" });
    store.deleteProjectInstance(o.pid, copyInstance("k1"));
    setCopyState(k.id, "removed");
    assert.equal(bar.killed, false, "the terminal in the other project ended with the removal of the old project's copy");
    for (const p of ptys.slice(before)) if (!p.killed) p.kill?.();
  }).finally(() => corpsesClean(corpses));
});

// ── (13)/(14) the wait phase of the old process ends as soon as an input waits in another instance ────────────────────────────
// A wakeup belongs to the CHAT (runs/wakeup.js): the turn ends after setting it, and its continuation runs as a new turn where the chat
// stands at wake time — so it does not fall with the process and holds no wait phase. (13)–(14b) hold that; the test seam
// `wakeupNow` (runs/wakeup.js) fires the wakeup at once. What a turn in another instance still holds (a monitor, a schedule, a background
// command) stands as a notice in the log and in the next turn (runs/wait-phase-yield.js); the queue runs as a follow-up turn in the
// instance of NOW.
const phaseOf = async (ctx, chatId = ctx.chat.id) => ((await json(`${ctx.base}/api/active-runs`)).items || []).find((i) => i.chatId === chatId)?.phase || null;
const waitPhase = (ctx) => waitForTruthy(async () => ((await phaseOf(ctx)) === "waiting" || (await runs(ctx)) === 0 ? true : null), "the wait phase or the run end");
const wakeupNow = (chatId) => wakeupFire(chatId);
// A turn that begins by itself (the wakeup) has no run before — waits on its row, not on the run end.
const turnCame = (ctx, n, what) => waitForTruthy(() => (turns(ctx).length >= n ? true : null), what);
const wakeupTurnEnd = async (ctx) => { await send(ctx, "WAKEUP"); await waitForTruthy(async () => ((await runs(ctx)) === 0 && turns(ctx).length >= 1 ? true : null), "the end of the wakeup turn"); };
async function secondProject(ctx, fd) {
  const filePath = path.join(ctx.root, "workspace", "other");
  fs.mkdirSync(filePath, { recursive: true });
  const q = await ctx.projectWithoutInstance({ name: "Anderes", path: filePath });
  containerStart(fd, `cbase-p-${q.id}`);
  store.createProjectInstance({ projectId: q.id, state: "ready", convertedAt: Date.now(), containerId: `cbase-p-${q.id}` });
  return q;
}

test("(13) copy ready after the main turn set a wakeup — no wait phase, the wake-up runs in the copy, the wakeup stays and wakes afterwards in the copy", async () => {
  await withInset(async (ctx, fd) => {
    const o = await projectInOps(ctx, fd);
    await wakeupTurnEnd(ctx);
    // The wakeup used to hold the process in the wait phase (`phase: "waiting"`, `runs: 1`).
    assert.equal(await phaseOf(ctx), null, "the chat still stands in the run overview after setting the wakeup");
    assert.ok(wakeupOf(ctx.chat.id), "the wakeup no longer stands after the end of its turn");
    assert.equal(turns(ctx)[0].instance, `${o.pid}/main`);
    const k = copyUntilFastReady(fd, o, ctx.chat.id);
    copyReady(k); // MOVE-IN: the copy's wake-up becomes a turn of its own — in the copy
    await turnCame(ctx, 2, "the wake turn in the copy");
    await quiet(ctx);
    assert.ok(turns(ctx)[1].text.includes("<task-notification>") && turns(ctx)[1].text.includes('Copy "k1" ready'), turns(ctx)[1].text.slice(0, 400));
    assert.equal(turns(ctx)[1].instance, `${o.pid}/${copyInstance("k1")}`, "the wake turn does not run in the copy");
    assert.ok(!turns(ctx)[1].all.includes("Mit ihm fiel"), `the wakeup fell with the process: ${turns(ctx)[1].all.slice(0, 900)}`);
    assert.equal(wakeupNow(ctx.chat.id), true, "the wakeup no longer stood after the move-in");
    await turnCame(ctx, 3, "the wakeup as a turn in the copy");
    await quiet(ctx);
    const t = turns(ctx);
    assert.equal(t.length, 3, JSON.stringify(t.map((x) => [x.instance, x.text.slice(0, 80)])));
    assert.ok(t[2].text.includes("[Scheduled continuation]") && t[2].text.includes("Please check"), t[2].text.slice(0, 400));
    assert.equal(t[2].instance, `${o.pid}/${copyInstance("k1")}`, "the wakeup did not run in the copy");
    assert.equal(turnsIn(fd, o.main), 1, "a second turn in main");
    const log = await json(`${ctx.base}/api/chats/${ctx.chat.id}/log`);
    assert.ok(!log.some((m) => m.role === "hint" && String(m.text).includes("cbase_wakeup, cbase_monitor")), "a notice about a fallen wakeup");
  });
});

test("(13b) move-in in the middle of the turn that sets a wakeup — at its end NO wait phase begins in main, the wake-up runs at once as a follow-up turn in the copy, the wakeup stays", async () => {
  await withInset(async (ctx, fd) => {
    const o = await projectInOps(ctx, fd);
    await send(ctx, "HOLD WAKEUP");
    await atGate(ctx, "hold");
    const k = copyUntilFastReady(fd, o, ctx.chat.id);
    copyReady(k); // IN THE MIDDLE of the turn: the wake-up stands in the queue
    ctx.gate.open("hold"); // the turn sets the wakeup and ends
    const what = await waitForTruthy(async () => (turns(ctx).length >= 2 ? "turn" : (await phaseOf(ctx)) === "waiting" ? "waiting" : (await runs(ctx)) === 0 ? "end" : null), "follow-up turn, wait phase or run end");
    assert.equal(what, "turn", "after the turn the wait phase began in main although the copy's wake-up was waiting");
    await quiet(ctx);
    const t = turns(ctx);
    assert.equal(t.length, 2, JSON.stringify(t.map((x) => [x.instance, x.text.slice(0, 80)])));
    assert.equal(t[1].instance, `${o.pid}/${copyInstance("k1")}`, "the wake turn does not run in the copy");
    assert.ok(!t[1].all.includes("Mit ihm fiel"), `the wakeup fell with the process: ${t[1].all.slice(0, 900)}`);
    assert.ok(wakeupOf(ctx.chat.id), "the wakeup no longer stands");
    assert.equal(turnsIn(fd, o.main), 1);
  });
});

test("(13c) a subagent's completion message does not go into main's process after the move-in — it waits and becomes a turn in the copy", async () => {
  await withInset(async (ctx, fd) => {
    const o = await projectInOps(ctx, fd);
    await send(ctx, "BACKGROUND");
    await atGate(ctx, "sub-alive", { agents: true });
    await waitForTruthy(async () => (await runs(ctx)) === 0, "the turn is over (the subagent lives)");
    await send(ctx, "HOLD");
    await atGate(ctx, "hold");
    const k = copyUntilFastReady(fd, o, ctx.chat.id, { withoutWakeCall: true });
    copyReady(k); // IN THE MIDDLE of the second turn; the first one's subagent lives in main
    ctx.gate.open("sub-alive"); // it ends, its completion message (occasion agent) comes while the turn runs in main
    const whereTo = await waitForTruthy(async () => {
      const item = ((await json(`${ctx.base}/api/active-runs`)).items || []).find((i) => i.chatId === ctx.chat.id);
      if ((item?.queued || 0) >= 1) return "queued";
      const log = await json(`${ctx.base}/api/chats/${ctx.chat.id}/log`);
      return log.some((m) => m.role === "user" && String(m.text).includes("<task-notification>")) ? "injected" : null;
    }, "the subagent's completion message");
    assert.equal(whereTo, "queued", "the completion message went into main's process although the chat stands in the copy");
    ctx.gate.open("hold");
    await waitingForTurns(ctx, 3, "the completion message as a turn");
    await quiet(ctx);
    const t = turns(ctx);
    assert.equal(t.length, 3, JSON.stringify(t.map((x) => [x.instance, x.text.slice(0, 80)])));
    assert.ok(t[2].text.includes("<task-notification>"), t[2].text.slice(0, 300));
    assert.equal(t[2].instance, `${o.pid}/${copyInstance("k1")}`, "the completion message did not run in the copy");
    assert.equal(t.filter((x) => x.instance === `${o.pid}/main`).length, 2);
  });
});

test("(14) project switch after setting a wakeup — a message afterwards becomes the next turn in the new project, the wakeup stays and wakes there", async () => {
  await withInset(async (ctx, fd) => {
    const o = await projectInOps(ctx, fd);
    await wakeupTurnEnd(ctx);
    assert.equal(await phaseOf(ctx), null, "the chat still stands in the run overview after setting the wakeup");
    const q = await secondProject(ctx, fd);
    await json(`${ctx.base}/api/chats/${ctx.chat.id}`, { method: "PATCH", body: JSON.stringify({ projectId: q.id }) });
    const r = await send(ctx, "Continue");
    assert.equal(r.injected, false, "the message went into a process of the old project");
    await turnCame(ctx, 2, "the turn in the new project");
    await quiet(ctx);
    assert.ok(turns(ctx)[1].text.includes("Continue"), turns(ctx)[1].text.slice(0, 300));
    assert.equal(turns(ctx)[1].instance, `${q.id}/main`, "the message did not run in the new project");
    assert.ok(!turns(ctx)[1].all.includes("Mit ihm fiel"), `the wakeup fell with the process: ${turns(ctx)[1].all.slice(0, 900)}`);
    assert.equal(wakeupNow(ctx.chat.id), true, "the user's message took the wakeup along");
    await turnCame(ctx, 3, "the wakeup as a turn in the new project");
    await quiet(ctx);
    const t = turns(ctx);
    assert.equal(t.length, 3, JSON.stringify(t.map((x) => [x.instance, x.text.slice(0, 80)])));
    assert.ok(t[2].text.includes("[Scheduled continuation]") && t[2].text.includes("Please check"), t[2].text.slice(0, 400));
    assert.equal(t[2].instance, `${q.id}/main`, "the wakeup did not run in the new project");
    assert.equal(turnsIn(fd, o.main), 1);
  });
});

test("(14b) project switch after setting a wakeup, no message — the due wakeup becomes the next turn in the new project, no turn in the old one", async () => {
  await withInset(async (ctx, fd) => {
    const o = await projectInOps(ctx, fd);
    await wakeupTurnEnd(ctx);
    const q = await secondProject(ctx, fd);
    await json(`${ctx.base}/api/chats/${ctx.chat.id}`, { method: "PATCH", body: JSON.stringify({ projectId: q.id }) });
    assert.equal(wakeupNow(ctx.chat.id), true, "the wakeup no longer stood after the project switch");
    await turnCame(ctx, 2, "the wakeup as a turn in the new project");
    await quiet(ctx);
    const t = turns(ctx);
    assert.equal(t.length, 2, JSON.stringify(t.map((x) => [x.instance, x.text.slice(0, 80)])));
    assert.ok(t[1].text.includes("[Scheduled continuation]") && t[1].text.includes("Please check"), t[1].text.slice(0, 400));
    assert.equal(t[1].instance, `${q.id}/main`, "the wakeup did not run in the new project");
    assert.equal(turnsIn(fd, o.main), 1, "a second turn in the old project");
  });
});

// A monitor belongs to the CHAT: it holds no wait phase, the turn ends right after the start, and the monitor lives on in the instance
// of its start. A project switch does not end it — its next event wakes the chat, and that turn runs in the NEW project (the
// instance of the turn, not of the monitor).
test("(14c) project switch while a monitor (unbounded) lives — its event becomes the next turn in the new project, the monitor stays until stopped", async () => {
  await withInset(async (ctx, fd) => {
    const fifo = path.join(ctx.root, "monitor.fifo");
    execFileSync("mkfifo", [fifo]);
    let writer = null;
    try {
      const o = await projectInOps(ctx, fd);
      await send(ctx, "MONITOR_START");
      await waitPhase(ctx);
      await waitForTruthy(async () => ((await runs(ctx)) === 0 ? true : null), "the end of the start turn");
      const monitors = (await json(`${ctx.base}/api/runs/active`)).monitors.filter((m) => m.chatId === ctx.chat.id);
      assert.equal(monitors.length, 1, "the monitor lives after the end of its turn");
      const q = await secondProject(ctx, fd);
      await json(`${ctx.base}/api/chats/${ctx.chat.id}`, { method: "PATCH", body: JSON.stringify({ projectId: q.id }) });
      // The event: a line into the FIFO that the monitor reads (the writer stays open — otherwise `cat` would end with EOF).
      writer = await fs.promises.open(fifo, "w");
      await writer.write("EVENT-ALPHA\n");
      // No run is open until the event starts it — so wait on the turn itself (waitingForTurns would stop at the run end).
      await waitForTruthy(() => (turns(ctx).length >= 2 ? true : null), "the monitor event as a turn");
      assert.equal(turns(ctx)[1].instance, `${q.id}/main`, "the monitor event did not run in the new project");
      assert.ok(turns(ctx)[1].text.includes("EVENT-ALPHA"), turns(ctx)[1].text.slice(0, 400));
      await waitForTruthy(async () => ((await runs(ctx)) === 0 ? true : null), "the end of the wake turn");
      await json(`${ctx.base}/api/chats/${ctx.chat.id}/monitor/stop`, { method: "POST", body: JSON.stringify({ taskId: monitors[0].taskId, from: "human" }) });
      await quiet(ctx);
      const t = turns(ctx);
      assert.equal(t.length, 2, JSON.stringify(t.map((x) => [x.instance, x.text.slice(0, 80)])));
      assert.equal(t.filter((x) => x.instance === `${o.pid}/main`).length, 1, "a second turn in the old project");
    } finally { await writer?.close().catch(() => {}); }
  });
});

// ── (15) the move-in asks the project binding ────────────────────────────────────────────────────────────────────────────────
// If the copy becomes ready while the chat stands in ANOTHER project, it is idle (runs/instance.js binding) — the next turn runs in
// the main of that project. Terminal and turn mark stay, instead of the wake-up a silent hint (ready, this chat does not work in it),
// the mark in the journal stands.
test("(15) the copy becomes ready while the chat stands in another project — its terminal there stays, no wake-up, a silent hint \"ready, not in it\"", async () => {
  const corpses = [];
  await withInset(async (ctx, fd) => {
    const o = await projectInOps(ctx, fd);
    const k = copyUntilFastReady(fd, o, ctx.chat.id);
    const q = await secondProject(ctx, fd);
    await json(`${ctx.base}/api/chats/${ctx.chat.id}`, { method: "PATCH", body: JSON.stringify({ projectId: q.id }) });
    const before = ptys.length;
    const open = terminalOpener(ctx, q.id, corpses);
    const bar = await open(`chat:${ctx.chat.id}`);
    assert.ok(bar.args.includes(`cbase-p-${q.id}`), "the bar's terminal starts in the main of the other project");
    copyReady(k);
    assert.equal(bar.killed, false, "the terminal in the other project ended at the move-in into an idle copy");
    await quiet(ctx);
    assert.equal(turns(ctx).length, 0, `a wake turn ran although the copy is idle: ${JSON.stringify(turns(ctx).map((x) => [x.instance, x.text.slice(0, 120)]))}`);
    assert.equal(store.stackCopy(k.id)?.journal?.data?.inset?.wakeCall?.state, "ready", "the wake-up mark is missing — a restart grace reported again");
    assert.equal(copiesWakeRestartGrace(), 0, "the restart grace made up a wake-up");
    await send(ctx, "Continue");
    await waitingForTurns(ctx, 1, "the turn in the other project");
    await quiet(ctx);
    const t = turns(ctx);
    assert.equal(t.length, 1, JSON.stringify(t.map((x) => [x.instance, x.text.slice(0, 80)])));
    assert.equal(t[0].instance, `${q.id}/main`, "the turn did not run in the main of the other project");
    assert.equal(t[0].copyParagraph, false);
    // The hint says "ready, this chat does not work in it" — the project switch released the binding, a switch back does not bind
    // again.
    assert.ok(t[0].all.includes("ist bereit") && t[0].all.includes("arbeitet nicht in ihr"), `no silent hint "ready, not in it": ${t[0].all.slice(0, 900)}`);
    assert.ok(!t[0].all.includes("From this turn on everything you start ANEW"), "the turn got the statement that it runs in the copy");
    for (const p of ptys.slice(before)) if (!p.killed) p.kill?.();
  }).finally(() => corpsesClean(corpses));
});

// ── (16) a failed clearing away does not let the chat fall silently into main ─────────────────────────────────────────────────
// clearAway -> error (e.g. "Backup pending"): the unsaved work is still in the copy. The chat stays bound (error and was ever
// ready), and the copy's lock holds with a message — no turn, a row with the reason.
test("(16) if the clearing away fails, the chat stays bound to its copy — no turn in main, the queued and every further message end visibly with the reason", async () => {
  await withInset(async (ctx, fd) => {
    const o = await projectInOps(ctx, fd);
    const k = copyUntilFastReady(fd, o, ctx.chat.id, { withoutWakeCall: true });
    copyReady(k);
    await send(ctx, "Erster");
    await waitingForTurns(ctx, 1, "the turn in the copy");
    await quiet(ctx);
    assert.equal(turns(ctx)[0].instance, `${o.pid}/${copyInstance("k1")}`);
    setCopyState(k.id, "clearAway", { phase: "save" });
    // Like build and clearing away themselves (stacks/build.js `journal.step("ready")`, stacks/clearAway.js): `ready` stands as done
    // in the log, the clearing away's run in the journal — that is how wasReady recognizes the copy in which the chat worked (the
    // build here ran through the setters, without a log; the `clearAway` section alone does not count).
    store.writeStackCopyJournal(k.id, { step: "ready", done: "ready", data: { clearAway: { phase: "save" } } });
    const queued = [];
    try {
      const r = await send(ctx, "While clearing away");
      queued.push(r.entryId);
      assert.equal(r.locked, true, `the message does not wait at the copy's lock: ${JSON.stringify(r)}`);
      setCopyState(k.id, "error", { error: "Sicherung ausstehend: Testgrund" });
      assert.equal(instanceNameForChat(ctx.chat.id, o.pid), copyInstance("k1"), "after the failed clearing away the chat stands silently in main");
      await quiet(ctx);
      assert.equal(turns(ctx).length, 1, `a turn ran after the failed clearing away: ${JSON.stringify(turns(ctx).map((x) => [x.instance, x.text.slice(0, 80)]))}`);
      const rows = async () => (await json(`${ctx.base}/api/chats/${ctx.chat.id}/log`)).filter((m) => m.role === "hint" && String(m.text).includes("Sicherung ausstehend")).length;
      assert.equal(await rows(), 1, "the queued message did not end visibly with the reason");
      queued.push((await send(ctx, "Once more")).entryId);
      await quiet(ctx);
      assert.equal(turns(ctx).length, 1, "a further message ran");
      assert.equal(await rows(), 2, "the further message did not end visibly with the reason");
      assert.equal(turnsIn(fd, o.main), 0, "a turn in main");
    } finally {
      // Red instead of a hang: otherwise the queued message would lie there forever (no waker names the chat's identifier), and the
      // harness's quiet would wait endlessly — it is discarded here, 404 means "already gone".
      for (const id of queued.filter(Boolean)) {
        await fetch(`${ctx.base}/api/chats/${ctx.chat.id}/message/queue/${id}`, { method: "DELETE", headers: { Connection: "close" } }).then((x) => x.arrayBuffer()).catch(() => {});
      }
    }
  });
});

// ── (17) the restart grace repairs a child pin on a copy that no longer exists ─────────────────────────────────────────────────
// If the re-pinning at move-out threw (copyTransition only catches) or the server ended between `removed` and the re-pinning,
// `graph_starts.instance` pointed at an identifier without a row, and the child chat was locked forever (G11) — the head of
// stacks/inset.js promised the repair in the restart grace, the code did not do it. A pin on a LIVING copy stays.
test("(17) the restart grace hangs a child pin on a dead copy back into main (silent hint), a pin on the living copy stays", async () => {
  await withInset(async (ctx, fd) => {
    const o = await projectInOps(ctx, fd);
    const k = copyUntilFastReady(fd, o, ctx.chat.id, { withoutWakeCall: true });
    copyReady(k);
    const now = Date.now();
    const kind = (title) => store.createChat({ id: crypto.randomUUID(), workspaceId: ctx.ws.id, projectId: o.pid, kind: "normal", title, createdAt: now, updatedAt: now });
    const pin = (childChat, instance) => store.createGraphStart({ id: `gs-${crypto.randomUUID()}`, chatId: ctx.chat.id, childChatId: childChat.id,
      workflowId: "wf-pin", workflowName: "Pin probe", shortName: "pin-probe", background: true, status: "stopped", instance });
    const totKind = kind("Child of a removed copy");
    const lebKind = kind("Child of the living copy");
    const tot = `${o.pid}/${copyInstance("way")}`;
    const alive = `${o.pid}/${copyInstance("k1")}`;
    const zTot = pin(totKind, tot);
    const zAlive = pin(lebKind, alive);
    assert.equal(instanceNameForChat(totKind.id, o.pid), copyInstance("way"), "precondition: the pin binds the child to the dead copy");
    assert.equal(copiesWakeRestartGrace(), 0, "a wake-up was made up (the mark stands)");
    assert.equal(store.graphStart(zTot.id).instance, "", "the pin on the dead copy still stands — the child chat would stay locked forever");
    assert.equal(instanceNameForChat(totKind.id, o.pid), "main");
    assert.ok(store.openHints(totKind.id).some((h) => h.text.includes("„way“") && h.text.includes("gibt es nicht mehr")), "no silent hint in the child chat");
    assert.equal(store.graphStart(zAlive.id).instance, alive, "the pin on the living copy was released");
    assert.equal(instanceNameForChat(lebKind.id, o.pid), copyInstance("k1"));
    assert.equal(store.openHints(lebKind.id).length, 0);
  });
});

// ── (18) an error at server end is no error of the attempt ───────────────────────────────────────────────────────────────────
// If the freeze fails WHILE the server ends (lock), it sets `error` itself — and the build then puts the copy back into the queue
// (stacks/build.js backAfterServerEnd). The error wake-up used to go out then (queued in run_inputs: "NOT built … a new attempt …",
// the chat read it in the next process although the copy was waiting) and set the mark `wakeCall` to "error" — if the NEXT attempt
// really failed, the chat stayed silent (one per state). Now: no wake-up at server end, a silent hint on the way back into the queue,
// and the mark falls with the way back (it belongs to the attempt).
test("(18) error at server end -> back into the queue -> error in the next attempt => only the second wakes the chat; from the server end a silent hint", async () => {
  await withInset(async (ctx, fd) => {
    const o = await projectInOps(ctx, fd);
    const inst = copyInstance("k1");
    const queued = () => store.listRunInputs().filter((r) => r.chatId === ctx.chat.id).flatMap((r) => r.entries);
    try {
      const k = copyRequests({ projectId: o.pid, name: "k1", chatId: ctx.chat.id });
      setCopyState(k.id, "build", { phase: "clone1" });
      serverEndMarkerForTest(true);
      try {
        // What the freeze does in the ending process: dismantling with instance row, then `error` — and the build puts it back.
        store.deleteProjectInstance(o.pid, inst);
        setCopyState(k.id, "error", { error: "lock: the server ends — no freeze" }, { returnPathAtServerEnd: true });
        const z = backAfterServerEnd(store.stackCopy(k.id), inst, { dismantled: true }, "freeze");
        assert.equal(z.state, "waiting_queue", `after the server end "${z.state}"`);
        assert.deepEqual(queued().filter((e) => /NOT built/.test(String(e.prompt))).map((e) => String(e.prompt).slice(0, 120)), [],
          "an error wake-up went out from the server end (queued for the next process) although the copy waits again");
        assert.equal(store.stackCopy(k.id).journal?.data?.inset?.wakeCall ?? null, null, "the server end's mark blocks the next attempt");
        const h = store.openHints(ctx.chat.id).filter((x) => x.source === "stack-copy");
        assert.equal(h.length, 1, `silent hint: ${JSON.stringify(h)}`);
        assert.match(h[0].text, /„k1“.*wieder in der Reihe/);
      } finally { serverEndMarkerForTest(false); }
      await quiet(ctx);
      assert.equal(turns(ctx).length, 0, "a wake turn from the server end");

      // The next process: the attempt really fails => the chat is woken.
      setCopyState(k.id, "build", { phase: "clone1" });
      store.deleteProjectInstance(o.pid, inst);
      setCopyState(k.id, "error", { error: "clone1: disk full" });
      await waitingForTurns(ctx, 1, "the wake-up of the second failure");
      await quiet(ctx);
      const t = turns(ctx);
      assert.equal(t.length, 1);
      assert.ok(t[0].text.includes("not built") && t[0].text.includes("disk full") && !t[0].text.includes("server ends"), t[0].text.slice(0, 400));
      assert.equal(t[0].instance, `${o.pid}/main`);
      assert.equal(store.stackCopy(k.id).journal.data.inset.wakeCall.state, "error");
    } finally {
      // Red instead of a hang: otherwise the queued message would lie there forever (the harness's quiet waited for it), and a
      // system message is not discarded by the route (409) — the chat's queue is emptied here.
      pendingRunInputs.delete(ctx.chat.id);
      store.clearRunInputs(ctx.chat.id);
    }
  });
});

// ── (19) the other side: if the copy stays `error` at server end, the wake-up goes out after all ────────────────────────────
// If the build can NOT put it back (the dismantling stayed incomplete, the instance row still stands), `error` is real — the wake-up
// left out in copyTransition then goes out from backAfterServerEnd (wakeCopyError). In the ending process deliverUserPrompt queues it
// (start lock), the next process delivers it. Without that call the chat would stay silent about a copy that never builds again.
test("(19) if the copy stays error at server end (dismantling incomplete), the error wake-up goes out anyway — queued, with mark", async () => {
  await withInset(async (ctx, fd) => {
    const o = await projectInOps(ctx, fd);
    const inst = copyInstance("k1");
    const queued = () => store.listRunInputs().filter((r) => r.chatId === ctx.chat.id).flatMap((r) => r.entries);
    try {
      const k = copyRequests({ projectId: o.pid, name: "k1", chatId: ctx.chat.id });
      setCopyState(k.id, "build", { phase: "clone1" });
      serverEndMarkerForTest(true);
      try {
        assert.ok(store.projectInstance(o.pid, inst), "the instance row of the copy (it stands since the request) is missing");
        setCopyState(k.id, "error", { error: "clone2: location stayed — helper not removed" }, { returnPathAtServerEnd: true });
        const z = backAfterServerEnd(store.stackCopy(k.id), inst, { dismantled: false }, "freeze");
        assert.equal(z.state, "error");
        assert.equal(queued().filter((e) => /NOT built/.test(String(e.prompt))).length, 1,
          "the copy stays error, and the chat never learns it (no wake-up, not even queued)");
        assert.equal(store.stackCopy(k.id).journal?.data?.inset?.wakeCall?.state, "error");
      } finally { serverEndMarkerForTest(false); }
    } finally {
      store.deleteProjectInstance(o.pid, inst);
      pendingRunInputs.delete(ctx.chat.id);
      store.clearRunInputs(ctx.chat.id);
    }
  });
});
