// The owner of the monitors per CHAT.
//
// A monitor (cbase_monitor) belongs to the CHAT, like a subagent (runs/agents.js), not to the turn: it lives across
// turn ends and messages in between, until its command ends, cbase_monitor_stop ends it, its time limit strikes, the
// human stops it (card under Background Tasks) or the chat is archived or deleted. Bound to the turn, a watch would
// silently fall with a turn that ends regularly while the watched command keeps running and nobody reports its end.
//
// EVERY event and its end wake the chat via the ONE wake path (`deliver`, runs/queue.js deliverUserPrompt with cause
// "agent" — the same as a subagent's completion notice: if a turn is running, with Claude at the next tool boundary,
// otherwise queued; if the chat is idle, a turn of its own). The notice has the form of a completion notice
// (runs/monitor-notice.js) so that Web and iOS show it as a system row. No wake call: a stop by the agent itself (it
// knows), by the human (silent hint to the next turn, as with a watch) and closing with the chat.
//
// In BOTH report modes the output goes into a file in the chat's output location (one capped log per task in the
// monitor folder), which the human sees under Artifacts → Outputs and which every notice names.
//
// Restart: a monitor is a process of the backend (or a docker exec into the project container) — it dies with it. The
// inventory lives in `<data>/monitors-open.json`; the restart hook (`monitorsRestartGrace`) reads it:
//   · a monitor WITH a time limit is NOT continued (it waits for one result — a silently restarted build would be a
//     second run of the command). Like an orphaned subagent the chat gets ONE note (history row + silent hint).
//   · a PERSISTENT monitor (a watch, open for days) starts again by itself: same command
//     or WebSocket, same chat, cwd and instance, SAME id (cbase_monitor_stop with the old id still hits it), the same
//     log file continued. No wake call — the next turn gets a silent hint that output during the restart was not seen.
//     Stopped (agent, human, chat deleted or archived) it leaves the inventory at once and never comes back.
//   Crash loop: a resumed monitor that ends within CBASE_MONITOR_RESUME_STABLE_MS of its start (default 60 s) counts as
//   a failed attempt and is retried after a doubling pause (CBASE_MONITOR_RESUME_BACKOFF_MS, default 5 s); after
//   CBASE_MONITOR_RESUME_MAX attempts in a row (default 3) it ends for good with ONE end notice to the chat. The count
//   stands in the inventory BEFORE the start, so a backend that dies with the start counts too (a crash loop of B); a
//   monitor that ran stable for the period starts over at 0. While its instance's project is locked (relocation,
//   restore after the swap) the attempt waits uncounted (CBASE_MONITOR_RESUME_POLL_MS, default 15 s).
//   Between the attempts the monitor stands in `waiting` — named in `liveMonitors` (`resuming: true`), so it stays open
//   work (archive, gateway reaper) and the human can stop it.
//
// Import rules: neither the five core modules of runs (do-run, queue, …) nor background.js or agents.js — those
// attach via `observeMonitors` (agents.js: display, background.js: end of work). The wake path of a RESUMED monitor
// comes via `setMonitorDelivery` (server.js; runs/queue.js must not be imported here). No cycle.
import fs from "node:fs";
import path from "node:path";
import { saverOn } from "./saver.js";
import { createMonitorRuntime } from "../providers/monitor-runtime.js";
import * as store from "../store.js";
import { sse } from "../runtime/sse.js";
import { DIRS } from "../app-state.js";
import { T } from "../i18n.js";
import { depositHint } from "./hints.js";
import { createFolderInRuntimeFolder, openForAppendInRuntimeFolder } from "./runtime-write.js";
import { MONITOR_FOLDER, monitorNotice, monitorEndText } from "./monitor-notice.js";
import { instanceFromIdentifier, instanceIdentifierOf, projectFromIdentifier } from "./instance.js";
import { startLock } from "./project-lock.js";

/** At most this many monitors live per chat (knob CBASE_MONITOR_CAP) — a start beyond it fails with a message. */
export const MONITOR_CAP_DEFAULT = 10;
/** A monitor's log file grows at most up to here (knob CBASE_MONITOR_LOG_MAX), then a note and nothing more. */
export const MONITOR_LOG_MAX_DEFAULT = 10 * 1024 * 1024;
/** This many last lines are carried by the end notice. */
export const MONITOR_TAIL_ROWS = 40;
const TAIL_BUFFER = 64 * 1024;

