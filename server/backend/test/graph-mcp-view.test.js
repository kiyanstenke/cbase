// Graph workflows over MCP: cbase_workflow_start / _status / _stop belong to the MAIN AGENT of a Coding chat — on every provider,
// because all three run the same MCP server. Subagents of any depth (visibility.js alwaysLocked), workflow agents (marker
// CBASE_WORKFLOW_AGENT, family "cbase_workflow") and an explicit list from the tool catalog of the agent choice (toolchain/
// tool-catalog.js) do not see them. Measured by spawn against the real MCP server, as the app starts it.
//
// Plus the handlers on the wire: against a fake cbase server (node:http) — path, method and body of every call, `background`/
// `worktree` only on an explicit true, the call id from `_meta`, `from: "agent"` on stop, and without CBASE_CHAT_ID an error instead
// of a call.
//
// Counter-tests (each shown red once):
//   · the three names taken out of `alwaysLocked` => "depth 1 sees cbase_workflow_start".
//   · "cbase_workflow" taken out of WORKFLOW_AGENT_FAMILIES => "workflow agent sees cbase_workflow_start".
//   · `background: a.background === true` replaced by `!!a.background` => red at the body with background: "yes".
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { AGENT_DEPTH_MAX, lockedForDepth, lockedForWorkflowAgent } from "../electron/mcp/visibility.js";
import { CODING_TOOLS } from "../electron/server/toolchain/tool-catalog.js";

const MCP_SCRIPT = fileURLToPath(new URL("../electron/mcp/cbase-mcp.js", import.meta.url));
const GRAPH = ["cbase_workflow_start", "cbase_workflow_status", "cbase_workflow_stop"];

