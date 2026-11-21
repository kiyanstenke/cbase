// Node.js debugger over the V8 inspector protocol (CDP). Starts the target file with `node --inspect-brk`, connects via
// WebSocket, and offers breakpoints, stepping, call stack, variables (scopes) and watch (evaluateOnCallFrame). Events go
// over SSE, commands over POST. node-pty is NOT needed; ws is bundled. If ws/Node fails, the debugger reports itself as
// unavailable (the rest of the app stays functional).
// The ONE start function: with an instance the program starts in the project container, without one exactly as plain.
// The inspector address Node reports there ("Debugger listening on ws://127.0.0.1:<p>/…") is the container's loopback — B
// connects to the instance's IP (DNAT on eth0; the inspector checks the host like Chromium: an IP works, a name does not).
// The inspector has not been measured through DNAT.
import { T } from "./i18n.js";
import { inProject } from "./runtime/inProject.js";
import { instanceIp, urlWithHost } from "./projectbox/address.js";
import crypto from "node:crypto";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import process from "node:process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let WebSocket = null;
try { WebSocket = require("ws"); } catch { WebSocket = null; }
export function debugAvailable() { return !!WebSocket; }

const sessions = new Map();
const TS_RE = /\.(ts|tsx|mts|cts)$/i;

function cdp(sess, method, params) {
  return new Promise((resolve, reject) => {
    if (!sess.ws) return reject(new Error("not connected"));
    const id = ++sess.seq;
    sess.pending.set(id, { resolve, reject });
    sess.ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
}
function emit(sess, event, data) {
  for (const res of sess.subs) { try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* ignore */ } }
}
function fileFromUrl(sess, url) {
  if (!url || !url.startsWith("file://")) return url || "";
  let abs; try { abs = fileURLToPath(url); } catch { return url; }
  const base = path.resolve(sess.cwd);
  if (abs === base || abs.startsWith(base + path.sep)) return path.relative(base, abs).split(path.sep).join("/");
  return abs;
}
function descValue(v) {
  if (!v) return "";
  if (v.type === "string") return JSON.stringify(v.value);
  if ("value" in v) return String(v.value);
  if (v.type === "function") return v.description ? v.description.split("\n")[0] : "ƒ";
  return v.description || v.className || v.subtype || v.type || "";
}
function cleanup(id) {
  const s = sessions.get(id);
  if (!s) return;
  try { s.ws?.close(); } catch { /* ignore */ }
  try { s.proc?.kill(); } catch { /* ignore */ }
  sessions.delete(id);
}

// `tag`: the key of the session as with the terminal (terminal.js). The project level passes the tag of its instance
// (`proj:<id>` or `proj:<id>@copy-<name>`, the project terminal tag in projectbox/idle.js): idle and lock then count the
// debugger like a terminal of this instance and end it with a notice before its container is recreated or cleaned up. Without a
// tag (workspace level) it belongs to nobody there.
export function debugLaunch({ cwd, file, breakpoints, instance = null, tag = "" } = {}) {
  if (!WebSocket) throw new Error(T("Debugger not available (ws missing)"));
  const f = String(file || "");
  if (!f) throw new Error(T("No file"));
  const id = crypto.randomUUID();
  // From B the instance's IP — without an IP it throws BEFORE the start (no program that nobody can reach).
  const inspectorHost = instance ? instanceIp(instance) : null;
  const args = ["--inspect-brk=0"];
  if (TS_RE.test(f)) args.push("--experimental-strip-types");
  args.push(f);
  const proc = inProject(instance, "node", args, { cwd: cwd || process.env.HOME, env: process.env });
  const sess = { id, proc, ws: null, subs: new Set(), seq: 0, pending: new Map(), scripts: new Map(), paused: null, cwd: cwd || process.env.HOME, breakpoints: breakpoints || [], bpIds: new Map(), connected: false, stderr: "", tag: typeof tag === "string" ? tag : "" };
  sessions.set(id, sess);

  proc.stdout.on("data", (d) => emit(sess, "output", { stream: "stdout", text: d.toString() }));
  proc.stderr.on("data", (d) => {
    const s = d.toString();
    if (!sess.connected) {
      sess.stderr += s;
      const m = sess.stderr.match(/ws:\/\/\S+/);
      if (m && !inspectorHost) { sess.connected = true; connect(sess, m[0]); }
      else if (m) {
        sess.connected = true;
        let target = null;
        try { target = urlWithHost(m[0], inspectorHost); } catch (e) { emit(sess, "output", { stream: "stderr", text: T`Inspector address: ${e.message}` }); }
        if (target) connect(sess, target);
      }
    } else if (/Waiting for the debugger to disconnect/i.test(s)) {
      // Program finished — Node hangs on the inspector; disconnect so that it exits.
      try { sess.ws?.close(); } catch { /* ignore */ }
    } else if (!/Debugger (listening|attached)|For help, see|most recent version/i.test(s)) {
      emit(sess, "output", { stream: "stderr", text: s });
    }
  });
  proc.on("error", (e) => { emit(sess, "output", { stream: "stderr", text: T`Start failed: ${e.message}` }); emit(sess, "terminated", { code: -1 }); cleanup(id); });
  proc.on("exit", (code) => { emit(sess, "terminated", { code }); cleanup(id); });
  return { id, available: true };
}

function connect(sess, url) {
  const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
  sess.ws = ws;
  ws.on("message", (raw) => onMessage(sess, raw.toString()));
  ws.on("error", (e) => emit(sess, "output", { stream: "stderr", text: "WS: " + e.message }));
  ws.on("open", async () => {
    try {
      await cdp(sess, "Runtime.enable");
      await cdp(sess, "Debugger.enable");
      for (const bp of sess.breakpoints) { try { await setBp(sess, bp.file, bp.line); } catch { /* ignore */ } }
      await cdp(sess, "Runtime.runIfWaitingForDebugger");
      emit(sess, "started", { id: sess.id });
    } catch (e) { emit(sess, "output", { stream: "stderr", text: String(e.message || e) }); }
  });
}

function onMessage(sess, raw) {
  let msg; try { msg = JSON.parse(raw); } catch { return; }
  if (msg.id && sess.pending.has(msg.id)) {
    const { resolve, reject } = sess.pending.get(msg.id); sess.pending.delete(msg.id);
    return msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  }
  const { method, params } = msg;
  if (method === "Debugger.scriptParsed") { if (params.url) sess.scripts.set(params.scriptId, params.url); }
  else if (method === "Debugger.paused") {
    // Skip the synthetic entry pause of --inspect-brk automatically (like VS Code stopOnEntry=false), so that it runs
    // straight to the real breakpoint.
    if (!sess.sawEntry) { sess.sawEntry = true; cdp(sess, "Debugger.resume").catch(() => {}); return; }
    handlePaused(sess, params);
  }
  else if (method === "Debugger.resumed") { sess.paused = null; emit(sess, "resumed", {}); }
  else if (method === "Runtime.consoleAPICalled") emit(sess, "output", { stream: "console", text: (params.args || []).map((a) => descValue(a)).join(" ") });
  else if (method === "Runtime.executionContextDestroyed") { try { sess.ws?.close(); } catch { /* ignore */ } }
}

async function handlePaused(sess, params) {
  sess.paused = params;
  const frames = (params.callFrames || []).slice(0, 30).map((cf) => ({
    callFrameId: cf.callFrameId,
    name: cf.functionName || T("(anonymous)"),
    file: fileFromUrl(sess, cf.url || sess.scripts.get(cf.location.scriptId) || ""),
    line: cf.location.lineNumber + 1,
  }));
  const scopes = [];
  const top = params.callFrames && params.callFrames[0];
  if (top) {
    for (const sc of top.scopeChain || []) {
      if (sc.type === "global" || !sc.object?.objectId) continue;
      let vars = [];
      try {
        const r = await cdp(sess, "Runtime.getProperties", { objectId: sc.object.objectId, ownProperties: true, generatePreview: true });
        vars = (r.result || []).filter((p) => p.enumerable !== false).slice(0, 200).map((p) => ({ name: p.name, value: descValue(p.value), type: p.value?.type || "" }));
      } catch { /* ignore */ }
      scopes.push({ type: sc.type, name: sc.name || sc.type, vars });
    }
  }
  emit(sess, "paused", { reason: params.reason, frames, topFile: frames[0]?.file, topLine: frames[0]?.line, scopes });
}

async function setBp(sess, file, line) {
  const abs = path.isAbsolute(file) ? file : path.join(sess.cwd, file);
  const url = pathToFileURL(abs).href;
  const r = await cdp(sess, "Debugger.setBreakpointByUrl", { lineNumber: line - 1, url });
  sess.bpIds.set(`${file}:${line}`, r.breakpointId);
  return r;
}

export function debugSubscribe(id, res) {
  const s = sessions.get(id); if (!s) return false;
  s.subs.add(res);
  if (s.paused) handlePaused(s, s.paused); // deliver the current pause state afterwards
  res.on("close", () => s.subs.delete(res));
  return true;
}
export function debugCommand(id, cmd) {
  const s = sessions.get(id); if (!s || !s.ws) return { ok: false };
  const map = { continue: "Debugger.resume", stepOver: "Debugger.stepOver", stepInto: "Debugger.stepInto", stepOut: "Debugger.stepOut", pause: "Debugger.pause" };
  if (!map[cmd]) return { ok: false };
  cdp(s, map[cmd]).catch(() => {});
  return { ok: true };
}
export async function debugSetBreakpoints(id, file, lines) {
  const s = sessions.get(id); if (!s || !s.ws) return { ok: false };
  const want = new Set((lines || []).map(Number));
  // remove what is no longer wanted
  for (const [key, bpId] of [...s.bpIds]) {
    const [f, ln] = key.split(":"); if (f !== file) continue;
    if (!want.has(Number(ln))) { try { await cdp(s, "Debugger.removeBreakpoint", { breakpointId: bpId }); } catch { /* ignore */ } s.bpIds.delete(key); }
  }
  // add what is new
  for (const ln of want) if (!s.bpIds.has(`${file}:${ln}`)) { try { await setBp(s, file, ln); } catch { /* ignore */ } }
  return { ok: true };
}
export async function debugEvaluate(id, expr) {
  const s = sessions.get(id); if (!s) throw new Error(T("Session not found"));
  if (!s.paused) throw new Error(T("Can only be evaluated while paused"));
  const cf = s.paused.callFrames[0];
  const r = await cdp(s, "Debugger.evaluateOnCallFrame", { callFrameId: cf.callFrameId, expression: String(expr || ""), generatePreview: true, silent: true });
  if (r.exceptionDetails) return { error: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
  return { value: descValue(r.result), type: r.result?.type || "" };
}
export function debugStop(id) { cleanup(id); return { ok: true }; }

// Like terminal.js countTerminalsByTag/endTerminalsWithNotice (see debugLaunch): how many sessions carry this tag, and end
// them — beforehand every viewer gets the notice as output (`terminated` reports the end of the program itself, as with
// debugStop). Empty tag ⇒ none.
export function countDebugByTag(tag) {
  if (typeof tag !== "string" || !tag) return 0;
  let n = 0;
  for (const s of sessions.values()) if (s.tag === tag) n++;
  return n;
}
export function endDebugWithNotice(tag, notice) {
  if (typeof tag !== "string" || !tag) return 0;
  let n = 0;
  for (const [id, s] of [...sessions]) {
    if (s.tag !== tag) continue;
    emit(s, "output", { stream: "stderr", text: `${String(notice || "").replace(/[\r\n]+/g, " ")}\n` });
    cleanup(id);
    n++;
  }
  return n;
}
