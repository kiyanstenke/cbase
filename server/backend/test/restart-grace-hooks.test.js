// The restart recovery after a reboot through the hook registry - no server, no fake CLI, a real store in a temp dir.
//
// Two sides, each on its own:
//   1. The FIRING in runs/resume.js: resumeInterruptedWork fires the three events restartGrace,
//      restartGraceWorkflows, restartGraceAbandoned at the places and in the order the former direct calls had
//      (restartGrace BEFORE filtering the runs, locks + runs AFTER the early exit, finishWorkflow BEFORE the
//      broadcast and before "end"), with the payloads the consumers need. Measured through own spies on the
//      registry, not through the real consumers: this is about the hub.
//   2. The CONSUMERS in their domain (workflows/gates.js): what can be measured without a model call - the lock is
//      brought along, an abandoned workflow run ends as "failed" with its note (an already finished one stays as it
//      is), a run without a chat is abandoned.
//      NOT here: driving an interrupted workflow run (driveWorkflow/workflowGateAfterRun - that needs a turn).
//
// The early exit (nothing to do) fires ONLY restartGrace - the normal case of every boot and the reason the golden
// runs filter out the restartGrace kinds (golden-harness.mjs: the 2.5 s timer is wall clock).
//
// This file imports NO other test file.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, test } from "node:test";

import * as store from "../electron/server/store.js";
import { observeHooks, resetHooks, registerHook } from "../electron/server/runs/hooks.js";
import { resumeInterruptedWork } from "../electron/server/runs/resume.js";
import { running } from "../electron/server/runs/state.js";
import { workflowAbandonedHook, workflowRunsHook, workflowLocksHook } from "../electron/server/workflows/gates.js";

beforeEach(resetHooks);

const now = () => Date.now();
function withStore(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-restart-grace-"));
  try {
    store.initStore(dir);
    return fn(dir);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
    catch (e) { console.warn("[restart-grace-hooks] cleanup:", e?.message || e); }
  }
}
function seed() {
  const ws = store.createWorkspace({ id: "ws1", name: "W", path: os.tmpdir(), createdAt: now() });
  const chat = (id, extra = {}) => store.createChat({ id, workspaceId: ws.id, title: id, createdAt: now(), updatedAt: now(), ...extra });
  return { ws, chat };
}
// Capture console.error (the consumers log their safety net there) - always restore the original.
const REAL_ERROR = console.error;
function withConsole(fn) {
  const rows = [];
  console.error = (...a) => { rows.push(a.map(String).join(" ")); };
  try { return fn(rows); } finally { console.error = REAL_ERROR; }
}

// ── 1. The firing in resume.js ───────────────────────────────────────────────

test("resumeInterruptedWork fires restartGrace → restartGraceWorkflows → restartGraceAbandoned → end, with the expected payloads", () => withStore(() => {
  const { ws, chat } = seed();
  // A run already resumed twice (MAX_RESUME_ATTEMPTS = 2): the abandoned branch.
  chat("c-on");
  store.setActiveRun("c-on", { prompt: "further" });
  store.bumpActiveRunAttempts("c-on"); store.bumpActiveRunAttempts("c-on");
  // A workflow run interrupted BETWEEN two steps: running, no active_runs row → `flows`.
  chat("c-flow");
  store.createWorkflow({ id: "w1", workspaceId: ws.id, name: "W1", createdAt: now(), updatedAt: now() });
  const run = store.startWorkflowRun({ id: "r-flow", chatId: "c-flow", workflowId: "w1", workflowName: "W1", workspaceId: ws.id });

  const trace = [];
  observeHooks((info, payload) => trace.push({ kind: info.kind, name: info.name, payload }));
  for (const kind of ["restartGrace", "restartGraceWorkflows", "restartGraceAbandoned", "end"]) {
    registerHook(kind, () => {}, { name: `spion-${kind}` });
  }
  resumeInterruptedWork();

  assert.deepEqual(trace.map((t) => t.kind), ["restartGrace", "restartGraceWorkflows", "restartGraceAbandoned", "end"]);
  // The payloads: empty, the flows list, the chat with its cap, the end.
  assert.deepEqual(trace[0].payload, {});
  assert.deepEqual(trace[1].payload.flows.map((r) => r.id), [run.id]);
  assert.equal(trace[2].payload.chat.id, "c-on");
  assert.equal(trace[2].payload.attempts, 2);
  assert.deepEqual({ id: trace[3].payload.chat.id, abandoned: trace[3].payload.abandoned }, { id: "c-on", abandoned: true });
  // The hub did its part: the active_runs row is gone, the marker is in the history.
  assert.equal(store.listActiveRuns().length, 0);
  assert.ok(store.listMessages("c-on").some((m) => m.role === "meta" && /"gaveUp":true/.test(m.text)));
  // And nobody touched the workflow run - that is the consumers' job (below), not registered here.
  assert.equal(store.getWorkflowRun("c-flow").status, "running");
}));

