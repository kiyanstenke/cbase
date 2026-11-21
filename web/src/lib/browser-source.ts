// The source of the streamed browser: FIRST the WebSocket wire (frames binary, input on the same socket, lib/browser-wire.ts), else the
// SSE stream. Outwardly it looks like an EventSource (addEventListener with `{ data }`, close, onerror), so the handlers in BrowserPane
// stay the same; a frame from the wire additionally carries `bytes` (the JPEG bytes, no base64). `send(obj)` sends a message over the
// wire and says whether it worked (otherwise the caller takes the POST way).
//
// The fallback: if the wire fails BEFORE it was open (a backend without the route, a gateway that does not pass the path, a proxy
// without WebSocket), this source takes the SSE stream, and every further source of this page too (`wireBroken`). If an open wire
// drops (backend restart, network), it retries once; if that fails, SSE. “gone” closes (close), with no retry afterwards.
import { readFrame, readMessage } from "./browser-wire.js";

type Listener = (ev: { data: string; bytes?: Uint8Array }) => void;
type WsLike = { readyState: number; binaryType: string; send(d: string): void; close(): void; onopen: unknown; onmessage: unknown; onclose: unknown; onerror: unknown };
type EsLike = { addEventListener(n: string, f: (ev: MessageEvent) => void): void; close(): void; onerror: unknown };

let wireBroken = false;
/** For the guard only: reset the page's flag. */
export const _wireBrokenReset = () => { wireBroken = false; };

export type StreamSource = {
  addEventListener(name: string, fn: Listener): void;
  close(): void;
  onerror: (() => void) | null;
  send(obj: unknown): boolean;
  readonly transport: "ws" | "sse" | "";
};

export function streamSource(o: {
  wsUrl: string;
  sseUrl: string;
  WS?: new (url: string) => WsLike;
  ES?: new (url: string) => EsLike;
  newAttemptMs?: number;
}): StreamSource {
  const WS = o.WS ?? (typeof WebSocket !== "undefined" ? (WebSocket as unknown as new (url: string) => WsLike) : undefined);
  const ES = o.ES ?? (EventSource as unknown as new (url: string) => EsLike);
  const listeners = new Map<string, Set<Listener>>();
  let es: EsLike | null = null;
  let ws: WsLike | null = null;
  let closed = false;
  let transport: "ws" | "sse" | "" = "";
  let newAttempted = false;
  const q: StreamSource = {
    addEventListener(name, fn) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(fn);
      if (es) es.addEventListener(name, fn as (ev: MessageEvent) => void);
    },
    close() { closed = true; try { ws?.close(); } catch { /* closed */ } try { es?.close(); } catch { /* closed */ } },
    onerror: null,
    send(obj) {
      if (!ws || ws.readyState !== 1 || transport !== "ws") return false;
      try { ws.send(JSON.stringify(obj)); return true; } catch { return false; }
    },
    get transport() { return transport; },
  };
  const report = (name: string, ev: { data: string; bytes?: Uint8Array }) => { for (const fn of listeners.get(name) ?? []) fn(ev); };
  const sse = () => {
    if (closed || es) return;
    ws = null;
    transport = "sse";
    es = new ES(o.sseUrl);
    for (const [name, fns] of listeners) for (const fn of fns) es.addEventListener(name, fn as (ev: MessageEvent) => void);
    es.onerror = () => q.onerror?.();
  };
  const wire = () => {
    if (closed) return;
    let open = false;
    const w = new WS!(o.wsUrl);
    ws = w;
    w.binaryType = "arraybuffer";
    w.onopen = () => { open = true; transport = "ws"; };
    w.onmessage = (m: { data: unknown }) => {
      if (typeof m.data === "string") {
        const n = readMessage(m.data);
        if (n) report(n.event, { data: JSON.stringify(n.data) });
      } else if (m.data instanceof ArrayBuffer) {
        const f = readFrame(m.data);
        if (f) report("frame", { data: JSON.stringify(f.header), bytes: f.jpeg });
      }
    };
    w.onerror = () => { /* onclose follows */ };
    w.onclose = () => {
      if (closed || ws !== w) return;
      if (!open) { wireBroken = true; sse(); return; }
      transport = "";
      if (!newAttempted) { newAttempted = true; setTimeout(wire, o.newAttemptMs ?? 1000); return; }
      sse();
    };
  };
  if (!WS || !o.wsUrl || wireBroken) sse();
  else wire();
  return q;
}
