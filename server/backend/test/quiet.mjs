// Quiet and stream barrier — the harness core against tests that wobble under load. Not a test itself (hence .mjs):
// agent-harness.mjs, server-harness.mjs and golden-harness.mjs use it, and any test may import it directly.
//
// TWO questions a test must ask before it asserts something:
//
//   waitForQuiet(base, { barrier })
//       Is the server still doing something ON ITS OWN? It asks /api/runs/active for `quiet` — the ONE computation of "open
//       work" in the server (runs/routes.js openWork: runs, background agents, dynamic workflows, verdicts, queue, wait
//       phase, compaction, goal gate, hooks not awaited, oneshots, project-container instances in work). `busy` stays the
//       deploy's gate and covers only the first two plus the project instances. WITHOUT a deadline: if it hangs, the suite
//       deadline is the emergency brake (no clock at which a test turns red). A server that does not answer has no open
//       work (same reading as the harnesses' idle check) — a server WITHOUT the field `quiet` throws (empty is not
//       unknown). With `barrier: [{ reader, target, write }]` it then passes every stream barrier. Returns the last body
//       of the route.
//
//   streamBarrier(reader, target, { write })
//       Does MY reader have everything the server has written into this stream up to NOW? A look into server memory
//       (liveAgents(), /api/runs/active, the history) is synchronous, the SSE reader is not: an event written earlier
//       arrives at the reader only AFTER the look, and whoever then sets `from = events.length` counts it as a later one.
//       The barrier writes a marker into the SAME stream and waits until the reader has exactly this marker — SSE is
//       ordered per connection, so the reader has everything before it. Returns the position BEHIND the marker in
//       `reader.events`, the safe cut. `target` is a chat id or GLOBAL (the /api/events stream). `reader` is an array of
//       the read events, an object with `events`, or a reader with `markers` (Map marker → position) that does not put
//       markers into `events` (web/test/streams/server.mjs — the golden recording must contain no marker). WITHOUT a deadline.
//
//   tidyUp(base, { error, who, end })
//       Cleaning up a harness AFTER a failure: stop everything active that would keep going on its own (turns, background
//       agents, dynamic workflows; `end` in addition, e.g. kill the fakes hard), then wait for quiet — without a deadline
//       and without ever throwing (the body's error stays THE error). Under load a run that was not finished would write
//       into the database of the NEXT test ("attempt to write a readonly database"). The error is printed BEFORE the wait:
//       if cleanup hangs, the log still shows what the test failed on — plus, every 30 s, what it waits for.
//
//   waitRow(what)
//       A line "[waiting] for N s: <what>" every 30 s on stderr while waiting; the return value stops it. Waiting has no
//       deadline — when it hangs, the suite deadline strikes, and the log should say WHAT the test waited for. No verdict,
//       no limit; `unref`, the line keeps no process alive.
//
// THE MARKER is `{ type: "harness", subtype: "barrier", marker }` — a subtype no consumer knows: the web reducer
// (web/src/components/chat/chatBubbles.ts), the side effects in ChatPane (chatBackground.ts, chatDynTree.ts) branch only on
// known subtypes, the iOS app (Chat/ChatViewModel+Stream.swift) ends in `default`, the global stream is distributed by
// `type` (lib/api/events.ts). Guard for the web reducer: web/test/reducer.test.mjs (the marker of the stream barrier is a
// no-op in EVERY state of every recorded stream). Only tests write it: nothing in the product opens a path to it.
//
// THE WRITER: `barrierInProcess` (default) when the server runs in the test process — runtime/sse.js is the same module
// instance as the server's; loaded dynamically because golden-harness.mjs is imported by the gate test without a server.
// If the server runs as its own process (agent-harness.mjs opts.childProcess), it writes itself: agent-harness.mjs then passes a
// writer over the IPC channel of agent-server-child.mjs (ctx.barrier) — a path of the test entry only.
//
// A chat stream without a reader throws on write: the marker would never arrive, and misuse (reader not yet connected —
// wait for `connected` first) would become a hang without a line. For the global stream the writer cannot see that
// (runtime/sse.js does not export the set) — wait for `init` there first.

export const GLOBAL = "@global";
export const isBarrier = (e) => Boolean(e) && e.type === "harness" && e.subtype === "barrier";

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

export function waitRow(what) {
  const since = Date.now();
  const t = setInterval(() => console.error(`[waiting] for ${Math.round((Date.now() - since) / 1000)} s: ${typeof what === "function" ? what() : what}`), 30_000);
  t.unref?.();
  return () => clearInterval(t);
}