/** Resume of a persistent monitor after a restart (see the file head): attempts in a row, stable period, pauses. */
export const MONITOR_RESUME_MAX_DEFAULT = 3;
export const MONITOR_RESUME_STABLE_MS_DEFAULT = 60_000;
export const MONITOR_RESUME_BACKOFF_MS_DEFAULT = 5_000;
export const MONITOR_RESUME_POLL_MS_DEFAULT = 15_000;

const cap = () => Number(process.env.CBASE_MONITOR_CAP) || MONITOR_CAP_DEFAULT;
const logMax = () => Number(process.env.CBASE_MONITOR_LOG_MAX) || MONITOR_LOG_MAX_DEFAULT;
// Read at every call (tests set the knobs after the import).
const resumeMax = () => Number(process.env.CBASE_MONITOR_RESUME_MAX) || MONITOR_RESUME_MAX_DEFAULT;
const resumeStableMs = () => Number(process.env.CBASE_MONITOR_RESUME_STABLE_MS) || MONITOR_RESUME_STABLE_MS_DEFAULT;
const resumeBackoffMs = (attempts) => (Number(process.env.CBASE_MONITOR_RESUME_BACKOFF_MS) || MONITOR_RESUME_BACKOFF_MS_DEFAULT) * 2 ** Math.max(0, attempts - 1);
const resumePollMs = () => Number(process.env.CBASE_MONITOR_RESUME_POLL_MS) || MONITOR_RESUME_POLL_MS_DEFAULT;

const perChat = new Map(); // chatId -> Map(taskId -> entry)
const waiting = new Map(); // taskId -> { row, timer } — a persistent monitor between two resume attempts
const carried = new Map(); // data folder -> rows of the last server run the restart hook has not taken yet
const observer = new Set(); // fn(chatId, { kind: "start" | "end" })
const resumeHinted = new Set(); // taskId — the silent hint "started again" once per server run

// The wake path of a resumed monitor: `(chatId, text) => result of deliverUserPrompt` — set in server.js.
let delivery = null;
export function setMonitorDelivery(fn) { delivery = typeof fn === "function" ? fn : null; }

/** A subscription (agents.js: display; background.js: end of work). Returns the unsubscribe function. */
export function observeMonitors(fn) {
  observer.add(fn);
  return () => observer.delete(fn);
}
function report(chatId, kind) {
  for (const fn of [...observer]) {
    try { fn(chatId, { kind }); } catch (e) { console.error("[monitor] observer:", chatId, e?.message || e); }
  }
}

// ── The inventory for the restart ───────────────────────────────────────────────────────────────────────────────────
const inventoryFile = () => (DIRS?.data ? path.join(DIRS.data, "monitors-open.json") : null);
function readInventory() {
  const f = inventoryFile();
  if (!f) return [];
  try { const j = JSON.parse(fs.readFileSync(f, "utf8")); return Array.isArray(j) ? j : []; } catch { return []; }
}
function writeInventory(rows) {
  const f = inventoryFile();
  if (!f) return;
  try {
    if (!rows.length) { fs.rmSync(f, { force: true }); return; }
    fs.writeFileSync(f, JSON.stringify(rows));
  } catch (e) { console.error("[monitor] inventory not written:", e?.message || e); }
}
// A persistent monitor carries what its resume needs: the arguments, cwd, the instance's identifier, the absolute log
// file and the attempts in a row that have not yet run stable.
const inventoryRow = (e) => ({ taskId: e.task.taskId, chatId: e.chatId, description: e.task.description, report: e.task.report,
  startedAt: e.task.startedAt, logPath: e.logRel, data: e.data,
  ...(e.task.persistent ? { persistent: true, args: e.args, cwd: e.cwd, instance: e.identifier, logFile: e.logFile, attempts: e.attempts } : {}) });
