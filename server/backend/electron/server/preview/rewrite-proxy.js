// The rewrite proxy of a preview link.
//
// Why: a project that names `http://localhost:<port>` in the visitor's browser (a client that calls
// `http://localhost:3000/api/…`; NextAuth redirecting to `NEXTAUTH_URL=http://localhost:3000` after login) points to the
// VISITOR's machine through the link; a Vite server rejects the foreign Host header. A link to the frontend port should
// still be enough — without changing the project's code or .env. For that this proxy sits between ngrok listener and
// service:
//
//   ngrok edge ── listener (listenAndForward) ──> http://127.0.0.1:<proxy> (this leaf, in the backend) ──> http://<instance-ip>:<port>
//
// To the service: `Host: localhost:<port>`, Origin/Referer of the public origin ⇒ `http://localhost:<port>`,
// X-Forwarded-For, `Accept-Encoding: identity` (otherwise nothing could be rewritten). Method, path and body unchanged,
// streamed. NO X-Forwarded-Host/-Proto with the public address: Next.js prefers X-Forwarded-Host over Host and aborts
// every Server Action if it does not match the (rewritten) Origin — the service should see itself as "local" throughout.
// For whoever needs it, the public address is in `X-cbase-Public-Host`/`-Proto`.
// To the visitor: in text bodies and in the headers with addresses every spelling of the service origin (ONLY this port)
// ⇒ the public one (`rewriter`); `Set-Cookie` loses `Domain=localhost`; if the visitor accepts gzip, text bodies go out
// gzip-compressed (the Free plan has 1 GB a month), with a flush per chunk (every text response can be a stream — chat,
// NDJSON, Suspense HTML). NEVER compressed: an event stream (text/event-stream) and every response with
// `Cache-Control: no-transform` — with gzip the last event of a stream went missing between ngrok edge and browser, and
// `no-transform` forbids every intermediary to re-encode (RFC 9110 §7.7). An event stream gets its headers at once.
// A partial response (206/Content-Range) passes raw: its body must match Content-Range. WebSocket upgrades (HMR) pass
// raw, only their headers are rewritten. The public address comes from the `Host` of the ngrok request — the proxy does
// not need to know it beforehand (a dev address is only known AFTER opening).
//
// Idle connections — two races:
//   - ngrok → proxy: Node closed an idle connection after 5 s (+1 s buffer) — in the SAME millisecond ngrok sent the next
//     request on it and got a reset. ngrok silently retries a GET but not a POST ⇒ ERR_NGROK_3004 for the visitor. So the
//     proxy closes idle connections only after `QUIET_VISITOR_MS` — ngrok does not hold them that long, ngrok closes
//     first. Only the side that reuses can avoid the race.
//   - proxy → service: the keep-alive agent reused an idle connection that Next closed at the same moment after ITS
//     5 s + 1 s ⇒ ECONNRESET ⇒ 502 "not responding". Node shortens the idle time after the service's
//     `Keep-Alive: timeout=` hint (to hint − 1 s) only if the agent itself has a timeout. It has one
//     (`QUIET_SERVICE_MS`): an idle socket to the service closes after at most 2 s, long before Next (5 s) or another
//     common service closes it. The timeout applies only to IDLE sockets — a running response with long pauses (SSE, a
//     thinking agent) is not aborted by it. NOT `Connection: close`: if the service answers early to a large upload (401
//     from middleware, 413 above the limit), it then closes with an unread body — an RST that cut off the response at
//     the visitor; with keep-alive it silently reads off the rest.
//   - An unread request body: if the response to the visitor ends before the visitor's body has fully arrived (early
//     response, dead service, unusable response), the proxy reads off the rest and discards it — otherwise the
//     connection's parser would stand at the old body, and the NEXT request from ngrok on it would hang until the idle
//     timeout (10 min). Node does the same itself when nobody reads.
//
// What is logged: an abort of the response BY THE SERVICE (crash, restart) — one line. Not: a visitor who leaves; a write
// error of the upload after the service has already answered; a response the proxy itself discards (unusable status
// line — that has its own line); `close()`.
//
// Only node:* — a leaf. Caller: preview/ngrok-session.js (`open` starts it before the listener, `close`/`sessionClosed`
// close it along).
//
// startRewriteProxy({ target, log, stoppedText, quietServiceMs })  → { url, port, target, close() } — `target` =
//     `http://<host>:<port>` of the service; `quietServiceMs` only for the test (default `QUIET_SERVICE_MS`);
//     `stoppedText()` asks BEFORE every request and every upgrade whether the instance is stopped: a text means yes — 502
//     with exactly that text, nothing goes to the service; null/empty means continue as usual. Without the question a
//     stopped service would only answer "not responding — is it running?", and the visitor would read an error where a
//     user stopped on purpose. If it throws, "running" applies (the service then answers itself as it can).
// rewriter(port, pub)                 → { replace(text), Stream() } — the replacement, also for the test
// proxyTarget(url)                    the target of the open proxy under `url`, else null (test, diagnosis)
// openProxies()                       how many are listening right now (the test holds them against the open listeners)
import http from "node:http";
import net from "node:net";
import { Transform, pipeline } from "node:stream";
import zlib from "node:zlib";

