// The rewrite proxy of the preview links (server/backend/electron/server/preview/rewrite-proxy.js). Without a server, without
// ngrok: a fake service (http.createServer, port 0) delivers HTML, JS, JSON, SSE, a redirect with Set-Cookie, binary data and a
// WebSocket upgrade; the requests go DIRECTLY to the proxy, with `Host: abc.ngrok-free.dev` and `X-Forwarded-Proto: https` - the
// way the ngrok agent sends them. No clock: where order matters (chunk boundary, SSE, abort), service and test wait on gates (events).
//
// The promises:
//   (1) `rewriter.replace`: every spelling of the service origin (http/ws, four hosts, log-relative, JSON-escaped, URL-encoded in
//       both cases) is replaced - foreign ports and a port with one more digit are NOT.
//   (2) Request to the service: `Host: localhost:<port>`, Origin/Referer of the public origin rewritten (the path stays),
//       X-Forwarded-For, `Accept-Encoding: identity`; method, path and body unchanged. NO X-Forwarded-Host/-Proto (Next.js prefers
//       X-Forwarded-Host over Host and rejects Server Actions if it does not match the Origin) - the public address is in
//       X-cbase-Public-Host/-Proto.
//   (3) Response: text bodies rewritten (without Content-Length), Location/Set-Cookie rewritten, binary data byte-equal with
//       Content-Length.
//   (4) A pattern split across two chunks is hit (the service writes the second half only after the visitor has seen the first line).
//   (5) SSE: an event arrives at the visitor before the service ends the stream - and NEVER gzip, even if the visitor accepts gzip
//       (otherwise the last event went missing via ngrok); a large HTML body goes out gzip and unpacks to the rewritten text.
//   (6) WebSocket upgrade: Host/Origin rewritten, afterwards the tunnel speaks in both directions.
//   (7) Errors: dead service => 502 with the proxy's sentence; without Host => 400; an abort by the visitor aborts the request to
//       the service; after `close()` the port is closed (ECONNREFUSED) and `openProxies()` no longer counts it.
//   (8) Streamed text that is NOT an event stream (text/plain) also arrives before the end with gzip.
//   (9) Unchanged: a partial response (206 + Content-Range, also with gzip in Accept), RSC (text/x-component); a broken status
//       line of the service becomes a 502 instead of a hang - with EXACTLY one log line ("unusable response").
//   (10) An event stream gets its headers before the first event is there; a response with `Cache-Control: no-transform` does not
//       go out gzip (RFC 9110 section 7.7), it is still rewritten.
//   (11) Idle connections: towards the visitor the proxy announces `Keep-Alive: timeout=600` (it closes only after 10 min - ngrok
//       first); towards the service keep-alive, but an IDLE socket the proxy closes itself after its deadline (the service sees it
//       close), and the next request - one after another on the same visitor connection - comes over a new source port.
//   (12) If the service breaks off in the middle of the response, there is a log line and the visitor sees an abort; if the VISITOR
//       leaves, nothing is logged (that is no error), nor when `close()` ends an open stream.
//   (13) A large upload the service answers early (413 without reading the body): the response arrives completely (gzip), nothing
//       in the log, and the next request on the SAME visitor connection is answered.
//   (14) A large upload to a dead service: 502, and the next request on the same visitor connection is answered.
//
// COUNTER-TESTS (each sabotage in preview/rewrite-proxy.js shown red, then restored; "hangs" = the file runs into the deadline,
// `# cancelled 1`, red):
//   - without carry-over (`Stream.transform` splits with `true` - everything out at once) => (4) red (the first half of the pattern
//     went out unchanged, "http://localh" + "ost:<port>" in the body); the others green. (4) is the ONLY guard of the carry-over:
//     (5) hits a chunk boundary in the pattern only by chance.
//   - gzip with flush only for SSE (`sse ? {flush} : {}`) => (8) hangs (the gate never opens); X-Forwarded-Host = public address
//     => (2) red; 206 rewritten => (9) red; writeHead without try => (9) hangs (uncaught exception, no response).
//   - without host rewriting (`headersToService` passes `host` through, no `Host: localhost:<port>`) => (2) and (6) red (the
//     service saw `abc.ngrok-free.dev`); the others green.
//   - event stream gzip again => (5) red; plus the old flush (`sse && !gzip`) => (5) red.
//   - `no-transform` ignored => (10) red.   - no flush of the SSE headers => (10) hangs.
//   - keep-alive to the service (`keepAlive: true`) => (11) red (one source port, no `Connection: close`).
//   - without `server.keepAliveTimeout` => (11) red (`timeout=5`).
//   - without the listeners on the service response (`aborted`/`error`) => (12) hangs - the listener on the request's error alone
//     does not report an abort in the MIDDLE of the response.   - a visitor abort reported as an error => (12) red.
//   - without the "visitor" marker everything stays green (Node 22.17 and Electron's 24.21): if the proxy ends the request to the
//     service itself, the service response reports no abort. The marker is a precaution in case a Node version does.
//   - `Connection: close` to the service again (`keepAlive: false`) => (11) and (13) red.
//   - agent without `timeout` => (11) hangs (the idle socket to the service never closes - the fake service never closes in (11)).
//   - without reading off at `finish` => (13) and (14) hang (the second request stays behind the unread body).
//   - without the `unusable` marker => (9) red (two log lines);   without `closing` => (12) red.
//   NOT red (measured): the upload's write error as an abort again (`serviceBroke(e); res.destroy()`) - with keep-alive the service
//   reads off the rest, no write error arises on this path any more. The branch is a precaution for a service that closes itself
//   after an early response.
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import test from "node:test";
import zlib from "node:zlib";

