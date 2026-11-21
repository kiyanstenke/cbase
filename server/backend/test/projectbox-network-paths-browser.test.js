// Network paths of the backend into a project container - the part browser, profiles and inspector. The ports, tunnels and
// probes are in projectbox-network-paths.test.js; the profiles' lock check is in browser-profiles.test.js.
//
// A Chromium or a Node inspector in the project container listens on ITS loopback and reports `ws://127.0.0.1:<p>/...`. B
// reaches it through the instance's IP (DNAT at eth0). Every connection from B - CDP client, /json/version, DevTools proxy
// with upgrade, inspector - must go there, with `Host: <IP>:<port>`; at the same port on 127.0.0.1 a service of B would sit.
//
// THE INSTRUMENT. A fake DevTools server after the measured Chromium: a host that is no IP and not localhost gives 500 ("Host
// header is specified and is not an IP address or localhost."); a WebSocket WITH an origin 403 (without
// --remote-allow-origins); it builds `webSocketDebuggerUrl` from the request's host. It listens on the second loopback address
// (fake-docker.mjs secondLoopback - the "instance's IP"), a DECOY of the same build on 127.0.0.1 at the SAME port: whoever
// forgets the host hits the decoy, and the test sees it in its log. (T0) shows that the instrument has the three properties.
//
// The promises, each with the way that breaks it:
//   (T1) Scanner of the agent browsers: a root `{ root, host, identifier }` is asked at `host`, the session is called
//        `agent:<identifier>:<dir>:<port>` and carries `debugHost`; the same port file in a B root goes to 127.0.0.1 under the
//        old key - two browsers, two namespaces. The upgrade of the instance session goes to the IP with `Host: <IP>:<port>`,
//        the caller's origin is dropped; HTTP no longer goes to the instance at all (T10, T12).
//   (T2) Browser tab of a converted project (`proj:<id>`): start in the instance (docker exec), the stderr address
//        `ws://127.0.0.1:<p>` is rewritten to the IP; without an instance it starts in B and talks to 127.0.0.1 (no exec); an
//        instance without an IP throws before the start.
//   (T3) Inspector (debug.js): the same for `node --inspect-brk` - with an instance to the IP, without to 127.0.0.1, without IP no start.
//   (T4) Server seam (server.js -> projectbox/browser-network.js agentScanRoots): without the operating mark the root of a
//        converted project is a string (127.0.0.1); with it it carries IP and identifier, and the SERVER's scanner
//        (agentScanCycle) asks the instance. No docker call. A converted instance WITHOUT an IP drops out completely in
//        operation (neither path nor object), without operation it is a path.
//   (T5) The instance's answer on /json/version is a claim, not truth - a ws URL to a service of B, a redirect there, a foreign
//        port or path at the instance, a query, http: instead of ws: give NO session and no fetch outside the instance;
//        127.0.0.1 at the own port is pinned to the IP.
//   (T6) the same set for the fallback poll of the browser tab: it follows no redirect and keeps polling until stderr comes.
//   (T7) an instance root without `host` drops out, never 127.0.0.1.
//   (T8) agentScanRoots per instance of the chat - without a source (setBrowserChatInstance) the root as before, with it one
//        entry per instance with its IP and `only`; without IP, without row, a throwing source: the profile is skipped.
//   (T9) in a root with `only` the scanner reads only the profiles for which it is true.
//   (T10) no HTTP goes to the debug port of an instance - the static DevTools files come from the source in B
//        (projectbox/devtools-ui.js, same version), without script and without Set-Cookie/Clear-Site-Data/Refresh/Link/
//        Service-Worker-Allowed of the container; the WebSocket goes only for `/page|browser/<id>`, with allow list and
//        filtered 101; other methods 405; B unchanged.
//   (T11) ensureUserBrowser reuses a session only where the browser is supposed to run.
//   (T12) if no UI fits in B (version, revision, unreadable version, source does not start), B answers with the notice page
//        (409, mark `cbase-devtools`) - never with files of the container; with an unreadable version the source does not start.
//   (T13) the pure parts: `revisionValue`/`revisionFromVersion` and the header filter for raw headers (every spelling, with continuation).
//   (T14) the scanner reads an instance root only up to `ENTRIES_PER_ROOT` - entries that `only` discards count too; in B it
//        reads as before.
//   (T15) the screencast script is executable under the real meta CSP of inspector.html (same-origin file instead of an
//        inline <script>), cbase answers it itself, and it clicks only once enabled and until the mirror is off (vm context,
//        clocked by hand).
//
// COUNTER-TESTS (each shown red, then reverted):
//   browsers.js with 127.0.0.1 instead of `host` in the scanner fetch => (T1) and (T4) red (the decoy gets both); the key
//   without identifier => (T1) and (T4) red (the instance root is skipped); proxyDevtools at 127.0.0.1 => (T1) and (T2) red; its
//   Host header 127.0.0.1 => (T1) red; the upgrade's Host header as a name => (T1) red (500); the upgrade at 127.0.0.1 => (T1)
//   red; launchUserBrowser without rewriting the stderr address => (T2) red; debug.js without the rewriting => (T3) red; server.js
//   with the old roots `() => allLocations().map(playwrightProfileRoot)` => (T4) red.
//   browsers.js before the repair => (T5) red in all eight cases (the service of B got `ws /api/tunnel?port=5432`,
//   `ws /devtools/browser/x`, `http /json/version` + `ws ...`; the decoy `ws 127.0.0.1:<P>`; at the instance sessions arose over
//   a foreign port, foreign path, query and http:) and (T6) red (the poll followed the 302 to the service of B); without one
//   check each in wsUrlTheInstance (protocol, port, path, query, pinning) => exactly its case in (T5) red; `redirect: "error"`
//   removed => (T5) "redirect" and (T6) red; startAgentScan with `host || "127.0.0.1"` => (T7) red; agentScanRoots with the root
//   of an instance without IP as a path => (T4) red.
//   browser-network.js with the copy at the main's line (`if (i !== MAIN)` -> `if (false)`) => (T8) red; browsers.js without `only`
//   in the reading => (T9) red (the second profile asked).
//   browsers.js/response-header.js in the old state with an ineffective shell of the new exports => (T1), (T2), (T10) "script of
//   the container reached the user", (T12), (T14) "4097 entries read" red; one sabotage each in the new state: without filter of
//   the 101, without header filter of the source, without path check of the WebSocket => (T10) red each; without read cap =>
//   (T14) red ("4097 ... cap 2048"); browsers.js in the old state => (T11) red (the same id, debugHost 127.0.0.1); (T15)
//   browsers.js in the old state => red (inline script behind the meta CSP, not executable); the old click logic
//   (clearInterval at the first find, one click) => red ("slow setup": the mirror stays on).
//
// Waiting is on events (a whole scanner pass, the fakes' log, the end of a debug session), never on a duration. Connections
// are closed in the finally, `closeAllConnections` before `close`.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { WebSocket as WsClient, WebSocketServer } from "ws";

import {
  agentScanCycle, attachBrowserDevtools, closeBrowser, stopDevtoolsSource, ENTRIES_PER_ROOT, ensureUserBrowser, getBrowser,
  listBrowsers, PROFILES_PER_ROOT, proxyDevtools, startAgentScan,
} from "../electron/server/browsers.js";
import { revision as revisionValue, revisionFromVersion } from "../electron/server/projectbox/devtools-ui.js";
import { rawHeaderWithoutForbidden, FORBIDDEN_RESPONSE_HEADERS } from "../electron/server/runtime/response-header.js";
import { debugLaunch, debugStop, debugSubscribe } from "../electron/server/debug.js";
import { openEscalations, openCatchUpKills, setInProjectSeam } from "../electron/server/runtime/inProject.js";
import { dockerKind, dockerProgram } from "../electron/server/projectbox/docker.js";
import { agentScanRoots, setBrowserChatInstance } from "../electron/server/projectbox/browser-network.js";
import { locationFor } from "../electron/server/runs/runtime-location.js";
import * as store from "../electron/server/store.js";
import { fakeDocker, hostPort, secondLoopback } from "./fake-docker.mjs";
import { json, withAgentsServer } from "./agent-harness.mjs";

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitForTruthy(what, fn) {
  for (;;) {
    const v = await fn();
    if (v) return v;
    await pause(25);
  }
}
const mkdtemp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `cbase-s14-${n}-`));

