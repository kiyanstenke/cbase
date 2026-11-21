// The routes of the coding MCP airlock: the way of the wrapper `mcp/airlock.js` into the backend. Sub-slice of `chatRoutes`
// (chats/routes.js), fence row "chat-mcp-airlock".
//
//   GET  /api/chats/:chat/mcp-airlock/:server/start   stdio: {transport, command, args, env} of the real server; http: {transport}
//   POST /api/chats/:chat/mcp-airlock/:server/list    {tools} (raw tools/list response of the child) ⇒ update the cache, {tools} filtered
//   POST /api/chats/:chat/mcp-airlock/:server/call    {name, arguments} ⇒ stream, last line {free, arguments} | {free: false, text}
//   POST /api/chats/:chat/mcp-airlock/:server/rpc     http/sse: {message, session} ⇒ stream, last line {messages, session}
//
// Every request carries the run token (`x-cbase-airlock`, toolchain/airlock-token.js); it must match the chat in the path
// (otherwise 401). Checked live on EVERY request: is the server in the chat's set NOW (`effectiveMcpServers` with the run's
// project), may the role have it (subagent/workflow agent only with `subagentsInherit` or brought by the agent type — token
// fields `codingChoice`/`fromType`, toolchain/agent-mcp.js —, an outer-loop run only within its agent's choice), and what does
// the choice say (`verdict`)? A mark shows main agent and subagents a card; workflow agent and outer loop get a sentence
// instead of a card (no human in the run).
//
// call and rpc answer as a STREAM (NDJSON): headers at once, then an empty line every HEARTBEAT_MS, finally ONE line of JSON.
// A card stays open up to CARDS_DEADLINE_MS; without early headers the wrapper's fetch would abort after 300 s (headersTimeout).
// If the wrapper closes the connection (CLI abort, stop, provider deadline — none of the CLIs sends notifications/cancelled on
// a stop; the wrapper sees the stdin end or the signal and aborts its requests), the route declines the open card and NEVER
// forwards afterwards.
//
// Headers never leave the backend: they appear only in the request to the real server (`realEntry`), never in a response of
// these routes.

import * as store from "../store.js";
import { NEXT, readBody, send } from "../runtime/http.js";
import { requestInProject } from "../runtime/target.js";
import { requestPermission } from "../runs/permissions.js";
import { agentAsOwner } from "../runs/agents.js";
import { instanceFromIdentifier } from "../runs/instance.js";
import { mcpServerToConfigEntry } from "./mcp-config.js";
import { realEntry, carryForwardTools } from "./mcp-load.js";
import { filtered, verdict } from "./mcp-tools.js";
import { checkToken } from "./airlock-token.js";
import * as texts from "./airlock-texts.js";

// Below the providers' call timeout (MCP_CALL_TIMEOUT_MS = 660 s; Claude sends notifications/cancelled "Request timed out" at
// 660 s, Codex reports "timed out awaiting tools/call after 660s") — so the model gets a sentence instead of a timeout.
export const CARDS_DEADLINE_MS = () => Number(process.env.CBASE_AIRLOCK_DEADLINE_MS) || 600_000;
const HEARTBEAT_MS = () => Number(process.env.CBASE_AIRLOCK_HEARTBEAT_MS) || 20_000;
const BODY_MAX = 64 * 1024 * 1024;
const PAGES_MAX = 50;
export const AIRLOCK_HEADER = "x-cbase-airlock";

/** Run token, set and role — `{status}` (401), `{entry, server, not}` (rejection with text) or `{entry, server}`. */
export function airlockSituation(chatId, token, serverId) {
  const entry = checkToken(token);
  if (!entry || entry.chatId !== chatId) return { status: 401 };
  const server = store.getMcpServerInternal(serverId);
  const name = server?.name || String(serverId);
  let inSet = false;
  try { inSet = Boolean(server?.enabled) && store.effectiveMcpServers(entry.workspaceId, entry.setProject).some((s) => s.id === server.id); }
  catch { inSet = false; }
  if (!inSet) return { entry, server, not: texts.notActive(name) };
  // An outer-loop run: not "Subagents inherit" decides but the choice of ITS agent — read live, per server the list of tools
  // (`olChoice`).
  if (entry.role === "outer_loop") {
    const choice = store.outerLoopAgent(entry.outerLoopAgent)?.mcp?.[server.id];
    if (!Array.isArray(choice) || !choice.length) return { entry, server, not: texts.outerLoopNotSelected("", name) };
    return { entry, server, olChoice: choice };
  }
  if (entry.role !== "main") {
    // Subagent/workflow agent: a server its set does not name (runs/agent-set.js codingSet) it does not have; one brought by
    // the agent type also without "Subagents inherit" (toolchain/agent-mcp.js), any other only with the toggle — which applies live.
    const cw = entry.codingChoice;
    if (cw && !Object.hasOwn(cw, server.id)) return { entry, server, not: texts.onlyMain(name, entry.role) };
    if (!(entry.fromType || []).includes(server.id) && !server.subagentsInherit) return { entry, server, not: texts.onlyMain(name, entry.role) };
    // A tool list of its set cuts in addition to the choice at the server (`typeChoice`).
    if (cw && Array.isArray(cw[server.id])) return { entry, server, typeChoice: cw[server.id] };
  }
  return { entry, server };
}

