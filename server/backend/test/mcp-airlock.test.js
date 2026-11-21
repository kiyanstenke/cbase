// The coding MCP airlock at the main seam: real server, real wrapper (mcp/airlock.js), a fake stdio MCP server and a fake
// streamable-HTTP server. What is pinned here:
//   (1) stdio: writeMcpConfig writes the WRAPPER under the name of the server (never command/args/env of the real one);
//       tools/list arrives over all pages and filtered; a free tool goes through (child without CBASE_*, with its env), a
//       deselected one does NOT (isError with reason); a marker => card (without "remember", `remember` dropped, `updatedInput`
//       applies); without a turn no run => refusal; the wrapper exits (stdin closed) => the card is declined (origin "stop") and
//       NEVER forwarded;
//   (2) token: expired => 401 (the wrapper does not start), the token of another chat => 401;
//   (3) http: the headers reach the real server but appear in NO response and in no file; list over two pages filtered, a call
//       as SSE response, the session holds, a deselected tool does not reach the server;
//   (4) roles: a subagent gets a server only with "subagents inherit" (new: off); live: switching it off in mid-run makes the
//       route refuse (the "main" sentence); the card of a subagent belongs to IT and stays open across background and turn end,
//       its token stays valid; a workflow agent gets NO card for a marker;
//   (5) a server without a free tool is not in the file (counter-test: choice null);
//   (6) Codex: the run token is not in argv, only its name (`env_vars`), the value in the environment of the Codex process;
//   (7) outer loop: the token role `outer_loop`: the server is in the file WITHOUT "subagents inherit", the list carries only
//       the choice of ITS agent without markers, a tool not chosen and a marker are refused with one sentence (no card, even in
//       mid-turn), the choice applies live. Counter-test: without the role writeMcpConfig wrote a subagent entry for an
//       outer-loop marker, i.e. none without "inherit".
//
// Run alone: CBASE_LIMIT_GRACE_MS=2000 CBASE_LIMIT_MIN_WAIT_MS=2000 CBASE_SWEEP_MS=2000 CBASE_AGENT_STALL_MS=3600000
// CBASE_EMBED_OFFLINE=1 node --test --test-reporter=tap server/backend/test/mcp-airlock.test.js
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import * as store from "../electron/server/store.js";
import { db } from "../electron/server/store/db.js";
import { writeMcpConfig } from "../electron/server/toolchain/mcp-config.js";
import { expireAllTokens, expiry } from "../electron/server/toolchain/airlock-token.js";
import * as texts from "../electron/server/toolchain/airlock-texts.js";
import { agentCardsIntoTheBackground, clearChatPermissions, pendingPermissions } from "../electron/server/runs/approvals.js";
import { loadPermissionRules } from "../electron/server/runs/permissions.js";
import { running } from "../electron/server/runs/state.js";
import { buildCodexChatArgs, mcpSecretEnvironment } from "../electron/server/providers/connectors/codex.js";
import { json, withAgentsServer, waitForTruthy } from "./agent-harness.mjs";

// A stdio MCP server with three tools on two pages; every message, with the environment it sees, goes into the log.
const FAKE_STDIO = `import fs from "node:fs";
const LOG = process.env.FAKE_LOG;
const TOOLS = [
  { name: "read", description: "reads", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
  { name: "send", description: "sends", inputSchema: { type: "object" }, annotations: { readOnlyHint: false } },
  { name: "third", description: "unclear", inputSchema: { type: "object" } },
];
const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) { const z = buf.slice(0, i); buf = buf.slice(i + 1); if (z.trim()) handle(JSON.parse(z)); }
});
function handle(m) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("CBASE_") || k === "OWN"));
  fs.appendFileSync(LOG, JSON.stringify({ method: m.method, params: m.params, env }) + "\\n");
  if (m.id === undefined || m.method === undefined) return;
  if (m.method === "initialize") return out({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-stdio", version: "1" } } });
  if (m.method === "tools/list") {
    const two = m.params && m.params.cursor === "2";
    return out({ jsonrpc: "2.0", id: m.id, result: { tools: two ? TOOLS.slice(2) : TOOLS.slice(0, 2), ...(two ? {} : { nextCursor: "2" }) } });
  }
  if (m.method === "tools/call") return out({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "ok:" + m.params.name + ":" + JSON.stringify(m.params.arguments) }] } });
  if (m.method === "resources/list") return out({ jsonrpc: "2.0", id: m.id, result: { resources: [{ uri: "fake://one", name: "one" }] } });
  out({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "unknown" } });
}
`;