import { openProxies, startRewriteProxy, rewriter } from "../electron/server/preview/rewrite-proxy.js";

const PUB = "abc.ngrok-free.dev";

const gate = () => { let on; const p = new Promise((r) => { on = r; }); return { p, on }; };

/** The fake service. Through `gates` the test and the service tell each other how far they are. */
async function fakeService() {
  const seen = [];
  const closed = new Set(); // paths whose response is closed (finished or aborted)
  const observer = new Map();
  const gates = { secondHalf: gate(), sseEnd: gate(), streamEnd: gate(), hangsTo: gate(), hangsThere: gate(), sseHeader: gate(), aborts: gate() };
  const socketTo = new WeakMap(); // socket -> promise that resolves when the socket closes
  const toOf = (plinth) => {
    if (!socketTo.has(plinth)) socketTo.set(plinth, new Promise((r) => (plinth.destroyed ? r() : plinth.once("close", r))));
    return socketTo.get(plinth);
  };
  const server = http.createServer(async (req, res) => {
    const P = server.address().port;
    if (req.url === "/early") {
      // Answers at once WITHOUT reading the body (like a middleware with 401 or a limit with 413).
      seen.push({ method: req.method, url: req.url, headers: req.headers, sourcePort: req.socket.remotePort, socketTo: toOf(req.socket) });
      res.writeHead(413, { "content-type": "text/html; charset=utf-8" });
      return res.end(`<p>too large http://localhost:${P}/help</p>`.repeat(10_000));
    }
    let body = "";
    for await (const c of req) body += c;
    seen.push({ method: req.method, url: req.url, headers: req.headers, body, sourcePort: req.socket.remotePort, socketTo: toOf(req.socket) });
    res.on("close", () => { closed.add(req.url); observer.get(req.url)?.(); });
    const u = req.url.split("?")[0];
    if (u === "/html") {
      const t = `<a href="http://localhost:${P}/x">a</a> <script src="//localhost:${P}/app.js"></script> foreign http://localhost:4201/api long http://localhost:${P}0/ Ä`;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": String(Buffer.byteLength(t)) });
      return res.end(t);
    }
    if (u === "/json") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ a: `http://localhost:${P}/a`, b: `http://127.0.0.1:${P}/api`, c: `ws://localhost:${P}/hmr` }).replace(/\//g, "\\/"));
    }
    if (u === "/shared") {
      // First up to the middle of the pattern, then - when the visitor has the first line - the rest.
      res.writeHead(200, { "content-type": "text/javascript" });
      res.write(`first line\nconst baseUrl = "http://localh`);
      await gates.secondHalf.p;
      return res.end(`ost:${P}/";\n`);
    }
    if (u === "/sse") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(`data: {"url":"http://localhost:${P}/a"}\n\n`);
      await gates.sseEnd.p;
      return res.end("data: end\n\n");
    }
    if (u === "/further") {
      res.writeHead(302, {
        location: `http://localhost:${P}/login?callbackUrl=http%3A%2F%2Flocalhost%3A${P}%2Fdash`,
        "set-cookie": ["session=1; Domain=localhost; Path=/; HttpOnly", "second=2; Path=/; domain=.127.0.0.1"],
        "access-control-allow-origin": `http://localhost:${P}`,
      });
      return res.end();
    }
    if (u === "/bin") {
      const b = Buffer.concat([Buffer.from(`http://localhost:${P}`), Buffer.from([0, 255, 128, 10, 13])]);
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(b.length) });
      return res.end(b);
    }
    if (u === "/large") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(`<p>http://localhost:${P}/z</p>`.repeat(2000));
    }
    if (u === "/stream") {
      // A text stream without SSE (a chat answer as text/plain): the first part must be at the visitor before the end.
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.write(`part1 http://localhost:${P}/a\n`);
      await gates.streamEnd.p;
      return res.end("part2\n");
    }
    if (u === "/part") {
      const b = Buffer.from(`0123456789 http://localhost:${P}/x`);
      res.writeHead(206, { "content-type": "text/plain", "content-range": `bytes 0-${b.length - 1}/${b.length + 10}`, "content-length": String(b.length), "accept-ranges": "bytes" });
      return res.end(b);
    }
    if (u === "/rsc") {
      const t = `0:T1a,http://localhost:${P}/abcdefgh\n`;
      res.writeHead(200, { "content-type": "text/x-component" });
      return res.end(t);
    }
    if (u === "/hangs") {
      res.on("close", () => gates.hangsTo.on());
      gates.hangsThere.on();
      return; // never answers
    }
    if (u === "/sse-header") {
      // Like Next: headers at once, the first event only when the visitor has the headers.
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform" });
      res.flushHeaders();
      await gates.sseHeader.p;
      return res.end(`event: done\ndata: {"url":"http://localhost:${P}/x"}\n\n`);
    }
    if (u === "/notransform") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-cache, No-Transform" });
      return res.end(`<p>http://localhost:${P}/z</p>`.repeat(200));
    }
    if (u === "/aborts") {
      // The service breaks off in the middle of the response (crash, restart).
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("part1\n");
      await gates.aborts.p;
      return req.socket.destroy();
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("echo");
  });
  const raw = new Set(); // upgraded sockets are unknown to closeAllConnections - otherwise server.close would wait forever
  server.on("upgrade", (req, plinth) => {
    raw.add(plinth);
    seen.push({ method: req.method, url: req.url, headers: req.headers, upgrade: true });
    plinth.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    plinth.on("data", (d) => plinth.write(`echo:${d}`));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: server.address().port, seen, gates, server,
    /** `fn` runs as soon as the response to `path` is closed - at once if it already is. */
    toObserve: (path, fn) => { if (closed.has(path)) fn(); else observer.set(path, fn); },
    shutdown: () => new Promise((r) => { server.closeAllConnections(); for (const s of raw) s.destroy(); server.close(() => r()); }),
  };
}

