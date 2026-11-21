// Integrated terminal: real PTY sessions via node-pty in the Electron main process.
// I/O goes over the existing HTTP server (SSE for output, POST for input), so no extra
// WebSocket server is needed. node-pty is loaded lazily; if it is missing or breaks, the rest of
// the app keeps working (the terminal then reports itself as unavailable).
import { createRequire } from "node:module";
import crypto from "node:crypto";
import path from "node:path";
import process from "node:process";
// The ONE start function: with an instance the pty runs as `docker exec -it ... cbase-wrapper ...` in the project container.
import { inProjectCall, inProjectKill } from "./runtime/inProject.js";
import { HEARTBEAT, HEARTBEAT_MS } from "./runtime/heartbeat.js";
import { dataRow, truncateBuffer, catchUpTerminal } from "./terminal-stream.js";
import { T } from "./i18n.js";

const require = createRequire(import.meta.url);
let pty = null;
let ptyError = null;
function loadPty() {
  if (pty || ptyError) return pty;
  try { pty = require("node-pty"); } catch (e) { ptyError = String(e && e.message ? e.message : e); }
  return pty;
}
export function terminalAvailable() { loadPty(); return !!pty; }
export function terminalError() { return ptyError; }

const sessions = new Map(); // id -> { proc, buffer, end, subs:Set<res>, tag, group, identifier }
// ONE observer for the end of a session (set in server.js; the layout then re-checks its quiet state): fn({ id, tag, identifier }). Unset: nothing.
let endObserver = null;
export function setTerminalEndObserver(fn) { endObserver = typeof fn === "function" ? fn : null; }
// ── The stream: offset instead of full replay ───────────────────────────────────────────────────────────────────────────────────
// The protocol (counter `end`, `id:`/`until`, resume, `replaced`, truncation without half a character) lives in the leaf
// `terminal-stream.js`. Only what hangs on the sessions is here: buffer, subscribers, heartbeat.

// Heartbeat (`runtime/heartbeat.js`, the same as the chat, global and browser streams): a silent stream is not cut in the first
// place. Without `id:` it does not move the browser's last event id; iOS ignores `{}` (there it also kept URLSession's 45 s
// deadline open, at which an idle stream ended silently). The tick starts with the first subscription, `unref`.
// `heartbeatNow()` is the seam for the test: the same round at once, without waiting for the tick.
let heartbeatTick = null;
export function heartbeatNow() {
  for (const s of sessions.values()) for (const res of s.subs) { try { if (!res.destroyed) res.write(HEARTBEAT); } catch { /* viewer is just leaving */ } }
}
function saveHeartbeat() {
  if (heartbeatTick) return;
  heartbeatTick = setInterval(heartbeatNow, HEARTBEAT_MS);
  heartbeatTick.unref?.();
}
/** Read-only, for the test: is the tick running? */
export function terminalHeartbeatRunning() { return heartbeatTick !== null; }

// The shell's locale: it must exist at the TARGET. A Linux target (B itself and every project container; with `instance` always
// the project box image, bookworm) knows only C, C.utf8 and POSIX. With en_US.UTF-8 as the fallback even the perl wrapper
// (cbase-wrapper) printed six "perl: warning: Setting locale failed" lines before the prompt, and the shell fell back to C
// (umlauts in file names and readline broken). C.UTF-8 ships with libc. On the Mac without an instance it stays en_US.UTF-8,
// and a LANG set in B applies as before (it does not differ and never passes the allow list of runtime/inProject.js into the container).
// `lang` is NOT a default parameter: an explicitly passed `undefined` triggers the default in JS, so
// `terminalLang({ lang: undefined })` would read the process LANG. A passed `lang` (even `undefined`) means "this LANG" or
// "no LANG"; only a MISSING field reads process.env.LANG (the caller below).
export function terminalLang(opts = {}) {
  const { instance = null, platform = process.platform } = opts || {};
  const lang = opts && Object.hasOwn(opts, "lang") ? opts.lang : process.env.LANG;
  if (lang) return lang;
  return !instance && platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8";
}

