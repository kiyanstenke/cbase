// Network paths of the loop engine FOR an instance: WebFetch, WebSocket monitor and HTTP MCP (runtime/target.js,
// providers/tool-runtime.js, providers/monitor-runtime.js, providers/mcp-client.js).
//
// The promises, each with the way that breaks it:
//   (1) targetFor maps ONLY localhost, 127/8, ::1, 0.0.0.0 (with equivalent spellings) to the instance's IP, nothing without an
//       instance, nothing foreign; an instance without an IP throws (otherwise a local host would silently run in B).
//   (2)-(4) With an instance, WebFetch, the WebSocket monitor and an HTTP MCP server hit the service IN the instance for
//       "localhost:<p>" or "127.0.0.1:<p>" (here: the second loopback address, fake-docker.mjs secondLoopback), with the host
//       header of the URL. A DECOY (B's service) listens on 127.0.0.1 at the same port. Without an instance the same call hits
//       the decoy, as before.
//   (2b) Redirects: every hop is mapped anew: to localhost into the instance (never the decoy), outward NOT to the IP (here a
//       host under `.invalid`, RFC 2606: it never resolves; mapped, the request would arrive at the instance, unmapped it fails at
//       name resolution without the instance seeing it).
//   (2c) The WebFetch cache separates by instance: the same URL without an instance does not serve the instance's page from memory.
//   (5)/(6) The GUARD: with an instance NO unmapped host reaches a service of B: a name that the test lookup (`setNetworkSeam`)
//       points to 127.0.0.1 never hits the decoy: not via WebFetch, not after a redirect, not as HTTP MCP, not in the WebSocket
//       monitor; an IP literal of an interface of B is rejected before connecting. The instance IP itself and foreign hosts pass.
//   (7) With an instance requestInProject asks for compression and unpacks it; an empty encoded body is empty.
//   (8) The `timeout` field of an HTTP MCP server applies to tools/call (also WITHOUT an instance).
// Every promise is also stated with "127.0.0.1": on macOS the second loopback address is ::1 and "localhost" resolves to ::1 first,
// so old code would hit the instance with "localhost" by accident. Only "127.0.0.1" reliably hits the decoy without a mapping.
//
// COUNTER-TESTS: the three callers (tool-runtime, monitor-runtime, mcp-client) without the instance mapping => (2), (3), (4) red
// with "DECOY" instead of "INSTANCE"; targetFor mapping every hop to the IP => (2b) red (the instance gets /end); without the
// instance key in the cache => (2c) red. No clock: every server counts its requests, the tests wait for events.
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import test from "node:test";
import zlib from "node:zlib";
import { WebSocketServer } from "ws";

import { addressOfB, requestInProject, localHost, lookupInProject, networkOptions, setNetworkSeam, targetFor } from "../electron/server/runtime/target.js";
import { runBuiltinTool } from "../electron/server/providers/tool-runtime.js";
import { createMonitorRuntime } from "../electron/server/providers/monitor-runtime.js";
import { connectMcpServers } from "../electron/server/providers/mcp-client.js";
import { secondLoopback } from "./fake-docker.mjs";

const IP = await secondLoopback();
const INSTANCE = Object.freeze({ projectId: "p-network", instance: "main", identifier: "p-network/main", ip: IP });

// Wait for an event, without a deadline.
async function waitForTruthy(fn) { for (;;) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 20)); } }

function listen(server, host, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => { server.off("error", reject); resolve(server.address().port); });
  });
}
const close = (s) => new Promise((r) => { s.closeAllConnections?.(); s.close(() => r()); });

// Two HTTP servers on the SAME port: the instance on IP, the decoy on 127.0.0.1. `response(who, req, res)` answers.
async function paar(response) {
  for (let attempt = 0; ; attempt++) {
    const log = [];
    const build = (who) => http.createServer((req, res) => { log.push({ who, url: req.url, host: req.headers.host }); response(who, req, res); });
    const instance = build("INSTANCE");
    const port = await listen(instance, IP, 0);
    const decoy = build("DECOY");
    try {
      await listen(decoy, "127.0.0.1", port);
      return { port, log, shutdown: async () => { await close(instance); await close(decoy); } };
    } catch (e) {
      await close(instance);
      if (e.code !== "EADDRINUSE" || attempt > 20) throw e;
    }
  }
}
const page = (who, req, res) => {
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  res.end(`${who} host=${req.headers.host}`);
};

