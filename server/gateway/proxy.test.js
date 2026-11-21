// The gateway proxy and the session cookie.
//
// The backend passes the DevTools of a streamed browser on to Chromium (server/backend/electron/server/browsers.js proxyDevtools);
// if the browser runs in a project container, THAT reads the request header. The upgrade path (index.js) always stripped the
// cookie; the HTTP path (proxy.js proxyRequest) passed it through — the user's session cookie landed in the container on every
// fetch of inspector.html. Here: on /api/browsers/<id>/devtools/* no cookie goes to the container (not even via a spelling with
// `..`), every other /api/* request passes it on as before (counter-test in the same test). The login at the gateway happens
// BEFORE proxyRequest (index.js sessionOf) — stripping does not change it, and the backend reads no cookie.
//
// Sabotage: remove the line `if (devtools) delete headers.cookie;` in proxy.js => the first test red (the cookie reaches the
// backend).
//
// No clock: waits on the response; every connection is closed in the finally (closeAllConnections before close).
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  DEVTOOLS_RESPONSE_FORBIDDEN, isDevtoolsPath, withoutForbiddenHeaders, proxyRequest, rawHeaderWithoutForbidden, passThroughUpgradeResponse,
} from "./proxy.js";
import * as inBackend from "../../server/backend/electron/server/runtime/response-header.js";

const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));
const to = (srv) => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); });

function retrieval(port, path, header) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, path, headers: header, agent: false }, (res) => {
      let b = "";
      res.on("data", (d) => { b += d; });
      res.on("end", () => resolve({ status: res.statusCode, body: b }));
    });
    r.on("error", reject);
    r.end();
  });
}

test("HTTP on …/devtools/* passes no cookie to the container; every other /api/* request passes it on (counter-test)", async () => {
  const seen = [];
  const backend = http.createServer((req, res) => {
    seen.push({ url: req.url, cookie: req.headers.cookie ?? null, accept: req.headers.accept ?? null });
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
  });
  const bPort = await listen(backend);
  const gateway = http.createServer((req, res) => proxyRequest(req, res, { port: bPort, userId: "u1", onActivity: () => {} }));
  const gPort = await listen(gateway);
  try {
    const header = { Cookie: "cbase_session=SECRET", Accept: "text/html" };
    for (const path of [
      "/api/browsers/0f0f-1/devtools/inspector.html?ws=x",
      "/api/browsers/0f0f-1/devtools/json/version",
      "/api/browsers/0f0f-1/devtools",
      "/api/projects/../browsers/0f0f-1/devtools/inspector.html",
    ]) {
      const r = await retrieval(gPort, path, header);
      assert.equal(r.status, 200, path);
      const g = seen.at(-1);
      assert.equal(g.cookie, null, `${path}: the session cookie reached the backend (and with it the instance's Chromium)`);
      assert.equal(g.accept, "text/html", `${path}: the rest of the header passes on`);
    }
    // Counter-test: the same request on another route carries the cookie as before.
    for (const path of ["/api/projects", "/api/browsers", "/api/browsers/0f0f-1/stream", "/api/browsersx/devtools/a"]) {
      await retrieval(gPort, path, header);
      assert.equal(seen.at(-1).cookie, "cbase_session=SECRET", `${path}: the cookie is missing`);
    }
    assert.equal(isDevtoolsPath("/api/browsers/a/devtools/x"), true);
    assert.equal(isDevtoolsPath("/api/browsers/a/stream"), false);
  } finally {
    await to(gateway);
    await to(backend);
  }
});

// ── the RESPONSE on …/devtools/* ──────────────────────────────────────────────────────────────────────────────────────────────
// The backend serves the DevTools UI of a project browser itself and passes only the WebSocket through from the project
// container; it strips the header lines with which a response SETS something at the user. The gateway does the same on the same
// path, in depth — on HTTP (proxyRequest) and in the upgrade (index.js -> passThroughUpgradeResponse). Without it:
// `res.writeHead(ur.statusCode, ur.headers)` and `up.pipe(socket)`, unfiltered. All other paths as before (counter-test).
// The SAME list and the same calculation live in the backend (server/backend/electron/server/runtime/response-header.js) — bound
// here.
// Sabotage (proxy.js and index.js without the filtering): the HTTP test red (Set-Cookie "FROM-CONTAINER" arrived), the upgrade
// test red (the header went through unfiltered), the wiring test red (index.js without the filter).
const MALICIOUS = {
  "Set-Cookie": "cbase_session=FROM-CONTAINER; Path=/; HttpOnly", "Set-Cookie2": "x=1", "Clear-Site-Data": "\"cookies\"",
  Refresh: "0; url=https://foreign.example/", Link: "</b.js>; rel=preload", "Service-Worker-Allowed": "/",
};
const ROWS = ["set-cookie", "set-cookie2", "clear-site-data", "refresh", "link", "service-worker-allowed"];
// One turn of the event loop — an ordering, no deadline (PassThrough forwards within the same turn).
const round = () => new Promise((r) => setImmediate(r));

