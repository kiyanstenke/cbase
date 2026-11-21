// The event-loop watch. When B stops answering /api/health (a route that only sends a fixed object — so the event loop is
// busy), the gateway replaces it, and the container's log goes with it: WHAT held the loop can no longer be told. This watch
// measures the lateness of its own tick; above the threshold it writes ONE line to a file on the volume (survives the
// container's replacement) and to the log:
//   { at, blockedMs, rssMb, heapMb, open: [{ m, p, ageMs }], capture? }
// `open` are the HTTP requests that had begun and not yet ended when the block ended — newest first (the request that blocked
// began before the block and is usually still open; long-lived streams sort to the back). What holds a block outside a request
// (a tick, a run end) is told by the timestamp, held against the rest of the log.
// The file only grows on blocks; above FILE_CAP it is rotated once to `.1`.
//
// `capture` is the main thread's stack DURING the block, taken by a watchdog in a worker thread (loop-stack-worker.js, header
// there): `{ lagMs, pausedAfterMs, stack: ["fn file:line:col", …], kernel?: { states, wchans } }`. `pausedAfterMs` small = a
// synchronous JS stretch (the stack shows it), large = a blocking native call (the stack shows its JS caller, right after it
// returned). The main thread's only cost is one Atomics.store per tick; the watchdog reads the heartbeat in shared memory.
// Missing when the block was shorter than the watchdog's capture threshold, within the gap after the last capture, or when the
// worker could not start (`stacks: false` switches it off).
//
// Deliberately plain: no perf_hooks histogram (it does not say WHEN). A leaf with node:* only.
import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";

export const THRESHOLD_MS = 2_000;
export const TICK_MS = 500;
export const FILE_CAP = 5 * 1024 * 1024;
// The watchdog takes its stack when the heartbeat is this old — below THRESHOLD_MS, so it is taken while a block that will be
// written is still going on. At most one capture per CAPTURE_GAP_MS: Debugger.enable announces every loaded script to the
// session, which costs the main thread some milliseconds, and the blocks come in clusters.
export const CAPTURE_MS = 1_000;
export const CAPTURE_GAP_MS = 10_000;
const CAPTURE_BYTES = 16 * 1024;
const CAPTURE_FRAMES = 16;
const OPEN_MAX = 10;

const open = new Map(); // id → { m, p, since }
let nextId = 1;

/** An HTTP request begins (server.js, dispatcher). → id for `requestEnd`. */
export function requestBegin(m, p) {
  const id = nextId++;
  open.set(id, { m: String(m || ""), p: String(p || ""), since: Date.now() });
  return id;
}
/** The request is done (response finished or connection gone). */
export function requestEnd(id) { open.delete(id); }

/** The open requests, newest first, at most OPEN_MAX. */
export function openRequests(now = Date.now()) {
  return [...open.values()].sort((a, b) => b.since - a.since).slice(0, OPEN_MAX).map((a) => ({ m: a.m, p: a.p, ageMs: now - a.since }));
}

function write(file, row) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try { if (fs.statSync(file).size > FILE_CAP) fs.renameSync(file, `${file}.1`); } catch { /* no file yet */ }
    fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
  } catch (e) { console.error(`[loop] ${file} not writable: ${e?.message || e}`); }
}