/**
 * What the wrapper passes on from a tools/list: without locked tools (filtered) — for an outer-loop run also only its agent's
 * choice and nothing marked (its run cannot show a card; outerloop/set.js names the same ones as omitted).
 */
export function offering(situation, server, tools) {
  const free = filtered(server, tools);
  if (situation.typeChoice) return free.filter((w) => situation.typeChoice.includes(w?.name));
  if (!situation.olChoice) return free;
  return free.filter((w) => situation.olChoice.includes(w?.name) && verdict(server, w.name) === "free");
}

/**
 * The verdict on ONE call — `{free: true, arguments}` or `{free: false, text}`. With a mark it holds a card open (owner live);
 * a workflow agent gets none. `signal` aborts the card (requestPermission declines it).
 */
export async function verdictsCall(situation, name, args, signal) {
  const { entry, server } = situation;
  if (situation.not) return { free: false, text: situation.not };
  // A tool outside the server's choice — locked for every role, with its own sentence.
  const u = verdict(server, name);
  if (u === "locked") return { free: false, text: texts.notSelected(name, server.name) };
  if (situation.olChoice && !situation.olChoice.includes(name)) return { free: false, text: texts.outerLoopNotSelected(name, server.name) };
  if (situation.typeChoice && !situation.typeChoice.includes(name)) return { free: false, text: texts.typeNotSelected(name, server.name) };
  if (u === "free") return { free: true, arguments: args };
  if (entry.role === "workflow") return { free: false, text: texts.workflowMarker() };
  if (entry.role === "outer_loop") return { free: false, text: texts.outerLoopMarker() };
  const w = (server.tools || []).find((x) => x.name === name);
  // The card ends at the wrapper's abort OR at its deadline — the deadline applies only here, not to a long free call.
  const card = new AbortController();
  const further = () => card.abort(signal.reason);
  if (signal?.aborted) further();
  else signal?.addEventListener("abort", further, { once: true });
  const clock = setTimeout(() => card.abort(Object.assign(new Error(texts.cardsDeadline(Math.round(CARDS_DEADLINE_MS() / 60_000))), { deadline: true })), CARDS_DEADLINE_MS());
  let decision;
  try {
    decision = await requestPermission(entry.chatId, {
      toolName: `mcp__${server.name}__${name}`, input: args,
      agent: entry.role === "main" ? null : agentAsOwner(entry.chatId, entry.agentId),
      airlock: { server: server.name, tool: name, description: w?.description || "", writing: w?.writing ?? null },
      signal: card.signal,
    });
  } finally {
    clearTimeout(clock);
    signal?.removeEventListener("abort", further);
  }
  if (card.signal.aborted) return { free: false, text: String(card.signal.reason?.message || texts.cardsAbort()), aborted: card.signal.reason?.deadline !== true };
  if (decision?.behavior !== "allow") return { free: false, text: String(decision?.message || "Declined by the user") };
  return { free: true, arguments: decision.updatedInput && typeof decision.updatedInput === "object" ? decision.updatedInput : args };
}

// The stream of a holding response: headers at once, heartbeat, one final line. `signal` aborts when the wrapper leaves
// (res "close" before the end).
function holdingStream(res) {
  const ac = new AbortController();
  res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" });
  const heart = setInterval(() => { try { res.write("\n"); } catch { /* closed */ } }, HEARTBEAT_MS());
  res.on("close", () => {
    clearInterval(heart);
    if (!res.writableFinished && !ac.signal.aborted) ac.abort(new Error(texts.cardsAbort()));
  });
  return {
    signal: ac.signal,
    end(obj) {
      clearInterval(heart);
      if (!res.writableEnded && !res.destroyed) res.end(JSON.stringify(obj) + "\n");
    },
  };
}

