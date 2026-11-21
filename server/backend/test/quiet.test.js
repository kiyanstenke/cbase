// The harness core: the server's quiet computation (`quiet`/`open` on /api/runs/active, runs/routes.js openWork), the stream
// barrier and the JSONL reader (quiet.mjs, jsonl.mjs).
//
// What holds here:
//   - EVERY item of the computation makes `quiet` false, and ONLY its own item is then 1 — one subtest per item, through the
//     real path where possible (a turn at the gate, a queued message, a background agent at the gate, a oneshot at the gate,
//     a hook not awaited), otherwise through the state the computation reads (compaction, goal gate, verdicts, wait phase,
//     dynamic workflow). `busy` stays what it was: true only for a run and a background agent (the deploy's gate hangs on it).
//   - The queue behind a wait row at the limit is NOT open work (it waits for the clock).
//   - `open` carries exactly these thirteen items — a new one needs its subtest here. `projectInstances` and `outerLoop` are
//     the only ones besides run and background agent that also make `busy`.
//   - The stream barrier: a lagging reader has everything before it after the barrier (in-process and over the IPC channel
//     of the server process), the return value is the position behind the marker, a chat stream without a reader throws.
//   - waitForQuiet waits across every item and throws on a route without `quiet`.
//   - readJsonl returns no half line (the old reader threw on one).
//
// COUNTER-TESTS: in openWork each item's count replaced by 0 => exactly that item's subtest red (for `queue` two — both
// check it). The barrier in "lags behind" replaced by `events.length` => red.
//
// No clock: tests wait for gates and events; there is no deadline at which a test turns red.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { fakeClaude, json, withAgentsServer } from "./agent-harness.mjs";
import { readJsonl } from "./jsonl.mjs";
import { GLOBAL, isBarrier, streamBarrier, waitForQuiet } from "./quiet.mjs";
import { compacting, pendingRunInputs, runWaiting, targetCheckOn, targetCheckOff } from "../electron/server/runs/state.js";
import { fireHooks, registerHook } from "../electron/server/runs/hooks.js";
import { runningVerdicts } from "../electron/server/workflows/driver.js";
import { runOnce } from "../electron/server/providers/index.js";
import { sse } from "../electron/server/runtime/sse.js";
import * as store from "../electron/server/store.js";
import { closeMonitors, startMonitor } from "../electron/server/runs/monitors.js";

process.env.CBASE_AGENT_IDLE_MS = String(24 * 3_600_000);
process.env.CBASE_AGENT_TICK_MS = String(3_600_000);

const ITEM = ["runs", "agents", "monitors", "dynWorkflows", "verdicts", "queue", "waitPhase", "compaction", "targetCheck", "hooks", "oneshots", "projectInstances", "outerLoop"];

// The main agent: "{GATE}" holds the turn at the gate "main", "{AGENT}" starts a background agent whose body stands at the gate
// "sub". The completion notice is a turn of its own and ends at once. A oneshot stands at the gate "oneshot".
const claude = fakeClaude({
  main: `
  if (!text.includes("<task-notification>")) {
    if (text.includes("{GATE}")) await gate("main");
    if (text.includes("{AGENT}")) {
      say({ type: "assistant", message: { id: "m-bg", content: [{ type: "tool_use", id: "toolu_bg", name: "mcp__cbase__cbase_agent",
        input: { description: "Probe", prompt: "Wait.", run_in_background: true } }] } });
      let t = "";
      try { t = textOf(await mcpCall("cbase_agent", { description: "Probe", prompt: "Wait.", run_in_background: true })); }
      catch (e) { t = "ERROR " + (e && e.message ? e.message : String(e)); }
      say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_bg", content: t }] } });
    }
  }
  finished();
  say({ type: "result", result: "finished", session_id: "main-session" });`,
  sub: `
  await gate("sub");
  finished();
  say({ type: "result", result: "Finding", session_id: "sub-session" });`,
  oneshot: `gate("oneshot").then(() => respond("ok"));`,
});

// A probe hook that returns an open promise ONLY for the probe payload — any other firing of the same kind in this process
// passes it by (otherwise the counter would stay at 1 forever). The real consumer of "inputDismissed" (scheduled/run.js
// scheduledInputDismissed) returns at once without `entry`. Registered only AFTER the first server start: startServer
// registers its list only while the registry is empty (registerEmpty) — a registration before would have taken that away.
let resolveHook = null;
let probeRegistered = false;
function reportProbeHookOn() {
  if (probeRegistered) return;
  registerHook("inputDismissed", (p) => (p?.quietProbe ? new Promise((r) => { resolveHook = r; }) : undefined), { name: "quiet-probe" });
  probeRegistered = true;
}

