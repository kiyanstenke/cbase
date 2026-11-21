// The grid of the editor groups like VS Code 1.143 — the pure computations of the tree in which the groups stand.
// The model is the grid of VS Code (Grid over GridView over SplitView, as of 1.143.1):
// Port of: microsoft/vscode src/vs/base/browser/ui/grid/grid.ts (MIT)
// Port of: microsoft/vscode src/vs/base/browser/ui/grid/gridview.ts (MIT)
// Port of: microsoft/vscode src/vs/base/browser/ui/splitview/splitview.ts (MIT)
//
//   - The tree: the root is ALWAYS a branch (even with one group), a branch lays its children side by side or stacked, and the
//     orientation changes per level (the root carries `situation`; GridView `orientation`). A leaf is a group (its identifier).
//   - Sizes are SHARES per branch (sum 1) — VS Code computes in pixels, but redistributes proportionally on redraw (`proportionalLayout`);
//     pixels arise only in `layoutPx` (rounded, minimum sizes, the rest from the back like `distributeEmptySpace`).
//   - Inserting (`insertClipboard`, Grid.addView + getRelativeLocation): if the direction fits the orientation of the branch, the new group comes next to it in
//     the same branch, otherwise the leaf is wrapped in a new branch (both half). If only ONE group stands there, the root turns its orientation.
//     The size like `workbench.editor.splitSizing: auto`: if the children are equally distributed they stay so, otherwise the new one gets half of the
//     source (`Sizing.Split`). The overhang is then taken by the children from back to front (SplitView `relayout` → `resize`) — that works only in
//     pixels: `insertClipboard` halves in shares and remembers the step (`backfill`), `aligned` computes it afterwards with the measured area.
//   - Removing (`remove`, Grid.removeView with Sizing.Auto): the size goes to the neighbor before it (the first: to the second), equally
//     distributed stay equal; if ONE child remains in a branch, it takes its place (the sizes of the grandparent branch stay).
//   - Moving (`move`, Grid.moveView), neighbors per direction (`neighbors`, getNeighborViews with wrap-around), the order of the leaves
//     (`sheets`, GRID_APPEARANCE), equalizing (`equalDistributed` over everything, `equallyDistributedAt` only one branch — the double-click on a
//     separator), flipping (`flip`), layouts (`byLayout`, createSerializedGrid), dragging a separator (`pull`, SplitView.resize — in the
//     2×2 grid the inner lines drag coupled like `trySet2x2`), a group wider/narrower (`changeSize`, GridView.resizeView).
//   - Minimum sizes like `DEFAULT_EDITOR_MIN_DIMENSIONS` (220 × 70): a branch needs the sum in its orientation, across it the largest.
//   - The tree is remembered as JSON (`rasterFrom`): unreadable is null, never "empty".
//
// Tested by execution in web/test/editor-raster.test.mjs, each computation with a sabotage its check must catch.

export type Situation = "sideBySide" | "mutually";
export type Direction = "top" | "bottom" | "left" | "right";
export type RasterSheet = { kind: "sheet"; id: string; share: number };
export type RasterBranch = { kind: "branch"; children: readonly RasterNode[]; share: number };
export type RasterNode = RasterSheet | RasterBranch;
/** An insert that is only finished in pixels (VS Code SplitView.addView with `Sizing.Split(source)` into an unequally distributed branch): the
 *  branch at location `branch`, the new group at `fresh` (index after inserting), the source at `source` (index BEFORE inserting — VS Code
 *  `highPriorityIndexes = [size.index]`, after inserting it points to the new one when going left/up) and the shares before. */
export type Backfill = { branch: Location; fresh: number; source: number; prior: readonly number[] };
/** `situation`: how the root lays its children (VS Code `orientation` of the grid — HORIZONTAL is "side by side"). `backfill`: see `Backfill` — every
 *  further computation on the tree (a new tree) drops it, `aligned` resolves it. */