// A streamable-HTTP server: requires `Authorization: Bearer <secret>`, issues a session, answers tools/call as SSE.
function fakeHttp(secret) {
  const requests = [];
  const TOOLS = [
    { name: "search", description: "searches", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
    { name: "item", description: "posts", inputSchema: { type: "object" }, annotations: { readOnlyHint: false } },
    { name: "erase", description: "deletes", inputSchema: { type: "object" }, annotations: { readOnlyHint: false } },
  ];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => { raw += d; });
    req.on("end", () => {
      const m = raw ? JSON.parse(raw) : null;
      requests.push({ auth: req.headers.authorization || "", session: req.headers["mcp-session-id"] || "", m });
      if (req.headers.authorization !== `Bearer ${secret}`) { res.writeHead(401); return res.end("no"); }
      if (!m || m.id === undefined) { res.writeHead(202); return res.end(); }
      const json = (r) => { res.writeHead(200, { "Content-Type": "application/json", "mcp-session-id": "sess-1" }); res.end(JSON.stringify(r)); };
      if (m.method === "initialize") return json({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-http", version: "1" } } });
      if (m.method === "tools/list") {
        const two = m.params?.cursor === "b";
        return json({ jsonrpc: "2.0", id: m.id, result: { tools: two ? TOOLS.slice(1) : TOOLS.slice(0, 1), ...(two ? {} : { nextCursor: "b" }) } });
      }
      if (m.method === "tools/call") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "mcp-session-id": "sess-1" });
        res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: 1, progress: 1 } })}\n\n`);
        return res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: `http:${m.params.name}` }] } })}\n\n`);
      }
      json({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "unknown" } });
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${server.address().port}/mcp`, requests, shutdown: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) })));
}

// The wrapper as a child, the way the CLI starts it: command/args/env of the entry.
function wrapper(entry, cwd) {
  const subprocess = spawn(entry.command, entry.args, { env: { ...process.env, ...entry.env }, cwd, stdio: ["pipe", "pipe", "pipe"] });
  const wait = new Map();
  const onTheSide = [];
  let buf = "";
  let error = "";
  subprocess.stdout.setEncoding("utf8");
  subprocess.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const z = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!z.trim()) continue;
      const m = JSON.parse(z);
      const w = wait.get(m.id);
      if (w && (m.result || m.error)) { wait.delete(m.id); w(m); } else onTheSide.push(m);
    }
  });
  subprocess.stderr.on("data", (d) => { error += d; });
  let seq = 0;
  const end = new Promise((r) => subprocess.once("exit", (code, signal) => r({ code, signal })));
  return {
    kind: subprocess, onTheSide, end, error: () => error,
    question: (method, params) => new Promise((r) => { const id = ++seq; wait.set(id, r); subprocess.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); }),
    // A request whose answer the test does NOT wait for (card, abort).
    send: (method, params) => { const id = ++seq; subprocess.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); return id; },
    report: (method, params) => subprocess.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"),
    shutdown: async () => { try { subprocess.stdin.end(); } catch { /* zu */ } return end; },
  };
}
const INIT = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } };
const text = (r) => r?.result?.content?.map((c) => c.text).join("") ?? "";
const logValue = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((z) => JSON.parse(z)) : []);
const calls = (f, name) => logValue(f).filter((z) => z.method === "tools/call" && (!name || z.params?.name === name));
const openCard = (chatId, toolName) => [...pendingPermissions.values()].find((p) => p.chatId === chatId && p.toolName === toolName);
const rows = (chatId, role) => db.prepare("SELECT text FROM messages WHERE chat_id = ? AND role = ? ORDER BY id").all(chatId, role).map((r) => JSON.parse(r.text));

test("airlock at the main seam: stdio, card, abort, token, http, roles, empty choice, Codex", { timeout: 120_000 }, async () => {
  await withAgentsServer(async ({ base, ws, chat, root }) => {
    const fake = path.join(root, "fake-stdio.mjs");
    fs.writeFileSync(fake, FAKE_STDIO);
    const log = path.join(root, "fake-stdio.log");
    const cfg = (name) => path.join(root, `${name}.mcp.json`);
    const set = () => store.effectiveMcpServers(ws.id, null);
    const s = await json(`${base}/api/workspaces/${ws.id}/mcp-servers`, { method: "POST", body: JSON.stringify({ name: "fake", transport: "stdio", command: process.execPath, args: [fake], env: { OWN: "yes", FAKE_LOG: log } }) });
    assert.equal(s.subagentsInherit, false, "newly created: subagents inherit off");
    const loaded = await json(`${base}/api/mcp-servers/${s.id}/tools`, { method: "POST" });
    assert.deepEqual(loaded.tools.map((w) => [w.name, w.writing]), [["read", false], ["send", true], ["third", null]], "both pages loaded");
    assert.deepEqual(loaded.markers, ["send"], "newly created: automatic marker on the writing tool");
    await json(`${base}/api/mcp-servers/${s.id}`, { method: "PATCH", body: JSON.stringify({ choice: ["read", "send"] }) });

    // (1) the file carries the wrapper, never the real server
    const { servers, airlock } = writeMcpConfig(cfg("main"), { chatId: chat.id, workspaceId: ws.id, extraServers: set() });
    assert.deepEqual(airlock, ["fake"]);
    const e = servers.fake;
    assert.equal(e.command, process.execPath);
    assert.match(e.args[0], /mcp[/\\]airlock\.js$/);
    assert.deepEqual(e.args.slice(1), ["--server", s.id]);
    const file = fs.readFileSync(cfg("main"), "utf8");
    assert.ok(!file.includes(fake) && !file.includes("OWN") && !file.includes(log), "neither command/args nor env of the real server in the file");

    const listPrior = logValue(log).filter((z) => z.method === "tools/list").length;
    const h = wrapper(e, root);
    try {
      const init = await h.question("initialize", INIT);
      assert.equal(init.result?.serverInfo?.name, "fake-stdio", "initialize goes through");
      h.report("notifications/initialized", {});
      const list = await h.question("tools/list", {});
      assert.deepEqual(list.result.tools.map((t) => t.name), ["read", "send"], "deselected is missing");
      assert.equal(list.result.nextCursor, undefined, "one answer over all pages");
      assert.equal(logValue(log).filter((z) => z.method === "tools/list").length - listPrior, 2, "counter-test: the child delivered two pages");

      assert.equal(text(await h.question("tools/call", { name: "read", arguments: { x: 1 } })), 'ok:read:{"x":1}');
      const [read] = calls(log, "read");
      assert.deepEqual(read.env, { OWN: "yes" }, "the child sees its env and NO CBASE_*");

      // resources/* go through.
      assert.deepEqual((await h.question("resources/list", {})).result?.resources?.map((r) => r.uri), ["fake://one"]);
      // Effective at once: change the choice between two calls of the same run.
      await json(`${base}/api/mcp-servers/${s.id}`, { method: "PATCH", body: JSON.stringify({ choice: ["send"] }) });
      assert.equal(text(await h.question("tools/call", { name: "read", arguments: { x: 2 } })), texts.notSelected("read", "fake"), "deselecting applies in the same run");
      await json(`${base}/api/mcp-servers/${s.id}`, { method: "PATCH", body: JSON.stringify({ choice: ["read", "send"] }) });
      assert.equal(text(await h.question("tools/call", { name: "read", arguments: { x: 3 } })), 'ok:read:{"x":3}', "counter-test: ticked again");
      assert.equal(calls(log, "read").length, 2, "the deselected call never arrived");

      const third = await h.question("tools/call", { name: "third", arguments: {} });
      assert.equal(third.result?.isError, true);
      assert.equal(text(third), texts.notSelected("third", "fake"));
      assert.equal(calls(log, "third").length, 0, "a deselected tool never reaches the server");

      // Marker without a running turn: no card, refusal.
      const withoutRun = await h.question("tools/call", { name: "send", arguments: {} });
      assert.equal(withoutRun.result?.isError, true);
      assert.equal(calls(log, "send").length, 0);

      // Marker in a turn: card, "remember" dropped, changed parameters apply.
      running.add(chat.id);
      const rulesPrior = JSON.stringify(loadPermissionRules());
      const response = h.question("tools/call", { name: "send", arguments: { to: "all" } });
      const card = await waitForTruthy(() => openCard(chat.id, "mcp__fake__send"), "Card");
      assert.equal(card.airlock, true);
      const row = rows(chat.id, "approval").at(-1);
      assert.equal(row.airlock, true);
      assert.equal(row.server, "fake");
      assert.equal(row.tool, "send");
      assert.equal(row.suggestedRule, undefined, "no rule to remember");
      const d = await json(`${base}/api/chats/${chat.id}/permission-decision`, { method: "POST", body: JSON.stringify({ requestId: card.requestId, behavior: "allow", remember: "mcp__fake__send", updatedInput: { to: "one" } }) });
      assert.equal(d.ok, true);
      assert.equal(text(await response), 'ok:send:{"to":"one"}');
      assert.equal(JSON.stringify(loadPermissionRules()), rulesPrior, "\"remember\" dropped");

      // Declining => the reason as text, nothing executed.
      const no = h.question("tools/call", { name: "send", arguments: { to: "no" } });
      const k3 = await waitForTruthy(() => openCard(chat.id, "mcp__fake__send"), "card to decline");
      await json(`${base}/api/chats/${chat.id}/permission-decision`, { method: "POST", body: JSON.stringify({ requestId: k3.requestId, behavior: "deny", message: "too risky" }) });
      const rejected = await no;
      assert.equal(rejected.result?.isError, true);
      assert.equal(text(rejected), "Declined by the user: too risky");
      assert.equal(calls(log, "send").length, 1);

      // Abort: the wrapper exits while the card is open => declined, never forwarded.
      h.send("tools/call", { name: "send", arguments: { again: true } });
      const second = await waitForTruthy(() => openCard(chat.id, "mcp__fake__send"), "second card");
      await h.shutdown();
      await waitForTruthy(() => !pendingPermissions.has(second.requestId), "card declined");
      const ruling = rows(chat.id, "approval_ruling").find((z) => z.requestId === second.requestId);
      assert.equal(ruling.behavior, "deny");
      assert.equal(ruling.origin, "stop");
      const late = await json(`${base}/api/chats/${chat.id}/permission-decision`, { method: "POST", body: JSON.stringify({ requestId: second.requestId, behavior: "allow" }) });
      assert.equal(late.ok, false, "a later approval finds no card");
      assert.equal(calls(log, "send").length, 1, "the aborted call never reached the server");
    } finally {
      running.delete(chat.id);
      await h.shutdown();
    }

    // (2) Token: expired (run end) or all gone (backend restart) => the wrapper does not start; a foreign chat => 401.
    expiry(chat.id);
    assert.equal((await fetch(`${base}/api/chats/${chat.id}/mcp-airlock/${s.id}/start`, { headers: { "x-cbase-airlock": e.env.CBASE_AIRLOCK } })).status, 401, "run end");
    writeMcpConfig(cfg("restart"), { chatId: chat.id, workspaceId: ws.id, extraServers: set() });
    expireAllTokens();
    const tot = wrapper(e, root);
    try {
      const r = await tot.question("initialize", INIT);
      assert.match(r.error?.message || "", /run token/);
    } finally { await tot.shutdown(); }
    const fresh = writeMcpConfig(cfg("main2"), { chatId: chat.id, workspaceId: ws.id, extraServers: set() }).servers.fake;
    const other = await json(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, provider: "claude", model: "claude-haiku-4-5-20251001" }) });
    const foreign = await fetch(`${base}/api/chats/${other.id}/mcp-airlock/${s.id}/start`, { headers: { "x-cbase-airlock": fresh.env.CBASE_AIRLOCK } });
    assert.equal(foreign.status, 401, "the token is valid only for its chat");
    const own = await fetch(`${base}/api/chats/${chat.id}/mcp-airlock/${s.id}/start`, { headers: { "x-cbase-airlock": fresh.env.CBASE_AIRLOCK } });
    assert.equal(own.status, 200, "counter-test: in its own chat");

    // (6) Codex: the token only as a name in argv, the value in the environment.
    const argv = buildCodexChatArgs({ cwd: root, model: "", prompt: "x", mcpServers: { fake: fresh } });
    assert.ok(!argv.join("\n").includes(fresh.env.CBASE_AIRLOCK), "no token in argv");
    assert.ok(argv.some((a) => a.includes("mcp_servers.fake.env_vars") && a.includes("CBASE_AIRLOCK")), "the name as env_vars");
    assert.equal(mcpSecretEnvironment({ fake: fresh }).CBASE_AIRLOCK, fresh.env.CBASE_AIRLOCK);

    // (4) Roles: subagent without inheriting => no entry; with => entry; switched off live => refusal with "main".
    const sub = () => writeMcpConfig(cfg("sub"), { chatId: chat.id, workspaceId: ws.id, extraServers: set(), agentDepth: 1, profileKey: `${chat.id}-agent-a1`, agentId: "a1" });
    assert.equal(sub().servers.fake, undefined, "subagent without \"subagents inherit\"");
    await json(`${base}/api/mcp-servers/${s.id}`, { method: "PATCH", body: JSON.stringify({ subagentsInherit: true }) });
    const subEntry = sub().servers.fake;
    assert.ok(subEntry, "counter-test: with \"subagents inherit\"");
    const hs = wrapper(subEntry, root);
    try {
      await hs.question("initialize", INIT);
      assert.equal(text(await hs.question("tools/call", { name: "read", arguments: {} })), "ok:read:{}", "counter-test: free with inheriting");
      await json(`${base}/api/mcp-servers/${s.id}`, { method: "PATCH", body: JSON.stringify({ subagentsInherit: false }) });
      const r = await hs.question("tools/call", { name: "read", arguments: {} });
      assert.equal(text(r), texts.onlyMain("fake"), "live: the switch applies in mid-run");
      // The card belongs to the subagent (same choice, same markers) and survives what the core does at background and turn
      // end: pull cards along (agentCardsIntoTheBackground), decline main-run cards, expire main-run tokens.
      await json(`${base}/api/mcp-servers/${s.id}`, { method: "PATCH", body: JSON.stringify({ subagentsInherit: true }) });
      running.add(chat.id);
      const open = hs.question("tools/call", { name: "send", arguments: { to: "sub" } });
      const ks = await waitForTruthy(() => openCard(chat.id, "mcp__fake__send"), "card of the subagent");
      assert.equal(ks.agent?.id, "a1", "the card belongs to the subagent");
      agentCardsIntoTheBackground(chat.id, "a1");
      running.delete(chat.id);
      clearChatPermissions(chat.id, "Run ended");
      expiry(chat.id);
      assert.ok(openCard(chat.id, "mcp__fake__send"), "open after turn end (background)");
      await json(`${base}/api/chats/${chat.id}/permission-decision`, { method: "POST", body: JSON.stringify({ requestId: ks.requestId, behavior: "allow" }) });
      assert.equal(text(await open), 'ok:send:{"to":"sub"}', "the token of the subagent stays valid beyond the turn end");
    } finally { await hs.shutdown(); }
    await json(`${base}/api/mcp-servers/${s.id}`, { method: "PATCH", body: JSON.stringify({ subagentsInherit: true }) });
    const wf = writeMcpConfig(cfg("wf"), { chatId: chat.id, workspaceId: ws.id, extraServers: set(), agentDepth: 1, workflowAgent: "w1" }).servers.fake;
    const hw = wrapper(wf, root);
    try {
      running.add(chat.id);
      await hw.question("initialize", INIT);
      const r = await hw.question("tools/call", { name: "send", arguments: {} });
      assert.equal(text(r), texts.workflowMarker(), "workflow agent: no card");
      assert.equal(openCard(chat.id, "mcp__fake__send"), undefined);
      assert.equal(text(await hw.question("tools/call", { name: "read", arguments: {} })), "ok:read:{}", "counter-test: free goes through");
    } finally { running.delete(chat.id); await hw.shutdown(); }

    // (5) nothing free => not in the file.
    await json(`${base}/api/mcp-servers/${s.id}`, { method: "PATCH", body: JSON.stringify({ choice: [] }) });
    assert.equal(writeMcpConfig(cfg("empty"), { chatId: chat.id, workspaceId: ws.id, extraServers: set() }).servers.fake, undefined);
    await json(`${base}/api/mcp-servers/${s.id}`, { method: "PATCH", body: JSON.stringify({ choice: null }) });
    assert.ok(writeMcpConfig(cfg("all"), { chatId: chat.id, workspaceId: ws.id, extraServers: set() }).servers.fake, "counter-test: choice null");

    // (3) http with headers.
    const SECRET = "secret-0815-airlock";
    const fh = await fakeHttp(SECRET);
    try {
      const hs2 = await json(`${base}/api/workspaces/${ws.id}/mcp-servers`, { method: "POST", body: JSON.stringify({ name: "network", transport: "http", url: fh.url, headers: { Authorization: `Bearer ${SECRET}` } }) });
      const responses = [JSON.stringify(hs2)];
      responses.push(JSON.stringify(await json(`${base}/api/mcp-servers/${hs2.id}/tools`, { method: "POST" })));
      responses.push(JSON.stringify(await json(`${base}/api/mcp-servers/${hs2.id}`, { method: "PATCH", body: JSON.stringify({ choice: ["search", "item"], markers: [] }) })));
      responses.push(JSON.stringify(await json(`${base}/api/workspaces/${ws.id}/mcp-servers`)));
      for (const a of responses) assert.ok(!a.includes(SECRET), "no header value in a response");
      assert.deepEqual(JSON.parse(responses[3]).find((x) => x.id === hs2.id).headers, [{ name: "Authorization", set: true }]);
      const { servers: sv } = writeMcpConfig(cfg("network"), { chatId: chat.id, workspaceId: ws.id, extraServers: set() });
      assert.ok(!fs.readFileSync(cfg("network"), "utf8").includes(SECRET), "no header value in the file");
      assert.equal(sv.network.type, undefined, "http also stands as a stdio wrapper");
      const hn = wrapper(sv.network, root);
      try {
        assert.equal((await hn.question("initialize", INIT)).result?.serverInfo?.name, "fake-http");
        hn.report("notifications/initialized", {});
        assert.deepEqual((await hn.question("tools/list", {})).result.tools.map((t) => t.name), ["search", "item"], "two pages, filtered");
        assert.equal(text(await hn.question("tools/call", { name: "item", arguments: {} })), "http:item", "SSE-Response");
        assert.ok(hn.onTheSide.some((m) => m.method === "notifications/progress"), "messages beside the answer arrive");
        const way = await hn.question("tools/call", { name: "erase", arguments: {} });
        assert.equal(text(way), texts.notSelected("erase", "network"));
        assert.ok(!fh.requests.some((a) => a.m?.params?.name === "erase"), "a deselected tool never reaches the server");
        const afterInit = fh.requests.filter((a) => a.m?.method !== "initialize");
        assert.ok(afterInit.length > 0 && afterInit.every((a) => a.session === "sess-1" && a.auth === `Bearer ${SECRET}`), "session and header on every request");
      } finally { await hn.shutdown(); }
    } finally { await fh.shutdown(); }
  });
});

test("PATCH contract: airlock fields only from the body, unknown names 400, headers one by one, never a value", { timeout: 60_000 }, async () => {
  await withAgentsServer(async ({ base, ws, root }) => {
    const fake = path.join(root, "fake-stdio.mjs");
    fs.writeFileSync(fake, FAKE_STDIO);
    const log = path.join(root, "fake-stdio.log");
    const patch = (id, b) => fetch(`${base}/api/mcp-servers/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
    const s = await json(`${base}/api/workspaces/${ws.id}/mcp-servers`, { method: "POST", body: JSON.stringify({ name: "fake", transport: "stdio", command: process.execPath, args: [fake], env: { FAKE_LOG: log } }) });
    await json(`${base}/api/mcp-servers/${s.id}/tools`, { method: "POST" });
    await json(`${base}/api/mcp-servers/${s.id}`, { method: "PATCH", body: JSON.stringify({ choice: ["read"] }) });
    // A rename does NOT carry the airlock fields along: choice and markers stay as they are.
    // The body as web and iOS send it when editing (McpServersPane saveDraft, McpPane RemoteBody): only the form.
    const renamed = await (await patch(s.id, { name: "fake2", transport: "stdio", command: process.execPath, args: [fake], env: { FAKE_LOG: log }, enabled: true })).json();
    assert.equal(renamed.name, "fake2");
    assert.deepEqual(renamed.choice, ["read"], "choice unchanged");
    assert.deepEqual(renamed.markers, ["send"], "markers unchanged");
    // Counter-test: an explicit field applies.
    assert.deepEqual((await (await patch(s.id, { choice: null })).json()).choice, null);
    const unknown = await patch(s.id, { choice: ["read", "nonexistent"] });
    assert.equal(unknown.status, 400);
    assert.deepEqual((await unknown.json()).unknown, ["nonexistent"]);
    assert.equal((await patch(s.id, { markers: ["nonexistent"] })).status, 400);
    assert.equal((await patch(s.id, { subagentsInherit: "yes" })).status, 400, "subagentsInherit only boolean");
    assert.equal((await patch(s.id, { headers: { "X-A": "1" } })).status, 400, "headers only for http/sse");
    // http: set and remove headers one by one, names per RFC 7230, values never returned.
    const h = await json(`${base}/api/workspaces/${ws.id}/mcp-servers`, { method: "POST", body: JSON.stringify({ name: "network", transport: "http", url: "http://127.0.0.1:9/mcp", headers: { "X-Api": "value-one" } }) });
    assert.deepEqual(h.headers, [{ name: "X-Api", set: true }]);
    const two = await (await patch(h.id, { headers: { "X-Api": null, Authorization: "Bearer value-two" } })).text();
    assert.ok(!two.includes("value-two") && !two.includes("value-one"), "no value in the response");
    assert.deepEqual(JSON.parse(two).headers, [{ name: "Authorization", set: true }]);
    assert.deepEqual(store.mcpHeadersValues(h.id), { Authorization: "Bearer value-two" });
    assert.equal((await patch(h.id, { headers: { "Not A Token": "x" } })).status, 400, "name is not an RFC 7230 token");
    assert.equal((await patch(h.id, { headers: { "X-B": "a\r\nb" } })).status, 400, "no line break in the value");
    const umb = await (await patch(h.id, { name: "network2", transport: "http", url: "http://127.0.0.1:9/mcp", enabled: true })).json();
    assert.deepEqual(umb.headers, [{ name: "Authorization", set: true }], "renaming keeps the headers");
    const stdio = await (await patch(h.id, { name: "network2", transport: "stdio", command: "true" })).json();
    assert.deepEqual(stdio.headers, [], "switching to stdio takes the headers along");
    assert.deepEqual(store.mcpHeadersValues(h.id), {});
  });
});

