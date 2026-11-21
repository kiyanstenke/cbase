// mcp-client.js — in-process MCP client (JSON-RPC 2.0).
//
// Connects arbitrary MCP servers, lists their tools and calls them. The loop engine (engine.js) uses it to offer MCP
// tools to completion providers — exactly the servers the CLI would otherwise get via --mcp-config (Claude) or
// -c mcp_servers.* (Codex). The source is the same spec.mcpServers set (cbase + playwright + own ones) that
// writeMcpConfig in toolchain/mcp-config.js builds → ONE path for all providers.
//
// Transport: stdio (newline-delimited JSON, like electron/mcp/cbase-mcp.js) fully supported; http/sse (Streamable
// HTTP) as best effort (own MCP servers; cbase/playwright are stdio). With an instance an HTTP server on localhost
// connects to its container (runtime/target.js requestInProject).
// The ONE start function: a stdio server starts in the project container of the instance, without one locally.
import { inProject } from "../runtime/inProject.js";
// Child stdin only through this helper (see providers/kind-stdin.js): an MCP server that dies while a message goes
// out would otherwise take the whole server process down with it.
import { closeStdin, writeStdin } from "./kind-stdin.js";
// An HTTP MCP server FOR an instance — localhost is its container (runtime/target.js); without an instance plain fetch.
import { requestInProject } from "../runtime/target.js";

const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "cbase-engine", version: "1.0.0" };
const INIT_TIMEOUT = 20_000;
const LIST_TIMEOUT = 20_000;
const CALL_TIMEOUT = 120_000;
const MAX_CALL_TIMEOUT = 3_600_000;
// Cap of a SINGLE message of a server. Without it the stdio client's `buf` would grow without bound as long as no line
// end comes — a server that writes without "\n" would fill the backend's memory; an HTTP server with an endless body
// likewise. Generous (a result may carry images as base64); above it the server is broken or hostile: stdio is ended,
// every open request fails with the wording; over HTTP the one request fails and the stream is cancelled. Read at
// runtime (tests set it small).
const rowsCap = () => Number(process.env.CBASE_MCP_ROW_MAX) || 64 * 1024 * 1024;
// tools/list across all pages (`nextCursor`, at most 50): loading the tools of a coding server (toolchain/mcp-load.js)
// needs the WHOLE list — one page would mean "the rest has vanished" in the cache.
async function allPages(question) {
  const tools = [];
  let cursor;
  for (let page = 0; page < 50; page++) {
    const r = await question(cursor ? { cursor } : {});
    if (Array.isArray(r?.tools)) tools.push(...r.tools);
    cursor = typeof r?.nextCursor === "string" && r.nextCursor ? r.nextCursor : null;
    if (!cursor) break;
  }
  return tools;
}
// Read the body of an HTTP response, at most `max` bytes — above that an error that says it was a cap. Unlike
// WebFetch (tool-runtime.js bodyUntilCap) nothing is truncated: half a JSON would not be an answer.
async function bodyWithCap(res, max, name) {
  const tooBig = () => new Error(`MCP "${name}": response over ${max} bytes — aborted`);
  if (!res.body || typeof res.body.getReader !== "function") {
    const text = await res.text(); // with an instance: requestInProject already stopped at max + 1 bytes
    if (Buffer.byteLength(text) > max) throw tooBig();
    return text;
  }
  const reader = res.body.getReader();
  const parts = [];
  let n = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.byteLength;
      if (n > max) throw tooBig();
      parts.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
  } finally {
    try { await reader.cancel(); } catch { /* already closed */ }
  }
  return Buffer.concat(parts).toString("utf8");
}

// Time limit of ONE tool call. A server may raise it per server (field `timeout` in ms in the MCP config) — the same
// field the Claude CLI knows ("Per-server tool-call timeout"). Needed by the native cbase agent tool: a subagent in the
// foreground works longer than two minutes, and the call should not break off with "Timeout" while the agent runs.
const callTimeoutOf = (def) => {
  const t = Number(def?.timeout);
  return t >= 1000 ? Math.min(t, MAX_CALL_TIMEOUT) : CALL_TIMEOUT;
};

