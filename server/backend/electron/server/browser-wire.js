// The WebSocket wire of the streamed browser. It used to send the frames as base64 in JSON over SSE (a third more bytes per image)
// and every input as its own POST. Over `GET /api/browsers/<id>/stream` (upgrade) now go:
//   Server → client  binary: [u16 BE length of the header][header as UTF-8 JSON {tab, seq, w, h, (tc, tr, tb)}][JPEG bytes]
//                    text:   {"event": "<name>", "data": {...}} — the same events as in the SSE stream (hello, tabs, tabclosed,
//                            dialog, gone, ping)
//   Client → server  text:   {"tab": "<targetId>", "events": [...]} — the same events as POST /input (mouse, key, text, ack)
// SSE + POST stay unchanged for older clients (iOS until the next install, a desktop client with an old web build).
// Pure except for viewerFromWs (the ws object comes from outside) — browsers.js and devtools/routes.js call in here,
// server/backend/test/browser-wire.test.js and web/test/browser-wire.test.mjs (the other side in web/src/lib/browser-wire.ts) check.

/** Build the binary frame: header (JSON) and JPEG bytes. */
export function frameBinary(header, jpeg) {
  const k = Buffer.from(JSON.stringify(header), "utf8");
  if (k.length > 0xffff) throw new Error("Frame header too large");
  const b = Buffer.allocUnsafe(2 + k.length + jpeg.length);
  b.writeUInt16BE(k.length, 0);
  k.copy(b, 2);
  jpeg.copy(b, 2 + k.length);
  return b;
}

/** An SSE block ("event: x\ndata: {…}\n\n") as a text message of the wire — or null (no event in it). */
export function sseAsMessage(block) {
  const ev = /^event: (\S+)$/m.exec(String(block || ""));
  if (!ev) return null;
  const raw = /^data: (.*)$/m.exec(String(block));
  let data = {};
  try { data = raw ? JSON.parse(raw[1]) : {}; } catch { data = {}; }
  return JSON.stringify({ event: ev[1], data });
}

/** Read a text message of the client: { tab, events } — or null (unreadable, no list). At most MAX_EVENTS. */
export const MAX_EVENTS = 512;
export function readInput(text) {
  let o;
  try { o = JSON.parse(String(text)); } catch { return null; }
  if (!o || typeof o !== "object" || !Array.isArray(o.events)) return null;
  return { tab: typeof o.tab === "string" ? o.tab : "", events: o.events.slice(0, MAX_EVENTS) };
}

/** Extend the socket's queue by one event — folded like in the client (web/src/lib/browser-stream.ts foldInput):
 *  hovering replaces the previous one, a wheel adds to the previous wheel, everything else stays single. On the wire there is no
 *  "one POST in flight" any more that collected the events; measured under load: unfolded, the wheel events piled up behind
 *  the delivery, and the page kept scrolling 1.5 s after release. So B folds what arrives while a delivery is running. */
export function foldInputs(q, e) {
  const last = q[q.length - 1];
  if (e?.t === "mouse" && e.type === "mouseMoved" && last?.t === "mouse" && last.type === "mouseMoved" && (last.buttons | 0) === (e.buttons | 0)) { q[q.length - 1] = e; return q; }
  if (e?.t === "mouse" && e.type === "mouseWheel" && last?.t === "mouse" && last.type === "mouseWheel") {
    q[q.length - 1] = { ...last, deltaX: (last.deltaX || 0) + (e.deltaX || 0), deltaY: (last.deltaY || 0) + (e.deltaY || 0), x: e.x, y: e.y };
    return q;
  }
  q.push(e);
  return q;
}

/** Only receipts? They bypass the input clock (they may overtake each other, mouse and keyboard may not). */
export const onlyReceipts = (events) => events.length > 0 && events.every((e) => e && e.t === "ack");

/** A viewer object over a WebSocket (package ws), as attachViewer knows it from an SSE response: write(SSE block) becomes a
 *  text message, sendFrame(header, jpeg) a binary one, writableLength = bufferedAmount, destroyed = no longer open, end() closes,
 *  on("close") reports the end. `binary` tells sendFrame in browsers.js that this viewer takes bytes instead of base64. */
export function viewerFromWs(ws) {
  const OPEN = 1;
  return {
    binary: true,
    get writableLength() { return ws.bufferedAmount || 0; },
    get destroyed() { return ws.readyState !== OPEN; },
    write(block) {
      const n = sseAsMessage(block);
      if (n !== null && ws.readyState === OPEN) ws.send(n);
      return true;
    },
    sendFrame(header, jpeg) { if (ws.readyState === OPEN) ws.send(frameBinary(header, jpeg), { binary: true }); },
    end() { try { ws.close(1000); } catch { /* already closed */ } },
    on(ev, fn) { if (ev === "close") ws.on("close", fn); },
  };
}
