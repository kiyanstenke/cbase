// The server's upgrade paths — ONE classification for the two listeners on the `upgrade` event (tunnel.js attachTunnel,
// browsers.js attachBrowserDevtools). A leaf with no imports.
//
//   "tunnel"    only for the NORMALISED pathname "/api/tunnel" (exact) — tunnel.js reads port and instance from the query;
//   "devtools"  only for the pattern on the RAW path — that is how the proxy reads the browser id (browsers.js), and the fence
//               requires in its scope that raw and normalised are the same path (projectbox/fence.js fenceUpgrade);
//   null        unknown: the listener that sees it first sends it through the fence (401/403 from a project network) and ends
//               the socket; the second one sees `socket.destroyed` and does nothing.
// Every other path must get an answer: `/api/tunnelx` and `/api/tunnel/../a` would otherwise leave the socket hanging open,
// with no response and no fence.
export const DEVTOOLS_UPGRADE = /^\/api\/browsers\/([0-9a-f-]+)\/devtools(\/[^?]*)/;
// "stream": the WebSocket wire of the streamed browser (browser-wire.js) — exactly this path, a query is allowed.
export const STREAM_UPGRADE = /^\/api\/browsers\/([0-9a-f-]+)\/stream(?:\?|$)/;

export function upgradeWay(rawUrl) {
  let path;
  try { path = new URL(String(rawUrl || "/"), "http://x").pathname; } catch { return null; }
  if (path === "/api/tunnel") return "tunnel";
  if (STREAM_UPGRADE.test(String(rawUrl || ""))) return "stream";
  return DEVTOOLS_UPGRADE.test(String(rawUrl || "")) ? "devtools" : null;
}