/** A request to the proxy the way ngrok sends it. `atData(text)` sees the body grow (unpacked if gzip). */
function calls(proxyPort, path, { method = "GET", headers = {}, body, atData, raw = false } = {}) {
  return new Promise((ok, no) => {
    const req = http.request({
      host: "127.0.0.1", port: proxyPort, method, path,
      headers: { Host: PUB, "X-Forwarded-Proto": "https", "X-Forwarded-For": "203.0.113.7", ...headers },
    }, (res) => {
      const chunk = [];
      const stream = res.headers["content-encoding"] === "gzip" && !raw ? res.pipe(zlib.createGunzip()) : res;
      stream.on("data", (c) => { chunk.push(c); atData?.(Buffer.concat(chunk).toString("utf8")); });
      stream.on("end", () => ok({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunk), text: Buffer.concat(chunk).toString("utf8") }));
      stream.on("error", no);
    });
    req.on("error", no);
    req.end(body);
  });
}

async function withProxy(fn, { target, quietServiceMs } = {}) {
  const service = await fakeService();
  const logs = [];
  const logArrival = gate(); // resolves with the first line in the log - (12) waits for it instead of polling
  const proxy = await startRewriteProxy({ target: target || `http://127.0.0.1:${service.port}`, quietServiceMs, log: (...a) => { logs.push(a.join(" ")); logArrival.on(); } });
  try {
    await fn({ service, proxy, P: service.port, logs, logArrival: logArrival.p });
  } finally {
    await proxy.close();
    await service.shutdown();
  }
}

