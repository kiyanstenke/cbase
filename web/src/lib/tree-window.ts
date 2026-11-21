// Port of: microsoft/vscode src/vs/base/browser/ui/list/listView.ts (MIT)
// Port of: microsoft/vscode src/vs/base/browser/ui/tree/abstractTree.ts (MIT)
// The explorer made fluid as in VS Code — the PURE computation of virtualization. A leaf module without imports, computed in
// web/test/tree-window.test.mjs (with sabotages), drawn in components/code/explorer/TreeWindow.tsx.
//
// The tree used to draw EVERY visible row (6,000 rows ⇒ ≈ 60,000 nodes) and set a state in the whole tree on every scroll event.
// VS Code `ListView` draws only the rows in the viewport (`getRenderRange`: `rangeMap.indexAt(renderTop)` to
// `indexAfter(renderTop + renderHeight - 1)`), each at its fixed `top` (explorer row height 22 px),
// and when scrolling swaps ONLY the rows entering or leaving (`render`: `Range.relativeComplement` of both ranges) — the others
// stay untouched.
//
//   treeWindow      the rows [from, until) that are drawn: the viewport plus `buffer` rows per side (deviation from VS Code: VS Code
//                    scrolls itself and draws in the same frame without a buffer; cbase scrolls natively — the buffer covers the frames before
//                    the scroll event draws the new range).
//   nextWindow      the same object if the range does not change — React then does not render at all (the core: "a scroll event does not
//                    redraw every row").
//   drawn           the indexes that stand: the window plus the rows that must never drop out (focus for
//                    `aria-activedescendant`, the field while renaming/creating, the source of a drag), ascending and without duplicates.
//   scrollTarget    "Reveal Active File"/keys without the row in the DOM: already fully visible ⇒ null; near (≤ 3 rows beside) ⇒ to the
//                    edge; far away ⇒ centered (VS Code `reveal` with `relativeTop` 0.5 — as before, only computed from the index).
//   ariaSet         `aria-setsize`/`aria-posinset` per row as VS Code `AbstractTree` (`getSetSize` = visible children of the parent node,
//                    `getPosInSet` = `visibleChildIndex + 1`) — ONCE per row state, the drawing only reads.

/** The explorer's row height in VS Code (`ExplorerDelegate.ITEM_HEIGHT` in src/vs/workbench/contrib/files/browser/views/explorerViewer.ts)
 *  — with text scale ≠ 1 the drawing measures the real (fractional) height. */
export const ROW_PX = 22;
/** This many rows per side beyond the viewport (deviation from VS Code). */
export const BUFFER = 8;

export type Window = { readonly from: number; readonly until: number };

export function treeWindow(count: number, scrollTop: number, h: number, view: number, buffer = BUFFER): Window {
  if (count <= 0 || !(h > 0)) return { from: 0, until: 0 };
  const top = Math.max(0, scrollTop);
  const first = Math.min(count - 1, Math.floor(top / h));
  const afterLast = Math.max(first + 1, Math.ceil((top + Math.max(0, view)) / h));
  return { from: Math.max(0, first - buffer), until: Math.min(count, afterLast + buffer) };
}

export const nextWindow = (old: Window, fresh: Window): Window => (old.from === fresh.from && old.until === fresh.until ? old : fresh);

export function drawn(f: Window, always: readonly number[], count: number): number[] {
  const out: number[] = [];
  for (let i = f.from; i < f.until; i++) out.push(i);
  const extra = always.filter((i) => i >= 0 && i < count && (i < f.from || i >= f.until));
  if (!extra.length) return out;
  return [...new Set([...out, ...extra])].sort((a, b) => a - b);
}

export function scrollTarget(index: number, h: number, scrollTop: number, view: number): number | null {
  const top = index * h, bottom = top + h;
  if (top >= scrollTop && bottom <= scrollTop + view) return null;
  const near = bottom > scrollTop - h * 3 && top < scrollTop + view + h * 3;
  if (near) return top < scrollTop ? top : bottom - view;
  return Math.max(0, top - (view - h) / 2);
}

export type AriaRow = { readonly parent: string };
export type AriaSet = { readonly size: Int32Array; readonly position: Int32Array };

export function ariaSet(rows: readonly AriaRow[]): AriaSet {
  const n = rows.length;
  const size = new Int32Array(n), position = new Int32Array(n);
  const count = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const k = (count.get(rows[i].parent) ?? 0) + 1;
    count.set(rows[i].parent, k);
    position[i] = k;
  }
  for (let i = 0; i < n; i++) size[i] = count.get(rows[i].parent) ?? 1;
  return { size, position };
}