export type Raster = { situation: Situation; root: RasterBranch; backfill?: Backfill };
/** A location in the tree: the indexes from the root (VS Code `GridLocation`). */
export type Location = readonly number[];
export type Box = { x: number; y: number; w: number; h: number };
/** A separator: between child `index` and `index + 1` of the branch at location `branch`. `situation` is that of the branch (side by side ⇒ a
 *  vertical line); `x`/`y` its start, `length` across the orientation, `lengthBranch` the length of the branch in its orientation (for dragging). */
export type Separator = { branch: number[]; index: number; situation: Situation; x: number; y: number; length: number; lengthBranch: number };

/** The smallest size of a group (VS Code `DEFAULT_EDITOR_MIN_DIMENSIONS`). */
export const MIN_WIDTH = 220;
export const MIN_HEIGHT = 70;
/** "Equally distributed" (SplitView `areViewsDistributed`: largest minus smallest ≤ 2 px) — here in shares, 2 px at 1,000 px. */
export const DISTRIBUTED_TOLERANCE = 0.002;
const EPS = 1e-6;

export const landscape = (l: Situation): Situation => (l === "sideBySide" ? "mutually" : "sideBySide");
export const orientationOfTheDirection = (r: Direction): Situation => (r === "left" || r === "right" ? "sideBySide" : "mutually");
const rear = (r: Direction) => r === "right" || r === "bottom";
export const againstDirection = (r: Direction): Direction => ({ top: "bottom", bottom: "top", left: "right", right: "left" } as const)[r];
/** The orientation of the branch at location `branch` (the root: `r.situation`, below it across per level). */
export const orientationOfTheBranch = (r: Raster, branch: Location): Situation => (branch.length % 2 === 0 ? r.situation : landscape(r.situation));

/** ONE group. */
export const individual = (id: string): Raster => ({ situation: "sideBySide", root: { kind: "branch", share: 1, children: [{ kind: "sheet", id, share: 1 }] } });
/** Groups in a row (equal, or by `shares`). */
export function queue(ids: readonly string[], situation: Situation = "sideBySide", shares?: readonly number[]): Raster {
  const a = shares && shares.length === ids.length && shares.every((x) => x > 0 && Number.isFinite(x)) ? shares : ids.map(() => 1);
  const sum = a.reduce((x, y) => x + y, 0);
  return { situation, root: { kind: "branch", share: 1, children: ids.map((id, i) => ({ kind: "sheet", id, share: a[i] / sum })) } };
}

// ── Reading ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** The groups in the order of the grid (VS Code `GroupsOrder.GRID_APPEARANCE`: depth-first search). */
export function sheets(r: Raster): string[] {
  const out: string[] = [];
  const go = (k: RasterNode) => { if (k.kind === "sheet") out.push(k.id); else for (const c of k.children) go(c); };
  go(r.root);
  return out;
}
export function locationOf(r: Raster, id: string): number[] | null {
  const search = (k: RasterNode, location: number[]): number[] | null => {
    if (k.kind === "sheet") return k.id === id ? location : null;
    for (let i = 0; i < k.children.length; i++) { const x = search(k.children[i], [...location, i]); if (x) return x; }
    return null;
  };
  return search(r.root, []);
}
export function nodeAt(r: Raster, location: Location): RasterNode | null {
  let k: RasterNode = r.root;
  for (const i of location) { if (k.kind !== "branch" || !k.children[i]) return null; k = k.children[i]; }
  return k;
}
const sameLocations = (a: Location, b: Location) => a.length === b.length && a.every((x, i) => x === b[i]);

// ── Building (mutable inside, always a new tree outside) ────────────────────────────────────────────────────────────────────────
type MSheet = { kind: "sheet"; id: string; share: number };
type MBranch = { kind: "branch"; children: MNode[]; share: number };
type MNode = MSheet | MBranch;
type MRaster = { situation: Situation; root: MBranch; backfill?: Backfill };
const cloneK = (k: RasterNode): MNode => (k.kind === "sheet" ? { kind: "sheet", id: k.id, share: k.share } : { kind: "branch", share: k.share, children: k.children.map(cloneK) });
const clone = (r: Raster): MRaster => ({ situation: r.situation, root: cloneK(r.root) as MBranch });
const branchAt = (r: MRaster, location: Location): MBranch => { let k: MNode = r.root; for (const i of location) k = (k as MBranch).children[i]; return k as MBranch; };
/** SplitView `areViewsDistributed`. */
const distributed = (children: readonly { share: number }[]) => {
  if (children.length < 2) return true;
  const a = children.map((k) => k.share);
  return Math.max(...a) - Math.min(...a) <= DISTRIBUTED_TOLERANCE;
};
const equal = (children: { share: number }[]) => { for (const k of children) k.share = 1 / children.length; };

