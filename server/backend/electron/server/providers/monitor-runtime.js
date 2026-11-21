// Provider-neutral monitor runtime core.
//
// Claude Code's own Monitor tool is blocked in every cbase run (CLAUDE_WAIT_LOCK); ALL providers observe through this
// core (cbase_monitor → route /monitor). A monitor belongs to the CHAT (runs/monitors.js, one core per monitor) and
// lives across turns and intermediate messages; this core knows nothing of that — it starts, reports, throttles and
// ends.
//
// Two report kinds (`report`): "rows" (default) — every output is an event (onNotification, throttled as below);
// "end" — silent while it runs; ONLY the end counts (onDone with `info`: exit code, signal, reason). The raw output
// goes to `onOutput` in BOTH kinds (the owner writes it to the log file and keeps the last lines for the end notice).
// The ONE start function: a watch starts in the project container of the instance, without one locally.
import { inProject } from "../runtime/inProject.js";
import { withLfsEnvironment } from "../runs/lfs-environment.js";
import { withNice } from "../../mcp/cpu-saver.js"; // "save computing power"
import crypto from "node:crypto";
import fs from "node:fs";
import WebSocket from "ws";
// A WebSocket watch FOR an instance connects localhost to its container (URL, host header and SNI stay), every other
// host goes through the guard (never to an address of the backend).
import { networkOptions } from "../runtime/target.js";

const DEFAULT_TIMEOUT_MS = 120_000;
// "end" waits for a result (build, test suite) — the default covers long runs, the cap stays one day.
export const END_DEFAULT_TIMEOUT_MS = 4 * 3_600_000;
export const MAX_TIMEOUT_MS = 86_400_000;
export const REPORT_KINDS = Object.freeze(["rows", "end"]);
const MAX_EVENT_CHARS = 60_000;
const FLUSH_DELAY_MS = 80;

// ── Flood brake ──────────────────────────────────────────────────────────────
// EVERY event of this core is injected into the run as a new turn — so it costs a full model call. A `tail -f`
// without a filter or a chatty WebSocket would litter the chat minute by minute and burn money. Claude's built-in
// Monitor tool throttles by itself and stops runaway watches; since this core replaces the built-in tool for ALL
// providers, it must be able to do the same.
//
// Two stages: (1) above RATE_MAX events in the sliding window, events are collected instead of reported — at most one
// collective notice per THROTTLE_MS; (2) above MAX_EVENTS in total the monitor is ended, with a notice that asks for a
// restart with a narrower filter. Stage (2) does NOT apply to a PERSISTENT monitor: a watch
// that stays open for days (the Teams watch on a WebSocket) would otherwise end after 100 events in total, however slowly
// they came — for it the throttle (1) is the cost protection, at most RATE_MAX notices per window plus one collective
// notice per THROTTLE_MS.
// Read AT EVERY CALL, not at module load: runs/do-run.js imports this file at the very top, tests set their
// environment variables only afterwards.
const num = (name, fallback) => Number(process.env[name]) || fallback;
const rateWindowMs = () => num("CBASE_MONITOR_RATE_WINDOW_MS", 60_000);
const rateMaxEvents = () => num("CBASE_MONITOR_RATE_MAX", 12);
const throttleMs = () => num("CBASE_MONITOR_THROTTLE_MS", 30_000);
const maxEvents = () => num("CBASE_MONITOR_MAX_EVENTS", 100);

const shellBin = () => (process.env.SHELL && fs.existsSync(process.env.SHELL) ? process.env.SHELL : "/bin/bash");
const clip = (s) => {
  const text = String(s || "");
  return text.length > MAX_EVENT_CHARS
    ? text.slice(-MAX_EVENT_CHARS) + `\n… [${text.length - MAX_EVENT_CHARS} characters truncated]`
    : text;
};

function killProcessTree(child, signal = "SIGTERM") {
  if (!child || child.killed) return;
  // In the project container: `-pid` would only hit the group of the docker child in the backend, the watch in the
  // container would keep running. The `kill` of the child from inProject ends the group in the container and then
  // the docker child.
  if (child.inProject) { try { child.kill(signal); } catch {} return; }
  try {
    // Unix: monitor commands run in a process group of their own, so that their children end too.
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try { child.kill(signal); } catch {}
  }
}

