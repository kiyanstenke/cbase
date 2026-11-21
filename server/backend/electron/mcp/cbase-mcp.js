#!/usr/bin/env node
// cbase MCP server (stdio, JSON-RPC 2.0). Gives Claude Code typed tools for project context, chat-bound artifacts, ports and
// workspace context instead of curl instructions. Talks to the local cbase API (127.0.0.1:7718); the project is resolved from
// CBASE_PROJECT_ID (injected by the app) or the cwd.
// This file is only the entry point: TOOLS is built from the groups under tools/ by spread, in a fixed order; the helpers live
// in lib.js, the sets in toolsets.js; visibility (VISIBLE_TOOLS, TOOL_MAP) and JSON-RPC stay here. The file is started by its
// PATH (MCP_SCRIPT in app-state.js; tests spawn it), never imported.

import process from "node:process";
import { SERVER_INFO, FENCE_HINT, runEnvironment, withFenceMarker, setRunEnvironment } from "./lib.js";
// The catalog (the tool groups in a fixed order) lives in catalog.js; the server reads its names too.
import { TOOLS } from "./catalog.js";
// What a run is offered is ONE computation over its environment (offering.js — the stages and their reasons are there): the
// server runs the same function for the name list in the prefix of a Codex run
// (server/providers/connectors/codex-prefix.js), so the description side is the execution side.
import { offeringNames } from "./offering.js";

const OFFERING = new Set(offeringNames(process.env));
const VISIBLE_TOOLS = TOOLS.filter((t) => OFFERING.has(t.name));

const TOOL_MAP = new Map(VISIBLE_TOOLS.map((t) => [t.name, t]));
// The description follows the execution: a tool may carry `description` and `inputSchema` as a FUNCTION of the run environment
// (lib.js runEnvironment: depth, workflow marker, write access to chats, schedule run), evaluated at tools/list. Only this filter
// knows whether cbase_agent is in the offered set.
setRunEnvironment({ withAgent: TOOL_MAP.has("cbase_agent") });
const evaluate = (field) => (typeof field === "function" ? field(runEnvironment()) : field);

// ── JSON-RPC over stdio (newline-delimited) ─────────────────────────────────
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\n"); }
function reply(id, result) { send({ jsonrpc: "2.0", id, result }); }
function replyError(id, code, message) { send({ jsonrpc: "2.0", id, error: { code, message } }); }

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    return reply(id, {
      protocolVersion: params?.protocolVersion || "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
  }
  if (method === "notifications/initialized" || method === "notifications/cancelled") return; // no reply
  if (method === "ping") return reply(id, {});
  if (method === "tools/list") {
    return reply(id, { tools: VISIBLE_TOOLS.map((t) => ({ name: t.name, description: evaluate(t.description), inputSchema: evaluate(t.inputSchema) })) });
  }
  if (method === "tools/call") {
    // TOOL_MAP knows only the visible tools: a resumed run (--resume) that remembers a name from an earlier, wider toolset
    // is stopped here instead of getting through.
    const tool = TOOL_MAP.get(params?.name);
    if (!tool) return reply(id, { content: [{ type: "text", text: `Unknown tool: ${params?.name}` }], isError: true });
    // The fence marker: if a backend response in THIS call carried the header `x-cbase-fenced: 1` (lib.js api), a second text
    // block is appended after the result; the body itself stays as it is. Without a token (every run outside a project
    // container) no backend sets the header.
    const fence = (response, fenced) => (fenced ? { ...response, content: [...response.content, { type: "text", text: FENCE_HINT }] } : response);
    let fenced = false;
    try {
      // `_meta` of the request as second argument: the call id of a cbase_agent start is in it.
      const run = await withFenceMarker(async () => {
        try { return { result: await tool.handler(params.arguments || {}, params._meta && typeof params._meta === "object" ? params._meta : {}) }; }
        catch (error) { return { error }; }
      });
      fenced = run.fenced;
      if (run.result.error) throw run.result.error;
      const result = run.result.result;
      // Two markers a handler can attach to its result; neither goes out:
      //   __content = finished MCP blocks (images!), passed through 1:1 instead of folded into JSON.
      //   __isError = the result is an ERROR result (isError:true) although the handler did not throw (see agentReport):
      //               a failed subagent whose report the route returns with 201 must not reach the main agent as a success.
      const obj = result && typeof result === "object" && !Array.isArray(result) ? result : null;
      const isError = obj?.__isError === true;
      let content;
      if (obj && Array.isArray(obj.__content)) content = obj.__content;
      else if (obj) { const { __isError: _marker, ...rest } = obj; content = [{ type: "text", text: JSON.stringify(rest, null, 2) }]; }
      else content = [{ type: "text", text: JSON.stringify(result, null, 2) }];
      return reply(id, fence(isError ? { content, isError: true } : { content }, fenced));
    } catch (e) {
      return reply(id, fence({ content: [{ type: "text", text: `Error: ${e.message || e}` }], isError: true }, fenced));
    }
  }
  if (id !== undefined) replyError(id, -32601, `Method not supported: ${method}`);
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    handle(msg).catch((e) => { if (msg && msg.id !== undefined) replyError(msg.id, -32603, String(e.message || e)); });
  }
});
process.stdin.on("end", () => process.exit(0));
