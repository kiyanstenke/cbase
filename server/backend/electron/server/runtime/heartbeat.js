// The heartbeat of the event streams, defined ONCE: used by `sse.js` (chat and global stream), `../browsers.js` (screencast
// viewers) and `../terminal.js` (terminal stream). Without it a silent connection is cut by the proxy after about 100 s.
//
// A NAMED event, not an SSE comment (`: ping`): a comment keeps proxies awake but is invisible to the EventSource API, so the
// client could not tell a silently hanging stream from a healthy one (web/src/lib/api.ts listens for `ping`). No `id:` line: it
// does not move the browser's last event id. iOS reads only `data:` lines and skips the empty object. A leaf with no imports.
export const HEARTBEAT = "event: ping\ndata: {}\n\n";
export const HEARTBEAT_MS = 25_000;