// The rows of the last server run, read ONCE per data folder at the first touch (a start in the seconds before the
// restart hook would otherwise overwrite them) — they stay in the file until the hook has taken them.
function carriedRows() {
  const data = DIRS?.data || "";
  if (!carried.has(data)) {
    const live = new Set([...allEntries()].map((e) => e.task.taskId));
    carried.set(data, readInventory().filter((z) => (!z.data || z.data === data) && !live.has(z.taskId) && !waiting.has(z.taskId)));
  }
  return carried.get(data);
}
function refreshInventory() {
  // Only the rows of THIS data folder: in tests several servers run one after another in one process.
  const data = DIRS?.data || "";
  const old = carriedRows();
  writeInventory([...[...allEntries()].filter((e) => e.data === data).map(inventoryRow),
    ...[...waiting.values()].filter((w) => w.row.data === data).map((w) => w.row), ...old]);
}
function* allEntries() { for (const m of perChat.values()) yield* m.values(); }

// ── The log file ───────────────────────────────────────────────────────────────────────────────────────────────────
// Opened ONCE at the start and held by its descriptor until the end: in a project's runtime folder (which the project
// container mounts rw) via the descriptor without links (runs/runtime-write.js) — a link created later redirects
// nothing.
function openLog(file) {
  const folder = path.dirname(file);
  if (!createFolderInRuntimeFolder(folder)) fs.mkdirSync(folder, { recursive: true });
  const fd = openForAppendInRuntimeFolder(file);
  return fd ?? fs.openSync(file, "a");
}
function logWrite(e, text) {
  if (e.fd === null || !text) return;
  try {
    const buf = Buffer.from(String(text));
    const max = logMax();
    if (e.written >= max) return;
    if (e.written + buf.length > max) {
      const rest = buf.subarray(0, Math.max(0, max - e.written));
      fs.writeSync(e.fd, rest);
      fs.writeSync(e.fd, `\n… [log cap of ${max} bytes hit — further output not written down; the last lines are in the notice]\n`);
      e.written = max;
      e.clipped = true;
      return;
    }
    fs.writeSync(e.fd, buf);
    e.written += buf.length;
  } catch (err) {
    if (!e.logError) console.error(`[monitor] log ${e.logFile}:`, err?.message || err);
    e.logError = true;
  }
}
function logClose(e, row) {
  if (e.fd === null) return;
  try { if (row) fs.writeSync(e.fd, row); } catch { /* the log is a convenience */ }
  try { fs.closeSync(e.fd); } catch { /* already closed */ }
  e.fd = null;
}

const tail = (e) => {
  const rows = e.tail.replace(/\s+$/, "").split("\n");
  return rows.slice(-MONITOR_TAIL_ROWS).join("\n");
};

// ── Rows for display, gate and archive ─────────────────────────────────────────────────────────────────────────────
const rowValue = (e) => ({
  chatId: e.chatId, taskId: e.task.taskId, description: e.task.description, report: e.task.report, kind: e.task.kind,
  command: e.task.command || "", ws: e.task.ws || "", startedAt: e.task.startedAt, timeoutMs: e.task.timeoutMs,
  persistent: e.task.persistent, logPath: e.logRel,
});
// A persistent monitor between two resume attempts — the same shape, marked `resuming`.
const waitingValue = ({ row }) => ({
  chatId: row.chatId, taskId: row.taskId, description: row.description, report: row.report, kind: row.args?.ws ? "websocket" : "command",
  command: row.args?.command || "", ws: row.args?.ws || "", startedAt: row.startedAt, timeoutMs: 0, persistent: true,
  logPath: row.logPath, resuming: true,
});

/** The live monitors — of one chat or of all, a persistent one waiting for its resume included. Empty means: none
 *  (process state, never "unknown"). */
export function liveMonitors(chatId) {
  const w = [...waiting.values()].filter((x) => !chatId || x.row.chatId === chatId).map(waitingValue);
  if (chatId) return [...[...(perChat.get(chatId)?.values() || [])].map(rowValue), ...w];
  return [...[...allEntries()].map(rowValue), ...w];
}