test("Nothing to do: only restartGrace fires - the early exit sits BEFORE the workflow events", () => withStore(() => {
  seed();
  const trace = [];
  observeHooks((info) => trace.push(info.kind));
  for (const kind of ["restartGrace", "restartGraceWorkflows", "restartGraceAbandoned", "end"]) {
    registerHook(kind, () => {}, { name: `spion-${kind}` });
  }
  resumeInterruptedWork();
  assert.deepEqual(trace, ["restartGrace"]);
}));

test("A chat running in THIS process is no leftover - and a running workflow chat is not in `flows`", () => withStore(() => {
  const { ws, chat } = seed();
  chat("c-live");
  store.setActiveRun("c-live", { prompt: "x" });
  store.createWorkflow({ id: "w1", workspaceId: ws.id, name: "W1", createdAt: now(), updatedAt: now() });
  store.startWorkflowRun({ id: "r-live", chatId: "c-live", workflowId: "w1", workflowName: "W1", workspaceId: ws.id });
  running.add("c-live");
  try {
    const trace = [];
    observeHooks((info, payload) => trace.push({ kind: info.kind, payload }));
    for (const kind of ["restartGrace", "restartGraceWorkflows", "restartGraceAbandoned", "end"]) {
      registerHook(kind, () => {}, { name: `spion-${kind}` });
    }
    resumeInterruptedWork();
    assert.deepEqual(trace.map((t) => t.kind), ["restartGrace"]);
    assert.equal(store.listActiveRuns().length, 1, "the running chat's row is cleaned up by the run itself");
  } finally { running.delete("c-live"); }
}));

// restartGrace fires BEFORE filtering the runs - and that carries behaviour: the channel restart delivers unread
// messages (-> ... -> doRun), and doRun does `running.add` SYNCHRONOUSLY before its first await; resume.js filters
// exactly on that (`!running.has(r.chatId)`). Were the hook fired behind the filter, the same chat would run twice:
// once as a channel turn, once as a restart. The spy does what the channel does (running.add), without a fake CLI -
// the abandoned branch must then NOT fire, the active_runs row stays with the run.
test("restartGrace fires BEFORE filtering: a chat started by a restart-grace consumer is no leftover any more", () => withStore(() => {
  const { chat } = seed();
  chat("c-on");
  store.setActiveRun("c-on", { prompt: "further" });
  store.bumpActiveRunAttempts("c-on"); store.bumpActiveRunAttempts("c-on");
  const trace = [];
  observeHooks((info) => trace.push(info.kind));
  registerHook("restartGrace", () => { running.add("c-on"); }, { name: "spy-channel" });
  for (const kind of ["restartGraceWorkflows", "restartGraceAbandoned", "end"]) {
    registerHook(kind, () => {}, { name: `spion-${kind}` });
  }
  try {
    resumeInterruptedWork();
    assert.deepEqual(trace, ["restartGrace"], "the abandoned branch ran for a chat the channel restart had just started");
    assert.equal(store.listActiveRuns().length, 1, "the active_runs row belongs to the running chat - the run cleans it up itself");
    assert.equal(store.listMessages("c-on").some((m) => m.role === "meta"), false, "no gave-up marker in the history");
  } finally { running.delete("c-on"); }
}));