test("(1) rewriter: every notation of the service origin, only the current port, not one with a digit more", () => {
  const P = 3000;
  const u = rewriter(P, { host: PUB, schema: "https" });
  const cases = [
    [`http://localhost:${P}/a`, `https://${PUB}/a`],
    [`https://localhost:${P}`, `https://${PUB}`],
    [`http://127.0.0.1:${P}/api`, `https://${PUB}/api`],
    [`http://0.0.0.0:${P}`, `https://${PUB}`],
    [`http://[::1]:${P}/`, `https://${PUB}/`],
    [`HTTP://LOCALHOST:${P}`, `https://${PUB}`],
    [`ws://localhost:${P}/hmr`, `wss://${PUB}/hmr`],
    [`//localhost:${P}/app.js`, `//${PUB}/app.js`],
    [`http:\\/\\/localhost:${P}\\/a`, `https:\\/\\/${PUB}\\/a`],
    [`\\/\\/localhost:${P}`, `\\/\\/${PUB}`],
    [`cb=http%3A%2F%2Flocalhost%3A${P}%2Fdash`, `cb=https%3A%2F%2F${PUB}%2Fdash`],
    [`cb=http%3a%2f%2flocalhost%3a${P}%2fdash`, `cb=https%3a%2f%2f${PUB}%2fdash`],
    [`ws%3A%2F%2F127.0.0.1%3A${P}`, `wss%3A%2F%2F${PUB}`],
    // Unchanged: foreign port, one digit more, without "//" before it.
    [`http://localhost:4201/api`, `http://localhost:4201/api`],
    [`http://localhost:${P}0/`, `http://localhost:${P}0/`],
    [`host: localhost:${P}`, `host: localhost:${P}`],
  ];
  for (const [one, out] of cases) assert.equal(u.replace(one), out, one);
  assert.equal(rewriter(P, { host: PUB, schema: "http" }).replace(`ws://localhost:${P}`), `ws://${PUB}`, "schema from X-Forwarded-Proto");
});

test("(2) request to the service: Host, Origin, Referer, X-Forwarded-*, Accept-Encoding identity; body unchanged", async () => {
  await withProxy(async ({ service, proxy, P }) => {
    const body = "x".repeat(70_000);
    const r = await calls(proxy.port, "/echo?q=1", {
      method: "POST", body,
      headers: { Origin: `https://${PUB}`, Referer: `https://${PUB}/page?x=1`, "Accept-Encoding": "gzip, br", "Content-Type": "text/plain" },
    });
    assert.equal(r.status, 200);
    const g = service.seen.at(-1);
    assert.deepEqual([g.method, g.url, g.body.length], ["POST", "/echo?q=1", body.length]);
    assert.equal(g.headers.host, `localhost:${P}`);
    assert.equal(g.headers.origin, `http://localhost:${P}`);
    assert.equal(g.headers.referer, `http://localhost:${P}/page?x=1`);
    // Host, Origin and (missing) X-Forwarded-Host do not contradict each other - otherwise Next.js rejects every Server Action.
    assert.equal(g.headers["x-forwarded-host"], undefined, "X-Forwarded-Host with the public address breaks Next.js Server Actions");
    assert.equal(g.headers["x-forwarded-proto"], undefined, "X-Forwarded-Proto of the public address contradicts the Origin");
    assert.equal(new URL(g.headers.origin).host, g.headers.host);
    assert.equal(g.headers["x-cbase-public-host"], PUB);
    assert.equal(g.headers["x-cbase-public-proto"], "https");
    assert.match(g.headers["x-forwarded-for"], /^203\.0\.113\.7, (127\.0\.0\.1|::ffff:127\.0\.0\.1)$/);
    assert.equal(g.headers["accept-encoding"], "identity");
    // A foreign Origin stays.
    await calls(proxy.port, "/echo", { headers: { Origin: "https://elsewhere.example" } });
    assert.equal(service.seen.at(-1).headers.origin, "https://elsewhere.example");
  });
});

test("(3) response: text rewritten without Content-Length, Location and Set-Cookie rewritten, binary data byte-equal", async () => {
  await withProxy(async ({ proxy, P }) => {
    let r = await calls(proxy.port, "/html");
    assert.equal(r.headers["content-length"], undefined, "rewritten body: no Content-Length");
    assert.equal(r.text, `<a href="https://${PUB}/x">a</a> <script src="//${PUB}/app.js"></script> foreign http://localhost:4201/api long http://localhost:${P}0/ Ä`);
    r = await calls(proxy.port, "/json");
    assert.deepEqual(JSON.parse(r.text), { a: `https://${PUB}/a`, b: `https://${PUB}/api`, c: `wss://${PUB}/hmr` });
    r = await calls(proxy.port, "/further");
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, `https://${PUB}/login?callbackUrl=https%3A%2F%2F${PUB}%2Fdash`);
    assert.deepEqual(r.headers["set-cookie"], ["session=1; Path=/; HttpOnly", "second=2; Path=/"]);
    assert.equal(r.headers["access-control-allow-origin"], `https://${PUB}`);
    r = await calls(proxy.port, "/bin", { headers: { "Accept-Encoding": "gzip" } });
    assert.deepEqual(r.buf, Buffer.concat([Buffer.from(`http://localhost:${P}`), Buffer.from([0, 255, 128, 10, 13])]));
    assert.equal(r.headers["content-length"], String(r.buf.length));
    assert.equal(r.headers["content-encoding"], undefined, "binary data is not compressed");
  });
});