// An MCP server with this environment; `calls(method, params)` sends a request and waits for its answer.
function mcpServer(env) {
  const child = spawn(process.execPath, [MCP_SCRIPT], {
    env: { ...process.env, CBASE_TOOLS: undefined, CBASE_TOOLSET: undefined, CBASE_SKILLS: undefined, CBASE_AGENT_DEPTH: undefined,
      CBASE_WORKFLOW_AGENT: undefined, CBASE_SCHEMA: undefined, CBASE_BASE_URL: "http://127.0.0.1:1", CBASE_CHAT_ID: "c-graph", ...env },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const open = new Map();
  let buf = "";
  let next = 1;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const z = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      let m; try { m = JSON.parse(z); } catch { continue; }
      const w = open.get(m.id);
      if (w) { open.delete(m.id); w(m); }
    }
  });
  const calls = (method, params = {}) => new Promise((resolve) => {
    const id = next++;
    open.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const end = () => { child.stdin.end(); child.kill(); };
  return { calls, end };
}

async function view(env) {
  const s = mcpServer(env);
  try {
    await s.calls("initialize", {});
    return (await s.calls("tools/list")).result.tools;
  } finally { s.end(); }
}

test("visibility: the main agent (depth 0) has all three, no subagent of any depth, no workflow agent, no list from the catalog", async () => {
  const main = await view({});
  const names = main.map((t) => t.name);
  for (const n of GRAPH) assert.ok(names.includes(n), `depth 0 does not see ${n}`);
  // At the end of the catalog, in this order (prompt prefix; the full order is held by mcp-catalog.test.js) — only the agenda group
  // stands behind them.
  assert.deepEqual(names.slice(-5, -2), GRAPH);
  assert.deepEqual(names.slice(-2), ["cbase_agenda", "cbase_agenda_write"]);

  for (let t = 1; t <= AGENT_DEPTH_MAX; t++) {
    const sub = (await view({ CBASE_AGENT_DEPTH: String(t) })).map((x) => x.name);
    for (const n of GRAPH) {
      assert.ok(!sub.includes(n), `depth ${t} sees ${n}`);
      assert.equal(lockedForDepth(n, t), true);
    }
  }

  const wfAgent = (await view({ CBASE_WORKFLOW_AGENT: "x" })).map((x) => x.name);
  for (const n of GRAPH) {
    assert.ok(!wfAgent.includes(n), `workflow agent sees ${n}`);
    assert.equal(lockedForWorkflowAgent(n), true);
  }
  // The family hits nothing a workflow agent had before: its set loses exactly the three.
  const prior = names.filter((n) => !GRAPH.includes(n) && !lockedForWorkflowAgent(n));
  assert.deepEqual(wfAgent, prior);

  // The tool catalog of the agent choice does not know the names — even a list from the whole catalog shows none.
  for (const n of GRAPH) assert.ok(!CODING_TOOLS.includes(n), `${n} is in the catalog of the agent choice`);
  const selected = (await view({ CBASE_TOOLS: JSON.stringify(CODING_TOOLS) })).map((x) => x.name);
  assert.ok(selected.includes("cbase_agents_list"), "the list does not take effect — otherwise this part checks nothing");
  for (const n of GRAPH) assert.ok(!selected.includes(n), `a list from the catalog sees ${n}`);
});

test("schema: start requires workflow, input at most 16,000 characters, no foreign fields; stop requires startId", async () => {
  const tools = await view({});
  const start = tools.find((t) => t.name === "cbase_workflow_start");
  assert.deepEqual(start.inputSchema.required, ["workflow"]);
  assert.equal(start.inputSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(start.inputSchema.properties), ["workflow", "input", "background", "worktree"]);
  assert.equal(start.inputSchema.properties.input.maxLength, 16000);
  assert.equal(start.inputSchema.properties.background.type, "boolean");
  assert.equal(start.inputSchema.properties.worktree.type, "boolean");
  // The load-bearing sentences of the description (the model starts only on announcement, and in the foreground its turn ends).
  assert.match(start.description, /ONLY if the human announced it in their message of this turn with \/workflow:<shortname>/);
  assert.match(start.description, /end it with one line/);
  assert.match(start.description, /alreadyStarted/);
  const status = tools.find((t) => t.name === "cbase_workflow_status");
  assert.deepEqual(status.inputSchema.required, []);
  assert.deepEqual(Object.keys(status.inputSchema.properties), ["startId"]);
  const stop = tools.find((t) => t.name === "cbase_workflow_stop");
  assert.deepEqual(stop.inputSchema.required, ["startId"]);
  // No runtime values in the descriptions (prompt cache): two servers with different environments, the same bytes.
  const different = await view({ CBASE_CHAT_ID: "c-different", CBASE_WORKSPACE_ID: "w-different", CBASE_DYNWF_SIZE: "large" });
  for (const n of GRAPH) {
    assert.deepEqual(different.find((t) => t.name === n), tools.find((t) => t.name === n), `${n} depends on the environment`);
  }
});

test("handlers on the wire: paths, bodies, call id, from: agent — and without a chat reference an error", async () => {
  const requests = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
      if (req.url.includes("/stop") && requests.filter((a) => a.url.includes("/stop")).length > 1) {
        res.writeHead(409, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "The run has already ended.", reason: "ended" }));
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const s = mcpServer({ CBASE_BASE_URL: base, CBASE_CHAT_ID: "c/1" });
  try {
    await s.calls("initialize", {});
    const call = (name, args, meta) => s.calls("tools/call", { name, arguments: args, ...(meta ? { _meta: meta } : {}) });

    let r = await call("cbase_workflow_start", { workflow: "review", input: "please check" }, { "claudecode/toolUseId": "toolu_1" });
    assert.equal(r.result.isError, undefined, JSON.stringify(r.result));
    r = await call("cbase_workflow_start", { workflow: "review", background: true, worktree: true }, { "cbase/toolUseId": "call_2" });
    assert.equal(r.result.isError, undefined);
    // Only an explicit true counts — a string is no statement.
    r = await call("cbase_workflow_start", { workflow: "review", background: "yes", worktree: 1 });
    assert.equal(r.result.isError, undefined);
    r = await call("cbase_workflow_status", {});
    r = await call("cbase_workflow_status", { startId: "gs 1" });
    r = await call("cbase_workflow_stop", { startId: "gs_1" });
    assert.equal(r.result.isError, undefined);
    // The error of the route arrives as an error result with its wording.
    r = await call("cbase_workflow_stop", { startId: "gs_1" });
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0].text, /already ended/);
    // Without startId no call.
    const beforeEmpty = requests.length;
    r = await call("cbase_workflow_stop", {});
    assert.equal(r.result.isError, true);
    assert.equal(requests.length, beforeEmpty);

    assert.deepEqual(requests, [
      { method: "POST", url: "/api/chats/c%2F1/graph-workflows/start", body: { workflow: "review", input: "please check", background: false, worktree: false, callId: "toolu_1" } },
      { method: "POST", url: "/api/chats/c%2F1/graph-workflows/start", body: { workflow: "review", input: "", background: true, worktree: true, callId: "call_2" } },
      { method: "POST", url: "/api/chats/c%2F1/graph-workflows/start", body: { workflow: "review", input: "", background: false, worktree: false, callId: "" } },
      { method: "GET", url: "/api/chats/c%2F1/graph-workflows", body: null },
      { method: "GET", url: "/api/chats/c%2F1/graph-workflows?startId=gs%201", body: null },
      { method: "POST", url: "/api/chats/c%2F1/graph-workflows/gs_1/stop", body: { from: "agent" } },
      { method: "POST", url: "/api/chats/c%2F1/graph-workflows/gs_1/stop", body: { from: "agent" } },
    ]);
  } finally {
    s.end();
    srv.closeAllConnections();
    await new Promise((r) => srv.close(r));
  }

  // Without CBASE_CHAT_ID: an error, no call.
  const without = mcpServer({ CBASE_BASE_URL: base, CBASE_CHAT_ID: "" });
  try {
    await without.calls("initialize", {});
    for (const [name, args] of [["cbase_workflow_start", { workflow: "review" }], ["cbase_workflow_status", {}], ["cbase_workflow_stop", { startId: "gs_1" }]]) {
      const r = await without.calls("tools/call", { name, arguments: args });
      assert.equal(r.result.isError, true, name);
      assert.match(r.result.content[0].text, /Without a chat/);
    }
  } finally { without.end(); }
});
