// The dispatcher after the handler split: server.js holds only `for (const route of ROUTES) if ((await route(ctx)) !== NEXT) return;`
// and every route function ends with `return NEXT;`. What is measured here is the one promise that no guard in the gate can
// prove without a real server: a path that is NOT hit falls through ALL routes to the 404, and within the deadline. If a
// `return NEXT;` is missing (the function returns undefined) the dispatcher takes the route as "answered", returns, and the
// client waits until the deadline for an answer that never comes.
// COUNTER-TEST: removing `return NEXT;` in todoRoutes makes `/api/unknown` hang and turns the test red.
//
// Three levels: the top table (unknown path, wrong method on /api/health), the three family owners (unknown sub-path falls
// through all sub-slices, unknown id ends in the 404 of the preamble) and the prelude in server.js (static delivery,
// /api/health), which is the null hypothesis: a route that hits answers exactly once.
//
// The outer skin of the same dispatcher, below from "A1". Every check ENTERS the path that broke:
//   K1   a WebSocket upgrade on /api/tunnel and the DevTools proxy with a foreign origin or host name, on the real startServer
//        (it used to give 101 and raw TCP to the Mac for every web page; the DevTools proxy dropped the origin unchecked);
//   H1   foreign host (DNS rebinding), foreign origin, Sec-Fetch-Site cross-site, `text/plain` body, on the real dispatcher,
//        plus the opposite direction in server mode (the gateway rewrites host and passes the public origin through);
//   H2   `GET //`, `///`, `//x:99999`, `/\`, an absolute target with a broken port, on a server in its OWN process without
//        catcher, because the defect was the process end (exit 1);
//   H10  readBody with an "ä" split across two chunks; N1 readRawBody at the cap (413 instead of a destroyed socket);
//   M2   the process watch of B in its own process, and its registration in server/backend/headless.js AFTER the start.
// COUNTER-TESTS (each turns the named test red): K1 101 instead of 403 ("foreign origin at the tunnel"); H1 200 instead of 403;
// H2 the child dies at `new URL` (node:internal/url); H10 two U+FFFD instead of "ä"; text/plain parsed by readBody ("ok"
// instead of 415); N1 "write EPIPE" instead of 413; headless.js without registering the watch.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { startServer } from "../electron/server/server.js";
import { originVerdict } from "../electron/server/runtime/origin.js";
import { readBody, readBodyOrEmpty, readRawBody, send } from "../electron/server/runtime/http.js";

// Deadline per request. A hanging dispatcher never reports, so the clock throws, with the path in plain text. And it ABORTS
// the request (AbortSignal) instead of just forgetting it: an open connection would hold `server.close()` in the finally
// and turn "red" into "hangs". A test with an open connection closes it in the finally.
const DEADLINE_MS = 5_000;

async function fetchData(url, init) {
  let res;
  try {
    res = await fetch(url, { headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(DEADLINE_MS), ...init });
  } catch (err) {
    if (err?.name === "TimeoutError" || err?.name === "AbortError") throw new Error(`no answer within ${DEADLINE_MS} ms: ${init?.method || "GET"} ${url} - the dispatcher took the route as answered (missing return NEXT?)`);
    throw err;
  }
  const text = await res.text();
  let body = text;
  try { body = JSON.parse(text); } catch { /* HTML or empty */ }
  return { status: res.status, body };
}

async function withServer(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-dispatcher-"));
  const wsPath = path.join(root, "ws");
  const projPath = path.join(wsPath, "till");
  fs.mkdirSync(projPath, { recursive: true });
  fs.mkdirSync(path.join(root, "web"), { recursive: true });
  fs.writeFileSync(path.join(root, "web", "index.html"), "<!doctype html><title>cbase</title>");
  let server;
  try {
    server = await startServer({ port: 0, dataRoot: path.join(root, "data-root"), webDir: path.join(root, "web"), pickDirectory: null, notify: null });
    const base = `http://127.0.0.1:${server.address().port}`;
    const ws = (await fetchData(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ name: "Test", path: wsPath }) })).body;
    const project = (await fetchData(`${base}/api/workspaces/${ws.id}/projects`, { method: "POST", body: JSON.stringify({ name: "Checkout", path: projPath }) })).body;
    const chat = (await fetchData(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, projectId: null, provider: "claude", model: "claude-haiku-4-5-20251001", permissionMode: "bypassPermissions" }) })).body;
    assert.ok(ws.id && project.id && chat.id, `seed created: ${JSON.stringify({ ws: ws.id, project: project.id, chat: chat.id })}`);
    await run({ base, ws, project, chat });
  } finally {
    // Cut every open connection first, then close: `server.close()` would otherwise wait for an answer a broken dispatcher
    // never writes.
    if (server) { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (err) { console.warn(`cleanup: ${err.message}`); }
  }
}

test("dispatcher: an unknown path falls through all routes to the 404 within the deadline", async () => {
  await withServer(async ({ base }) => {
    const r = await fetchData(`${base}/api/unknown`);
    assert.equal(r.status, 404);
    assert.deepEqual(r.body, { error: "not found" });
    // A wrong method on a known route is no hit: /api/health is GET-only (prelude).
    const p = await fetchData(`${base}/api/health`, { method: "POST", body: "{}" });
    assert.equal(p.status, 404);
    // And the null hypothesis: a hit answers exactly once.
    const h = await fetchData(`${base}/api/health`);
    assert.equal(h.status, 200);
    // Mode detection of project creation: without the ops marker "folder"; web and iOS then show the plain dialog.
    assert.deepEqual(h.body, { ok: true, projectCreation: "folder" });
  });
});