// ── 2. The consumers ─────────────────────────────────────────────────────────

test("workflowLocksHook: an open run without a lock row gets it brought along; a run that has one keeps it", () => withStore(() => {
  const { ws, chat } = seed();
  chat("c1"); chat("c2");
  store.createWorkflow({ id: "w1", workspaceId: ws.id, name: "W1", createdAt: now(), updatedAt: now() });
  store.updateWorkflow("w1", { lock: { scope: "workflow" } });
  store.startWorkflowRun({ id: "r1", chatId: "c1", workflowId: "w1", workflowName: "W1", workspaceId: ws.id });
  store.createWorkflow({ id: "w2", workspaceId: ws.id, name: "W2", createdAt: now(), updatedAt: now() });
  store.updateWorkflow("w2", { lock: { scope: "workflow" } });
  store.startWorkflowRun({ id: "r2", chatId: "c2", workflowId: "w2", workflowName: "W2", workspaceId: ws.id });
  store.acquireLock("workflow:w2", { runId: "r2", chatId: "c2", workflowId: "w2" });
  assert.equal(store.lockOfRun("r1") ?? null, null, "before: r1 without a lock");
  workflowLocksHook();
  assert.equal(store.lockOfRun("r1")?.key, "workflow:w1", "the lock was not brought along");
  assert.equal(store.lockOfRun("r2")?.key, "workflow:w2");
  assert.equal(store.getLock("workflow:w2").runId, "r2", "an existing lock was left untouched");
}));

test("workflowAbandonedHook: a running workflow run ends \"failed\" with its note; a finished one stays, a chat without a run is no error", () => withStore(() => {
  const { ws, chat } = seed();
  const c = chat("c1");
  store.createWorkflow({ id: "w1", workspaceId: ws.id, name: "W1", createdAt: now(), updatedAt: now() });
  store.startWorkflowRun({ id: "r1", chatId: "c1", workflowId: "w1", workflowName: "W1", workspaceId: ws.id });
  const rows = withConsole((z) => { workflowAbandonedHook({ chat: c, attempts: 2 }); return z; });
  assert.deepEqual(rows, []);
  const run = store.getWorkflowRun("c1");
  assert.equal(run.status, "failed");
  assert.equal(run.note, "Nach 2 Versuchen aufgegeben — der Schritt ließ sich nicht fortsetzen.");
  // The cap is in the text - it comes from the payload, not from a constant of the consumer.
  const c2 = chat("c2");
  store.startWorkflowRun({ id: "r2", chatId: "c2", workflowId: "w1", workflowName: "W1", workspaceId: ws.id });
  workflowAbandonedHook({ chat: c2, attempts: 7 });
  assert.match(store.getWorkflowRun("c2").note, /^Nach 7 Versuchen/);
  // Already finished: stays (finishWorkflow ends exactly once).
  workflowAbandonedHook({ chat: c, attempts: 2 });
  assert.equal(store.getWorkflowRun("c1").note, "Nach 2 Versuchen aufgegeben — der Schritt ließ sich nicht fortsetzen.");
  // No run: nothing happens, no throw.
  const c3 = chat("c3");
  assert.doesNotThrow(() => workflowAbandonedHook({ chat: c3, attempts: 2 }));
}));

test("workflowRunsHook: a run whose chat is gone is abandoned - with its note", () => withStore(() => {
  const { ws } = seed();
  store.createWorkflow({ id: "w1", workspaceId: ws.id, name: "W1", createdAt: now(), updatedAt: now() });
  const run = store.startWorkflowRun({ id: "r1", chatId: "c-away", workflowId: "w1", workflowName: "W1", workspaceId: ws.id });
  workflowRunsHook({ flows: [run] });
  const after = store.getWorkflowRunById("r1");
  assert.notEqual(after.status, "running");
  assert.equal(after.note, "Chat deleted");
}));