// The watchdog (loop-stack-worker.js): the heartbeat the tick writes, the result buffer the worker fills. → { beatNow, take, stop }
// or null if the worker cannot start (then the rows carry no capture — the watch itself keeps running).
function startStackWatchdog({ captureMs, gapMs, pollMs, hold, atReady }) {
  try {
    const beat = new BigInt64Array(new SharedArrayBuffer(8));
    const result = new SharedArrayBuffer(8 + CAPTURE_BYTES);
    const header = new Int32Array(result, 0, 2);
    const decoder = new TextDecoder();
    Atomics.store(beat, 0, BigInt(Date.now()));
    const worker = new Worker(new URL("./loop-stack-worker.js", import.meta.url), {
      workerData: { beat, result, captureMs, gapMs, pollMs, mainPid: process.pid, frames: CAPTURE_FRAMES },
      // A small heap: the worker only holds a session and a few frames.
      resourceLimits: { maxOldGenerationSizeMb: 32 },
    });
    if (!hold) worker.unref();
    worker.on("message", (m) => {
      if (m?.ready) atReady?.();
      if (m?.error) console.warn(`[loop] stack capture failed: ${m.error}`);
    });
    worker.on("error", (e) => console.warn(`[loop] stack watchdog ended: ${e?.message || e}`));
    let seen = 0;
    return {
      beatNow: (ms) => Atomics.store(beat, 0, BigInt(ms)),
      /** The capture of the block that began after heartbeat `beatAt`, or null. Consumed once. */
      take: (beatAt) => {
        const seq = Atomics.load(header, 0);
        if (seq === seen) return null;
        seen = seq;
        try {
          const c = JSON.parse(decoder.decode(new Uint8Array(result, 8, Atomics.load(header, 1)).slice()));
          if (c.beatAt !== beatAt) return null;
          const { beatAt: _, ...rest } = c;
          return rest;
        } catch { return null; }
      },
      stop: () => { worker.terminate().catch(() => {}); },
    };
  } catch (e) {
    console.warn(`[loop] stack watchdog not started: ${e?.message || e}`);
    return null;
  }
}

/**
 * Start the watch. → stop(). `file` is required (no file, no watch — a line only in the log would be lost with the container).
 * `atTick(blockedMs)` (tests only): after every tick, AFTER writing — the test waits for this event instead of the clock.
 * `hold: true` (tests only): the tick keeps the process alive (in production `unref` — the watch never holds an ending server).
 * `stacks` (default on): the stack watchdog in a worker thread, see the header; `captureMs`/`captureGapMs`/`atStacksReady`
 * (tests: the worker is up and polls) tune it.
 * @param {{ file: string, thresholdMs?: number, tickMs?: number, atTick?: (blockedMs: number) => void, hold?: boolean,
 *   stacks?: boolean, captureMs?: number, captureGapMs?: number, atStacksReady?: () => void }} o
 */
export function startLoopWatch({
  file, thresholdMs = THRESHOLD_MS, tickMs = TICK_MS, atTick = null, hold = false,
  stacks = true, captureMs = CAPTURE_MS, captureGapMs = CAPTURE_GAP_MS, atStacksReady = null,
} = {}) {
  if (!file) throw new TypeError("startLoopWatch: file is missing");
  const dog = stacks ? startStackWatchdog({ captureMs, gapMs: captureGapMs, pollMs: Math.max(20, Math.min(100, Math.floor(captureMs / 5))), hold, atReady: atStacksReady }) : null;
  let expected = Date.now() + tickMs;
  let lastBeat = Date.now();
  dog?.beatNow(lastBeat);
  const t = setInterval(() => {
    const now = Date.now();
    const blockedMs = now - expected;
    expected = now + tickMs;
    const beatBefore = lastBeat;
    lastBeat = now;
    if (blockedMs < thresholdMs) { dog?.take(-1); dog?.beatNow(now); atTick?.(blockedMs); return; }
    const mem = process.memoryUsage();
    const row = { at: new Date(now).toISOString(), blockedMs, rssMb: Math.round(mem.rss / 1e6), heapMb: Math.round(mem.heapUsed / 1e6), open: openRequests(now) };
    const capture = dog?.take(beatBefore);
    if (capture) row.capture = capture;
    dog?.beatNow(now);
    console.warn(`[loop] event loop blocked for ${blockedMs} ms — open: ${row.open.map((a) => `${a.m} ${a.p} (${a.ageMs} ms)`).join(", ") || "no request"}${capture ? ` — at ${capture.stack[0] || "?"} (paused after ${capture.pausedAfterMs} ms)` : ""}`);
    write(file, row);
    atTick?.(blockedMs);
  }, tickMs);
  if (!hold) t.unref();
  return () => { clearInterval(t); dog?.stop(); };
}