test("families: an unknown sub-path falls through all sub-slices, an unknown id ends in the 404 of the preamble", async () => {
  await withServer(async ({ base, ws, project, chat }) => {
    // Chat: nine sub-slices, none responsible: the 404 of the dispatcher, not that of the preamble.
    const c = await fetchData(`${base}/api/chats/${chat.id}/unknown`);
    assert.equal(c.status, 404);
    assert.deepEqual(c.body, { error: "not found" });
    const cf = await fetchData(`${base}/api/chats/00000000-0000-4000-8000-000000000000/log`);
    assert.equal(cf.status, 404);
    assert.deepEqual(cf.body, { error: "chat not found" });
    // Workspace: 15 sub-slices, codeRoute last; an unknown sub-path falls through there too.
    const w = await fetchData(`${base}/api/workspaces/${ws.id}/unknown`);
    assert.equal(w.status, 404);
    assert.deepEqual(w.body, { error: "not found" });
    const wf = await fetchData(`${base}/api/workspaces/00000000-0000-4000-8000-000000000000/overview`);
    assert.equal(wf.status, 404);
    assert.deepEqual(wf.body, { error: "workspace not found" });
    // Project: seven sub-slices.
    const pj = await fetchData(`${base}/api/projects/${project.id}/unknown`);
    assert.equal(pj.status, 404);
    assert.deepEqual(pj.body, { error: "not found" });
    // The sub-slice of the copies: without server operation 404 "only in server mode", a deeper path is not theirs and
    // falls through. DELETE …/stack-copies/:name likewise.
    for (const [m, u] of [["GET", "stack-copies"], ["POST", "stack-copies"], ["GET", "stack-copies/k1"], ["DELETE", "stack-copies/k1"]]) {
      const sk = await fetchData(`${base}/api/projects/${project.id}/${u}`, { method: m, ...(m === "POST" || m === "DELETE" ? { body: "{}" } : {}) });
      assert.equal(sk.status, 404, `${m} ${u}`);
      assert.deepEqual(sk.body, { error: "only in server mode" }, `${m} ${u}`);
    }
    // The sub-slice of the LFS access: without server operation 404 "only in server mode", with `no-store`; only POST is
    // theirs, a GET falls through all sub-slices.
    const lfs = await fetchData(`${base}/api/projects/${project.id}/lfs-access`, { method: "POST", body: JSON.stringify({ host: "git.example.test" }) });
    assert.equal(lfs.status, 404);
    assert.deepEqual(lfs.body, { error: "only in server mode" });
    const lfsGet = await fetchData(`${base}/api/projects/${project.id}/lfs-access`);
    assert.equal(lfsGet.status, 404);
    assert.deepEqual(lfsGet.body, { error: "not found" });
    const deep = await fetchData(`${base}/api/projects/${project.id}/stack-copies/k1/x`);
    assert.equal(deep.status, 404);
    assert.deepEqual(deep.body, { error: "not found" });
    const pf = await fetchData(`${base}/api/projects/00000000-0000-4000-8000-000000000000/services`);
    assert.equal(pf.status, 404);
    assert.deepEqual(pf.body, { error: "project not found" });
    // A hit in every family: ONE answer each, with the id of the preamble.
    assert.equal((await fetchData(`${base}/api/chats/${chat.id}`)).body.id, chat.id);
    assert.equal((await fetchData(`${base}/api/workspaces/${ws.id}`)).body.id, ws.id);
    assert.equal((await fetchData(`${base}/api/projects/${project.id}`)).body.id, project.id);
  });
});

// ══ The outer skin ═══════════════════════════════════════════════════════════════════════════════════════
const TESTDIR = path.dirname(fileURLToPath(import.meta.url));
const SERVER_JS = path.resolve(TESTDIR, "..", "electron", "server", "server.js");
const WATCH_JS = path.resolve(TESTDIR, "..", "electron", "server", "runtime", "process-watch.js");
const HEADLESS = path.resolve(TESTDIR, "..", "headless.js");

// A request with FULL control over the headers (Host, Origin, Sec-Fetch-Site; fetch sets Host and type itself). It is done
// only when the answer is read AND its own body is written (an early 413 arrives before the upload ends).
function request(port, { method = "GET", path: filePath, header = {}, body: bodyText = null }) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, path: filePath, method: method, agent: false, headers: { connection: "close", ...header } }, (res) => {
      const parts = [];
      res.on("data", (d) => parts.push(d));
      res.on("end", () => {
        const text = Buffer.concat(parts).toString("utf8");
        let body = text;
        try { body = JSON.parse(text); } catch { /* no JSON */ }
        written.then(() => resolve({ status: res.statusCode, body }));
      });
    });
    const written = new Promise((ok) => r.once("finish", ok));
    r.on("error", reject);
    r.end(bodyText ?? undefined);
  });
}