const historyRow = (chatId, event, t, status, extra = {}) => {
  const row = { event, taskId: t.taskId, description: t.description || "", ...(status ? { status } : {}), ...extra };
  try { store.addMessage(chatId, "monitor", JSON.stringify(row)); } catch (err) { console.error("[monitor] history row:", err?.message || err); }
  sse(chatId, { type: "harness", subtype: "monitor", ...row });
};

/**
 * Start a monitor for a chat (called from the turn that got the cbase_monitor call — approval, cwd and instance live
 * there). `deliver(text)`: the chat's wake path. `outputLocation`: the chat's output location at this turn's place.
 * `resume`: only the restart hook — `{ row }` of the inventory: same id, same log file (continued), the attempts.
 * @returns {Object} the public view of the task with `logPath` (relative to the output location) and `logFile` (absolute)
 */
export function startMonitor(chatId, args, { cwd, env = process.env, instance = null, outputLocation, deliver, meta = {}, resume = null } = {}) {
  if (!chatId) throw new Error("No chat for the monitor.");
  const open = perChat.get(chatId)?.size || 0;
  if (!resume && open >= cap()) {
    throw new Error(`Cap hit: ${open} monitors are already running in this chat (at most ${cap()}). End one with cbase_monitor_stop before you start a new one.`);
  }
  // What a resume needs again (only the arguments, never the approval: it was given at the first start).
  const kept = { command: args?.command || "", ws: args?.ws || "", protocols: Array.isArray(args?.protocols) ? args.protocols : [],
    report: args?.report || "", description: args?.description || "", persistent: args?.persistent === true };
  let e = null;
  const rt = createMonitorRuntime({
    cwd, env, instance,
    // CPU saver: every monitor is background work — the toggle is asked at the start.
    saver: saverOn,
    onStart: (t) => {
      const logRel = resume?.row?.logPath || `${MONITOR_FOLDER}/${t.taskId}.log`;
      const logFile = resume?.row?.logFile || path.join(outputLocation, logRel);
      e = { chatId, task: t, rt, logRel, logFile, fd: null, written: 0, clipped: false, logError: false, tail: "",
        deliver, endDelivered: false, silenced: false, stopThrough: "", data: DIRS?.data || "",
        args: kept, cwd, identifier: instanceIdentifierOf(instance), attempts: resume?.row?.attempts || 0, stableTimer: null, held: [] };
      try { e.fd = openLog(logFile); } catch (err) { console.error(`[monitor] log ${logFile} not opened:`, err?.message || err); e.logError = true; }
      if (resume) {
        // The same file continued: its cap counts what already stands there.
        try { if (e.fd !== null) e.written = fs.fstatSync(e.fd).size; } catch { /* the log is a convenience */ }
        e.clipped = e.written >= logMax();
        logWrite(e, `\n# Resumed after a server restart (attempt ${e.attempts}) · ${new Date().toISOString()}\n\n`);
        // Stable for the period: the count of attempts starts over (a later restart gets its full attempts again), and
        // the events held until then go out as ONE notice.
        e.stableTimer = setTimeout(() => {
          e.stableTimer = null;
          e.attempts = 0;
          refreshInventory();
          if (e.held.length) {
            const output = e.held.join("\n");
            e.held = [];
            wake(e, monitorNotice({ task: e.task, event: { status: "running", output }, logFile: e.logFile }));
          }
        }, resumeStableMs());
        e.stableTimer.unref?.();
      } else {
        logWrite(e, `# Monitor ${t.taskId} — ${t.description}\n# ${t.kind === "command" ? `command: ${t.command}` : `WebSocket: ${t.ws}`}\n`
          + `# report: ${t.report}${t.persistent ? " · persistent" : ""} · started ${new Date(t.startedAt).toISOString()}\n\n`);
      }
      let m = perChat.get(chatId);
      if (!m) perChat.set(chatId, (m = new Map()));
      m.set(t.taskId, e);
      waiting.delete(t.taskId);
      historyRow(chatId, "started", t, "", resume ? { resumed: true } : {});
      refreshInventory();
      report(chatId, "start");
    },
    onOutput: (_t, text) => {
      if (!e) return;
      logWrite(e, text);
      e.tail = (e.tail + text).slice(-TAIL_BUFFER);
    },
    onNotification: (t, event) => {
      if (!e) return;
      const ending = Boolean(event.status && event.status !== "running");
      // Before its stable period a resumed monitor wakes nobody: its end is a failed attempt (onDone), an event waits
      // for the period — a command that fails at once would otherwise wake the chat once per attempt.
      if (e.stableTimer) {
        if (!ending) e.held.push(String(event.output || ""));
        return;
      }
      if (ending) e.endDelivered = true;
      wake(e, monitorNotice({ task: t, event, logFile: e.logFile }));
    },
    onDone: (t, status, detail, info = {}) => {
      if (!e) return;
      perChat.get(chatId)?.delete(t.taskId);
      if (!perChat.get(chatId)?.size) perChat.delete(chatId);
      const end = monitorEndText({ task: t, status, info, detail });
      const unstable = Boolean(e.stableTimer);
      if (e.stableTimer) { clearTimeout(e.stableTimer); e.stableTimer = null; }
      // A resumed monitor that ends before its stable period: a failed attempt, no end (crash-loop protection).
      if (unstable && status !== "stopped" && !e.silenced) {
        logClose(e, `\n# ${end}\n`);
        failedAttempt(inventoryRow(e), end, tail(e));
        report(chatId, "end");
        return;
      }
      logClose(e, `\n# ${end}\n`);
      refreshInventory();
      // Who wakes? A stop (agent, human, chat closed) does not; report mode "end" always otherwise; the line mode
      // only if the end did not already come as an event (time limit without output, flood brake — the core reports
      // an end without output itself).
      const stopped = status === "stopped";
      const wakes = !e.silenced && !stopped && (t.report === "end" || !e.endDelivered);
      if (wakes) {
        wake(e, monitorNotice({ task: t, event: { status, output: tail(e), end }, logFile: e.logFile, end: true, clipped: e.clipped }));
      } else if (!e.silenced) {
        historyRow(chatId, "done", t, status);
      }
      if (stopped && e.stopThrough === "human" && !e.silenced) {
        depositHint(chatId, T`The human stopped the monitor "${t.description}" (${t.taskId}) — it no longer reports. Output so far: ${e.logFile}`, { source: "monitor" });
      }
      report(chatId, "end");
    },
  });
  try {
    const task = rt.start(args, meta);
    return { ...task, logPath: e?.logRel || "", logFile: e?.logFile || "" };
  } catch (err) {
    rt.close();
    throw err;
  }
}

