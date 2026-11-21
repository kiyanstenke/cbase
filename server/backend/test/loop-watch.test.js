// The event-loop watch (runtime/loop-watch.js).
//   (1) A real block above the threshold is written as ONE line to the file: duration, memory, the open requests
//       (newest first); a short delay below the threshold writes nothing
//   (2) Above the cap the file is rotated once to `.1`; without `file` no watch (TypeError)
// Counter-test: without the watch (stop() before the block) the file stays empty — the check in (1) turns red.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { FILE_CAP, requestBegin, requestEnd, openRequests, startLoopWatch } from "../electron/server/runtime/loop-watch.js";

const block = (ms) => { const until = Date.now() + ms; while (Date.now() < until) { /* hold the loop */ } };
// Wait for the next tick of the watch (its `atTick` event), never for the clock.
function tickClock() {
  const waiting = [];
  return {
    atTick: (ms) => { for (const w of waiting.splice(0)) w(ms); },
    next: () => new Promise((r) => waiting.push(r)),
  };
}
const rows = (f) => { try { return fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((z) => JSON.parse(z)); } catch { return []; } };

test("(1) a block above the threshold is a line in the file, with the open request; below it nothing", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loop-"));
  const file = path.join(dir, "logs", "eventLoop.jsonl");
  const clock = tickClock();
  const stop = startLoopWatch({ file, thresholdMs: 300, tickMs: 50, atTick: clock.atTick, hold: true });
  const old = requestBegin("GET", "/api/chats/x/stream");
  block(5); // the second request surely starts later
  const fresh = requestBegin("POST", "/api/chats/x/message");
  try {
    await clock.next();
    block(100);
    assert.ok((await clock.next()) < 300, "the tick after the short delay is below the threshold");
    assert.deepEqual(rows(file), [], "below the threshold: no line");
    block(700);
    assert.ok((await clock.next()) >= 300, "the tick after the block reports it");
    const z = rows(file);
    assert.equal(z.length, 1, JSON.stringify(z));
    assert.ok(z[0].blockedMs >= 300, `duration ${z[0].blockedMs}`);
    assert.ok(z[0].rssMb > 0 && z[0].heapMb > 0);
    assert.deepEqual(z[0].open.map((a) => `${a.m} ${a.p}`), ["POST /api/chats/x/message", "GET /api/chats/x/stream"], "newest first");
    assert.match(z[0].at, /^\d{4}-\d\d-\d\dT/);
  } finally {
    stop(); requestEnd(old); requestEnd(fresh);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(openRequests().filter((a) => a.p.startsWith("/api/chats/x/")).length, 0, "finished requests drop out");
});

test("(2) rotation above the cap; without file no watch", async () => {
  assert.throws(() => startLoopWatch({}), TypeError);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loop-"));
  const file = path.join(dir, "e.jsonl");
  fs.writeFileSync(file, "x".repeat(FILE_CAP + 1));
  const clock = tickClock();
  const stop = startLoopWatch({ file, thresholdMs: 200, tickMs: 50, atTick: clock.atTick, hold: true });
  try {
    await clock.next();
    block(400);
    await clock.next();
    assert.equal(fs.statSync(`${file}.1`).size, FILE_CAP + 1, "the old file is under .1");
    assert.equal(rows(file).length, 1, "the new line is in a fresh file");
  } finally { stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});