// A raw upgrade handshake; returns the status line and closes the socket.
function upgrade(port, filePath, header = {}) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, "127.0.0.1", () => {
      const rows = [`GET ${filePath} HTTP/1.1`, `host: 127.0.0.1:${port}`, "upgrade: websocket", "connection: Upgrade",
        "sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version: 13"];
      const k = { ...header };
      if (k.host) { rows[1] = `host: ${k.host}`; delete k.host; }
      for (const [n, v] of Object.entries(k)) rows.push(`${n}: ${v}`);
      s.write(`${rows.join("\r\n")}\r\n\r\n`);
    });
    let a = "";
    s.on("data", (d) => {
      a += d;
      const i = a.indexOf("\r\n");
      if (i >= 0) { s.destroy(); resolve(a.slice(0, i)); }
    });
    s.on("close", () => resolve(a.split("\r\n")[0] || "(no Response)"));
    s.on("error", reject);
  });
}

// A server without seed (the requests of these tests control their headers themselves).
async function withBareServer(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-outer-shell-"));
  fs.mkdirSync(path.join(root, "web"), { recursive: true });
  fs.writeFileSync(path.join(root, "web", "index.html"), "<!doctype html><title>cbase</title>");
  let server;
  try {
    server = await startServer({ port: 0, dataRoot: path.join(root, "data-root"), webDir: path.join(root, "web"), pickDirectory: null, notify: null });
    await run({ port: server.address().port, root });
  } finally {
    if (server) { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (err) { console.warn(`cleanup: ${err.message}`); }
  }
}

// ── The rule as a function ───────────────────────────────────────────────────────────────────────────────────────────────
test("originVerdict: host only an IP literal or localhost, origin exactly http://<host>, Sec-Fetch-Site only same-origin/none", () => {
  const yes = (header) => assert.deepEqual(originVerdict(header, { ops: "local" }), { ok: true }, JSON.stringify(header));
  const no = (header) => {
    const u = originVerdict(header, { ops: "local" });
    assert.equal(u.ok, false, JSON.stringify(header));
    assert.equal(u.status, 403, JSON.stringify(header));
    assert.ok(u.reason, JSON.stringify(header));
  };
  // Non-browsers (MCP servers and scripts with Node fetch, curl, ws): host without origin and without Sec-Fetch-Site.
  yes({ host: "127.0.0.1:7718" });
  yes({ host: "localhost:7718" });
  yes({ host: "[::1]:7718" });
  yes({ host: "127.0.0.1:41234" }); // the tests start with port 0: the port is not the danger, the name is
  yes({ host: "192.168.1.5:7718" }); // CBASE_HOST bound to an interface
  yes({ host: "127.0.0.1:7718", "sec-fetch-mode": "cors" }); // Node fetch (measured: mode yes, site no)
  yes({});
  // The own UI: the shell loads http://127.0.0.1:<port>/, in the browser also under localhost.
  yes({ host: "127.0.0.1:7718", origin: "http://127.0.0.1:7718", "sec-fetch-site": "same-origin" });
  yes({ host: "localhost:7718", origin: "http://localhost:7718" });
  yes({ host: "LOCALHOST:7718", origin: "http://localhost:7718" });
  yes({ host: "127.0.0.1:80", origin: "http://127.0.0.1" }); // default port: normalised without ":80"
  yes({ host: "127.0.0.1:7718", "sec-fetch-site": "none" }); // address bar, loadURL
  // DNS rebinding: a name that is not localhost.
  no({ host: "evil.example:7718" });
  no({ host: "evil.example" });
  no({ host: "localhost.:7718" });
  no({ host: "x.localhost:7718" });
  no({ host: "evil@127.0.0.1:7718" });
  no({ host: "127.0.0.1.evil.example" });
  no({ host: "0.0.0.0:7718" });
  no({ host: "[::]:7718" });
  no({ host: "" });
  // Foreign origin.
  no({ host: "127.0.0.1:7718", origin: "https://evil.example" });
  no({ host: "127.0.0.1:7718", origin: "null" });
  no({ host: "127.0.0.1:7718", origin: "http://127.0.0.1:3000" }); // another app on the same machine
  no({ host: "127.0.0.1:7718", origin: "https://127.0.0.1:7718" });
  no({ host: "127.0.0.1:7718", origin: "http://localhost:7718" }); // another origin, even if it points to the same place
  no({ origin: "http://127.0.0.1:7718" }); // origin without host: nothing it could be checked against
  no({ host: "127.0.0.1:7718", "sec-fetch-site": "cross-site" });
  no({ host: "127.0.0.1:7718", "sec-fetch-site": "same-site" });
  no({ host: "127.0.0.1:7718", origin: "http://127.0.0.1:7718", "sec-fetch-site": "cross-site" });
  // Server mode: origin and Sec-Fetch-Site do not count (gateway: host rewritten, origin of the user's browser passed
  // through); the host name does (see below).
  assert.deepEqual(originVerdict({ host: "127.0.0.1:49153", origin: "https://cbase.example", "sec-fetch-site": "cross-site" }, { ops: "server" }), { ok: true });
});

// In server mode the WHOLE check must not fall away: B would stay open to DNS rebinding from browsers that run in B itself
// (agent/user browser without instance, loopback of B, fence "as today"). Rule 1 applies in both modes, rules 2 and 3 only
// locally. COUNTER-TEST: a verdict that only knows "everything" or "nothing" turns this red (the gateway form with a public
// origin is 403 under check; without a check `evil.example` goes through, see the next test).
test("originVerdict in server mode: a foreign host name is 403, every measured caller of B is ok", () => {
  const server = (header) => originVerdict(header, { ops: "server" });
  const yes = (header) => assert.deepEqual(server(header), { ok: true }, JSON.stringify(header));
  const no = (header) => {
    const u = server(header);
    assert.equal(u.ok, false, JSON.stringify(header));
    assert.equal(u.status, 403, JSON.stringify(header));
    assert.match(u.reason, /DNS rebinding/, JSON.stringify(header));
  };
  // DNS rebinding: a name that is not localhost, with and without browser features.
  no({ host: "evil.example:7718" });
  no({ host: "evil.example:7718", origin: "http://evil.example:7718", "sec-fetch-site": "same-origin" });
  no({ host: "evil.example" });
  no({ host: "x.localhost:7718" });
  no({ host: "evil@127.0.0.1:7718" });
  no({ host: "" });
  // The measured callers (runtime/origin.js, head "SERVER MODE"):
  yes({ host: "127.0.0.1:49153", origin: "https://cbase.example", "sec-fetch-site": "same-origin" }); // Gateway (proxy.js)
  yes({ host: "127.0.0.1:49153", origin: "https://cbase.example" }); // gateway upgrade (index.js), origin of the public site
  yes({ host: "127.0.0.1:49153" }); // gateway internal (containers.js, push.js)
  yes({ host: "0.0.0.0:7718" }); // MCP server of a run in B: BASE_URL = http://0.0.0.0:7718 (CBASE_HOST=0.0.0.0 in the image)
  yes({ host: "[::]:7718" });
  yes({ host: "10.249.3.1:7718" }); // MCP server of an instance: gateway of the project network (projectbox/token.js backendUrlFor)
  yes({ host: "127.0.0.1:7718" }); // cbase-project, curl of the deploy
  yes({ host: "localhost:7718" }); // in the project container (OUTPUT DNAT)
  yes({});
  // The unspecified address stays foreign locally.
  assert.equal(originVerdict({ host: "0.0.0.0:7718" }, { ops: "local" }).ok, false);
});

// ── H1 on the real dispatcher ──────────────────────────────────────────────────────────────────────────────────────────────
test("foreign host, foreign origin, cross-site and text/plain do not get through the dispatcher; the own UI does", async () => {
  await withBareServer(async ({ port, root }) => {
    const wsPath = (n) => { const p = path.join(root, `ws-${n}`); fs.mkdirSync(p, { recursive: true }); return p; };
    const count = async () => (await request(port, { path: "/api/workspaces" })).body.length;
    const prior = await count();
    const json = { "content-type": "application/json" };

    // DNS rebinding: reading and writing under a foreign name, also the static page (rebinding would read it, then the API).
    const read = await request(port, { path: "/api/workspaces", header: { host: `evil.example:${port}` } });
    assert.equal(read.status, 403, JSON.stringify(read.body));
    assert.equal((await request(port, { path: "/", header: { host: `evil.example:${port}` } })).status, 403);
    const rebind = await request(port, { method: "POST", path: "/api/workspaces", header: { host: `evil.example:${port}`, ...json }, body: JSON.stringify({ name: "R", path: wsPath("r") }) });
    assert.equal(rebind.status, 403, JSON.stringify(rebind.body));
    // CSRF: the blind cross-site POST (text/plain, no preflight), with origin and as cross-site without origin.
    const csrf = await request(port, { method: "POST", path: "/api/workspaces", header: { origin: "https://evil.example", "sec-fetch-site": "cross-site", "content-type": "text/plain;charset=UTF-8" }, body: JSON.stringify({ name: "C", path: wsPath("c") }) });
    assert.equal(csrf.status, 403, JSON.stringify(csrf.body));
    const withoutOrigin = await request(port, { method: "POST", path: "/api/workspaces", header: { "sec-fetch-site": "cross-site", ...json }, body: JSON.stringify({ name: "S", path: wsPath("s") }) });
    assert.equal(withoutOrigin.status, 403, JSON.stringify(withoutOrigin.body));
    // text/plain WITHOUT browser features (the rest of the hole if a check above fell): 415, not parsed. Likewise without type.
    const plainText = await request(port, { method: "POST", path: "/api/workspaces", header: { "content-type": "text/plain;charset=UTF-8" }, body: JSON.stringify({ name: "T", path: wsPath("t") }) });
    assert.equal(plainText.status, 415, JSON.stringify(plainText.body));
    const withoutType = await request(port, { method: "POST", path: "/api/workspaces", body: JSON.stringify({ name: "O", path: wsPath("o") }) });
    assert.equal(withoutType.status, 415, JSON.stringify(withoutType.body));
    assert.equal(await count(), prior, "no workspace from any of the rejected requests");

    // The own UI (same origin) and a non-browser get through.
    const own = await request(port, { method: "POST", path: "/api/workspaces", header: { origin: `http://127.0.0.1:${port}`, "sec-fetch-site": "same-origin", ...json }, body: JSON.stringify({ name: "Own", path: wsPath("e") }) });
    assert.equal(own.status, 201, JSON.stringify(own.body));
    const node = await request(port, { method: "POST", path: "/api/workspaces", header: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify({ name: "Node", path: wsPath("n") }) });
    assert.equal(node.status, 201, JSON.stringify(node.body));
    assert.equal(await count(), prior + 2);
    assert.equal((await request(port, { path: "/", header: { "sec-fetch-site": "none" } })).status, 200, "the UI from the address bar");

    // Server mode (CBASE_CONTAINER=1): the gateway rewrites host to 127.0.0.1:<host port> and passes the origin of the user's
    // browser through (server/gateway/proxy.js); origin and Sec-Fetch-Site do not count there (the host name does: the test
    // "in server mode a foreign host name is 403 ..." below).
    const priorC = process.env.CBASE_CONTAINER;
    process.env.CBASE_CONTAINER = "1";
    try {
      const gw = await request(port, { path: "/api/health", header: { host: "127.0.0.1:49153", origin: "https://cbase.example", "sec-fetch-site": "same-origin" } });
      assert.equal(gw.status, 200, JSON.stringify(gw.body));
    } finally {
      if (priorC === undefined) delete process.env.CBASE_CONTAINER; else process.env.CBASE_CONTAINER = priorC;
    }
  });
});

// On the real server in server mode the dispatcher AND the tunnel gate refuse a foreign host name (rebinding from a browser in
// B: the request comes from loopback, the fence judges "as today"); the forms of the gateway, of the MCP server in B (0.0.0.0)
// and of an instance (gateway of the project network) get through. COUNTER-TEST: 200/101 instead of 403 for `evil.example`
// turns it red (so does a server without any check).
test("in server mode a foreign host name is 403, at the real dispatcher and at the tunnel; the own callers are not", async () => {
  const target = net.createServer((s) => s.on("error", () => {}).end());
  await new Promise((r) => target.listen(0, "127.0.0.1", r));
  const priorC = process.env.CBASE_CONTAINER;
  try {
    await withBareServer(async ({ port }) => {
      process.env.CBASE_CONTAINER = "1";
      // Dispatcher: reading, writing and the static page under a foreign name.
      const read = await request(port, { path: "/api/workspaces", header: { host: `evil.example:${port}` } });
      assert.equal(read.status, 403, JSON.stringify(read.body));
      assert.match(String(read.body?.error), /DNS rebinding/);
      assert.equal((await request(port, { path: "/", header: { host: `evil.example:${port}` } })).status, 403, "the UI under a foreign name");
      const rebind = await request(port, { method: "POST", path: "/api/workspaces", header: { host: `evil.example:${port}`, origin: `http://evil.example:${port}`, "sec-fetch-site": "same-origin", "content-type": "application/json" }, body: JSON.stringify({ name: "R", path: "/tmp/exists-not-a1" }) });
      assert.equal(rebind.status, 403, JSON.stringify(rebind.body));
      // The own callers: gateway (public origin), MCP server in B (0.0.0.0), instance (gateway of the project network), localhost.
      for (const header of [
        { host: `127.0.0.1:${port}`, origin: "https://cbase.example", "sec-fetch-site": "same-origin" },
        { host: "0.0.0.0:7718" },
        { host: "10.249.3.1:7718" },
        { host: "localhost:7718" },
      ]) {
        const r = await request(port, { path: "/api/health", header });
        assert.equal(r.status, 200, `${JSON.stringify(header)}: ${JSON.stringify(r.body)}`);
      }
      // Tunnel upgrade: the same gate.
      const tunnel = `/api/tunnel?port=${target.address().port}`;
      assert.match(await upgrade(port, tunnel, { host: `evil.example:${port}` }), /^HTTP\/1\.1 403 /, "foreign host name at the tunnel (server mode)");
      assert.match(await upgrade(port, tunnel, { host: `evil.example:${port}`, origin: `http://evil.example:${port}` }), /^HTTP\/1\.1 403 /, "foreign host name with own origin at the tunnel");
      assert.match(await upgrade(port, "/api/browsers/00000000-0000-4000-8000-000000000000/devtools/page/1", { host: `evil.example:${port}` }), /^HTTP\/1\.1 403 /, "foreign host name at the DevTools proxy");
      assert.match(await upgrade(port, tunnel, { origin: "https://cbase.example" }), /^HTTP\/1\.1 101 /, "gateway form: host 127.0.0.1, public origin");
      assert.match(await upgrade(port, tunnel, { host: "0.0.0.0:7718" }), /^HTTP\/1\.1 101 /, "Host 0.0.0.0 (BASE_URL in B)");
    });
  } finally {
    if (priorC === undefined) delete process.env.CBASE_CONTAINER; else process.env.CBASE_CONTAINER = priorC;
    await new Promise((r) => target.close(r));
  }
});

test("the tunnel upgrade and the DevTools proxy refuse a foreign page; a non-browser and the own UI are not refused", async () => {
  // A target for the tunnel: without a listening port the 101 would be no proof.
  const target = net.createServer((s) => s.on("error", () => {}).end());
  await new Promise((r) => target.listen(0, "127.0.0.1", r));
  try {
    await withBareServer(async ({ port }) => {
      const tunnel = `/api/tunnel?port=${target.address().port}`;
      assert.match(await upgrade(port, tunnel, { origin: "https://evil.example" }), /^HTTP\/1\.1 403 /, "foreign origin at the tunnel");
      assert.match(await upgrade(port, tunnel, { host: `evil.example:${port}` }), /^HTTP\/1\.1 403 /, "foreign host name at the tunnel (rebinding)");
      assert.match(await upgrade(port, tunnel, { origin: "null" }), /^HTTP\/1\.1 403 /, "origin null at the tunnel");
      assert.match(await upgrade(port, `/api/tunnel?port=${port}`, { origin: "https://evil.example" }), /^HTTP\/1\.1 403 /, "the tunnel to the backend itself");
      // The DevTools proxy used to drop the origin without looking at it; now the gate checks first (the id is unknown:
      // without a check the proxy's 404 would come).
      const dt = "/api/browsers/00000000-0000-4000-8000-000000000000/devtools/page/1";
      assert.match(await upgrade(port, dt, { origin: "https://evil.example" }), /^HTTP\/1\.1 403 /, "foreign origin at the DevTools proxy");
      assert.match(await upgrade(port, dt, { host: `evil.example:${port}` }), /^HTTP\/1\.1 403 /, "foreign host name at the DevTools proxy");
      assert.match(await upgrade(port, dt), /^HTTP\/1\.1 404 /, "without origin as before (browser unknown)");
      // Non-browser (client forwarding, ws without origin) and the own UI: 101.
      assert.match(await upgrade(port, tunnel), /^HTTP\/1\.1 101 /, "without origin");
      assert.match(await upgrade(port, tunnel, { origin: `http://127.0.0.1:${port}` }), /^HTTP\/1\.1 101 /, "own origin");
    });
  } finally {
    await new Promise((r) => target.close(r));
  }
});

// ── H2: a broken request target does not end the process ────────────────────────────────────────────────────────────────
test("`GET //`, `///`, `//x:99999`, `/\\` and an absolute target with a broken port give 400; the server process lives", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-url-"));
  // A process of its own WITHOUT a catcher for unhandled rejections: that is how B ended (exit 1), with ops marker or without.
  // It reports its port and lives until the test ends it.
  const script = `
    const { startServer } = await import(${JSON.stringify(SERVER_JS)});
    const s = await startServer({ port: 0, dataRoot: ${JSON.stringify(path.join(root, "d"))}, webDir: ${JSON.stringify(path.join(root, "w"))}, pickDirectory: null, notify: null });
    console.log("PORT=" + s.address().port);
  `;
  const env = { ...process.env, HOME: path.join(root, "home") };
  delete env.NODE_TEST_CONTEXT;
  delete env.CBASE_CONTAINER;
  const subprocess = spawn(process.execPath, ["--input-type=module", "-e", script], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let error = "";
  subprocess.stderr.on("data", (d) => { error += d; });
  const end = once(subprocess, "exit").then(([code, sig]) => ({ code, sig }));
  try {
    const port = await new Promise((resolve, reject) => {
      subprocess.stdout.on("data", (d) => { out += d; const m = out.match(/PORT=(\d+)/); if (m) resolve(Number(m[1])); });
      end.then(({ code }) => reject(new Error(`child ended before the start (exit ${code}): ${error.slice(-800)}`)));
    });
    const raw = (target) => new Promise((resolve, reject) => {
      const s = net.connect(port, "127.0.0.1", () => s.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`));
      let a = "";
      s.on("data", (d) => { a += d; });
      s.on("close", () => resolve(a.split("\r\n")[0] || "(no Response)"));
      s.on("error", reject);
    });
    for (const target of ["//", "///", "//x:99999", "/\\", "http://a:99999/api/health"]) {
      // Every answer raced against the end of the child: if it dies, that is the statement, not a hang. (Exit 1, or a
      // signal when node-pty aborts in the static destructors.)
      const r = await Promise.race([raw(target), end.then(({ code, sig }) => `child ended (exit ${code}, signal ${sig}): ${error.slice(-600)}`)]);
      assert.match(r, /^HTTP\/1\.1 400 /, `target ${JSON.stringify(target)}: ${r}`);
    }
    const health = await Promise.race([raw("/api/health"), end.then(({ code, sig }) => `child ended (exit ${code}, signal ${sig})`)]);
    assert.match(health, /^HTTP\/1\.1 200 /, "the server keeps answering afterwards");
    assert.equal(subprocess.exitCode, null, "the process lives");
  } finally {
    if (subprocess.exitCode === null && subprocess.signalCode === null) { subprocess.kill("SIGKILL"); await end; }
    // As above: a test must not fail at cleanup; under load a child of the server still writes (ENOTEMPTY).
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); } catch (err) { console.warn(`cleanup: ${err.message}`); }
  }
});

// ── H10, H1, N1: reading the body ──────────────────────────────────────────────────────────────────────────────────────────────
const bodyFrom = (parts, header = { "content-type": "application/json" }) => Object.assign(Readable.from(parts), { headers: header });
const statusOf = async (p) => { try { await p; return "ok"; } catch (e) { return e.status; } };

test("readBody decodes once: a two-byte UTF-8 character split across two chunks stays one character, invalid UTF-8 is 400 instead of silently replaced", async () => {
  const raw = Buffer.from(JSON.stringify({ text: "Grüße äöü" }), "utf8");
  const i = raw.indexOf(Buffer.from("ä")) + 1; // split IN THE MIDDLE of the character
  assert.deepEqual(await readBody(bodyFrom([raw.subarray(0, i), raw.subarray(i)])), { text: "Grüße äöü" });
  // Byte by byte: every boundary once.
  assert.deepEqual(await readBody(bodyFrom([...raw].map((b) => Buffer.from([b])))), { text: "Grüße äöü" });
  // Latin-1 instead of UTF-8: loud (400), not a U+FFFD and 200.
  assert.equal(await statusOf(readBody(bodyFrom([Buffer.from('{"t":"\xe4"}', "latin1")]))), 400);
});

test("readBody reads only under a JSON type: text/plain and a missing type are 415, an empty body stays {}", async () => {
  const j = Buffer.from('{"a":1}');
  assert.equal(await statusOf(readBody(bodyFrom([j], { "content-type": "text/plain;charset=UTF-8" }))), 415);
  assert.equal(await statusOf(readBody(bodyFrom([j], {}))), 415);
  assert.equal(await statusOf(readBody(bodyFrom([j], { "content-type": "application/x-www-form-urlencoded" }))), 415);
  assert.equal(await statusOf(readBody(bodyFrom([j], { "content-type": "multipart/form-data; boundary=x" }))), 415);
  assert.equal(await statusOf(readBody(bodyFrom([j], { "content-type": "application/jsonx" }))), 415);
  assert.deepEqual(await readBody(bodyFrom([j], { "content-type": "application/json; charset=utf-8" })), { a: 1 });
  assert.deepEqual(await readBody(bodyFrom([j], { "content-type": "Application/JSON" })), { a: 1 });
  assert.deepEqual(await readBody(bodyFrom([j], { "content-type": "application/merge-patch+json" })), { a: 1 });
  assert.deepEqual(await readBody(bodyFrom([], { "content-type": "text/plain" })), {});
  assert.deepEqual(await readBody(bodyFrom([], {})), {});
  assert.equal(await statusOf(readBody(bodyFrom([Buffer.from("{broken")]))), 400);
});

// Routes that read with `readBody(req).catch(() => ({}))` turn the loud 415 of readBody into a silent yes WITHOUT fields, and
// the route runs anyway. COUNTER-TEST: a route that swallows the error (a DELETE with `text/plain` still deleting) turns the
// worktree test below red, and the pattern check after it finds the hit.
test("readBodyOrEmpty: empty and broken JSON are {}, 415 and 413 go out", async () => {
  const j = Buffer.from('{"a":1}');
  assert.deepEqual(await readBodyOrEmpty(bodyFrom([j])), { a: 1 });
  assert.deepEqual(await readBodyOrEmpty(bodyFrom([], {})), {});
  assert.deepEqual(await readBodyOrEmpty(bodyFrom([Buffer.from("{broken")])), {});
  assert.deepEqual(await readBodyOrEmpty(bodyFrom([Buffer.from('{"t":"\xe4"}', "latin1")])), {}); // invalid UTF-8 is 400 -> {}
  assert.equal(await statusOf(readBodyOrEmpty(bodyFrom([j], { "content-type": "text/plain;charset=UTF-8" }))), 415);
  assert.equal(await statusOf(readBodyOrEmpty(bodyFrom([j], {}))), 415);
  assert.equal(await statusOf(readBodyOrEmpty(bodyFrom([Buffer.alloc(5_000_001, 0x20)]))), 413);
});

// A route that reads its body through readBodyOrEmpty: `DELETE /api/projects/:id/git/worktree` (devtools/code-route.js). A
// `text/plain` body is 415 and the worktree still exists afterwards; without a body (path in the query) and with broken JSON
// under a JSON type DELETE removes as usual.
test("DELETE of a worktree with a text/plain body is 415 and the worktree still exists afterwards", async () => {
  await withServer(async ({ base, project }) => {
    const repo = path.join(project.path);
    const git = (...args) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
    git("init", "-q", "-b", "main");
    fs.writeFileSync(path.join(repo, "README.md"), "a\n");
    git("add", "README.md");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "one");
    const wt = `${base}/api/projects/${project.id}/git/worktree`;
    const count = async () => ((await fetchData(`${base}/api/projects/${project.id}/git/worktrees?repo=`)).body.worktrees || []).length;
    const create = async (name) => {
      const r = await fetchData(wt, { method: "POST", body: JSON.stringify({ path: name, newBranch: name }) });
      assert.equal(r.status, 200, JSON.stringify(r.body));
    };
    await create("wt1");
    assert.equal(await count(), 2);
    const way = await fetchData(wt, { method: "DELETE", headers: { "Content-Type": "text/plain;charset=UTF-8" }, body: JSON.stringify({ path: "wt1" }) });
    assert.equal(way.status, 415, JSON.stringify(way.body));
    assert.equal(await count(), 2, "the worktree still exists");
    assert.ok(fs.existsSync(path.join(repo, "wt1")), "the worktree folder still exists");
    // The null hypothesis: without a body (the UI, path in the query) and with broken JSON under a JSON type DELETE removes as usual.
    const empty = await fetchData(`${wt}?path=wt1`, { method: "DELETE" });
    assert.equal(empty.status, 200, JSON.stringify(empty.body));
    assert.equal(await count(), 1);
    await create("wt2");
    const broken = await fetchData(`${wt}?path=wt2`, { method: "DELETE", body: "{broken" });
    assert.equal(broken.status, 200, JSON.stringify(broken.body));
    assert.equal(await count(), 1);
  });
});

test("in the server tree no route swallows the error of readBody (`readBody(…).catch(…)`)", () => {
  const tree = path.resolve(TESTDIR, "..", "electron", "server");
  const hits = [];
  const go = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== "node_modules") go(p); continue; }
      if (!e.name.endsWith(".js")) continue;
      fs.readFileSync(p, "utf8").split("\n").forEach((z, i) => {
        if (/^\s*(\/\/|\*)/.test(z)) return;
        if (/\breadBody\([^)]*\)\s*\.catch\s*\(/.test(z)) hits.push(`${path.relative(tree, p)}:${i + 1}: ${z.trim().slice(0, 140)}`);
      });
    }
  };
  go(tree);
  assert.deepEqual(hits, [], `A body that may be missing: runtime/http.js readBodyOrEmpty (415/413 loud):\n${hits.join("\n")}`);
});

test("readRawBody at the cap answers 413 and the socket stays intact until the answer is out", async () => {
  const srv = http.createServer(async (req, res) => {
    try { const b = await readRawBody(req, 1000); send(res, 200, { length: b.length }); }
    catch (e) { send(res, Number(e?.status) || 500, { error: String(e?.message || e) }); }
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const port = srv.address().port;
    const small = await request(port, { method: "POST", path: "/", body: Buffer.alloc(500, 1) });
    assert.deepEqual([small.status, small.body.length], [200, 500]);
    // Far above the cap, in one go (`req.destroy()` without status would give ECONNRESET at the client, 502 at the gateway).
    // With keep-alive like a browser and the gateway's agent: the server reads the rest away (`resume`), the answer goes out.
    // (With `Connection: close` Node closes the socket itself after the answer and the still-writing client would see ECONNRESET.)
    const large = await request(port, { method: "POST", path: "/", header: { connection: "keep-alive" }, body: Buffer.alloc(2 * 1024 * 1024, 1) });
    assert.equal(large.status, 413, JSON.stringify(large.body));
    assert.match(large.body.error, /Rumpf zu groß \(mehr als 1000 Bytes\)/);
  } finally {
    srv.closeAllConnections?.();
    await new Promise((r) => srv.close(r));
  }
});

// ── Pattern 2: the process watch of B ─────────────────────────────────────────────────────────────────────────────────────
test("the process watch: a rejection, an exception and a stream error without a listener do not end the process", async () => {
  // A process of its own: in the test process node:test reports every exception to the running test (intended, so the watch
  // registers only in headless.js, never in startServer).
  const script = `
    import vm from "node:vm";
    import fs from "node:fs";
    const { processWatch } = await import(${JSON.stringify(WATCH_JS)});
    const counter = { rejections: 0, exceptions: 0 };
    let rows = 0;
    processWatch({ counter, output: (z) => { console.log(z.split("\\n")[0]); if (++rows === 3) further(); } });
    Promise.reject(new Error("A1-rejection"));
    setImmediate(() => { throw new Error("A1-exception"); });
    fs.createReadStream("/exists/es/not/A1"); // 'error' without a listener
    function further() {
      // A second listener (like the sandbox of the dynamic workflows): a promise from a foreign realm belongs to it.
      process.on("unhandledRejection", (reason) => {
        console.log("SECOND " + reason.message + " counter=" + counter.rejections);
        console.log("ALIVE");
      });
      vm.runInNewContext("Promise.reject(new Error('A1-realm'))");
    }
  `;
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const subprocess = spawn(process.execPath, ["--input-type=module", "-e", script], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let error = "";
  subprocess.stdout.on("data", (d) => { out += d; });
  subprocess.stderr.on("data", (d) => { error += d; });
  const [code] = await once(subprocess, "exit");
  assert.equal(code, 0, `exit ${code}: ${error.slice(-800)}`);
  const rows = out.trim().split("\n");
  assert.equal(rows.filter((z) => z.startsWith("[process] unhandled rejection #1")).length, 1, out);
  assert.ok(rows.some((z) => z.includes("A1-rejection")), out);
  assert.equal(rows.filter((z) => z.startsWith("[process] uncaught exception")).length, 2, out);
  assert.ok(rows.some((z) => z.includes("A1-exception")), out);
  assert.ok(rows.some((z) => z.includes("ENOENT")), out);
  assert.ok(rows.includes("SECOND A1-realm counter=1"), `the promise from the vm realm was left to the second listener: ${out}`);
  assert.equal(rows.at(-1), "ALIVE", out);
});

test("headless.js registers the process watch AFTER the successful start (server/backend is in no glob)", () => {
  const text = fs.readFileSync(HEADLESS, "utf8");
  assert.match(text, /import \{ processWatch \} from "\.\/electron\/server\/runtime\/process-watch\.js";/);
  const login = text.search(/\nprocessWatch\(\);/);
  const start = text.search(/\nserver = await startServer\(/);
  assert.ok(login > 0, "processWatch() at the top level");
  assert.ok(start > 0, "the start at the top level");
  // Registered before it, a failed start (EADDRINUSE) would end silently with 0 instead of 1 (runtime/process-watch.js, head).
  assert.ok(login > start, "the watch stands BEHIND the start");
  assert.equal(text.match(/processWatch\(/g).length, 1, "exactly one registration");
  // And only there: startServer does not register it (in a test an unhandled rejection should turn red).
  assert.doesNotMatch(fs.readFileSync(SERVER_JS, "utf8"), /processWatch/);
});