let sseModule = null;
export async function barrierInProcess(target, marker) {
  sseModule ??= await import("../electron/server/runtime/sse.js");
  const evt = { type: "harness", subtype: "barrier", marker };
  if (target === GLOBAL) { sseModule.broadcast(evt); return; }
  if (!(sseModule.streams.get(target)?.size > 0)) throw new Error(`stream barrier: no reader on stream ${target} (wait for "connected" first)`);
  sseModule.sse(target, evt);
}

let counter = 0;
function placeTheMarker(reader, marker) {
  if (reader && reader.markers instanceof Map) return reader.markers.has(marker) ? reader.markers.get(marker) : -1;
  const events = Array.isArray(reader) ? reader : reader?.events;
  if (!Array.isArray(events)) throw new Error("stream barrier: the reader has neither `events` nor `markers`");
  for (let i = events.length - 1; i >= 0; i--) {
    if (isBarrier(events[i]) && events[i].marker === marker) return i + 1;
  }
  return -1;
}

export async function streamBarrier(reader, target, { write = barrierInProcess } = {}) {
  if (!target) throw new Error("stream barrier: no target (chat id or GLOBAL)");
  const marker = `barrier-${process.pid}-${++counter}-${Math.random().toString(36).slice(2, 10)}`;
  await write(target, marker);
  const to = waitRow(`stream barrier ${target}`);
  try {
    for (;;) {
      const place = placeTheMarker(reader, marker);
      if (place >= 0) return place;
      await pause(10);
    }
  } finally { to(); }
}

// `Connection: close`: after a restart in the same process the fetch pool still holds the socket to the OLD server
// (agent-harness.mjs json).
async function active(base) {
  let res;
  try { res = await fetch(`${base}/api/runs/active`, { headers: { Connection: "close" } }); }
  catch { return null; }
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

export async function waitForQuiet(base, { barrier = [] } = {}) {
  let s;
  const to = waitRow(() => `quiet — open ${JSON.stringify(s?.open ?? null)}`);
  try {
    for (;;) {
      s = await active(base);
      if (!s) break;
      if (typeof s.quiet !== "boolean") throw new Error(`waitForQuiet: /api/runs/active without field "quiet" — ${JSON.stringify(s).slice(0, 300)}`);
      if (s.quiet) break;
      await pause(25);
    }
  } finally { to(); }
  for (const { reader, target, write } of barrier) await streamBarrier(reader, target, write ? { write } : {});
  return s;
}

// Stop everything the server would keep driving on its own — through the same routes as the UI buttons. Agents and
// workflows with `from: "agent"`: a human stop would leave a silent notice for the next turn.
async function stopOpen(base, s) {
  const post = (url, body = {}) => fetch(`${base}${url}`, {
    method: "POST", headers: { "Content-Type": "application/json", Connection: "close" }, body: JSON.stringify(body),
  }).then((r) => r.text()).catch(() => null);
  const chats = new Set();
  try {
    const r = await fetch(`${base}/api/active-runs`, { headers: { Connection: "close" } });
    for (const it of (await r.json())?.items || []) if (it.chatId) chats.add(it.chatId);
  } catch { /* the server may already be closed */ }
  for (const id of chats) await post(`/api/chats/${id}/stop`);
  for (const id of new Set((s.agents || []).map((a) => a.chatId).filter(Boolean))) await post(`/api/chats/${id}/agents/stop`, { from: "agent" });
  for (const w of s.dynWorkflows || []) if (w.chatId && w.runId) await post(`/api/chats/${w.chatId}/dyn-workflows/stop`, { taskId: w.runId });
}

export async function tidyUp(base, { error = null, who = "harness", end = null } = {}) {
  if (error) console.error(`[${who}] failure — clean up first, then the verdict. The error: ${error?.stack || error}`);
  let s = null;
  const to = waitRow(() => `quiet after the failure (${who}) — open ${JSON.stringify(s?.open ?? null)}`);
  try {
    // One stop per 40 looks (≈ 1 s), no time limit: a queue or a graph step may start the next turn after the stop — the
    // next pass stops that one too.
    for (let look = 0; ; look++) {
      s = await active(base);
      // A missing `quiet` field does NOT throw here (unlike waitForQuiet): cleanup must not hide the error.
      if (!s || s.quiet !== false) return s;
      if (look % 40 === 0) {
        await stopOpen(base, s);
        try { await end?.(); } catch { /* never throws */ } // the harness waits in it until its children are gone
      }
      await pause(25);
    }
  } finally { to(); }
}
