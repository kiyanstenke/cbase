// The queue of copies and the shared arbiter of the storage wait: stacks/queue.js and workflows/storage-queue.js, wired in server.js.
//
// What holds:
//   (0) The arbiter alone (fake sources): the oldest first, equally old in registration order; from the storage wait at most ONE
//       start per pass, a start from another wait does not count; a wake during a pass is dropped; a throwing source is missing
//       only in this pass; `storageQueueSoon` bundles.
//   (1) At the real seam: a graph start (older) and a copy (younger) wait for storage; the gate opens => the graph starts, the
//       copy only in the NEXT pass. On entering the storage wait a silent hint to the copy's chat — once, not per pass.
//   (2) Two requests of the same project => the second waits (`waiting_queue`, the reason names the first) and starts by itself at
//       the end of the first build. The start step is ONE synchronous step: when the procedure is entered the instance row
//       (`create`/`clone1`), the project occupancy "copy", the procedure mark and the heavy load "copy-clone" stand. (2b) Condition
//       (1) alone: an orphaned copy in the build (without occupancy) holds the second one.
//   (3) A relocation holds the heavy load => the copy waits; the release wakes it (heavy-load waker from server.js); a copy in the
//       clone holds the heavy load against a relocation.
//   (4) Restart grace: `build` without a living procedure => dismantling under the instance occupancy "copy-dismantling" and the
//       procedure mark, back to `waiting_queue` with the OLD `requested_at`, silent hint; `waiting_*` stays. Without a dismantling
//       connection, if the dismantling leaves the instance row standing or fails => `error`. If the project is occupied, the next
//       pass tries it. server.js calls copiesRestartGrace in the restart-grace timer BEFORE graphStartsRestartGrace.
//   (5) The safety net: a procedure that ends without a final state or throws => dismantling ("procedure-without-end") still under
//       the occupancy, then `error` with a hint; heavy load and occupancy are free afterwards. Without a procedure connection
//       nothing starts.
//   (4c) While the server ends (serverEnds) no build and no earmarked dismantling begins — `wakeStorageQueue()` counts 0, the rows
//       wait unchanged; in the next process both begin.
//   (4d) The restart-grace dismantling only begins once the clean-up of helper orphans (restart-grace hook "project-helper") is
//       through — the instance occupancy "copy-dismantling" already stands before.
//   (6) The main must be ready; (6b) waiting for the main tells the chat; (6c) a STOPPED main or template names the way.
//
// COUNTER-TESTS (each shown red, then reverted):
//   workflows/storage-queue.js: `fromStorage` per source instead of per pass (separate lanes)
//                                                         => (0) and (1) red (`wakeStorageQueue()` starts graph AND copy)
//   stacks/queue.js projectReason without the look at another copy in the build
//                                                         => (2) red (reason names the occupancy), (2b) red (k4 starts next to k3)
//   stacks/queue.js without condition (2) and without occupyHeavyLoad in the start
//                                                         => (2) red (no heavy load on entering), (3) red (next to the relocation)
//   server.js without setHeavyLoadWakeup                  => (3) red (the release does not wake the copy), (4b) red
//   stacks/queue.js backInTheQueue without the occupancy  => (4) red (no "copy-dismantling" when the dismantling is entered)
//   server.js without copiesRestartGrace                  => (4b) red (wiring)
//   stacks/queue.js runProcedure without the safety net   => (5) red (no dismantling, the copy would stay in `build`)
//   stacks/queue.js attempts without serverEnds           => (4c) red ("a build began in the ending process")
//   stacks/queue.js backInTheQueue without serverEnds     => (4c) red ("a dismantling began in the ending process")
//   stacks/queue.js dismantling without `await helperCleanedUp()`
//                                                         => (4d) red ("the dismantling began before the helper orphans were cleaned up")
//   stacks/queue.js projectReason without the look at the main
//                                                         => (6) red ("the build began next to a main in error")
//   server.js state waker without wakeMainReady           => (6) red ("the copy did not begin when the main became ready")
//   stacks/queue.js, stacks/state.js reduced to the state before the hint on waiting for the main
//                                                         => (6b) red ("no silent hint when waiting for a main in error")
//   stacks/queue.js without the `stopped` branch in the main's hint => (6c) red ("you have to do nothing");
//   stacks/state.js occupiedWhatToDo without baseStopped  => (6c) red (the 409 does not name the way)
// Two counter-tests first ran into a HANG (a successor started after the clean-up, or the test waited for a dismantling that never
// came) — hence `end` (connections off, finish until nothing lives) and in (5) waiting for the end of the procedure instead of the
// dismantling.
//
// No clock: waits on states (waitForTruthy without deadline) and on draining the microtasks (setImmediate); the queue's tick is
// set to one day, every pass is a call of the test (the same module state, the server runs in the test process).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { fakeClaude, json, withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import { fakeDocker } from "./fake-docker.mjs";
import { readJsonl } from "./jsonl.mjs";
import { withOps } from "./projectbox-scenario.mjs";
import * as store from "../electron/server/store.js";
import { running } from "../electron/server/runs/state.js";
import { backgroundWork } from "../electron/server/runs/background.js";
import { serverEndMarkerForTest } from "../electron/server/runs/server-end.js";
import { copyInstance } from "../electron/server/projectbox/creation.js";
import { LABEL_HELPER, LABEL_HELPER_RUN, helperRestartGrace } from "../electron/server/projectbox/helper.js";
import { instanceOccupied, withProjectOccupancy, projectOccupied } from "../electron/server/projectbox/instance.js";
import { procedureAlive, setInstanceState } from "../electron/server/projectbox/instances.js";
import { occupyHeavyLoad, heavyLoadStatus } from "../electron/server/projectbox/heavyLoad.js";
import { buildAlive, copiesRestartGrace, setCopyProcedure, setCopyDismantling } from "../electron/server/stacks/queue.js";
import { copyRequests, setCopyState } from "../electron/server/stacks/state.js";
import { setStorageQueueSource, storageQueueSoon, storageQueueSources, wakeStorageQueue } from "../electron/server/workflows/storage-queue.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GIB = 1024 ** 3;
const micro = () => new Promise((r) => setImmediate(r)); // afterwards all microtasks have run