test("outer loop: token role outer_loop, only the choice of the agent, marker without card, live", { timeout: 60_000 }, async () => {
  await withAgentsServer(async ({ base, ws, chat, root }) => {
    const fake = path.join(root, "fake-stdio-ol.mjs");
    fs.writeFileSync(fake, FAKE_STDIO);
    const log = path.join(root, "fake-stdio-ol.log");
    const s = await json(`${base}/api/workspaces/${ws.id}/mcp-servers`, { method: "POST", body: JSON.stringify({ name: "fake", transport: "stdio", command: process.execPath, args: [fake], env: { FAKE_LOG: log } }) });
    await json(`${base}/api/mcp-servers/${s.id}/tools`, { method: "POST" });
    assert.equal(store.getMcpServerInternal(s.id).subagentsInherit, false, "\"subagents inherit\" is off");
    const a = store.createOuterLoopAgent({ id: "a7000000-0000-4000-8000-000000000007", workspaceId: ws.id, name: "Reader", trigger: [{ kind: "run_end" }], provider: "claude", model: "m", mcp: { [s.id]: ["read", "send"] } });
    const { servers } = writeMcpConfig(path.join(root, "ol.mcp.json"), { chatId: chat.id, workspaceId: ws.id, extraServers: store.effectiveMcpServers(ws.id, null), agentDepth: 1, agentId: "core-1", outerLoop: `${a.id}:run-7` });
    assert.ok(servers.fake, "the server is in the file without \"subagents inherit\"");
    const h = wrapper(servers.fake, root);
    try {
      running.add(chat.id);
      await h.question("initialize", INIT);
      h.report("notifications/initialized", {});
      assert.deepEqual((await h.question("tools/list", {})).result.tools.map((t) => t.name), ["read"], "only the choice, without the marked send");
      assert.equal(text(await h.question("tools/call", { name: "read", arguments: { y: 1 } })), 'ok:read:{"y":1}', "chosen and free goes through");
      assert.equal(text(await h.question("tools/call", { name: "third", arguments: {} })), texts.outerLoopNotSelected("third", "fake"), "not chosen");
      const marker = await h.question("tools/call", { name: "send", arguments: {} });
      assert.equal(text(marker), texts.outerLoopMarker(), "marked: one sentence instead of a card");
      assert.equal(openCard(chat.id, "mcp__fake__send"), undefined, "no card although a turn is running");
      assert.equal(calls(log, "send").length + calls(log, "third").length, 0, "nothing refused reached the server");
      // Live: the choice without the server => refused, without a new token.
      store.changeOuterLoopAgent(a.id, { mcp: {} });
      assert.equal(text(await h.question("tools/call", { name: "read", arguments: {} })), texts.outerLoopNotSelected("", "fake"));
      assert.equal(calls(log, "read").length, 1);
    } finally { running.delete(chat.id); await h.shutdown(); }
  });
});
