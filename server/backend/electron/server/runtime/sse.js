// Event streams (SSE): streams per chat and global, heartbeat and broadcast. The route function eventStreamRoute (/api/events)
// lives here because it needs globalStreams; it is listed in ROUTES (server.js).
// The RUN STATE (is a chat running, does it have an open question, which ones are running) comes in through the setter
// setRunState, set in startServer — runtime/ imports nothing from runs/ (import-direction.test.js).

import { listBrowsers } from "../browsers.js";
import { NEXT } from "./http.js";
import { HEARTBEAT, HEARTBEAT_MS } from "./heartbeat.js";

// ── Run state ────────────────────────────────────────────────────────────────
// A setter instead of an import, modelled on setStartGate (providers/index.js). Unset, the query THROWS in plain words instead
// of answering "nothing is running": an empty answer could not be told from a true one (empty is not unknown) — in the server
// startServer sets it before the first request.
// The fourth question `workflows`: the open dynamic workflows as `[{ chatId, runId }]` for the initial state — they run outside
// the turn (`running` does not know them), and the chat list would otherwise show their working icon only after the next
// `dyn_workflow` event.
let runState = null;
function setRunState({ isRunning, question, running, workflows }) {
  for (const [name, fn] of Object.entries({ isRunning, question, running, workflows })) {
    if (typeof fn !== "function") throw new Error(`setRunState: ${name} must be a function`);
  }
  runState = { isRunning, question, running, workflows };
}
function run() {
  if (!runState) throw new Error("runtime/sse.js: run state not set (setRunState in startServer)");
  return runState;
}


// ── SSE ──────────────────────────────────────────────────────────────────────
const streams = new Map();
function sse(chatId, obj) {
  const subs = streams.get(chatId);
  if (subs) { const line = `data: ${JSON.stringify(obj)}\n\n`; for (const r of subs) { try { r.write(line); } catch {} } }
}
// Heartbeat against intermediaries that cut silent connections. The `try` is mandatory: writing to an already destroyed
// response throws, and the throw would leave ALL remaining streams of this round without a heartbeat.
// Line and interval are defined ONCE in `./heartbeat.js` (why a named event: see there).
setInterval(() => {
  for (const subs of streams.values()) for (const r of subs) { try { r.write(HEARTBEAT); } catch {} }
}, HEARTBEAT_MS).unref();

// Global event stream (across workspaces): reports the run status of ALL chats to the sidebar, so the hexagon per chat spins
// live (run active) or glows (finished, unread answer). Unread is decided on the client (it knows the open chat).
const globalStreams = new Set();
function broadcast(obj) {
  const line = `data: ${JSON.stringify(obj)}\n\n`;
  for (const r of globalStreams) { try { r.write(line); } catch {} }
}
setInterval(() => { for (const r of globalStreams) { try { r.write(HEARTBEAT); } catch {} } }, HEARTBEAT_MS).unref();
export async function eventStreamRoute(ctx) {
  const { req, res, url, p, m } = ctx;

      // ── Global event stream (sidebar hexagon: running/unread chats) ──
      if (p === "/api/events" && m === "GET") {
        // Read the run state BEFORE the headers: unset, run() throws — then a clean 500 from the dispatcher instead of a throw
        // behind an already written 200.
        const running = run().running();
        const workflows = run().workflows();
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        // Initial state: currently running chats, open dynamic workflows and active browsers, so the UI is in sync at once.
        res.write(`data: ${JSON.stringify({ type: "init", running: running, dynWorkflows: workflows, browsers: listBrowsers() })}\n\n`);
        globalStreams.add(res);
        req.on("close", () => globalStreams.delete(res));
        return;
      }
  return NEXT;
}

export { broadcast, setRunState, sse, streams };