/** A NEW group `fresh` next to `ref` in direction `direction` (VS Code Grid.addView with `Sizing.Auto`). Unknown or already there: the same tree. */
export function insertClipboard(r: Raster, fresh: string, ref: string, direction: Direction): Raster {
  if (locationOf(r, fresh) || !locationOf(r, ref)) return r;
  const k = clone(r);
  // Grid.addView: with ONE group the root turns its orientation to the direction.
  if (sheets(k).length === 1 && k.situation !== orientationOfTheDirection(direction)) k.situation = orientationOfTheDirection(direction);
  const location = locationOf(k, ref)!;
  const parentLocation = location.slice(0, -1), i = location[location.length - 1];
  const parent = branchAt(k, parentLocation);
  const sheet: MSheet = { kind: "sheet", id: fresh, share: 0 };
  if (orientationOfTheBranch(k, parentLocation) === orientationOfTheDirection(direction)) {
    // getRelativeLocation: into the same branch, right/below behind it. SplitView: Auto ⇒ equally distributed stays equal, otherwise Split(i).
    if (distributed(parent.children)) { parent.children.splice(i + (rear(direction) ? 1 : 0), 0, sheet); equal(parent.children); }
    else {
      // Without pixels: the source is halved (right for right/down as long as no minimum size applies); `aligned` computes the rest afterwards.
      const source = parent.children[i], prior = parent.children.map((c) => c.share), j = i + (rear(direction) ? 1 : 0);
      sheet.share = source.share / 2; source.share /= 2; parent.children.splice(j, 0, sheet);
      k.backfill = { branch: parentLocation, fresh: j, source: i, prior };
    }
  } else {
    // GridView.addView on a leaf: a new branch in its place (with its size), in it leaf and new group half each.
    const old = parent.children[i];
    const pair: MNode[] = rear(direction) ? [{ ...old, share: 0.5 }, { ...sheet, share: 0.5 }] : [{ ...sheet, share: 0.5 }, { ...old, share: 0.5 }];
    parent.children[i] = { kind: "branch", share: old.share, children: pair };
  }
  return k;
}

/** The group `id` out of the grid (VS Code Grid.removeView with `Sizing.Auto`). The last one stays. */
export function remove(r: Raster, id: string): Raster {
  const location0 = locationOf(r, id);
  if (!location0 || sheets(r).length < 2) return r;
  const k = clone(r);
  const parentLocation = location0.slice(0, -1), i = location0[location0.length - 1];
  const parent = branchAt(k, parentLocation);
  // SplitView.removeView: Auto ⇒ equally distributed stays equal, otherwise the neighbor before (the first: the second) gets the size.
  if (distributed(parent.children)) { parent.children.splice(i, 1); equal(parent.children); }
  else { const ref = parent.children[i === 0 ? 1 : i - 1]; ref.share += parent.children[i].share; parent.children.splice(i, 1); }
  if (parent.children.length > 1) return k;
  const siblings = parent.children[0];
  if (parentLocation.length === 0) {
    // The root: a leaf stays in it; a branch becomes the new root (its orientation is across — the tree keeps its shape).
    if (siblings.kind === "sheet") { siblings.share = 1; return k; }
    return { situation: landscape(k.situation), root: { kind: "branch", share: 1, children: siblings.children } };
  }
  // The last child takes the place of its branch; the sizes of the grandparent branch stay (GridView.removeView `resizeChild`).
  const large = branchAt(k, parentLocation.slice(0, -1)), pi = parentLocation[parentLocation.length - 1];
  if (siblings.kind === "branch") large.children.splice(pi, 1, ...siblings.children.map((c) => ({ ...c, share: c.share * parent.share })));
  else large.children.splice(pi, 1, { ...siblings, share: parent.share });
  return k;
}

