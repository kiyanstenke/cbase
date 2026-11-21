"use client";
// Port of: microsoft/vscode src/vs/base/browser/ui/list/listView.ts (MIT)
// The explorer's window: draws ONLY the rows in the viewport plus a buffer, each absolute at its `top` (index × row height) in a surface of
// the full height (VS Code `ListView`: `rowsContainer.style.height = scrollHeight`, per row `style.top = elementTop(index)`). The
// computation is in lib/tree-window.ts.
//
// Scrolling: the window itself listens to `scroll` on the tree's surface and draws ONLY when the range changes — then synchronously in the
// event (`flushSync`, as VS Code in the same frame), otherwise not at all. The tree above (ExplorerTree) does not render while scrolling;
// `onScroll` reports the scroll position for sticky scroll in the same pass. The rows themselves are `memo` (TreeRow): a row that stays in
// the window does not re-render. Guard: web/test/tree-window.test.mjs (with sabotages, also rendered over a body DOM).
import { useEffect, useLayoutEffect, useReducer, useRef, type ReactNode, type RefObject } from "react";
import { flushSync } from "react-dom";
import { treeWindow, drawn, nextWindow, type Window } from "@/lib/tree-window";

export function TreeWindow({ surface, count, h, view, always, draw, onScroll }: {
  /** The scrolling surface (`role="tree"`). */
  surface: RefObject<HTMLElement | null>;
  count: number;
  /** The row height (fractional, measured). */
  h: number;
  /** The height of the viewport. */
  view: number;
  /** Indices that always stand (focus, field, source of a drag) — lib/tree-window.ts `drawn`. */
  always: readonly number[];
  /** Row `i` at its `top` (px from the tree's top edge). */
  draw: (i: number, top: number) => ReactNode;
  /** Every scroll event: the scroll position (sticky scroll) — in the same pass as the window. */
  onScroll?: (scrollTop: number) => void;
}) {
  const top = useRef(0);
  const dimensions = useRef({ count, h, view });
  dimensions.current = { count, h, view };
  const report = useRef(onScroll);
  report.current = onScroll;
  const [, newDraw] = useReducer((x: number) => x + 1, 0);
  const f = treeWindow(count, top.current, h, view);
  const stands = useRef<Window>(f);
  stands.current = f;

  useEffect(() => {
    const el = surface.current;
    if (!el) return;
    const scroll = () => {
      top.current = el.scrollTop;
      const m = dimensions.current;
      const fresh = treeWindow(m.count, top.current, m.h, m.view);
      const different = nextWindow(stands.current, fresh) !== stands.current;
      flushSync(() => {
        if (different) newDraw();
        report.current?.(top.current);
      });
    };
    el.addEventListener("scroll", scroll, { passive: true });
    return () => el.removeEventListener("scroll", scroll);
  }, [surface]);

  // Newly mounted or other measures (a big folder collapses, the surface shortens `scrollTop`): take the surface's state BEFORE painting —
  // otherwise the old window would stand for one frame.
  useLayoutEffect(() => {
    const el = surface.current;
    if (!el || el.scrollTop === top.current) return;
    top.current = el.scrollTop;
    newDraw();
    report.current?.(top.current);
  }, [surface, count, h, view]);

  return (
    <div className="cb-tree-window" style={{ height: count * h }} data-tree-window={`${f.from}-${f.until}`}>
      {drawn(f, always, count).map((i) => draw(i, i * h))}
    </div>
  );
}