// ── stdio transport ────────────────────────────────────────────────────────────
class StdioClient {
  constructor(name, def, { cwd, instance = null, onServerRequest } = {}) {
    this.name = name;
    this.def = def;
    this.cwd = cwd;
    this.instance = instance; // the run's instance (null = in the backend)
    this.child = null;
    this.buf = "";
    this.nextId = 1;
    this.pending = new Map(); // id → { resolve, reject, timer }
    this.stderr = "";
    this.closed = false;
    this.onServerRequest = onServerRequest || null; // sampling/createMessage, roots/list
  }

  async start() {
    const { command, args = [], env } = this.def;
    if (!command) throw new Error(`MCP server "${this.name}": no command`);
    // An own `env` SUPPLEMENTS the backend's environment, as with the Claude CLI: replacing it would run a server
    // with an env of its own without PATH and without the backend's package caches. With an instance this changes
    // nothing: the allowlist of inProject takes only what deviates from the backend — exactly the entries of the own env.
    this.child = inProject(this.instance, command, args, { cwd: this.cwd, env: env ? { ...process.env, ...env } : process.env, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (d) => this._onData(d));
    this.child.stderr.on("data", (d) => { this.stderr += String(d); if (this.stderr.length > 8000) this.stderr = this.stderr.slice(-8000); });
    this.child.on("error", (e) => this._fail(new Error(`MCP "${this.name}" spawn error: ${e.message}`)));
    this.child.on("close", () => { this.closed = true; this._fail(new Error(`MCP "${this.name}" ended`)); });

    await this._request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      // Capabilities of the CLIENT: with {} servers could not know that they may query the model (sampling) or ask
      // for the working roots.
      capabilities: this.onServerRequest ? { sampling: {}, roots: { listChanged: false } } : {},
      clientInfo: CLIENT_INFO,
    }, INIT_TIMEOUT);
    this._notify("notifications/initialized");
  }

  _onData(chunk) {
    if (this.closed) return;
    this.buf += chunk;
    let idx;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && msg.method) { this._serve(msg); continue; } // server→client request
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(timer);
        if (msg.error) reject(new Error(msg.error.message || `JSON-RPC ${msg.error.code}`));
        else resolve(msg.result);
      }
    }
    // What is left is a message that has begun. Above the cap: no buffer without bound — the server is ended, every
    // open request fails with this wording (instead of at the time limit or not at all).
    const cap = rowsCap();
    if (this.buf.length > cap) {
      this.buf = "";
      this._fail(new Error(`MCP "${this.name}": message over ${cap} characters without a line end — server ended`));
      this.close();
    }
  }

  // Answer server→client requests (sampling/createMessage, roots/list) — a server waiting for an answer would hang.
  async _serve(msg) {
    let result = null;
    let error = null;
    try {
      if (!this.onServerRequest) throw new Error("Method not supported");
      result = await this.onServerRequest(msg.method, msg.params || {}, this.name);
      if (result == null) throw new Error(`Method not supported: ${msg.method}`);
    } catch (e) {
      error = { code: -32601, message: String(e?.message || e) };
    }
    try { this._send(error ? { jsonrpc: "2.0", id: msg.id, error } : { jsonrpc: "2.0", id: msg.id, result }); } catch { /* connection gone */ }
  }

  _send(msg) {
    if (this.closed || !this.child) throw new Error(`MCP "${this.name}" not connected`);
    // If stdin accepts nothing any more, that is a REGULAR error of this call — `_request` rejects at once with it
    // instead of waiting for a time limit. A later, asynchronous EPIPE has no consequence: the helper's error handler
    // catches it, and the child's `close` clears every open request via `_fail`.
    if (!writeStdin(this.child, JSON.stringify(msg) + "\n")) throw new Error(`MCP "${this.name}" accepts no more input`);
  }
  _notify(method, params) { try { this._send({ jsonrpc: "2.0", method, params }); } catch { /* does not matter */ } }
  _request(method, params, timeoutMs = CALL_TIMEOUT) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`MCP "${this.name}" ${method} timeout`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this._send({ jsonrpc: "2.0", id, method, params }); }
      catch (e) { this.pending.delete(id); clearTimeout(timer); reject(e); }
    });
  }
  _fail(err) {
    for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(err); }
    this.pending.clear();
  }

  async listTools() {
    return allPages((params) => this._request("tools/list", params, LIST_TIMEOUT));
  }
  async callTool(name, args, meta) {
    return this._request("tools/call", { name, arguments: args || {}, ...(meta ? { _meta: meta } : {}) }, callTimeoutOf(this.def));
  }
  // Resources and prompts: with tools/list alone, servers that offer files, documentation or ready-made prompts would
  // be half invisible.
  async listResources() {
    const res = await this._request("resources/list", {}, LIST_TIMEOUT);
    return Array.isArray(res?.resources) ? res.resources : [];
  }
  async readResource(uri) { return this._request("resources/read", { uri }, CALL_TIMEOUT); }
  async listPrompts() {
    const res = await this._request("prompts/list", {}, LIST_TIMEOUT);
    return Array.isArray(res?.prompts) ? res.prompts : [];
  }
  async getPrompt(name, args) { return this._request("prompts/get", { name, arguments: args || {} }, CALL_TIMEOUT); }
  close() {
    this.closed = true;
    closeStdin(this.child);
    try { this.child?.kill("SIGTERM"); } catch {}
  }
}

