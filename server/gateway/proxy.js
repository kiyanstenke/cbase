// Streaming reverse proxy to the per-user container. Pure pass-through (request body and response are piped), so SSE streams,
// uploads and large responses work without buffering. Terminals/chats of the app run over SSE+POST (no WebSocket).
import http from "node:http";

// Active connections per user (for the idle reaper: open SSE streams = active).
const active = new Map();
export const activeStreams = (userId) => active.get(userId) || 0;

// The open connections per user that can be CLOSED — upgrade sockets (port tunnel, DevTools WebSocket) and running proxy
// responses (SSE, long downloads). Locking, deleting and a new password end the sessions (users.js); what a session had already
// opened would otherwise keep running until the client closed it — a locked user would keep their tunnel into the container and
// their event stream. `closeStreams` destroys them; the cleanups at the sockets (index.js teardown, proxyRequest
// `res.on("close")`) tear down the path to the backend with them.
const open = new Map(); // userId -> Set<{ destroy() }>
function remember(userId, ding) {
  if (!ding) return () => {};
  let s = open.get(userId);
  if (!s) open.set(userId, (s = new Set()));
  s.add(ding);
  return () => {
    const t = open.get(userId);
    if (!t) return;
    t.delete(ding);
    if (!t.size) open.delete(userId);
  };
}
/** How many closable connections this user currently has open (for the guard). */
export const openConnections = (userId) => open.get(userId)?.size || 0;
/** Destroy every open connection of this user. Returns how many there were. */
export function closeStreams(userId) {
  const s = open.get(userId);
  if (!s) return 0;
  open.delete(userId);
  for (const ding of s) { try { ding.destroy(); } catch { /* already closed */ } }
  return s.size;
}

// Take external connections (e.g. port tunnel) into the count — returns done(). `plinth`: the client socket that closeStreams
// may destroy.
export function trackStream(userId, plinth = null) {
  active.set(userId, (active.get(userId) || 0) + 1);
  const forget = remember(userId, plinth);
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    forget();
    const n = (active.get(userId) || 1) - 1;
    if (n <= 0) active.delete(userId); else active.set(userId, n);
  };
}

// /api/browsers/<id>/devtools/… — by the normalised pathname (like the upgrade path in index.js), plus the raw start, so a
// spelling with `..` cannot carry the header past the check.
const DEVTOOLS_PATH = /^\/api\/browsers\/[^/]+\/devtools(\/|$)/;
export function isDevtoolsPath(rawUrl) {
  let path = "";
  try { path = new URL(String(rawUrl || "/"), "http://gateway").pathname; } catch { return true; }
  return DEVTOOLS_PATH.test(path) || DEVTOOLS_PATH.test(String(rawUrl || "").split("?")[0]);
}

// The response to …/devtools/*: the backend serves a project browser's DevTools UI itself and passes only the WebSocket through
// from the project container — and strips the headers with which a response SETS something on the user's side (overwrite or
// delete the session, redirect, widen a service worker). The gateway does the same on the same path, in depth: on HTTP
// (proxyRequest) and in the upgrade (index.js, passThroughUpgradeResponse). The SAME list is in the backend
// (server/backend/electron/server/runtime/response-header.js FORBIDDEN_RESPONSE_HEADERS); proxy.test.js keeps both equal. All
// other paths are untouched.
export const DEVTOOLS_RESPONSE_FORBIDDEN = Object.freeze(["set-cookie", "set-cookie2", "clear-site-data", "refresh", "link", "service-worker-allowed"]);
const FORBIDDEN = new Set(DEVTOOLS_RESPONSE_FORBIDDEN);
export function withoutForbiddenHeaders(header) {
  const h = {};
  for (const [k, v] of Object.entries(header || {})) if (!FORBIDDEN.has(String(k).toLowerCase())) h[k] = v;
  return h;
}
// A raw response head (status line + headers, no blank line) without the forbidden lines; a continuation line (obs-fold) drops
// with its line.
export function rawHeaderWithoutForbidden(text) {
  const rows = String(text).split("\r\n");
  const out = [rows[0]];
  let dropping = false;
  for (const z of rows.slice(1)) {
    if (/^[ \t]/.test(z)) { if (!dropping) out.push(z); continue; }
    const i = z.indexOf(":");
    dropping = FORBIDDEN.has((i < 0 ? z : z.slice(0, i)).trim().toLowerCase());
    if (!dropping) out.push(z);
  }
  return out.join("\r\n");
}
// An upgrade's response: collect the head up to the blank line (at most 64 KiB, otherwise the socket is dropped), write it
// without the forbidden lines, then pass the rest through raw. Replaces `up.pipe(socket)`.
export const UPGRADE_HEADER_CAP = 64 * 1024;
export function passThroughUpgradeResponse(up, socket, { cap = UPGRADE_HEADER_CAP } = {}) {
  let buffer = Buffer.alloc(0);
  const read = (d) => {
    buffer = Buffer.concat([buffer, d]);
    const end = buffer.indexOf("\r\n\r\n");
    if (end < 0) {
      if (buffer.length > cap) {
        up.off("data", read);
        try { up.destroy(); } catch {}
        try { socket.destroy(); } catch {}
      }
      return;
    }
    up.off("data", read);
    up.pause();
    try {
      socket.write(Buffer.from(`${rawHeaderWithoutForbidden(buffer.subarray(0, end).toString("latin1"))}\r\n\r\n`, "latin1"));
      const rest = buffer.subarray(end + 4);
      if (rest.length) socket.write(rest);
    } catch { /* client gone — teardown comes via close/error */ }
    up.pipe(socket);
  };
  up.on("data", read);
}

