// ── Does a bar scroll? Measured in fractions, not rounded pixels ───────
//
// `Segments` (CbKit) decides while measuring whether the bar scrolls and THEN appends a real spacer as the last child. In an
// `inline-flex` bar that is no decoration: the spacer enters the intrinsic width, i.e. exactly the number the decision was made against.
// The state changes its own precondition.
//
// Measuring the need at the LAST BUTTON instead of `scrollWidth` walls off only half of this path. The other half was ROUNDING.
// `offsetLeft`, `offsetWidth` and `clientWidth` are integers, the real box widths are not: for a bar of 391.38 px real width
// `clientWidth` reported 391 and the sum of the rounded button sizes 392, a pixel that existed only in the rounding. So "scrolls" although
// the bar fits; so it grows by the spacer; so the new width refutes the condition; so the spacer drops. Once per frame, ~60 Hz. Measured on
// a test rig with letter-spacing 0.07 px: `clientWidth` jumped 391 ↔ 401 while the need stayed at 392. Exactly the reported "flickers
// extremely fast back and forth".
//
// Ten pixels of feedback, not eight: the spacer is 8 px wide and brings the bar's gap (`gap-0.5`, 2 px) with it. A hysteresis over an
// estimated feedback is therefore the wrong way; it fell short by exactly these 2 px at the first attempt and the flicker stayed. The right
// way is not to round at all.
//
// Measured in fractions the spacer can no longer close the cycle, and that is not experience but a line of algebra. If the bar fits
// (intrinsic width = content width), the view WITH the spacer is `need + feedback`, and `need > need + feedback` is false: the spacer
// drops, afterwards the view is exactly `need`, and `need > need` is false again. If it overflows, the view is capped by `max-width`,
// so the spacer does not change it at all. Both sides are stable, nothing lies in between.
//
// Both functions stay here and not in the component so the guard in the gate can run them without a browser:
// `web/test/scrollBand.test.mjs` replays the measured trace and demands that it settles, with the rounded computation as counter-check.

/**
 * Space the content needs in the scroll area's coordinate system (origin: left inner edge), in fractions. `barLeft` is the bar's left
 * inner edge (rectangle plus left border), `lastRight` the right edge of the last button from the same rectangle space.
 *
 * `scrollLeft` belongs because rectangles scroll along and `offsetLeft` does not: without this term the measured need would shrink as
 * soon as the bar is scrolled, and a scrolled bar would take itself for one that fits.
 */
export function scrollNeed(barLeft: number, lastRight: number, scrollLeft: number, padRight: number): number {
  return lastRight - barLeft + scrollLeft + padRight;
}

/**
 * Does the bar scroll? `view` is the width of the inner surface, also in fractions. The half pixel is leeway against floating-point
 * noise, not generosity: a real overflow of a third of a pixel is none an eye can find.
 */
export function scrollsNow(need: number, view: number): boolean {
  return need > view + 0.5;
}
