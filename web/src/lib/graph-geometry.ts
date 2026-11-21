// Geometry of the flow builder: WHERE an edge leaves a node, where it arrives and which path it takes in between.
//
// The model: nodes with non-hard-coded outputs get one dock on the left and one on the right, as usual. Depending on where you drag the
// edge from, you decide what is the input and what the output.
//   · FREE nodes (instruction, parallel, entries, end, …): a dock on the left, a dock on the right. Each dock can be an output (you drag
//     an edge out of it) and an input (you drop an edge onto it). The GESTURE decides, and the choice is stored in the edge
//     (`fromSide`/`toSide`). Without it (older graphs, edges built on mobile) the convention applies: out to the right, in from the left.
//     All edges of a dock meet in ONE point (middle of the flank) — so a dock is a dock and not a row of wandering points.
//   · FIXED nodes (condition yes/no, loop each/done, review approval/findings): input one dock on the left, one output per branch on the
//     right, stacked in branch order. Their pills should stand where they are known; a stored side on a fixed node is ignored. The
//     marker (`fixed`) is set by the editor per node; the calculation here knows no node kinds.
// The calculation only reads the sides; it does not derive a side from the position of the neighbors — that produced cards with input
// AND output on the same flank that nobody could read. What the user dragged stays as dragged. Entries (trigger, start) accept no edge,
// `end` emits none — the editor decides that.
//
// Pure calculation, deliberately without React: so it can be checked on its own (web/test/graph-geometry.test.mjs) and ported number by
// number to Swift (mobile/CbaseMobile/Workflows/WorkflowGeometry.swift — the same graph shows the same paths on the iPhone). Everything
// calculates over rectangles {x,y,w,h}, so the editor can give individual kinds (start/end) another size without anything here knowing.

export type Pos = { x: number; y: number };
export type Rect = Pos & { w: number; h: number };        // node rectangle: top-left corner + size
export type Anchor = Pos & { nx: number; ny: number };    // point + normal (points outward)
export type Side = "left" | "right";
export type Port = { side: Side; slot: number };          // flank + position on it (0…1, from the top)

// Default size of a node. A suggestion for the editor — the calculation here does not depend on it.
export const NODE_W = 232;
export const NODE_H = 84;
// Length of the horizontal stub with which an edge leaves or enters a flank before it turns. Shorter, and the first corner would sit
// practically ON the point.
export const PORT_STUB = 24;
// Distance at which a detour runs around nodes: close enough to visibly belong to the node, far enough not to touch frame and shadow.
export const ROUTE_GAP = 28;
// From this much horizontal room between two flanks an edge runs as a staircase BETWEEN them (the step in the middle, half on each side as
// a stub). Deliberately small: two cards only 15 px apart between left and right flank need a vertical connection, not a detour around
// one of the cards. Below 12 px the arrowhead no longer fit between corner and point.
export const STAIR_MIN = 12;

// Point on a flank. `slot` is the position ON the flank (0…1), so several points can make way for one another without pixels here.
export function anchorAt(r: Rect, side: Side, slot = 0.5): Anchor {
  return side === "right"
    ? { x: r.x + r.w, y: r.y + r.h * slot, nx: 1, ny: 0 }
    : { x: r.x, y: r.y + r.h * slot, nx: -1, ny: 0 };
}
// This much margin always stays free on a flank: otherwise with many points one would sit in the rounded corner of the card.
const SLOT_MARGIN = 0.15;

// Evenly distributed heights for `count` points on a flank: a single one in the middle, several symmetrically around it. STRICTLY
// ascending — the caller sorts its points and gets the heights in the same order, so edges run in parallel instead of crossing in front
// of the flank.
function spread(count: number): number[] {
  if (count <= 0) return [];
  // (k+1)/(count+1) distributes evenly; from six points on it slides into the margin and is compressed to
  // [SLOT_MARGIN, 1-SLOT_MARGIN] — for ALL points, so the spacing stays equal (mere clipping would make the outer points collapse).
  const half = 0.5 - 1 / (count + 1);
  const scale = half > 0.5 - SLOT_MARGIN ? (0.5 - SLOT_MARGIN) / half : 1;
  return Array.from({ length: count }, (_, k) => 0.5 + ((k + 1) / (count + 1) - 0.5) * scale);
}

// Heights for `count` outputs on the right flank of a fixed node.
export const outSlots = (count: number): number[] => spread(count);

// Remove consecutive equal points and intermediate points on a straight run. They arise when anchors are at the same height — and a
// zero segment at the end twists the arrowhead, because an SVG marker follows the last segment. A U-turn on the same line is kept (that
// only occurs in the drag preview when the pointer is behind the stub).
function tidy(points: Pos[]): Pos[] {
  const equal = (a: number, b: number) => Math.abs(a - b) < 1e-6;
  const out: Pos[] = [];
  for (const p of points) {
    const prev = out[out.length - 1];
    if (prev && equal(prev.x, p.x) && equal(prev.y, p.y)) continue;
    const pp = out[out.length - 2];
    if (pp && prev) {
      const verticalContinue = equal(pp.x, prev.x) && equal(prev.x, p.x) && (p.y - prev.y) * (prev.y - pp.y) > 0;
      const horizontalContinue = equal(pp.y, prev.y) && equal(prev.y, p.y) && (p.x - prev.x) * (prev.x - pp.x) > 0;
      if (verticalContinue || horizontalContinue) out.pop();
    }
    out.push({ x: p.x, y: p.y });
  }
  return out;
}