/** Move the group `id` next to `ref` in direction `direction` (VS Code Grid.moveView): in the same branch only reorder (the sizes
 *  move along), otherwise remove and insert again. */
export function move(r: Raster, id: string, ref: string, direction: Direction): Raster {
  const source = locationOf(r, id), target = locationOf(r, ref);
  if (!source || !target || id === ref) return r;
  const ofParent = source.slice(0, -1), from = source[source.length - 1];
  const [targetParent, to] = orientationOfTheBranch(r, target.slice(0, -1)) === orientationOfTheDirection(direction)
    ? [target.slice(0, -1), target[target.length - 1] + (rear(direction) ? 1 : 0)]
    : [target, rear(direction) ? 1 : 0];
  if (sameLocations(ofParent, targetParent)) {
    // BranchNode.moveChild: `if (from === to) return; if (from < to) to -= 1;` — if it lands in the same place, the tree stays the same.
    if (from === to || from + 1 === to) return r;
    const k = clone(r), z = branchAt(k, ofParent);
    const [x] = z.children.splice(from, 1);
    z.children.splice(from < to ? to - 1 : to, 0, x);
    return k;
  }
  return insertClipboard(remove(r, id), id, ref, direction);
}

/** All branches equally distributed (VS Code `distributeViewSizes()` without a location: recursive — "Reset Editor Group Sizes"). */
export function equalDistributed(r: Raster): Raster {
  const k = clone(r);
  const go = (z: MBranch) => { equal(z.children); for (const c of z.children) if (c.kind === "branch") go(c); };
  go(k.root);
  return k;
}
/** Only the branch at location `branch` (the double-click on a separator: `onDidSashReset` → `distributeViewSizes(parentLocation)`). */
export function equallyDistributedAt(r: Raster, branch: Location): Raster {
  const z0 = nodeAt(r, branch);
  if (!z0 || z0.kind !== "branch") return r;
  const k = clone(r);
  equal(branchAt(k, branch).children);
  return k;
}
/** "Toggle Vertical/Horizontal Editor Layout" (GridView `orientation` = — the whole tree flips, the shares stay). */
export const flip = (r: Raster): Raster => ({ situation: landscape(r.situation), root: r.root });

// ── Neighbors ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** The boxes of the groups in the unit square (0…1). */
export function boxes(r: Raster): Map<string, Box> {
  const out = new Map<string, Box>();
  const go = (k: RasterNode, situation: Situation, b: Box) => {
    if (k.kind === "sheet") { out.set(k.id, b); return; }
    let pos = situation === "sideBySide" ? b.x : b.y;
    for (const c of k.children) {
      const kb = situation === "sideBySide" ? { x: pos, y: b.y, w: b.w * c.share, h: b.h } : { x: b.x, y: pos, w: b.w, h: b.h * c.share };
      pos += situation === "sideBySide" ? kb.w : kb.h;
      go(c, landscape(situation), kb);
    }
  };
  go(r.root, r.situation, { x: 0, y: 0, w: 1, h: 1 });
  return out;
}
type Limit = { situation: number; from: number; until: number };
function limit(b: Box, direction: Direction): Limit {
  if (direction === "top") return { situation: b.y, from: b.x, until: b.x + b.w };
  if (direction === "bottom") return { situation: b.y + b.h, from: b.x, until: b.x + b.w };
  if (direction === "left") return { situation: b.x, from: b.y, until: b.y + b.h };
  return { situation: b.x + b.w, from: b.y, until: b.y + b.h };
}
/** The groups that border `id` in `direction` (VS Code Grid.getNeighborViews; `lap`: at the edge from the other side), in the
 *  order of the grid. */
