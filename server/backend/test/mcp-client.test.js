// The in-process MCP client against a REAL stdio server (small, created in the test). Covers the whole way: initialize ->
// tools/list -> tools/call, resources and prompts, server-to-client requests (sampling/roots) and the question that weighs most
// in an app with browser automation: does an IMAGE arrive at the model as an image?
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { connectMcpServers, mcpResourceBlocks, mcpResultBlocks, mcpResultText } from "../electron/server/providers/mcp-client.js";

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

// A minimal MCP server (newline-delimited JSON-RPC over stdio).
const SERVER_JS = `
let buf = "";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    handle(msg);
  }
});
function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    // The server remembers what the client can do.
    global.clientCaps = params && params.capabilities;
    return send({ jsonrpc: "2.0", id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: "fake", version: "1" } } });
  }
  if (method === "notifications/initialized") return;
  if (method === "tools/list") {
    return send({ jsonrpc: "2.0", id, result: { tools: [
      { name: "echo", description: "returns", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
      { name: "shot", description: "delivers an image", inputSchema: { type: "object", properties: {} } },
      { name: "broken", description: "fails", inputSchema: { type: "object", properties: {} } },
      { name: "ask_model", description: "uses sampling", inputSchema: { type: "object", properties: {} } },
      { name: "roots", description: "uses roots", inputSchema: { type: "object", properties: {} } },
    ] } });
  }
  if (method === "resources/list") {
    return send({ jsonrpc: "2.0", id, result: { resources: [{ uri: "mem://doc", name: "Docs", description: "Test text", mimeType: "text/plain" }] } });
  }
  if (method === "resources/read") {
    return send({ jsonrpc: "2.0", id, result: { contents: [{ uri: params.uri, mimeType: "text/plain", text: "Content of the resource" }] } });
  }
  if (method === "prompts/list") {
    return send({ jsonrpc: "2.0", id, result: { prompts: [{ name: "review", description: "Review template", arguments: [{ name: "file" }] }] } });
  }
  if (method === "prompts/get") {
    return send({ jsonrpc: "2.0", id, result: { messages: [{ role: "user", content: { type: "text", text: "Please check " + params.arguments.file } }] } });
  }
  if (method === "tools/call") {
    const n = params.name;
    if (n === "echo") return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "echo:" + (params.arguments.text || "") }] } });
    if (n === "shot") return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "Screenshot" }, { type: "image", data: ${JSON.stringify(PNG_B64)}, mimeType: "image/png" }] } });
    if (n === "broken") return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "did not work" }], isError: true } });
    if (n === "ask_model") {
      // Server to client: ask the model and return the answer as the tool result.
      const rid = "s" + id;
      pending[rid] = (r) => send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "Model says: " + r.content.text }] } });
      return send({ jsonrpc: "2.0", id: rid, method: "sampling/createMessage", params: { messages: [{ role: "user", content: { type: "text", text: "hello" } }], maxTokens: 10 } });
    }
    if (n === "roots") {
      const rid = "r" + id;
      pending[rid] = (r) => send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "Roots: " + r.roots.length }] } });
      return send({ jsonrpc: "2.0", id: rid, method: "roots/list", params: {} });
    }
    return send({ jsonrpc: "2.0", id, error: { code: -32601, message: "unknown" } });
  }
  // Answer to one of our server-to-client requests
  if (id !== undefined && pending[id]) { const fn = pending[id]; delete pending[id]; if (msg.result) fn(msg.result); return; }
}
const pending = {};
`;

