// The provider-neutral monitor core: it keeps a run open, reports every event and must end reliably at the run end. The waiting
// phase hangs on it (the reason a chat can wait for a build or a log pattern without polling).
import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";

import { createMonitorRuntime } from "../electron/server/providers/monitor-runtime.js";

// Waiting for an event, without a deadline (no clock on which a test turns red). If it hangs, the suite ends the run.
const waitFor = async (fn) => {
  for (;;) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
};

test("shell watch: start, event, end", async () => {
  const events = [];
  const rt = createMonitorRuntime({
    cwd: os.tmpdir(),
    onStart: (t) => events.push({ e: "start", id: t.taskId }),
    onNotification: (t, ev) => events.push({ e: "fire", out: ev.output }),
    onDone: (t, status) => events.push({ e: "done", status }),
  });
  try {
    const task = rt.start({ command: "printf 'ROW-A\\n'; sleep 0.1; printf 'ROW-B\\n'", description: "Test watch", timeout_ms: 5000 });
    assert.ok(task.taskId);
    assert.equal(task.timeoutMs, 5000);

    await waitFor(() => events.some((x) => x.e === "done"));
    const fired = events.filter((x) => x.e === "fire");
    assert.ok(fired.length >= 1, "output must be delivered as an event");
    // 80 ms collection window: both lines can come in one or in two events.
    assert.match(fired.map((x) => x.out).join(""), /ROW-A/);
    assert.match(fired.map((x) => x.out).join(""), /ROW-B/);
    assert.equal(events[0].e, "start");
    assert.equal(events.at(-1).e, "done");
  } finally { rt.close(); }
});

test("TaskStop ends a persistent watch", async () => {
  const done = [];
  const rt = createMonitorRuntime({ cwd: os.tmpdir(), onDone: (t, s) => done.push(s) });
  try {
    const task = rt.start({ command: "sleep 60", description: "runs long", persistent: true });
    assert.equal(task.timeoutMs, 0, "persistent = no deadline");
    assert.equal(rt.stop(task.taskId), true);
    await waitFor(() => done.length > 0);
    // A second stop honestly reports that there is nothing left to stop.
    assert.equal(rt.stop(task.taskId), false);
  } finally { rt.close(); }
});