// ── (0) The arbiter alone ────────────────────────────────────────────────────────────────────────────────────────
// FIRST in the file: before the first server there is no source "graph"/"copies" that would run along here.

test("(0) arbiter: the oldest first, one from the storage wait per pass, other starts do not count, no re-entry, a throwing source is only missing", async () => {
  const lane = [];
  const candidate = (name, old, storage, { start = true, wake = false } = {}) => ({
    waitingSince: old, storage,
    attempts: () => {
      lane.push(name);
      if (wake) assert.equal(wakeStorageQueue(), null, "a wake during a pass is dropped");
      return start ? { started: true } : null;
    },
  });
  try {
    assert.deepEqual(storageQueueSources(), [], "no source before the first server");
    setStorageQueueSource("a", () => [candidate("a-storage-30", 30, true), candidate("a-queue-10", 10, false, { wake: true })]);
    setStorageQueueSource("b", () => [candidate("b-storage-20", 20, true), candidate("b-storage-30", 30, true), candidate("b-without-start-5", 5, true, { start: false })]);
    assert.deepEqual(storageQueueSources(), ["a", "b"]);
    // 5 (no start, does not count) · 10 (queue, does not count) · 20 (storage: THE one) · 30a, 30b (storage: wait).
    assert.equal(wakeStorageQueue(), 2);
    assert.deepEqual(lane, ["b-without-start-5", "a-queue-10", "b-storage-20"]);

    // Equally old: registration order. A throwing source is missing, the others run.
    lane.length = 0;
    setStorageQueueSource("a", () => [candidate("a-7", 7, true)]);
    setStorageQueueSource("b", () => [candidate("b-7", 7, true)]);
    setStorageQueueSource("c", () => { throw new Error("Probe"); });
    assert.equal(wakeStorageQueue(), 1);
    assert.deepEqual(lane, ["a-7"]);
    assert.throws(() => setStorageQueueSource("", () => []), /needs a name/);
    assert.throws(() => setStorageQueueSource("d", 42), /not a function/);

    // Bundled: three occasions at the same moment => ONE pass in the next microtick.
    lane.length = 0;
    setStorageQueueSource("c", null);
    let passes = 0;
    setStorageQueueSource("b", () => { passes += 1; return []; });
    storageQueueSoon(); storageQueueSoon(); storageQueueSoon();
    assert.equal(passes, 0, "nothing runs synchronously");
    await micro();
    assert.equal(passes, 1);
  } finally {
    for (const n of ["a", "b", "c", "d"]) setStorageQueueSource(n, null);
  }
});

// ── The seam: server, fake storage root, controllable procedure ──────────────────────────────────────────────────

function writeStorage(root, { max = null, current = null } = {}) {
  const cg = path.join(root, "sys", "fs", "cgroup");
  fs.mkdirSync(cg, { recursive: true });
  const set = (file, content) => (content === null ? fs.rmSync(file, { force: true }) : fs.writeFileSync(file, content));
  set(path.join(cg, "memory.max"), max === null ? null : `${max}\n`);
  set(path.join(cg, "memory.current"), current === null ? null : `${current}\n`);
}
const FULL = { max: 8 * GIB, current: Math.round(8 * GIB * 0.9) };
const RELAXED = { max: 8 * GIB, current: 2 * GIB };
const FULL_REASON = "wartet auf Speicher: Container bei 90 % seiner Grenze (7,2 von 8,0 GiB)";

