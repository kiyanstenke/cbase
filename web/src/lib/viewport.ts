"use client";

// ── Detecting narrow windows ────────────────────────────────────────────────────
//
// The desktop UI lays out up to three fixed columns side by side (workspace sidebar 228 px, chat list 272 px, right chat sidebar
// 272 px) with the history between them. Below about 1100 px nothing usable is left for the history, below 900 px the row ran out
// of the window. Instead of squeezing the columns, they collapse — the preview via hover/click stays, so no function is lost.
//
// What matters is the interplay with the user's choice: a sidebar opened by hand may close when shrinking, but must open AGAIN when
// enlarging. For that `useAutoCollapse` remembers the user's wish and restores it on leaving the narrow range. Only the
// transition acts, not every render pass — otherwise one could no longer open a sidebar deliberately in a narrow window.

import { useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * Keeps an open popover inside the window.
 *
 * Right-anchored popovers (`absolute right-0`) and center-anchored ones (`left-1/2 -translate-x-1/2`) sit relative to their
 * trigger. As soon as it sits far left in a narrow window — the normal case after the header wraps — the popover sticks out over the
 * LEFT window edge: up to 196 px outside at a window width of 420 px. A mere width limit does not help, because the problem is the
 * position, not the width.
 *
 * It is shifted via the standalone `translate` property, NOT via `transform`: otherwise the correction would overwrite the
 * `-translate-x-1/2` of the center-anchored popovers.
 */
export function useEdgeClamp<T extends HTMLElement>(open: boolean) {
  const ref = useRef<T | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !open) return;
    const margin = 8;
    const fix = () => {
      el.style.translate = "";
      const r = el.getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      let dx = 0;
      if (r.left < margin) dx = margin - r.left;
      else if (r.right > vw - margin) dx = vw - margin - r.right;
      if (dx) el.style.translate = `${Math.round(dx)}px`;
    };
    fix();
    window.addEventListener("resize", fix);
    return () => window.removeEventListener("resize", fix);
  }, [open]);
  return ref;
}

/** true while the window is narrower than `px`. SSR-safe (starts with false). */
export function useNarrow(px: number): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${px - 1}px)`);
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [px]);
  return narrow;
}

/**
 * Collapses a column as soon as the window falls below `px`, and restores the previously chosen state on crossing back.
 *
 * @param px       threshold in pixels
 * @param open     is the column currently open?
 * @param setOpen  toggle (the same one the button uses)
 */
export function useAutoCollapse(px: number, open: boolean, setOpen: (open: boolean) => void) {
  const narrow = useNarrow(px);
  const wasNarrow = useRef<boolean | null>(null);
  // The user's wish as it was BEFORE narrowing.
  const wanted = useRef(open);
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    if (wasNarrow.current === narrow) return;
    const first = wasNarrow.current === null;
    wasNarrow.current = narrow;
    if (narrow) {
      wanted.current = openRef.current;
      if (openRef.current) setOpen(false);
    } else if (!first && wanted.current && !openRef.current) {
      setOpen(true);
    }
    // setOpen is a stable state function or useCallback for all callers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [narrow]);
  return narrow;
}
