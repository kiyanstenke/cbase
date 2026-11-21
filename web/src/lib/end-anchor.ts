// Extracted from web/src/lib/scroll.ts (atEnd, EndAnchor) without React, so web/test/end-anchor.test.mjs can transpile the class with tsc and
// EXECUTE it (scroll.ts imports useEffect and therefore cannot be loaded without a bundler). scroll.ts passes both names on; callers
// (ChatStage …) are unchanged.

// ── At the end of a scroll area? ─────────────────────────────────────────────────
//
// The chat histories follow an incoming answer only as long as the user REALLY stands at the
// end. "Up to 80 px before it" used to count as bottom: whoever had scrolled up a bit to re-read the last lines of a long
// answer was pulled back to the end at the next piece of text. Now only the edge itself counts.
//
// The tolerance of 1 px is not generosity but rounding: with a non-integer
// device pixel ratio or fractional heights in the layout, `scrollTop` after a
// `scrollTop = scrollHeight` lies half a pixel beside the computed edge.

/** What the computation reads and writes on a scroll area — an HTMLElement satisfies it, a test passes an object. */
export interface ScrollArea {
  scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

export function atEnd(m: ScrollArea): boolean {
  return m.scrollHeight - m.scrollTop - m.clientHeight <= 1;
}

/**
 * Decides in the scroll handler of a history whether an event comes from the USER — only then
 * may it decide about sticking to the end.
 *
 * Three sources of scroll events that are NOT the user:
 *   • the own jump to the end (`toEnd`) — arrives only in the next frame, and if the
 *     content has grown in between, it seems to stand "2 px above";
 *   • Chrome's scroll anchoring: if content shrinks (the memory brake re-measures: −11 px),
 *     the browser holds the anchor node and shifts scrollTop — an event 2.5 px from
 *     the edge, and with the strict threshold the history stopped sticking;
 *   • clamping of scrollTop when the content shrinks below the scroll position.
 * The old 80 px threshold never noticed these.
 *
 * Detection: a user scroll does not change the SCROLL HEIGHT (layout scrolls always do), or
 * it comes shortly after an input (wheel, finger, key, pointer on the scroll bar) — that
 * also covers the case that the user scrolls up DURING growth.
 *
 * The pointer counts only if it was pressed INSIDE the history: otherwise EVERY release in the window would open a
 * 300 ms user window — also the release on the chat row that OPENS the chat. The layout scrolls of opening (anchoring
 * when an image at the top gets its height; clamping) fell into exactly this window, counted as a user scroll, `sticks()` said
 * "not at the end", and the history stayed 324–380 px (the image height) above the end. Now `pointerBottom` (on the scroll area,
 * `onPointerDown`) remembers that the press began there, and only then does
 * `pointerTop` (window, also `pointercancel`) open the window.
 */
export class EndAnchor {
  private own: number | null = null;
  private sh = -1;
  private ch = -1;
  private userUntil = 0;
  private pointerInHistory = false;
  /**
   * Set to the end and remember the position actually reached (the browser clamps). Also if scrollTop already stood there:
   * a still PENDING scroll event from an earlier clamping arrives with exactly this position and so counts as
   * own — otherwise it would decide about sticking with a changed scroll height as soon as a user window is open.
   */
  toEnd(m: ScrollArea) {
    m.scrollTop = m.scrollHeight;
    this.own = m.scrollTop;
    this.sh = m.scrollHeight;
    this.ch = m.clientHeight;
  }
  /** Input of the user: the scroll events of the next `window` ms are his. */
  userInput(window = 300) {
    this.userUntil = performance.now() + window;
  }
  /** Pointer pressed IN the history (dragging the scroll bar, dragging a selection): until release everything is his. */
  pointerBottom() {
    this.pointerInHistory = true;
    this.userUntil = Infinity;
  }
  /** Pointer released or canceled (window listener): only after a press IN the history a user window. */
  pointerTop() {
    if (!this.pointerInHistory) return;
    this.pointerInHistory = false;
    this.userInput();
  }
  /**
   * In the scroll handler: the new sticking state — or null if this event does not come from the
   * user and therefore decides nothing.
   */
  /**
   * After a "sticks": if the history still stands above the edge WITHOUT a user input being open, it belongs back
   * at the end. Chrome's scroll anchoring shifts scrollTop by one pixel when content above shrinks by a FRACTION
   * (the memory brake locks the measured height) — the integer scroll height stays the same, `sticks` takes the event for the user,
   * and `atEnd` (≤ 1 px) says "at the end". Never with an input open: a trackpad scrolls in steps of one pixel, and each of them would
   * otherwise be taken back.
   */
  toEdge(m: ScrollArea): boolean {
    return performance.now() > this.userUntil && m.scrollHeight - m.scrollTop - m.clientHeight > 0;
  }
  sticks(m: ScrollArea): boolean | null {
    // The mark applies to exactly ONE event — the next, whether it fits or not. Since `ansEnd` sets it also without movement,
    // otherwise no event would consume it, and a later user scroll exactly back to the end would be taken as "own".
    const own = this.own;
    this.own = null;
    if (own != null && m.scrollTop === own) return null;
    const layoutEqual = m.scrollHeight === this.sh && m.clientHeight === this.ch;
    this.sh = m.scrollHeight;
    this.ch = m.clientHeight;
    if (!layoutEqual && performance.now() > this.userUntil) return null;
    return atEnd(m);
  }
}