function open() {
  let resolve;
  let reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

// The controllable procedure (stand-in for the real build): holds until the test calls `end(kind)` — "error" (clean: instance row
// gone, row `error`), "without-end" (resolved, nothing set), "throwing". On entering it records what the start step set
// SYNCHRONOUSLY. `heavyLoadImmediately` releases the heavy load at once (as the procedure after phase 2).
function controllableProcedure({ heavyLoadImmediately = false } = {}) {
  const runs = [];
  const fn = (o) => {
    const pid = o.copy.projectId;
    const i = o.instance;
    const row = store.projectInstance(pid, i);
    const run = {
      ...o,
      atEnter: {
        instanceRow: row ? [row.state, row.phase, row.chatId, row.copyName] : null,
        occupancy: projectOccupied(pid),
        procedureAlive: procedureAlive(pid, i),
        heavyLoad: heavyLoadStatus() ? [heavyLoadStatus().kind, heavyLoadStatus().projectId, heavyLoadStatus().instance] : null,
        journal: typeof o.journal?.read === "function" || typeof o.journal === "object",
      },
    };
    const d = open();
    run.end = (kind = "error") => d.resolve(kind);
    runs.push(run);
    if (heavyLoadImmediately) o.releaseHeavyLoad();
    return track(run, d.promise.then((kind) => {
      if (kind === "throwing") throw new Error("Probe: the procedure threw");
      if (kind === "error") {
        store.deleteProjectInstance(pid, i);
        setCopyState(o.copy.id, "error", { error: "Probe: build failed" });
      }
    }));
  };
  return { fn, runs, endAll: () => { for (const l of runs) l.end("error"); }, open: () => runs.some((l) => !l.finished) };
}
// Remembers when the promise returned by a controllable run is settled (for `end`).
function track(run, p) {
  run.finished = false;
  p.then(() => { run.finished = true; }, () => { run.finished = true; });
  return p;
}

// Clean up: every row to `removed` (with its instance row) — otherwise an instance row would hold the harness's quiet.
function clean(id) {
  const k = store.stackCopy(id);
  if (!k || k.state === "removed") return;
  if (["build", "ready", "clearAway"].includes(k.state)) setCopyState(id, "error", { error: "test end" });
  store.deleteProjectInstance(k.projectId, copyInstance(k.name));
  setCopyState(id, "removed");
}

async function withQueue(fn, { claude } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-queue-"));
  const prior = { CBASE_STORAGE_ROOT: process.env.CBASE_STORAGE_ROOT, CBASE_GRAPH_TICK_MS: process.env.CBASE_GRAPH_TICK_MS };
  process.env.CBASE_STORAGE_ROOT = root;
  process.env.CBASE_GRAPH_TICK_MS = String(24 * 3_600_000);
  writeStorage(root, RELAXED);
  try {
    // server.js connects the real build and dismantling (stacks/build.js, stacks/dismantling.js) — here the queue runs with
    // controllable connections, so first switch both off: without a connection nothing starts (5), every test sets its own.
    await withAgentsServer((ctx) => {
      setCopyProcedure(null);
      setCopyDismantling(null);
      return fn({ ...ctx, storage: (situation) => writeStorage(root, situation) });
    }, claude ? { claude } : {});
  } finally {
    setCopyProcedure(null);
    setCopyDismantling(null);
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}
// Clean up, also after a RED test: first no new starts (both connections off), then finish every controllable run until none lives
// — a finished build wakes the queue, and a successor that started before the disconnect would otherwise never end (a failure
// would turn into a hang). Afterwards every row to `removed`.
async function end({ control = [], ids = [] }) {
  setCopyProcedure(null);
  setCopyDismantling(null);
  await waitForTruthy(async () => {
    for (const s of control) s.endAll();
    await micro();
    return ids.some((id) => buildAlive(store.stackCopy(id))) || control.some((s) => s.open()) ? null : true;
  }, "all builds and dismantlings finished");
  for (const id of ids) clean(id);
}
const hints = (chatId) => store.openHints(chatId).filter((h) => h.source === "stack-copy");
const aliveNot = (id) => waitForTruthy(() => (buildAlive(store.stackCopy(id)) ? null : true), `build ${id} finished`);

// ── (1) graph start and copy share ONE arbiter ───────────────────────────────────────────────────────────────────

// The fake main agent as in graph-background.test.js: "GS[<tag>]:{json}§" calls `cbase_workflow_start` through the REAL
// cbase MCP server (result in `gs-<tag>.jsonl`), "HALT:<x>" in the text of a step holds at the gate.
const MAIN = `
  const step = String(text).includes("[cbase workflow");
  const g = text.indexOf("GS[");
  if (g >= 0 && !step) {
    const gtag = text.slice(g + 3, text.indexOf("]:", g));
    const args = JSON.parse(text.slice(text.indexOf("]:", g) + 2, text.indexOf("§", g)));
    const id = "toolu_gs_" + gtag;
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
  say({ type: "result", result: step ? "DONE" : "Started.", session_id: "s-main" });`;

function newWorkflow(ws, name, text) {
  const now = Date.now();
  const w = store.createWorkflow({ id: crypto.randomUUID(), workspaceId: ws.id, name, createdAt: now, updatedAt: now, graph: {
    nodes: [{ id: "s", type: "start", title: "Start" }, { id: "n1", type: "instruction", title: "Step", text }, { id: "e", type: "end", title: "End" }],
    edges: [{ from: "s", to: "n1" }, { from: "n1", to: "e" }],
  } });
  return store.updateWorkflow(w.id, { run: { doneAll: false }, lock: { scope: "off" } });
}
async function start(base, root, chatId, short, tag) {
  const res = await fetch(`${base}/api/chats/${chatId}/message`, { method: "POST", headers: { "Content-Type": "application/json", Connection: "close" },
    body: JSON.stringify({ text: `/workflow:${short} GS[${tag}]:${JSON.stringify({ workflow: short, input: "go", background: true })}§` }) });
  assert.equal(res.status, 202, await res.text());
  const file = path.join(root, `gs-${tag}.jsonl`);
  const [{ t }] = await waitForTruthy(() => { const z = readJsonl(file); return z.length ? z : null; }, `tool result ${tag}`);
  assert.ok(!t.startsWith("ERROR "), t);
  await waitForTruthy(() => !running.has(chatId), `turn of ${chatId} finished`);
  return JSON.parse(t).start;
}

test("(1) graph older, copy younger, both wait for storage — the gate opens => the graph first, the copy in the NEXT pass", async () => {
  await withQueue(async ({ base, ws, chat, root, gate, storage }) => {
    const fromIdx = controllableProcedure();
    setCopyProcedure(fromIdx.fn);
    newWorkflow(ws, "Queue Flow", "QUEUE HALT:h");
    storage(FULL);
    const kc = await json(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, provider: "claude", model: "claude-haiku-4-5-20251001" }) });
    let k = null;
    try {
      const g = await start(base, root, chat.id, "queue-flow", "a");
      assert.equal(g.state, "waiting_storage", JSON.stringify(g));
      k = copyRequests({ projectId: "p-queue", name: "k1", chatId: kc.id });
      assert.ok(store.graphStart(g.startId).createdAt <= k.requestedAt, "the graph is not older");

      // Gate closed: nothing starts; the copy enters the storage wait, with a reason and ONE silent hint.
      assert.equal(wakeStorageQueue(), 0);
      assert.equal(store.graphStart(g.startId).status, "waiting_storage");
      const kw = store.stackCopy(k.id);
      assert.deepEqual([kw.state, kw.reason], ["waiting_storage", FULL_REASON]);
      assert.equal(hints(kc.id).length, 1);
      assert.match(hints(kc.id)[0].text, /^Deine Kopie „k1“ wartet auf Speicher: .* und baut dann von selbst/);
      assert.equal(wakeStorageQueue(), 0);
      assert.equal(hints(kc.id).length, 1, "one hint per entry, not per pass");
      assert.equal(fromIdx.runs.length, 0);

      // Gate open: ONE pass starts the graph — the copy waits (one per pass across BOTH queues).
      storage(RELAXED);
      assert.equal(wakeStorageQueue(), 1);
      assert.equal(store.graphStart(g.startId).status, "started");
      assert.equal(store.stackCopy(k.id).state, "waiting_storage", "the copy started in the same pass — separate lanes");
      assert.equal(fromIdx.runs.length, 0);
      await gate.reached("h"); // the graph run's step holds — no run end, no waker in between

      // The next pass: the copy.
      assert.equal(wakeStorageQueue(), 1);
      const kb = store.stackCopy(k.id);
      assert.deepEqual([kb.state, kb.phase, kb.reason], ["build", "clone1", ""]);
      assert.equal(fromIdx.runs.length, 1);

      fromIdx.runs[0].end("error");
      await aliveNot(k.id);
      gate.open("h");
      const gz = store.graphStart(g.startId);
      await waitForTruthy(() => { const r = store.getWorkflowRunById(gz.runId); return r && !store.workflowOpen(r) ? r : null; }, "graph run finished");
      await waitForTruthy(() => (backgroundWork(chat.id).length ? null : true), "nothing open any more");
      await waitForTruthy(() => !running.has(chat.id), "orchestrator free");
    } finally {
      await end({ control: [fromIdx], ids: k ? [k.id] : [] });
    }
  }, { claude: fakeClaude({ main: MAIN }) });
});