function normalizeArgs(args = {}) {
  const command = String(args.command || "").trim();
  const ws = String(args.ws || "").trim();
  if ((command ? 1 : 0) + (ws ? 1 : 0) !== 1) {
    throw new Error("Exactly one of command or ws is required.");
  }
  if (ws) {
    let parsed;
    try { parsed = new URL(ws); } catch { throw new Error("ws must be a valid ws:// or wss:// URL."); }
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
      throw new Error("ws must be a ws:// or wss:// URL.");
    }
    if (parsed.username || parsed.password) throw new Error("WebSocket URLs with credentials are not allowed.");
  }
  const report = args.report === undefined || args.report === null || args.report === "" ? "rows" : String(args.report);
  if (!REPORT_KINDS.includes(report)) throw new Error(`report must be "rows" or "end" (was: ${JSON.stringify(args.report)}).`);
  const persistent = args.persistent === true;
  const requested = Number(args.timeout_ms);
  const preset = report === "end" ? END_DEFAULT_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
  const timeoutMs = persistent
    ? 0
    : Math.min(MAX_TIMEOUT_MS, Math.max(1000, Number.isFinite(requested) && requested > 0 ? Math.round(requested) : preset));
  const description = String(args.description || (command ? command : ws)).trim().slice(0, 300);
  const protocols = Array.isArray(args.protocols)
    ? [...new Set(args.protocols.map((p) => String(p).trim()).filter(Boolean))]
    : [];
  return { command, ws, description, persistent, timeoutMs, protocols, report };
}

/**
 * @param {Object} options
 * @param {string} options.cwd
 * @param {Object} [options.env]
 * @param {(task:Object)=>void} [options.onStart]
 * @param {(task:Object,event:Object)=>void} [options.onNotification]
 * @param {(task:Object,status:string,detail:string,info:Object)=>void} [options.onDone]  info: { exitCode, signal, wsCode }
 * @param {(task:Object,text:string)=>void} [options.onOutput]  raw output (both report kinds), unthrottled
 */