async function active(base) { return json(`${base}/api/runs/active`); }
// Exactly `item` is at `n`, all others at 0, `quiet` is false.
async function onlyOpen(base, item, n = 1) {
  const s = await active(base);
  assert.equal(s.quiet, false, `${item}: the server is not quiet — ${JSON.stringify(s.open)}`);
  for (const p of ITEM) assert.equal(s.open[p], p === item ? n : 0, `${item}: open.${p} — ${JSON.stringify(s.open)}`);
  return s;
}
async function quiet(base) {
  const s = await active(base);
  assert.equal(s.quiet, true, `quiet — ${JSON.stringify(s.open)}`);
  for (const p of ITEM) assert.equal(s.open[p], 0, `open.${p}`);
  return s;
}

test("quiet: every item of the computation makes `quiet` false — only its own is at 1, `busy` stays what it was", async (t) => {
  await withAgentsServer(async ({ base, chat, gate, waitForTruthy, waitForIdle }) => {
    reportProbeHookOn();
    const empty = await quiet(base);
    assert.deepEqual(Object.keys(empty.open).sort(), [...ITEM].sort(), "`open` carries exactly the thirteen items — a new one needs its subtest here");
    assert.equal(empty.busy, false);

    await t.test("runs + queue: a turn at the gate, a second message during the turn", async () => {
      try {
        await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "Wait {GATE}" }) });
        await gate.reached("main");
        const s = await onlyOpen(base, "runs");
        assert.equal(s.busy, true, "a turn is busy — unchanged");
        const r = await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "One more thing" }) });
        assert.equal(r.queued, true, JSON.stringify(r));
        const q = await active(base);
        assert.equal(q.quiet, false);
        assert.equal(q.open.runs, 1);
        assert.equal(q.open.queue, 1, `the queued message is open work: ${JSON.stringify(q.open)}`);
      } finally {
        // The waiting belongs in the finally: if a line above fails, the turn would run into the next subtest and turn it red
        // too — exactly THIS item should be red.
        gate.open("main");
        await waitForIdle();
        await waitForQuiet(base);
      }
      await quiet(base);
    });

    await t.test("queue: behind a wait row at the limit it is NOT open work (it waits for the clock)", async () => {
      const id = "quiet-probe-parked";
      pendingRunInputs.set(id, [{ id: "e1", prompt: "later", display: "later" }]);
      try {
        await onlyOpen(base, "queue");
        store.setPendingResume(id, { kind: "run", dueAt: Date.now() + 3_600_000, resetsAt: Date.now() + 3_600_000 });
        await quiet(base);
      } finally {
        pendingRunInputs.delete(id);
        store.clearPendingResume(id);
      }
      await quiet(base);
    });

    await t.test("agents: a background agent at the gate outlives the turn — busy as before", async () => {
      try {
        await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "Start {AGENT}" }) });
        await gate.reached("sub");
        // Wait for the end of the turn and its trailers (the hooks after the run) — the wait is on the THREE counts that are
        // not the subject; whether `agents` stands is checked only by the line after (a sabotage there turns red, no hang).
        await waitForTruthy(async () => { const a = await active(base); return a.runs === 0 && a.open.hooks === 0 && a.open.oneshots === 0 ? true : null; }, "turn end with a living agent");
        const s = await onlyOpen(base, "agents");
        assert.equal(s.busy, true, "a living agent is busy — unchanged");
      } finally {
        // As above: without the wait here the agent (with its completion-notice turn) would live on into the following
        // subtests after a failure.
        gate.open("sub");
        await waitForIdle();
        await waitForQuiet(base);
      }
      await quiet(base);
    });

    // A monitor belongs to the chat and outlives its turn — open work AND busy (it has no journal, a swap ends it).
    // COUNTER-TEST: `monitors` in openWork of runs/routes.js replaced by 0 => exactly this subtest red.
    await t.test("monitors: a living monitor without a turn — busy", async () => {
      const location = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-quiet-monitor-"));
      try {
        startMonitor(chat.id, { command: "sleep 600", description: "quiet probe", report: "end" }, { cwd: location, outputLocation: location, deliver: () => {} });
        const s = await onlyOpen(base, "monitors");
        assert.equal(s.busy, true, "a living monitor is busy");
      } finally {
        closeMonitors(chat.id);
        fs.rmSync(location, { recursive: true, force: true });
      }
      await quiet(base);
    });

    await t.test("oneshots: a oneshot at the gate (title, verdict, classification …) — not busy", async () => {
      const run = runOnce("Say ok.", { provider: "claude" });
      try {
        await gate.reached("oneshot");
        const s = await onlyOpen(base, "oneshots");
        assert.equal(s.busy, false, "a oneshot is no turn — busy stays false");
      } finally { gate.open("oneshot"); }
      assert.equal(await run, "ok");
      await quiet(base);
    });

    await t.test("hooks: a hook not awaited whose promise is still running — not busy", async () => {
      resolveHook = null;
      await fireHooks("inputDismissed", { chatId: null, entry: null, quietProbe: true });
      try {
        assert.equal(typeof resolveHook, "function", "the probe hook ran");
        const s = await onlyOpen(base, "hooks");
        assert.equal(s.busy, false);
      } finally { resolveHook?.(); }
      await waitForQuiet(base);
      await quiet(base);
    });

    // State the computation reads — the real paths to it (compaction, goal gate, verdict, monitor wait phase, dynamic
    // workflow) have their own tests; what counts here is that the computation sees each one.
    const state = [
      ["compaction", () => compacting.add("quiet-probe"), () => compacting.delete("quiet-probe")],
      ["targetCheck", () => targetCheckOn("quiet-probe"), () => targetCheckOff("quiet-probe")],
      ["verdicts", () => runningVerdicts.set("quiet-probe", 1), () => runningVerdicts.delete("quiet-probe")],
      ["waitPhase", () => runWaiting.set("quiet-probe", { monitors: [] }), () => runWaiting.delete("quiet-probe")],
    ];
    for (const [item, enabled, out] of state) {
      await t.test(`${item}: the state the computation reads — not busy`, async () => {
        enabled();
        try {
          const s = await onlyOpen(base, item);
          assert.equal(s.busy, false, `${item} is not busy — the deploy's gate stays as it was`);
        } finally { out(); }
        await quiet(base);
      });
    }

    await t.test("dynWorkflows: a running dynamic workflow (row \"running\") — not busy", async () => {
      const runId = "wf_quiet_probe";
      store.createDynRun({ runId, taskId: "t_quiet_probe", chatId: chat.id, name: "probe", meta: {}, scriptPath: "", outputPath: "" });
      try {
        const s = await onlyOpen(base, "dynWorkflows");
        assert.equal(s.busy, false, "dynamic workflows are not part of busy");
      } finally { store.endDynRun(runId, { status: "stopped" }); }
      await quiet(base);
    });

    // A project-container instance in a working state (here `relocation`) is open work AND busy — an unsecured step halts
    // deploy and reaper. `ready` is quiet.
    await t.test("projectInstances: an instance in relocation — busy", async () => {
      store.createProjectInstance({ projectId: "p-quiet-probe", state: "relocation" });
      try {
        const s = await onlyOpen(base, "projectInstances");
        assert.equal(s.busy, true, "a relocation is busy");
      } finally { store.changeProjectInstance("p-quiet-probe", "main", { state: "ready" }); }
      await quiet(base);
    });

    await t.test("outerLoop: a running outer-loop run (row \"running\") — busy", async () => {
      // Through the state the computation reads (the open outer-loop runs of the store): a real run would need agent, trigger and core.
      const id = "ol-quiet-probe";
      store.createOuterLoopRun({ id, agentId: "ol-agent-quiet-probe", chatId: chat.id, trigger: "quiet" });
      try {
        const s = await onlyOpen(base, "outerLoop");
        assert.equal(s.busy, true, "an outer-loop run is busy");
      } finally { store.outerLoopRunEnd(id, { state: "aborted", error: "quiet-probe" }); }
      await quiet(base);
    });
  }, { claude });
});

