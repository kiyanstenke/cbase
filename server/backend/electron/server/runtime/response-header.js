// Response headers of an instance — a leaf with no imports.
//
// Whatever B passes on to the user's browser lives under the cbase origin. The DevTools UI of a project browser comes from B
// (projectbox/devtools-ui.js); only the WebSocket comes out of the project container — and its response (101 or an error) is the
// one header block the container still writes. A browser accepts cookies from a WebSocket handshake response too. So every
// response that comes from an instance, or is served for an instance session, loses the headers with which a response SETS or
// triggers something on the user's side:
//   set-cookie, set-cookie2      overwrite the session (fixation) or plant a cookie under the cbase origin
//   clear-site-data              sign the user out, clear cbase's storage and cache
//   refresh                      a redirect the page itself does not contain
//   link                         preloading foreign addresses, `rel=serviceworker`
//   service-worker-allowed       widen a service worker's scope beyond its folder
// The same list lives in the gateway (server/gateway/proxy.js DEVTOOLS_RESPONSE_FORBIDDEN); server/gateway/proxy.test.js keeps
// the two equal.

export const FORBIDDEN_RESPONSE_HEADERS = Object.freeze(["set-cookie", "set-cookie2", "clear-site-data", "refresh", "link", "service-worker-allowed"]);
const FORBIDDEN = new Set(FORBIDDEN_RESPONSE_HEADERS);

/** A header object (`res.headers` of http) without the forbidden lines — case-insensitive, the original is left untouched. */
export function withoutForbiddenHeaders(header) {
  const h = {};
  for (const [k, v] of Object.entries(header || {})) if (!FORBIDDEN.has(String(k).toLowerCase())) h[k] = v;
  return h;
}

/** A raw response header (status line and header lines, without the blank line) without the forbidden lines. A continuation
 *  line (obs-fold, starts with whitespace) belongs to the line before it and is dropped with it. */
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

// A header that has not ended after 64 KiB is not a header — the socket is dropped (no response rather than a truncated one).
export const UPGRADE_HEADER_CAP = 64 * 1024;

/** The response of an upgrade from `up` to `socket`: first collect the header up to the blank line and write it without the
 *  forbidden lines, then pass everything through raw (the WebSocket frames). Replaces `up.pipe(socket)`. */
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
    } catch { /* client gone — cleanup comes via close/error */ }
    up.pipe(socket);
  };
  up.on("data", read);
}
