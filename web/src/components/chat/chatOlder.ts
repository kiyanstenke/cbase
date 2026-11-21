// Older pages when scrolling up (history window: lib/api/log-window.ts, server chats/log-window.js): a chat opens with only
// the end of its history. When the reader comes near the top edge (RELOAD_FROM_PX) and rows lie before it (`older`),
// `loadOlder` (chat/chatCache.ts) prepends the next page. The scroll position stays: before loading, the distance to the
// BOTTOM end is remembered and restored after the new bubbles render, before paint; the text the reader had in view stays
// in the same place. If the window does not fill the scroll area, it keeps loading on its own.
//
// Why no virtualisation: with the window an open chat renders about WINDOW_ROWS rows instead of all (a 16,000-row chat
// renders about 300); each bubble already carries `content-visibility` (lib/contain.tsx). Only someone who scrolls very far
// up has many bubbles again; that is the deliberate exception, not the chat switch.
import { useEffect, useLayoutEffect, useRef } from "react";

/** Reloading begins this close to the top edge. */
export const RELOAD_FROM_PX = 600;

export function useOlderReload({ msgsRef, bubbles, activeId, chatLoading, older, loadOlder }: {
  msgsRef: React.RefObject<HTMLDivElement | null>;
  bubbles: readonly unknown[];
  activeId: string | null;
  chatLoading: boolean;
  older: boolean;
  loadOlder: (until?: number) => Promise<void>;
}): void {
  const loading = useRef(false);
  const gapBottom = useRef<number | null>(null);

  // After the new bubbles render: the same distance to the bottom end as before the load.
  useLayoutEffect(() => {
    const m = msgsRef.current;
    if (!m || gapBottom.current === null) return;
    m.scrollTop = m.scrollHeight - gapBottom.current;
  }, [bubbles, msgsRef]);

  useEffect(() => {
    const m = msgsRef.current;
    if (!m || !activeId || chatLoading || !older) return;
    const check = () => {
      if (loading.current || m.scrollTop > RELOAD_FROM_PX) return;
      loading.current = true;
      gapBottom.current = m.scrollHeight - m.scrollTop;
      loadOlder()
        .catch(console.error)
        // Two frames later: by then the layout effect has set the position; afterwards the reader leads again.
        .finally(() => requestAnimationFrame(() => requestAnimationFrame(() => { gapBottom.current = null; loading.current = false; check(); })));
    };
    m.addEventListener("scroll", check, { passive: true });
    check(); // if the window does not fill the area (or it is already at the top), keep going right away
    return () => m.removeEventListener("scroll", check);
  }, [msgsRef, activeId, chatLoading, older, loadOlder]);
}