// ── (2) one build per project and the synchronous start step ─────────────────────────────────────────────────────

test("(2) two requests of the same project => the second waits and starts at the end of the first; the start step is ONE synchronous step", async () => {
  await withQueue(async () => {
    const fromIdx = controllableProcedure({ heavyLoadImmediately: true });
    setCopyProcedure(fromIdx.fn);
    const pid = "p-n33";
    const ids = [];
    try {
      const k1 = copyRequests({ projectId: pid, name: "k1", chatId: "c-n33-a" });
      const k2 = copyRequests({ projectId: pid, name: "k2", chatId: "c-n33-b" });
      ids.push(k1.id, k2.id);
      assert.equal(wakeStorageQueue(), 1);
      assert.deepEqual([store.stackCopy(k1.id).state, store.stackCopy(k1.id).phase], ["build", "clone1"]);
      const w = store.stackCopy(k2.id);
      assert.equal(w.state, "waiting_queue");
      assert.match(w.reason, /wartet auf die Kopie „k1“ desselben Projekts \(im Aufbau\)/);
      assert.equal(fromIdx.runs.length, 1);
      // When the procedure is entered EVERYTHING stands — without an await in between.
      assert.deepEqual(fromIdx.runs[0].atEnter, {
        instanceRow: ["create", "clone1", "c-n33-a", "k1"],
        occupancy: "copy",
        procedureAlive: true,
        heavyLoad: ["copy-clone", pid, "copy-k1"],
        journal: true,
      });
      assert.equal(fromIdx.runs[0].instance, "copy-k1");
      assert.equal(heavyLoadStatus(), null, "the procedure released the heavy load (releaseHeavyLoad)");

      // The end of the first build wakes the queue (bundled in the next microtick) — the second begins by itself.
      fromIdx.runs[0].end("error");
      await waitForTruthy(() => (store.stackCopy(k2.id).state === "build" ? true : null), "k2 begins at the end of k1");
      assert.equal(store.stackCopy(k1.id).state, "error");
      assert.equal(projectOccupied(pid), "copy", "k2 now holds the occupancy");
      fromIdx.runs[1].end("error");
      await aliveNot(k2.id);
      assert.equal(projectOccupied(pid), null);
    } finally {
      await end({ control: [fromIdx], ids });
    }
  });
});

test("(2b) condition (1) alone: a copy in the build WITHOUT occupancy (orphaned, before its dismantling) holds the next one of the same project", async () => {
  await withQueue(async () => {
    const fromIdx = controllableProcedure();
    setCopyProcedure(fromIdx.fn);
    const pid = "p-n33-orphan";
    const ids = [];
    try {
      const k3 = copyRequests({ projectId: pid, name: "k3", chatId: "c-orphan-a" });
      const k4 = copyRequests({ projectId: pid, name: "k4", chatId: "c-orphan-b" });
      ids.push(k3.id, k4.id);
      setCopyState(k3.id, "build", { phase: "clone1" });
      setCopyState(k3.id, "build", { phase: "clone2" });
      assert.equal(projectOccupied(pid), null);
      assert.equal(buildAlive(store.stackCopy(k3.id)), false);
      assert.equal(wakeStorageQueue(), 0);
      assert.equal(fromIdx.runs.length, 0, "k4 started next to the orphaned k3");
      const w = store.stackCopy(k4.id);
      assert.equal(w.state, "waiting_queue");
      assert.match(w.reason, /Kopie „k3“ desselben Projekts/);
    } finally {
      await end({ control: [fromIdx], ids });
    }
  });
});

// ── (3) the heavy load ───────────────────────────────────────────────────────────────────────────────────────────

test("(3) a relocation holds the heavy load => the copy waits; the release wakes it; a copy in the clone holds the heavy load against a relocation", async () => {
  await withQueue(async ({ base }) => {
    const fromIdx = controllableProcedure();
    setCopyProcedure(fromIdx.fn);
    const ids = [];
    let free = null;
    try {
      free = occupyHeavyLoad("relocation", { projectId: "p-relocation" });
      const k = copyRequests({ projectId: "p-heavy", name: "k1", chatId: "c-heavy" });
      ids.push(k.id);
      assert.equal(wakeStorageQueue(), 0);
      const w = store.stackCopy(k.id);
      assert.equal(w.state, "waiting_queue");
      assert.match(w.reason, /schweren Plattenvorgang \(relocation für p-relocation\/main\)/);
      assert.equal(fromIdx.runs.length, 0, "the copy started next to the relocation");

      // The release wakes (projectbox/heavyLoad.js -> server.js setHeavyLoadWakeup -> one bundled pass).
      free();
      free = null;
      await micro();
      assert.deepEqual([store.stackCopy(k.id).state, store.stackCopy(k.id).phase], ["build", "clone1"], "the release of the heavy load did not wake the queue");
      assert.deepEqual(heavyLoadStatus() && [heavyLoadStatus().kind, heavyLoadStatus().instance], ["copy-clone", "copy-k1"]);
      // Conversely: a relocation finds the heavy load occupied.
      assert.throws(() => occupyHeavyLoad("relocation", { projectId: "p-relocation" }), (e) => e.code === "HEAVY_LOAD_OCCUPIED" && /copy-clone/.test(e.message));
      const a = await json(`${base}/api/runs/active`);
      assert.ok(a.projectWork.some((x) => x.state === "heavyLoad" && x.phase === "copy-clone" && x.instance === "copy-k1"), JSON.stringify(a.projectWork));

      fromIdx.runs[0].end("error");
      await aliveNot(k.id);
      assert.equal(heavyLoadStatus(), null, "the end of the build released the heavy load");
    } finally {
      if (free) free();
      await end({ control: [fromIdx], ids });
    }
  });
});