export function neighbors(r: Raster, id: string, direction: Direction, lap = false): string[] {
  const ks = boxes(r), b = ks.get(id);
  if (!b) return [];
  const g = limit(b, direction);
  if (lap) {
    if (direction === "top" && Math.abs(b.y) < EPS) g.situation = 1;
    else if (direction === "right" && Math.abs(b.x + b.w - 1) < EPS) g.situation = 0;
    else if (direction === "bottom" && Math.abs(b.y + b.h - 1) < EPS) g.situation = 0;
    else if (direction === "left" && Math.abs(b.x) < EPS) g.situation = 1;
  }
  const against = againstDirection(direction);
  // findAdjacentBoxLeafNodes: the same edge, the ranges overlap (`intersects`: truly, not just at a point).
  return sheets(r).filter((x) => {
    const o = limit(ks.get(x)!, against);
    return Math.abs(o.situation - g.situation) < EPS && o.from < g.until - EPS && g.from < o.until - EPS;
  });
}

// ── Pixels ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** The minimum size of a node in the axis `axis` (`situation`: the orientation of the node itself if it is a branch). */
export function minimumSize(k: RasterNode, situation: Situation, axis: Situation): number {
  if (k.kind === "sheet") return axis === "sideBySide" ? MIN_WIDTH : MIN_HEIGHT;
  const m = k.children.map((c) => minimumSize(c, landscape(situation), axis));
  return situation === axis ? m.reduce((x, y) => x + y, 0) : Math.max(...m);
}
/** The pixels of the children of a branch of length `length` (SplitView.layout proportional: rounded, at least the minimum size, the rest from
 *  back to front like `distributeEmptySpace`). If the length is not enough, it overhangs (like VS Code). */
export function sizesPx(shares: readonly number[], length: number, mins: readonly number[]): number[] {
  const g = shares.map((a, i) => Math.max(mins[i] ?? 0, Math.round(a * length)));
  let rest = length - g.reduce((x, y) => x + y, 0);
  for (let i = g.length - 1; i >= 0 && rest !== 0; i--) {
    const fresh = Math.max(mins[i] ?? 0, g[i] + rest);
    rest -= fresh - g[i];
    g[i] = fresh;
  }
  return g;
}
const minsOf = (z: RasterBranch, situation: Situation) => z.children.map((c) => minimumSize(c, landscape(situation), situation));
/** The tree in pixels: the box of each group and each separator, for an area `width` × `height`. */
export function layoutPx(r: Raster, width: number, height: number): { boxes: Map<string, Box>; separator: Separator[] } {
  const out = new Map<string, Box>(), separator: Separator[] = [];
  const go = (z: RasterBranch, location: number[], situation: Situation, b: Box) => {
    const nb = situation === "sideBySide", length = nb ? b.w : b.h;
    const g = sizesPx(z.children.map((c) => c.share), length, minsOf(z, situation));
    let pos = nb ? b.x : b.y;
    z.children.forEach((c, i) => {
      if (i > 0) separator.push({ branch: location, index: i - 1, situation, x: nb ? pos : b.x, y: nb ? b.y : pos, length: nb ? b.h : b.w, lengthBranch: length });
      const kb = nb ? { x: pos, y: b.y, w: g[i], h: b.h } : { x: b.x, y: pos, w: b.w, h: g[i] };
      pos += g[i];
      if (c.kind === "sheet") out.set(c.id, kb);
      else go(c, [...location, i], landscape(situation), kb);
    });
  };
  go(r.root, [], r.situation, { x: 0, y: 0, w: Math.max(0, width), h: Math.max(0, height) });
  return { boxes: out, separator };
}
const withShares = (z: MBranch, px: readonly number[]) => { const s = px.reduce((x, y) => x + y, 0) || 1; z.children.forEach((c, i) => { c.share = px[i] / s; }); };
/** SplitView.addView with `Sizing.Split` in pixels (VS Code `doAddView`: the new one gets `getViewSize(index) / 2`, the source keeps its size;
 *  then `relayout([fresh], [source])` → `resize(last, area − content)`): the children give up the overhang from back to front — the one at
 *  index `source` first (`pushToStart`), the new one last (`pushToEnd`), each down to its minimum size (`clamp` — also the new one, which
 *  started below it); what is then missing or left over is balanced by `distributeEmptySpace` from the back. `mins` are those AFTER inserting. */
