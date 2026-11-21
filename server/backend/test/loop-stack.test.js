// The stack watchdog of the event-loop watch (runtime/loop-watch.js + runtime/loop-stack-worker.js).
//   (1) A synchronous JS stretch: the row of the block carries `capture.stack` with the blocking function on top, taken WHILE
//       the block went on (pausedAfterMs well below the block)
//   (2) A blocking native wait (spawnSync of a sleeping child stands in for a slow synchronous fs call or a SQLite busy wait — NOT
//       Atomics.wait, which V8 interrupts for the pause): the stack names the JS caller, and `pausedAfterMs` shows that the wait held
//       the thread until it returned
//   (3) `stacks: false` — no worker, no capture; the capture of a short delay below the threshold is never handed to a later
//       block (the capture is keyed by the heartbeat before its block)
// Counter-test: without the watchdog (the old watch) no worker reports ready and the rows carry no `capture` — (1)–(3) turn red
// (the deadline per test is a fuse against that hang, not a wait).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";

import { startLoopWatch } from "../electron/server/runtime/loop-watch.js";

function holdTheLoopBusy(ms) { const until = Date.now() + ms; while (Date.now() < until) { /* hold the loop */ } }
// Like real code, the caller does something with the result — the pause lands at the first function call after the native call
// returned (here inside spawnSync's own decoding, with the caller below it).
function waitInNativeCall(ms) { return spawnSync(process.execPath, ["-e", `setTimeout(() => {}, ${ms})`], { encoding: "utf8" }).stdout.trim(); }

function tickClock() {
  const waiting = [];
  return {
    atTick: (ms) => { for (const w of waiting.splice(0)) w(ms); },
    next: () => new Promise((r) => waiting.push(r)),
  };
}
const rows = (f) => { try { return fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((z) => JSON.parse(z)); } catch { return []; } };

async function withWatch(t, opts, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loop-stack-"));
  const file = path.join(dir, "eventLoop.jsonl");
  const clock = tickClock();
  let ready;
  const up = new Promise((r) => { ready = r; });
  const stop = startLoopWatch({ file, thresholdMs: 400, tickMs: 50, captureMs: 150, captureGapMs: 0, atTick: clock.atTick, hold: true, atStacksReady: ready, ...opts });
  // At the test's deadline the watch is stopped, so a red run (no worker ever ready) ends instead of holding the process.
  t.signal.addEventListener("abort", stop, { once: true });
  try {
    if (opts.stacks !== false) await up;
    await clock.next();
    await fn({ file, clock });
  } finally {
    stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("(1) a synchronous JS stretch: the row names the blocking function, captured during the block", { timeout: 30_000 }, async (t) => {
  await withWatch(t, {}, async ({ file, clock }) => {
    holdTheLoopBusy(1200);
    assert.ok((await clock.next()) >= 400);
    const [row] = rows(file);
    assert.ok(row?.capture, `the row carries a capture: ${JSON.stringify(row)}`);
    t.diagnostic(`capture ${JSON.stringify(row.capture)}`);
    assert.match(row.capture.stack[0], /^holdTheLoopBusy .*loop-stack\.test\.js:\d+:\d+$/, row.capture.stack.join(" | "));
    // That the top frame IS holdTheLoopBusy already proves the pause came while the stretch still ran — no duration bound
    // (clock-counts.test.js: a bound in milliseconds measures the machine).
    assert.ok(row.capture.lagMs >= 150);
  });
});

test("(2) a blocking native wait: the stack names the JS caller, paused only after the call returned", { timeout: 30_000 }, async (t) => {
  await withWatch(t, {}, async ({ file, clock }) => {
    waitInNativeCall(1200);
    assert.ok((await clock.next()) >= 400);
    const [row] = rows(file);
    assert.ok(row?.capture, `the row carries a capture: ${JSON.stringify(row)}`);
    t.diagnostic(`capture ${JSON.stringify(row.capture)}`);
    assert.ok(row.capture.stack.some((f) => f.startsWith("waitInNativeCall ")), row.capture.stack.join(" | "));
    assert.ok(row.capture.pausedAfterMs >= 500, `the wait held the thread: paused after ${row.capture.pausedAfterMs} ms`);
    if (process.platform === "linux") assert.ok(Object.keys(row.capture.kernel.states).some((s) => s !== "R"), JSON.stringify(row.capture.kernel));
  });
});

test("(3) stacks: false writes rows without capture; a later block never gets the capture of a short delay", { timeout: 30_000 }, async (t) => {
  await withWatch(t, { stacks: false }, async ({ file, clock }) => {
    holdTheLoopBusy(700);
    await clock.next();
    const [row] = rows(file);
    assert.ok(row && !("capture" in row), JSON.stringify(row));
  });
  await withWatch(t, { thresholdMs: 600 }, async ({ file, clock }) => {
    holdTheLoopBusy(450); // above captureMs, below the threshold: captured, not written
    assert.ok((await clock.next()) < 600);
    assert.deepEqual(rows(file), []);
    waitInNativeCall(1200);
    assert.ok((await clock.next()) >= 600);
    const [row] = rows(file);
    assert.ok(row?.capture, JSON.stringify(row));
    assert.ok(row.capture.stack.some((f) => f.startsWith("waitInNativeCall ")), row.capture.stack.join(" | "));
  });
});