// Read the body of a response, at most `max` bytes (otherwise an error that says it was a cap).
async function body(res, max) {
  if (!res.body || typeof res.body.getReader !== "function") return await res.text();
  const reader = res.body.getReader();
  const parts = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > max) { try { await reader.cancel(); } catch { /* ignore */ } throw new Error(`Response over ${max} bytes — aborted`); }
    parts.push(value);
  }
  return Buffer.concat(parts.map((t) => Buffer.from(t))).toString("utf8");
}

// SSE body ⇒ JSON-RPC messages (per event the data: lines, joined with "\n").
export function sseMessages(text) {
  const out = [];
  for (const block of String(text).split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter((z) => z.startsWith("data:")).map((z) => z.slice(5).replace(/^ /, ""));
    if (!data.length) continue;
    try { const j = JSON.parse(data.join("\n")); out.push(...(Array.isArray(j) ? j : [j])); } catch { /* not JSON — skip */ }
  }
  return out;
}

// One JSON-RPC message to the real http server (Streamable HTTP), with its headers — from the namespace of the run's instance,
// otherwise from B. ⇒ { messages, session }.
async function toTheServer(server, entry, message, session, signal) {
  const def = realEntry(server);
  if (!def?.url) throw new Error(`MCP "${server.name}": no url`);
  const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(def.headers || {}) };
  if (session) headers["mcp-session-id"] = session;
  const init = { method: "POST", headers, body: JSON.stringify(message), signal };
  let inst = null;
  if (entry.instance) {
    inst = instanceFromIdentifier(entry.instance);
    if (!inst) throw new Error(texts.instanceGone(server.name));
  }
  const res = await (inst ? requestInProject(def.url, { ...init, maxBytes: BODY_MAX + 1 }, inst) : fetch(def.url, init));
  const fresh = res.headers.get("mcp-session-id") || session || "";
  const text = await body(res, BODY_MAX);
  if (!res.ok && res.status !== 202) throw new Error(`MCP "${server.name}": HTTP ${res.status}${text ? ` — ${text.slice(0, 300)}` : ""}`);
  const ct = res.headers.get("content-type") || "";
  let messages = [];
  if (ct.includes("text/event-stream")) messages = sseMessages(text);
  else if (text.trim()) {
    try { const j = JSON.parse(text); messages = Array.isArray(j) ? j : [j]; }
    catch { throw new Error(`MCP "${server.name}": not a JSON-RPC response`); }
  }
  return { messages, session: fresh };
}

const isRequest = (n) => n && typeof n === "object" && typeof n.method === "string" && n.id !== undefined && n.id !== null;
const errorFor = (id, text) => ({ jsonrpc: "2.0", id, error: { code: -32603, message: String(text) } });
const denialTo = (id, text) => ({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: String(text) }], isError: true } });

// tools/list across all pages: the cache gets the WHOLE list (one page would mean "the rest has disappeared"), the wrapper ONE
// response without nextCursor.
async function rpcList(situation, message, session, signal) {
  const { entry, server } = situation;
  if (situation.not) return { messages: [{ jsonrpc: "2.0", id: message.id, result: { tools: [] } }], session };
  const all = [];
  const onTheSide = [];
  let cursor = message.params?.cursor;
  let last = null;
  for (let page = 0; page < PAGES_MAX; page++) {
    const r = await toTheServer(server, entry, { jsonrpc: "2.0", id: message.id, method: "tools/list", params: { ...(message.params || {}), ...(cursor ? { cursor } : {}) } }, session, signal);
    session = r.session;
    last = r.messages.find((n) => n.id === message.id && (n.result || n.error)) || null;
    onTheSide.push(...r.messages.filter((n) => n !== last));
    if (!last || last.error) return { messages: [...onTheSide, last || errorFor(message.id, `MCP "${server.name}" tools/list: no response`)], session };
    all.push(...(Array.isArray(last.result?.tools) ? last.result.tools : []));
    cursor = last.result?.nextCursor;
    if (!cursor) break;
  }
  const to = carryForwardTools(server.id, all) || server;
  const { nextCursor: _dropped, ...rest } = last.result || {};
  return { messages: [...onTheSide, { jsonrpc: "2.0", id: message.id, result: { ...rest, tools: offering(situation, to, all) } }], session };
}