function wake(e, text) {
  if (typeof e.deliver !== "function") return;
  try { e.deliver(text); } catch (err) { console.error("[monitor] notice not delivered:", e.chatId, err?.message || err); }
}

/** Stop a monitor. `through`: "agent" (cbase_monitor_stop) | "human" (card). → true if it existed. A persistent one
 *  waiting for its resume — or still in the inventory of the last run before the restart hook took it — ends for good
 *  as well (it leaves the inventory). */
export function stopMonitor(chatId, taskId, { through = "agent" } = {}) {
  const id = String(taskId || "");
  const e = perChat.get(chatId)?.get(id);
  const who = through === "human" ? "human" : "agent";
  if (!e) {
    const row = dropPending(chatId, id);
    if (!row) return false;
    appendLog(row.logFile, `\n# ${monitorEndText({ task: row, status: "stopped", info: { through: who } })}\n`);
    historyRow(chatId, "done", row, "stopped");
    if (who === "human") depositHint(chatId, T`The human stopped the monitor "${row.description}" (${row.taskId}) — it no longer reports. Output so far: ${row.logFile}`, { source: "monitor" });
    report(chatId, "end");
    return true;
  }
  e.stopThrough = who;
  return e.rt.stop(e.task.taskId, "stopped", { through: e.stopThrough });
}

/** End all monitors of a chat silently (archive, delete): no wake call, no note. → count. */
export function closeMonitors(chatId) {
  const m = perChat.get(chatId);
  let n = 0;
  for (const e of [...(m?.values() || [])]) {
    e.silenced = true;
    if (e.rt.stop(e.task.taskId, "stopped", { through: "chat" })) n++;
  }
  const pending = [...[...waiting.values()].map((w) => w.row), ...carriedRows()].filter((z) => z.chatId === chatId);
  for (const z of pending) if (dropPending(chatId, z.taskId)) n++;
  if (pending.length) report(chatId, "end");
  return n;
}