// ── (4) restart grace ────────────────────────────────────────────────────────────────────────────────────────────

function controllableDismantling({ letsRow = false, raises = false } = {}) {
  const runs = [];
  const fn = (o) => {
    const pid = o.copy.projectId;
    const run = { ...o, atEnter: { instanceOccupied: instanceOccupied(pid, o.instance), procedureAlive: procedureAlive(pid, o.instance), projectOccupied: projectOccupied(pid) } };
    const d = open();
    run.end = () => d.resolve();
    runs.push(run);
    return track(run, d.promise.then(() => {
      if (raises) throw new Error("Probe: dismantling failed");
      if (!letsRow) store.deleteProjectInstance(pid, o.instance);
    }));
  };
  return { fn, runs, endAll: () => { for (const l of runs) l.end(); }, open: () => runs.some((l) => !l.finished) };
}

// A copy whose build began "in the last server run": the rows stand, no procedure lives.
function orphanedBuild(pid, name, chatId, phase = "freeze") {
  const k = copyRequests({ projectId: pid, name, chatId });
  setCopyState(k.id, "build", { phase: "clone1" });
  setCopyState(k.id, "build", { phase });
  return store.stackCopy(k.id);
}

test("(4) restart grace: build without a procedure => dismantling under \"copy-dismantling\", back to waiting_queue with the old place, silent hint; waiting_* stays; without a dismantling, with a standing row, failed => error; occupied => next pass", async () => {
  await withQueue(async ({ base }) => {
    const ids = [];
    const rbs = [];
    try {
      // The ordinary case.
      const rb = controllableDismantling();
      rbs.push(rb);
      setCopyDismantling(rb.fn);
      const k = orphanedBuild("p-restart", "k1", "c-restart");
      const w = copyRequests({ projectId: "p-restart-w", name: "k1", chatId: "c-restart-w" });
      ids.push(k.id, w.id);
      assert.equal((await json(`${base}/api/runs/active`)).busy, true, "the orphaned instance row in `create` holds busy");
      assert.equal(copiesRestartGrace(), 1);
      await micro(); // the dismantling begins after helperCleanedUp() (here a fulfilled promise), not in the same step
      assert.equal(rb.runs.length, 1);
      assert.equal(rb.runs[0].reason, "restart");
      assert.equal(rb.runs[0].instance, "copy-k1");
      assert.deepEqual(rb.runs[0].atEnter, { instanceOccupied: "copy-dismantling", procedureAlive: true, projectOccupied: null },
        "the dismantling runs under the copy's instance occupancy (next to the main) and the procedure mark");
      assert.equal(copiesRestartGrace(), 0, "a second restart grace does not start a second dismantling");
      rb.runs[0].end();
      await waitForTruthy(() => (store.stackCopy(k.id).state === "waiting_queue" ? true : null), "k1 back in the queue");
      const z = store.stackCopy(k.id);
      assert.equal(z.requestedAt, k.requestedAt, "the old place");
      assert.match(z.reason, /Neustart des Servers mitten im Aufbau \(Phase „freeze“\) — zurückgebaut, wieder in der Reihe \(alter Platz\)/);
      assert.equal(store.projectInstance("p-restart", "copy-k1"), null);
      assert.equal(hints("c-restart").length, 1);
      assert.match(hints("c-restart")[0].text, /steht wieder an ihrem alten Platz in der Reihe/);
      assert.deepEqual([store.stackCopy(w.id).state, store.stackCopy(w.id).reason], ["waiting_queue", ""], "waiting_* did not stay");
      assert.equal(hints("c-restart-w").length, 0);
      await micro();
      assert.equal(instanceOccupied("p-restart", "copy-k1"), null);
      assert.equal((await json(`${base}/api/runs/active`)).busy, false);

      // Without a dismantling connection: nothing is safely taken down => error (with its instance row), hint.
      setCopyDismantling(null);
      const k2 = orphanedBuild("p-restart2", "k1", "c-restart2");
      ids.push(k2.id);
      assert.equal(copiesRestartGrace(), 1);
      const f2 = store.stackCopy(k2.id);
      assert.equal(f2.state, "error");
      assert.match(f2.error, /kein Rückbau angeschlossen/);
      assert.equal(store.projectInstance("p-restart2", "copy-k1").state, "error");
      assert.equal(hints("c-restart2").length, 1);

      // The dismantling leaves the instance row standing => error; the dismantling throws => error.
      for (const [opts, set, pid] of [[{ letsRow: true }, /ließ die Instanz-Zeile stehen/, "p-restart3"], [{ raises: true }, /Rückbau gescheitert: Probe/, "p-restart4"]]) {
        const r = controllableDismantling(opts);
        rbs.push(r);
        setCopyDismantling(r.fn);
        const kx = orphanedBuild(pid, "k1", `c-${pid}`);
        ids.push(kx.id);
        copiesRestartGrace();
        await micro();
        r.runs[0].end();
        await waitForTruthy(() => (store.stackCopy(kx.id).state === "error" ? true : null), `${pid} error`);
        assert.match(store.stackCopy(kx.id).error, set);
      }

      // The project is occupied at the restart grace (a relocation): no dismantling — the next pass makes up for it.
      const r5 = controllableDismantling();
      rbs.push(r5);
      setCopyDismantling(r5.fn);
      const k5 = orphanedBuild("p-restart5", "k1", "c-restart5");
      ids.push(k5.id);
      const hold = open();
      const relocation = withProjectOccupancy("p-restart5", "relocation", () => hold.promise);
      assert.equal(copiesRestartGrace(), 1);
      assert.equal(r5.runs.length, 0, "dismantling next to a relocation of the same project");
      wakeStorageQueue();
      assert.equal(r5.runs.length, 0);
      hold.resolve();
      await relocation;
      wakeStorageQueue();
      await micro();
      assert.equal(r5.runs.length, 1, "the pass after the occupancy did not make up for the dismantling");
      r5.runs[0].end();
      await waitForTruthy(() => (store.stackCopy(k5.id).state === "waiting_queue" ? true : null), "k5 back in the queue");
    } finally {
      await end({ control: rbs, ids });
    }
  });
});