test("(1) targetFor: only localhost, 127/8, ::1, 0.0.0.0 map to the IP, URL/host/SNI stay; null without an instance and for foreign hosts; throws without an IP", () => {
  for (const url of ["http://localhost:5173/x", "http://LOCALHOST.:5173/", "http://127.0.0.1:5173/", "http://127.9.8.7:5173/", "http://[::1]:5173/",
    "http://0.0.0.0:5173/", "http://[::]:5173/", "http://[::ffff:127.0.0.1]:5173/", "http://2130706433:5173/"]) {
    const z = targetFor(url, INSTANCE);
    assert.ok(z, `${url} is mapped`);
    assert.equal(z.ip, IP);
    assert.equal(z.port, 5173);
    assert.equal(z.hostname, new URL(url).hostname.replace(/^\[|\]$/g, ""), "the host of the URL stays (host header, SNI)");
  }
  assert.deepEqual(targetFor("https://localhost/", INSTANCE), { ip: IP, port: 443, hostname: "localhost", secure: true, serverName: "localhost" });
  assert.equal(targetFor("wss://127.0.0.1/", INSTANCE).serverName, "", "no SNI for an IP");
  assert.equal(targetFor("ws://localhost/", INSTANCE).port, 80);
  for (const url of ["http://example.com/", "http://10.0.0.1:5173/", "http://checkout.example.com:5173/", "http://localhost.example.com/", "http://[::2]/", "http://128.0.0.1/"]) {
    assert.equal(targetFor(url, INSTANCE), null, `${url} stays as it is`);
  }
  assert.equal(targetFor("http://localhost:5173/", null), null, "without an instance the path as before");
  assert.throws(() => targetFor("http://localhost:1/", { projectId: "p", identifier: "p/main", ip: "" }), /has no IP/);
  assert.equal(targetFor("http://example.com/", { projectId: "p", ip: "" }), null, "a foreign host needs no IP");
  assert.equal(localHost("[::ffff:7f00:1]"), true);
  assert.equal(localHost("::ffff:a00:1"), false);
});

test("(2) WebFetch: with an instance localhost hits the instance (host header of the URL), without an instance the decoy as before; (2c) the cache separates by instance", async () => {
  const s = await paar(page);
  try {
    const fetch = (url, instance) => runBuiltinTool("WebFetch", { url }, { cwd: os.tmpdir(), addDirs: [], env: process.env, instance });
    let r = await fetch(`http://localhost:${s.port}/a`, INSTANCE);
    assert.equal(r.isError, false, r.content);
    assert.match(r.content, new RegExp(`INSTANCE host=localhost:${s.port}`), r.content);
    r = await fetch(`http://127.0.0.1:${s.port}/b`, INSTANCE);
    assert.match(r.content, new RegExp(`INSTANCE host=127\\.0\\.0\\.1:${s.port}`), r.content);
    // Without an instance: the same call as before (fetch), the service of B.
    r = await fetch(`http://127.0.0.1:${s.port}/c`, null);
    assert.match(r.content, /DECOY/, r.content);
    // (2c) The same URL the instance just delivered does NOT come from the cache without an instance.
    r = await fetch(`http://127.0.0.1:${s.port}/b`, null);
    assert.match(r.content, /DECOY/, `from the instance's cache: ${r.content}`);
    const second = { ...INSTANCE, projectId: "p-other", identifier: "p-other/main" };
    const prior = s.log.length;
    r = await fetch(`http://127.0.0.1:${s.port}/b`, second);
    assert.match(r.content, /INSTANCE/);
    assert.equal(s.log.length, prior + 1, "another instance fetches by itself");
    r = await fetch(`http://127.0.0.1:${s.port}/b`, INSTANCE);
    assert.match(r.content, /from the cache/, "the same instance gets its cache");
    assert.equal(s.log.filter((x) => x.who === "DECOY").map((x) => x.url).sort().join(","), "/b,/c", "the decoy saw only the fetches without an instance");
    // An instance without an IP: fails visibly, never silently in B.
    r = await fetch(`http://localhost:${s.port}/d`, { projectId: "p-empty", identifier: "p-empty/main", ip: "" });
    assert.equal(r.isError, true);
    assert.match(r.content, /has no IP/);
    assert.ok(!s.log.some((x) => x.url === "/d"), "nobody got /d");
  } finally { await s.shutdown(); }
});