const open = new Map(); // url → target

// How long an idle connection from ngrok stays open (see header: ngrok should close first). Finite so a forgotten
// connection does not hang forever.
const QUIET_VISITOR_MS = 10 * 60 * 1000;
// How long an idle socket to the service stays open (see header: the proxy should close first). The service's
// `Keep-Alive` hint shortens it further.
const QUIET_SERVICE_MS = 2000;

export const proxyTarget = (url) => open.get(url) ?? null;
export const openProxies = () => open.size;

// The spellings of the service origin. Case-insensitive (host names and hex digits of the URL encoding).
const HOSTS = ["localhost", "127.0.0.1", "0.0.0.0", "[::1]"];
const SCHEMATA = ["http:", "https:", "ws:", "wss:", ""];
const SEPARATOR = ["//", "\\/\\/"]; // raw and JSON/JS-escaped
const ENCODED_HOST = (h) => h.replace(/\[/g, "%5b").replace(/\]/g, "%5d").replace(/:/g, "%3a");
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/**
 * The replacement for the port `port` and the public address `{ host, schema }` (`schema` "https" or "http").
 * `replace(text)` replaces everything in a finished text (headers). `Stream()` is a transform for bodies: at the end of
 * every chunk it holds back only what COULD be the start of a pattern (the carry, at most the longest pattern — the port
 * boundary "no digit after it" needs one character of lookahead) — a pattern split over two chunks is hit, and an event
 * stream whose chunk does not end in the middle of a pattern passes on at once. Read as latin1: every byte is a
 * character, bytes outside the patterns go out unchanged, whatever the ASCII-compatible encoding.
 */
