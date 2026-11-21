// The frame of an image in the history BEFORE it is loaded. An <img> without dimensions stands at 2 px in the layout and grows by its
// whole height on loading (a capture measured 2 → 327/384 px): the history, which had just jumped to the end, then stood exactly that
// height above it. With width and height (capture: `capture.w/h`; attachment: `w/h` from the file header) the box reserves its place
// from the first paint.
//
// The calculation reproduces what the classes did before (`max-h-*` + `max-w-*` on an image without dimensions): fit while keeping the
// aspect ratio, never enlarge. `maxWidth` is the CSS upper limit over it (a length like "100%" or "220px"). Without valid dimensions
// `null` — the caller stays with the old way (empty is not unknown: no guessed aspect ratio). Leaf module without imports
// (web/test/chat-open.test.mjs).

export interface ImageFrame {
  aspectRatio: string;
  width: string;
}

/** Style for an <img>/<video> with known dimensions `w`×`h`, fitted into at most `maxH` px height and `maxWidth` width. */
export function imageFrame(w: unknown, h: unknown, maxH: number, maxWidth: string): ImageFrame | null {
  const bw = Number(w);
  const bh = Number(h);
  if (!Number.isFinite(bw) || !Number.isFinite(bh) || bw <= 0 || bh <= 0) return null;
  // At most as wide as keeps the height from exceeding `maxH` — and never wider than the image itself (no enlargement).
  const width = Math.min(bw, (maxH * bw) / bh);
  const px = `${Math.round(width * 100) / 100}px`;
  return { aspectRatio: `${bw} / ${bh}`, width: `min(${maxWidth}, ${px})` };
}