test("(2b) WebFetch with an instance: redirects by hand; to localhost into the instance, outward NOT to the IP", async () => {
  // Only the instance redirects; the decoy always answers itself (a fetch that lands at it is visibly wrong).
  const s = await paar((who, req, res) => {
    if (who === "DECOY") { page(who, req, res); return; }
    if (req.url === "/after-local") { res.writeHead(302, { location: `http://localhost:${s.port}/end` }); res.end(); return; }
    if (req.url === "/after-outside") { res.writeHead(301, { location: `http://outside.invalid:${s.port}/end` }); res.end(); return; }
    page(who, req, res);
  });
  try {
    let r = await runBuiltinTool("WebFetch", { url: `http://127.0.0.1:${s.port}/after-local` }, { cwd: os.tmpdir(), instance: INSTANCE });
    assert.equal(r.isError, false, r.content);
    assert.match(r.content, new RegExp(`INSTANCE host=localhost:${s.port}`));
    assert.match(r.content, new RegExp(`URL: http://localhost:${s.port}/end`), "the final address is the one of the redirect");
    const prior = s.log.length;
    r = await runBuiltinTool("WebFetch", { url: `http://127.0.0.1:${s.port}/after-outside` }, { cwd: os.tmpdir(), instance: INSTANCE });
    assert.equal(r.isError, true, `nothing outward may go to the IP: ${r.content}`);
    assert.match(r.content, /Fetch failed/);
    assert.deepEqual(s.log.slice(prior).map((x) => [x.who, x.url]), [["INSTANCE", "/after-outside"]], "only the first hop reached the instance");
  } finally { await s.shutdown(); }
});

test("(3) WebSocket monitor: with an instance ws://localhost connects to the instance, without an instance to the decoy", async () => {
  const hs = [];
  let port;
  for (let attempt = 0; ; attempt++) {
    const inst = new WebSocketServer({ host: IP, port: 0 });
    await new Promise((r, j) => { inst.once("listening", r); inst.once("error", j); });
    port = inst.address().port;
    const decoy = new WebSocketServer({ host: "127.0.0.1", port });
    const ok = await new Promise((r) => { decoy.once("listening", () => r(true)); decoy.once("error", () => r(false)); });
    if (ok) { hs.push([inst, "INSTANCE"], [decoy, "DECOY"]); break; }
    await new Promise((r) => inst.close(r));
    if (attempt > 20) throw new Error("no common port");
  }
  for (const [srv, who] of hs) srv.on("connection", (sock, req) => sock.send(`${who} host=${req.headers.host}`));
  const events = [];
  const run = (instance) => createMonitorRuntime({ cwd: os.tmpdir(), instance, onNotification: (t, ev) => events.push({ id: t.taskId, out: ev.output }) });
  const withInstance = run(INSTANCE);
  const without = run(null);
  try {
    const a = withInstance.start({ ws: `ws://localhost:${port}/`, persistent: true });
    const b = withInstance.start({ ws: `ws://127.0.0.1:${port}/`, persistent: true });
    const c = without.start({ ws: `ws://127.0.0.1:${port}/`, persistent: true });
    const from = (t) => waitForTruthy(() => events.find((e) => e.id === t.taskId)?.out);
    assert.equal(await from(a), `INSTANCE host=localhost:${port}`);
    assert.equal(await from(b), `INSTANCE host=127.0.0.1:${port}`);
    assert.equal(await from(c), `DECOY host=127.0.0.1:${port}`, "without an instance as before");
    // Without an IP: the start fails visibly.
    assert.throws(() => run({ projectId: "p-empty", identifier: "p-empty/main", ip: "" }).start({ ws: `ws://localhost:${port}/` }), /has no IP/);
  } finally {
    withInstance.close();
    without.close();
    for (const [srv] of hs) { for (const c of srv.clients) c.terminate(); await new Promise((r) => srv.close(r)); }
  }
});