function broughtAlongPx(nz: Backfill, length: number, mins: readonly number[]): number[] {
  const before = sizesPx(nz.prior, length, mins.filter((_, i) => i !== nz.fresh));
  const g = [...before];
  g.splice(nz.fresh, 0, before[nz.source] / 2);
  const followUp: number[] = [];
  for (let i = g.length - 1; i >= 0; i--) if (i !== nz.source && i !== nz.fresh) followUp.push(i);
  if (nz.source !== nz.fresh) followUp.unshift(nz.source);
  followUp.push(nz.fresh);
  let over = length - g.reduce((x, y) => x + y, 0);
  for (const x of followUp) { const n = Math.max(mins[x], g[x] + over); over -= n - g[x]; g[x] = n; }
  let empty = length - g.reduce((x, y) => x + y, 0);
  for (let x = g.length - 1; x >= 0 && empty !== 0; x--) { const n = Math.max(mins[x], g[x] + empty); empty -= n - g[x]; g[x] = n; }
  return g;
}
/** The shares as they are drawn (SplitView.relayout → `saveProportions` after every change of a child): if a minimum size holds a child
 *  larger than its share, the drawn pixels become the new shares — otherwise the grid would jump as soon as the minimum size falls again
 *  (a group closes). Only after a change of the grid, never after a size change of the area (SplitView.layout does not save).
 *  If the tree carries a `backfill`, the insert is finished here in pixels (`broughtAlongPx`) and the backfill drops. If a branch does not suffice
 *  for its minimum sizes, it stays (a backfill there stays halved). Nothing to do: the same tree. */
export function aligned(r: Raster, width: number, height: number): Raster {
  if (!(width > 0) || !(height > 0)) return r;
  const nz = r.backfill;
  let k: MRaster | null = nz ? clone(r) : null;
  const go = (z: RasterBranch, location: number[], situation: Situation, w: number, h: number) => {
    const nb = situation === "sideBySide", length = nb ? w : h, mins = minsOf(z, situation);
    let g = sizesPx(z.children.map((c) => c.share), length, mins);
    const matches = mins.reduce((x, y) => x + y, 0) <= length;
    if (matches && nz && sameLocations(location, nz.branch) && nz.prior.length + 1 === z.children.length) withShares(branchAt(k!, location), (g = broughtAlongPx(nz, length, mins)));
    else if (matches && z.children.some((c, i) => Math.round(c.share * length) < mins[i])) withShares(branchAt((k ??= clone(r)), location), g);
    z.children.forEach((c, i) => { if (c.kind === "branch") go(c, [...location, i], landscape(situation), nb ? g[i] : w, nb ? h : g[i]); });
  };
  go(r.root, [], r.situation, width, height);
  return k ?? r;
}

/** Is it the 2×2 grid whose inner separators drag coupled (GridView `trySet2x2`: two branches with two leaves each, the first ones equally large)? */
export function is2x2(r: Raster): boolean {
  const [a, b] = r.root.children;
  if (r.root.children.length !== 2 || a.kind !== "branch" || b.kind !== "branch" || a.children.length !== 2 || b.children.length !== 2) return false;
  if (![...a.children, ...b.children].every((c) => c.kind === "sheet")) return false;
  return Math.abs(a.children[0].share - b.children[0].share) < EPS;
}
/** Drag a separator (SplitView.resize over the sizes at the press): `way` px since the press, `length` the length of the branch. The children
 *  before it (away from the line) and behind it yield down to their minimum size; no further. In the 2×2 grid the line of the
 *  other branch drags along. */
