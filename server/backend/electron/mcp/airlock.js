#!/usr/bin/env node
// The wrapper of the coding MCP airlock. A stdio MCP server that the CLI or the loop engine starts under the NAME of a coding MCP
// server (writeMcpConfig, toolchain/mcp-config.js) — everywhere they start stdio servers today (B or project container). The tool
// names `mcp__<name>__<tool>` stay.
//
//   stdio server  the wrapper fetches `{command, args, env}` from the backend (…/start) and starts the real server as a child — with
//                 its environment WITHOUT any CBASE_*, on top of it the child's stored env and, for a Claude run with an LFS
//                 environment, the LFS lock. Everything passes through except two requests: tools/list (all pages from the child, the
//                 whole list to the backend, the FILTERED one back, …/list) and tools/call (first …/call: free, rejected or a card
//                 that stays open there).
//   http/sse      every JSON-RPC message goes to …/rpc; the backend checks the same way, sets the headers (which the wrapper never
//                 sees) and forwards. The wrapper holds the session (`mcp-session-id`).
//
// Abort: neither CLI sends notifications/cancelled on a stop — Claude ends the wrapper with SIGINT, Codex closes stdin. Both (and
// SIGTERM/SIGHUP, and a notifications/cancelled for an open request) abort the open requests to the backend: the route then rejects
// the card and NEVER forwards.
//
// Only node: modules: the file runs in the project container under the same path (/app/electron/mcp, mounted) and with the same
// binary as cbase-mcp.js. No security boundary against Bash — the only promise: the headers never leave the backend.

import { spawn } from "node:child_process";
import process from "node:process";

const argv = process.argv.slice(2);
const SERVER = argv.includes("--server") ? String(argv[argv.indexOf("--server") + 1] || "") : "";
const BASE = process.env.CBASE_BASE_URL || "http://127.0.0.1:7718";
const CHAT = String(process.env.CBASE_CHAT_ID || "");
const HEADER = {
  "x-cbase-airlock": String(process.env.CBASE_AIRLOCK || ""),
  ...(process.env.CBASE_TOKEN ? { "x-cbase-token": String(process.env.CBASE_TOKEN) } : {}),
};
const PATH = `${BASE}/api/chats/${encodeURIComponent(CHAT)}/mcp-airlock/${encodeURIComponent(SERVER)}`;
// The LFS lock (runs/lfs-environment.js LFS_STDIO_LOCK) is in the wrapper's env if writeMcpConfig set it: then it applies on top of
// the child's stored env too (as over the entry). The two CBASE_LFS_* are dropped anyway.
const LFS_LOCK = process.env.CBASE_LFS_URL === "" && process.env.CBASE_LFS_PASS === "";
const ROW_MAX = Number(process.env.CBASE_MCP_ROW_MAX) || 64 * 1024 * 1024;
const PAGES_MAX = 50;
const INTERN = "cbase-airlock-";

const write = (n) => { try { process.stdout.write(JSON.stringify(n) + "\n"); } catch { /* stdout closed */ } };
const isRequest = (n) => n && typeof n === "object" && typeof n.method === "string" && n.id !== undefined && n.id !== null;
const key = (id) => JSON.stringify(id);
const error = (id, text) => ({ jsonrpc: "2.0", id, error: { code: -32603, message: String(text) } });
const denial = (id, text) => ({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: String(text) }], isError: true } });

let end2 = false;
let mode = null; // "stdio" | "http" | { error }
let subprocess = null;
let session = "";
const beforeStart = [];
const open = new Map(); // request id of the CLI → AbortController of the request to the backend
const pending = new Map(); // own request id to the child → resolve
let internalSeq = 0;

