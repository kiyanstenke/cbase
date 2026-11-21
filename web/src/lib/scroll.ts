"use client";

import { useEffect } from "react";
import { type EndAnchor } from "@/lib/end-anchor";

// `atEnd` and `EndAnchor` live without React in lib/end-anchor.ts (which also explains why the pointer only counts after a press INSIDE the
// history); the two names are re-exported here so callers stay on `@/lib/scroll`.
export { atEnd, EndAnchor } from "@/lib/end-anchor";

/**
 * Window listeners for inputs that scroll the history but do not land on it: pointer release (after dragging the scrollbar) and
 * navigation keys. Wheel and finger attach directly to the scroll area (onWheel/onTouchMove). `pointercancel` like `pointerup`: an
 * aborted press in the history (system gesture, window switch) would otherwise leave the anchor on "everything is user" until the next release.
 */
export function useUserInput(anchor: EndAnchor) {
  useEffect(() => {
    const KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (KEYS.has(e.key)) anchor.userInput();
    };
    const onUp = () => anchor.pointerTop();
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [anchor]);
}