// A reader that puts each event into its list only after `ms` — the reader under load, deterministic.
function laggingReader(ms) {
  const events = [];
  return { events, take: (evt) => setTimeout(() => events.push(evt), ms) };
}
async function readingStream(url, take) {
  const ac = new AbortController();
  const res = await fetch(url, { signal: ac.signal, headers: { Accept: "text/event-stream", Connection: "close" } });
  assert.equal(res.status, 200);
  const pump = (async () => {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let cut;
        while ((cut = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          for (const line of frame.split("\n")) if (line.startsWith("data: ")) { try { take(JSON.parse(line.slice(6))); } catch { /* partial line */ } }
        }
      }
    } catch { /* abort on close */ }
  })();
  return { async shutdown() { ac.abort(); await pump; } };
}

test("stream barrier: a lagging reader has everything before it after the barrier — the return value is the position behind the marker", async () => {
  await withAgentsServer(async ({ base, chat, waitForTruthy }) => {
    const reader = laggingReader(150);
    const stream = await readingStream(`${base}/api/chats/${chat.id}/stream`, reader.take);
    try {
      await waitForTruthy(() => reader.events.some((e) => e.subtype === "connected"), "connected");
      for (let i = 1; i <= 5; i++) sse(chat.id, { type: "harness", subtype: "probe", n: i });
      // This is the situation the barrier exists for: the server has written, the reader has not yet got it.
      assert.ok(reader.events.filter((e) => e.subtype === "probe").length < 5, "the reader lags (otherwise the test proves nothing)");
      const from = await streamBarrier(reader, chat.id);
      assert.deepEqual(reader.events.filter((e) => e.subtype === "probe").map((e) => e.n), [1, 2, 3, 4, 5], "after the barrier everything before it is there");
      assert.ok(isBarrier(reader.events[from - 1]), "the return value stands behind the marker");
      sse(chat.id, { type: "harness", subtype: "probe", n: 6 });
      await waitForTruthy(() => reader.events.length > from, "the event after");
      assert.deepEqual(reader.events.slice(from).map((e) => e.n), [6], "behind the cut stands only what came after");
      // The global stream: the same promise through broadcast.
      const global = laggingReader(50);
      const g = await readingStream(`${base}/api/events`, global.take);
      try {
        await waitForTruthy(() => global.events.some((e) => e.type === "init"), "init of the global stream");
        const gBarrier = await streamBarrier(global, GLOBAL);
        assert.ok(isBarrier(global.events[gBarrier - 1]));
      } finally { await g.shutdown(); }
    } finally { await stream.shutdown(); }
    // A chat stream without a reader: the marker would never arrive — that is misuse, not waiting.
    await assert.rejects(streamBarrier([], "no-such-chat"), /no reader on stream no-such-chat/);
  }, { claude });
});