test("(4b) server.js: copiesRestartGrace stands in the restart-grace timer BEFORE graphStartsRestartGrace; the sources and wakeups are registered", () => {
  const server = fs.readFileSync(path.join(HERE, "../electron/server/server.js"), "utf8");
  const block = server.slice(server.indexOf("const restartGrace = setTimeout("), server.indexOf("}, restartGraceMs());"));
  const k = block.indexOf("copiesRestartGrace();");
  const g = block.indexOf("graphStartsRestartGrace();");
  assert.ok(k > 0 && g > k, "copiesRestartGrace is missing in the restart-grace timer or stands after graphStartsRestartGrace");
  for (const row of ['setStorageQueueSource("graph", graphCandidates);', 'setStorageQueueSource("copies", copyCandidates);',
    // the queue's waker also wakes the jobs to remove (stacks/remove.js).
    "setQueueWakeup(() => { storageQueueSoon(); copiesRemoveWake(); });", "setHeavyLoadWakeup(() => storageQueueSoon());", "setTriggerWakeup(() => { scheduleTriggerDrain(); wakeStorageQueue(); });",
    "setCopyProcedure(copyBuild);", "setCopyDismantling(dismantleCopy);"]) {
    assert.ok(server.includes(row), `server.js: ${row}`);
  }
  assert.match(server, /const graphTick = setInterval\(\(\) => \{ try \{ wakeStorageQueue\(\); \}/, "the tick does not wake the arbiter");
  assert.deepEqual(storageQueueSources().slice(0, 2), ["graph", "copies"], "the sources in this order (tie: graph first)");
});

// ── (4c) the server end in the queue ─────────────────────────────────────────────────────────────────────────────
// The mark "server ends" is set in the product by the shutdown (with process.exit at the end) — here the test seam of the sheet.

test("(4c) the server ends: no build and no earmarked dismantling begins — the rows wait unchanged; in the next process both begin", async () => {
  await withQueue(async () => {
    const fromIdx = controllableProcedure();
    const rb = controllableDismantling();
    setCopyProcedure(fromIdx.fn);
    setCopyDismantling(rb.fn);
    const ids = [];
    try {
      const k = copyRequests({ projectId: "p-end", name: "k1", chatId: "c-end" });
      // An orphaned build whose dismantling hung on an occupancy at the restart grace — earmarked, every pass tries it.
      const v = orphanedBuild("p-end-v", "k1", "c-end-v");
      ids.push(k.id, v.id);
      const hold = open();
      const relocation = withProjectOccupancy("p-end-v", "relocation", () => hold.promise);
      assert.equal(copiesRestartGrace(), 1);
      hold.resolve();
      await relocation;

      serverEndMarkerForTest(true);
      const prior = store.stackCopy(k.id);
      assert.equal(wakeStorageQueue(), 0, "a build began in the ending process");
      await micro();
      assert.equal(fromIdx.runs.length, 0);
      assert.equal(rb.runs.length, 0, "a dismantling began in the ending process");
      assert.deepEqual(store.stackCopy(k.id), prior, "the row waits unchanged");
      assert.equal(store.stackCopy(v.id).state, "build");

      // The next process: without the mark the same pass starts both.
      serverEndMarkerForTest(false);
      assert.equal(wakeStorageQueue(), 1);
      await micro();
      assert.equal(fromIdx.runs.length, 1);
      assert.equal(rb.runs.length, 1, "the earmarked dismantling stayed lying");
    } finally {
      serverEndMarkerForTest(false);
      await end({ control: [fromIdx, rb], ids });
    }
  });
});

// ── (4d) the restart-grace dismantling waits for the clean-up of helper orphans ──────────────────────────────────

test("(4d) the restart-grace dismantling only begins after the clean-up of the helper orphans (like the relocation) — the occupancy already stands before", async () => {
  const fd = await fakeDocker({ rmGate: "rm" });
  try {
    await withQueue(async () => {
      const rb = controllableDismantling();
      setCopyDismantling(rb.fn);
      const ids = [];
      try {
        await withOps(fd, async () => {
          // An orphan: a clone helper of the last server run (another `cbase.helper.run`), the label ON the container.
          execFileSync(fd.bin, ["run", "-d", "--name", "cbase-helper-orphan", "--label", `${LABEL_HELPER}=clone`, "--label", `${LABEL_HELPER_RUN}=earlier`, "cbase-projectbox:latest"]);
          const k = orphanedBuild("p-orphan-h", "k1", "c-orphan-h");
          ids.push(k.id);
          const cleanUp = helperRestartGrace(); // the hook "project-helper" (asynchronous) — hangs on the orphan's `rm`
          await fd.gateReached("rm");
          assert.equal(copiesRestartGrace(), 1);
          await micro();
          assert.equal(instanceOccupied("p-orphan-h", "copy-k1"), "copy-dismantling", "the occupancy \"copy-dismantling\" does not stand while the dismantling waits");
          assert.equal(rb.runs.length, 0, "the dismantling began before the helper orphans were cleaned up");
          fd.openGate("rm");
          assert.equal((await cleanUp).removed.length, 1);
          await waitForTruthy(() => (rb.runs.length === 1 ? true : null), "dismantling after the clean-up");
          rb.runs[0].end();
          await waitForTruthy(() => (store.stackCopy(k.id).state === "waiting_queue" ? true : null), "back in the queue");
        });
      } finally {
        fd.openGate("rm");
        await end({ control: [rb], ids });
      }
    });
  } finally { fd.cleanUp(); }
});

// ── (5) the safety net and "without a procedure nothing" ─────────────────────────────────────────────────────────

test("(5) safety net: a procedure without a final state (resolved or thrown) => dismantling \"procedure-without-end\" under the occupancy, then error; without a procedure connection nothing starts", async () => {
  await withQueue(async ({ base }) => {
    const ids = [];
    const fromIdx = controllableProcedure();
    const rb = controllableDismantling();
    try {
      // Without a procedure connection: the queue starts nothing, the row stays as it is.
      const k0 = copyRequests({ projectId: "p-network0", name: "k1", chatId: "c-network0" });
      ids.push(k0.id);
      assert.equal(wakeStorageQueue(), 0);
      assert.deepEqual([store.stackCopy(k0.id).state, store.stackCopy(k0.id).reason], ["waiting_queue", ""]);
      setCopyState(k0.id, "removed");

      setCopyProcedure(fromIdx.fn);
      setCopyDismantling(rb.fn);
      for (const [kind, set, pid] of [["without-end", /^Aufbau endete ohne Ergebnis \(Phase „clone1“\)$/, "p-network1"], ["throwing", /^Aufbau gescheitert \(Phase „clone1“\): Probe: the procedure threw$/, "p-network2"]]) {
        const k = copyRequests({ projectId: pid, name: "k1", chatId: `c-${pid}` });
        ids.push(k.id);
        assert.equal(wakeStorageQueue(), 1);
        const run = fromIdx.runs.at(-1);
        const prior = rb.runs.length;
        run.end(kind);
        // Wait for the end of the PROCEDURE, not for the dismantling — without the net it would never come (a hang instead of a red).
        await waitForTruthy(() => (run.finished ? true : null), `procedure ${pid} finished`);
        await micro();
        assert.equal(rb.runs.length, prior + 1, `${kind}: no dismantling — the copy would stay in \`build\``);
        const r = rb.runs.at(-1);
        assert.equal(r.reason, "procedure-without-end");
        assert.equal(r.atEnter.projectOccupied, "copy", "the net's dismantling still runs under the build's occupancy");
        assert.equal(r.atEnter.procedureAlive, true);
        r.end();
        await aliveNot(k.id);
        const f = store.stackCopy(k.id);
        assert.equal(f.state, "error", `${kind}: the copy stayed in ${f.state}`);
        assert.match(f.error, set);
        assert.equal(store.projectInstance(pid, "copy-k1"), null);
        assert.equal(projectOccupied(pid), null);
        assert.equal(heavyLoadStatus(), null);
        assert.match(hints(`c-${pid}`).at(-1).text, /^Deine Kopie „k1“ entstand nicht: Aufbau/);
      }
      assert.equal((await json(`${base}/api/runs/active`)).busy, false);
    } finally {
      await end({ control: [fromIdx, rb], ids });
    }
  });
});

// ── (6) the main must be ready ───────────────────────────────────────────────────────────────────────────────────
// The queue used to see only occupancy, heavy load and storage: a main in `error` or `start` (resumption after a restart of B) let
// the build begin, and the freeze failed with MAIN_NOT_READY — the copy went to `error` although the main ran again seconds later.
// Now it waits in `waiting_queue` with a reason, and the main's transition to `ready` (projectbox/instances.js, state waker in
// server.js) wakes the queue. A project WITHOUT a main row does not wait (that would never end) — there the freeze decides as before.
test("(6) main in error or start => the copy waits with a reason; once it is ready, it begins by itself", async () => {
  await withQueue(async () => {
    const fromIdx = controllableProcedure();
    setCopyProcedure(fromIdx.fn);
    const pid = "p-main-ready";
    const ids = [];
    try {
      store.createProjectInstance({ projectId: pid, state: "error", convertedAt: Date.now(), error: "Probe: start failed" });
      const k = copyRequests({ projectId: pid, name: "k1", chatId: "c-main-ready" });
      ids.push(k.id);
      assert.equal(wakeStorageQueue(), 0, "the build began next to a main in error");
      let w = store.stackCopy(k.id);
      assert.deepEqual([w.state, w.error], ["waiting_queue", ""], `main in error: ${w.state} ${w.error}`);
      assert.match(w.reason, /Haupt nicht bereit \(error\)/);

      setInstanceState(pid, "main", "start");
      await micro();
      assert.equal(wakeStorageQueue(), 0, "the build began next to a main in start");
      w = store.stackCopy(k.id);
      assert.equal(w.state, "waiting_queue");
      assert.match(w.reason, /Haupt nicht bereit \(start\)/);
      assert.equal(fromIdx.runs.length, 0);

      // Ready => the state waker wakes the queue (no tick, no call of the test).
      setInstanceState(pid, "main", "ready");
      await micro(); // waker, bundling and pass are microtasks — afterwards everything has run (red instead of a hang)
      assert.equal(fromIdx.runs.length, 1, "the copy did not begin when the main became ready (no waker)");
      const b = store.stackCopy(k.id);
      assert.deepEqual([b.state, b.phase, b.reason], ["build", "clone1", ""]);
      fromIdx.runs[0].end("error");
      await aliveNot(k.id);
    } finally {
      await end({ control: [fromIdx], ids });
      store.deleteProjectInstance(pid, "main");
    }
  });
});

// ── (6b) waiting for the main tells the chat ─────────────────────────────────────────────────────────────────────
// The copy used to wait in "main not ready" without a word: no silent hint (only the storage wait created one), and the 409
// COPY_OCCUPIED of a new attempt said "cbase wakes …" — with a main in `error`, which never comes back by itself, the agent waited
// for a wake-up without end. Now on entering ONE hint per reason, with `error` with the way (next turn in the project or
// cbase_copy_stack_remove), and the 409 names reason and way. The 409 only comes over the NAME of the waiting copy (the same sentence).
test("(6b) main in error => one silent hint with the way, once per reason; the 409 COPY_OCCUPIED names reason and way; main in start => a second hint without the way", async () => {
  await withQueue(async () => {
    const fromIdx = controllableProcedure();
    setCopyProcedure(fromIdx.fn);
    const pid = "p-main-error";
    const chat = "c-main-error";
    const ids = [];
    try {
      store.createProjectInstance({ projectId: pid, state: "error", convertedAt: Date.now(), error: "Probe: start failed" });
      const k = copyRequests({ projectId: pid, name: "k1", chatId: chat });
      ids.push(k.id);
      assert.equal(wakeStorageQueue(), 0);
      let h = hints(chat);
      assert.equal(h.length, 1, `no silent hint when waiting for a main in error: ${JSON.stringify(h)}`);
      assert.match(h[0].text, /„k1“ wartet\. Das Haupt des Projekts steht auf „error“ und kommt von selbst nicht zurück: .*Turn.*cbase_copy_stack_remove \(name „k1“\)/);
      // The same reason in the next pass: no second hint.
      assert.equal(wakeStorageQueue(), 0);
      assert.equal(hints(chat).length, 1, "a second hint for the same reason");
      // A new attempt under its name: the 409 names reason and way (over the name — another name would go through).
      assert.throws(() => copyRequests({ projectId: pid, name: "k1", chatId: chat }), (e) => {
        assert.equal(e.code, "COPY_OCCUPIED");
        assert.match(e.message, /wartet auf ihren Aufbau \(wartet: Haupt nicht bereit \(error\).*\)\. Das Haupt des Projekts steht auf „error“ .*cbase_copy_stack_remove \(name „k1“\)/, e.message);
        return true;
      });
      // Another reason (the main starts up again): a second hint, without the way.
      setInstanceState(pid, "main", "start");
      await micro();
      assert.equal(wakeStorageQueue(), 0);
      h = hints(chat);
      assert.equal(h.length, 2, JSON.stringify(h));
      assert.match(h[1].text, /„k1“ wartet: das Haupt des Projekts ist nicht bereit \(start\) — sie beginnt von selbst/);
      assert.doesNotMatch(h[1].text, /cbase_copy_stack_remove/);
      assert.equal(fromIdx.runs.length, 0);
    } finally {
      await end({ control: [fromIdx], ids });
      store.deleteProjectInstance(pid, "main");
    }
  });
});

// ── (6c) a STOPPED main or template ──────────────────────────────────────────────────────────────────────────────
// A stopped main is no transition like `start`: only "Start" in the tab "Instances" or a turn in main brings it back. The hint used
// to say "it begins by itself as soon as it is ready; you have to do nothing" — the agent waited without end. Now hint, waiting
// reason and the 409 of its name name the way (stacks/state.js stoppedWay); the same for a copy from a stopped template. When the main
// is started (ready) the copy begins by itself as before.
test("(6c) main stopped => hint, reason and 409 name the tab \"Instances\" instead of \"you have to do nothing\"; started => the copy begins; template stopped likewise", async () => {
  await withQueue(async () => {
    const fromIdx = controllableProcedure();
    setCopyProcedure(fromIdx.fn);
    const pid = "p-main-stopped";
    const pidV = "p-template-stopped";
    const chat = "c-main-stopped";
    const chatV = "c-template-stopped";
    const ids = [];
    try {
      store.createProjectInstance({ projectId: pid, state: "stopped", convertedAt: Date.now() });
      const k = copyRequests({ projectId: pid, name: "k1", chatId: chat });
      ids.push(k.id);
      assert.equal(wakeStorageQueue(), 0, "the build began next to a stopped main");
      const w = store.stackCopy(k.id);
      assert.equal(w.state, "waiting_queue");
      assert.match(w.reason, /Haupt nicht bereit \(stopped\) — es startet nicht von selbst: im Reiter „Instanzen“ starten/, w.reason);
      const h = hints(chat);
      assert.equal(h.length, 1, JSON.stringify(h));
      assert.match(h[0].text, /„k1“ wartet\. Die Instanz main des Projekts ist gestoppt \(von Hand\) und startet nicht von selbst: im Reiter „Instanzen“ .*cbase_copy_stack_remove \(name „k1“\)/, h[0].text);
      assert.doesNotMatch(h[0].text, /du musst nichts tun/);
      assert.throws(() => copyRequests({ projectId: pid, name: "k1", chatId: chat }), (e) => {
        assert.equal(e.code, "COPY_OCCUPIED");
        assert.match(e.message, /Die Instanz main des Projekts ist gestoppt \(von Hand\) .*im Reiter „Instanzen“/, e.message);
        return true;
      });
      // Started => the state waker wakes the queue, the copy begins (no call of the test).
      setInstanceState(pid, "main", "ready");
      await micro();
      assert.equal(fromIdx.runs.length, 1, "the copy did not begin when the main was started");
      fromIdx.runs[0].end("error");
      await aliveNot(k.id);

      // A copy from the template k1 of a second project — the template lives (ready), its instance row is stopped.
      store.createProjectInstance({ projectId: pidV, state: "ready", convertedAt: Date.now() });
      const v = store.createStackCopy({ projectId: pidV, name: "k1", chatId: chatV, state: "ready" });
      ids.push(v.id);
      store.createProjectInstance({ projectId: pidV, instance: copyInstance("k1"), state: "stopped", convertedAt: Date.now() });
      const k2 = copyRequests({ projectId: pidV, name: "k2", chatId: chatV, baseInstance: copyInstance("k1") });
      ids.push(k2.id);
      assert.equal(wakeStorageQueue(), 0, "the build began next to a stopped template");
      const w2 = store.stackCopy(k2.id);
      assert.equal(w2.state, "waiting_queue", JSON.stringify(w2));
      assert.match(w2.reason, /Vorlage „k1“ nicht bereit \(stopped\) — sie startet nicht von selbst: im Reiter „Instanzen“ starten/, w2.reason);
      const h2 = hints(chatV);
      assert.equal(h2.length, 1, JSON.stringify(h2));
      assert.match(h2[0].text, /„k2“ wartet: ihre Vorlage „k1“ ist gestoppt\. Die Instanz copy-k1 des Projekts ist gestoppt \(von Hand\)/, h2[0].text);
      assert.doesNotMatch(h2[0].text, /sie beginnt von selbst, sobald die Vorlage bereit ist/);
      assert.equal(fromIdx.runs.length, 1);
    } finally {
      await end({ control: [fromIdx], ids });
      store.deleteProjectInstance(pid, "main");
      store.deleteProjectInstance(pidV, "main");
    }
  });
});