// ── the instrument ─────────────────────────────────────────────────────────────────────────────────────────────────
function hostAllowed(header) {
  const h = String(header || "");
  const name = h.startsWith("[") ? h.slice(1, h.indexOf("]")) : h.split(":")[0];
  return net.isIP(name) !== 0 || name === "localhost";
}
// `version(req)` (T5, T6): an own answer on /json/version - `{ status, headers, body }` - instead of Chromium's; so the instance
// plays one that wants to send B somewhere else.
// `product`/`revision` (T10/T12): the answer on `Browser.getVersion` over CDP (without: `{}` like any other method).
// `malicious` (T10): a project container that serves script under its debug port and wants to SET something at the user -
// every HTTP answer under /devtools/ is `<script>...` with Set-Cookie, Set-Cookie2, Clear-Site-Data, Refresh, Link and
// Service-Worker-Allowed, and the WebSocket's 101 carries the same lines.
const MALICIOUS_HEADER = {
  "Set-Cookie": "cbase_session=FROM-CONTAINER; Path=/; HttpOnly", "Set-Cookie2": "x=1", "Clear-Site-Data": "\"cookies\", \"storage\"",
  Refresh: "0; url=https://foreign.example/", Link: "</boese.js>; rel=preload; as=script", "Service-Worker-Allowed": "/",
};
const MALICIOUS_ROWS = ["set-cookie", "set-cookie2", "clear-site-data", "refresh", "link", "service-worker-allowed"];
function fakeDevtools(name, { version = null, product = "", revision = "", malicious = false } = {}) {
  const requests = [];
  const socks = new Set();
  const server = http.createServer((req, res) => {
    requests.push({ kind: "http", url: req.url, host: req.headers.host || "", origin: req.headers.origin || "", header: { ...req.headers } });
    if (!hostAllowed(req.headers.host)) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Host header is specified and is not an IP address or localhost.");
      return;
    }
    if (req.url === "/json/version" && version) {
      const a = version(req);
      res.writeHead(a.status, { "Content-Type": "application/json", ...(a.headers || {}) });
      res.end(a.body === undefined ? "" : JSON.stringify(a.body));
      return;
    }
    if (req.url === "/json/version") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ Browser: `Fake/${name}`, webSocketDebuggerUrl: `ws://${req.headers.host}/devtools/browser/${name}` }));
      return;
    }
    if (malicious && req.url.startsWith("/devtools/")) {
      res.writeHead(200, { "Content-Type": "text/html", ...MALICIOUS_HEADER });
      res.end(`<script>fetch("/api/projects")</script>${name}`);
      return;
    }
    if (req.url.startsWith("/devtools/inspector.html")) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html>${name}</html>`);
      return;
    }
    // A page as a project container can serve under its debug port - with script.
    if (req.url.startsWith("/devtools/malicious.html")) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<script>fetch("/api/projects")</script>${name}`);
      return;
    }
    res.writeHead(404); res.end();
  });
  const wss = new WebSocketServer({ noServer: true });
  if (malicious) wss.on("headers", (rows) => { for (const [k, v] of Object.entries(MALICIOUS_HEADER)) rows.push(`${k}: ${v}`); });
  server.on("upgrade", (req, socket, head) => {
    requests.push({ kind: "ws", url: req.url, host: req.headers.host || "", origin: req.headers.origin || "", header: { ...req.headers } });
    if (req.headers.origin) { socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n"); return; }
    if (!hostAllowed(req.headers.host)) { socket.end("HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\n\r\n"); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      socks.add(ws);
      ws.on("close", () => socks.delete(ws));
      ws.on("message", (d) => {
        let m = null;
        try { m = JSON.parse(String(d)); } catch { /* echo */ }
        const result = m?.method === "Browser.getVersion" && product ? { protocolVersion: "1.3", product, revision, userAgent: "TestBench", jsVersion: "1" } : {};
        ws.send(m && m.id !== undefined && m.method ? JSON.stringify({ id: m.id, result }) : String(d));
      });
    });
  });
  return {
    name, server, requests,
    kinds: () => requests.map((a) => `${a.kind} ${a.host}${a.origin ? ` origin=${a.origin}` : ""}`),
    async shutdown() {
      for (const ws of socks) { try { ws.terminate(); } catch {} }
      server.closeAllConnections?.();
      await new Promise((r) => server.close(() => r()));
    },
  };
}
const listen = (server, port, host) => new Promise((resolve, reject) => {
  const error = (e) => reject(e);
  server.once("error", error);
  server.listen(port, host, () => { server.off("error", error); resolve(); });
});
// Instance (second loopback) and decoy (127.0.0.1) at the SAME port.
async function paar(ip, opts = {}) {
  for (;;) {
    const inst = fakeDevtools("instance", opts);
    await listen(inst.server, 0, ip);
    const P = inst.server.address().port;
    const decoy = fakeDevtools("decoy");
    try {
      await listen(decoy.server, P, "127.0.0.1");
      return { inst, decoy, P, shutdown: async () => { await inst.shutdown(); await decoy.shutdown(); } };
    } catch { await inst.shutdown(); }
  }
}
// A raw HTTP fetch with a free Host header (fetch sets it itself).
function raw(host, port, filePath, header) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host, port, path: filePath, headers: header, agent: false }, (res) => {
      let b = "";
      res.on("data", (d) => { b += d; });
      res.on("end", () => resolve({ status: res.statusCode, body: b, headers: res.headers }));
    });
    r.on("error", reject);
    r.end();
  });
}
// A WebSocket attempt: resolves with `{ status, ws }` (101 = open), never with a deadline.
function wsAttempt(url, opts = {}) {
  return new Promise((resolve) => {
    const ws = new WsClient(url, { perMessageDeflate: false, ...opts });
    ws.once("open", () => resolve({ status: 101, ws }));
    ws.once("unexpected-response", (_req, res) => { resolve({ status: res.statusCode, ws: null }); try { ws.terminate(); } catch {} });
    ws.once("error", (e) => resolve({ status: 0, error: e.message, ws: null }));
  });
}
const echo = (ws, text) => new Promise((resolve) => { ws.once("message", (d) => resolve(String(d))); ws.send(text); });

// A small server with the DevTools proxy like devtools/routes.js and the upgrade (attachBrowserDevtools, without fence).
async function proxyServer() {
  const srv = http.createServer((req, res) => {
    const m = (req.url || "").match(/^\/api\/browsers\/([^/]+)\/devtools(\/.*)$/);
    if (m) return proxyDevtools(m[1], req, res, `/devtools${m[2]}`);
    res.writeHead(404); res.end();
  });
  attachBrowserDevtools(srv);
  // A taken-over socket (upgrade) still counts for `close`, but `closeAllConnections` does not reach it - a test that fails
  // with an open WebSocket would otherwise hang in the finally. `shutdown` ends them itself.
  const takenOver = new Set();
  srv.on("upgrade", (_req, socket) => { takenOver.add(socket); socket.once("close", () => takenOver.delete(socket)); });
  await listen(srv, 0, "127.0.0.1");
  return {
    srv, port: srv.address().port,
    shutdown: () => new Promise((r) => { for (const s of takenOver) s.destroy(); srv.closeAllConnections?.(); srv.close(() => r()); }),
  };
}

const IP = await secondLoopback();

// ── (T0) ───────────────────────────────────────────────────────────────────────────────────────────────────────────
test("(T0) the instrument behaves like the measured Chromium - 500 for names, 403 with origin, URL from the host", async () => {
  const f = await paar(IP);
  try {
    const name = await raw(IP, f.P, "/json/version", { Host: `shop.cbase:${f.P}` });
    assert.equal(name.status, 500, "a name never works");
    const ipv = await raw(IP, f.P, "/json/version", { Host: hostPort(IP, f.P) });
    assert.equal(JSON.parse(ipv.body).webSocketDebuggerUrl, `ws://${hostPort(IP, f.P)}/devtools/browser/instance`, "built from the host");
    const withOrigin = await wsAttempt(`ws://${hostPort(IP, f.P)}/devtools/page/1`, { origin: "http://foreign.example" });
    assert.equal(withOrigin.status, 403, "a WebSocket with an origin is rejected");
    const without = await wsAttempt(`ws://${hostPort(IP, f.P)}/devtools/page/1`);
    assert.equal(without.status, 101);
    without.ws.close();
    assert.deepEqual(f.decoy.requests, [], "the decoy stayed untouched");
  } finally { await f.shutdown(); }
});

