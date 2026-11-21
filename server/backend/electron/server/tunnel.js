// Port tunnel: WebSocket ⇄ TCP passthrough to local services (port forwarding in the client).
// The client binds 127.0.0.1:<port> on the user's device and tunnels every connection as a WebSocket through the gateway to
// here; we connect inside the container (or locally) to 127.0.0.1:<port> and pass raw bytes through in both directions. That way
// EVERY browser on the client PC reaches the services of the isolated environment — including WebSockets/HMR of the apps
// themselves, because TCP is piped instead of rewriting HTTP.
// Auth happens at the gateway (one-time ticket); the backend itself is otherwise unauthenticated (local: 127.0.0.1 only;
// container: via the gateway). "Only via the gateway" is NOT true any more: every project container reaches the backend via
// the gateway of ITS project network — and the tunnel would connect it to every loopback and docker-proxy port of B, past the
// INPUT filter. Therefore the upgrade asks the fence (`fence` option, projectbox/fence.js fenceUpgrade): from a project network
// /api/tunnel is rejected (401 without, 403 with a token). Without an operation marker the verdict is "as before".
// `fence` is the GATE of the server (server.js upgradeGate): first the origin (runtime/origin.js), then the fence. In the
// local server the tunnel would otherwise give EVERY web page raw TCP to the Mac (a WebSocket knows no same-origin policy; via
// port 7718 also the backend itself, i.e. a terminal) — a foreign origin or host name is now 403, before the handshake. A
// non-browser (without Origin) goes as before.
//
// THE TARGET. A converted project listens in its project container, not on B's loopback. The query parameter `instance`
// selects the target — three-valued, because a missing field is no statement:
//   `instance=<projectId>/<instance>`  the instance: `net.connect` to its IP (`setNoDelay` stays). Unknown — or without an
//                                      operation marker — is 404, an instance without an address 409; both BEFORE the handshake.
//   `instance=` (empty)                explicitly B: 127.0.0.1, without any probe. (The client does NOT send it: without an
//                                      instance it omits the parameter and gets the rule below — otherwise every forward
//                                      remembered before the relocation would run into nothing, client/forwarding-rules.js.)
//   no `instance`                      an OLD client: 127.0.0.1 as before — unless B does not hold the port and EXACTLY ONE
//                                      instance holds it, then it applies. Without instances (without operation, before the
//                                      first relocation) nothing is probed. Only a LIVE instance is probed (ports.js
//                                      instanceAlive): the address of a container that is not running does not answer, and
//                                      every probe there would run into the deadline and retries.
// The instances come via `attachTunnel(server, { targets: { forIdentifier(identifier), all() } })` from server.js
// (projectbox/network-targets.js) — this leaf does not import the store. The gateway passes the query through.
import net from "node:net";
import { createRequire } from "node:module";
import { checkPort, instanceAlive } from "./ports.js";
import { ONLY_IN_OPS, projectboxOps } from "./projectbox/ops.js";
import { upgradeWay } from "./runtime/upgrade-way.js";

const require = createRequire(import.meta.url);
let wsLib = null, wsError = null;
// A rejected upgrade (fence): status with reason, then close — never a half handshake.
function deny(socket, { status, reason }) {
  const text = { 400: "Bad Request", 401: "Unauthorized", 404: "Not Found", 409: "Conflict", 500: "Internal Server Error" }[status] || "Forbidden";
  const body = JSON.stringify({ error: reason || text });
  try { socket.write(`HTTP/1.1 ${status} ${text}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`); } catch {}
  try { socket.destroy(); } catch {}
}
function loadWs() {
  if (wsLib || wsError) return wsLib;
  try { wsLib = require("ws"); } catch (e) { wsError = String(e && e.message ? e.message : e); }
  return wsLib;
}

/**
 * The target of a tunnel connection: `{ host, identifier }` (identifier null = B) or `{ status, reason }` (reject).
 * `identifier` is the query parameter (`null` = not given), `targets` the source from server.js (without it there is no
 * instance), `check` the probe (checkPort — replaceable in tests), `alive` the question whether an instance is worth a
 * network path (instanceAlive — replaceable in tests).
 */