export async function airlockChatRoutes(ctx) {
  const { req, res, url, p, m, id, sub, chat } = ctx;
  const t = /^\/mcp-airlock\/([^/]+)\/(start|list|call|rpc)$/.exec(sub);
  if (t) return airlockRequest(req, res, m, id, decodeURIComponent(t[1]), t[2]);
  return NEXT;
}

async function airlockRequest(req, res, m, id, serverId, kind) {
  if ((kind === "start") !== (m === "GET") || (m !== "GET" && m !== "POST")) return send(res, 405, { error: "method not allowed" });
  const situation = airlockSituation(id, String(req.headers[AIRLOCK_HEADER] || ""), serverId);
  if (situation.status) return send(res, situation.status, { error: "airlock: unknown or expired run token" });
  const { server } = situation;

  if (kind === "start") {
    if (situation.not) return send(res, 410, { error: situation.not });
    if (server.transport === "http" || server.transport === "sse") return send(res, 200, { transport: server.transport });
    const e = mcpServerToConfigEntry(server);
    if (!e) return send(res, 410, { error: texts.notActive(server.name) });
    return send(res, 200, { transport: "stdio", command: e.command, args: e.args || [], env: e.env || {} });
  }

  const b = await readBody(req);
  if (kind === "list") {
    // Only the wrapper of a STDIO server supplies its list; that of an http server is loaded by B itself (rpcList,
    // loadMcpTools) — a run holding the airlock token must not write the cache of a server it does not wrap.
    if (server.transport === "http" || server.transport === "sse") return send(res, 400, { error: texts.listOnlyStdio(server.name) });
    if (!Array.isArray(b?.tools)) return send(res, 400, { error: "tools must be a list" });
    const tools = b.tools.filter((w) => w && typeof w === "object" && typeof w.name === "string" && w.name);
    if (situation.not) return send(res, 200, { tools: [] });
    const to = carryForwardTools(server.id, tools) || server;
    return send(res, 200, { tools: offering(situation, to, tools) });
  }

  if (kind === "call") {
    const name = typeof b?.name === "string" ? b.name : "";
    if (!name) return send(res, 400, { error: "name is missing" });
    const args = b.arguments && typeof b.arguments === "object" && !Array.isArray(b.arguments) ? b.arguments : {};
    const stream = holdingStream(res);
    const r = await verdictsCall(situation, name, args, stream.signal);
    stream.end(r.free ? { free: true, arguments: r.arguments } : { free: false, text: r.text });
    return;
  }

  // rpc: only for http/sse servers.
  if (server.transport !== "http" && server.transport !== "sse") return send(res, 400, { error: "rpc only for http/sse" });
  const message = b?.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) return send(res, 400, { error: "message is missing" });
  let session = typeof b.session === "string" ? b.session : "";
  const stream = holdingStream(res);
  try {
    if (isRequest(message) && message.method === "tools/list") {
      stream.end(await rpcList(situation, message, session, stream.signal));
      return;
    }
    if (isRequest(message) && message.method === "tools/call") {
      const name = String(message.params?.name || "");
      const args = message.params?.arguments && typeof message.params.arguments === "object" ? message.params.arguments : {};
      const r = await verdictsCall(situation, name, args, stream.signal);
      // Aborted ⇒ forward nothing, not even after a late yes.
      if (stream.signal.aborted) return stream.end({ messages: [], session });
      if (!r.free) return stream.end({ messages: [denialTo(message.id, r.text)], session });
      const w = await toTheServer(server, situation.entry, { ...message, params: { ...message.params, arguments: r.arguments } }, session, stream.signal);
      return stream.end(w);
    }
    // Everything else (initialize, notifications, resources/*, prompts/*, ping, responses to server requests) passes through
    // as long as the server is in the run.
    if (situation.not) return stream.end({ messages: isRequest(message) ? [errorFor(message.id, situation.not)] : [], session });
    stream.end(await toTheServer(server, situation.entry, message, session, stream.signal));
  } catch (e) {
    const text = String(e?.message || e).slice(0, 500);
    stream.end({ messages: isRequest(message) ? [errorFor(message.id, text)] : [], session });
  }
}