test("(4) a pattern split across the chunk boundary is replaced", async () => {
  await withProxy(async ({ service, proxy }) => {
    const r = await calls(proxy.port, "/shared", {
      atData: (t) => { if (t.includes("first line\n")) service.gates.secondHalf.on(); },
    });
    assert.equal(r.text, `first line\nconst baseUrl = "https://${PUB}/";\n`);
  });
});

test("(5) SSE: the event arrives before the end, never gzip; a large HTML body unpacks to the rewritten text", async () => {
  for (const gzip of [false, true]) {
    await withProxy(async ({ service, proxy }) => {
      const r = await calls(proxy.port, "/sse", {
        headers: gzip ? { "Accept-Encoding": "gzip, deflate, br, zstd" } : {},
        atData: (t) => { if (t.includes(`data: {"url":"https://${PUB}/a"}\n\n`)) service.gates.sseEnd.on(); },
      });
      // If the event did not arrive before the end, nobody opened the gate - the service never ended, and the test would hang.
      assert.equal(r.text, `data: {"url":"https://${PUB}/a"}\n\ndata: end\n\n`);
      assert.equal(r.headers["content-encoding"], undefined, `an event stream never goes out gzip (Accept-Encoding ${gzip ? "with" : "without"} gzip)`);
    });
  }
  await withProxy(async ({ proxy, P }) => {
    const r = await calls(proxy.port, "/large", { headers: { "Accept-Encoding": "gzip;q=1, identity;q=0.5" }, raw: true });
    assert.equal(r.headers["content-encoding"], "gzip");
    assert.match(r.headers.vary, /Accept-Encoding/);
    const text = zlib.gunzipSync(r.buf).toString("utf8");
    assert.ok(text === `<p>https://${PUB}/z</p>`.repeat(2000), `unpacks to the rewritten text (${text.length} characters, start ${text.slice(0, 60)})`);
    assert.ok(r.buf.length < text.length / 5, `compressed (${r.buf.length} of ${text.length})`);
    assert.ok(!text.includes(`localhost:${P}`));
    const without = await calls(proxy.port, "/large", { headers: { "Accept-Encoding": "gzip;q=0" } });
    assert.equal(without.headers["content-encoding"], undefined, "gzip;q=0 means: not");
  });
});