// ── Backend ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Holding answers come as an NDJSON stream (blank lines = heartbeat, the last line is the answer).
async function backend(kindName, body, signal) {
  const res = await fetch(`${PATH}/${kindName}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...HEADER, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("ndjson")) {
    const row = (await res.text()).split("\n").map((z) => z.trim()).filter(Boolean).pop();
    if (!row) throw new Error("empty answer of the airlock");
    return JSON.parse(row);
  }
  const data = ct.includes("json") ? await res.json() : { error: await res.text() };
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

// ── The child (stdio) ───────────────────────────────────────────────────────────────────────────────────────────────────────
function toKind(n) {
  if (!subprocess || end2) return;
  try { subprocess.stdin.write(JSON.stringify(n) + "\n"); } catch { /* child closed */ }
}
function kindRequest(method, params) {
  const id = `${INTERN}${++internalSeq}`;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    toKind({ jsonrpc: "2.0", id, method, params });
  });
}
function rowsReader(stream, onTextLine) {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    if (buffer.length > ROW_MAX && !buffer.includes("\n")) { buffer = ""; process.stderr.write(`[airlock] line over ${ROW_MAX} characters dropped\n`); return; }
    let i;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const row = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      if (row.trim()) onTextLine(row);
    }
  });
}
function startChild(s) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("CBASE_")) delete env[k];
  Object.assign(env, s.env || {});
  if (LFS_LOCK) for (const k of ["GIT_LFS_SKIP_SMUDGE", "GIT_LFS_SKIP_DOWNLOAD_ERRORS"]) if (k in process.env) env[k] = process.env[k];
  subprocess = spawn(String(s.command), (s.args || []).map(String), { env, cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] });
  subprocess.on("error", (e) => {
    process.stderr.write(`[airlock] ${SERVER}: ${e.message}\n`);
    for (const resolve of pending.values()) resolve({ error: { code: -32603, message: e.message } });
    pending.clear();
    end(1);
  });
  subprocess.on("exit", (code, signal) => { if (!end2) end(code ?? (signal ? 1 : 0)); });
  subprocess.stderr.on("data", (d) => { try { process.stderr.write(d); } catch { /* ignore */ } });
  rowsReader(subprocess.stdout, (row) => {
    let n = null;
    try { n = JSON.parse(row); } catch { /* not a JSON line — to the CLI as it is */ }
    if (n && typeof n.id === "string" && n.id.startsWith(INTERN) && !n.method) {
      const resolve = pending.get(n.id);
      pending.delete(n.id);
      if (resolve) resolve(n);
      return;
    }
    try { process.stdout.write(row + "\n"); } catch { /* stdout closed */ }
  });
}

async function listStdio(n) {
  const tools = [];
  let cursor = n.params?.cursor;
  let last = null;
  for (let page = 0; page < PAGES_MAX; page++) {
    last = await kindRequest("tools/list", { ...(n.params || {}), ...(cursor ? { cursor } : {}) });
    if (last.error) return write({ jsonrpc: "2.0", id: n.id, error: last.error });
    tools.push(...(Array.isArray(last.result?.tools) ? last.result.tools : []));
    cursor = last.result?.nextCursor;
    if (!cursor) break;
  }
  try {
    const g = await backend("list", { tools });
    const { nextCursor: _dropped, ...rest } = last?.result || {};
    write({ jsonrpc: "2.0", id: n.id, result: { ...rest, tools: Array.isArray(g.tools) ? g.tools : [] } });
  } catch (e) {
    write(error(n.id, `Airlock ${SERVER}: ${e.message}`));
  }
}

async function callStdio(n) {
  const k = key(n.id);
  const ac = new AbortController();
  open.set(k, ac);
  try {
    const r = await backend("call", { name: String(n.params?.name || ""), arguments: n.params?.arguments || {} }, ac.signal);
    if (ac.signal.aborted || end2) return;
    if (r.free) toKind({ ...n, params: { ...n.params, arguments: r.arguments } });
    else write(denial(n.id, r.text));
  } catch (e) {
    if (ac.signal.aborted || end2) return; // aborted: no answer, never forward
    write(denial(n.id, `Airlock ${SERVER}: ${e.message}`));
  } finally {
    open.delete(k);
  }
}

// ── http/sse ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function rpc(n) {
  const k = isRequest(n) ? key(n.id) : null;
  const ac = new AbortController();
  if (k) open.set(k, ac);
  try {
    const r = await backend("rpc", { message: n, session }, ac.signal);
    if (ac.signal.aborted || end2) return;
    if (typeof r.session === "string" && r.session) session = r.session;
    for (const m of Array.isArray(r.messages) ? r.messages : []) write(m);
  } catch (e) {
    if (ac.signal.aborted || end2) return;
    if (k) write(error(n.id, `Airlock ${SERVER}: ${e.message}`));
  } finally {
    if (k) open.delete(k);
  }
}

// ── From the CLI ────────────────────────────────────────────────────────────────────────────────────────────────────────────
function ofCli(n) {
  if (mode && typeof mode === "object") { if (isRequest(n)) write(error(n.id, `Airlock ${SERVER}: ${mode.error}`)); return; }
  // An abort for a request that is still pending in the backend: abort it there (card rejected), do NOT forward.
  if (n?.method === "notifications/cancelled") {
    const ac = open.get(key(n.params?.requestId));
    if (ac) { ac.abort(); open.delete(key(n.params?.requestId)); return; }
  }
  if (mode === "http") return void rpc(n);
  if (isRequest(n) && n.method === "tools/list") return void listStdio(n);
  if (isRequest(n) && n.method === "tools/call") return void callStdio(n);
  toKind(n);
}

rowsReader(process.stdin, (row) => {
  let n;
  try { n = JSON.parse(row); } catch { return write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }
  if (!mode) beforeStart.push(n);
  else ofCli(n);
});

// ── End ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function end(code = 0) {
  if (end2) return;
  end2 = true;
  for (const ac of open.values()) { try { ac.abort(); } catch { /* ignore */ } }
  open.clear();
  const out = () => process.exit(code);
  if (subprocess && subprocess.exitCode === null && subprocess.signalCode === null) {
    try { subprocess.stdin.end(); } catch { /* closed */ }
    try { subprocess.kill("SIGTERM"); } catch { /* gone */ }
    const hart = setTimeout(() => { try { subprocess.kill("SIGKILL"); } catch { /* gone */ } out(); }, 2000);
    subprocess.once("exit", () => { clearTimeout(hart); setTimeout(out, 20); });
  } else setTimeout(out, 20); // the aborted requests still reach the backend
}
process.stdin.on("end", () => end(0));
process.stdout.on("error", () => end(0));
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => end(0));

// ── Start ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
(async () => {
  try {
    if (!SERVER || !CHAT || !HEADER["x-cbase-airlock"]) throw new Error("wrapper without --server, CBASE_CHAT_ID or CBASE_AIRLOCK");
    const s = await backend("start");
    if (s.transport === "stdio") { startChild(s); mode = "stdio"; }
    else mode = "http";
  } catch (e) {
    mode = { error: e.message };
    process.stderr.write(`[airlock] ${SERVER}: ${e.message}\n`);
  }
  for (const n of beforeStart.splice(0)) ofCli(n);
})();