// Take a monitor out of `waiting` or out of the carried rows (not yet resumed) — it never comes back. → its row or null.
function dropPending(chatId, taskId) {
  const w = waiting.get(taskId);
  let row = null;
  if (w && w.row.chatId === chatId) {
    if (w.timer) clearTimeout(w.timer);
    waiting.delete(taskId);
    row = w.row;
  } else {
    const rows = carriedRows();
    const i = rows.findIndex((z) => z.chatId === chatId && z.taskId === taskId);
    if (i >= 0) row = rows.splice(i, 1)[0];
  }
  if (row) refreshInventory();
  return row;
}

// A line into a monitor's log file outside its run (resume attempts, stop while waiting) — via the same opening.
function appendLog(file, text) {
  if (!file) return;
  let fd = null;
  try { fd = openLog(file); fs.writeSync(fd, String(text)); } catch { /* the log is a convenience */ }
  finally { if (fd !== null) { try { fs.closeSync(fd); } catch { /* closed */ } } }
}

/**
 * The server run ends: end every watch process — silently, and WITHOUT emptying the inventory: the restart of the
 * next run reports them to the chat (like a crash). Only the monitors of this data folder (in tests several servers
 * run in one process).
 */
export function monitorsAtServerEnd() {
  const data = DIRS?.data || "";
  for (const [chatId, m] of [...perChat]) {
    for (const e of [...m.values()]) {
      if (e.data !== data) continue;
      m.delete(e.task.taskId);
      if (e.stableTimer) { clearTimeout(e.stableTimer); e.stableTimer = null; }
      logClose(e, e.task.persistent ? "\n# The server was shut down — the persistent monitor starts again after the restart.\n" : "\n# End: the server was shut down.\n");
      try { e.rt.close(); } catch { /* already closed */ }
    }
    if (!m.size) perChat.delete(chatId);
  }
  // Waiting resumes: only the clocks go — their rows stand in the file, the next run takes them.
  for (const [taskId, w] of [...waiting]) {
    if (w.row.data !== data) continue;
    if (w.timer) clearTimeout(w.timer);
    waiting.delete(taskId);
  }
  // The next run of this data folder reads the file anew.
  carried.delete(data);
  resumeHinted.clear();
}

/** The text of the note after a restart. Pure, exported for the guard. */
export const orphanedText = (z) => T`The monitor "${z.description}" (${z.taskId}, report: ${z.report}) was running when the server restarted — it has ended and no longer reports. Its output so far is in the output folder at ${z.logPath}. Restart with cbase_monitor whatever still needs watching.`;
/** The silent hint after a persistent monitor started again. Pure, exported for the guard. */
// Only for the model (silent hint, no history row) — English, not through T().
export const resumedText = (z) => `The persistent monitor "${z.description}" (${z.taskId}) was started again after a server restart — same id, its log ${z.logPath} continues. Output during the restart was not observed.`;

/**
 * Restart hook: per monitor of the last run — a persistent one starts again (see the file head), every other gets ONE
 * note to its chat. → { resumed, reported }.
 */
export function monitorsRestartGrace() {
  const rows = carriedRows().splice(0);
  let reported = 0, resumed = 0;
  for (const z of rows) {
    let chat = null;
    try { chat = store.getChat(z.chatId); } catch { /* deleted */ }
    if (!chat) continue;
    if (z.persistent && z.args) {
      resumed++;
      waiting.set(z.taskId, { row: { ...z, attempts: Number(z.attempts) || 0 }, timer: null });
      continue;
    }
    const text = orphanedText(z);
    try { store.addMessage(z.chatId, "hint", text); } catch (err) { console.error("[monitor] note:", err?.message || err); }
    depositHint(z.chatId, text, { source: "monitor-orphaned" });
    reported++;
  }
  refreshInventory();
  for (const z of rows) { const w = waiting.get(z.taskId); if (w && !w.timer) attemptResume(w.row); }
  if (reported) console.log(`[monitor] reported ${reported} monitor(s) as ended after the restart`);
  if (resumed) console.log(`[monitor] ${resumed} persistent monitor(s) taken up for their resume after the restart`);
  return { resumed, reported };
}

