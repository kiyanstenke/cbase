"use client";

import { useCallback, useRef, type RefCallback, type RefObject } from "react";

// ── Wheel over the empty margin of a history ────────────────────────────────────────────────────
//
// The scroll area of the coding chat on a wide stage is only 768 px wide (the reading column including a 16 px gutter on each side; the
// composer is as wide as the reading column) — so the scrollbar stands at the column, not at the edge of the page. Left and right of it
// stays empty stage. Without this helper a wheel (or trackpad) THERE scrolled nothing: the event lands in the margin area, its
// ancestors do not scroll, and the history is not an ancestor. The helper passes it on — as if it had been turned over the history.
//
// It is passed on ONLY if
//   • the target lies in the margin area but OUTSIDE the scroll area (there the browser scrolls itself — scrolling twice would be twice
//     as fast);
//   • no element between target and margin area can scroll in that direction itself, and the target is not an input (a text field with
//     little text does not scroll, but should still not hand the wheel to the history);
//   • it is vertical (|deltaY| > |deltaX|) and not a zoom (ctrlKey — that is how Chrome reports the trackpad "pinch" gesture).
// Header, base, banners, menus and the right bar do not lie IN the margin area (glass plates as siblings above it, menus via portal
// on the body, the bar next to the stage) — over them the wheel stays where it lands. The margin area is therefore a node of its own
// around the scroll area, not the stage.
//
// Convert `deltaMode`: lines (1) are the line height of the history, pages (2) 90 % of its visible height — pixels (0) stay as they are.
// Scrolling happens immediately (scrollTop), not smoothly: a second smooth scrollBy during the first drops its remainder.
//
// The user intent belongs to it: `onUserWheel(deltaY)` runs BEFORE scrolling, with the same consequence as the wheel over the history
// (EndAnchor.userInput, and up means "stop sticking to the end") — otherwise the scroll handler would take the forwarded scroll for a
// jump of its own, and the next answer would pull the history down again.
//
// Return: a callback ref for the margin area (React 19 cleans up via its return value). The listener is `passive: false` because it ends
// the forwarded event with preventDefault — an ancestor of the stage that can scroll itself would otherwise scroll along.

export const MARGIN_ROW_FALLBACK_PX = 16;

/** Pixels from a wheel event, by `deltaMode`. */
export function wheelPixel(e: Pick<WheelEvent, "deltaY" | "deltaMode">, rowPx: number, pagePx: number): number {
  if (e.deltaMode === 1) return e.deltaY * rowPx;
  if (e.deltaMode === 2) return e.deltaY * pagePx;
  return e.deltaY;
}

function scrollsSelf(el: Element, dy: number): boolean {
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement || el instanceof HTMLSelectElement) return true;
  if (el instanceof HTMLElement && el.isContentEditable) return true;
  const oy = getComputedStyle(el).overflowY;
  if (oy !== "auto" && oy !== "scroll" && oy !== "overlay") return false;
  if (el.scrollHeight <= el.clientHeight) return false;
  return dy < 0 ? el.scrollTop > 0 : el.scrollTop + el.clientHeight < el.scrollHeight - 1;
}

/** Should this wheel go to the scroll area? (pure decision, no side effect) */
export function marginWheelContinue(e: WheelEvent, margin: Element, scroller: Element): boolean {
  if (e.ctrlKey || e.defaultPrevented) return false;
  if (!e.deltaY || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return false;
  const target = e.target instanceof Element ? e.target : null;
  if (!target || !margin.contains(target) || scroller.contains(target)) return false;
  for (let el: Element | null = target; el && el !== margin; el = el.parentElement) {
    if (scrollsSelf(el, e.deltaY)) return false;
  }
  return true;
}

/**
 * The listener itself, without React: decide, convert, end the event, report the intent — and only THEN scroll. The order is the
 * promise: the history's scroll handler must already know the forwarded scroll as a user scroll when it arrives
 * (web/test/chat-scrollbar.test.mjs).
 */
export function marginWheelListener(
  margin: Element,
  fetchScroller: () => HTMLElement | null,
  onUserWheel: (deltaY: number) => void,
): (e: WheelEvent) => void {
  return (e: WheelEvent) => {
    const scroller = fetchScroller();
    if (!scroller || !marginWheelContinue(e, margin, scroller)) return;
    const row = parseFloat(getComputedStyle(scroller).lineHeight) || MARGIN_ROW_FALLBACK_PX;
    const dy = wheelPixel(e, row, scroller.clientHeight * 0.9);
    e.preventDefault();
    onUserWheel(dy);
    scroller.scrollTop += dy;
  };
}

export function useMarginWheel(
  scrollerRef: RefObject<HTMLElement | null>,
  onUserWheel: (deltaY: number) => void,
): RefCallback<HTMLDivElement> {
  // The callback may change per render, the listener stays the same.
  const callback = useRef(onUserWheel);
  callback.current = onUserWheel;
  return useCallback((margin: HTMLDivElement | null) => {
    if (!margin) return;
    const onWheel = marginWheelListener(margin, () => scrollerRef.current, (dy) => callback.current(dy));
    margin.addEventListener("wheel", onWheel, { passive: false });
    return () => margin.removeEventListener("wheel", onWheel);
  }, [scrollerRef]);
}
