// Port of: microsoft/vscode src/vs/base/browser/ui/tree/abstractTree.ts (MIT)
// Sticky scroll in the tree styled like VS Code — the PURE computation, ported from VS Code `StickyScrollController`
// (abstractTree.ts `findStickyState`, `getNextStickyNode`, `getAncestorUnderPrevious`, `calculateStickyNodePosition`, `constrainStickyNodes`).
//
// The parent folders of the topmost visible row stick at the top, at most MAX (VS Code `workbench.tree.stickyScrollMaxItemCount`, default 7)
// and at most 40 % of the height (VS Code `maxWidgetViewRatio`). A sticky folder is pushed up as soon as its last descendant scrolls out
// below it (it never stands above rows that are no longer its own). A folder whose row stands exactly under the sticky ones does not stick
// (it is at its place anyway); a collapsed row never sticks.
//
// The rows are equally tall (`h`, the tree's row height); `depth` is the level (a compact row is ONE level), `open` means
// "expanded folder". → per sticky row its index and its position `top` (pixels from the view's top edge, ≤ its place in the stack).
// Guard: web/test/tree-sticky.test.mjs (with counter-proofs).

export const STICKY_MAX = 7;
export const STICKY_SHARE = 0.4;

export type StickyRow = { depth: number; open: boolean };
export type StickyNode = { index: number; top: number };

export function stickyNode(rows: readonly StickyRow[], scrollTop: number, h: number, view: number, max = STICKY_MAX): StickyNode[] {
  const n = rows.length;
  if (!n || h <= 0 || scrollTop <= 0) return [];
  const indexAt = (y: number): number | null => { const i = Math.floor(y / h); return i >= 0 && i < n ? i : null; };
  // The ancestors of i (index), from outside in, and i itself last.
  const chain = (i: number): number[] => {
    const out = [i];
    let t = rows[i].depth;
    for (let k = i - 1; k >= 0 && t > 0; k--) if (rows[k].depth < t) { out.unshift(k); t = rows[k].depth; }
    return out;
  };
  const lastDescendant = (i: number): number => { let j = i; while (j + 1 < n && rows[j + 1].depth > rows[i].depth) j++; return j; };
  // The ancestor of `i` (or `i` itself) one level under `prior` — or without `prior` the outermost. null: `prior` is no ancestor.
  const underPrevious = (i: number, prior: number | null): number | null => {
    const k = chain(i);
    if (prior === null) return k[0];
    const pos = k.indexOf(prior);
    return pos >= 0 && pos + 1 < k.length ? k[pos + 1] : null;
  };
  const node = (i: number, stack: number): StickyNode => {
    const bottomEdgeLast = (lastDescendant(i) + 1) * h - scrollTop;
    return { index: i, top: Math.min(stack, bottomEdgeLast - h) };
  };
  const next = (under: number, prior: number | null, stack: number): StickyNode | null => {
    const i = underPrevious(under, prior);
    if (i === null) return null;
    if (i === under) {
      if (!rows[i].open) return null; // only an expanded folder sticks
      if (Math.abs(i * h - scrollTop - stack) < 0.5) return null; // stands exactly under the sticky ones: at its place (h is fractional)
    }
    return node(i, stack);
  };
  const out: StickyNode[] = [];
  let under = indexAt(scrollTop);
  if (under === null) return [];
  let s = next(under, null, 0);
  while (s) {
    out.push(s);
    if (out.length > max) break;
    const further = indexAt(scrollTop + s.top + h);
    if (further === null) break;
    under = further;
    s = next(under, s.index, out.length * h);
  }
  // Capped as in VS Code: at most `max` rows, and none reaches below 40 % of the view.
  for (let i = 0; i < out.length; i++) if (i >= max || out[i].top + h > view * STICKY_SHARE) return out.slice(0, i);
  return out;
}

/** Where the tree scrolls when the sticky row at slot `slot` (0 = top) is clicked: so that the row stands exactly there
 *  (VS Code: a click on a sticky element shows it under the sticky ancestors). */
export const stickyTarget = (index: number, slot: number, h: number): number => Math.max(0, index * h - slot * h);