// `tag`: a key of the caller's choice (the chat bar sends "chat:<chatId>") so `killTerminalsByTag` finds a chat's shells when
// the chat is deleted; the sessions otherwise know nothing about their origin.
// `instance`: the project's instance (runs/instance.js). If set, the pty starts `docker exec -it` in its container; the
// environment goes along as an allow list (runtime/inProject.js), `kill` ends the group in the container (SIGHUP like a
// closed pty) and then the pty. Without an instance everything is as before.
export function createTerminal({ cwd, cols = 80, rows = 24, shell, command, args, env: envOverride, tag = "", instance = null } = {}) {
  if (!loadPty()) throw new Error(T`Terminal not available: ${ptyError || T("node-pty is missing")}`);
  const id = crypto.randomUUID();
  // SHELL_SESSIONS_DISABLE=1: disable macOS shell session restore. Otherwise /etc/zshrc_Apple_Terminal would change into a
  // previously saved directory at login shell start and overwrite the passed `cwd` (e.g. the project folder).
  const env = { ...(envOverride || process.env), TERM: "xterm-256color", LANG: terminalLang({ instance }), SHELL_SESSIONS_DISABLE: "1" };
  // command set: start exactly this command in a PTY (e.g. `claude auth login`);
  // otherwise an interactive login shell (project terminal).
  let proc;
  let group = null;
  // The pty's program: its name goes to the client (the terminal title like VS Code `${process}`: "zsh").
  const program = command || shell || process.env.SHELL || "/bin/zsh";
  if (instance) {
    const call = inProjectCall(instance, program, command ? args || [] : ["-l"],
      { cwd: cwd || process.env.HOME, env, tty: true });
    group = inProjectKill(call);
    proc = pty.spawn(call.program, call.args, { name: "xterm-256color", cwd: process.env.HOME, cols, rows, env: call.env });
  } else {
    proc = command
      ? pty.spawn(command, args || [], { name: "xterm-256color", cwd: cwd || process.env.HOME, cols, rows, env })
      : pty.spawn(program, ["-l"], { name: "xterm-256color", cwd: cwd || process.env.HOME, cols, rows, env });
  }
  const sess = { proc, buffer: "", end: 0, subs: new Set(), tag: typeof tag === "string" ? tag : "", group, identifier: instance?.identifier || null };
  proc.onData((d) => {
    sess.buffer += d;
    sess.end += d.length;
    sess.buffer = truncateBuffer(sess.buffer);
    const row = dataRow(d, sess.end);
    for (const res of sess.subs) { try { res.write(row); } catch { /* ignore */ } }
  });
  proc.onExit(({ exitCode }) => {
    group?.closed();
    for (const res of sess.subs) { try { res.write(`event: exit\ndata: ${JSON.stringify({ exitCode })}\n\n`); res.end(); } catch { /* ignore */ } }
    sessions.delete(id);
    if (endObserver) { try { endObserver({ id, tag: sess.tag, identifier: sess.identifier }); } catch (e) { console.error("[terminal] end observer:", e?.message || e); } }
  });
  sessions.set(id, sess);
  return { id, shell: path.basename(program) };
}
// `ab`: the client's resume point (terminal-stream.js catchUpTerminal). The first line ALWAYS goes out, even empty: it sets the
// position. Without it on an empty first fetch the browser would send no `Last-Event-ID` on the next reconnect and the full
// buffer would come again. A data event `{d:"", until}` WITH `id:` is chosen instead of a bare `id:` line: per the SSE spec the
// latter sets the last id even without `data`, but that is an edge case of browser implementations, and iOS would not see it at
// all (it reads only `data:`). This way both clients understand the same line; neither writes an empty `d`. Synchronous with the
// entry in `subs`: no live chunk can slip in between catching up and subscribing.
export function subscribeTerminal(id, res, from = null) {
  const s = sessions.get(id);
  if (!s) return false;
  saveHeartbeat();
  s.subs.add(res);
  const { d, until, replaced } = catchUpTerminal(s, from);
  try { res.write(dataRow(d, until, replaced)); } catch { /* ignore */ }
  res.on("close", () => s.subs.delete(res));
  return true;
}
export function terminalExists(id) { return sessions.has(id); }
export function writeTerminal(id, data) { const s = sessions.get(id); if (!s) return false; try { s.proc.write(data); } catch { /* ignore */ } return true; }
export function resizeTerminal(id, cols, rows) { const s = sessions.get(id); if (!s) return false; try { s.proc.resize(Math.max(1, cols | 0), Math.max(1, rows | 0)); } catch { /* ignore */ } return true; }
export function killTerminal(id) { const s = sessions.get(id); if (!s) return false; try { s.group?.kill("SIGHUP"); } catch { /* ignore */ } try { s.proc.kill(); } catch { /* ignore */ } sessions.delete(id); return true; }
// End all sessions with this tag (chat deleted => its PTYs). Empty tag => nothing: sessions without a tag (the page's terminal
// tab, login consoles) belong to nobody here.
export function killTerminalsByTag(tag) {
  if (typeof tag !== "string" || !tag) return 0;
  let n = 0;
  for (const [id, s] of [...sessions]) { if (s.tag === tag && killTerminal(id)) n++; }
  return n;
}
// The farewell line before a session ends: to the viewers, not into the PTY (there it would be shell input) and not into the
// buffer. The same data row as every chunk (`dataRow`), with the UNCHANGED position `end`: the message does not count because
// it is not in the buffer; a resume point behind it would be one the buffer never had. So `id:` (browser) and `until` (iOS) stay
// at the last real character, and there is only ONE row format.
function reportFarewell(s, notice) {
  const row = dataRow(`\r\n\x1b[33m${String(notice || "").replace(/[\r\n]+/g, " ")}\x1b[0m\r\n`, s.end);
  for (const res of s.subs) { try { res.write(row); } catch { /* ignore */ } }
}
// Like killTerminalsByTag, but WITH a notice: before the session ends every viewer gets a line of its own in the stream, so
// whoever sits in front of the shell sees WHY it ends (relocation, recreation).
export function endTerminalsWithNotice(tag, notice) {
  if (typeof tag !== "string" || !tag) return 0;
  let n = 0;
  for (const [id, s] of [...sessions]) {
    if (s.tag !== tag) continue;
    reportFarewell(s, notice);
    if (killTerminal(id)) n++;
  }
  return n;
}
// The process ids of the shells with this tag: node-pty makes the shell the leader of its own session, so its pid is the session
// (`sid`) of every process running in this terminal; the relocation plan thereby recognises which processes in the project
// folder end the lock with their terminal (projectbox/idle.js lock terminal sessions). Read-only; empty tag => none.
export function terminalPidsByTag(tag) {
  if (typeof tag !== "string" || !tag) return [];
  const out = [];
  for (const s of sessions.values()) if (s.tag === tag && Number.isInteger(s.proc?.pid) && s.proc.pid > 1) out.push(s.proc.pid);
  return out;
}
// How many sessions carry this tag (the pre-check warns before ending a chat's shells). Empty tag => 0, for the same reason as above.
export function countTerminalsByTag(tag) {
  if (typeof tag !== "string" || !tag) return 0;
  let n = 0;
  for (const s of sessions.values()) if (s.tag === tag) n++;
  return n;
}
// The open sessions, read-only: `{ id, tag, pid, identifier, inContainer, pgid }`. `pid` is the pty child's in B (without an
// instance the shell itself, its group and session), `pgid` for a session in the project container the shell's group IN the
// container (from the wrapper's pgid file, runtime/inProject.js) or null while it is not there.
export function terminalSessions() {
  const out = [];
  for (const [id, s] of sessions) {
    const pid = Number.isInteger(s.proc?.pid) && s.proc.pid > 1 ? s.proc.pid : null;
    let pgid = null;
    if (s.group) { try { pgid = s.group.pgid?.() || null; } catch { pgid = null; } }
    out.push({ id, tag: s.tag, pid, identifier: s.identifier || null, inContainer: Boolean(s.group), pgid });
  }
  return out;
}
// Like endTerminalsWithNotice, for ONE session (stopping a terminal holder of the layout). Returns whether it was running.
export function endTerminalWithNotice(id, notice) {
  const s = sessions.get(id);
  if (!s) return false;
  reportFarewell(s, notice);
  return killTerminal(id);
}
