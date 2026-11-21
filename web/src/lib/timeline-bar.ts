// The timeline bar of the per-project timeline — it should look like a real timeline: small icons per event, and on hover a larger
// description as a card — the PURE computations: the column metrics, where the line stands per row, the node's role and the position of
// the detail card. Drawn in components/timeline/TimelineRow.tsx and TimelineCard.tsx. A LEAF module without imports
// (web/test/timeline-web.test.mjs compiles it alone and runs it).

// ── The line ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Per row: time right-aligned · round node with the kind symbol ON the vertical line · title. The line runs per day from the first
// to the last node, in two pieces per row (above and below the node) — it touches the node but never lies under it, so the node
// needs no fill in the background color (the right sidebar and the tab have different ones).
/** The column metrics in px — the row (TimelineRow.tsx) and the line compute with the same ones. */
export const TIMELINE = Object.freeze({
  clockTime: 40, // width of the time column
  gap: 10, // between the columns
  node: 24, // diameter of a top-level event's node
  nodePart: 18, // diameter of a part's node
  top: 6, // inner padding of the row above the node
});

/** Where a top-level row's line stands: above the node (not in the day's first row), below it (not in the last). */
export function linesChunks(first: boolean, last: boolean): { top: boolean; bottom: boolean; x: number } {
  return { top: !first, bottom: !last, x: TIMELINE.clockTime + TIMELINE.gap + TIMELINE.node / 2 };
}

/** The node's role: dismissed (dashed, gray) before collective event (accent) before normal. */
export type NodeRole = "dismissed" | "collecting" | "normal";
export const nodeRole = (e: { dismissed: unknown; parts: readonly unknown[] }): NodeRole =>
  e.dismissed ? "dismissed" : e.parts.length > 0 ? "collecting" : "normal";

// ── The card on hover ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface Box { left: number; top: number; right: number; bottom: number }
export interface CardsSituation { left: number; top: number; width: number; maxHeight: number; page: "left" | "bottom" | "top" }
/**
 * The position of the detail card (TimelineCard.tsx): `sideways` (the narrow right chat sidebar) to the left of the list at the row's height if
 * there is room; otherwise — and in the wide tab always — below the row, flush with the title (`x`), if it does not fit there, above; never out of
 * the window (margin 8 px).
 */
export function timelineCardsSituation(row: Box, list: Box, card: { w: number; h: number }, window: { w: number; h: number },
  { lateral, x }: { lateral: boolean; x: number }, margin = 8, gap = 6): CardsSituation {
  const width = Math.max(0, Math.min(card.w, window.w - 2 * margin));
  const maxHeight = Math.max(0, window.h - 2 * margin);
  const h = Math.min(card.h, maxHeight);
  const holdX = (v: number) => Math.max(margin, Math.min(v, window.w - margin - width));
  const holdY = (v: number) => Math.max(margin, Math.min(v, window.h - margin - h));
  const beside = list.left - gap - width;
  if (lateral && beside >= margin) return { left: beside, top: holdY(row.top), width, maxHeight, page: "left" };
  const left = holdX(x);
  const bottom = row.bottom + gap;
  if (bottom + h <= window.h - margin) return { left, top: bottom, width, maxHeight, page: "bottom" };
  const top = row.top - gap - h;
  if (top >= margin) return { left, top: top, width, maxHeight, page: "top" };
  const moreBelow = window.h - row.bottom >= row.top;
  return { left, top: holdY(moreBelow ? bottom : top), width, maxHeight, page: moreBelow ? "bottom" : "top" };
}
