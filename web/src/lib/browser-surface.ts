// The surface of the streamed browser: how the page image sits in the page view and where a wheel goes. No DOM and no React, so
// `web/test/browser-surface.test.mjs` checks the computation without a browser; BrowserPane only calls in here.
//
// Why: in the right chat bar (280–640 px wide) an agent's viewport (1280 × 800 and wider) used to be fitted as a flat strip at the top,
// with the surface empty below it. The viewport belongs to the agent and stays untouched, so the image fills the HEIGHT and whatever is
// wider than the bar scrolls sideways.
//
// Two modes, by pane shape:
//   height (bar)          fill the height, width by aspect ratio; wider than the surface ⇒ scroll sideways (then a scrollbar sits at
//                         the bottom and the height is the one above it); narrower ⇒ centered
//   whole  (tab, window)  the whole image visible, fitted: large, user-sized surfaces, where the whole page at a glance counts more
//                         than the full height, and one never has to scroll
// The OWN browser gets its viewport emulated to the pane size (action `resize`), so its image fits exactly in both modes, until a second
// viewer (the extra window) pulls the viewport to ITS size. Then it stands undistorted like a foreign one (it used to be stretched to
// the surface: `h-full w-full`), and `viewportMatches` tells the pane it may fetch it back as soon as the pointer enters.

export type Fitting = { w: number; h: number; scrolls: boolean };
export type FitMode = "height" | "whole";

/** Up to this many pixels of deviation an image counts as fitting: the emulation rounds the pane size down. */
export const PASS_TOLERANCE = 2;

const floorEps = (x: number) => Math.floor(x + 1e-6);

/**
 * The CSS size of the page image in the surface. `frame` is the viewport size (CSS pixels, from the frame), `box` that of the page
 * view, `scrollbar` the measured height of a horizontal scrollbar (0 for overlay scrollbars). Null while one of the sizes is missing:
 * the pane then stays at its default.
 *
 * No oscillation: if the image scrolls only BECAUSE the scrollbar is missing (with it, it would be narrow enough), it is fitted to the
 * width instead of scrolling; otherwise the scrollbar would take the height, the image would get narrower, the scrollbar would
 * disappear, the image would get wider again …
 */
export function fitting(p: {
  frameW: number; frameH: number; boxW: number; boxH: number; mode: FitMode; scrollbar?: number;
}): Fitting | null {
  const { frameW: fw, frameH: fh, boxW: bw, boxH: bh } = p;
  if (!(fw > 0 && fh > 0 && bw > 0 && bh > 0)) return null;
  const pages = fw / fh;
  if (p.mode === "whole") {
    const s = Math.min(bw / fw, bh / fh);
    return { w: Math.min(bw, floorEps(fw * s)), h: Math.min(bh, floorEps(fh * s)), scrolls: false };
  }
  const full = bh * pages;
  if (full <= bw + PASS_TOLERANCE) return { w: Math.min(bw, Math.round(full)), h: bh, scrolls: false };
  const lane = Math.max(0, Math.round(p.scrollbar || 0));
  const h = bh - lane;
  if (h * pages <= bw + PASS_TOLERANCE) return { w: bw, h: Math.min(bh, floorEps(bw / pages)), scrolls: false };
  return { w: Math.round(h * pages), h, scrolls: true };
}

/** The smallest emulation the server sets (`browsers.js:applyMetrics`, `Math.max(320, …)`/`Math.max(240, …)`). */
export const VIEWPORT_MIN = { w: 320, h: 240 } as const;

/**
 * Does a frame's viewport fit the surface (within the tolerance)? For the own browser: otherwise the pane fetches it back. The
 * comparison uses the size the server REALLY sets for this surface: in a bar under 320 px it clamps to 320, and comparing with the raw
 * surface would mean “never fits”: every pointer entry would send a `resize` that changed nothing.
 */
export function viewportMatches(frame: { w: number; h: number }, box: { w: number; h: number }): boolean {
  const w = Math.max(VIEWPORT_MIN.w, box.w);
  const h = Math.max(VIEWPORT_MIN.h, box.h);
  return Math.abs(frame.w - w) <= PASS_TOLERANCE && Math.abs(frame.h - h) <= PASS_TOLERANCE;
}

/** Pixels per row when a wheel reports in rows (`deltaMode` 1, Firefox with a mouse wheel). */
export const ROW_PX = 16;

export type WheelTarget = { target: "surface"; dx: number } | { target: "page" };

/**
 * Where a wheel over the page view goes.
 *   page     to the page in the browser (as every wheel used to): vertical always, so the page scrolls as one expects of a browser;
 *            horizontal if the surface cannot scroll (further) in THAT direction
 *   surface  the surface scrolls sideways by `dx` pixels: a horizontal movement (trackpad swipe, deltaX dominates) or Shift+wheel
 *            (Chrome reports it as deltaY, macOS already as deltaX), as long as the surface can in that direction
 * The page does NOT additionally get a wheel the surface scrolls with, otherwise both would scroll. Either-or, on purpose: with a
 * diagonal swipe the vertical part is dropped, and whatever would go past the edge of the surface goes to nobody (the next wheel then
 * goes to the page).
 */
export function wheelTarget(r: {
  deltaX: number; deltaY: number; deltaMode?: number; shift: boolean; scrollLeft: number; scrollWidth: number; clientWidth: number;
}): WheelTarget {
  const ax = Math.abs(r.deltaX);
  const ay = Math.abs(r.deltaY);
  const horizontal = ax > ay || (r.shift && ay > 0);
  if (!horizontal) return { target: "page" };
  const raw = ax >= ay ? r.deltaX : r.deltaY;
  const factor = r.deltaMode === 1 ? ROW_PX : r.deltaMode === 2 ? r.clientWidth : 1;
  const dx = raw * factor;
  const right = r.scrollWidth - r.clientWidth - r.scrollLeft;
  if (dx > 0 && right > 0.5) return { target: "surface", dx };
  if (dx < 0 && r.scrollLeft > 0.5) return { target: "surface", dx };
  return { target: "page" };
}