// ── A short question to the container, with cap and deadline ──────────────────────────────────────────────────────────────────
// The gateway reads an ANSWER from the user container itself in several places (busy, next schedule occurrence, notices to catch
// up). Collecting the body without a limit (`b += c`) with only http.get's `timeout` — an IDLE deadline of the socket — would let
// a backend that sends one byte every two seconds hold it open forever, and one that writes endlessly fill the memory of the ONE
// process that carries login, proxy, tunnel and push for ALL users. And the backend runs as `agent` — an agent in B can replace
// the listener on 7718.
// Hence ONE form: total deadline from the start (not idle), cap in bytes, and the result as a value instead of a throw —
// `{ status, body }` or `{ error }` ("deadline", "too-big" or the socket's message). What an error MEANS is decided by the
// caller (busy: busy, schedule: unknown) — an error is never "empty" here.
export function fetchFromBackend(port, path, { deadlineMs = 5000, capBytes = 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    let finished = false;
    let clock = null;
    const end = (value) => {
      if (finished) return;
      finished = true;
      clearTimeout(clock);
      resolve(value);
    };
    const req = http.get({ host: "127.0.0.1", port, path: path, agent: false }, (res) => {
      const parts = [];
      let size = 0;
      res.on("data", (c) => {
        if (finished) return;
        size += c.length;
        if (size > capBytes) {
          end({ error: "too-big" });
          req.destroy();
          return;
        }
        parts.push(c);
      });
      res.on("end", () => end({ status: res.statusCode || 0, body: Buffer.concat(parts) }));
      res.on("error", (e) => end({ error: e?.message || String(e) }));
    });
    clock = setTimeout(() => { end({ error: "deadline" }); req.destroy(); }, deadlineMs);
    req.on("error", (e) => end({ error: e?.message || String(e) }));
  });
}

// The same with JSON parsing: `{ json }` or `{ error }` (also "no-json" and "status <n>").
export async function fetchJsonFromBackend(port, path, options) {
  const r = await fetchFromBackend(port, path, options);
  if (r.error) return { error: r.error };
  if (r.status !== 200) return { error: `status ${r.status}`, status: r.status };
  try { return { json: JSON.parse(r.body.toString("utf8")) }; } catch { return { error: "no-json" }; }
}

export function proxyRequest(req, res, { port, userId, onActivity }) {
  // The response is closable while it runs — `res.destroy()` destroys the client socket, `res.on("close")` below the path to the
  // backend.
  const done = trackStream(userId, res);
  let finished = false;
  const finish = () => { if (!finished) { finished = true; done(); onActivity?.(); } };

  const headers = { ...req.headers, host: `127.0.0.1:${port}` };
  // The DevTools of a streamed browser: the backend passes them on to Chromium — and if the browser runs in a project container,
  // it reads the header. The session cookie belongs to the gateway (already authenticated, sessionOf in index.js); as on the
  // upgrade path, it does not go into the container over HTTP either. All other /api/* are untouched.
  const devtools = isDevtoolsPath(req.url);
  if (devtools) delete headers.cookie;
  const fwd = req.socket.remoteAddress || "";
  headers["x-forwarded-for"] = headers["x-forwarded-for"] ? `${headers["x-forwarded-for"]}, ${fwd}` : fwd;

  const up = http.request(
    { host: "127.0.0.1", port, path: req.url, method: req.method, headers },
    (ur) => {
      res.writeHead(ur.statusCode || 502, devtools ? withoutForbiddenHeaders(ur.headers) : ur.headers);
      ur.pipe(res);
      ur.on("data", () => onActivity?.());
      ur.on("end", finish);
      ur.on("close", finish);
    }
  );
  // No timeouts: SSE connections live arbitrarily long.
  up.setTimeout(0);
  req.socket.setTimeout?.(0);
  req.socket.setKeepAlive?.(true, 30_000);

  up.on("error", () => {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "backend unreachable" }));
    } else {
      try { res.end(); } catch {}
    }
    finish();
  });
  // If the client aborts, take upstream down with it (otherwise the SSE stream leaks in the container).
  res.on("close", () => { try { up.destroy(); } catch {} finish(); });

  req.pipe(up);
  onActivity?.();
}