function withServer(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-mcp-"));
  const file = path.join(root, "server.mjs");
  fs.writeFileSync(file, SERVER_JS);
  return { root, file, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("mcpResultBlocks: images stay images (mcpResultText folds them to text)", () => {
  const result = { content: [{ type: "text", text: "Screenshot" }, { type: "image", data: PNG_B64, mimeType: "image/png" }] };
  assert.equal(mcpResultText(result), "Screenshot\n[Image]");
  const blocks = mcpResultBlocks(result);
  assert.equal(blocks[0].type, "text");
  assert.equal(blocks[1].type, "image");
  assert.equal(blocks[1].source.media_type, "image/png");
  assert.equal(blocks[1].source.data, PNG_B64);

  // Embedded resources: image as image, everything else as text.
  const embedded = mcpResultBlocks({ content: [{ type: "resource", resource: { uri: "x://1", blob: PNG_B64, mimeType: "image/png" } }] });
  assert.equal(embedded[0].type, "image");
  const textRes = mcpResultBlocks({ content: [{ type: "resource", resource: { uri: "x://2", text: "hello" } }] });
  assert.equal(textRes[0].text, "hello");

  assert.equal(mcpResourceBlocks({ contents: [{ uri: "mem://d", text: "abc" }] })[0].text, "[mem://d]\nabc");
});

test("full stdio round trip: tools, resources, prompts, sampling, roots", async () => {
  const { file, cleanup } = withServer();
  const asked = [];
  const pool = await connectMcpServers(
    { fake: { command: process.execPath, args: [file] } },
    {
      cwd: process.cwd(),
      onServerRequest: async (method, params) => {
        asked.push(method);
        if (method === "roots/list") return { roots: [{ uri: "file:///a", name: "/a" }, { uri: "file:///b", name: "/b" }] };
        if (method === "sampling/createMessage") return { role: "assistant", content: { type: "text", text: "42" }, model: "test", stopReason: "endTurn" };
        return null;
      },
    },
  );
  try {
    assert.deepEqual(pool.errors, []);
    // Tools carry the canonical prefix mcp__<server>__<tool>.
    assert.deepEqual(pool.tools.map((t) => t.name).sort(), [
      "mcp__fake__ask_model", "mcp__fake__broken", "mcp__fake__echo", "mcp__fake__roots", "mcp__fake__shot",
    ]);

    const echo = await pool.call("mcp__fake__echo", { text: "hi" });
    assert.equal(mcpResultText(echo), "echo:hi");

    // A screenshot stays an image up to the engine.
    const shot = mcpResultBlocks(await pool.call("mcp__fake__shot", {}));
    assert.equal(shot.find((b) => b.type === "image").source.data, PNG_B64);

    const bad = await pool.call("mcp__fake__broken", {});
    assert.equal(bad.isError, true);

    // An unknown tool ends as an error result, not as an exception.
    const unknown = await pool.call("mcp__fake__nonexistent", {});
    assert.equal(unknown.isError, true);

    // Resources and prompts (the client used to know only tools/list).
    assert.deepEqual(pool.resources.map((r) => r.uri), ["mem://doc"]);
    const read = await pool.readResource("fake", "mem://doc");
    assert.match(mcpResourceBlocks(read)[0].text, /Content of the resource/);
    assert.deepEqual(pool.prompts.map((p) => p.name), ["review"]);
    const prompt = await pool.getPrompt("fake", "review", { file: "a.ts" });
    assert.match(prompt.messages[0].content.text, /check a\.ts/);

    // Server to client: sampling and roots are ANSWERED (they used to be dropped silently).
    const sampled = await pool.call("mcp__fake__ask_model", {});
    assert.match(mcpResultText(sampled), /Model says: 42/);
    const roots = await pool.call("mcp__fake__roots", {});
    assert.match(mcpResultText(roots), /Roots: 2/);
    assert.deepEqual(asked.sort(), ["roots/list", "sampling/createMessage"]);
  } finally {
    pool.closeAll();
    cleanup();
  }
});

// A stdio server with its OWN env used to get ONLY that env in the loop engine (`env || process.env`): no PATH (in operation:
// the git folder alone, a program by name ended with ENOENT) and none of the package caches of B (npx/uvx loaded from the shared
// caches of the project containers). Now the own env extends the environment of B, as with the Claude CLI: the server is started
// by NAME (`sh`), sees its env, B's caches and the git folder in front in PATH.
// Counter-test: the old mcp-client.js (`env || process.env`) => red ("the server does not see B's npm cache").
test("stdio server with its own env: it extends the environment of B (PATH with the git folder in front, the package caches of B, its own values)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-mcp-env-"));
  const file = path.join(root, "server.mjs");
  fs.writeFileSync(file, `
let buf = "";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    const { id, method } = JSON.parse(line);
    if (method === "initialize") send({ jsonrpc: "2.0", id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "env", version: "1" } } });
    else if (method === "tools/list") send({ jsonrpc: "2.0", id, result: { tools: [{ name: "environment", description: "", inputSchema: { type: "object", properties: {} } }] } });
    else if (method === "tools/call") send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify({ PATH: process.env.PATH, npm_config_cache: process.env.npm_config_cache ?? null, OWN: process.env.OWN ?? null }) }] } });
    else if (id !== undefined) send({ jsonrpc: "2.0", id, result: {} });
  }
});
`);
  const values = { CBASE_CONTAINER: "1", CBASE_DIND: "1", CBASE_GIT_WRAPPER_FOLDER: path.join(root, "git-path"), npm_config_cache: path.join(root, "b-npm") };
  const saved = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  Object.assign(process.env, values);
  let pool = null;
  try {
    pool = await connectMcpServers({ env: { command: "sh", args: ["-c", `exec "${process.execPath}" "${file}"`], env: { OWN: "yes" } } }, { cwd: root });
    assert.deepEqual(pool.errors, [], `the server did not start: ${JSON.stringify(pool.errors)}`);
    const u = JSON.parse(mcpResultText(await pool.call("mcp__env__environment", {})));
    assert.equal(u.OWN, "yes", "the own env is missing");
    assert.equal(u.npm_config_cache, values.npm_config_cache, "the server does not see B's npm cache");
    assert.ok(u.PATH.startsWith(`${values.CBASE_GIT_WRAPPER_FOLDER}:`), `PATH without the git folder in front: ${u.PATH}`);
    assert.ok(u.PATH.length > values.CBASE_GIT_WRAPPER_FOLDER.length + 1, "PATH is only the git folder");
  } finally {
    pool?.closeAll();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// `enabledTools` on the server entry (the individually released tools of a foreign server for a subagent) cuts Codex through
// `enabled_tools`; the client of the loop engine used to ignore it. Counter-test: ignoring it puts all five tools in the pool and
// `broken` is executed.
test("enabledTools on the server entry applies as with Codex: only the named tools, an empty list blocks the server", async () => {
  const { file, cleanup } = withServer();
  const pool = await connectMcpServers({
    only: { command: process.execPath, args: [file], enabledTools: ["echo"] },
    none: { command: process.execPath, args: [file], enabledTools: [] },
    all: { command: process.execPath, args: [file] },
  }, { cwd: process.cwd() });
  try {
    const names = pool.tools.map((t) => t.name);
    assert.deepEqual(names.filter((n) => n.startsWith("mcp__only__")), ["mcp__only__echo"]);
    assert.deepEqual(names.filter((n) => n.startsWith("mcp__none__")), []);
    assert.equal(names.filter((n) => n.startsWith("mcp__all__")).length, 5, "without a list everything as before");
    const outside = await pool.call("mcp__only__broken", {});
    assert.equal(outside.isError, true);
    assert.match(mcpResultText(outside), /Unknown MCP tool/);
    assert.equal(mcpResultText(await pool.call("mcp__only__echo", { text: "yes" })), "echo:yes");
  } finally { pool.closeAll(); cleanup(); }
});

// The buffer of the stdio client used to grow without a limit as long as no line end came: a server writing without "\n" filled
// the memory of B. Now a message above the cap (`CBASE_MCP_ROW_MAX`, small here) ends with an error saying so, and the server is
// ended. Counter-test: without the cap the call waits up to its deadline (here 1 s) and ends as "timeout".
test("a message without a line end above the cap ends the server: the call fails with the wording, not at the deadline", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-mcp-flood-"));
  const file = path.join(root, "flood.mjs");
  fs.writeFileSync(file, `
let buf = "";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "flood", version: "1" } } });
    else if (msg.method === "tools/list") send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "flood", inputSchema: { type: "object", properties: {} } }] } });
    else if (msg.method === "tools/call") process.stdout.write("x".repeat(2 * 1024 * 1024)); // never a line end
    else if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "nope" } });
  }
});
`);
  const saved = process.env.CBASE_MCP_ROW_MAX;
  process.env.CBASE_MCP_ROW_MAX = String(1024 * 1024);
  const pool = await connectMcpServers({ flood: { command: process.execPath, args: [file], timeout: 1000 } }, { cwd: process.cwd() });
  try {
    assert.deepEqual(pool.errors, []);
    const r = await pool.call("mcp__flood__flood", {});
    assert.equal(r.isError, true);
    assert.match(mcpResultText(r), /message over 1048576 characters without a line end — server ended/, mcpResultText(r));
    // The server is gone: the next call fails at once.
    assert.match(mcpResultText(await pool.call("mcp__flood__flood", {})), /not connected|ended/);
  } finally {
    if (saved === undefined) delete process.env.CBASE_MCP_ROW_MAX; else process.env.CBASE_MCP_ROW_MAX = saved;
    pool.closeAll();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// HTTP way: the HTTP client used to read the body whole with `res.text()`; a server with an endless body filled the memory of B.
// Now the request fails at the same cap, with the wording, and the stream is aborted (the server sees the end). Counter-test:
// without the cap the call reads up to its deadline (120 s) and ends as an abort without this wording.
test("an HTTP response above the cap aborts: the request fails with the wording, the server sees the abort", async () => {
  const http = await import("node:http");
  let aborted = false;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      const msg = JSON.parse(body);
      const response = (result) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })); };
      if (msg.method === "initialize") return response({ protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "flood", version: "1" } });
      if (msg.method === "tools/list") return response({ tools: [{ name: "flood", inputSchema: { type: "object", properties: {} } }] });
      if (msg.method !== "tools/call") { res.writeHead(202); return res.end(); }
      res.writeHead(200, { "content-type": "application/json" });
      res.write(`{"jsonrpc":"2.0","id":${msg.id},"result":{"content":[{"type":"text","text":"`);
      const block = "x".repeat(64 * 1024);
      let open = true;
      res.on("close", () => { open = false; aborted = true; });
      const pump = () => { while (open && res.write(block)) { /* until the buffer is full */ } if (open) res.once("drain", pump); };
      pump();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const saved = process.env.CBASE_MCP_ROW_MAX;
  process.env.CBASE_MCP_ROW_MAX = String(1024 * 1024);
  const pool = await connectMcpServers({ flood: { type: "http", url: `http://127.0.0.1:${server.address().port}/mcp` } }, { cwd: process.cwd() });
  try {
    assert.deepEqual(pool.errors, []);
    const r = await pool.call("mcp__flood__flood", {});
    assert.equal(r.isError, true);
    assert.match(mcpResultText(r), /response over 1048576 bytes — aborted/, mcpResultText(r));
    await waitUntil(() => aborted);
  } finally {
    if (saved === undefined) delete process.env.CBASE_MCP_ROW_MAX; else process.env.CBASE_MCP_ROW_MAX = saved;
    pool.closeAll();
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
});
// Waits for a condition, without a deadline (the guard measures events, not durations).
async function waitUntil(fn) { while (!fn()) await new Promise((r) => setImmediate(r)); }

test("a broken server does not take the others down", async () => {
  const { file, cleanup } = withServer();
  const pool = await connectMcpServers({
    fake: { command: process.execPath, args: [file] },
    broken: { command: path.join(os.tmpdir(), "exists-not-cbase"), args: [] },
  }, { cwd: process.cwd() });
  try {
    assert.equal(pool.errors.length, 1);
    assert.equal(pool.errors[0].server, "broken");
    assert.ok(pool.tools.some((t) => t.name === "mcp__fake__echo"), "the healthy server stays usable");
  } finally { pool.closeAll(); cleanup(); }
});