// `saver` ("save computing power"): asked at EVERY start — `true` starts the command under `nice -n 10`
// (mcp/cpu-saver.js withNice); without the callback or with `false` the plain start. A monitor never waits (priority only).
export function createMonitorRuntime({ cwd, env = process.env, instance = null, onStart, onNotification, onDone, onOutput, saver = () => false } = {}) {
  const tasks = new Map();
  let closed = false;
  // Test seam: how many watch processes have already reported their "close" — counted BEFORE every check. So a test
  // knows that a process end had the chance to produce an event (monitor-runtime.test.js) instead of waiting a duration.
  let endProcess = 0;

  const publicTask = (rec) => ({
    taskId: rec.taskId,
    description: rec.description,
    timeoutMs: rec.timeoutMs,
    persistent: rec.persistent,
    kind: rec.kind,
    report: rec.report,
    command: rec.command,
    ws: rec.ws,
    startedAt: rec.startedAt,
  });

  function finish(rec, status, detail = "", { silent = false, info = {} } = {}) {
    if (!rec || rec.done) return;
    if (rec.timer) clearTimeout(rec.timer);
    if (rec.flushTimer) clearTimeout(rec.flushTimer);
    if (rec.pending.trim() && !silent) flush(rec);
    // What was collected while throttled still has to be delivered — otherwise the last output of a throttled watch
    // vanishes without a trace, just when it carries the reason for its end.
    if (!silent && rec.heldCount && status !== "flooded") flushHeld(rec);
    if (rec.throttleTimer) { clearTimeout(rec.throttleTimer); rec.throttleTimer = null; }
    rec.done = true;
    tasks.delete(rec.taskId);
    if (!silent) onDone?.(publicTask(rec), status, clip(detail), info);
  }

  // Deliver unthrottled. Only for final notices and for the brake itself.
  function deliver(rec, text, status) {
    rec.hadEvent = true;
    rec.eventTimes.push(Date.now());
    rec.eventsTotal += 1;
    onNotification?.(publicTask(rec), { output: text, status });
  }

  // Send the collective notice of the throttled state (or, if nothing is pending, do nothing).
  function flushHeld(rec) {
    if (rec.throttleTimer) { clearTimeout(rec.throttleTimer); rec.throttleTimer = null; }
    if (!rec.heldCount) return;
    const count = rec.heldCount;
    const text = rec.heldText;
    rec.heldCount = 0;
    rec.heldText = "";
    if (rec.done || closed) return;
    deliver(rec, `[throttled: ${count} event(s) combined]\n${text}`, "running");
  }

  function notify(rec, output, status = "running") {
    if (!rec || rec.done || closed) return;
    // "end": silent while it runs — and the end is not reported this way either but via onDone (the owner builds ONE
    // notice from it with the exit code and the last lines).
    if (rec.report === "end") return;
    const text = clip(output).trim();
    if (!text) return;
    // Completion, error, time limit: always at once and unthrottled — the end of the run hangs on it.
    if (status !== "running") {
      flushHeld(rec);
      deliver(rec, text, status);
      return;
    }
    const now = Date.now();
    const window = rateWindowMs();
    rec.eventTimes = rec.eventTimes.filter((t) => now - t < window);
    // Rip cord: this watch reports more than a chat can take. End instead of throttling — a throttled long-runner
    // would otherwise tie up the run until the time limit. Not for a persistent monitor (see "Flood brake" above).
    if (!rec.persistent && rec.eventsTotal + rec.heldCount >= maxEvents()) {
      rec.heldCount = 0;
      rec.heldText = "";
      if (rec.throttleTimer) { clearTimeout(rec.throttleTimer); rec.throttleTimer = null; }
      deliver(rec, `Monitor "${rec.description}" was ended after ${rec.eventsTotal} events: too many notices.`
        + ` Last output:\n${text}\n\nIf needed, start it anew with a NARROWER filter`
        + ` (only the rows you really react to).`, "flooded");
      terminate(rec);
      finish(rec, "flooded", "", { info: { reason: "flood" } });
      return;
    }
    // Throttling: the event account in the sliding window is full → collect.
    if (rec.eventTimes.length >= rateMaxEvents()) {
      rec.heldCount += 1;
      rec.heldText = clip(`${rec.heldText}${rec.heldText ? "\n" : ""}${text}`);
      if (!rec.throttleTimer) {
        rec.throttleTimer = setTimeout(() => flushHeld(rec), throttleMs());
        rec.throttleTimer.unref?.();
      }
      return;
    }
    deliver(rec, text, status);
  }

  function flush(rec) {
    if (!rec || rec.done && !rec.pending) return;
    if (rec.flushTimer) clearTimeout(rec.flushTimer);
    rec.flushTimer = null;
    const output = rec.pending;
    rec.pending = "";
    notify(rec, output);
  }

  function append(rec, data) {
    if (!rec || rec.done || closed) return;
    try { onOutput?.(publicTask(rec), String(data || "")); } catch { /* the log must never disturb the watch */ }
    if (rec.report === "end") return; // collect only (log), no event
    rec.pending += String(data || "");
    if (rec.pending.length > MAX_EVENT_CHARS * 2) rec.pending = rec.pending.slice(-MAX_EVENT_CHARS * 2);
    if (!rec.flushTimer) rec.flushTimer = setTimeout(() => flush(rec), FLUSH_DELAY_MS);
  }

  function armTimeout(rec) {
    if (!rec.timeoutMs) return;
    rec.timer = setTimeout(() => {
      if (rec.kind === "command") killProcessTree(rec.child, "SIGTERM");
      else {
        try { rec.socket?.close(1000, "monitor timeout"); } catch {}
      }
      if (!rec.hadEvent) notify(rec, `Monitor timed out after ${rec.timeoutMs} ms.`, "timed_out");
      finish(rec, "timed_out", "", { info: { reason: "timeout" } });
    }, rec.timeoutMs);
    rec.timer.unref?.();
  }

  // `meta.taskId` / `meta.startedAt`: the resume of a persistent monitor after a server restart (runs/monitors.js) keeps
  // its id and its start time — cbase_monitor_stop with the old id still hits it, and the log file is the same.
  function start(args = {}, meta = {}) {
    if (closed) throw new Error("The monitor run has already ended.");
    const cfg = normalizeArgs(args);
    const kept = typeof meta.taskId === "string" && /^monitor_[A-Za-z0-9_-]{1,40}$/.test(meta.taskId) ? meta.taskId : "";
    if (kept && tasks.has(kept)) throw new Error(`The monitor ${kept} is already running.`);
    const taskId = kept || `monitor_${crypto.randomUUID().slice(0, 8)}`;
    const rec = {
      taskId,
      description: cfg.description,
      timeoutMs: cfg.timeoutMs,
      persistent: cfg.persistent,
      kind: cfg.command ? "command" : "websocket",
      report: cfg.report,
      command: cfg.command,
      ws: cfg.ws,
      startedAt: Number.isFinite(meta.startedAt) && meta.startedAt > 0 ? meta.startedAt : Date.now(),
      toolUseId: meta.toolUseId || null,
      pending: "",
      flushTimer: null,
      timer: null,
      hadEvent: false,
      done: false,
      child: null,
      socket: null,
      // flood brake (see above)
      eventTimes: [],
      eventsTotal: 0,
      heldText: "",
      heldCount: 0,
      throttleTimer: null,
    };
    tasks.set(taskId, rec);

    if (cfg.command) {
      // A monitor is a shell of the agent — with an instance the LFS environment (runs/lfs-environment.js).
      const [program, argv] = withNice(shellBin(), ["-c", cfg.command], saver() === true);
      const child = inProject(instance, program, argv, withLfsEnvironment(instance, {
        cwd,
        env,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      }));
      rec.child = child;
      child.stdout.on("data", (d) => append(rec, d));
      child.stderr.on("data", (d) => append(rec, d));
      child.on("error", (e) => {
        notify(rec, `Monitor error: ${e.message || e}`, "failed");
        finish(rec, "failed", String(e?.message || e), { info: { reason: "error" } });
      });
      child.on("close", (code, signal) => {
        endProcess += 1;
        if (rec.done) return;
        if (rec.pending.trim()) flush(rec);
        const status = code === 0 ? "completed" : "failed";
        // A watch that ends without output must still wake the waiting agent.
        if (!rec.hadEvent) {
          notify(rec, code === 0
            ? "Monitor ended (no output)."
            : `Monitor ended (exit code ${code ?? "?"}${signal ? `, signal ${signal}` : ""}).`, status);
        }
        finish(rec, status, "", { info: { exitCode: code, signal: signal || null } });
      });
    } else {
      let socket;
      // With an instance: localhost is the project's service, not the backend's — `ws` connects via its option
      // `createConnection` to the IP of the instance; every other host gets the guard as `lookup` (ws passes its
      // options on to net.connect), an IP literal of the backend throws here. Without an instance a plain connect.
      try {
        const network = networkOptions(cfg.ws, instance);
        socket = network
          ? new WebSocket(cfg.ws, cfg.protocols.length ? cfg.protocols : undefined, network)
          : new WebSocket(cfg.ws, cfg.protocols.length ? cfg.protocols : undefined);
      }
      catch (e) { tasks.delete(taskId); throw new Error(`The WebSocket could not be started: ${e.message || e}`); }
      rec.socket = socket;
      socket.on("message", (data, isBinary) => {
        const text = isBinary ? `[Binary WebSocket event: ${data?.length || 0} bytes]` : String(data);
        try { onOutput?.(publicTask(rec), `${text}\n`); } catch { /* the log must never disturb the watch */ }
        notify(rec, text);
      });
      socket.on("error", (e) => {
        notify(rec, `WebSocket error: ${e.message || e}`, "failed");
      });
      socket.on("close", (code, reason) => {
        if (rec.done) return;
        const detail = String(reason || "");
        if (!rec.hadEvent) notify(rec, `WebSocket closed (code ${code}${detail ? `: ${detail}` : ""}).`, code === 1000 ? "completed" : "failed");
        finish(rec, code === 1000 ? "completed" : "failed", detail, { info: { wsCode: code } });
      });
    }

    armTimeout(rec);
    onStart?.(publicTask(rec));
    return publicTask(rec);
  }

  // End the process or socket and discard everything pending. Separate from finish() because the flood brake needs
  // the same path as an explicit stop.
  function terminate(rec) {
    if (rec.timer) clearTimeout(rec.timer);
    if (rec.flushTimer) clearTimeout(rec.flushTimer);
    if (rec.throttleTimer) { clearTimeout(rec.throttleTimer); rec.throttleTimer = null; }
    rec.pending = "";
    rec.heldText = "";
    rec.heldCount = 0;
    if (rec.kind === "command") killProcessTree(rec.child, "SIGTERM");
    else {
      try { rec.socket?.close(1000, "monitor stopped"); } catch {}
    }
  }

  function stop(taskId, status = "stopped", info = {}) {
    const rec = tasks.get(String(taskId || ""));
    if (!rec) return false;
    // Mark as done before the process signal: close must not produce a second done.
    terminate(rec);
    finish(rec, status, "", { info: { reason: "stopped", ...info } });
    return true;
  }

  function close() {
    if (closed) return;
    closed = true;
    for (const rec of [...tasks.values()]) {
      if (rec.timer) clearTimeout(rec.timer);
      if (rec.flushTimer) clearTimeout(rec.flushTimer);
      if (rec.throttleTimer) clearTimeout(rec.throttleTimer);
      rec.pending = "";
      if (rec.kind === "command") killProcessTree(rec.child, "SIGTERM");
      else {
        try { rec.socket?.terminate(); } catch {}
      }
      finish(rec, "stopped", "", { silent: true });
    }
  }

  return {
    start,
    stop,
    close,
    list: () => [...tasks.values()].map(publicTask),
    has: (taskId) => tasks.has(String(taskId || "")),
    endProcess: () => endProcess, // test seam (see above)
  };
}