// At which height does a detour run horizontally? If there is a vertical gap between the rectangles, in its middle — there it disturbs
// neither node, even if the gap is narrow (the path under both would lead the column from the output through the target as soon as it
// projects to the right). If they overlap vertically, along under both: the bottom is mostly free in the builder, the top holds title
// and toolbar. Downward edges lie a bit ABOVE the gap middle, upward ones below — two detours through the same gap would otherwise merge
// into ONE line; in a narrow gap the offset shrinks with it so that it does not hit a card.
function detourY(s: Rect, d: Rect): number {
  if (d.y >= s.y + s.h) return (s.y + s.h + d.y) / 2 - Math.min(ROUTE_GAP, d.y - (s.y + s.h)) / 4;   // d below s
  if (s.y >= d.y + d.h) return (d.y + d.h + s.y) / 2 + Math.min(ROUTE_GAP, s.y - (d.y + d.h)) / 4;   // d above s
  return Math.max(s.y + s.h, d.y + d.h) + ROUTE_GAP;
}

// Orthogonal polyline from the output `from` at `s` to the input `to` at `d`. Sharp corners; the last segment is always horizontal and
// approaches the flank from outside — so the arrowhead always points at the point. `inset` pulls the end point back by that many
// pixels so the tip ends ON the point and does not vanish behind it (the nodes lie above the edge layer).
// Three shapes, checked in this order:
//   · Staircase: opposite flanks and the target lies in the output direction — one step in the middle of the gap (a straight line at
//     the same height). Forward as backward.
//   · Bracket: the same flank, the cards stand on top of each other — a column outside past both, like a "[" or "]". That is the jump
//     back in the same column.
//   · Detour: everything else (offset overlapping cards) — stub out, vertical into the gap between the nodes or under both,
//     horizontal, vertical to the height of the input, in.
export function route(s: Rect, from: Port, d: Rect, to: Port, inset = 0): Pos[] {
  const a = anchorAt(s, from.side, from.slot);
  const b = anchorAt(d, to.side, to.slot);
  const start = { x: a.x, y: a.y };
  const end = { x: b.x + b.nx * inset, y: b.y };
  if (a.nx !== b.nx && (b.x - a.x) * a.nx >= STAIR_MIN) {
    if (Math.abs(a.y - b.y) < 0.5) return [start, end];
    const midX = (a.x + b.x) / 2;
    return tidy([start, { x: midX, y: a.y }, { x: midX, y: b.y }, end]);
  }
  const stacked = s.y + s.h <= d.y || d.y + d.h <= s.y;
  if (a.nx === b.nx && stacked) {
    const column = a.nx > 0 ? Math.max(a.x, b.x) + PORT_STUB : Math.min(a.x, b.x) - PORT_STUB;
    return tidy([start, { x: column, y: a.y }, { x: column, y: b.y }, end]);
  }
  const midY = detourY(s, d);
  let x1 = a.x + a.nx * PORT_STUB;
  let x2 = b.x + b.nx * PORT_STUB;
  // Neither column may lead through the OTHER card — with tight neighbors (gap below STAIR_MIN) the stub would otherwise hit its
  // interior as soon as the path runs under both. The column then moves to its facing edge.
  const crosses = (x: number, y0: number, y1: number, r: Rect) =>
    x > r.x && x < r.x + r.w && Math.max(y0, y1) > r.y && Math.min(y0, y1) < r.y + r.h;
  if (crosses(x1, a.y, midY, d)) x1 = a.nx > 0 ? Math.max(a.x, d.x) : Math.min(a.x, d.x + d.w);
  if (crosses(x2, midY, b.y, s)) x2 = b.nx > 0 ? Math.max(b.x, s.x) : Math.min(b.x, s.x + s.w);
  return tidy([start, { x: x1, y: a.y }, { x: x1, y: midY }, { x: x2, y: midY }, { x: x2, y: b.y }, end]);
}

// Preview while dragging a new edge: from the output to the pointer, with the same staircase as a finished edge — otherwise the line
// jumps into another shape on release. Without a target node there is no gap to calculate: if the pointer is behind the stub, it goes
// vertically at the stub to its height and then horizontally to it.
export function routeToPoint(s: Rect, from: Port, p: Pos): Pos[] {
  const a = anchorAt(s, from.side, from.slot);
  const midX = (p.x - a.x) * a.nx > PORT_STUB ? (a.x + p.x) / 2 : a.x + a.nx * PORT_STUB;
  return tidy([{ x: a.x, y: a.y }, { x: midX, y: a.y }, { x: midX, y: p.y }, { x: p.x, y: p.y }]);
}

// ── Wiring of a whole graph ────────────────────────────────────────────────────────────

