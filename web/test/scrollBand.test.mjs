// Decision "does the segment bar scroll?" (src/lib/scrollBand.ts), tested without a browser: what is proven is not the look
// but a feedback loop. The `scrolls` state attaches a spacer, the spacer changes the bar's own width, and that width is the
// number the decision was made against: a state that changes its own precondition.
//
// Reported as "the pill bar flickers extremely fast". Measured on a probe rig (letter-spacing 0.07 px): `clientWidth` jumped
// 391 <-> 401 while the need stayed at 392 -- 10 px of feedback (8 px spacer plus 2 px `gap-0.5`), once per frame. Exactly
// this geometry is `MEASURED` below.
//
// COUNTER-TEST (the proof, not the claim): the same loop, once with the ROUNDED computation (`offsetLeft + offsetWidth`
// against `clientWidth`) and once with the computation in fractions. The rounded one never settles, the other settles after
// one step. A test that only checked the new computation would also have let a hysteresis of 8 px pass -- which was short by
// exactly the 2 px gap, so the flicker stayed.
//
// Run:  node --test web/test/scrollBand.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");

const out = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-scroll-band-"));
execFileSync(process.execPath, [
  tsc, path.join(webDir, "src", "lib", "scrollBand.ts"),
  "--outDir", out, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler",
], { stdio: "pipe" });
const { scrollNeed, scrollsNow } = await import(pathToFileURL(path.join(out, "scrollBand.js")).href);
try { fs.rmSync(out, { recursive: true, force: true }); }
catch (e) { console.warn("[test] temp directory stayed behind:", String(e?.message || e).slice(0, 120)); }

// The measured situation. The last button ends at 389.38 px behind the left inner edge (327.62 + 61.76), plus 2 px right
// padding -- real need 391.38 px. Measured rounded this becomes 328 + 62 + 2 = 392: a pixel that exists only in the rounding.
const MEASURED = { lastLeft: 327.62, lastWidth: 61.76, pad: 2, holders: 10 }; // holders = spacer
const needReal = MEASURED.lastLeft + MEASURED.lastWidth + MEASURED.pad;
const needRounded = Math.round(MEASURED.lastLeft) + Math.round(MEASURED.lastWidth) + MEASURED.pad;

/**
 * A loop of measuring and setting, as `ResizeObserver` runs it: the own width of the `inline-flex` bar is the content, capped
 * by the available space -- and the content carries the spacer as soon as `scrolls` holds. `computation` returns the
 * decision from the own width.
 */
function loop(slot, computation, rounds = 12) {
  const lane = [];
  let scrolls = false;
  for (let i = 0; i < rounds; i++) {
    const own = Math.min(needReal + (scrolls ? MEASURED.holders : 0), slot);
    scrolls = computation(own);
    lane.push(scrolls);
  }
  return lane;
}

const inFractions = (own) => scrollsNow(needReal, own);
const rounded = (own) => needRounded > Math.round(own) + 0.5;

test("need in fractions: the right edge of the last button plus inner padding", () => {
  // 100 is the left inner edge of the bar in rect space, 489.38 the right edge of the last button in it:
  // 389.38 content + 2 inner padding.
  assert.equal(scrollNeed(100, 489.38, 0, 2), needReal);
});

test("need: the scroll offset counts -- a scrolled bar would otherwise think it fits", () => {
  // Rects scroll along, `offsetLeft` does not. Scrolled 26 px to the left, the same edge sits 26 px further left in the
  // window; without the term the need would shrink by exactly those 26 px and a scrolling bar would conclude it fits.
  assert.equal(scrollNeed(100, 489.38 - 26, 26, 2), needReal);
});

test("fits: the computation in fractions settles after one step", () => {
  const lane = loop(1560, inFractions);
  assert.deepEqual(new Set(lane), new Set([false]), `lane: ${lane.join(",")}`);
});

test("COUNTER-TEST: computed rounded, the same loop oscillates forever", () => {
  const lane = loop(1560, rounded);
  // Exactly the reported picture: scrolls, does not scroll, scrolls, ... once per frame.
  assert.deepEqual(lane.slice(0, 6), [true, false, true, false, true, false], `lane: ${lane.join(",")}`);
  assert.notEqual(lane[lane.length - 1], lane[lane.length - 2], "it should still be oscillating at the end");
});

test("overflows: scrolls stays set, the spacer does not cancel itself", () => {
  // The space is below the need -- exactly the case scrolling was built for. The spacer must not flip the decision here,
  // or the inner padding it is meant to provide at the end of the scroll would vanish again.
  const lane = loop(380, inFractions);
  assert.deepEqual(new Set(lane), new Set([true]), `lane: ${lane.join(",")}`);
});

test("exactly at the edge: content and space equal means \"fits\"", () => {
  const lane = loop(needReal, inFractions);
  assert.deepEqual(new Set(lane), new Set([false]), `lane: ${lane.join(",")}`);
});

test("half a pixel of overflow does not count, two do", () => {
  assert.equal(scrollsNow(391.38, 391.0), false);
  assert.equal(scrollsNow(393.38, 391.0), true);
});
