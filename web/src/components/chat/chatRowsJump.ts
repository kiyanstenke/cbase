// The jump "row in the chat" as a hook of the stage: `useRowsJump({ activeId, chatLoading, count, msgsRef, stickRef, … })`.
// lib/rows-jump.ts `openChatRow` creates the wish (the location of a timeline event); as soon as THIS chat is open and
// loaded, the history scrolls to the row's bubble (`data-row` on the `Contained` wrapper, `targetIndex`) and briefly
// highlights it. "Stick to the end" goes off meanwhile, otherwise the next growth would pull the reader back to the end.
//
// Why a hook and why in ChatStage: ChatPane sits at the line guard; the stage knows scroll area and sticking.
//
// History window (lib/api/log-window.ts): if the row lies BEFORE the first loaded one (`window.firstRow`) and older rows
// exist, the hook first loads everything up to it (`loadOlder(row)`, a request that begins at or before the row at the
// boundary) and scrolls once the bubbles are there.
import { useEffect, useRef, useState } from "react";
import { ROWS_JUMP_EVENT, rowsWish, rowsWishDone, targetIndex } from "@/lib/rows-jump";

/** How often a waiting wish re-asks while its chat is still loading (the deadline would never expire otherwise). */
const TICK_MS = 250;
/** How long the target bubble carries its highlight. */
const HIGHLIGHTING_MS = 1_800;

export function useRowsJump({ activeId, chatLoading, count, msgsRef, stickRef, window: timeWindow, loadOlder }: {
  activeId: string | null;
  chatLoading: boolean;
  /** Number of bubbles; growth (history loaded) wakes the hook. */
  count: number;
  msgsRef: React.RefObject<HTMLDivElement | null>;
  stickRef: React.RefObject<boolean>;
  /** The window of the open chat: whether rows lie before it, and which is the first loaded. */
  window: { older: boolean; firstRow: number };
  /** Loads the older rows up to and including `until`. */
  loadOlder: (until?: number) => Promise<void>;
}): void {
  const [tick, setTick] = useState(0);
  const requested = useRef<object | null>(null); // the wish for which the older rows are already on their way

  useEffect(() => {
    const on = () => setTick((x) => x + 1);
    window.addEventListener(ROWS_JUMP_EVENT, on);
    return () => window.removeEventListener(ROWS_JUMP_EVENT, on);
  }, []);

  useEffect(() => {
    const w = rowsWish(activeId);
    if (!w) return;
    const m = msgsRef.current;
    if (chatLoading || count === 0 || !m) {
      const t = setTimeout(() => setTick((x) => x + 1), TICK_MS);
      return () => clearTimeout(t);
    }
    if (timeWindow.older && w.row < timeWindow.firstRow) {
      if (requested.current === w) return;
      requested.current = w;
      // Afterwards `count` grows and the effect comes back; if loading fails, the tick asks again.
      loadOlder(w.row).catch(console.error).finally(() => { if (requested.current === w) requested.current = null; setTick((x) => x + 1); });
      return;
    }
    rowsWishDone(w);
    const bubbles = [...m.querySelectorAll<HTMLElement>("[data-row]")];
    const i = targetIndex(bubbles.map((b) => Number(b.dataset.row)), w.row);
    if (i < 0) return;
    const target = bubbles[i];
    stickRef.current = false;
    // Twice: the wrappers carry `content-visibility` with an estimated height; after the first scroll the bubbles around the
    // target measure their real height and the target shifts. The second call puts it at the measured position.
    target.scrollIntoView({ block: "center" });
    requestAnimationFrame(() => requestAnimationFrame(() => target.scrollIntoView({ block: "center" })));
    // The highlight clears itself; no cleanup in the effect, because a new render (the stream grows) would leave the mark.
    target.setAttribute("data-row-target", "");
    target.style.outline = "2px solid color-mix(in srgb, var(--color-accent) 45%, transparent)";
    target.style.outlineOffset = "4px";
    target.style.borderRadius = "12px";
    setTimeout(() => {
      target.removeAttribute("data-row-target");
      target.style.outline = "";
      target.style.outlineOffset = "";
      target.style.borderRadius = "";
    }, HIGHLIGHTING_MS);
  }, [tick, activeId, chatLoading, count, msgsRef, stickRef, timeWindow.older, timeWindow.firstRow, loadOlder]);
}