test("invalid arguments fail early and clearly", () => {
  const rt = createMonitorRuntime({ cwd: os.tmpdir() });
  try {
    assert.throws(() => rt.start({ description: "nothing" }), /Exactly one of command or ws/);
    assert.throws(() => rt.start({ command: "x", ws: "ws://a", description: "both" }), /Exactly one of command or ws/);
    assert.throws(() => rt.start({ ws: "http://example.org", description: "wrong" }), /ws:\/\/ or wss:\/\//);
    // Credentials in the URL are forbidden (they would land in the history otherwise).
    assert.throws(() => rt.start({ ws: "ws://user:pw@example.org", description: "creds" }), /credentials/);
  } finally { rt.close(); }
});

test("close() clears all watches at the run end, without farewell events", async () => {
  const done = [];
  const rt = createMonitorRuntime({ cwd: os.tmpdir(), onDone: () => done.push(1) });
  const a = rt.start({ command: "sleep 60", description: "a", persistent: true });
  const b = rt.start({ command: "sleep 60", description: "b", persistent: true });
  rt.close();
  // Deliberately SILENT: a run end must not write "ended" lines into the history that the user never requested. The tasks are gone
  // all the same: a second stop finds nothing. Waits until BOTH processes have reported their end (test seam endProcess): only then
  // did their "close" have the chance to produce a done; a time window would silently be too short under load.
  await waitFor(() => rt.endProcess() >= 2);
  assert.deepEqual(done, []);
  assert.equal(rt.stop(a.taskId), false);
  assert.equal(rt.stop(b.taskId), false);
});

// ── Flood brake ──────────────────────────────────────────────────────────────
// Every event of this core is injected into the run as a turn of its own and so costs a model call. Since the core replaces
// Claude's built-in monitor tool for ALL providers, it must bring its brake: first throttle, then cut off.
const withEnv = async (vars, fn) => {
  const before = {};
  for (const [k, v] of Object.entries(vars)) { before[k] = process.env[k]; process.env[k] = String(v); }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
};

test("too many events are throttled and summarised", async () => {
  await withEnv({
    CBASE_MONITOR_RATE_MAX: 3,
    CBASE_MONITOR_RATE_WINDOW_MS: 60_000,
    CBASE_MONITOR_THROTTLE_MS: 400,
    CBASE_MONITOR_MAX_EVENTS: 1000,
  }, async () => {
    const fired = [];
    const rt = createMonitorRuntime({ cwd: os.tmpdir(), onNotification: (t, ev) => fired.push(ev.output) });
    try {
      // Ten lines with spacing: without a brake that would be ten turns.
      rt.start({ command: "for i in 1 2 3 4 5 6 7 8 9 10; do echo Z$i; sleep 0.12; done", description: "Chatterbox", timeout_ms: 8000 });
      await waitFor(() => fired.join("").includes("Z10"));
      assert.ok(fired.length <= 6, `too many single notices: ${fired.length}`);
      assert.ok(fired.some((f) => f.includes("throttled")), `no summary notice: ${JSON.stringify(fired)}`);
      // Nothing may be lost: the summary notice carries the held-back lines.
      const all = fired.join("\n");
      for (const z of ["Z1", "Z5", "Z10"]) assert.match(all, new RegExp(z + "\\b"));
    } finally { rt.close(); }
  });
});

test("a runaway watch is ended instead of littering the chat", async () => {
  await withEnv({
    CBASE_MONITOR_RATE_MAX: 1000,   // switch throttling off here: the ripcord is what is tested
    CBASE_MONITOR_MAX_EVENTS: 4,
  }, async () => {
    const fired = [];
    const done = [];
    const rt = createMonitorRuntime({
      cwd: os.tmpdir(),
      onNotification: (t, ev) => fired.push(ev),
      onDone: (t, status) => done.push(status),
    });
    try {
      rt.start({ command: "for i in $(seq 1 40); do echo FLUT$i; sleep 0.1; done", description: "Runaway", timeout_ms: 60_000 });
      await waitFor(() => done.length);
      assert.equal(done[0], "flooded");
      assert.equal(fired.at(-1).status, "flooded");
      assert.match(fired.at(-1).output, /NARROWER filter/);
      assert.ok(fired.length <= 5, `the ripcord came too late: ${fired.length} events`);
      assert.equal(rt.list().length, 0, "the watch must be gone");
    } finally { rt.close(); }
  });
});

// A PERSISTENT monitor (a watch open for days, the Teams watch on a WebSocket) has no total cap: the
// throttle stays its cost protection. Same knobs as the runaway above — the same watch with persistent: true keeps running past the
// cap and every line still arrives.
// COUNTER-PROOF: the `!rec.persistent &&` in the rip cord of providers/monitor-runtime.js removed => "keeps running past the cap" red
// (status flooded after 4 events).
test("a persistent watch has no total cap — it reports beyond CBASE_MONITOR_MAX_EVENTS and keeps running", async () => {
  await withEnv({ CBASE_MONITOR_RATE_MAX: 1000, CBASE_MONITOR_MAX_EVENTS: 4 }, async () => {
    const fired = [];
    const done = [];
    const rt = createMonitorRuntime({
      cwd: os.tmpdir(),
      onNotification: (t, ev) => fired.push(ev),
      onDone: (t, status) => done.push(status),
    });
    try {
      // Sixteen lines, as a rule each its own event (spacing above the 80 ms collection window), then the watch waits on. Waits for
      // the last line OR an end — the counter-proof turns red at once instead of hanging.
      const task = rt.start({ command: "for i in $(seq 1 16); do echo LINE$i; sleep 0.15; done; while true; do sleep 0.2; done", description: "Watch", persistent: true });
      await waitFor(() => done.length || fired.some((f) => /LINE16\b/.test(f.output)));
      assert.deepEqual(done, [], `keeps running past the cap: ${JSON.stringify(done)}`);
      assert.ok(fired.every((f) => f.status === "running"), JSON.stringify(fired.map((f) => f.status)));
      assert.ok(fired.length > 4, `more events than the cap: ${fired.length}`);
      for (const n of [1, 5, 16]) assert.match(fired.map((f) => f.output).join("\n"), new RegExp(`LINE${n}\\b`));
      assert.equal(rt.list().length, 1, "the watch still runs");
      assert.equal(rt.stop(task.taskId), true);
    } finally { rt.close(); }
  });
});

test("a kept task id (resume after a restart) is taken over, a malformed or running one is not", async () => {
  const rt = createMonitorRuntime({ cwd: os.tmpdir() });
  try {
    const a = rt.start({ command: "sleep 60", description: "kept", persistent: true }, { taskId: "monitor_abc123", startedAt: 1234 });
    assert.equal(a.taskId, "monitor_abc123");
    assert.equal(a.startedAt, 1234, "the start time of the first start stays");
    assert.throws(() => rt.start({ command: "sleep 60", description: "twice", persistent: true }, { taskId: "monitor_abc123" }), /already running/);
    const b = rt.start({ command: "sleep 60", description: "bad id", persistent: true }, { taskId: "../evil" });
    assert.match(b.taskId, /^monitor_[0-9a-f]{8}$/, "a malformed id is not taken over");
  } finally { rt.close(); }
});

test("completion notices pass through unbraked", async () => {
  await withEnv({ CBASE_MONITOR_RATE_MAX: 1, CBASE_MONITOR_THROTTLE_MS: 60_000 }, async () => {
    const fired = [];
    const done = [];
    const rt = createMonitorRuntime({
      cwd: os.tmpdir(),
      onNotification: (t, ev) => fired.push(ev),
      onDone: (t, s) => done.push(s),
    });
    try {
      // The first line goes through, the second is throttled; the end must not wait all the same.
      rt.start({ command: "echo ONE; sleep 0.2; echo TWO; sleep 0.2; exit 3", description: "ends soon", timeout_ms: 8000 });
      await waitFor(() => done.length);
      assert.equal(done[0], "failed");
      // The held-back line must not be swallowed.
      assert.match(fired.map((f) => f.output).join("\n"), /TWO/);
    } finally { rt.close(); }
  });
});

// ── WebSocket watch ──────────────────────────────────────────────────────────
// The second way of the core: since all providers watch through this tool, Claude's former `ws` use case hangs on it too.
test("WebSocket watch: every text frame is an event, binary is named", async () => {
  const { WebSocketServer } = await import("ws");
  const wss = new WebSocketServer({ port: 0 });
  await new Promise((r) => wss.on("listening", r));
  const url = `ws://127.0.0.1:${wss.address().port}`;
  const fired = [];
  const done = [];
  const rt = createMonitorRuntime({
    cwd: os.tmpdir(),
    onNotification: (t, ev) => fired.push(ev),
    onDone: (t, s) => done.push(s),
  });
  try {
    // In ONE sequence instead of over two clocks: a WebSocket delivers in send order, the closing comes after the frames.
    wss.on("connection", (sock) => {
      sock.send("FRAME-ONE");
      sock.send(Buffer.from([1, 2, 3, 4]));
      sock.close(1000, "finished");
    });
    rt.start({ ws: url, description: "Deploy events", timeout_ms: 5000 });
    await waitFor(() => done.length);
    const all = fired.map((f) => f.output).join("\n");
    assert.match(all, /FRAME-ONE/);
    assert.match(all, /Binary WebSocket event: 4 bytes/);
    assert.equal(done[0], "completed", "clean closing (1000) is no error");
  } finally {
    rt.close();
    await new Promise((r) => wss.close(r));
  }
});

test("WebSocket watch: an unclean end reports as a failure", async () => {
  const { WebSocketServer } = await import("ws");
  const wss = new WebSocketServer({ port: 0 });
  await new Promise((r) => wss.on("listening", r));
  const done = [];
  const fired = [];
  const rt = createMonitorRuntime({ cwd: os.tmpdir(), onNotification: (t, ev) => fired.push(ev), onDone: (t, s) => done.push(s) });
  try {
    wss.on("connection", (sock) => sock.close(1011, "server error"));
    rt.start({ ws: `ws://127.0.0.1:${wss.address().port}`, description: "aborts", timeout_ms: 5000 });
    await waitFor(() => done.length);
    assert.equal(done[0], "failed");
    // Without a previous event the end MUST be reported; otherwise the run waits for nothing.
    assert.match(fired.map((f) => f.output).join(""), /WebSocket closed \(code 1011/);
  } finally {
    rt.close();
    await new Promise((r) => wss.close(r));
  }
});

// ── Time limit ───────────────────────────────────────────────────────────────
test("a watch without output runs into its time limit and reports it", async () => {
  const fired = [];
  const done = [];
  const rt = createMonitorRuntime({ cwd: os.tmpdir(), onNotification: (t, ev) => fired.push(ev), onDone: (t, s) => done.push(s) });
  try {
    rt.start({ command: "sleep 30", description: "waits in vain", timeout_ms: 1000 });
    await waitFor(() => done.length);
    assert.equal(done[0], "timed_out");
    assert.match(fired.map((f) => f.output).join(""), /timed out/);
    assert.equal(rt.list().length, 0);
  } finally { rt.close(); }
});