export function rewriter(port, { host, schema = "https" }) {
  const p = String(port);
  const safe = schema === "http" ? "http" : "https";
  const wsSafe = safe === "https" ? "wss" : "ws";
  // Literals (lower case) for the carry.
  const literals = [];
  for (const h of HOSTS) {
    for (const s of SCHEMATA) for (const t of SEPARATOR) literals.push(`${s}${t}${h}:${p}`);
    for (const s of ["http", "https", "ws", "wss"]) literals.push(`${s}%3a%2f%2f${ENCODED_HOST(h)}%3a${p}`);
  }
  const longest = Math.max(...literals.map((l) => l.length));
  const hostAlternation = HOSTS.map(esc).join("|");
  const hostEncodedAlternation = HOSTS.map((h) => esc(ENCODED_HOST(h))).join("|");
  const pattern = new RegExp(
    `(?:(https?:|wss?:)?(\\/\\/|\\\\\\/\\\\\\/)(?:${hostAlternation}):${p}|(https?|wss?)(%3a%2f%2f)(?:${hostEncodedAlternation})%3a${p})(?![0-9])`,
    "gi",
  );
  const fallback = (m) => {
    if (m[3] !== undefined) {
      const s = m[3].toLowerCase().startsWith("ws") ? wsSafe : safe;
      return `${s}${m[4]}${host}`;
    }
    const s = m[1] === undefined ? "" : `${m[1].toLowerCase().startsWith("ws") ? wsSafe : safe}:`;
    return `${s}${m[2]}${host}`;
  };
  // Replaces in `text` up to the cut — matches are searched on the WHOLE text (the lookahead "no digit" sees the
  // character after it). `finished`: nothing more is coming (otherwise a match right at the end stays in the carry — the
  // digit may still come).
  function parts(text, finished) {
    let cut = text.length;
    if (!finished) {
      const small = text.slice(-longest).toLowerCase();
      for (let k = Math.min(longest, small.length); k > 0; k -= 1) {
        const rest = small.slice(small.length - k);
        if (literals.some((l) => l.startsWith(rest))) { cut = text.length - k; break; }
      }
    }
    let out = "";
    let pos = 0;
    for (const m of text.matchAll(pattern)) {
      const end = m.index + m[0].length;
      if (!finished && end === text.length) { cut = Math.min(cut, m.index); break; }
      if (m.index >= cut) break;
      if (end > cut) cut = end;
      out += text.slice(pos, m.index) + fallback(m);
      pos = end;
    }
    return { output: out + text.slice(pos, cut), rest: text.slice(cut) };
  }
  return {
    replace: (text) => parts(String(text), true).output,
    Stream: () => {
      let rest = "";
      return new Transform({
        transform(chunk, _enc, cb) {
          const t = parts(rest + chunk.toString("latin1"), false);
          rest = t.rest;
          cb(null, t.output ? Buffer.from(t.output, "latin1") : undefined);
        },
        flush(cb) {
          const t = parts(rest, true);
          rest = "";
          cb(null, t.output ? Buffer.from(t.output, "latin1") : undefined);
        },
      });
    },
  };
}

const TEXT_TYPE = /^(text\/|application\/(javascript|ecmascript|json|xml|x-www-form-urlencoded|x-javascript|manifest\+json)|[^;]*\+(json|xml)|image\/svg\+xml)/i;
// React Flight (RSC navigation) writes long strings with a byte-length prefix (`id:T<hex>,…`) — a replacement inside
// would shift the whole stream. It stays unchanged, including the address in it.
const NEVER_REWRITE = /^text\/x-component\b/i;
export const isText = (type) => { const t = String(type || "").trim(); return TEXT_TYPE.test(t) && !NEVER_REWRITE.test(t); };

// Headers that concern only one connection — never pass on (node sets its own).
const HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "te", "trailer", "upgrade", "proxy-authorization", "proxy-authenticate"]);
const ADDRESS_HEADERS = new Set(["location", "content-location", "refresh", "link", "access-control-allow-origin", "content-security-policy", "content-security-policy-report-only"]);
const COOKIE_DOMAIN = /;\s*domain\s*=\s*\.?(?:localhost|127\.0\.0\.1|0\.0\.0\.0)\s*(?=;|$)/gi;

/** Does the visitor accept gzip (and not with q=0)? */
function takesGzip(acceptEncoding) {
  for (const part of String(acceptEncoding || "").split(",")) {
    const [name, ...param] = part.trim().split(";");
    if (name.trim().toLowerCase() !== "gzip") continue;
    const q = param.map((x) => x.trim()).find((x) => x.startsWith("q="));
    return !q || Number(q.slice(2)) > 0;
  }
  return false;
}

/** The public address of an ngrok request: host from `Host`, schema from `X-Forwarded-Proto` (default https). */
function publicOf(req) {
  const host = String(req.headers.host || "").trim();
  if (!host) return null;
  const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
  return { host, schema: proto === "http" ? "http" : "https" };
}