// ── (T1) ───────────────────────────────────────────────────────────────────────────────────────────────────────────
test("(T1) the scanner asks the instance's IP and keeps its browser under the identifier; DevTools proxy and upgrade follow", async () => {
  const f = await paar(IP);
  const tmp = mkdtemp("scan");
  const rootB = path.join(tmp, "b");
  const rootI = path.join(tmp, "instance");
  for (const w of [rootB, rootI]) {
    fs.mkdirSync(path.join(w, "chat-s14t1"), { recursive: true });
    fs.writeFileSync(path.join(w, "chat-s14t1", "DevToolsActivePort"), `${f.P}\n/devtools/browser/x`);
  }
  const scan = startAgentScan(() => [rootB, { root: rootI, host: IP, identifier: "ps14t1/main" }], {
    describeProfile: () => ({ label: "S14", workspaceId: "ws-s14" }),
  });
  const px = await proxyServer();
  try {
    await scan.cycle();
    const list = listBrowsers().filter((b) => b.profile === "chat-s14t1");
    assert.deepEqual(list.map((b) => b.scopeKey).sort(), [`agent:chat-s14t1:${f.P}`, `agent:ps14t1/main:chat-s14t1:${f.P}`].sort(),
      "two browsers: the same folder and port in B and in the instance");
    const inI = list.find((b) => b.scopeKey.startsWith("agent:ps14t1/"));
    const inB = list.find((b) => b.scopeKey === `agent:chat-s14t1:${f.P}`);
    assert.equal(getBrowser(inI.id).debugHost, IP);
    assert.equal(getBrowser(inB.id).debugHost, "127.0.0.1");
    assert.deepEqual(f.inst.kinds(), [`http ${hostPort(IP, f.P)}`, `ws ${hostPort(IP, f.P)}`], "the instance: /json/version and CDP at its IP");
    assert.deepEqual(f.decoy.kinds(), [`http 127.0.0.1:${f.P}`, `ws 127.0.0.1:${f.P}`], "B as before");

    // DevTools proxy (HTTP): NO HTTP goes to the instance. Its browser reports no version here (the instrument answers
    // Browser.getVersion with `{}`) - so the notice from B, without B starting its source; neither instance nor decoy sees anything.
    const httpPrior = f.inst.requests.length;
    const html = await raw("127.0.0.1", px.port, `/api/browsers/${inI.id}/devtools/inspector.html`, { Origin: "http://foreign.example" });
    assert.equal(html.status, 409);
    assert.match(html.body, /<meta name="cbase-devtools" content="no-ui" data-reason="instance"/);
    assert.doesNotMatch(html.body, /<html>instance<\/html>/, "the page came from the instance");
    assert.equal(f.inst.requests.length, httpPrior, "HTTP at the instance's debug port");
    // Upgrade: to the IP, Host <IP>:<port>, the caller's origin is dropped (Chromium: 403 with origin).
    const up = await wsAttempt(`ws://127.0.0.1:${px.port}/api/browsers/${inI.id}/devtools/page/1`, { origin: "http://foreign.example" });
    assert.equal(up.status, 101, JSON.stringify(up));
    assert.equal(await echo(up.ws, "through the proxy"), "through the proxy");
    up.ws.close();
    const last = f.inst.requests.at(-1);
    assert.deepEqual([last.kind, last.url, last.host, last.origin], ["ws", "/devtools/page/1", hostPort(IP, f.P), ""]);
    assert.equal(f.decoy.requests.length, 2, "the decoy got nothing from the proxy");
  } finally {
    scan.stop();
    await px.shutdown();
    await f.shutdown();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── start in the instance through the fake docker (T2, T3) ─────────────────────────────────────────────────────────
async function withInstance(fn) {
  const fd = await fakeDocker();
  const tmp = mkdtemp("start");
  const bin = path.join(tmp, "bin");
  fs.mkdirSync(bin);
  const name = `cbase-p-s14${crypto.randomBytes(4).toString("hex")}`;
  const names = ["CBASE_CONTAINER", "CBASE_DIND", "CBASE_DOCKER_BIN", "CBASE_CHROMIUM", "CBASE_IN_PROJECT_ESCALATION_MS"];
  const saved = Object.fromEntries(names.map((k) => [k, process.env[k]]));
  try {
    Object.assign(process.env, { CBASE_CONTAINER: "1", CBASE_DIND: "1", CBASE_DOCKER_BIN: fd.bin, CBASE_IN_PROJECT_ESCALATION_MS: "200" });
    // The container finds the fake programs through its PATH (the wrapper searches the command there).
    execFileSync(fd.bin, ["run", "-d", "--name", name, "-e", `PATH=${bin}:${process.env.PATH}`, "cbase-projectbox:test"], { env: { ...process.env, ...fd.env } });
    setInProjectSeam({ kind: dockerKind, program: dockerProgram, processLocation: () => path.join(tmp, "processes"), container: (i) => i.containerId });
    const inst = { projectId: "ps14start", instance: "main", identifier: "ps14start/main", containerId: name, ip: IP };
    // The STARTS in the container (through the wrapper) - not the group kills on closing, which may trail behind.
    const execs = () => fd.calls({ daemon: "host" }).filter((a) => a.args[0] === "exec" && a.args.includes("/usr/sbin/cbase-wrapper"));
    return await fn({ fd, tmp, bin, inst, execs });
  } finally {
    await waitForTruthy("escalations and catch-up kills done", () => openEscalations() === 0 && openCatchUpKills() === 0);
    setInProjectSeam(null);
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fd.cleanUp();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
const script = (file, text) => { fs.writeFileSync(file, text); fs.chmodSync(file, 0o755); return file; };

test("(T2) the browser tab of a converted project starts in the instance and talks to its IP; without an instance 127.0.0.1", async () => {
  const f = await paar(IP);
  const px = await proxyServer();
  try {
    await withInstance(async ({ tmp, bin, inst, execs }) => {
      // A Chromium as it listens in the container: it reports ITS loopback.
      process.env.CBASE_CHROMIUM = script(path.join(bin, "chromium"),
        `#!/bin/sh\necho "DevTools listening on ws://127.0.0.1:${f.P}/devtools/browser/s14" >&2\nexec sleep 3600\n`);
      const profile = (n) => path.join(tmp, `profile-${n}`);

      // An instance without an IP: no start (empty is not unknown - 127.0.0.1 would be B).
      await assert.rejects(ensureUserBrowser({ scopeKey: "proj:s14-without-ip", profileDir: profile("x"), label: "X", workspaceId: "ws", instance: { ...inst, ip: "" } }), /without an IP/);
      assert.equal(execs().length, 0, "without an IP nothing starts");

      const b = await ensureUserBrowser({ scopeKey: "proj:s14-inst", profileDir: profile("i"), label: "Shop", workspaceId: "ws", instance: inst });
      try {
        assert.equal(execs().length, 1, "started in the project container");
        assert.equal(getBrowser(b.id).debugHost, IP);
        assert.deepEqual(f.inst.kinds(), [`ws ${hostPort(IP, f.P)}`], "CDP at the instance's IP (the stderr address rewritten)");
        assert.deepEqual(f.decoy.requests, []);
        // The UI never from the instance - without a readable version the notice from B, no HTTP at its debug port.
        const html = await raw("127.0.0.1", px.port, `/api/browsers/${b.id}/devtools/inspector.html`, {});
        assert.equal(html.status, 409);
        assert.doesNotMatch(html.body, /<html>instanz<\/html>/);
        assert.deepEqual(f.inst.kinds(), [`ws ${hostPort(IP, f.P)}`], "only the CDP line, no HTTP at the instance");
      } finally { closeBrowser(b.id); }

      // Without an instance: as before - start in B, 127.0.0.1, no docker.
      const prior = execs().length;
      const bB = await ensureUserBrowser({ scopeKey: "proj:s14-b", profileDir: profile("b"), label: "B", workspaceId: "ws" });
      try {
        assert.equal(execs().length, prior, "without an instance no docker exec");
        assert.equal(getBrowser(bB.id).debugHost, "127.0.0.1");
        assert.deepEqual(f.decoy.kinds(), [`ws 127.0.0.1:${f.P}`]);
      } finally { closeBrowser(bB.id); }
    });
  } finally { await px.shutdown(); await f.shutdown(); }
});

test("(T3) the inspector of a converted project is connected at the instance's IP; without an instance at 127.0.0.1", async () => {
  const f = await paar(IP);
  try {
    await withInstance(async ({ tmp, bin, inst, execs }) => {
      // A node as it listens in the container (--inspect-brk=0): it reports ITS loopback and waits.
      script(path.join(bin, "node"), `#!/bin/sh\necho "Debugger listening on ws://127.0.0.1:${f.P}/s14-inspector" >&2\nexec sleep 3600\n`);
      fs.writeFileSync(path.join(tmp, "app.js"), "console.log(1)\n");
      const session = async (opts, fact) => {
        const events = [];
        const { id } = debugLaunch({ cwd: tmp, file: "app.js", breakpoints: [], ...opts });
        debugSubscribe(id, { write: (s) => { events.push(s); }, on: () => {} });
        try {
          await waitForTruthy("inspector connected or session ended", () =>
            [...f.inst.requests, ...f.decoy.requests].some((a) => a.kind === "ws" && a.url === "/s14-inspector" && !fact.seen.has(a))
            || events.some((e) => e.startsWith("event: terminated")));
        } finally { debugStop(id); }
        const fresh = [...f.inst.requests, ...f.decoy.requests].filter((a) => !fact.seen.has(a));
        for (const a of fresh) fact.seen.add(a);
        return { fresh, events };
      };
      const fact = { seen: new Set() };

      assert.throws(() => debugLaunch({ cwd: tmp, file: "app.js", instance: { ...inst, ip: "" } }), /without an IP/);
      assert.equal(execs().length, 0, "without an IP nothing starts");

      const including = await session({ instance: inst }, fact);
      assert.equal(execs().length, 1, "started in the project container");
      assert.deepEqual(f.inst.kinds(), [`ws ${hostPort(IP, f.P)}`], `at the instance's IP (${including.events.join(" | ")})`);
      assert.deepEqual(f.decoy.requests, []);

      // Without an instance: spawn in B (the same fake node through the test process's PATH), 127.0.0.1.
      const oldPath = process.env.PATH;
      let without;
      process.env.PATH = `${bin}:${oldPath}`;
      try { without = session({}, fact); } finally { process.env.PATH = oldPath; }
      await without;
      assert.equal(execs().length, 1, "without an instance no docker exec");
      assert.deepEqual(f.decoy.kinds(), [`ws 127.0.0.1:${f.P}`]);
    });
  } finally { await f.shutdown(); }
});

// ── (T4) server seam ───────────────────────────────────────────────────────────────────────────────────────────────
test("(T4) server.js - the root of a converted project carries IP and identifier only in operation, the server's scanner asks there", async () => {
  const f = await paar(IP);
  const fd = await fakeDocker();
  const names = ["CBASE_CONTAINER", "CBASE_DIND", "CBASE_DOCKER_BIN"];
  const saved = Object.fromEntries(names.map((k) => [k, process.env[k]]));
  try {
    await withAgentsServer(async (ctx) => {
      const projPath = path.join(ctx.root, "workspace", "s14-shop");
      fs.mkdirSync(projPath, { recursive: true });
      const p = await json(`${ctx.base}/api/workspaces/${ctx.ws.id}/projects`, { method: "POST", body: JSON.stringify({ name: "S14 Shop", path: projPath }) });
      store.createProjectInstance({ projectId: p.id, state: "ready", convertedAt: Date.now(), containerId: `cbase-p-${p.id}`, ip: IP, hostname: "cbp-214" });
      const rootI = locationFor({ projectId: p.id, converted: true }).playwrightProfiles;
      // A second converted project whose instance row carries NO IP: in operation its root drops out.
      const withoutIpPath = path.join(ctx.root, "workspace", "s14-without-ip");
      fs.mkdirSync(withoutIpPath, { recursive: true });
      const pWithout = await json(`${ctx.base}/api/workspaces/${ctx.ws.id}/projects`, { method: "POST", body: JSON.stringify({ name: "S14 without IP", path: withoutIpPath }) });
      store.createProjectInstance({ projectId: pWithout.id, state: "ready", convertedAt: Date.now(), containerId: `cbase-p-${pWithout.id}`, hostname: "cbp-215" });
      const rootWithout = locationFor({ projectId: pWithout.id, converted: true }).playwrightProfiles;
      fs.mkdirSync(path.join(rootWithout, "chat-s14t4-without-ip"), { recursive: true }); // the runtime folder exists (allLocations)
      fs.mkdirSync(path.join(rootI, "chat-s14t4"), { recursive: true });
      fs.writeFileSync(path.join(rootI, "chat-s14t4", "DevToolsActivePort"), `${f.P}\n/devtools/browser/x`);

      // server.js sets the chat-instance source (setBrowserChatInstance) itself now; this guard holds the root WITHOUT it - with
      // it per instance is held by (T8).
      setBrowserChatInstance(null);
      // Without the operating mark: a string - the browser counts as one of B.
      for (const k of names) delete process.env[k];
      try {
      assert.ok(agentScanRoots().every((w) => typeof w === "string"), "without operation only paths");
      assert.ok(agentScanRoots().includes(rootI));
      assert.ok(agentScanRoots().includes(rootWithout), "without operation it too is a path");
      await agentScanCycle();
      assert.deepEqual(f.decoy.kinds(), [`http 127.0.0.1:${f.P}`, `ws 127.0.0.1:${f.P}`], "without operation as before");
      assert.deepEqual(f.inst.requests, []);

      // With the operating mark: IP and identifier, the server's scanner asks the instance.
      Object.assign(process.env, { CBASE_CONTAINER: "1", CBASE_DIND: "1", CBASE_DOCKER_BIN: fd.bin });
      const identifier = `${p.id}/main`;
      assert.deepEqual(agentScanRoots().find((w) => typeof w !== "string"), { root: rootI, host: IP, identifier });
      assert.ok(!agentScanRoots().some((w) => w === rootWithout || w?.root === rootWithout), "an instance without IP: neither path (127.0.0.1) nor object");
      await agentScanCycle();
      assert.deepEqual(f.inst.kinds(), [`http ${hostPort(IP, f.P)}`, `ws ${hostPort(IP, f.P)}`], "the server's scanner asks the instance");
      const s = listBrowsers().find((b) => b.scopeKey === `agent:${identifier}:chat-s14t4:${f.P}`);
      assert.ok(s, `session under the identifier: ${JSON.stringify(listBrowsers().map((b) => b.scopeKey))}`);
      assert.equal(getBrowser(s.id).debugHost, IP);
      assert.deepEqual(fd.calls().filter((a) => a.args[0] === "exec"), [], "the scanner calls no docker exec");
      } finally {
        // Back before the server end: the server's end should not run in operation (no project container there).
        for (const k of names) delete process.env[k];
      }
    });
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fd.cleanUp();
    await f.shutdown();
  }
});

// ── (T5) an instance's answer is a claim, not truth ──
// What answers on /json/version in the project container is the project's code. It must not determine where B connects: a ws
// URL or a redirect to 127.0.0.1 would hit a service of B (`serviceB`, own port) or the decoy at the same port, and B would
// hang a session under project identifier and chat id on it. So: no redirect, the host becomes the instance's, protocol ws:,
// port that of the port file, path /devtools/browser/<id>, no query. `beside` is a second service IN the instance (port Q): it
// shows the port check, which pinning the host alone does not replace.
async function scannerCase(response) {
  const serviceB = fakeDevtools("service-b");
  await listen(serviceB.server, 0, "127.0.0.1");
  const K = serviceB.server.address().port;
  const beside = fakeDevtools("beside");
  await listen(beside.server, 0, IP);
  const Q = beside.server.address().port;
  const f = await paar(IP, { version: (req) => response({ K, Q, P: req.socket.localPort }) });
  const tmp = mkdtemp("t5");
  const root = path.join(tmp, "instance");
  fs.mkdirSync(path.join(root, "chat-s14t5"), { recursive: true });
  fs.writeFileSync(path.join(root, "chat-s14t5", "DevToolsActivePort"), `${f.P}\n/devtools/browser/x`);
  const scan = startAgentScan(() => [{ root, host: IP, identifier: "ps14t5/main" }]);
  try {
    await scan.cycle();
    const sessions = listBrowsers().filter((b) => b.profile === "chat-s14t5");
    const result = {
      instance: f.inst.kinds(), decoy: f.decoy.kinds(), serviceB: serviceB.requests.map((a) => `${a.kind} ${a.url}`), beside: beside.kinds(),
      sessions: sessions.map((b) => `${b.scopeKey === `agent:ps14t5/main:chat-s14t5:${f.P}` ? "Identifier" : b.scopeKey} ${getBrowser(b.id).debugHost}`),
    };
    for (const b of sessions) closeBrowser(b.id);
    return { P: f.P, result };
  } finally {
    scan.stop();
    await f.shutdown();
    await serviceB.shutdown();
    await beside.shutdown();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test("(T5) the scanner does not believe the instance's DevTools address - no redirect, host pinned, port/path/protocol checked", async () => {
  // Expected per case, depending on the instance's port P (it changes per case).
  const nothing = (P) => ({ instance: [`http ${hostPort(IP, P)}`], decoy: [], serviceB: [], beside: [], sessions: [] });
  const cases = [
    ["ws URL to a service of B", nothing, ({ K }) => ({ status: 200, body: { webSocketDebuggerUrl: `ws://127.0.0.1:${K}/api/tunnel?port=5432` } })],
    ["Chromium path at a foreign port of B", nothing, ({ K }) => ({ status: 200, body: { webSocketDebuggerUrl: `ws://127.0.0.1:${K}/devtools/browser/x` } })],
    ["redirect to a service of B", nothing, ({ K }) => ({ status: 302, headers: { Location: `http://127.0.0.1:${K}/json/version` } })],
    ["foreign port at the instance", nothing, ({ Q }) => ({ status: 200, body: { webSocketDebuggerUrl: `ws://${hostPort(IP, Q)}/devtools/browser/x` } })],
    ["foreign path at the instance", nothing, ({ P }) => ({ status: 200, body: { webSocketDebuggerUrl: `ws://${hostPort(IP, P)}/api/tunnel` } })],
    ["query at the instance", nothing, ({ P }) => ({ status: 200, body: { webSocketDebuggerUrl: `ws://${hostPort(IP, P)}/devtools/browser/x?port=5432` } })],
    ["http: instead of ws:", nothing, ({ P }) => ({ status: 200, body: { webSocketDebuggerUrl: `http://${hostPort(IP, P)}/devtools/browser/x` } })],
    // The loopback at the own port (this is how Chromium reports when asked WITH Host 127.0.0.1): the host becomes the
    // instance's - the session arises, past the decoy.
    ["127.0.0.1 at the own port", (P) => ({ instance: [`http ${hostPort(IP, P)}`, `ws ${hostPort(IP, P)}`], decoy: [], serviceB: [], beside: [], sessions: [`Identifier ${IP}`] }),
      ({ P }) => ({ status: 200, body: { webSocketDebuggerUrl: `ws://127.0.0.1:${P}/devtools/browser/instance` } })],
  ];
  for (const [what, desired, response] of cases) {
    const { P, result } = await scannerCase(response);
    assert.deepEqual(result, desired(P), what);
  }
});

test("(T6) the fallback poll of an instance's browser tab follows no redirect", async () => {
  // The instance redirects /json/version to a service of B. Only from the SECOND fetch on does its Chromium report on stderr
  // (gate file): whoever follows the redirect is done with the first fetch - at the service of B.
  const serviceB = fakeDevtools("service-b");
  await listen(serviceB.server, 0, "127.0.0.1");
  const K = serviceB.server.address().port;
  let gate = "";
  let retrievals = 0;
  const f = await paar(IP, {
    version: () => {
      if (++retrievals === 2) fs.writeFileSync(gate, "");
      return { status: 302, headers: { Location: `http://127.0.0.1:${K}/json/version` } };
    },
  });
  try {
    await withInstance(async ({ tmp, bin, inst }) => {
      gate = path.join(tmp, "stderr-gate");
      process.env.CBASE_CHROMIUM = script(path.join(bin, "chromium"), [
        "#!/bin/sh",
        'for a in "$@"; do case "$a" in --user-data-dir=*) d="${a#--user-data-dir=}";; esac; done',
        `printf '%s\\n/devtools/browser/s14\\n' ${f.P} > "$d/DevToolsActivePort"`,
        `while [ ! -f '${gate}' ]; do sleep 0.05; done`,
        `echo "DevTools listening on ws://127.0.0.1:${f.P}/devtools/browser/s14" >&2`,
        "exec sleep 3600",
        "",
      ].join("\n"));
      const b = await ensureUserBrowser({ scopeKey: "proj:s14-poll", profileDir: path.join(tmp, "profile-poll"), label: "Poll", workspaceId: "ws", instance: inst });
      try {
        assert.deepEqual(serviceB.requests, [], "no fetch at a service of B");
        assert.deepEqual(f.decoy.requests, []);
        assert.equal(getBrowser(b.id).debugHost, IP);
        assert.ok(retrievals >= 2, "the poll kept asking until stderr came");
        assert.deepEqual(f.inst.kinds().filter((a) => a.startsWith("ws ")), [`ws ${hostPort(IP, f.P)}`], "CDP at the instance");
      } finally { closeBrowser(b.id); }
    });
  } finally { await f.shutdown(); await serviceB.shutdown(); }
});

test("(T7) an instance root without host drops out - never a fallback to 127.0.0.1", async () => {
  const f = await paar(IP);
  const tmp = mkdtemp("without-host");
  const root = path.join(tmp, "instance");
  fs.mkdirSync(path.join(root, "chat-s14t7"), { recursive: true });
  fs.writeFileSync(path.join(root, "chat-s14t7", "DevToolsActivePort"), `${f.P}\n/devtools/browser/x`);
  const scan = startAgentScan(() => [{ root, identifier: "ps14t7/main" }, { root, host: "", identifier: "ps14t7/main" }]);
  try {
    await scan.cycle();
    assert.deepEqual(f.decoy.requests, [], "the decoy at the same port in B stayed untouched");
    assert.deepEqual(f.inst.requests, []);
    assert.deepEqual(listBrowsers().filter((b) => b.profile === "chat-s14t7"), [], "no session");
  } finally {
    scan.stop();
    await f.shutdown();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── (T8/T9) per instance of the chat ──
// Main and copies of a project share the runtime folder, their browsers run on different IPs. Without a source
// (setBrowserChatInstance, set by server.js) the root stands there as before; with it one entry per instance with IP,
// identifier and `only` - a copy's profile is never searched at the main's IP.

test("(T8) agentScanRoots per instance of the chat - without a source as before, with it main and copy apart, unresolvable is skipped", async () => {
  const fd = await fakeDocker();
  const names = ["CBASE_CONTAINER", "CBASE_DIND", "CBASE_DOCKER_BIN"];
  const saved = Object.fromEntries(names.map((k) => [k, process.env[k]]));
  const IP_H = "10.230.71.2";
  const IP_K = "10.230.72.2";
  try {
    await withAgentsServer(async (ctx) => {
      const projPath = path.join(ctx.root, "workspace", "st25-shop");
      fs.mkdirSync(projPath, { recursive: true });
      const p = await json(`${ctx.base}/api/workspaces/${ctx.ws.id}/projects`, { method: "POST", body: JSON.stringify({ name: "ST25 Shop", path: projPath }) });
      store.createProjectInstance({ projectId: p.id, state: "ready", convertedAt: Date.now(), containerId: `cbase-p-${p.id}`, ip: IP_H, hostname: "cbp-71" });
      store.createProjectInstance({ projectId: p.id, instance: "copy-k1", state: "ready", convertedAt: Date.now(), containerId: `cbase-k-${p.id}-k1`, ip: IP_K, hostname: "cbp-72" });
      store.createProjectInstance({ projectId: p.id, instance: "copy-k2", state: "ready", convertedAt: Date.now(), containerId: `cbase-k-${p.id}-k2`, hostname: "cbp-73" }); // without IP
      const root = locationFor({ projectId: p.id, converted: true }).playwrightProfiles;
      const profile = ["chat-st25h", "chat-st25k", "chat-st25ohneip", "chat-st25throws", "chat-st25way"];
      for (const n of profile) fs.mkdirSync(path.join(root, n), { recursive: true });
      Object.assign(process.env, { CBASE_CONTAINER: "1", CBASE_DIND: "1", CBASE_DOCKER_BIN: fd.bin });
      try {
        const here = () => agentScanRoots().filter((w) => typeof w !== "string" && w.root === root);
        // Without a source (server.js sets it itself - taken away here): ONE entry for the main, without `only` - exactly the
        // object as before.
        setBrowserChatInstance(null);
        assert.deepEqual(here(), [{ root, host: IP_H, identifier: `${p.id}/main` }]);

        const asked = [];
        const INSTANCE = { st25h: "", st25k: "copy-k1", st25ohneip: "copy-k2", st25way: "copy-k9" };
        setBrowserChatInstance((chatId, projectId) => {
          asked.push([chatId, projectId]);
          if (chatId === "st25throws") throw new Error("source broken");
          return INSTANCE[chatId];
        });
        const including = here().map((w) => [w.host, w.identifier, profile.filter((n) => w.only(n))]);
        assert.deepEqual(including, [[IP_H, `${p.id}/main`, ["chat-st25h"]], [IP_K, `${p.id}/copy-k1`, ["chat-st25k"]]],
          "main and copy each with its IP and ONLY its profiles; without IP, without row, throws: skipped (never the main's IP)");
        assert.ok(asked.every(([, pid]) => pid === p.id), "the source gets the root's project");
        assert.deepEqual(fd.calls().filter((a) => a.args[0] === "exec"), [], "no docker call");
      } finally {
        setBrowserChatInstance(null);
        for (const k of names) delete process.env[k];
      }
    });
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fd.cleanUp();
  }
});

test("(T9) in a root with `only` the scanner reads only the profiles for which it is true", async () => {
  const f = await paar(IP);
  const tmp = mkdtemp("only");
  const root = path.join(tmp, "instance");
  for (const n of ["chat-st25t9a", "chat-st25t9b"]) {
    fs.mkdirSync(path.join(root, n), { recursive: true });
    fs.writeFileSync(path.join(root, n, "DevToolsActivePort"), `${f.P}\n/devtools/browser/x`);
  }
  const scan = startAgentScan(() => [{ root, host: IP, identifier: "pst25/copy-k1", only: (n) => n === "chat-st25t9a" }]);
  try {
    await scan.cycle();
    assert.deepEqual(listBrowsers().filter((b) => b.profile?.startsWith("chat-st25t9")).map((b) => b.scopeKey), [`agent:pst25/copy-k1:chat-st25t9a:${f.P}`]);
    assert.deepEqual(f.inst.kinds(), [`http ${hostPort(IP, f.P)}`, `ws ${hostPort(IP, f.P)}`], "the second profile was not asked");
    assert.deepEqual(f.decoy.requests, []);
  } finally {
    scan.stop();
    await f.shutdown();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── the UI source in B: a fake "Chromium in B" ──
// For the UI of an instance session B starts ITS Chromium (resolveChromium -> CBASE_CHROMIUM). The fake listens on 127.0.0.1,
// reports itself like Chromium on stderr, answers /json/version with `product` and "WebKit-Version: 537.36 (<revision>)" and
// serves own files under /devtools/*: inspector.html (SOURCE_INSPECTOR, with the REAL meta CSP) with Set-Cookie and
// X-Frame-Options (B strips both), every other one as script "file-b <path>". Its argv and every request are in the log (one
// JSON line per event, written BEFORE the answer - whoever has the answer reads the line). `fail`: it ends at once (exit 3),
// without listening.
// The meta CSP of inspector.html, verbatim as in Chromium 153.0.8010.52 (resources.pak of the image): `script-src 'self' ...`
// without 'unsafe-inline', without hash, without nonce. A source page WITHOUT a CSP would let an injected inline snippet
// stand in the document in the test and never run in the real frontend.
const INSPECTOR_CSP = "default-src 'self' devtools: data:; style-src 'self' 'unsafe-inline' devtools:; object-src 'none'; script-src\n"
  + "  'self' https://chrome-devtools-frontend.appspot.com; img-src 'self' data: blob:; frame-src * data:; connect-src data: "
  + "https://chromeuxreport.googleapis.com 'self' devtools: ws://127.0.0.1:*;";
const SOURCE_INSPECTOR = "<!DOCTYPE html>\n<html lang=\"en\">\n<meta charset=\"utf-8\">\n<title>DevTools</title>\n"
  + `<meta\n  http-equiv="Content-Security-Policy"\n  content="${INSPECTOR_CSP}">\n<meta name="referrer" content="no-referrer">\n`
  + "<script type=\"module\" src=\"./entrypoints/inspector/inspector.js\"></script>\n<body class=\"undocked\" id=\"-blink-dev-tools\">ui-b\n";
function wrongSource(tmp, { product = "", revision = "", fail = false } = {}) {
  const id = crypto.randomBytes(4).toString("hex");
  const log = path.join(tmp, `source-${id}.jsonl`);
  const js = path.join(tmp, `source-${id}.cjs`);
  fs.writeFileSync(js, [
    'const http = require("node:http"); const fs = require("node:fs");',
    `const K = ${JSON.stringify({ log, product, revision, fail, inspector: SOURCE_INSPECTOR })};`,
    'const write = (o) => fs.appendFileSync(K.log, JSON.stringify(o) + "\\n");',
    "write({ argv: process.argv.slice(2) });",
    "if (K.fail) process.exit(3);",
    "const srv = http.createServer((req, res) => {",
    "  write({ url: req.url, header: req.headers });",
    '  if (req.url === "/json/version") { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ Browser: K.product, "WebKit-Version": "537.36 (" + K.revision + ")" })); return; }',
    '  if (req.url.startsWith("/devtools/inspector.html")) { res.writeHead(200, { "Content-Type": "text/html", "Set-Cookie": "of-b=1", "X-Frame-Options": "DENY" }); res.end(K.inspector); return; }',
    '  if (req.url.startsWith("/devtools/")) { res.writeHead(200, { "Content-Type": "text/javascript" }); res.end("// file-b " + req.url); return; }',
    "  res.writeHead(404); res.end();",
    "});",
    'srv.listen(0, "127.0.0.1", () => process.stderr.write("\\nDevTools listening on ws://127.0.0.1:" + srv.address().port + "/devtools/browser/source\\n"));',
    'process.on("SIGTERM", () => process.exit(0));',
    "",
  ].join("\n"));
  const bin = script(path.join(tmp, `chromium-b-${id}`), `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`);
  const logValue = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((z) => JSON.parse(z)) : []);
  return { bin, log: logValue, requests: () => logValue().filter((e) => e.url) };
}
// An upgrade with the raw answer head: `{ status, header }` (101 = open, `header` the answer's header lines, lower-cased).
function wsWithHeader(url, opts = {}) {
  return new Promise((resolve) => {
    const ws = new WsClient(url, { perMessageDeflate: false, ...opts });
    ws.once("upgrade", (res) => { resolve({ status: 101, header: res.headers, ws }); });
    ws.once("unexpected-response", (_req, res) => { resolve({ status: res.statusCode, header: res.headers, ws: null }); try { ws.terminate(); } catch {} });
    ws.once("error", (e) => resolve({ status: 0, error: e.message, header: {}, ws: null }));
  });
}
const P140 = "HeadlessChrome/140.0.7339.185";
const REV = "@0123456789abcdef0123456789abcdef01234567";
// An instance root and a B root with the same profile (like T1); `opts` go to the instance's instrument.
async function twoBrowser(tmp, f, profile, identifier) {
  const rootB = path.join(tmp, "b");
  const rootI = path.join(tmp, "instance");
  for (const w of [rootB, rootI]) {
    fs.mkdirSync(path.join(w, profile), { recursive: true });
    fs.writeFileSync(path.join(w, profile, "DevToolsActivePort"), `${f.P}\n/devtools/browser/x`);
  }
  const scan = startAgentScan(() => [rootB, { root: rootI, host: IP, identifier }]);
  await scan.cycle();
  const list = listBrowsers().filter((b) => b.profile === profile);
  return { scan, inI: list.find((b) => b.scopeKey.startsWith(`agent:${identifier}:`)), inB: list.find((b) => b.scopeKey === `agent:${profile}:${f.P}`) };
}
const httpToThe = (fake) => fake.requests.filter((a) => a.kind === "http" && a.url !== "/json/version");

// ── (T10) request AND answer of an instance ──
// A browser in an instance belongs to the project container. B passes it only an allow list of the request head (not the
// session cookie, `authorization`, `x-cbase-token`, `x-forwarded-*`). The ANSWER must not go to the user's browser unchanged
// either: HTML/JS of the container under the cbase origin, Set-Cookie (overwrite the session), Clear-Site-Data (log out).
// So (instrument `malicious`: every answer script, every header line that sets something at the user, also in the 101): NO
// HTTP goes to the debug port - the UI comes from the Chromium in B (wrongSource, same version), without the forbidden header
// lines, with nosniff; the WebSocket goes there (allow list), its 101 comes back without the forbidden lines; only
// /devtools/page|browser/<id> becomes an upgrade, and only GET/HEAD to the file. Counter-proof in the same test: a browser in B
// gets head and answer as before.
test("(T10) no HTTP goes to an instance's debug port - the UI comes from B, without the container's script and header lines; the WebSocket with allow list and filtered 101; B as before", async () => {
  const f = await paar(IP, { product: P140, revision: REV, malicious: true });
  const tmp = mkdtemp("header");
  const source = wrongSource(tmp, { product: P140, revision: REV });
  const savedChromium = process.env.CBASE_CHROMIUM;
  process.env.CBASE_CHROMIUM = source.bin;
  const px = await proxyServer();
  const secret = { Cookie: "cbase_session=SECRET", Authorization: "Bearer SECRET", "x-cbase-token": "SECRET", "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", Accept: "text/html", "User-Agent": "TestBench/1", Range: "bytes=0-", "If-None-Match": "\"e1\"" };
  const forbidden = ["cookie", "authorization", "x-cbase-token", "x-forwarded-for", "x-forwarded-proto"];
  let scan = null;
  try {
    const two = await twoBrowser(tmp, f, "chat-s14t10", "ps14t10/main");
    scan = two.scan;
    const { inI, inB } = two;
    assert.ok(inI && inB, "both browsers found");
    const httpPrior = httpToThe(f.inst).length;

    // A file that the container WOULD serve with script and header lines: it comes from B.
    const r = await raw("127.0.0.1", px.port, `/api/browsers/${inI.id}/devtools/malicious.html`, secret);
    assert.doesNotMatch(r.body, /<script>fetch/, `script of the container reached the user: ${r.body}`);
    assert.doesNotMatch(r.body, /instance/);
    for (const k of MALICIOUS_ROWS) assert.equal(r.headers[k], undefined, `${k} of the container reached the user`);
    assert.equal(r.headers["x-content-type-options"], "nosniff");
    assert.equal(r.status, 200);
    assert.equal(r.body, "// file-b /devtools/malicious.html", "the file comes from the Chromium in B");
    // inspector.html: from B, with the inclusion of the screencast script (T15), without the source's Set-Cookie and X-Frame-Options.
    const html = await raw("127.0.0.1", px.port, `/api/browsers/${inI.id}/devtools/inspector.html?ws=x`, secret);
    assert.equal(html.status, 200);
    assert.ok(html.body.startsWith(SOURCE_INSPECTOR), "inspector.html comes from B");
    assert.equal(html.body.slice(SOURCE_INSPECTOR.length), '<script src="cbase-screencast-off.js"></script>', "with the inclusion");
    for (const k of [...MALICIOUS_ROWS, "x-frame-options"]) assert.equal(html.headers[k], undefined, `inspector.html: ${k}`);
    assert.equal(html.headers["x-content-type-options"], "nosniff");
    assert.equal(httpToThe(f.inst).length, httpPrior, "an HTTP request reached the instance's debug port");
    assert.deepEqual(httpToThe(f.decoy), [], "the decoy got a file request");
    // The source: started like a Chromium (headless, debug port 0), asked with Host 127.0.0.1:<p> and only the allow list.
    const argv = source.log()[0].argv;
    assert.ok(argv.includes("--headless=new") && argv.includes("--remote-debugging-port=0"), argv.join(" "));
    const toB = source.requests().filter((a) => a.url.startsWith("/devtools/"));
    assert.deepEqual(toB.map((a) => a.url), ["/devtools/malicious.html", "/devtools/inspector.html?ws=x"]);
    for (const a of toB) {
      assert.match(a.header.host, /^127\.0\.0\.1:\d+$/);
      for (const k of forbidden) assert.equal(a.header[k], undefined, `${k} went to the source in B`);
      assert.equal(a.header["user-agent"], "TestBench/1");
    }
    // Only GET/HEAD; no file outside /devtools/; no upgrade except page|browser.
    const post = await new Promise((resolve, reject) => {
      const q = http.request({ host: "127.0.0.1", port: px.port, path: `/api/browsers/${inI.id}/devtools/malicious.html`, method: "POST", agent: false }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
      q.on("error", reject);
      q.end("x");
    });
    assert.equal(post, 405);
    const wsPrior = f.inst.requests.filter((a) => a.kind === "ws").length;
    const foreignUpgrade = await wsWithHeader(`ws://127.0.0.1:${px.port}/api/browsers/${inI.id}/devtools/inspector.html`);
    assert.equal(foreignUpgrade.status, 404, "an upgrade to a path other than page|browser");
    assert.equal(httpToThe(f.inst).length, httpPrior);
    assert.equal(f.inst.requests.filter((a) => a.kind === "ws").length, wsPrior, "a foreign upgrade path reached the instance");

    // Upgrade to the instance: the allow list with the handshake; the answer (101) without the forbidden lines.
    const up = await wsWithHeader(`ws://127.0.0.1:${px.port}/api/browsers/${inI.id}/devtools/page/1`, { headers: { Cookie: secret.Cookie, Authorization: secret.Authorization, "x-cbase-token": "SECRET", "x-forwarded-for": "203.0.113.9" } });
    assert.equal(up.status, 101, JSON.stringify(up.error || ""));
    for (const k of MALICIOUS_ROWS) assert.equal(up.header[k], undefined, `upgrade: ${k} of the container reached the user`);
    await new Promise((r) => { up.ws.once("open", r); if (up.ws.readyState === 1) r(); });
    assert.equal(await echo(up.ws, "through the proxy"), "through the proxy", "the data stream after the filtered head");
    up.ws.close();
    assert.equal(f.inst.requests.at(-1).kind, "ws");
    const wsHeader = f.inst.requests.at(-1).header;
    for (const k of forbidden) assert.equal(wsHeader[k], undefined, `upgrade: ${k} reached the instance`);

    // Counter-proof B: the head as before (a browser in B is the user's), answer unchanged, no nosniff mark.
    const rb = await raw("127.0.0.1", px.port, `/api/browsers/${inB.id}/devtools/inspector.html`, secret);
    const headerB = f.decoy.requests.at(-1).header;
    assert.equal(headerB.cookie, "cbase_session=SECRET", "B: the head goes through as before");
    assert.equal(headerB.authorization, "Bearer SECRET");
    assert.match(rb.body, /^<html>decoy<\/html>/, "B: the file from its own Chromium");
    assert.equal(rb.headers["x-content-type-options"], undefined, "B: no new header line");
  } finally {
    scan?.stop();
    await stopDevtoolsSource();
    if (savedChromium === undefined) delete process.env.CBASE_CHROMIUM; else process.env.CBASE_CHROMIUM = savedChromium;
    await px.shutdown();
    await f.shutdown();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── (T11) ensureUserBrowser reuses a session only where the browser is supposed to run ──
// `proj:<id>` ran in B before the relocation; after it (instance row) ensure must not return the OLD session - the browser tab
// would keep showing B's browser, and the fence would take it (key `proj:<id>`) for the instance's. So: a session with a
// foreign debug host is closed and the browser restarted in the instance; a matching one is reused.
test("(T11) proj:<id> ran in B, afterwards an instance - ensure restarts in the instance; a matching session is reused", async () => {
  const f = await paar(IP);
  try {
    await withInstance(async ({ tmp, bin, inst, execs }) => {
      process.env.CBASE_CHROMIUM = script(path.join(bin, "chromium"),
        `#!/bin/sh\necho "DevTools listening on ws://127.0.0.1:${f.P}/devtools/browser/s14" >&2\nexec sleep 3600\n`);
      const scopeKey = "proj:s14-relocation";
      const old = await ensureUserBrowser({ scopeKey, profileDir: path.join(tmp, "profile-b"), label: "Before", workspaceId: "ws" });
      let fresh = null;
      try {
        assert.equal(getBrowser(old.id).debugHost, "127.0.0.1");
        fresh = await ensureUserBrowser({ scopeKey, profileDir: path.join(tmp, "profile-i"), label: "After", workspaceId: "ws", instance: inst });
        assert.notEqual(fresh.id, old.id, "ensure returned B's session after the relocation");
        assert.equal(getBrowser(fresh.id)?.debugHost, IP);
        assert.equal(getBrowser(old.id) ?? null, null, "B's session is closed");
        assert.equal(execs().length, 1, "the new browser started in the project container");
        // Counter-proof: a matching session is reused (no second start).
        const again = await ensureUserBrowser({ scopeKey, profileDir: path.join(tmp, "profile-i"), label: "After", workspaceId: "ws", instance: inst });
        assert.equal(again.id, fresh.id);
        assert.equal(execs().length, 1);
        // An instance without an IP: no fallback to the existing session.
        await assert.rejects(ensureUserBrowser({ scopeKey, profileDir: path.join(tmp, "profile-i"), label: "X", workspaceId: "ws", instance: { ...inst, ip: "" } }), /without an IP/);
      } finally {
        if (getBrowser(old.id)) closeBrowser(old.id);
        if (fresh && getBrowser(fresh.id)) closeBrowser(fresh.id);
      }
    });
  } finally { await f.shutdown(); }
});

// ── (T12) no fitting UI in B - a notice, never a fallback to the container ──
// Three reasons, each without HTTP at the instance's debug port: its browser reports no readable version ("instance" - the
// source is not even started), it reports another than the Chromium in B ("version"), or the Chromium in B does not start
// ("source"). For a page (.html) the notice as HTML with the mark that the web UI reads (meta name="cbase-devtools"), for
// every other file as text; status 409, no script (CSP).
test("(T12) if no UI fits in B, B shows a notice - version differs, version unreadable, source does not start; never files of the container", async () => {
  const tmp = mkdtemp("n54");
  const savedChromium = process.env.CBASE_CHROMIUM;
  const px = await proxyServer();
  const open = [];
  const session = async (opts, profile) => {
    const f = await paar(IP, { malicious: true, ...opts });
    open.push(f);
    const z = await twoBrowser(path.join(tmp, profile), f, profile, `pn54/${profile}`);
    z.scan.stop();
    return { f, inI: z.inI };
  };
  try {
    const source = wrongSource(tmp, { product: P140, revision: REV });
    process.env.CBASE_CHROMIUM = source.bin;

    // (a) another version
    const a = await session({ product: "HeadlessChrome/141.0.7390.54", revision: REV }, "chat-n54a");
    const ha = await raw("127.0.0.1", px.port, `/api/browsers/${a.inI.id}/devtools/inspector.html?ws=x`, { Accept: "text/html" });
    assert.equal(ha.status, 409);
    assert.match(ha.body, /<meta name="cbase-devtools" content="no-ui" data-reason="version" data-instance="141\.0\.7390\.54" data-b="140\.0\.7339\.185">/);
    assert.match(ha.body, /Chromium 141\.0\.7390\.54/);
    assert.equal(ha.headers["content-security-policy"], "default-src 'none'; style-src 'unsafe-inline'");
    assert.doesNotMatch(ha.body, /<script/);
    const yes = await raw("127.0.0.1", px.port, `/api/browsers/${a.inI.id}/devtools/entrypoints/inspector/inspector.js`, {});
    assert.equal(yes.status, 409);
    assert.match(yes.headers["content-type"], /^text\/plain/);
    // The same number, another revision: that does not fit either.
    const a2 = await session({ product: P140, revision: "@ffffffffffffffffffffffffffffffffffffffff" }, "chat-n54a2");
    assert.equal((await raw("127.0.0.1", px.port, `/api/browsers/${a2.inI.id}/devtools/inspector.html`, {})).status, 409);
    assert.deepEqual(source.requests().filter((x) => x.url.startsWith("/devtools/")), [], "nothing went out of the source with a wrong version");

    // (b) unreadable - the source is not asked
    await stopDevtoolsSource();
    const startsPrior = source.log().filter((e) => e.argv).length;
    const b = await session({ product: "Chrome/x<script>", revision: REV }, "chat-n54b");
    const hb = await raw("127.0.0.1", px.port, `/api/browsers/${b.inI.id}/devtools/inspector.html`, {});
    assert.equal(hb.status, 409);
    assert.match(hb.body, /data-reason="instance" data-instance="" data-b=""/);
    assert.doesNotMatch(hb.body, /<script/);
    assert.equal(source.log().filter((e) => e.argv).length, startsPrior, "for an unreadable version B started its source");

    // (c) the source in B does not start
    process.env.CBASE_CHROMIUM = wrongSource(tmp, { fail: true }).bin;
    const c = await session({ product: P140, revision: REV }, "chat-n54c");
    const hc = await raw("127.0.0.1", px.port, `/api/browsers/${c.inI.id}/devtools/inspector.html`, {});
    assert.equal(hc.status, 409);
    assert.match(hc.body, /data-reason="source" data-instance="140\.0\.7339\.185" data-b=""/);

    for (const f of open) assert.deepEqual(httpToThe(f.inst), [], "an HTTP request reached an instance's debug port");
  } finally {
    await stopDevtoolsSource();
    if (savedChromium === undefined) delete process.env.CBASE_CHROMIUM; else process.env.CBASE_CHROMIUM = savedChromium;
    for (const b of listBrowsers().filter((x) => x.profile?.startsWith("chat-n54"))) closeBrowser(b.id);
    await px.shutdown();
    for (const f of open) await f.shutdown();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── (T13) the version and the answer head - pure ──────────────────────────────────────────────────────────────────────
test("(T13) revisionValue/revisionFromVersion read only what looks like a Chromium version; rawHeaderWithoutForbidden strips every spelling with its continuation", () => {
  assert.deepEqual(revisionValue("Chrome/154.0.8037.92", "@334b65d254ccc35df4fca82706d1753227b01039"),
    { number: "154.0.8037.92", revision: "334b65d254ccc35df4fca82706d1753227b01039", key: "154.0.8037.92@334b65d254ccc35df4fca82706d1753227b01039" });
  // Measured on Chrome 154: /json/version carries the same revision in the bracket of WebKit-Version.
  assert.deepEqual(revisionFromVersion({ Browser: "Chrome/154.0.8037.92", "WebKit-Version": "537.36 (@334b65d254ccc35df4fca82706d1753227b01039)" }),
    revisionValue("Chrome/154.0.8037.92", "@334b65d254ccc35df4fca82706d1753227b01039"));
  assert.equal(revisionValue("HeadlessChrome/140.0.7339.185", "").key, "140.0.7339.185@");
  for (const [p, r] of [["Chrome/154", ""], ["Chrome/1.2.3.4<script>", ""], ["", ""], [undefined, undefined], ["Chrome/1.2.3.4", "@<x>"], ["Chrome/1.2.3.4", "@a b"]]) {
    assert.equal(revisionValue(p, r), null, `${p} ${r}`);
  }
  assert.deepEqual([...FORBIDDEN_RESPONSE_HEADERS].sort(), [...MALICIOUS_ROWS].sort());
  const raw = ["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "SET-COOKIE: a=1", "set-cookie : b=2", "  ; Path=/", "Clear-Site-Data: \"*\"",
    "Connection: Upgrade", "Link: <x>", "Refresh: 0", "Service-Worker-Allowed: /", "Set-Cookie2: c", "Sec-WebSocket-Accept: abc"].join("\r\n");
  assert.equal(rawHeaderWithoutForbidden(raw), ["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", "Sec-WebSocket-Accept: abc"].join("\r\n"));
});

// ── (T14) one pass reads an instance root only up to the cap ──
// PROFILES_PER_ROOT limited only the further work; `fs.readdirSync` still read the root COMPLETELY - every 3 s in B's main
// thread (200,000 entries = about 200 ms per pass). Now the scanner reads entry by entry (opendir) and stops: after
// PROFILES_PER_ROOT + 1 profiles or - entries that `only` discards count too - after ENTRIES_PER_ROOT + 1 read. The READ SEAM:
// `fs.readdirSync` and `fs.opendirSync` are counted (the scanner calls both through the module object `fs`): a whole
// readdirSync counts every entry, an opendir every one that `readSync` delivers - read is read; through another path the test
// would see nothing and turn red at "> 0". A root in B (string) stays without a cap.
test("(T14) the scanner reads an instance root only up to the cap - entries that `only` discards count too; in B as before", async () => {
  const tmp = mkdtemp("cap");
  const N = 2 * ENTRIES_PER_ROOT + 1;
  const roots = { withoutOnly: path.join(tmp, "a"), withOnly: path.join(tmp, "b"), inB: path.join(tmp, "c") };
  for (const w of Object.values(roots)) {
    fs.mkdirSync(w);
    for (let i = 0; i < N; i++) fs.writeFileSync(path.join(w, `dummy-${i}`), "");
  }
  const read = new Map(Object.values(roots).map((w) => [w, 0]));
  const old = { readdirSync: fs.readdirSync, opendirSync: fs.opendirSync };
  fs.readdirSync = function (p, ...rest) {
    const r = old.readdirSync.call(fs, p, ...rest);
    if (read.has(String(p))) read.set(String(p), read.get(String(p)) + r.length);
    return r;
  };
  fs.opendirSync = function (p, ...rest) {
    const d = old.opendirSync.call(fs, p, ...rest);
    if (read.has(String(p))) {
      const read2 = d.readSync.bind(d);
      d.readSync = () => { const e = read2(); if (e) read.set(String(p), read.get(String(p)) + 1); return e; };
    }
    return d;
  };
  let scan = null;
  try {
    scan = startAgentScan(() => [
      { root: roots.withoutOnly, host: IP, identifier: "pcap/main" },
      { root: roots.withOnly, host: IP, identifier: "pcap/copy-k1", only: (n) => n.startsWith("chat-") },
      roots.inB,
    ]);
    // The start already runs a pass, `cycle()` waits for it and runs a second - only ONE is counted: afterwards the counters
    // to zero and exactly one more.
    await scan.cycle();
    for (const w of read.keys()) read.set(w, 0);
    await scan.cycle();
  } finally {
    scan?.stop();
    fs.readdirSync = old.readdirSync;
    fs.opendirSync = old.opendirSync;
  }
  try {
    const z = Object.fromEntries(Object.entries(roots).map(([k, w]) => [k, read.get(w)]));
    assert.ok(z.withoutOnly > 0 && z.withOnly > 0, `the read seam saw nothing: ${JSON.stringify(z)}`);
    assert.ok(z.withoutOnly <= PROFILES_PER_ROOT + 1, `instance root without \`only\`: ${z.withoutOnly} entries read (cap ${PROFILES_PER_ROOT})`);
    assert.ok(z.withOnly <= ENTRIES_PER_ROOT + 1, `instance root with \`only\`: ${z.withOnly} entries read (cap ${ENTRIES_PER_ROOT})`);
    assert.equal(z.inB, N, "B: the root completely");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── (T15) the screencast script runs under the UI's CSP ──
// B must not hang an INLINE <script> behind inspector.html: its meta CSP (`script-src 'self' ...`, without 'unsafe-inline')
// blocks it - it would stand in the DOM and never run. So the source carries the real meta CSP, and what a browser EXECUTES
// under it is measured (scriptsUnderMetaCsp) - for an instance (UI from the source in B) and for a browser in B (decoy). The
// file is answered by cbase itself (200, JavaScript, nosniff), it reaches neither the source nor the debug port. And the
// script as served, in a vm context of its own against a rebuilt frontend (DevTools 153: the button is locked at first,
// `clicked` discards a click before that), clocked by hand - no clock.
// What a browser executes under a document's meta CSP: an inline <script> only with 'unsafe-inline' (inspector.html has neither
// hash nor nonce), an external one only if its resolved origin is allowed ('self' = the document's origin, otherwise a source as
// prefix). Without a meta CSP everything would be allowed - so the test first checks that it found it.
function scriptsUnderMetaCsp(html, documentUrl) {
  const meta = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/i);
  const guidelines = Object.fromEntries((meta ? meta[1] : "").split(";").map((r) => r.trim().split(/\s+/)).filter((t) => t[0])
    .map(([name, ...values]) => [name.toLowerCase(), values]));
  const sources = guidelines["script-src"] || guidelines["default-src"] || null;
  const origin = new URL(documentUrl).origin;
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].map((m) => {
    const src = m[1].match(/\bsrc\s*=\s*"([^"]*)"/i)?.[1] ?? null;
    const url = src === null ? null : new URL(src, documentUrl);
    const allowed = !sources ? true
      : src === null ? sources.includes("'unsafe-inline'")
        : (sources.includes("'self'") && url.origin === origin) || sources.some((q) => /^https?:\/\//.test(q) && url.href.startsWith(q));
    return { index: m.index, inline: src === null, url: url?.href ?? null, allowed };
  });
  return { sources, scripts };
}
// The frontend in small: the button is the host `devtools-button` in the shadow of the toolbar (aria-label, `toggled`,
// `disabled`); a click works only once enabled (ToolbarButton.clicked: `this.enabled && ...`). `appears`/`free`: from which
// tick it is in the tree or enabled; `late`: a click's effect becomes visible only at the next tick; `withoutLock`: the host
// does not show its lock (neither property nor attribute) - then only the effect counts.
function frontend({ appears = 1, free = 1, enabled = true, late = false, withoutLock = false } = {}) {
  let t = 0;
  let open = null;
  const button = {
    toggled: enabled, clicks: 0, effective: 0,
    get disabled() { return withoutLock ? undefined : t < free; },
    getAttribute: (n) => (n === "aria-label" ? "Toggle screencast" : null),
    hasAttribute: (n) => n === "disabled" && !withoutLock && t < free,
    click() { button.clicks++; if (t < free) return; button.effective++; if (late) open = !button.toggled; else button.toggled = !button.toggled; },
  };
  const bar = { getAttribute: () => null, shadowRoot: { querySelectorAll: () => [{ getAttribute: () => "Andere" }, button] } };
  return {
    button,
    get tick() { return t; },
    beforeTick() { t++; if (open !== null) { button.toggled = open; open = null; } },
    document: { querySelectorAll: () => (t >= appears ? [{ getAttribute: () => null }, bar] : []) },
  };
}
// The served script in a context of its own; `setInterval` only remembers the tick, it is driven by hand.
function screencastRun(script, fe) {
  let tick = null;
  let stopped = false;
  const intervals = [];
  vm.runInNewContext(script, { document: fe.document, setInterval: (fn, ms) => { intervals.push(ms); tick = fn; return 1; }, clearInterval: () => { stopped = true; } });
  assert.deepEqual(intervals, [300], "one tick of 300 ms");
  return {
    get stopped() { return stopped; },
    ticks(n) { for (let i = 0; i < n && !stopped; i++) { fe.beforeTick(); tick(); } },
  };
}
test("(T15) the screencast script runs under the UI's meta CSP - same-origin file from cbase, clicks only once enabled and until the mirror is off", async () => {
  const f = await paar(IP, { product: P140, revision: REV });
  const tmp = mkdtemp("screencast");
  const source = wrongSource(tmp, { product: P140, revision: REV });
  const savedChromium = process.env.CBASE_CHROMIUM;
  process.env.CBASE_CHROMIUM = source.bin;
  const px = await proxyServer();
  let scan = null;
  try {
    const two = await twoBrowser(tmp, f, "chat-b6z3", "pb6z3/main");
    scan = two.scan;
    const { inI, inB } = two;
    assert.ok(inI && inB, "both browsers found");
    let script = null;
    for (const [kind, b, template] of [["Instance", inI, SOURCE_INSPECTOR], ["B", inB, "<html>decoy</html>"]]) {
      const httpInstance = httpToThe(f.inst).length;
      const httpDecoy = httpToThe(f.decoy).length;
      const sourcePrior = source.requests().length;
      const filePath = `/api/browsers/${b.id}/devtools/inspector.html?ws=x`;
      const document = `http://127.0.0.1:${px.port}${filePath}`;
      const html = await raw("127.0.0.1", px.port, filePath, {});
      assert.equal(html.status, 200, kind);
      assert.ok(html.body.startsWith(template), `${kind}: inspector.html from its source`);
      const { sources, scripts } = scriptsUnderMetaCsp(html.body, document);
      if (kind === "Instance") {
        assert.ok(sources && sources.includes("'self'") && !sources.includes("'unsafe-inline'"), `the real meta CSP is missing: ${sources}`);
        assert.ok(scripts.some((s) => s.url?.endsWith("/entrypoints/inspector/inspector.js") && s.allowed), "the UI's own module runs");
      }
      const injected = scripts.filter((s) => s.index >= template.length);
      assert.equal(injected.length, 1, `${kind}: exactly one inclusion by cbase`);
      assert.equal(injected[0].inline, false, `${kind}: inline script behind the meta CSP - the browser does not execute it`);
      assert.deepEqual(scripts.filter((s) => !s.allowed), [], `${kind}: a script that the CSP blocks`);
      const scriptPath = `/api/browsers/${b.id}/devtools/cbase-screencast-off.js`;
      assert.equal(injected[0].url, `http://127.0.0.1:${px.port}${scriptPath}`, `${kind}: same origin, under the proxy`);
      // The file: from cbase itself - 200, JavaScript, nosniff; neither source nor debug port nor decoy sees the request.
      const file = await raw("127.0.0.1", px.port, scriptPath, {});
      assert.equal(file.status, 200, `${kind}: the file`);
      assert.match(file.headers["content-type"] || "", /^text\/javascript\b/, `${kind}: as JavaScript`);
      assert.equal(file.headers["x-content-type-options"], "nosniff", `${kind}: nosniff`);
      assert.match(file.body, /Toggle screencast/);
      const post = await new Promise((resolve, reject) => {
        const q = http.request({ host: "127.0.0.1", port: px.port, path: scriptPath, method: "POST", agent: false }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
        q.on("error", reject);
        q.end("x");
      });
      assert.equal(post, 405, `${kind}: only GET/HEAD`);
      const onlyFile = (list) => list.map((a) => a.url).filter((u) => u.startsWith("/devtools/") && !u.startsWith("/devtools/inspector.html"));
      assert.deepEqual(onlyFile(source.requests().slice(sourcePrior)), [], `${kind}: the source in B got the file request`);
      assert.equal(httpToThe(f.inst).length, httpInstance, `${kind}: an HTTP request reached the instance's debug port`);
      assert.deepEqual(onlyFile(httpToThe(f.decoy).slice(httpDecoy)), [], `${kind}: the decoy got the file request`);
      if (script === null) script = file.body;
      else assert.equal(file.body, script, "the same script for B and instance");
    }

    // The logic as served. Slow setup (gateway, proxy, container): the button is in the tree from tick 3 and locked until tick
    // 6 - no click before that, exactly one effective, then rest.
    const slow = frontend({ appears: 3, free: 7 });
    const l1 = screencastRun(script, slow);
    l1.ticks(50);
    assert.equal(slow.button.toggled, false, "slow setup: the mirror stayed on (a click before the enabling was lost)");
    assert.equal(slow.button.clicks, 1, "clicking happens only once enabled");
    assert.ok(l1.stopped && slow.tick === 7, `rest after the effective click (tick ${slow.tick})`);
    // The lock is not readable: repeat until the click works - and not beyond.
    const blind = frontend({ free: 5, withoutLock: true });
    const l2 = screencastRun(script, blind);
    l2.ticks(50);
    assert.equal(blind.button.toggled, false);
    assert.equal(blind.button.effective, 1, "exactly one effective click");
    assert.ok(l2.stopped && blind.tick === 5);
    // The effect becomes visible only at the next tick: no second click (it would switch the mirror on again).
    const late = frontend({ late: true });
    const l3 = screencastRun(script, late);
    l3.ticks(50);
    assert.equal(late.button.toggled, false);
    assert.equal(late.button.clicks, 1, "a second click would have switched the mirror on again");
    assert.ok(l3.stopped && late.tick === 2);
    // Already off (the user's choice is in the origin's localStorage): no click, rest at once.
    const out = frontend({ enabled: false });
    const l4 = screencastRun(script, out);
    l4.ticks(50);
    assert.equal(out.button.clicks, 0);
    assert.ok(l4.stopped && out.tick === 1);
    // The cap: no button, rest after 100 ticks.
    const never = frontend({ appears: Infinity });
    const l5 = screencastRun(script, never);
    l5.ticks(1000);
    assert.ok(l5.stopped, "the cap did not take hold");
    assert.equal(never.tick, 101, "cap 100 ticks");
  } finally {
    scan?.stop();
    await stopDevtoolsSource();
    if (savedChromium === undefined) delete process.env.CBASE_CHROMIUM; else process.env.CBASE_CHROMIUM = savedChromium;
    await px.shutdown();
    await f.shutdown();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