export async function tunnelTarget({ port, identifier = null, targets = null, check = checkPort, alive = instanceAlive }) {
  const B = { host: "127.0.0.1", identifier: null };
  if (identifier === "") return B;
  if (identifier !== null) {
    let target;
    try { target = targets?.forIdentifier ? targets.forIdentifier(identifier) : null; } catch (e) {
      return { status: 500, reason: `Instance ${identifier} not readable: ${e?.message || e}` };
    }
    if (!target) return { status: 404, reason: projectboxOps() ? `unknown instance: ${identifier}` : ONLY_IN_OPS };
    if (!target.ip) return { status: 409, reason: `Instance ${identifier} has no address` };
    return { host: target.ip, identifier: target.identifier };
  }
  // An old client without `instance`.
  let all = [];
  try { all = (targets?.all ? targets.all() : []).filter((z) => z?.ip); } catch (e) {
    console.error(`[tunnel] instances not readable (${e?.message || e}) — port ${port} goes to B as before`);
    return B;
  }
  if (!all.length) return B;
  if (await check(port)) return B;
  // Probe only live instances — an unreadable one is not "does not hold it" but not asked at all.
  const hold = await Promise.all(all.map(async (z) => {
    try { return (await alive(z)) && (await check(port, undefined, { host: z.ip })) ? z : null; } catch { return null; }
  }));
  const holders = hold.filter(Boolean);
  return holders.length === 1 ? { host: holders[0].ip, identifier: holders[0].identifier } : B;
}

export function attachTunnel(server, { fence = null, targets = null } = {}) {
  server.on("upgrade", (req, socket, head) => {
    if (socket.destroyed) return; // another upgrade path has already rejected it
    let url;
    try { url = new URL(req.url, "http://x"); } catch { socket.destroy(); return; }
    // The DevTools belong to browsers.js. Every other path except exactly /api/tunnel is unknown (runtime/upgrade-way.js):
    // first the fence (401/403 from a project network), then end — otherwise this listener would return silently and
    // `/api/tunnelx` would hang open.
    const way = upgradeWay(req.url);
    // DevTools and the browser wire belong to browsers.js — otherwise this listener (it is attached first) would destroy the
    // wire, and the client would silently fall back to SSE ("WebSocket connection … /stream failed").
    if (way === "devtools" || way === "stream") return;
    const verdict = fence ? fence(req) : null;
    if (verdict && !verdict.ok) { deny(socket, verdict); return; }
    if (way !== "tunnel") { try { socket.destroy(); } catch {} return; }
    const port = Number(url.searchParams.get("port"));
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n"); socket.destroy(); return;
    }
    if (!loadWs()) { socket.write("HTTP/1.1 501 Not Implemented\r\n\r\n"); socket.destroy(); return; }
    // Until the handshake the upgrade socket belongs to nobody: the HTTP server has removed its error listener, ws attaches its
    // own only in handleUpgrade. A reset during the probe would otherwise be an uncaught error.
    const beforeHandshake = () => { try { socket.destroy(); } catch {} };
    socket.on("error", beforeHandshake);
    tunnelTarget({ port, identifier: url.searchParams.get("instance"), targets }).then((target) => {
      socket.off("error", beforeHandshake);
      if (target.status) deny(socket, target);
      else routeThrough(req, socket, head, { host: target.host, port });
    }, (e) => {
      socket.off("error", beforeHandshake);
      deny(socket, { status: 500, reason: String(e?.message || e) });
    });
  });
}

function routeThrough(req, socket, head, { host, port }) {
  const wss = new wsLib.WebSocketServer({ noServer: true, perMessageDeflate: false });
  wss.handleUpgrade(req, socket, head, (ws) => {
    const tcp = net.connect({ host, port });
    tcp.setNoDelay(true);
    // createWebSocketStream: duplex wrapper with real backpressure in both directions.
    const duplex = wsLib.createWebSocketStream(ws, { binary: true });
    const teardown = () => { try { duplex.destroy(); } catch {} try { tcp.destroy(); } catch {} };
    tcp.on("connect", () => { duplex.pipe(tcp); tcp.pipe(duplex); });
    // Target port closed (service not running): close cleanly with a reason so the client can report it.
    tcp.on("error", () => { try { ws.close(1011, `Port ${port} not reachable`); } catch {} teardown(); });
    tcp.on("close", () => { try { ws.close(1000); } catch {} });
    duplex.on("error", teardown);
    ws.on("close", teardown);
  });
}