test("stream barrier over the IPC channel: the server as its own process writes the marker itself", async () => {
  await withAgentsServer(async ({ base, chat, waitForTruthy, barrier }) => {
    const reader = laggingReader(0);
    const stream = await readingStream(`${base}/api/chats/${chat.id}/stream`, reader.take);
    try {
      await waitForTruthy(() => reader.events.some((e) => e.subtype === "connected"), "connected");
      const bar = await barrier(reader);
      assert.ok(isBarrier(reader.events[bar - 1]), "the marker came through the server process");
      await assert.rejects(barrier([], "no-such-chat"), /no reader on stream no-such-chat/, "the error of the server process comes back");
    } finally { await stream.shutdown(); }
  }, { claude, childProcess: true });
});

test("waitForQuiet: waits across an item, throws on a route without `quiet`", async () => {
  await withAgentsServer(async ({ base }) => {
    compacting.add("quiet-probe-wait");
    let finished = false;
    const wait = waitForQuiet(base).then(() => { finished = true; });
    try {
      // Let two answers of the route pass without waitForQuiet finishing — counted, not timed.
      for (let i = 0; i < 2; i++) assert.equal((await active(base)).quiet, false);
      assert.equal(finished, false, "waitForQuiet does not return while an item is open");
    } finally { compacting.delete("quiet-probe-wait"); }
    await wait;
    assert.equal(finished, true);
  }, { claude });
  // A route without the field: empty is not unknown.
  const http = await import("node:http");
  const srv = http.createServer((req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ busy: false, runs: 0 })); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    await assert.rejects(waitForQuiet(`http://127.0.0.1:${srv.address().port}`), /without field "quiet"/);
  } finally { await new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }); }
});

test("readJsonl returns only completed lines — the old reader threw on a half one", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-jsonl-"));
  try {
    const file = path.join(dir, "log.jsonl");
    const old = (f) => fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    fs.writeFileSync(file, `${JSON.stringify({ n: 1 })}\n\n${JSON.stringify({ n: 2 })}\n{"n": 3, "prompt": "a long pro`);
    assert.deepEqual(readJsonl(file), [{ n: 1 }, { n: 2 }], "the half last line belongs to the writer");
    assert.throws(() => old(file), SyntaxError, "counter-test: the old reader throws on exactly this file");
    fs.appendFileSync(file, "mpt\"}\n");
    assert.deepEqual(readJsonl(file), [{ n: 1 }, { n: 2 }, { n: 3, prompt: "a long prompt" }], "once fully written, it is there");
    fs.writeFileSync(file, "");
    assert.deepEqual(readJsonl(file), []);
    assert.deepEqual(readJsonl(path.join(dir, "missing.jsonl")), [], "a missing file is an empty log");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