test("(4) HTTP MCP: with an instance the client talks to the server in the instance (host header of the URL), without an instance to the decoy", async () => {
  // A minimal streamable HTTP server: initialize, tools/list (tool name = who), tools/call (host header back).
  const s = await paar((who, req, res) => {
    let raw = "";
    req.on("data", (d) => { raw += d; });
    req.on("end", () => {
      const msg = JSON.parse(raw || "{}");
      if (msg.id === undefined) { res.writeHead(202); res.end(); return; }
      const result = msg.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: who, version: "1" } }
        : msg.method === "tools/list" ? { tools: [{ name: `${who.toLowerCase()}_tool`, inputSchema: { type: "object", properties: {} } }] }
          : msg.method === "tools/call" ? { content: [{ type: "text", text: `${who} host=${req.headers.host}` }] }
            : null;
      res.writeHead(200, { "content-type": "application/json", "mcp-session-id": `${who}-session` });
      res.end(JSON.stringify(result ? { jsonrpc: "2.0", id: msg.id, result } : { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no" } }));
    });
  });
  const pools = [];
  try {
    const including = await connectMcpServers({ project: { type: "http", url: `http://localhost:${s.port}/mcp` } }, { cwd: os.tmpdir(), instance: INSTANCE });
    pools.push(including);
    assert.deepEqual(including.errors, []);
    assert.deepEqual(including.tools.map((t) => t.name), ["mcp__project__instance_tool"]);
    const r = await including.call("mcp__project__instance_tool", {});
    assert.equal(r.content[0].text, `INSTANCE host=localhost:${s.port}`);
    // The same address that hits the decoy without an instance (127.0.0.1; on macOS "localhost" resolves ::1 first, which is
    // the instance itself here): with an instance the server in the instance.
    const withIp = await connectMcpServers({ project: { type: "http", url: `http://127.0.0.1:${s.port}/mcp` } }, { cwd: os.tmpdir(), instance: INSTANCE });
    pools.push(withIp);
    assert.deepEqual(withIp.tools.map((t) => t.name), ["mcp__project__instance_tool"]);
    assert.equal((await withIp.call("mcp__project__instance_tool", {})).content[0].text, `INSTANCE host=127.0.0.1:${s.port}`);
    const without = await connectMcpServers({ project: { type: "http", url: `http://127.0.0.1:${s.port}/mcp` } }, { cwd: os.tmpdir() });
    pools.push(without);
    assert.deepEqual(without.tools.map((t) => t.name), ["mcp__project__decoy_tool"], "without an instance as before");
    assert.ok(s.log.filter((x) => x.who === "INSTANCE").every((x) => [`localhost:${s.port}`, `127.0.0.1:${s.port}`].includes(x.host)), "the host header is the one of the URL");
  } finally {
    for (const p of pools) p.closeAll();
    await s.shutdown();
  }
});

// ── The guard, compression, HTTP MCP timeout ─────────────────────────────────────────────────────────────────────────
// Test lookup with the signature of dns.lookup (also `all`): names from a table (one address or a list), everything else
// ENOTFOUND, never the real DNS. `calls` shows that the path really went through the guard.
function testLookup(table, calls = []) {
  return (host, opts, cb) => {
    calls.push(host);
    const value = table[host];
    if (!value) { cb(Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" })); return; }
    const list = [].concat(value).map((address) => ({ address, family: net.isIPv6(address) ? 6 : 4 }));
    if (opts?.all) cb(null, list);
    else cb(null, list[0].address, list[0].family);
  };
}
const OF_B = /an address of B/;
// Interfaces of an invented B: loopback, eth0 (IPv4 + link-local with zone), the bridge of a project network.
const B = Object.freeze({
  lo: [{ address: "127.0.0.1", internal: true }, { address: "::1", internal: true }],
  eth0: [{ address: "172.20.0.5" }, { address: "fe80::1c:2", scopeid: 2 }],
  "cbp-9": [{ address: "10.230.9.1" }],
  // A TEST-NET literal (RFC 5737): never reachable, it is rejected BEFORE connecting.
  test0: [{ address: "192.0.2.7" }],
});

test("(5) Guard: addressOfB and lookupInProject; loopback, unspecified and interfaces of B rejected, instance and foreign hosts pass; networkOptions", async () => {
  for (const a of ["127.0.0.1", "127.8.9.10", "::1", "[::1]", "0:0:0:0:0:0:0:1", "0.0.0.0", "0.1.2.3", "::", "::ffff:127.0.0.1", "::ffff:7f00:1",
    "::ffff:0:0", "172.20.0.5", "::ffff:172.20.0.5", "10.230.9.1", "fe80::1c:2", "FE80::1C:2%eth0"]) {
    assert.equal(addressOfB(a, B), true, `${a} is B`);
  }
  for (const a of ["10.230.9.2", "172.20.0.6", "93.184.215.14", "2606:2800:220:1::1", "fe80::1c:3", "::2", "localhost", "", "no.ip"]) {
    assert.equal(addressOfB(a, B), false, `${a} is not B`);
  }
  const calls = [];
  const back = setNetworkSeam({
    lookup: testLookup({ "decoy.test": "127.0.0.1", "null.test": "0.0.0.0", "lan.test": "172.20.0.5", "bridge.test": "10.230.9.1",
      "v6.test": "::ffff:127.0.0.1", "outside.test": "192.0.2.10", "half.test": ["192.0.2.10", "::1"], "project.test": "10.230.9.2" }, calls),
    interfaces: () => B,
  });
  try {
    const question = (h, opts) => new Promise((r) => lookupInProject(h, opts, (e, address, family) => r({ e, address, family })));
    for (const h of ["decoy.test", "null.test", "lan.test", "bridge.test", "v6.test", "half.test"]) {
      // "half" (foreign AND ::1): rejected with `all` (this is how net.connect asks since Node 20, autoSelectFamily); without
      // `all` net connects only the FIRST answer, and that one is foreign (see below).
      for (const opts of h === "half.test" ? [{ all: true }] : [{}, { all: true }]) {
        const { e } = await question(h, opts);
        assert.ok(e, `${h} ${JSON.stringify(opts)} is rejected`);
        assert.equal(e.code, "ECBASETARGET");
        assert.match(e.message, OF_B);
      }
    }
    assert.deepEqual(await question("outside.test", { all: true }), { e: null, address: [{ address: "192.0.2.10", family: 4 }], family: undefined });
    assert.deepEqual(await question("outside.test", {}), { e: null, address: "192.0.2.10", family: 4 });
    assert.equal((await question("half.test", {})).address, "192.0.2.10", "without `all` what gets connected counts: the first answer");
    assert.equal((await question("project.test", {})).address, "10.230.9.2", "the IP of an instance is not an address of B");
    assert.equal((await question("missing.test", {})).e.code, "ENOTFOUND", "a resolution error stays itself");
    assert.ok(calls.includes("decoy.test"));
    // networkOptions: null without an instance, createConnection when mapped, otherwise the guard; a literal of B throws at once.
    assert.equal(networkOptions("http://decoy.test/", null), null);
    assert.equal(typeof networkOptions("http://localhost:1/", INSTANCE).createConnection, "function");
    assert.deepEqual(Object.keys(networkOptions("http://decoy.test:1/", INSTANCE)), ["lookup"]);
    assert.equal(typeof networkOptions("wss://aussen.test/", INSTANCE).lookup, "function", "the guard of the instance");
    for (const url of ["http://172.20.0.5:7718/", "http://[::ffff:172.20.0.5]:7718/", "ws://10.230.9.1:7718/", "http://192.0.2.7/"]) {
      assert.throws(() => networkOptions(url, INSTANCE), OF_B, url);
    }
    // The project network of ANOTHER project is off limits with an instance.
    assert.throws(() => networkOptions("http://10.230.9.2:5173/", INSTANCE), /another project/);
    assert.deepEqual(Object.keys(networkOptions("http://93.184.215.14:5173/", INSTANCE)), ["lookup"], "foreign addresses pass");
  } finally { back(); }
});

const mcpResponse = (who) => (req, res) => {
  let raw = "";
  req.on("data", (d) => { raw += d; });
  req.on("end", () => {
    const msg = JSON.parse(raw || "{}");
    if (msg.id === undefined) { res.writeHead(202); res.end(); return; }
    const result = msg.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: who, version: "1" } }
      : msg.method === "tools/list" ? { tools: [{ name: "tool", inputSchema: { type: "object", properties: {} } }] }
        : msg.method === "tools/call" ? { content: [{ type: "text", text: `${who} host=${req.headers.host}` }] }
          : null;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(result ? { jsonrpc: "2.0", id: msg.id, result } : { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no" } }));
  });
};

test("(6) Guard: with an instance a name that points to 127.0.0.1 NEVER reaches the decoy: WebFetch, redirect, HTTP MCP, WebSocket monitor; a literal of B fails before connecting", async () => {
  // The instance redirects to the name; the decoy answers everything (a fetch that lands at it is visibly wrong).
  const s = await paar((who, req, res) => {
    if (who === "INSTANCE" && req.url === "/to-name") { res.writeHead(302, { location: `http://decoy.test:${s.port}/detour` }); res.end(); return; }
    page(who, req, res);
  });
  const wsDecoy = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((r, j) => { wsDecoy.once("listening", r); wsDecoy.once("error", j); });
  let wsConnections = 0;
  wsDecoy.on("connection", (sock) => { wsConnections += 1; sock.send("DECOY"); });
  const calls = [];
  const back = setNetworkSeam({ lookup: testLookup({ "decoy.test": "127.0.0.1" }, calls), interfaces: () => ({ ...os.networkInterfaces(), test0: B.test0 }) });
  const events = [];
  const monitor = createMonitorRuntime({ cwd: os.tmpdir(), instance: INSTANCE, onNotification: (t, ev) => events.push({ id: t.taskId, out: ev.output, status: ev.status }) });
  const pools = [];
  try {
    const fetch = (url) => runBuiltinTool("WebFetch", { url }, { cwd: os.tmpdir(), instance: INSTANCE });
    // (a) WebFetch on the name.
    let r = await fetch(`http://decoy.test:${s.port}/watch-name`);
    assert.equal(r.isError, true, `the name reached something: ${r.content}`);
    assert.match(r.content, OF_B);
    // (b) The instance redirects to the name: the first hop goes into the instance, the second nowhere.
    r = await fetch(`http://127.0.0.1:${s.port}/to-name`);
    assert.equal(r.isError, true, `the redirect reached something: ${r.content}`);
    assert.match(r.content, OF_B);
    // (c) HTTP MCP on the name.
    const mcp = await connectMcpServers({ foreign: { type: "http", url: `http://decoy.test:${s.port}/mcp` } }, { cwd: os.tmpdir(), instance: INSTANCE });
    pools.push(mcp);
    assert.deepEqual(mcp.tools, []);
    assert.equal(mcp.errors.length, 1);
    assert.match(mcp.errors[0].error, OF_B);
    // (d) The WebSocket monitor on the name: the failure arrives as an event (resolution is asynchronous).
    const t = monitor.start({ ws: `ws://decoy.test:${wsDecoy.address().port}/`, persistent: true });
    const ev = await waitForTruthy(() => events.find((e) => e.id === t.taskId));
    assert.equal(ev.status, "failed");
    assert.match(ev.out, OF_B);
    // (e) net.connect does not resolve an IP literal of an interface of B: it fails before connecting.
    r = await fetch("http://192.0.2.7:9/watch-literal");
    assert.equal(r.isError, true);
    assert.match(r.content, OF_B);
    assert.throws(() => monitor.start({ ws: "ws://192.0.2.7:9/" }), OF_B);
    // The path went through the guard (not past a missing name), and the decoy saw nothing.
    assert.ok(calls.filter((h) => h === "decoy.test").length >= 4, `lookup calls: ${calls.join(",")}`);
    assert.deepEqual(s.log.filter((x) => x.who === "DECOY").map((x) => x.url), [], "the decoy got nothing");
    assert.deepEqual(s.log.map((x) => [x.who, x.url]), [["INSTANCE", "/to-name"]], "only the mapped first hop arrived");
    assert.equal(wsConnections, 0, "the WebSocket decoy got no connection");
  } finally {
    back();
    monitor.close();
    for (const p of pools) p.closeAll();
    for (const c of wsDecoy.clients) c.terminate();
    await new Promise((r) => wsDecoy.close(r));
    await s.shutdown();
  }
});

test("(7) requestInProject asks for compression, unpacks it, and an empty encoded body is empty", async () => {
  const s = await paar((who, req, res) => {
    const ae = req.headers["accept-encoding"];
    if (req.url === "/empty") { res.writeHead(200, { "content-encoding": "gzip", "content-length": "0", "content-type": "text/plain" }); res.end(); return; }
    const text = `${who} ae=${ae ?? "-"}`;
    if (/\bgzip\b/.test(ae || "")) {
      const z = zlib.gzipSync(text);
      res.writeHead(200, { "content-encoding": "gzip", "content-length": String(z.length), "content-type": "text/plain" });
      res.end(z);
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(text);
  });
  try {
    let r = await requestInProject(`http://127.0.0.1:${s.port}/a`, {}, INSTANCE);
    assert.equal(await r.text(), "INSTANCE ae=gzip, deflate, br");
    r = await requestInProject(`http://127.0.0.1:${s.port}/b`, { headers: { "Accept-Encoding": "identity" } }, INSTANCE);
    assert.equal(await r.text(), "INSTANCE ae=identity", "a header of the caller's own applies");
    r = await requestInProject(`http://127.0.0.1:${s.port}/empty`, {}, INSTANCE);
    assert.equal(r.status, 200);
    assert.equal(await r.text(), "");
    const w = await runBuiltinTool("WebFetch", { url: `http://127.0.0.1:${s.port}/compression` }, { cwd: os.tmpdir(), instance: INSTANCE });
    assert.match(w.content, /INSTANCE ae=gzip, deflate, br/, w.content);
    assert.equal(s.log.filter((x) => x.who === "DECOY").length, 0);
  } finally { await s.shutdown(); }
});

test("(8) HTTP MCP: the `timeout` field of the configuration applies to tools/call, also without an instance", async () => {
  const server = http.createServer(mcpResponse("MCP"));
  const port = await listen(server, "127.0.0.1", 0);
  const real = globalThis.setTimeout;
  const pools = [];
  try {
    const url = `http://127.0.0.1:${port}/mcp`;
    const pool = await connectMcpServers({ long: { type: "http", url, timeout: 600_000 }, preset: { type: "http", url } }, { cwd: os.tmpdir() });
    pools.push(pool);
    assert.deepEqual(pool.errors, []);
    // Which time limit the call sets is seen at the client's setTimeout, without waiting for a duration.
    const deadline = async (tool) => {
      const provided = [];
      globalThis.setTimeout = (fn, ms, ...rest) => { provided.push(ms); return real(fn, ms, ...rest); };
      try { assert.equal((await pool.call(tool, {})).content[0].text, `MCP host=127.0.0.1:${port}`); } finally { globalThis.setTimeout = real; }
      return provided;
    };
    assert.ok((await deadline("mcp__long__tool")).includes(600_000), "timeout: 600000 from the configuration");
    assert.ok((await deadline("mcp__preset__tool")).includes(120_000), "without the field the default 120 s");
  } finally {
    globalThis.setTimeout = real;
    for (const p of pools) p.closeAll();
    await close(server);
  }
});

// ── Foreign project networks, encoding lists, v4-compatible spelling ──────────────────────────────────────────────────────
// (9)  With an instance EVERY address from the range of the project networks (10.230/16) except its own is off limits: a name
//      that points to the project network of ANOTHER project, and the same as an IP literal. The guard knows the instance for
//      that (closure per instance, own agent pool per identifier); the shared pool with `lookupInProject` did not know it.
// (10) `content-encoding` is a LIST ("gzip, br" = first gzip, then br): unpacked in reverse order; an unknown encoding is not
//      unpacked, more than five are an error.
// (11) The v4-compatible spelling `::hhhh:hhhh` (the URL turns `::127.0.0.1` into `::7f00:1`) is IPv4.
// COUNTER-TESTS (runtime/target.js, one line sabotaged each): `foreignProjectNetwork` always returns false => (9) red;
//   `unpacker` takes only the last member => (10) red; the line for `::hhhh:hhhh` in `canonical` removed => (11) red.
const NEIGHBOR = Object.freeze({ projectId: "p-own", instance: "main", identifier: "p-own/main", ip: "10.230.3.2" });

test("(9) Guard per instance: another project network is off limits as a name, as a literal and on the way through requestInProject; the own IP and foreign hosts pass", async () => {
  const { LEVEL2_AREA } = await import("../electron/server/projectbox/creation.js");
  const { PROJECT_NETWORKS } = await import("../electron/server/runtime/target.js");
  assert.equal(PROJECT_NETWORKS, LEVEL2_AREA, "runtime/target.js and projectbox/creation.js name the same range");
  const back = setNetworkSeam({
    lookup: testLookup({ "neighbor.test": "10.230.9.2", "own.test": "10.230.3.2", "outside.test": "192.0.2.10", "mixed.test": ["192.0.2.10", "10.230.200.7"] }),
    interfaces: () => B,
  });
  try {
    const watch = networkOptions("http://neighbor.test:5173/", NEIGHBOR).lookup;
    assert.equal(typeof watch, "function");
    const question = (h, opts = {}) => new Promise((r) => watch(h, opts, (e, address) => r({ e, address })));
    for (const [h, opts] of [["neighbor.test", {}], ["neighbor.test", { all: true }], ["mixed.test", { all: true }]]) {
      const { e } = await question(h, opts);
      assert.equal(e?.code, "ECBASETARGET", `${h} ${JSON.stringify(opts)}: ${e?.message}`);
      assert.match(e.message, /another project/);
    }
    assert.equal((await question("own.test")).address, "10.230.3.2", "the own IP passes");
    assert.equal((await question("outside.test")).address, "192.0.2.10", "foreign hosts pass");
    // The literal: rejected at once; the own IP and a public address are not.
    assert.throws(() => networkOptions("http://10.230.9.2:5173/", NEIGHBOR), /another project/);
    assert.throws(() => networkOptions("http://[::ffff:10.230.9.2]:5173/", NEIGHBOR), /another project/);
    assert.deepEqual(Object.keys(networkOptions("http://10.230.3.2:5173/", NEIGHBOR)), ["lookup"]);
    assert.deepEqual(Object.keys(networkOptions("http://192.0.2.10/", NEIGHBOR)), ["lookup"]);
    // The real path (own agent pool per identifier): the request fails at the guard, not at a connection.
    await assert.rejects(requestInProject("http://neighbor.test:9/", {}, NEIGHBOR), (e) => e.code === "ECBASETARGET" && /another project/.test(e.message));
    // Without an instance the guard knows no project of its own: the project network is no address of B there (as before).
    const without = await new Promise((r) => lookupInProject("neighbor.test", {}, (e, address) => r({ e, address })));
    assert.equal(without.address, "10.230.9.2");
  } finally { back(); }
});

test("(10) requestInProject unpacks an encoding LIST in reverse order; unknown stays raw, more than five are an error", async () => {
  const s = await paar((who, req, res) => {
    const text = Buffer.from(`${who} HELLO`);
    if (req.url === "/gzip-br") { const z = zlib.brotliCompressSync(zlib.gzipSync(text)); res.writeHead(200, { "content-encoding": "gzip, br" }); res.end(z); return; }
    if (req.url === "/gzip") { const z = zlib.gzipSync(text); res.writeHead(200, { "content-encoding": "gzip" }); res.end(z); return; }
    if (req.url === "/identity") { const z = zlib.gzipSync(text); res.writeHead(200, { "content-encoding": "identity, gzip" }); res.end(z); return; }
    if (req.url === "/unknown") { res.writeHead(200, { "content-encoding": "gzip, zstd-invented" }); res.end(text); return; }
    if (req.url === "/six") { res.writeHead(200, { "content-encoding": "gzip, gzip, gzip, gzip, gzip, gzip" }); res.end(text); return; }
    res.writeHead(404); res.end();
  });
  try {
    const fetch = (path) => requestInProject(`http://127.0.0.1:${s.port}${path}`, {}, INSTANCE);
    assert.equal(await (await fetch("/gzip-br")).text(), "INSTANCE HELLO");
    assert.equal(await (await fetch("/gzip")).text(), "INSTANCE HELLO", "plain gzip as before");
    assert.equal(await (await fetch("/identity")).text(), "INSTANCE HELLO", "identity is skipped");
    assert.equal(await (await fetch("/unknown")).text(), "INSTANCE HELLO", "an unknown encoding is not unpacked");
    await assert.rejects(fetch("/six"), /encodings/);
    assert.equal(s.log.filter((x) => x.who === "DECOY").length, 0);
  } finally { await s.shutdown(); }
});

test("(11) the v4-compatible spelling ::hhhh:hhhh is IPv4, local and of B; :: and ::1 stay", () => {
  assert.equal(localHost("[::7f00:1]"), true);
  assert.equal(localHost("::7f00:1"), true);
  assert.equal(addressOfB("::7f00:1", B), true);
  assert.equal(addressOfB("::127.0.0.1", B), true);
  assert.equal(addressOfB("::ac14:5", B), true, "172.20.0.5 v4-compatible");
  assert.equal(targetFor("http://[::7f00:1]:5173/", INSTANCE)?.ip, IP, "mapped like 127.0.0.1");
  assert.equal(localHost("::"), true);
  assert.equal(localHost("::1"), true);
  assert.equal(localHost("::5db8:d70e"), false, "93.184.215.14 is not local");
  assert.equal(addressOfB("::5db8:d70e", B), false);
  assert.equal(addressOfB("::2", B), false);
});