// ── Resume of a persistent monitor ─────────────────────────────────────────────────────────────────────────────────
// One attempt: the chat must exist, the instance too; while its project is locked the attempt waits uncounted. The
// count rises and stands in the inventory BEFORE the start (a backend that dies with the start has used the attempt).
function attemptResume(row) {
  const w = waiting.get(row.taskId);
  if (!w || w.row !== row) return; // stopped or closed meanwhile
  w.timer = null;
  let chat = null;
  try { chat = store.getChat(row.chatId); } catch { /* deleted */ }
  if (!chat) { dropPending(row.chatId, row.taskId); return; }
  if (!delivery) { giveUp(row, T("no wake path attached in this server run")); return; }
  let instance = null;
  if (row.instance) {
    instance = instanceFromIdentifier(row.instance);
    if (!instance) { giveUp(row, T`its instance ${row.instance} no longer exists`); return; }
    const lock = startLock(row.chatId, "agent", { projectId: projectFromIdentifier(row.instance), identifier: row.instance });
    if (lock?.kind === "wait") { park(row, resumePollMs()); return; }
    if (lock) { row.attempts += 1; failedAttempt(row, String(lock.text || lock.kind), ""); return; }
  }
  if (row.attempts >= resumeMax()) { giveUp(row, T`${row.attempts} starts in a row did not run for ${Math.round(resumeStableMs() / 1000)} s`); return; }
  row.attempts += 1;
  refreshInventory();
  try {
    startMonitor(row.chatId, row.args, { cwd: row.cwd, instance, resume: { row },
      deliver: (text) => delivery?.(row.chatId, text), meta: { taskId: row.taskId, startedAt: row.startedAt } });
  } catch (err) {
    failedAttempt(row, String(err?.message || err), "");
    return;
  }
  if (!resumeHinted.has(row.taskId)) {
    resumeHinted.add(row.taskId);
    depositHint(row.chatId, resumedText(row), { source: "monitor-resumed" });
  }
}

function park(row, ms) {
  const w = { row, timer: null };
  waiting.set(row.taskId, w);
  w.timer = setTimeout(() => attemptResume(row), ms);
  w.timer.unref?.();
}

// An attempt failed (ended before its stable period, start threw, lock refused): retry after the pause, or give up.
function failedAttempt(row, why, lastRows) {
  const next = { ...row };
  if (next.attempts >= resumeMax()) { giveUp(next, T`${next.attempts} starts in a row did not run for ${Math.round(resumeStableMs() / 1000)} s (last: ${why})`, lastRows); return; }
  const ms = resumeBackoffMs(next.attempts);
  appendLog(next.logFile, `# Resume attempt ${next.attempts} failed (${why}) — next attempt in ${Math.round(ms / 100) / 10} s\n`);
  park(next, ms);
  refreshInventory();
}

// The end for good: out of the inventory, ONE end notice through the wake path (like any monitor that ends by itself).
function giveUp(row, why, lastRows = "") {
  const w = waiting.get(row.taskId);
  if (w?.timer) clearTimeout(w.timer);
  waiting.delete(row.taskId);
  refreshInventory();
  const task = { taskId: row.taskId, description: row.description, report: row.report, timeoutMs: 0 };
  const end = monitorEndText({ task, status: "failed", info: { reason: "resume" }, detail: why });
  appendLog(row.logFile, `\n# ${end}\n`);
  console.warn(`[monitor] ${row.chatId}/${row.taskId}: ${end}`);
  const text = monitorNotice({ task, event: { status: "failed", output: lastRows, end }, logFile: row.logFile, end: true });
  try {
    const r = delivery?.(row.chatId, text);
    if (!r || r.ok === false) historyRow(row.chatId, "done", task, "failed");
  } catch (err) { console.error("[monitor] notice not delivered:", row.chatId, err?.message || err); }
  report(row.chatId, "end");
}