/** The headers to the service — from the RAW ones (order and repetitions stay), rewritten. */
function headersToService(req, port, pub, { upgrade = false } = {}) {
  const service = `http://localhost:${port}`;
  const pubOrigin = new RegExp(`^(?:https?|wss?)://${esc(pub.host)}(?=/|$)`, "i");
  const raw = req.rawHeaders;
  const out = [];
  let xff = "";
  for (let i = 0; i < raw.length; i += 2) {
    const name = raw[i];
    const k = name.toLowerCase();
    let value = raw[i + 1];
    if (k === "host" || k === "x-forwarded-host" || k === "x-forwarded-proto" || k === "x-forwarded-port" || k === "forwarded"
      || k === "x-cbase-public-host" || k === "x-cbase-public-proto" || k === "accept-encoding") continue;
    if (k === "x-forwarded-for") { xff = xff ? `${xff}, ${value}` : value; continue; }
    if (HOP.has(k) && !(upgrade && (k === "connection" || k === "upgrade"))) continue;
    if (k === "origin" || k === "referer") value = value.replace(pubOrigin, service);
    out.push([name, value]);
  }
  const from = req.socket.remoteAddress || "";
  out.unshift(["Host", `localhost:${port}`]);
  out.push(["X-Forwarded-For", from ? (xff ? `${xff}, ${from}` : from) : xff], ["X-cbase-Public-Host", pub.host], ["X-cbase-Public-Proto", pub.schema]);
  if (!upgrade) out.push(["Accept-Encoding", "identity"]);
  return out.filter(([, w]) => w !== "");
}

/** The headers of the response, rewritten (addresses, Set-Cookie). `text`: the body is rewritten. */
function headersToVisitor(upRes, u, { text, gzip }) {
  const out = {};
  for (const [k, w] of Object.entries(upRes.headers)) {
    if (HOP.has(k)) continue;
    if (text && (k === "content-length" || k === "content-encoding" || k === "accept-ranges")) continue;
    if (k === "set-cookie") out[k] = [].concat(w).map((c) => c.replace(COOKIE_DOMAIN, ""));
    else if (ADDRESS_HEADERS.has(k)) out[k] = Array.isArray(w) ? w.map(u.replace) : u.replace(w);
    else out[k] = w;
  }
  if (gzip) {
    out["content-encoding"] = "gzip";
    out.vary = out.vary ? `${out.vary}, Accept-Encoding` : "Accept-Encoding";
  }
  return out;
}

const UNPACKER = { gzip: () => zlib.createGunzip(), "x-gzip": () => zlib.createGunzip(), deflate: () => zlib.createInflate(), br: () => zlib.createBrotliDecompress() };

