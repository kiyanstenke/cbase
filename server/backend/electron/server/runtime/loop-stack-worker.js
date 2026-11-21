// The stack watchdog of the event-loop watch (loop-watch.js) — the body of a worker thread. The main thread cannot report what
// holds it while it is held; this thread can. It reads the main thread's heartbeat (a BigInt64 in shared memory, written by
// the watch's tick) every `pollMs`; when the heartbeat is older than `captureMs` it takes ONE stack of the main thread:
//   1. Linux: the kernel state of the main thread (`/proc/self/task/<pid>/stat` state, `wchan`), sampled every `pollMs` until
//      the pause arrives — R = it computes (or waits for a CPU), S/D with a wchan = it waits in a system call.
//   2. `inspector.Session.connectToMainThread()`, `Debugger.enable` + `Debugger.pause`. V8 serves the request at the next stack
//      check of the main thread: in a synchronous JS stretch AT ONCE (the stack shows the hot function), after a blocking native
//      call (spawnSync, a synchronous fs call on a slow file system, a SQLite busy wait) at the first function call AFTER it
//      returned — usually the call's own post-processing (decoding the output), so the stack shows the JS caller below it; a
//      caller that returns at once shows the frame after it. `pausedAfterMs` says how long the call still held the thread.
//   3. The frames go into the shared result buffer BEFORE `Debugger.resume` — the main thread can only run on, and its tick only
//      write the row, after the resume, so the row always finds the capture of its block.
// One capture per block (keyed by the stale heartbeat), at most one per `gapMs`; the debugger is on only between enable and
// disable. If this thread dies while the main thread is paused, the session disconnects, and V8 resumes the main thread.
// A leaf with node:* only.
import fs from "node:fs";
import { Session } from "node:inspector";
import { parentPort, workerData } from "node:worker_threads";

const { beat, result, captureMs, pollMs, gapMs, mainPid, frames: frameMax } = workerData;
const header = new Int32Array(result, 0, 2); // [seq, byte length]
const body = new Uint8Array(result, 8);
const encoder = new TextEncoder();

const taskDir = `/proc/self/task/${mainPid}`;
const linux = process.platform === "linux" && fs.existsSync(taskDir);
function kernelState() {
  try {
    const t = fs.readFileSync(`${taskDir}/stat`, "utf8");
    const state = t.slice(t.lastIndexOf(")") + 2, t.lastIndexOf(")") + 3);
    let wchan = "";
    try { wchan = fs.readFileSync(`${taskDir}/wchan`, "utf8").trim(); } catch { /* not readable */ }
    return { state, wchan: wchan === "0" ? "" : wchan };
  } catch { return null; }
}

// "fn file:line:col", the path from `electron/` on (a server path says nothing beyond it), node internals as `node:…`. The frame's
// own `url` is empty in today's protocol: the script id resolves through the `Debugger.scriptParsed` announcements.
function frameText(f, urls) {
  const url = String(f.url || urls.get(f.location.scriptId) || "");
  const at = url.lastIndexOf("/electron/");
  const file = url.startsWith("node:") ? url : at >= 0 ? url.slice(at + 1) : url.replace(/^file:\/\//, "");
  return `${f.functionName || "(anonymous)"} ${file}:${f.location.lineNumber + 1}:${f.location.columnNumber + 1}`;
}

function publish(capture) {
  let bytes = encoder.encode(JSON.stringify(capture));
  if (bytes.length > body.length) bytes = encoder.encode(JSON.stringify({ ...capture, stack: capture.stack.slice(0, 3), clipped: true }));
  body.set(bytes.subarray(0, body.length));
  Atomics.store(header, 1, Math.min(bytes.length, body.length));
  Atomics.add(header, 0, 1);
}

async function capture(beatAt, lagMs) {
  const startedAt = Date.now();
  const states = {};
  const wchans = {};
  const sample = () => {
    const k = linux ? kernelState() : null;
    if (!k) return;
    states[k.state] = (states[k.state] || 0) + 1;
    if (k.wchan) wchans[k.wchan] = (wchans[k.wchan] || 0) + 1;
  };
  sample();
  const sampler = linux ? setInterval(sample, pollMs) : null;
  const session = new Session();
  session.connectToMainThread();
  const post = (method, params) => new Promise((ok, no) => session.post(method, params, (e, r) => (e ? no(e) : ok(r))));
  const urls = new Map();
  session.on("Debugger.scriptParsed", (m) => { if (m.params?.url) urls.set(m.params.scriptId, m.params.url); });
  try {
    const paused = new Promise((ok) => session.once("Debugger.paused", (m) => ok(m.params)));
    post("Debugger.enable").catch(() => {});
    post("Debugger.pause").catch(() => {});
    const p = await paused;
    const pausedAfterMs = Date.now() - startedAt;
    if (sampler) clearInterval(sampler);
    publish({
      beatAt,
      lagMs,
      pausedAfterMs,
      stack: (p.callFrames || []).slice(0, frameMax).map((f) => frameText(f, urls)),
      ...(linux ? { kernel: { states, wchans } } : {}),
    });
    await post("Debugger.resume").catch(() => {});
    await post("Debugger.disable").catch(() => {});
  } finally {
    if (sampler) clearInterval(sampler);
    session.disconnect();
  }
}

let running = false;
let lastBeatCaptured = 0n;
let lastCaptureAt = 0;
setInterval(() => {
  if (running) return;
  const b = Atomics.load(beat, 0);
  const lagMs = Date.now() - Number(b);
  if (lagMs < captureMs || b === lastBeatCaptured || Date.now() - lastCaptureAt < gapMs) return;
  running = true;
  lastBeatCaptured = b;
  lastCaptureAt = Date.now();
  capture(Number(b), lagMs)
    .catch((e) => parentPort.postMessage({ error: String(e?.message || e) }))
    .finally(() => { running = false; });
}, pollMs);
parentPort.postMessage({ ready: true });