test("(6) WebSocket upgrade: Host/Origin rewritten, afterwards in both directions", async () => {
  await withProxy(async ({ service, proxy, P }) => {
    const { res, plinth } = await new Promise((ok, no) => {
      const req = http.request({
        host: "127.0.0.1", port: proxy.port, path: "/hmr?token=1",
        headers: { Host: PUB, "X-Forwarded-Proto": "https", Origin: `https://${PUB}`, Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==" },
      });
      req.on("upgrade", (res, plinth) => ok({ res, plinth }));
      req.on("response", (res) => no(new Error(`no upgrade: ${res.statusCode}`)));
      req.on("error", no);
      req.end();
    });
    try {
      assert.equal(res.statusCode, 101);
      const g = service.seen.find((x) => x.upgrade);
      assert.deepEqual([g.url, g.headers.host, g.headers.origin, g.headers.upgrade, g.headers["sec-websocket-key"]],
        ["/hmr?token=1", `localhost:${P}`, `http://localhost:${P}`, "websocket", "dGhlIHNhbXBsZSBub25jZQ=="]);
      const response = new Promise((r) => plinth.once("data", (d) => r(String(d))));
      plinth.write("ping");
      assert.equal(await response, "echo:ping");
    } finally {
      plinth.destroy();
    }
  });
});

test("(7) dead service 502, without Host 400, abort reaches the service, after close() the port is closed", async () => {
  // A port nobody listens on: occupy it once, release it again.
  const free = await new Promise((r) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
  const tot = await startRewriteProxy({ target: `http://127.0.0.1:${free}`, log: () => {} });
  try {
    const r = await calls(tot.port, "/");
    assert.equal(r.status, 502);
    assert.match(r.headers["content-type"], /^text\/plain/);
    assert.equal(r.text, `The service on port ${free} is not responding — is it running?`);
  } finally {
    await tot.close();
  }

  let port;
  const prior = openProxies();
  await withProxy(async ({ service, proxy }) => {
    port = proxy.port;
    assert.equal(openProxies(), prior + 1);
    // Without Host (HTTP/1.0 may omit it).
    const withoutHost = await new Promise((ok) => {
      const s = net.connect(proxy.port, "127.0.0.1", () => s.write("GET / HTTP/1.0\r\n\r\n"));
      let t = "";
      s.on("data", (d) => { t += d; });
      s.on("end", () => ok(t));
    });
    assert.match(withoutHost, /^HTTP\/1\.[01] 400 /);
    // Abort: the visitor leaves while the service has not answered yet => the request to the service is closed.
    const req = http.request({ host: "127.0.0.1", port: proxy.port, path: "/hangs", headers: { Host: PUB } });
    req.on("error", () => {});
    req.end();
    await service.gates.hangsThere.p;
    req.destroy();
    await service.gates.hangsTo.p;
  });
  assert.equal(openProxies(), prior);
  const error = await new Promise((r) => { const s = net.connect(port, "127.0.0.1"); s.on("connect", () => { s.destroy(); r("connected"); }); s.on("error", (e) => r(e.code)); });
  assert.equal(error, "ECONNREFUSED", "after close() nothing listens any more");
});

test("(8) streamed text without SSE also arrives with gzip before the end", async () => {
  await withProxy(async ({ service, proxy }) => {
    const r = await calls(proxy.port, "/stream", {
      headers: { "Accept-Encoding": "gzip, deflate, br" },
      atData: (t) => { if (t.includes(`part1 https://${PUB}/a\n`)) service.gates.streamEnd.on(); },
    });
    // If the first part stayed in the deflate buffer, nobody opened the gate - the service never ended, and the test would hang.
    assert.equal(r.headers["content-encoding"], "gzip");
    assert.equal(r.text, `part1 https://${PUB}/a\npart2\n`);
  });
});

test("(9) unchanged: partial response (206) and RSC; a broken status line becomes a 502", async () => {
  await withProxy(async ({ proxy, P }) => {
    const part = await calls(proxy.port, "/part", { headers: { "Accept-Encoding": "gzip", Range: "bytes=0-" } });
    const b = Buffer.from(`0123456789 http://localhost:${P}/x`);
    assert.equal(part.status, 206);
    assert.deepEqual(part.buf, b, "a partial response goes out byte-equal");
    assert.equal(part.headers["content-range"], `bytes 0-${b.length - 1}/${b.length + 10}`);
    assert.equal(part.headers["content-encoding"], undefined, "a partial response is not compressed");
    assert.equal(part.headers["content-length"], String(b.length));
    const rsc = await calls(proxy.port, "/rsc", { headers: { "Accept-Encoding": "gzip" } });
    assert.equal(rsc.text, `0:T1a,http://localhost:${P}/abcdefgh\n`, "RSC (length prefix) stays unchanged");
    assert.equal(rsc.headers["content-encoding"], undefined);
  });

  // A service with a control character in the status reason: the parser accepts it, writeHead would throw.
  const raw = net.createServer((s) => {
    s.once("data", () => s.end("HTTP/1.1 200 O\x01K\r\nContent-Type: text/plain\r\nContent-Length: 2\r\n\r\nok"));
    s.on("error", () => {});
  });
  await new Promise((r) => raw.listen(0, "127.0.0.1", r));
  const logs = [];
  const proxy = await startRewriteProxy({ target: `http://127.0.0.1:${raw.address().port}`, log: (...a) => logs.push(a.join(" ")) });
  try {
    const r = await calls(proxy.port, "/");
    assert.equal(r.status, 502);
    assert.match(r.text, /unusable response/);
    // Discarding the service's response is no abort BY the service - exactly one line saying what happened.
    assert.equal(logs.length, 1, JSON.stringify(logs));
    assert.match(logs[0], /unusable response/);
  } finally {
    await proxy.close();
    await new Promise((r) => raw.close(() => r()));
  }
});

test("(10) an event stream gets its headers before the first event; no-transform does not go out gzip", async () => {
  await withProxy(async ({ service, proxy, P }) => {
    // The service writes the event only when the visitor has the headers - if the proxy held them back, the test would hang.
    const r = await new Promise((ok, no) => {
      const req = http.request({
        host: "127.0.0.1", port: proxy.port, path: "/sse-header",
        headers: { Host: PUB, "X-Forwarded-Proto": "https", "Accept-Encoding": "gzip, deflate, br, zstd", Accept: "text/event-stream" },
      }, (res) => {
        service.gates.sseHeader.on();
        let t = "";
        res.on("data", (d) => { t += d; });
        res.on("end", () => ok({ headers: res.headers, text: t }));
        res.on("error", no);
      });
      req.on("error", no);
      req.end();
    });
    assert.equal(r.headers["content-encoding"], undefined);
    assert.equal(r.text, `event: done\ndata: {"url":"https://${PUB}/x"}\n\n`);

    const nt = await calls(proxy.port, "/notransform", { headers: { "Accept-Encoding": "gzip" } });
    assert.equal(nt.headers["content-encoding"], undefined, "Cache-Control: no-transform forbids re-encoding");
    assert.equal(nt.text, `<p>https://${PUB}/z</p>`.repeat(200), "it is rewritten anyway");
    assert.ok(!nt.text.includes(`localhost:${P}`));
  });
});

/** The complete responses in `buf` (raw from the wire): each `{ header, body }`, the body de-chunked resp. by Content-Length. */
function responsesFrom(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    const headerEnd = buf.indexOf("\r\n\r\n", i);
    if (headerEnd < 0) break;
    const header = buf.subarray(i, headerEnd).toString("latin1");
    let j = headerEnd + 4;
    const parts = [];
    const length = /^content-length:\s*(\d+)$/im.exec(header);
    if (/^transfer-encoding:\s*chunked$/im.test(header)) {
      for (;;) {
        const lineEnd = buf.indexOf("\r\n", j);
        if (lineEnd < 0) return out;
        const n = parseInt(buf.subarray(j, lineEnd).toString("latin1"), 16);
        j = lineEnd + 2;
        if (n === 0) { j += 2; break; }
        if (j + n + 2 > buf.length) return out;
        parts.push(buf.subarray(j, j + n));
        j += n + 2;
      }
      if (j > buf.length) return out;
    } else if (length) {
      const n = Number(length[1]);
      if (j + n > buf.length) return out;
      parts.push(buf.subarray(j, j + n));
      j += n;
    }
    out.push({ header, body: Buffer.concat(parts) });
    i = j;
  }
  return out;
}

/** A raw connection to the proxy the way ngrok holds it: `send(text|Buffer)` writes, `responses(n)` waits until n complete
 *  responses are there - or the connection closes, then with those that are there (the check afterwards turns red instead of hanging). */
function rawConnection(port) {
  const s = net.connect(port, "127.0.0.1");
  let buf = Buffer.alloc(0);
  let closed = false;
  const wait = new Set();
  const check = () => {
    if (!wait.size) return;
    const existing = responsesFrom(buf);
    for (const w of [...wait]) if (closed || existing.length >= w.n) { wait.delete(w); w.ok(existing); }
  };
  s.on("data", (d) => { buf = Buffer.concat([buf, d]); check(); });
  s.on("close", () => { closed = true; check(); });
  s.on("error", () => {});
  return {
    send: (x) => s.write(x),
    responses: (n) => new Promise((ok) => { wait.add({ n, ok }); check(); }),
    shutdown: () => s.destroy(),
  };
}

test("(11) idle connections: towards the visitor 10 min keep-alive, towards the service keep-alive with its own short idle deadline", async () => {
  await withProxy(async ({ service, proxy }) => {
    // The fake service never closes idle connections itself (and announces no deadline) - if the socket closes, it was the proxy.
    service.server.keepAliveTimeout = 0;
    const v = rawConnection(proxy.port);
    try {
      // Two requests ONE AFTER ANOTHER on ONE connection, as ngrok sends them: the second only when the first is answered and
      // the proxy has closed the idle socket to the service.
      v.send(`GET /echo HTTP/1.1\r\nHost: ${PUB}\r\n\r\n`);
      await v.responses(1);
      const first = service.seen.at(-1);
      assert.equal(first.headers.connection, "keep-alive", "to the service: keep-alive (Connection: close cut off early responses to uploads)");
      await first.socketTo; // without its own deadline on the agent the idle socket would stay open - the test would hang here
      v.send(`GET /echo HTTP/1.1\r\nHost: ${PUB}\r\n\r\n`);
      const responses = await v.responses(2);
      assert.deepEqual(responses.map((a) => [a.header.split("\r\n")[0], String(a.body)]), [["HTTP/1.1 200 OK", "echo"], ["HTTP/1.1 200 OK", "echo"]], "both requests on the same connection answered");
      assert.match(responses[0].header, /^keep-alive: timeout=600$/im, "the proxy announces 600 s of idleness - ngrok closes first");
      const second = service.seen.at(-1);
      assert.notEqual(second.sourcePort, first.sourcePort, "the idle socket to the service was not reused");
    } finally {
      v.shutdown();
    }
  }, { quietServiceMs: 20 });
});

test("(12) an abort by the service in the middle of the response is in the log; an abort by the visitor is not", async () => {
  await withProxy(async ({ service, proxy, logs, logArrival }) => {
    await assert.rejects(
      calls(proxy.port, "/aborts", { atData: (t) => { if (t.includes("part1\n")) service.gates.aborts.on(); } }),
      "the visitor sees an abort, not a clean end",
    );
    // The line comes from an event of the proxy - wait until it is there (no time limit: if it is missing, the test hangs red in the gate).
    await logArrival;
    assert.equal(logs.length, 1, JSON.stringify(logs));
    assert.match(logs[0], /aborted midway \(GET \/aborts\)/);
  });
  await withProxy(async ({ service, proxy, logs }) => {
    // The visitor leaves after the first part; the service notices (its response closes) - only then is it counted.
    const serviceTo = gate();
    const req = http.request({ host: "127.0.0.1", port: proxy.port, path: "/stream", headers: { Host: PUB } }, (res) => {
      res.once("data", () => req.destroy());
    });
    const visitorTo = new Promise((r) => req.on("close", r));
    req.on("error", () => {});
    req.end();
    await visitorTo;
    service.toObserve("/stream", serviceTo.on);
    await serviceTo.p;
    assert.deepEqual(logs, [], "the visitor left - no error of the service");
  });
  await withProxy(async ({ service, proxy, logs }) => {
    // The link closes (deleted, expired, server end) while a stream is open: the proxy aborts itself.
    const serviceTo = gate();
    const open = gate();
    const req = http.request({ host: "127.0.0.1", port: proxy.port, path: "/stream", headers: { Host: PUB } }, (res) => {
      res.once("data", () => open.on());
      res.on("error", () => {});
    });
    req.on("error", () => {});
    req.end();
    await open.p;
    await proxy.close();
    service.toObserve("/stream", serviceTo.on);
    await serviceTo.p;
    assert.deepEqual(logs, [], "close() is no abort by the service");
  });
});

/** An upload of `size` bytes on a raw connection, then - when its response is there - a GET on the SAME connection, as ngrok
 *  would place it. Returns both responses (if the second is missing because the connection closed, only the first). */
async function uploadAndAfterwards(port, path, size) {
  const v = rawConnection(port);
  try {
    v.send(`POST ${path} HTTP/1.1\r\nHost: ${PUB}\r\nX-Forwarded-Proto: https\r\nAccept-Encoding: gzip\r\nContent-Type: application/octet-stream\r\nContent-Length: ${size}\r\n\r\n`);
    v.send(Buffer.alloc(size, 120));
    const [first] = await v.responses(1);
    assert.ok(first, "no response to the upload");
    v.send(`GET /echo HTTP/1.1\r\nHost: ${PUB}\r\nX-Forwarded-Proto: https\r\n\r\n`);
    const [, second] = await v.responses(2);
    const status = (a) => Number(a?.header.split(" ")[1]);
    const text = (a) => (a && /^content-encoding:\s*gzip$/im.test(a.header) ? zlib.gunzipSync(a.body) : a?.body)?.toString("utf8");
    return {
      first: { status: status(first), text: text(first), gzip: /^content-encoding:\s*gzip$/im.test(first.header) },
      second: second ? { status: status(second), text: text(second) } : null,
    };
  } finally {
    v.shutdown();
  }
}

test("(13) a large upload with an early response: the response arrives completely, nothing in the log, the connection stays usable", async () => {
  await withProxy(async ({ proxy, logs }) => {
    const { first, second } = await uploadAndAfterwards(proxy.port, "/early", 5 * 1024 * 1024);
    assert.equal(first.status, 413);
    assert.ok(first.gzip, "the error page is text and goes out gzip");
    assert.ok(first.text === `<p>too large https://${PUB}/help</p>`.repeat(10_000), `complete and rewritten (${first.text.length} characters)`);
    assert.deepEqual(second, { status: 200, text: "echo" }, "the next request on the same visitor connection");
    assert.deepEqual(logs, [], "a write error of the upload after the response is no abort by the service");
  });
});

test("(14) a large upload to a dead service: 502, the connection stays usable", async () => {
  const free = await new Promise((r) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
  const tot = await startRewriteProxy({ target: `http://127.0.0.1:${free}`, log: () => {} });
  try {
    const { first, second } = await uploadAndAfterwards(tot.port, "/up", 1024 * 1024);
    assert.equal(first.status, 502);
    assert.deepEqual(second, { status: 502, text: `The service on port ${free} is not responding — is it running?` }, "the next request on the same visitor connection is answered");
  } finally {
    await tot.close();
  }
});