function retrievalWithHeader(port, path) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, path, agent: false }, (res) => {
      let b = "";
      res.on("data", (d) => { b += d; });
      res.on("end", () => resolve({ status: res.statusCode, header: res.headers, body: b }));
    });
    r.on("error", reject);
    r.end();
  });
}

test("the response on …/devtools/* comes without Set-Cookie, Set-Cookie2, Clear-Site-Data, Refresh, Link, Service-Worker-Allowed; every other route as before", async () => {
  const backend = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain", "X-Stays": "yes", ...MALICIOUS });
    res.end("ok");
  });
  const bPort = await listen(backend);
  const gateway = http.createServer((req, res) => proxyRequest(req, res, { port: bPort, userId: "u1", onActivity: () => {} }));
  const gPort = await listen(gateway);
  try {
    for (const path of ["/api/browsers/0f0f-1/devtools/inspector.html?ws=x", "/api/projects/../browsers/0f0f-1/devtools/a.js"]) {
      const r = await retrievalWithHeader(gPort, path);
      assert.equal(r.status, 200);
      for (const k of ROWS) assert.equal(r.header[k], undefined, `${path}: ${k} reached the user`);
      assert.equal(r.header["x-stays"], "yes", "the rest of the header passes on");
    }
    // Counter-test: another route carries its header as before (the login sets its cookie itself).
    const g = await retrievalWithHeader(gPort, "/api/projects");
    assert.equal(g.header["set-cookie"]?.[0], MALICIOUS["Set-Cookie"]);
    assert.equal(g.header["clear-site-data"], MALICIOUS["Clear-Site-Data"]);
  } finally {
    await to(gateway);
    await to(backend);
  }
});

test("passThroughUpgradeResponse — the 101 without the forbidden lines, also across chunk boundaries; the frames after it unchanged; a header over the cap ends both", async () => {
  const up = new PassThrough();
  const client = new PassThrough();
  let out = "";
  client.on("data", (d) => { out += d; });
  passThroughUpgradeResponse(up, client);
  up.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nSet-Coo");
  await round();
  assert.equal(out, "", "something went out before the header ended");
  up.write("kie: cbase_session=FROM-CONTAINER\r\nConnection: Upgrade\r\nClear-Site-Data: \"*\"\r\n  \"storage\"\r\n");
  up.write("Link: <x>\r\nSec-WebSocket-Accept: abc\r\n\r\nFRAME-1");
  await round();
  assert.equal(out, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: abc\r\n\r\nFRAME-1");
  up.write("FRAME-2 Set-Cookie: stays, this is a frame\r\n\r\n");
  await round();
  assert.ok(out.endsWith("FRAME-1FRAME-2 Set-Cookie: stays, this is a frame\r\n\r\n"), "the data stream after the header passes through raw");

  // The cap: a header without an end beyond `cap` bytes => both sides closed, nothing written.
  const up2 = new PassThrough();
  const client2 = new PassThrough();
  let aus2 = "";
  client2.on("data", (d) => { aus2 += d; });
  passThroughUpgradeResponse(up2, client2, { cap: 16 });
  up2.write("HTTP/1.1 101 x\r\nSet-Cookie: aaaaaaaaaaaaaaaa");
  await round();
  assert.equal(up2.destroyed && client2.destroyed, true, "over the cap the sockets stayed open");
  assert.equal(aus2, "");
});

test("gateway and backend strip the SAME lines the same way (bound); index.js filters the DevTools upgrade", () => {
  assert.deepEqual([...DEVTOOLS_RESPONSE_FORBIDDEN], ROWS);
  assert.deepEqual([...DEVTOOLS_RESPONSE_FORBIDDEN], [...inBackend.FORBIDDEN_RESPONSE_HEADERS]);
  const header = { "Set-Cookie": ["a=1"], "CLEAR-SITE-DATA": "*", link: "<x>", refresh: "0", "service-worker-allowed": "/", "set-cookie2": "c", "content-type": "text/html", etag: "e" };
  assert.deepEqual(withoutForbiddenHeaders(header), inBackend.withoutForbiddenHeaders(header));
  assert.deepEqual(withoutForbiddenHeaders(header), { "content-type": "text/html", etag: "e" });
  const raw = "HTTP/1.1 101 x\r\nUpgrade: websocket\r\nset-cookie : a\r\n\tcontinued\r\nLink: <x>\r\nX-Stays: 1\r\n follows";
  assert.equal(rawHeaderWithoutForbidden(raw), inBackend.rawHeaderWithoutForbidden(raw));
  assert.equal(rawHeaderWithoutForbidden(raw), "HTTP/1.1 101 x\r\nUpgrade: websocket\r\nX-Stays: 1\r\n follows");
  // The wiring in the upgrade path (index.js starts a server when loaded and cannot be loaded here): the DevTools branch filters,
  // the port tunnel does not — and there is no second unfiltered path of the upgrade response.
  const index = fs.readFileSync(new URL("./index.js", import.meta.url), "utf8");
  assert.match(index, /if \(isDevtools\) passThroughUpgradeResponse\(up, socket\);\s*else up\.pipe\(socket\);/);
  assert.equal((index.match(/up\.pipe\(socket\)/g) || []).length, 1, "a second unfiltered path of the upgrade response");
});