// ── http/sse transport (Streamable HTTP, best effort) ────────────────────────────
class HttpClient {
  constructor(name, def, { instance = null } = {}) {
    this.name = name;
    // Without `def` callTimeoutOf would never read the field `timeout` — an HTTP MCP server would always get 120 s.
    this.def = def;
    // The run's instance (null = in the backend). Not a start place — the wording deliberately differs from that of
    // the StdioClient, which in-project-start-places.test.js expects as an edge exactly once.
    this.instance = instance ?? null;
    this.url = def.url;
    this.headers = def.headers || {};
    this.sessionId = null;
    this.nextId = 1;
  }
  async _rpc(method, params, timeoutMs = CALL_TIMEOUT) {
    if (!this.url) throw new Error(`MCP "${this.name}": no url`);
    const id = this.nextId++;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...this.headers };
      if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
      const init = { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }), signal: ctrl.signal };
      const cap = rowsCap();
      const res = await (this.instance ? requestInProject(this.url, { ...init, maxBytes: cap + 1 }, this.instance) : fetch(this.url, init));
      const sid = res.headers.get("mcp-session-id");
      if (sid) this.sessionId = sid;
      const ct = res.headers.get("content-type") || "";
      const text = await bodyWithCap(res, cap, this.name); // never a body without bound
      let msg = null;
      if (ct.includes("text/event-stream")) {
        // SSE: take the last data: line with a matching id.
        for (const line of text.split("\n")) {
          const t = line.trim();
          if (!t.startsWith("data:")) continue;
          try { const j = JSON.parse(t.slice(5).trim()); if (j.id === id || j.result || j.error) msg = j; } catch {}
        }
      } else if (text) {
        try { msg = JSON.parse(text); } catch {}
      }
      if (!msg) { if (method.startsWith("notifications/")) return null; throw new Error(`MCP "${this.name}" ${method}: no JSON-RPC response`); }
      if (msg.error) throw new Error(msg.error.message || `JSON-RPC ${msg.error.code}`);
      return msg.result;
    } finally { clearTimeout(timer); }
  }
  async start() {
    await this._rpc("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO }, INIT_TIMEOUT);
    try { await this._rpc("notifications/initialized", undefined, 5000); } catch { /* a notification needs no answer */ }
  }
  async listTools() { return allPages((params) => this._rpc("tools/list", params, LIST_TIMEOUT)); }
  async callTool(name, args, meta) { return this._rpc("tools/call", { name, arguments: args || {}, ...(meta ? { _meta: meta } : {}) }, callTimeoutOf(this.def)); }
  async listResources() { const r = await this._rpc("resources/list", {}, LIST_TIMEOUT); return Array.isArray(r?.resources) ? r.resources : []; }
  async readResource(uri) { return this._rpc("resources/read", { uri }, CALL_TIMEOUT); }
  async listPrompts() { const r = await this._rpc("prompts/list", {}, LIST_TIMEOUT); return Array.isArray(r?.prompts) ? r.prompts : []; }
  async getPrompt(name, args) { return this._rpc("prompts/get", { name, arguments: args || {} }, CALL_TIMEOUT); }
  close() { /* stateless */ }
}

