// The image stage of the streamed browser. Pure rules without Chromium and without a clock;
// browsers.js calls them, server/backend/test/browser-image-stage.test.js checks them.
//
// Measured (Linux container, 4 CPUs, headless --disable-gpu, bar 520 x 860 CSS pixels, link
// 1.5 MB/s + 2 x 50 ms): a frame in device pixels (x CAST_DSF 2, quality 80) weighs about
// 320-360 kB (base64), so the link carries 4.2 images per second while scrolling and the image
// is 969 ms old at the median. The same page in CSS pixels (x 1) at quality 60: 71 kB, 18-19
// images per second, 130-150 ms old. Resolution is the lever, quality the smaller one.
//
// Two stages per tab: SMOOTH while the human MOVES the page (wheel, dragging with a button down,
// scroll keys), SHARP otherwise. Switching restarts the screencast (Page.startScreencast accepts
// nothing while a cast runs); it takes 5 ms, and Chromium then delivers an image in the new stage
// at once, so the sharp final image after the movement arrives by itself.
//
// Rules:
//  - smooth ONLY on a movement input (movementInput), not on frames, not on click or key (text stays sharp);
//  - smooth until QUIET_MS after the LAST movement input; a frame extends nothing, a wheel burst is ONE switch there and
//    ONE back;
//  - a page that moves by itself (animation, spinner, video) stays sharp. Without this, carousels switched stage every
//    2 s and spinners or video stayed permanently soft.
// A recording (recorder) always stays sharp: it does not go over the link, and its image must not get soft.

/** Quality and scale of the two stages. Scale is the factor on the surface's CSS size.
 *  Smooth uses 0.75 instead of 1: measured on the WebSocket wire at 1.5 MB/s under load,
 *  scrolling fills the line in BOTH variants, x 1: 27.5 images/s at 51 kB, image 249 ms old;
 *  x 0.75: 43.2 images/s at 33 kB, 136 ms old. Softer in motion, sharp at rest. */
export const STAGES = Object.freeze({
  sharp: Object.freeze({ quality: 80 }),
  smooth: Object.freeze({ quality: 60, scale: 0.75 }),
});
/** How long after the last movement input the tab stays smooth; then sharp (and the final image arrives). Wheel events of a
 *  trackpad burst come on the 16 ms tick, folded over the link per round trip (about 100-150 ms); 400 ms bridges two lost
 *  beats without the image staying soft long after release. */
export const QUIET_MS = 400;
/** Maximum device pixels of a sharp image (about 2.4 MP: 1,809 x 1,080 at dpr 2 gives factor 1.11, about 110 kB instead of 300 kB). */
export const SHARP_PIXEL_MAX = 2_400_000;
/** Keys that scroll the page (without modifier): they move it like the wheel. Space and Home/End do not: in a text field they
 *  type or move the cursor, and text must stay sharp while typing. */
export const SCROLL_KEYS = Object.freeze(["PageUp", "PageDown", "ArrowUp", "ArrowDown"]);

/** The parameters for Page.startScreencast. viewSize: the surface in CSS pixels with the client's dpr (null for agent browsers,
 *  whose size we do not set); dsf: Chromium's device factor (CAST_DSF). Sharp = surface x min(dpr, dsf), so a client with dpr 1
 *  gets no pixels it throws away; smooth = surface x scale. Without viewSize the old fixed cap applies and only the quality
 *  drops. */
export function castParameter(stage, viewSize, dsf) {
  const st = STAGES[stage] || STAGES.sharp;
  let cap = { maxWidth: 2560, maxHeight: 1600 };
  if (viewSize && viewSize.width > 0 && viewSize.height > 0) {
    const dpr = Number(viewSize.dpr) > 0 ? Number(viewSize.dpr) : dsf;
    // Sharp at most SHARP_PIXEL_MAX device pixels: a wide surface (1,809 x 1,080 CSS at dpr 2 = 7.8 MP) weighed 300 kB per
    // image at 1.6-3.6 images/s, so the line was full with three images. The bar (520 x 860 x 2 = 1.8 MP) stays fully sharp;
    // only above it the factor drops, never below 1.
    const full = Math.max(1, Math.min(dsf, dpr));
    const f = stage === "smooth" ? st.scale : Math.max(1, Math.min(full, Math.sqrt(SHARP_PIXEL_MAX / (viewSize.width * viewSize.height))));
    cap = { maxWidth: Math.min(4096, Math.ceil(viewSize.width * f)), maxHeight: Math.min(2560, Math.ceil(viewSize.height * f)) };
  }
  return { format: "jpeg", quality: st.quality, ...cap, everyNthFrame: 1 };
}