/** A proxy to `target` (`http://<host>:<port>`), listening on 127.0.0.1 on a free port. */
export async function startRewriteProxy({ target, log = () => {}, stoppedText = null, quietServiceMs = QUIET_SERVICE_MS }) {
  const z = new URL(target);
  const targetHost = z.hostname.replace(/^\[|\]$/g, "");
  const port = Number(z.port || 80);
  // Keep-alive to the service with its own idle timeout (see header, second race). Shared so `close()` also ends
  // running requests to the service.
  const agent = new http.Agent({ keepAlive: true, timeout: quietServiceMs });
  // `close()` is running: whatever aborts now was aborted by the proxy itself — not an error of the service.
  let closing = false;
  const rawSocket = new Set();
  const notReachable = `The service on port ${port} is not responding — is it running?`;
  // A dead service is logged ONCE until it answers again (otherwise one line per visitor request).
  let reported = false;
  const reportTot = (what, e) => { if (!reported) { reported = true; log(what, e?.code || e?.message || e); } };
  // If the instance is stopped, the text for it — else null (see header).
  const stands = () => {
    if (typeof stoppedText !== "function") return null;
    try { const t = stoppedText(); return t ? String(t) : null; } catch { return null; }
  };

  const server = http.createServer({ requireHostHeader: false, requestTimeout: 0 }, (req, res) => {
    const pub = publicOf(req);
    if (!pub) {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      res.end("The request names no host — the preview link cannot determine the public address.");
      req.resume();
      return;
    }
    const stopped = stands();
    if (stopped) {
      res.writeHead(502, "Bad Gateway", { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      res.end(stopped);
      req.resume();
      return;
    }
    const u = rewriter(port, pub);
    const headers = headersToService(req, port, pub);
    const upReq = http.request({ host: targetHost, port, method: req.method, path: req.url, headers: arrayToHeaders(headers), agent, setHost: false });
    let answered = false;
    // Who aborted a started response first: "visitor" (they left — no error) or "service" (crash, restart — one log
    // line; the visitor sees an abort, via ngrok ERR_NGROK_3004). Not readable from the `pipeline` callback: on an error
    // it first destroys EVERY link, including `res`.
    let abort = "";
    const serviceBrach = (e) => {
      if (abort || closing) return;
      abort = "service";
      log(`service ${target}: response aborted midway (${req.method} ${req.url.split("?")[0]})`, e?.code || e?.message || e || "aborted");
    };
    upReq.on("response", (upRes) => {
      answered = true;
      reported = false;
      // Registered BEFORE the chain: if the service aborts, this listener hears it first.
      upRes.on("aborted", () => serviceBrach());
      upRes.on("error", serviceBrach);
      const type = upRes.headers["content-type"];
      const encoding = String(upRes.headers["content-encoding"] || "identity").trim().toLowerCase();
      const withoutBody = req.method === "HEAD" || upRes.statusCode === 204 || upRes.statusCode === 304;
      // A partial response stays byte-identical: a rewritten or compressed body would no longer match Content-Range.
      const part = upRes.statusCode === 206 || upRes.headers["content-range"] !== undefined;
      const text = isText(type) && !withoutBody && !part && (encoding === "identity" || Object.hasOwn(UNPACKER, encoding));
      const sse = /^text\/event-stream/i.test(String(type || ""));
      // No gzip for event streams and `no-transform` (see header: via ngrok the last event went missing).
      const noTransformation = /(?:^|,)\s*no-transform\s*(?:,|$)/i.test([].concat(upRes.headers["cache-control"] ?? []).join(","));
      const gzip = text && !sse && !noTransformation && takesGzip(req.headers["accept-encoding"]);
      // A service with a broken status line (control characters in the reason, invalid code) would make writeHead THROW —
      // uncaught, and the visitor would wait until ngrok's timeout. Instead 502.
      try {
        res.writeHead(upRes.statusCode, upRes.statusMessage, headersToVisitor(upRes, u, { text, gzip }));
      } catch (e) {
        abort = "unusable"; // the destroy below is not an abort by the service — the line here says what happened
        upRes.destroy();
        log(`service ${target}: unusable response`, e?.code || e?.message || e);
        if (!res.headersSent) {
          // The reason explicitly: the failed call has already stored the broken one in `res.statusMessage`.
          res.writeHead(502, "Bad Gateway", { "content-type": "text/plain; charset=utf-8" });
          res.end(`The service on port ${port} sent an unusable response.`);
        } else res.destroy();
        return;
      }
      const afterChain = (e) => { if (e && !res.destroyed) res.destroy(); };
      if (withoutBody) { upRes.resume(); res.end(); return; }
      if (!text) { pipeline(upRes, res, afterChain); return; }
      const chain = [upRes];
      if (encoding !== "identity") chain.push(UNPACKER[encoding]());
      chain.push(u.Stream());
      // Flush per chunk for EVERY text response, not only SSE: a streamed text (chat answer as text/plain, NDJSON,
      // Suspense HTML) would otherwise stay in the deflate buffer until the service ends — and browsers always send gzip.
      if (gzip) chain.push(zlib.createGzip({ flush: zlib.constants.Z_SYNC_FLUSH }));
      if (sse) res.flushHeaders();
      pipeline(...chain, res, afterChain);
    });
    upReq.on("error", (e) => {
      // After the response has started this is a write error of the upload (the service answered early and no longer
      // reads) — NOT an abort of the response: it runs to its end, or it aborts itself, then the listener on `upRes`
      // reports it. Just stop passing on the body (`finish` takes over the reading off).
      if (answered) { req.unpipe(upReq); return; }
      if (res.destroyed) return;
      reportTot(`service ${target} not reachable`, e);
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      res.end(notReachable);
    });
    // The response is fully out but the visitor's body has not fully arrived yet (see header): read off and discard, end
    // the request to the service — otherwise the next request on this connection would hang.
    res.on("finish", () => {
      if (req.complete) return;
      req.unpipe(upReq);
      req.resume();
      upReq.destroy();
    });
    // If the visitor aborts (socket closed before the response is done), the request to the service aborts with it.
    res.on("close", () => {
      if (res.writableFinished) return;
      if (!abort) abort = "visitor";
      upReq.destroy();
    });
    req.on("error", () => upReq.destroy());
    req.pipe(upReq);
  });

  server.on("upgrade", (req, plinth, header) => {
    rawSocket.add(plinth);
    plinth.on("close", () => rawSocket.delete(plinth));
    plinth.on("error", () => {});
    const pub = publicOf(req);
    if (!pub) { plinth.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); return; }
    const stopped = stands();
    if (stopped) {
      const body = Buffer.from(stopped, "utf8");
      plinth.end(`HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${stopped}`);
      return;
    }
    const headers = headersToService(req, port, pub, { upgrade: true });
    const service = net.connect({ host: targetHost, port });
    rawSocket.add(service);
    service.on("close", () => { rawSocket.delete(service); plinth.destroy(); });
    plinth.on("close", () => service.destroy());
    let connected = false;
    service.on("error", (e) => {
      if (connected) return;
      reportTot(`service ${target} not reachable (WebSocket)`, e);
      const body = Buffer.from(notReachable, "utf8");
      plinth.end(`HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${notReachable}`);
    });
    service.on("connect", () => {
      connected = true;
      service.write(`${req.method} ${req.url} HTTP/1.1\r\n${headers.map(([k, w]) => `${k}: ${w}`).join("\r\n")}\r\n\r\n`);
      if (header?.length) service.write(header);
      plinth.pipe(service);
      service.pipe(plinth);
    });
  });
  server.on("clientError", (_e, plinth) => { if (plinth.writable) plinth.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"); else plinth.destroy(); });
  // See header, first race: ngrok should close an idle connection first.
  server.keepAliveTimeout = QUIET_VISITOR_MS;

  await new Promise((ok, no) => { server.once("error", no); server.listen(0, "127.0.0.1", () => { server.off("error", no); ok(); }); });
  // A listening proxy does not keep the process alive (the cbase server does): a forgotten one would otherwise be a hang
  // on exit — in the test a run that never ends instead of a red line.
  server.unref();
  const ownPort = server.address().port;
  const url = `http://127.0.0.1:${ownPort}`;
  open.set(url, target);
  let closed = null;
  return {
    url, port: ownPort, target,
    close() {
      if (closed) return closed;
      open.delete(url);
      closing = true;
      closed = new Promise((r) => {
        server.close(() => r());
        server.closeAllConnections();
        for (const s of rawSocket) s.destroy();
        agent.destroy();
      });
      return closed;
    },
  };
}

/** Header pairs as an object for http.request — repetitions become arrays (node writes them one by one). */
function arrayToHeaders(pairs) {
  const o = {};
  for (const [k, w] of pairs) {
    if (o[k] === undefined) o[k] = w;
    else o[k] = [].concat(o[k], w);
  }
  return o;
}
