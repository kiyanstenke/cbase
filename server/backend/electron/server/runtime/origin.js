// The origin check. A leaf with ONE import (node:net).
//
// WHY. A backend without a container (local: tests, test benches) listens on 127.0.0.1 and knows no login — every web page in
// the user's browser can reach it:
//   - Cross-site: a WebSocket knows no same-origin policy (`/api/tunnel` would give any page raw TCP to the machine, and through
//     the backend port a terminal), and a POST with `text/plain` needs no preflight.
//   - DNS rebinding: `evil.example` first points to the attacker, then to 127.0.0.1 — the page then reads "same-origin"
//     responses. That is code execution on the developer's machine.
//
// THE RULE — `originVerdict(header)` → `{ ok: true }` or `{ ok: false, status: 403, reason }` (the fence's shape,
// projectbox/fence.js). server.js asks it at EVERY entrance: in the dispatcher before anything else (also before the static
// files) and at the gate of both upgrade paths (tunnel, DevTools) — there before the DevTools proxy strips the Origin.
//   1. Host (if present; in BOTH modes): an IP literal or exactly `localhost`. Rebinding needs a DNS NAME; nobody can bend a
//      literal. Locally never the unspecified address (0.0.0.0, ::; in server mode it is allowed, see below). Any IP literal
//      rather than only 127.0.0.1: whoever binds the local server to an interface with CBASE_HOST calls it by that address.
//      The port is NOT compared — the danger is a name, not a port (and a foreign app on the same machine is caught by rule 2).
//   2. Origin (if present): exactly `http://<Host>` (scheme, name and port, WHATWG-normalised). A browser sends it with EVERY
//      WebSocket handshake and every POST; "null" (sandbox, file, redirect) is foreign, and so is an Origin without a Host.
//   3. Sec-Fetch-Site (if present): only `same-origin` or `none` (address bar, bookmark, the shell's `loadURL`). `same-site` is
//      another port on the same name — another app (a dev server on localhost:3000) — and just as foreign. A link from a
//      foreign page to the UI is rejected too (cross-site); typed in, it works.
//   Without Origin and Sec-Fetch-Site it is not a browser — allowed: a local process reaches every local port anyway.
//
// Who calls a local backend: the UI itself (same origin, relative paths — web/src/lib/api/core.ts; the DevTools iframe builds
// its ws URL from window.location.host), the MCP server (mcp/lib.js, Node fetch to 127.0.0.1: Host 127.0.0.1:<port>,
// `sec-fetch-mode: cors`, NO Origin and NO Sec-Fetch-Site), `ws` (client tunnel: no Origin), the scripts under tools/ and the
// tests (Node, 127.0.0.1), the maintainer's browser test benches (Chrome, `Page.navigate` to 127.0.0.1 — none, then
// same-origin). The backend has no CORS — a UI under a foreign origin never worked.
//
// SERVER MODE (`CBASE_CONTAINER=1` — also without CBASE_DIND, so NOT the ops marker projectboxOps): ONLY rule 1.
// Rules 2 and 3 are dropped: the gateway rewrites Host to `127.0.0.1:<host port of the container>` and passes the Origin of
// the user's browser (the public address) through (server/gateway/proxy.js proxyRequest, index.js upgrade) — B does not know
// its public origin, rule 2 would hit every POST. There the gateway checks (session with `SameSite=Lax` — a cross-site POST
// does not carry it —, one-time ticket), and the fence protects against the project networks.
// Rule 1 STAYS: without it B would be open to DNS rebinding from the browsers that run inside B itself (agent and user browsers
// without an instance: browsers.js `debugHost = HOST_B`) — their requests come from B's loopback, which the fence lets pass,
// and after the rebinding a page would reach the full API up to terminal and execution. Who calls B in server mode — each with
// an IP literal or localhost as Host:
//   - the gateway (proxy.js, index.js upgrade, containers.js snapshot/health/idle, push.js): `127.0.0.1:<host port>`;
//   - the MCP server of a run in B: `CBASE_BASE_URL` = BASE_URL = `http://<CBASE_HOST>:<port>`, and the image sets
//     `CBASE_HOST=0.0.0.0` (server/backend/Dockerfile, server.js `setBaseUrl`, toolchain/mcp-config.js) — Host `0.0.0.0:7718`.
//     That is why in server mode the UNSPECIFIED address (0.0.0.0, [::]) counts as a literal too: it can be bent as little as
//     127.0.0.1; locally it stays foreign;
//   - the MCP server of a run in an instance: `http://<gateway of the project network>:7718` (projectbox/token.js);
//   - cbase-project and everything in the project container: `127.0.0.1:7718`/`localhost:7718` (OUTPUT DNAT,
//     projectbox-entry.sh);
//   - the deploy tool: `docker exec … curl http://127.0.0.1:7718` (the deploy tool's remote.mjs).
// The marker is read at run time (headless.js sets it after the hoisted imports; the tests switch it within one process).
import net from "node:net";

const OK = Object.freeze({ ok: true });
const foreign = (reason) => ({ ok: false, status: 403, reason });

export function localOps() {
  return process.env.CBASE_CONTAINER !== "1";
}

// The Host header as a normalised URL (name:port per WHATWG) — null if it is none. Host characters only: no `@`, no `/`
// (otherwise `new URL` would read the name 127.0.0.1 out of "evil@127.0.0.1").
function hostOf(raw) {
  const s = String(raw || "");
  if (!/^[A-Za-z0-9.\-:[\]]+$/.test(s)) return null;
  try { return new URL(`http://${s}`); } catch { return null; }
}

// `indeterminate`: the unspecified address (0.0.0.0, [::]) counts too — only in server mode (see the header: B's BASE_URL).
function nameMatches(hostname, { indeterminate = false } = {}) {
  if (hostname === "localhost") return true;
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    const v6 = hostname.slice(1, -1);
    return net.isIPv6(v6) && (indeterminate || v6 !== "::");
  }
  return net.isIPv4(hostname) && (indeterminate || hostname !== "0.0.0.0");
}

/**
 * May this request (or this upgrade) reach cbase? `header` are the request headers (`req.headers`).
 * `ops` (default: from `CBASE_CONTAINER`, at run time) is the test seam: "local" checks rules 1–3, "server" only rule 1
 * (see the header). Never throws.
 */
export function originVerdict(header, { ops = localOps() ? "local" : "server" } = {}) {
  const server = ops === "server";
  const h = header || {};
  let hu = null;
  if (h.host !== undefined) {
    hu = hostOf(h.host);
    if (!hu || !nameMatches(hu.hostname, { indeterminate: server })) return foreign(`Host "${String(h.host).slice(0, 100)}" is not this app (only an IP literal or localhost — DNS rebinding)`);
  }
  // Rules 2 and 3 only locally (see the header: the gateway passes the public Origin through).
  if (server) return OK;
  if (h.origin !== undefined) {
    let ou = null;
    try { ou = new URL(String(h.origin)); } catch { /* "null" and anything unreadable are foreign */ }
    if (!hu || !ou || ou.protocol !== "http:" || ou.host !== hu.host) {
      return foreign(`Request from a foreign origin rejected (Origin "${String(h.origin).slice(0, 100)}")`);
    }
  }
  const site = h["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin" && site !== "none") {
    return foreign(`Request from a foreign origin rejected (Sec-Fetch-Site "${String(site).slice(0, 40)}")`);
  }
  return OK;
}