// ── 3. The registration in server.js: a real boot ──────────────────────────
// The tests above register their own spies; whether server.js registers the REAL consumers only a boot shows.
// Seeded is what the restart handles without a model call: a WAITING workflow run without a lock row (flows takes
// only "running", the consumer brings the lock along for every open run) and a chat with exhausted resumptions and
// a running workflow run (abandoned branch, no doRun). The 2.5 s timer (server.js) is wall clock - hence here and
// not in the golden. Unregistering a consumer in server.js leaves workflow-locks-e2e green (the driver holds the lock
// itself there) - this test holds the registration.
// Without a clock: the restart runs at once (CBASE_RESTART_GRACE_MS=0) and the test waits for its end (test seam
// server.js:restartGraceCycles) instead of a deadline - a missing consumer turns it red instead of timing out.
test("Boot: server.js registers the restart consumers - lock brought along, abandoned run closed", async () => {
  const { startServer, restartGraceCycles } = await import("../electron/server/server.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-restart-grace-boot-"));
  const dataRoot = path.join(root, "data-root");
  const prevPoll = process.env.CBASE_TRIGGER_POLL;
  const prevRestartGrace = process.env.CBASE_RESTART_GRACE_MS;
  let server = null;
  try {
    process.env.CBASE_TRIGGER_POLL = "0";
    process.env.CBASE_RESTART_GRACE_MS = "0";
    fs.mkdirSync(path.join(root, "web"), { recursive: true });
    fs.mkdirSync(path.join(dataRoot, "data"), { recursive: true });
    // Seed BEFORE the boot into the same database (startServer opens <dataRoot>/data again).
    store.initStore(path.join(dataRoot, "data"));
    const { ws, chat } = seed();
    chat("c-waiting"); chat("c-on");
    store.createWorkflow({ id: "w1", workspaceId: ws.id, name: "W1", createdAt: now(), updatedAt: now() });
    store.updateWorkflow("w1", { lock: { scope: "workflow" } });
    store.startWorkflowRun({ id: "r-waiting", chatId: "c-waiting", workflowId: "w1", workflowName: "W1", workspaceId: ws.id });
    store.updateWorkflowRunById("r-waiting", { status: "waiting" });
    store.createWorkflow({ id: "w2", workspaceId: ws.id, name: "W2", createdAt: now(), updatedAt: now() });
    store.startWorkflowRun({ id: "r-on", chatId: "c-on", workflowId: "w2", workflowName: "W2", workspaceId: ws.id });
    store.setActiveRun("c-on", { prompt: "further" });
    store.bumpActiveRunAttempts("c-on"); store.bumpActiveRunAttempts("c-on");
    assert.equal(store.lockOfRun("r-waiting") ?? null, null);

    const prior = restartGraceCycles();
    server = await startServer({ port: 0, dataRoot, webDir: path.join(root, "web"), pickDirectory: null, notify: null });
    // This boot's restart is through - the consumers work synchronously (no doRun in this seed).
    while (restartGraceCycles() === prior) await new Promise((r) => setTimeout(r, 10));
    assert.equal(store.lockOfRun("r-waiting")?.key, "workflow:w1", "the waiting run's lock was not brought along at boot (workflow-locks not registered?)");
    const on = store.getWorkflowRunById("r-on");
    assert.equal(on?.status, "failed", "the abandoned chat's workflow run was not closed (workflow-abandoned not registered?)");
    assert.match(on.note, /^Nach 2 Versuchen aufgegeben/);
    assert.equal(store.listActiveRuns().length, 0);
  } finally {
    process.env.CBASE_TRIGGER_POLL = prevPoll === undefined ? "" : prevPoll;
    if (prevPoll === undefined) delete process.env.CBASE_TRIGGER_POLL;
    if (prevRestartGrace === undefined) delete process.env.CBASE_RESTART_GRACE_MS; else process.env.CBASE_RESTART_GRACE_MS = prevRestartGrace;
    if (server) { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
    catch (e) { console.warn("[restart-grace-hooks] cleanup:", e?.message || e); }
  }
});

// Stays the LAST test of the file: console.error is the original again.
test("zzz final: console.error is the original again", () => {
  assert.equal(console.error, REAL_ERROR);
});
