// The WebSocket wire of the streamed browser and the live measurement. Pure, no DOM: BrowserPane calls in here, web/test/browser-wire.test.mjs
// checks it (against the server side server/backend/electron/server/browser-wire.js: the same bytes there and back).
//
// Server → client binary: [u16 BE header length][header UTF-8 JSON {tab, seq, w, h, (tc, tr, tb)}][JPEG]; text: {"event", "data"}.
// Client → server text: {"tab", "events": [...]}, the same events as POST /input.

/** The wire's address: the same origin as the API (empty API_BASE = the page itself), http → ws, https → wss. */
export function streamUrl(apiBase: string, page: string, browserId: string, tab: string, measure: boolean): string {
  const u = new URL(`${apiBase || ""}/api/browsers/${encodeURIComponent(browserId)}/stream`, page);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  if (tab) u.searchParams.set("tab", tab);
  if (measure) u.searchParams.set("measure", "1");
  return u.toString();
}

export type FrameHeader = { tab: string; seq: number; w: number; h: number; tc?: number; tr?: number; tb?: number };

/** Read a binary frame, or null (too short, header unreadable). The JPEG bytes are a view onto the same buffer. */
export function readFrame(buf: ArrayBuffer): { header: FrameHeader; jpeg: Uint8Array } | null {
  if (buf.byteLength < 2) return null;
  const n = new DataView(buf).getUint16(0, false);
  if (2 + n > buf.byteLength) return null;
  let header: FrameHeader;
  try { header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 2, n))); } catch { return null; }
  if (!header || typeof header !== "object") return null;
  return { header, jpeg: new Uint8Array(buf, 2 + n) };
}

/** Read a text message: { event, data }, or null. */
export function readMessage(text: string): { event: string; data: Record<string, unknown> } | null {
  try {
    const o = JSON.parse(text);
    if (!o || typeof o.event !== "string") return null;
    return { event: o.event, data: o.data && typeof o.data === "object" ? o.data : {} };
  } catch { return null; }
}

// ── The live measurement ──────────────────────────────────────────────────────────────────────────────────────────────────────────
// Switched on through localStorage `cbase.measureBrowser` = "1" or `?measure=1` in the app's address; then every frame carries the
// server's measuring points (tc = Chromium produced, tr = B received, tb = B written; ONE clock), and BrowserPane sends a summary to
// POST /api/browsers/measurement every MEASURE_TICK_MS. The client's clock is a different one, so an image's age is RELATIVE: (receipt − tb)
// minus the minimum of that in the window, i.e. the wait above the best image (buffer, congestion, bundling).

export const MEASURE_TICK_MS = 10_000;
export const MESS_TOGGLE = "cbase.measureBrowser";

/** Is the measurement on? (The address query and the saved switch, both from outside.) */
export function measuringOn(addressSearch: string, saved: string | null): boolean {
  try { if (new URLSearchParams(addressSearch).get("measure") === "1") return true; } catch { /* ignore */ }
  return saved === "1";
}

export type MessFrame = { ta: number; n: number; tc?: number; tr?: number; tb?: number; px: number; w: number };
export type MessClick = { from: number; image: number };

const median = (a: number[]) => { const x = [...a].sort((p, q) => p - q); return x.length ? x[Math.floor(x.length / 2)] : null; };
const p90 = (a: number[]) => { const x = [...a].sort((p, q) => p - q); return x.length ? x[Math.floor(x.length * 0.9)] : null; };

/** The summary of a window: images/s, kB per image, relative age, the hops inside B, gaps between arrivals (and how many images
 *  arrived bundled, within 3 ms of the previous one: a buffer on the way), click → next image, sharp/smooth. */
export function messSummary(frames: MessFrame[], clicks: MessClick[], durationMs: number, meta: Record<string, string | number> = {}) {
  const raw = frames.filter((f) => typeof f.tb === "number" && f.tb > 0).map((f) => f.ta - (f.tb as number));
  const base = raw.length ? Math.min(...raw) : 0;
  const gaps: number[] = [];
  for (let i = 1; i < frames.length; i++) gaps.push(frames[i].ta - frames[i - 1].ta);
  const kb = frames.map((f) => f.n / 1024);
  return {
    ...meta,
    duration_ms: durationMs,
    images: frames.length,
    fps: durationMs > 0 ? (frames.length * 1000) / durationMs : 0,
    kb_med: median(kb), kb_p90: p90(kb),
    age_rel_med: median(raw.map((x) => x - base)), age_rel_p90: p90(raw.map((x) => x - base)),
    b_intern_med: median(frames.filter((f) => f.tb && f.tr).map((f) => (f.tb as number) - (f.tr as number))),
    chrome_b_med: median(frames.filter((f) => f.tr && f.tc).map((f) => (f.tr as number) - (f.tc as number))),
    gap_med: median(gaps), gap_p90: p90(gaps),
    bundle: gaps.filter((l) => l < 3).length,
    clicks: clicks.length,
    click_med: median(clicks.map((k) => k.image - k.from)), click_p90: p90(clicks.map((k) => k.image - k.from)),
    images_sharp: frames.filter((f) => f.w > 0 && f.px > f.w * 1.25).length,
    images_smooth: frames.filter((f) => f.w > 0 && f.px <= f.w * 1.25).length,
  };
}