export function pull(r: Raster, branch: Location, index: number, distance: number, length: number): Raster {
  const z0 = nodeAt(r, branch);
  if (!z0 || z0.kind !== "branch" || index < 0 || index >= z0.children.length - 1 || !(length > 0) || !Number.isFinite(distance)) return r;
  const situation = orientationOfTheBranch(r, branch), mins = minsOf(z0, situation);
  const g = sizesPx(z0.children.map((c) => c.share), length, mins);
  const up: number[] = [], down: number[] = [];
  for (let i = index; i >= 0; i--) up.push(i);
  for (let i = index + 1; i < g.length; i++) down.push(i);
  const minDelta = up.reduce((s, i) => s + (mins[i] - g[i]), 0);
  const maxDelta = down.reduce((s, i) => s + (g[i] - mins[i]), 0);
  const delta = Math.min(maxDelta, Math.max(minDelta, distance));
  let d = delta;
  for (const i of up) { const n = Math.max(mins[i], g[i] + d); d -= n - g[i]; g[i] = n; }
  d = delta;
  for (const i of down) { const n = Math.max(mins[i], g[i] - d); d += n - g[i]; g[i] = n; }
  const k = clone(r);
  withShares(branchAt(k, branch), g);
  if (branch.length === 1 && is2x2(r)) withShares(branchAt(k, [1 - branch[0]]), g);
  return k;
}
/** SplitView.resizeView: child `index` to `px`; the rest from the back (the child itself last), each down to its minimum size. */
function setKind(z: MBranch, situation: Situation, index: number, px: number, length: number) {
  const mins = minsOf(z, situation);
  const g = sizesPx(z.children.map((c) => c.share), length, mins);
  g[index] = Math.min(length, Math.max(mins[index], Math.round(px)));
  const followUp: number[] = [];
  for (let i = g.length - 1; i >= 0; i--) if (i !== index) followUp.push(i);
  followUp.push(index);
  let d = length - g.reduce((x, y) => x + y, 0);
  d = Math.max(d, followUp.reduce((s, i) => s + (mins[i] - g[i]), 0));
  for (const i of followUp) { const n = Math.max(mins[i], g[i] + d); d -= n - g[i]; g[i] = n; }
  withShares(z, g);
}
/** A group in `axis` by `delta` px larger/smaller (VS Code "Increase Current View Width" → GridView.resizeView with width
 *  and height of the group): its branch changes it, if it lies across, the branch above changes the whole branch. */
export function changeSize(r: Raster, id: string, axis: Situation, delta: number, width: number, height: number): Raster {
  const location = locationOf(r, id);
  if (!location || !Number.isFinite(delta) || !(width > 0) || !(height > 0)) return r;
  const { boxes: ks } = layoutPx(r, width, height), b = ks.get(id)!;
  const desired = { sideBySide: b.w + (axis === "sideBySide" ? delta : 0), mutually: b.h + (axis === "mutually" ? delta : 0) };
  const parentLocation = location.slice(0, -1), situation = orientationOfTheBranch(r, parentLocation);
  const k = clone(r);
  // The length of a branch in its orientation: via the boxes of its leaves (the branch itself has none).
  const lengthOf = (zLocation: number[], zSituation: Situation) => {
    const ids = sheets({ situation: r.situation, root: nodeAt(r, zLocation) as RasterBranch });
    const bs = ids.map((x) => ks.get(x)!);
    return zSituation === "sideBySide" ? Math.max(...bs.map((x) => x.x + x.w)) - Math.min(...bs.map((x) => x.x)) : Math.max(...bs.map((x) => x.y + x.h)) - Math.min(...bs.map((x) => x.y));
  };
  if (parentLocation.length > 0) {
    const largeLocation = parentLocation.slice(0, -1), largeSituation = landscape(situation);
    setKind(branchAt(k, largeLocation), largeSituation, parentLocation[parentLocation.length - 1], desired[largeSituation], lengthOf(largeLocation, largeSituation));
  }
  setKind(branchAt(k, parentLocation), situation, location[location.length - 1], desired[situation], lengthOf(parentLocation, situation));
  return k;
}