// Also for loading the tools of a coding server (toolchain/mcp-load.js): ONE client, no pool.
export function makeClient(name, def, opts) {
  const type = def?.type;
  if (type === "http" || type === "sse") return new HttpClient(name, def, opts);
  return new StdioClient(name, def, opts);
}

// ── Pool: connect all servers, aggregate tools (mcp__<server>__<tool>) ────────────
/**
 * @param {Object} serversMap  { name: {command,args,env} | {type:'http'|'sse',url,headers} }
 * @returns {Promise<{tools:Array, call:Function, closeAll:Function, errors:Array}>}
 */
export async function connectMcpServers(serversMap, { cwd, instance = null, onServerRequest } = {}) {
  const clients = new Map();
  const toolIndex = new Map(); // mcp__server__tool → { client, toolName }
  const tools = [];
  const resources = [];   // { server, uri, name, description, mimeType }
  const prompts = [];     // { server, name, description, arguments }
  const errors = [];
  for (const [name, def] of Object.entries(serversMap || {})) {
    if (!def) continue;
    const client = makeClient(name, def, { cwd, instance, onServerRequest });
    try {
      await client.start();
      const list = await client.listTools();
      clients.set(name, client);
      // `enabledTools` on the server entry (the individually approved tools of a foreign server for a subagent)
      // applies here as with Codex (`enabled_tools`): only the named tools exist, an empty list locks the server
      // entirely.
      const onlyThis = Array.isArray(def.enabledTools) ? new Set(def.enabledTools.map(String)) : null;
      for (const t of list) {
        if (!t?.name) continue;
        if (onlyThis && !onlyThis.has(String(t.name))) continue;
        const full = `mcp__${name}__${t.name}`;
        // annotations (readOnlyHint & co.) stay on: they mark what writes.
        tools.push({ name: full, description: t.description || "", inputSchema: t.inputSchema || { type: "object", properties: {} }, annotations: t.annotations && typeof t.annotations === "object" ? t.annotations : null });
        toolIndex.set(full, { client, toolName: t.name });
      }
      // Resources/prompts are optional — a server that does not offer them answers with "Method not found". That is
      // not a connection error and must not exclude the server.
      try { for (const r of await client.listResources()) if (r?.uri) resources.push({ server: name, uri: r.uri, name: r.name || r.uri, description: r.description || "", mimeType: r.mimeType || "" }); } catch { /* no resources support */ }
      try { for (const pr of await client.listPrompts()) if (pr?.name) prompts.push({ server: name, name: pr.name, description: pr.description || "", arguments: pr.arguments || [] }); } catch { /* no prompts support */ }
    } catch (e) {
      errors.push({ server: name, error: e.message || String(e) });
      try { client.close(); } catch {}
    }
  }
  return {
    tools,
    resources,
    prompts,
    errors,
    hasTool: (full) => toolIndex.has(full),
    // `meta` goes out as the request's `_meta` (the engine passes its call id there).
    async call(full, args, meta) {
      const hit = toolIndex.get(full);
      if (!hit) return { content: [{ type: "text", text: `Unknown MCP tool: ${full}` }], isError: true };
      try { return await hit.client.callTool(hit.toolName, args, meta); }
      catch (e) { return { content: [{ type: "text", text: `MCP error (${full}): ${e.message || e}` }], isError: true }; }
    },
    async readResource(server, uri) {
      const c = clients.get(server);
      if (!c) throw new Error(`Unknown MCP server: ${server}`);
      return c.readResource(uri);
    },
    async getPrompt(server, name, args) {
      const c = clients.get(server);
      if (!c) throw new Error(`Unknown MCP server: ${server}`);
      return c.getPrompt(name, args);
    },
    closeAll() { for (const c of clients.values()) { try { c.close(); } catch {} } },
  };
}