/** A tab's state: stage, since when, when the last movement input came. */
export const stageStart = (now = 0) => ({ stage: "sharp", since: now, lastMovement: 0 });

/** Does this event move the page? Wheel; dragging (mouseMoved with a button down: selecting, sliders, scroll bars); a scroll
 *  key without modifier on press. Not click, hover, typing, text or acknowledgements. */
export function movementInput(e) {
  if (!e || typeof e !== "object") return false;
  if (e.t === "mouse") return e.type === "mouseWheel" || (e.type === "mouseMoved" && (e.buttons | 0) !== 0);
  if (e.t === "key") return e.type === "keyDown" && !(e.modifiers | 0) && SCROLL_KEYS.includes(e.key);
  return false;
}

/** A screencast frame arrived. It NEVER changes the stage (a page that moves by itself stays sharp), unless a recording
 *  runs and the tab was smooth: then sharp. */
export function stageAfterFrame(st, now, { recorder = false } = {}) {
  if (recorder && st.stage !== "sharp") return { ...st, stage: "sharp", since: now };
  return st;
}

/** Human input (at time now). A movement input sets smooth and pushes the quiet time back; otherwise everything stays. */
export function stageAfterInput(st, now, events, { recorder = false } = {}) {
  if (recorder) return st;
  if (!(Array.isArray(events) ? events : []).some(movementInput)) return st;
  if (st.stage === "smooth") return { ...st, lastMovement: now };
  return { ...st, stage: "smooth", since: now, lastMovement: now };
}

/** The quiet timer: when (time) the tab should go sharp, or null (it already is). QUIET_MS after the last movement. */
export function quietDueFrom(st) {
  if (st.stage !== "smooth") return null;
  return Math.max(st.lastMovement, st.since) + QUIET_MS;
}

/** The timer has expired (now): quiet means sharp. If a movement came meanwhile it stays (the caller re-arms). */
export function stageAfterQuiet(st, now) {
  const from = quietDueFrom(st);
  if (from === null || now < from) return st;
  return { ...st, stage: "sharp", since: now };
}

// ── The page tick ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// A page that moves by itself stays sharp, and so filled the link: measured at 1.5 MB/s with a spinner, sharp, unthrottled
// 5.8 images/s at 252 kB (line full), click -> image 457 ms, typing -> echo 857 ms. Chromium sends the next screencast frame
// only after the previous one is acknowledged; so in the sharp stage B acknowledges it with delay: at most one image per
// PAGE_TICK_MS (which also saves encoding on the build host). Any human input releases the waiting acknowledgement immediately
// AFTER its delivery, so the answer to a click or key does not wait for the tick, the images after it do. While smooth (the
// human scrolls) and during a recording B acknowledges at once.

/** Spacing of images in the sharp stage (a page that moves by itself).
 *  200 rather than 500: since the pixel cap a sharp image weighs about 180 kB instead of 252-300 kB. Measured with 500: gap
 *  570 ms at the median, 1.5-2.8 images/s, image only 1-30 ms old, so the tick was the bottleneck, not the link. 5 images/s
 *  x 180 kB is about 0.9 MB/s and leaves room on 1.5 MB/s for the echo of an input. */
export const PAGE_TICK_MS = 200;

/** By how many ms B delays this frame's acknowledgement: 0 = at once. */
export function receiptDelay({ stage = "sharp", recorder = false }) {
  if (recorder || stage === "smooth") return 0;
  return PAGE_TICK_MS;
}

/** Is this event a human input (for the tick)? Everything except acknowledgements and mere hovering. */
export function humanInput(e) {
  if (!e || typeof e !== "object") return false;
  if (e.t === "mouse") return e.type !== "mouseMoved" || (e.buttons | 0) !== 0;
  return e.t === "key" || e.t === "text";
}