// ── Layouts ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** A description like VS Code `EditorGroupLayout` (`orientation` HORIZONTAL ⇒ "side by side"). */
export type LayoutGroup = { groups?: readonly LayoutGroup[] };
export type Layout = { situation: Situation; groups: readonly LayoutGroup[] };
/** How many groups a description has (the same rule as `byLayout`: a group with at most one child is ONE). */
export function groupsIn(l: { groups?: readonly LayoutGroup[] }): number {
  return (l.groups ?? []).reduce((n, g) => n + (g.groups && g.groups.length > 1 ? groupsIn(g) : 1), 0);
}
/** A grid from a description (VS Code createSerializedGrid: a branch with at most one child is a leaf, everything equally large);
 *  the leaves get `ids` in order (depth-first) — if one is missing, null. */
export function byLayout(l: Layout, ids: readonly string[]): Raster | null {
  let n = 0;
  const build = (g: LayoutGroup, share: number): MNode | null => {
    const children = g.groups && g.groups.length > 1 ? g.groups : null;
    if (!children) { const id = ids[n++]; return id === undefined ? null : { kind: "sheet", id, share }; }
    const ks = children.map((c) => build(c, 1 / children.length));
    return ks.every(Boolean) ? { kind: "branch", share, children: ks as MNode[] } : null;
  };
  if (!l.groups.length) return null;
  const children = l.groups.map((c) => build(c, 1 / l.groups.length));
  if (!children.every(Boolean)) return null;
  return { situation: l.situation, root: { kind: "branch", share: 1, children: children as MNode[] } };
}

// ── Remembering ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** A remembered tree — null if it does not carry exactly the groups `ids` (each once) or is unreadable. A branch with ONE child (except the
 *  root) becomes that child (sanitize like VS Code), the shares per branch computed to 1. */
export function rasterFrom(raw: unknown, ids: readonly string[]): Raster | null {
  const o = raw as { situation?: unknown; root?: unknown } | null;
  if (!o || typeof o !== "object" || (o.situation !== "sideBySide" && o.situation !== "mutually")) return null;
  const seen = new Set<string>();
  let branches = 0;
  const read = (x: unknown): MNode | null => {
    const k = x as { kind?: unknown; id?: unknown; share?: unknown; children?: unknown } | null;
    if (!k || typeof k !== "object" || typeof k.share !== "number" || !(k.share > 0) || !Number.isFinite(k.share)) return null;
    if (k.kind === "sheet") {
      if (typeof k.id !== "string" || !ids.includes(k.id) || seen.has(k.id)) return null;
      seen.add(k.id);
      return { kind: "sheet", id: k.id, share: k.share };
    }
    if (k.kind !== "branch" || !Array.isArray(k.children) || !k.children.length || ++branches > 256) return null;
    const children: MNode[] = [];
    for (const c of k.children as unknown[]) { const m = read(c); if (!m) return null; children.push(m); }
    const s = children.reduce((a, c) => a + c.share, 0);
    for (const c of children) c.share /= s;
    // Huge shares (2 × 1e308) would give the sum ∞ and then all zeros: after computing, every share must be finite and > 0.
    if (!children.every((c) => c.share > 0 && Number.isFinite(c.share))) return null;
    return { kind: "branch", share: k.share, children };
  };
  const w = read(o.root);
  if (!w || w.kind !== "branch" || seen.size !== ids.length) return null;
  w.share = 1;
  // A branch with one child (not the root) steps back: a leaf in its place, a branch with ITS children (they lie in the
  // orientation of the branch above — so the shape stays).
  const smooth = (z: MBranch) => {
    const fresh: MNode[] = [];
    for (const c of z.children) {
      if (c.kind !== "branch") { fresh.push(c); continue; }
      smooth(c);
      if (c.children.length > 1) { fresh.push(c); continue; }
      const e = c.children[0];
      if (e.kind === "sheet") fresh.push({ ...e, share: c.share });
      else fresh.push(...e.children.map((x) => ({ ...x, share: x.share * c.share })));
    }
    z.children = fresh;
  };
  smooth(w);
  // The root with ONE branch in it: it becomes the root (across), like GridView on removing.
  const e = w.children.length === 1 ? w.children[0] : null;
  if (e && e.kind === "branch") return { situation: landscape(o.situation), root: { kind: "branch", share: 1, children: e.children } };
  return { situation: o.situation, root: w };
}