// Content of a resources/read result as neutral blocks (text stays text, images images).
export function mcpResourceBlocks(result) {
  const blocks = [];
  for (const c of result?.contents || []) {
    if (typeof c?.text === "string") blocks.push({ type: "text", text: `[${c.uri || ""}]\n${c.text}` });
    else if (c?.blob && /^image\//.test(c.mimeType || "")) blocks.push({ type: "image", source: { type: "base64", media_type: c.mimeType, data: c.blob } });
    else if (c?.blob) blocks.push({ type: "text", text: `[${c.uri || ""}] binary data (${c.mimeType || "unknown"}, ${String(c.blob).length} base64 characters)` });
  }
  return blocks.length ? blocks : [{ type: "text", text: "(empty resource)" }];
}

// Extracts plain text from an MCP tools/call result (content[]) for tool_result events.
export function mcpResultText(result) {
  if (!result) return "";
  if (Array.isArray(result.content)) {
    return result.content.map((c) => {
      if (typeof c === "string") return c;
      if (c?.type === "text") return c.text || "";
      if (c?.type === "image") return "[Image]";
      return typeof c?.text === "string" ? c.text : JSON.stringify(c);
    }).join("\n");
  }
  if (result.structuredContent) return JSON.stringify(result.structuredContent);
  return typeof result === "string" ? result : JSON.stringify(result);
}

// The same result as NEUTRAL BLOCKS — text stays text, images stay images. mcpResultText folds every image to
// "[Image]": a Playwright screenshot would never reach a vision-capable model that way. The engine passes these blocks
// on directly as tool_result content (and folds them only if the provider cannot take images).
export function mcpResultBlocks(result) {
  const blocks = [];
  const pushText = (t) => { const s = String(t ?? ""); if (s) blocks.push({ type: "text", text: s }); };
  const pushImage = (data, mime) => {
    if (!data) return;
    blocks.push({ type: "image", source: { type: "base64", media_type: mime || "image/png", data: String(data) } });
  };
  if (!result) return blocks;
  if (Array.isArray(result.content)) {
    for (const c of result.content) {
      if (typeof c === "string") { pushText(c); continue; }
      if (c?.type === "text") { pushText(c.text); continue; }
      if (c?.type === "image") { pushImage(c.data, c.mimeType); continue; }
      // Embedded resource: images as an image, everything else as text.
      if (c?.type === "resource" && c.resource) {
        const r = c.resource;
        if (r.blob && /^image\//.test(r.mimeType || "")) pushImage(r.blob, r.mimeType);
        else pushText(r.text ?? `[Resource ${r.uri || ""}]`);
        continue;
      }
      pushText(typeof c?.text === "string" ? c.text : JSON.stringify(c));
    }
  } else if (result.structuredContent) {
    pushText(JSON.stringify(result.structuredContent));
  } else {
    pushText(typeof result === "string" ? result : JSON.stringify(result));
  }
  return blocks;
}