// `branches`: outputs in order (exactly one for free nodes, none for `end`). `fixed`: input on the left, outputs on the right in
// branch order (condition, loop, review).
export type WireNode = { id: string; rect: Rect; branches: (string | null)[]; fixed?: boolean };
// `fromSide`/`toSide`: the docks the user chose while dragging — empty means convention (out to the right, in from the left). No effect
// on fixed nodes.
export type WireEdge = { from: string; to: string; branch: string | null; fromSide?: Side | ""; toSide?: Side | "" };
export type OutPort = Port & { occupied: boolean };                                  // occupied = an edge leaves
// Per flank: does an edge hang there (in or out)? A free dock is filled as soon as one does.
export type Docks = { left: boolean; right: boolean };
export type Wiring = {
  edges: Map<number, { from: Port; to: Port }>;      // edge index → both ends
  ports: Map<string, Map<string, OutPort>>;          // FIXED nodes: branchKey → position of the output (right)
  docks: Map<string, Docks>;                         // every node → occupied flanks
};

export const branchKey = (branch: string | null | undefined): string => branch ?? "";

// Connections of all edges in ONE pass: side and height of each end. A free dock is a point in the middle of its flank; the outputs of a
// fixed node stand on the right on top of each other in branch order (yes above no, no matter where the edges go), its input is a dock
// on the left.
export function wire(nodes: WireNode[], edges: WireEdge[]): Wiring {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const ports = new Map<string, Map<string, OutPort>>();
  const docks = new Map<string, Docks>();
  for (const n of nodes) {
    docks.set(n.id, { left: false, right: false });
    if (!n.fixed) continue;
    const heights = outSlots(n.branches.length);
    ports.set(n.id, new Map(n.branches.map((b, k) => [
      branchKey(b),
      { side: "right" as const, slot: heights[k], occupied: edges.some((e) => e.from === n.id && branchKey(e.branch) === branchKey(b)) },
    ])));
  }
  const out = new Map<number, { from: Port; to: Port }>();
  edges.forEach((e, i) => {
    const s = byId.get(e.from);
    const d = byId.get(e.to);
    if (!s || !d) return;
    const fixed = s.fixed ? ports.get(s.id)?.get(branchKey(e.branch)) : undefined;
    const from: Port = s.fixed
      ? { side: "right", slot: fixed?.slot ?? 0.5 }
      : { side: e.fromSide === "left" ? "left" : "right", slot: 0.5 };
    const to: Port = { side: !d.fixed && e.toSide === "right" ? "right" : "left", slot: 0.5 };
    docks.get(s.id)![from.side] = true;
    docks.get(d.id)![to.side] = true;
    out.set(i, { from, to });
  });
  return { edges: out, ports, docks };
}

// Edges that lie on a cycle: `from → to` belongs to it as soon as `to` leads back to `from`. The editor highlights them — a loop should
// be recognizable as a loop on the canvas, not only by the round counter of the cards. Reachability per edge, the graphs are small.
export function cycleEdges(edges: { from: string; to: string }[]): Set<number> {
  const next = new Map<string, string[]>();
  for (const e of edges) next.set(e.from, [...(next.get(e.from) ?? []), e.to]);
  const reached = new Map<string, Set<string>>();
  const reach = (start: string): Set<string> => {
    const known = reached.get(start);
    if (known) return known;
    const seen = new Set<string>();
    const queue = [start];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const t of next.get(cur) ?? []) if (!seen.has(t)) { seen.add(t); queue.push(t); }
    }
    reached.set(start, seen);
    return seen;
  };
  const out = new Set<number>();
  edges.forEach((e, i) => { if (reach(e.to).has(e.from)) out.add(i); });
  return out;
}

// SVG path with sharp corners — only M and L, no curves. Rounded to two decimals: third slots would otherwise produce 18-digit numbers
// in the DOM without a pixel lying differently.
export function pathOf(points: Pos[]): string {
  const f = (v: number) => String(Math.round(v * 100) / 100);
  return points.map((p, i) => `${i === 0 ? "M" : "L"}${f(p.x)},${f(p.y)}`).join(" ");
}

// Point at fraction `t` (0…1) of the TOTAL LENGTH of the polyline — for the delete button in the middle. Neither the middle corner point
// nor the chord between the ends: with a detour both would lie next to the line.
export function pointAlong(points: Pos[], t: number): Pos {
  if (points.length === 0) return { x: 0, y: 0 };
  const lens = points.slice(1).map((p, i) => Math.hypot(p.x - points[i].x, p.y - points[i].y));
  const total = lens.reduce((sum, l) => sum + l, 0);
  let rest = Math.min(1, Math.max(0, t)) * total;
  for (let i = 0; i < lens.length; i++) {
    if (rest <= lens[i] || i === lens.length - 1) {
      const u = lens[i] > 0 ? Math.min(1, rest / lens[i]) : 0;
      const p = points[i];
      const q = points[i + 1];
      return { x: p.x + (q.x - p.x) * u, y: p.y + (q.y - p.y) * u };
    }
    rest -= lens[i];
  }
  return { x: points[0].x, y: points[0].y };
}
