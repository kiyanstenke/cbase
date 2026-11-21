// Anchors, docks, wiring and edge routes of the flow builder (src/lib/graph-geometry.ts).
// Free nodes carry one dock each on the left and right; which is input and which is output is decided by the
// gesture and stored in the edge (`fromSide`/`toSide`).
// Fixed nodes (condition, loop, review) stay rigid: input left, outputs right. The tests recompute and measure the
// routes instead of asserting "looks good": every segment axis-parallel, the first and last horizontal out of / into
// the chosen flank, no card crossed, and the dragged docks of a reference layout yield exactly the described connections.
// Run:  node --test web/test/*.test.mjs
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const source = path.join(webDir, "src", "lib", "graph-geometry.ts");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");

// Compile once, all tests share the module — tsc takes over a second per run.
let out = null;
let loaded = null;
function geometry() {
  loaded ??= (async () => {
    out = fs.mkdtempSync(path.join(webDir, "node_modules", ".geometry-test-"));
    // Flags as in the markdown test: without `bundler`/`skipLibCheck` tsc fails on the project's ambient types
    // (undici-types, csstype), not on this file.
    execFileSync(process.execPath, [
      tsc, source, "--module", "esnext", "--target", "es2022",
      "--moduleResolution", "bundler", "--skipLibCheck", "--outDir", out,
    ], { cwd: webDir, stdio: "pipe" });
    // The project has no `"type": "module"`, and Node 20 does not detect ESM in a .js file on its own
    // (only Node 22 does) — without this file the import fails with "Unexpected token export".
    fs.writeFileSync(path.join(out, "package.json"), '{"type":"module"}');
    return import(pathToFileURL(path.join(out, "graph-geometry.js")).href);
  })();
  return loaded;
}
after(() => { if (out) fs.rmSync(out, { recursive: true, force: true }); });

const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

// Every segment horizontal or vertical. Tolerance 0.5 px: a forward edge with < 0.5 px
// height difference is deliberately drawn as a straight line.
function axisAligned(pts) {
  for (let i = 1; i < pts.length; i++) {
    const dx = Math.abs(pts[i].x - pts[i - 1].x);
    const dy = Math.abs(pts[i].y - pts[i - 1].y);
    if (dx >= 0.5 && dy >= 0.5) return false;
  }
  return true;
}

// Does a segment cross the INTERIOR of a rectangle? Anchors on the border (and stubs that start exactly at the
// border) do not count — an edge may touch the card, just not pass through it.
function touchedInner(pts, r) {
  const eps = 1e-6;
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i - 1];
    const q = pts[i];
    const x0 = Math.max(Math.min(p.x, q.x), r.x);
    const x1 = Math.min(Math.max(p.x, q.x), r.x + r.w);
    const y0 = Math.max(Math.min(p.y, q.y), r.y);
    const y1 = Math.min(Math.max(p.y, q.y), r.y + r.h);
    if (x0 > x1 + eps || y0 > y1 + eps) continue;            // bounding box misses the rectangle
    const horizontal = near(p.y, q.y);
    if (horizontal) {
      if (p.y > r.y + eps && p.y < r.y + r.h - eps && x1 - x0 > eps) return true;
    } else if (p.x > r.x + eps && p.x < r.x + r.w - eps && y1 - y0 > eps) return true;
  }
  return false;
}

function gapToPolyline(pts, p) {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const len2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / len2));
    best = Math.min(best, Math.hypot(p.x - (a.x + (b.x - a.x) * t), p.y - (a.y + (b.y - a.y) * t)));
  }
  return best;
}

// Do two routes share a stretch (collinear AND overlapping)? Then they would be one line on screen.
function shareTrack(p1, p2) {
  for (let i = 1; i < p1.length; i++) {
    for (let j = 1; j < p2.length; j++) {
      const a = p1[i - 1], b = p1[i], c = p2[j - 1], d = p2[j];
      const wa = near(a.y, b.y), wc = near(c.y, d.y);
      if (wa && wc && near(a.y, c.y)) {
        if (Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x)) - Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x)) > 1) return true;
      }
      if (!wa && !wc && near(a.x, c.x)) {
        if (Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y)) - Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y)) > 1) return true;
      }
    }
  }
  return false;
}

// The rules EVERY finished edge must satisfy — whatever flanks it uses.
function checkEdge(g, pts, s, from, d, to, inset, name) {
  const a = g.anchorAt(s, from.side, from.slot);
  const b = g.anchorAt(d, to.side, to.slot);
  assert.ok(pts.length >= 2, `${name}: at least two points`);
  assert.ok(axisAligned(pts), `${name}: not axis-parallel: ${JSON.stringify(pts)}`);
  assert.deepEqual(pts[0], { x: a.x, y: a.y }, `${name}: does not start at the output`);
  assert.deepEqual(pts[pts.length - 1], { x: b.x + b.nx * inset, y: b.y }, `${name}: does not end ${inset} px before the input`);
  // First segment: horizontal OUT of the output flank (right to the right, left to the left).
  assert.ok((pts[1].x - pts[0].x) * a.nx > 0 && near(pts[1].y, pts[0].y, 0.5), `${name}: first segment does not leave the flank`);
  // Last segment: horizontal from OUTSIDE toward the input flank.
  const before = pts[pts.length - 2];
  const end = pts[pts.length - 1];
  assert.ok(near(before.y, end.y, 0.5), `${name}: last segment is not horizontal`);
  assert.ok((before.x - end.x) * b.nx > 0, `${name}: last segment does not come from outside`);
  assert.equal(touchedInner(pts, s), false, `${name}: crosses the source node`);
  assert.equal(touchedInner(pts, d), false, `${name}: crosses the target node`);
}
const P = (side, slot = 0.5) => ({ side, slot });
// Wiring of a small graph: rectangles + branches in, per edge both ends plus the route out.
function wire(g, nodes, edges, inset = 0) {
  const w = g.wire(nodes, edges);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const ways = edges.map((e, i) => {
    const ends = w.edges.get(i);
    assert.ok(ends, `edge ${i} (${e.from}→${e.to}) has no ends`);
    return { ...ends, pts: g.route(byId.get(e.from).rect, ends.from, byId.get(e.to).rect, ends.to, inset) };
  });
  return { w, ways };
}

test("Anchors: anchorAt sets point and normal per flank — also for compact rectangles", async (t) => {
  if (!fs.existsSync(tsc)) { t.skip("node_modules missing (tsc) — geometry not testable"); return; }
  const g = await geometry();
  const n = { x: 100, y: 50, w: g.NODE_W, h: g.NODE_H };
  assert.deepEqual(g.anchorAt(n, "right"), { x: 100 + g.NODE_W, y: 50 + g.NODE_H / 2, nx: 1, ny: 0 });
  assert.deepEqual(g.anchorAt(n, "left"), { x: 100, y: 50 + g.NODE_H / 2, nx: -1, ny: 0 });
  assert.deepEqual(g.anchorAt(n, "right", 0.25), { x: 100 + g.NODE_W, y: 50 + g.NODE_H * 0.25, nx: 1, ny: 0 });
  assert.deepEqual(g.anchorAt(n, "left", 0.75), { x: 100, y: 50 + g.NODE_H * 0.75, nx: -1, ny: 0 });
  // Start/end may be smaller: the calculation hangs on the rectangle, not on NODE_W/NODE_H.
  const small = { x: 10, y: 20, w: 120, h: 56 };
  assert.deepEqual(g.anchorAt(small, "right"), { x: 130, y: 48, nx: 1, ny: 0 });
  assert.deepEqual(g.anchorAt(small, "left"), { x: 10, y: 48, nx: -1, ny: 0 });
  assert.ok(g.PORT_STUB > 0 && g.ROUTE_GAP > 0 && g.STAIR_MIN > 0 && g.STAIR_MIN < g.PORT_STUB);
});

test("Docks: the edge carries its sides — empty means out right, in left; fixed nodes ignore them", async (t) => {
  if (!fs.existsSync(tsc)) { t.skip("node_modules missing (tsc) — geometry not testable"); return; }
  const g = await geometry();
  const N = (id, x, y, branches = [null], fixed = false) => ({ id, rect: { x, y, w: g.NODE_W, h: g.NODE_H }, branches, fixed });
  const nodes = [N("a", 0, 0), N("b", 500, 0), N("c", 1000, 0, ["true", "false"], true)];
  const w = g.wire(nodes, [
    { from: "a", to: "b", branch: null },                                       // convention
    { from: "b", to: "a", branch: null, fromSide: "left", toSide: "right" },    // gesture: out left, in right
    { from: "b", to: "c", branch: null, fromSide: "right", toSide: "right" },   // toSide on a FIXED node: ignored
    { from: "c", to: "a", branch: "false", fromSide: "left", toSide: "left" },  // fromSide on a fixed node: ignored
  ]);
  assert.deepEqual(w.edges.get(0), { from: { side: "right", slot: 0.5 }, to: { side: "left", slot: 0.5 } });
  assert.deepEqual(w.edges.get(1), { from: { side: "left", slot: 0.5 }, to: { side: "right", slot: 0.5 } });
  assert.deepEqual(w.edges.get(2).to, { side: "left", slot: 0.5 }, "a fixed node only accepts on the left");
  assert.equal(w.edges.get(3).from.side, "right", "a fixed node only emits on the right");
  assert.equal(w.edges.get(3).from.slot, g.outSlots(2)[1], "“no” at the height of the second branch");
  // Occupied docks: edge 0 leaves a on the right, edge 1 enters a on the right, edge 3 enters a on the left.
  assert.deepEqual(w.docks.get("a"), { left: true, right: true }, "a: out right (0), in right (1), in left (3)");
  assert.deepEqual(w.docks.get("b"), { left: true, right: true }, "b: in left (0) and out (1), out right (2)");
  assert.deepEqual(w.docks.get("c"), { left: true, right: true });
  // Without an edge no dock is occupied; a fixed node leads its outputs, a free one none.
  const empty = g.wire(nodes, []);
  assert.deepEqual(empty.docks.get("a"), { left: false, right: false });
  assert.equal(empty.ports.has("a"), false, "free nodes have no fixed outputs — only docks");
  assert.deepEqual([...empty.ports.get("c").keys()], ["true", "false"]);
  assert.deepEqual(empty.ports.get("c").get("true"), { side: "right", slot: g.outSlots(2)[0], occupied: false });
  // Invalid values count as empty.
  const crooked = g.wire(nodes, [{ from: "a", to: "b", branch: null, fromSide: "", toSide: "top" }]);
  assert.deepEqual(crooked.edges.get(0), { from: { side: "right", slot: 0.5 }, to: { side: "left", slot: 0.5 } });
});

test("outSlots: a single one in the middle, otherwise strictly ascending, symmetric, never in the corners", async (t) => {
  if (!fs.existsSync(tsc)) { t.skip("node_modules missing (tsc) — geometry not testable"); return; }
  const g = await geometry();
  assert.deepEqual(g.outSlots(0), []);
  assert.deepEqual(g.outSlots(1), [0.5], "a single output belongs in the middle");
  // Two outputs (yes/no, per element/done, approval/findings) sit clearly apart, but still
  // with room to the card corners.
  const two = g.outSlots(2);
  assert.equal(two.length, 2);
  assert.ok(two[0] > 0.25 && two[0] < 0.4, `upper output at ${two[0]}`);
  assert.ok(two[1] > 0.6 && two[1] < 0.75, `lower output at ${two[1]}`);
  for (let n = 1; n <= 12; n++) {
    const s = g.outSlots(n);
    assert.equal(s.length, n);
    for (let k = 1; k < n; k++) assert.ok(s[k] > s[k - 1] + 0.01, `outSlots(${n}) not strictly ascending: ${s}`);
    for (let k = 0; k < n; k++) {
      assert.ok(s[k] > 0 && s[k] < 1, "every height lies on the flank");
      // With many outputs nothing slips into the rounded corner.
      assert.ok(s[k] >= 0.15 - 1e-9 && s[k] <= 0.85 + 1e-9, `outSlots(${n})[${k}] = ${s[k]} too close to the edge`);
      assert.ok(near(s[k] + s[n - 1 - k], 1, 1e-9), `outSlots(${n}) not symmetric about the middle`);
    }
  }
});

test("Staircase: step in the middle, straight at equal height, inset shortens only the end point — forward and backward", async (t) => {
  if (!fs.existsSync(tsc)) { t.skip("node_modules missing (tsc) — geometry not testable"); return; }
  const g = await geometry();
  const R = (x, y) => ({ x, y, w: g.NODE_W, h: g.NODE_H });
  const s = R(0, 0);
  const RL = { from: P("right"), to: P("left") };

  // Equal height: a straight line, no needless corners.
  const currently = g.route(s, RL.from, R(600, 0), RL.to);
  assert.equal(currently.length, 2, `a straight connection has two points, not ${currently.length}`);
  checkEdge(g, currently, s, RL.from, R(600, 0), RL.to, 0, "currently");

  // Offset: out, vertical in the MIDDLE of the gap, in — both stubs equally long.
  const d = R(600, 200);
  const staircase = g.route(s, RL.from, d, RL.to);
  assert.equal(staircase.length, 4);
  checkEdge(g, staircase, s, RL.from, d, RL.to, 0, "staircase");
  const midX = (g.NODE_W + 600) / 2;
  assert.ok(near(staircase[1].x, midX) && near(staircase[2].x, midX), "the step lies in the middle of the gap");

  // Target higher than source: same shape, just upward.
  checkEdge(g, g.route(R(0, 300), RL.from, R(500, 0), RL.to), R(0, 300), RL.from, R(500, 0), RL.to, 0, "upward");

  // Small start node → normal node, with slots other than the middle.
  const start = { x: 0, y: 10, w: 120, h: 56 };
  const target = R(400, 0);
  checkEdge(g, g.route(start, P("right", 0.5), target, P("left", 0.35)), start, P("right", 0.5), target, P("left", 0.35), 0, "start → step");

  // Backward the same staircase, mirrored: out left, in right — the step again in the middle.
  const LR = { from: P("left"), to: P("right") };
  const back = g.route(R(600, 200), LR.from, s, LR.to);
  assert.equal(back.length, 4);
  checkEdge(g, back, R(600, 200), LR.from, s, LR.to, 0, "staircase backward");
  assert.ok(near(back[1].x, midX) && near(back[2].x, midX), "the step of the return staircase lies in the middle");
  assert.deepEqual(g.route(R(600, 0), LR.from, s, LR.to), [{ x: 600, y: 42 }, { x: g.NODE_W, y: 42 }], "backward at equal height: straight");

  // inset: ONLY the last point moves back (left at the left input, right at the right input),
  // everything else stays exactly the same — otherwise the step would shift as soon as the editor
  // puts the arrowhead on the point.
  for (const [q, fromP, targetR, toP, without] of [[s, RL.from, R(600, 0), RL.to, currently], [s, RL.from, d, RL.to, staircase], [R(600, 200), LR.from, s, LR.to, back]]) {
    const including = g.route(q, fromP, targetR, toP, 8);
    assert.equal(including.length, without.length);
    assert.deepEqual(including.slice(0, -1), without.slice(0, -1), "inset may only change the end point");
    const nx = toP.side === "right" ? 1 : -1;
    assert.deepEqual(including[including.length - 1], { x: without[without.length - 1].x + 8 * nx, y: without[without.length - 1].y });
    checkEdge(g, including, q, fromP, targetR, toP, 8, "with inset");
  }

  // Tight: from STAIR_MIN of room between the flanks the staircase applies (stubs half each) — this is
  // a vertical connection with 15 px of air, no detour around one of the cards. One pixel less and the edge runs around.
  const tight = R(g.NODE_W + g.STAIR_MIN, 200);
  const kt = g.route(s, RL.from, tight, RL.to);
  assert.equal(kt.length, 4, "at STAIR_MIN room a staircase");
  checkEdge(g, kt, s, RL.from, tight, RL.to, 0, "tight");
  const narrow = R(g.NODE_W + g.STAIR_MIN - 1, 200);
  assert.ok(g.route(s, RL.from, narrow, RL.to).length >= 5, "below STAIR_MIN the edge runs around");
});

test("Bracket: same flank, cards one above the other — one pillar outside past both", async (t) => {
  if (!fs.existsSync(tsc)) { t.skip("node_modules missing (tsc) — geometry not testable"); return; }
  const g = await geometry();
  const R = (x, y) => ({ x, y, w: g.NODE_W, h: g.NODE_H });
  const cases = [
    ["same column downward, right", R(700, 100), R(700, 465), "right"],
    ["same column upward, left", R(700, 400), R(700, 100), "left"],
    ["offset downward, target narrower on the right", R(700, 100), R(600, 465), "right"],
    ["offset downward, target protrudes on the right", R(700, 100), R(760, 465), "right"],
    ["compact end below the step", R(700, 100), { x: 740, y: 320, w: 160, h: 44 }, "right"],
    ["upward, target protrudes on the left", R(700, 400), R(640, 100), "left"],
  ];
  for (const [name, s, d, side] of cases) {
    for (const inset of [0, 5]) {
      const pts = g.route(s, P(side), d, P(side, 0.33), inset);
      checkEdge(g, pts, s, P(side), d, P(side, 0.33), inset, `${name} (inset ${inset})`);
      assert.equal(pts.length, 4, `${name}: a bracket has four points, not ${pts.length}`);
      // The pillar stands PORT_STUB outside the card that protrudes further — and thus outside both.
      const column = pts[1].x;
      assert.ok(near(column, pts[2].x), `${name}: pillar not vertical`);
      const outside = side === "right" ? Math.max(s.x + s.w, d.x + d.w) + g.PORT_STUB : Math.min(s.x, d.x) - g.PORT_STUB;
      assert.ok(near(column, outside), `${name}: pillar at ${column}, expected ${outside}`);
    }
  }
  // If the cards overlap vertically it does NOT go as a bracket (the horizontal would run through the other
  // card) but as a detour below both — node-free.
  const s = R(700, 100);
  const d = R(460, 120);
  const pts = g.route(s, P("right"), d, P("right"));
  checkEdge(g, pts, s, P("right"), d, P("right"), 0, "tight neighbor on the left, lower");
  assert.ok(pts.length >= 5, "vertically overlapping: detour instead of bracket");
});

test("Detour: offset overlapping cards — out, into the gap or below both, in, node-free", async (t) => {
  if (!fs.existsSync(tsc)) { t.skip("node_modules missing (tsc) — geometry not testable"); return; }
  const g = await geometry();
  const R = (x, y) => ({ x, y, w: g.NODE_W, h: g.NODE_H });
  // Opposite flanks, but the target lies BEHIND the output: only the detour remains.
  const cases = [
    ["target below, protruding to the right (in left)", R(700, 100), R(850, 465), P("right"), P("left")],
    ["target above, protruding to the left (in right)", R(700, 400), R(550, 50), P("left"), P("right")],
    ["target just below (gap narrower than 2·ROUTE_GAP)", R(700, 100), R(850, 100 + g.NODE_H + 30), P("right"), P("left")],
    ["target far left, vertically overlapping, in left (forced)", R(700, 100), R(200, 140), P("right"), P("left")],
    ["compact end left below the step, in left (forced)", R(700, 100), { x: 300, y: 320, w: 120, h: 56 }, P("right"), P("left")],
  ];
  for (const [name, s, d, from, to] of cases) {
    for (const inset of [0, 8]) {
      const pts = g.route(s, from, d, to, inset);
      checkEdge(g, pts, s, from, d, to, inset, `${name} (inset ${inset})`);
      assert.ok(pts.length >= 5, `${name}: ${pts.length} points are too few for a detour`);
      // The horizontal run keeps ROUTE_GAP distance from both cards — unless the gap between them
      // is narrower: then it lies in the gap (going below both, the pillar would run through the target).
      const way = pts.find((p, i) => i > 0 && i < pts.length - 1 && near(p.y, pts[i + 1]?.y) && !near(p.y, pts[0].y));
      assert.ok(way, `${name}: no horizontal run found`);
      const gap2 = Math.max(d.y - (s.y + s.h), s.y - (d.y + d.h));
      for (const r of [s, d]) {
        const gap = way.y >= r.y + r.h ? way.y - (r.y + r.h) : r.y - way.y;
        const desired = gap2 >= 2 * g.ROUTE_GAP ? g.ROUTE_GAP : gap2 > 0 ? gap2 / 4 : g.ROUTE_GAP;
        assert.ok(gap >= desired - 1e-6, `${name}: run only ${gap} px from a card (gap ${gap2})`);
      }
    }
  }
  // Gap between the rows: the run lies IN the gap (not below both), even a narrow one. If the cards
  // overlap vertically, it goes along below both — title and toolbar sit above.
  const inGap = g.route(R(700, 100), P("right"), R(850, 465), P("left"));
  assert.ok(inGap[2].y > 100 + g.NODE_H && inGap[2].y < 465, "run in the gap between the rows");
  const narrow = g.route(R(700, 100), P("right"), R(850, 214), P("left"));
  assert.ok(narrow[2].y > 184 && narrow[2].y < 214, `run in the narrow gap, not at ${narrow[2].y}`);
  const bottom = g.route(R(700, 100), P("right"), R(200, 140), P("left"));
  assert.ok(near(bottom[2].y, 140 + g.NODE_H + g.ROUTE_GAP), "with overlap, along below both");
  // Counter-test for the pillar rule: the tight neighbor on the left (8 px of air, lower) — without the dodge
  // the pillar into the input would run through the source.
  const tight = g.route(R(700, 100), P("right"), R(460, 120), P("right"));
  assert.equal(touchedInner(tight, R(700, 100)), false);
  assert.ok(tight.some((p) => near(p.x, 700)), "the pillar moves onto the facing edge of the source");
});

test("Screenshot layout: “no” placed on the right dock of phase 4, the back jump dragged from the left — and the cycle is marked", async (t) => {
  if (!fs.existsSync(tsc)) { t.skip("node_modules missing (tsc) — geometry not testable"); return; }
  const g = await geometry();
  const N = (id, x, y, branches = [null]) => ({ id, rect: { x, y, w: g.NODE_W, h: g.NODE_H }, branches, fixed: branches.length > 1 });
  // The layout from the screenshot (scaled to desktop size): phase 3 top left, the condition
  // to its right, phase 4 below — with 15 px of air between phase 3's right and phase 4's left.
  const nodes = [N("before", -300, 150), N("p3", 333, 155), N("cond", 810, 145, ["true", "false"]), N("p4", 580, 845), N("further", 1300, 140)];
  const edges = [
    { from: "before", to: "p3", branch: null },
    { from: "p3", to: "cond", branch: null },
    { from: "cond", to: "further", branch: "true" },
    { from: "cond", to: "p4", branch: "false", toSide: "right" },                    // dropped on the right dock
    { from: "p4", to: "p3", branch: null, fromSide: "left", toSide: "right" },      // dragged from the left, dropped on the right
  ];
  const { w, ways } = wire(g, nodes, edges, 5);
  const byId = new Map(nodes.map((n) => [n.id, n.rect]));
  ways.forEach((k, i) => checkEdge(g, k.pts, byId.get(edges[i].from), k.from, byId.get(edges[i].to), k.to, 5, `${edges[i].from}→${edges[i].to}`));
  // "No": right out of the condition, right into phase 4 — as a bracket (four points).
  assert.equal(ways[3].from.side, "right");
  assert.equal(ways[3].to.side, "right", "“no” arrives at the right dock of phase 4");
  assert.equal(ways[3].pts.length, 4, "“no” is a bracket");
  // Back jump: LEFT out of phase 4, into the right dock of phase 3 — a vertical connection in
  // the 15 px gap, no detour around one of the cards.
  assert.equal(ways[4].from.side, "left", "the back jump leaves phase 4 on the left");
  assert.equal(ways[4].to.side, "right", "the back jump arrives at the right dock of phase 3");
  assert.equal(ways[4].pts.length, 4);
  assert.ok(ways[4].pts[1].x > 565 && ways[4].pts[1].x < 580, `pillar in the gap, not at ${ways[4].pts[1].x}`);
  // No edge crosses a THIRD card.
  for (const [i, k] of ways.entries()) for (const [id, r] of byId) assert.equal(touchedInner(k.pts, r), false, `${edges[i].from}→${edges[i].to} crosses ${id}`);
  // Phase 4: both docks occupied (input on the right, output on the left); phase 3 likewise (feed on the
  // left, output AND back jump on the right — one dock, one point).
  assert.deepEqual(w.docks.get("p4"), { left: true, right: true });
  assert.deepEqual(w.docks.get("p3"), { left: true, right: true });
  assert.deepEqual(ways[1].from, ways[4].to, "output of phase 3 and input of the back jump are the SAME dock");
  // The condition: input left, yes above no on the right.
  assert.equal(ways[1].to.side, "left");
  assert.ok(w.ports.get("cond").get("true").slot < w.ports.get("cond").get("false").slot);
  // The delete button of each edge lies on ITS line.
  for (const k of ways) assert.ok(gapToPolyline(k.pts, g.pointAlong(k.pts, 0.5)) < 1e-6, "button must lie on the edge");
  // The cycle: phase 3 → condition → no → phase 4 → phase 3. The feed and "yes" do not belong to it.
  assert.deepEqual([...g.cycleEdges(edges)].sort(), [1, 3, 4]);
});

test("Without a gesture the convention applies: the same graph runs out right and in left — the back edges around the outside", async (t) => {
  if (!fs.existsSync(tsc)) { t.skip("node_modules missing (tsc) — geometry not testable"); return; }
  const g = await geometry();
  const N = (id, x, y, branches = [null]) => ({ id, rect: { x, y, w: g.NODE_W, h: g.NODE_H }, branches, fixed: branches.length > 1 });
  const nodes = [N("p3", 333, 155), N("cond", 810, 145, ["true", "false"]), N("p4", 580, 845)];
  const edges = [
    { from: "p3", to: "cond", branch: null },
    { from: "cond", to: "p4", branch: "false" },
    { from: "p4", to: "p3", branch: null },
  ];
  const { ways } = wire(g, nodes, edges, 5);
  const byId = new Map(nodes.map((n) => [n.id, n.rect]));
  ways.forEach((k, i) => checkEdge(g, k.pts, byId.get(edges[i].from), k.from, byId.get(edges[i].to), k.to, 5, `${edges[i].from}→${edges[i].to}`));
  assert.deepEqual([ways[1].from.side, ways[1].to.side], ["right", "left"], "“no” arrives on the left — the user dragged nothing else");
  assert.deepEqual([ways[2].from.side, ways[2].to.side], ["right", "left"]);
  assert.ok(ways[1].pts.length >= 5 && ways[2].pts.length >= 5, "both back edges run as a detour");
  for (const [i, k] of ways.entries()) for (const [id, r] of byId) assert.equal(touchedInner(k.pts, r), false, `${edges[i].from}→${edges[i].to} crosses ${id}`);
});

test("Wiring: a dock is ONE point — forward and back edge at the same dock, parallel edges at the same dock, foreign targets without ends", async (t) => {
  if (!fs.existsSync(tsc)) { t.skip("node_modules missing (tsc) — geometry not testable"); return; }
  const g = await geometry();
  const N = (id, x, y, branches = [null], fixed = false) => ({ id, rect: { x, y, w: g.NODE_W, h: g.NODE_H }, branches, fixed });
  // A and B in one row, A → B (convention) and B → A from B's left dock to A's right one: both edges run
  // over the SAME points, i.e. on the same stretch — the price of a dock being ONE point. Whoever does not
  // want that drags the back edge over other docks (and sees it run around the outside); the calculation
  // shifts nothing aside by itself.
  const { w, ways } = wire(g, [N("A", 0, 0), N("B", 500, 0)], [
    { from: "A", to: "B", branch: null }, { from: "B", to: "A", branch: null, fromSide: "left", toSide: "right" },
  ]);
  assert.equal(ways[0].pts.length, 2, "A → B straight");
  assert.equal(ways[1].pts.length, 2, "B → A straight back");
  assert.deepEqual(ways[1].from, ways[0].to, "B: input and output at the same (left) dock");
  assert.deepEqual(ways[1].to, ways[0].from, "A: output and input at the same (right) dock");
  assert.equal(shareTrack(ways[0].pts, ways[1].pts), true, "same stretch, there and back");
  assert.deepEqual(w.docks.get("A"), { left: false, right: true });
  assert.deepEqual(w.docks.get("B"), { left: true, right: false });
  // Over the other docks (right out of B, left into A) the back edge runs around the outside — below both.
  const outside = wire(g, [N("A", 0, 0), N("B", 500, 0)], [
    { from: "A", to: "B", branch: null }, { from: "B", to: "A", branch: null, fromSide: "right", toSide: "left" },
  ]);
  assert.ok(outside.ways[1].pts.length >= 5, "detour below both");
  assert.equal(shareTrack(outside.ways[0].pts, outside.ways[1].pts), false);

  // Without an edge nothing is occupied; `end` has no fixed outputs, a condition has two (yes above no).
  const empty = g.wire([N("s", 0, 0), N("e", 400, 0, []), N("c", 800, 0, ["true", "false"], true)], []);
  assert.deepEqual(empty.docks.get("s"), { left: false, right: false });
  assert.deepEqual(empty.docks.get("e"), { left: false, right: false });
  assert.equal(empty.ports.has("e"), false);
  assert.deepEqual([empty.ports.get("c").get("true").slot, empty.ports.get("c").get("false").slot], g.outSlots(2));

  // Parallel: several edges from ONE dock — all start at the same point.
  const par = wire(g, [N("p", 0, 0), N("x", 500, -200), N("y", 500, 200), N("z", -500, 0)], [
    { from: "p", to: "x", branch: null }, { from: "p", to: "y", branch: null }, { from: "p", to: "z", branch: null, fromSide: "left", toSide: "right" },
  ]);
  assert.deepEqual(par.ways[0].from, par.ways[1].from);
  assert.deepEqual(par.ways[2].from, { side: "left", slot: 0.5 });
  assert.deepEqual(par.w.docks.get("p"), { left: true, right: true });
  // An edge to an unknown node has no ends — it is not drawn but does not crash,
  // and it occupies no dock.
  const foreign = g.wire([N("p", 0, 0)], [{ from: "p", to: "nowhere", branch: null }]);
  assert.equal(foreign.edges.size, 0);
  assert.deepEqual(foreign.docks.get("p"), { left: false, right: false });
});

test("Fixed nodes (condition, loop, review): input one dock on the left, outputs on the right in branch order — the neighbors follow the gesture", async (t) => {
  if (!fs.existsSync(tsc)) { t.skip("node_modules missing (tsc) — geometry not testable"); return; }
  const g = await geometry();
  const N = (id, x, y, branches = [null], fixed = false) => ({ id, rect: { x, y, w: g.NODE_W, h: g.NODE_H }, branches, fixed });
  // A condition whose "no" leads back to a step on the LEFT (placed on its right dock),
  // and whose "yes" points up right; two feeds from the left.
  const nodes = [N("before", 100, 300), N("c", 900, 300, ["true", "false"], true), N("deep", 100, 600), N("top", 1400, 0)];
  const edges = [
    { from: "before", to: "c", branch: null },
    { from: "c", to: "top", branch: "true" },
    { from: "c", to: "before", branch: "false", toSide: "right" },
    { from: "deep", to: "c", branch: null, toSide: "right" },   // ignored on a fixed node
  ];
  const { w, ways } = wire(g, nodes, edges, 5);
  const byId = new Map(nodes.map((n) => [n.id, n.rect]));
  ways.forEach((k, i) => checkEdge(g, k.pts, byId.get(edges[i].from), k.from, byId.get(edges[i].to), k.to, 5, `${edges[i].from}→${edges[i].to}`));
  const yes = w.ports.get("c").get("true");
  const no = w.ports.get("c").get("false");
  assert.deepEqual([yes.side, no.side], ["right", "right"]);
  assert.ok(yes.slot < no.slot, "yes sits above no");
  assert.deepEqual([yes.slot, no.slot], g.outSlots(2), "the branches share the flank alone — no input in between");
  assert.deepEqual([yes.occupied, no.occupied], [true, true]);
  // Both feeds meet in the left dock — also the one that asks for "right".
  assert.deepEqual(ways[0].to, { side: "left", slot: 0.5 });
  assert.deepEqual(ways[3].to, { side: "left", slot: 0.5 });
  // "No" arrives at the RIGHT dock of "before" and therefore runs around below both cards.
  assert.equal(ways[2].to.side, "right");
  assert.ok(ways[2].pts.length >= 5, "“no” to the left: detour below both");
  for (const [i, k] of ways.entries()) for (const [id, r] of byId) assert.equal(touchedInner(k.pts, r), false, `${edges[i].from}→${edges[i].to} crosses ${id}`);
  // Loop: the body to its right; its back jump dragged from the left dock arrives on the LEFT of
  // the loop (fixed) — around below both, instead of on the right between "each" and "done".
  const loop = wire(g, [N("L", 0, 0, ["each", "done"], true), N("Body", 400, 0), N("Next", 400, 300)], [
    { from: "L", to: "Body", branch: "each" }, { from: "Body", to: "L", branch: null, fromSide: "left", toSide: "right" }, { from: "L", to: "Next", branch: "done" },
  ], 5);
  assert.deepEqual([loop.ways[1].from.side, loop.ways[1].to.side], ["left", "left"]);
  assert.ok(loop.ways[1].pts.length >= 5);
  assert.ok(loop.w.ports.get("L").get("each").slot < loop.w.ports.get("L").get("done").slot);
  for (const k of loop.ways) for (const r of [{ x: 0, y: 0, w: g.NODE_W, h: g.NODE_H }, { x: 400, y: 0, w: g.NODE_W, h: g.NODE_H }, { x: 400, y: 300, w: g.NODE_W, h: g.NODE_H }]) {
    assert.equal(touchedInner(k.pts, r), false, "no edge of the loop crosses a card");
  }
});

test("cycleEdges: only edges whose target leads back to the source", async (t) => {
  if (!fs.existsSync(tsc)) { t.skip("node_modules missing (tsc) — geometry not testable"); return; }
  const g = await geometry();
  const E = (from, to) => ({ from, to });
  assert.deepEqual([...g.cycleEdges([])], []);
  assert.deepEqual([...g.cycleEdges([E("a", "b"), E("b", "c")])], [], "a chain has no cycle");
  assert.deepEqual([...g.cycleEdges([E("a", "b"), E("b", "a")])].sort(), [0, 1]);
  // Two cycles sharing a node, plus feed and drain.
  const edges = [E("in", "a"), E("a", "b"), E("b", "a"), E("b", "c"), E("c", "b"), E("c", "out")];
  assert.deepEqual([...g.cycleEdges(edges)].sort(), [1, 2, 3, 4]);
  // An edge from a node to itself is a cycle.
  assert.deepEqual([...g.cycleEdges([E("a", "a")])], [0]);
});

test("Drag preview: angular, with stub, ends at the pointer — from both flanks", async (t) => {
  if (!fs.existsSync(tsc)) { t.skip("node_modules missing (tsc) — geometry not testable"); return; }
  const g = await geometry();
  const s = { x: 0, y: 0, w: g.NODE_W, h: g.NODE_H };
  const a = g.anchorAt(s, "right", 0.5);

  // Pointer to the right: the same staircase as a finished edge — otherwise the line jumps on release.
  const right = g.routeToPoint(s, P("right"), { x: 400, y: 200 });
  assert.ok(axisAligned(right));
  assert.deepEqual(right[0], { x: a.x, y: a.y });
  assert.deepEqual(right[right.length - 1], { x: 400, y: 200 });
  assert.ok(right[1].x > a.x, "first segment to the right");
  assert.ok(near(right[1].x, (a.x + 400) / 2), "step in the middle");

  // Pointer to the left/behind the stub: first PORT_STUB out, then vertical, then to the pointer.
  const left = g.routeToPoint(s, P("right"), { x: -100, y: 200 });
  assert.ok(axisAligned(left));
  assert.deepEqual(left[0], { x: a.x, y: a.y });
  assert.deepEqual(left[1], { x: a.x + g.PORT_STUB, y: a.y });
  assert.deepEqual(left[left.length - 1], { x: -100, y: 200 });

  // Pointer at the same height on the right: straight line, no zero segments (they twist the marker).
  const equal = g.routeToPoint(s, P("right"), { x: 400, y: a.y });
  assert.deepEqual(equal, [{ x: a.x, y: a.y }, { x: 400, y: a.y }]);

  // From the LEFT flank (an output whose edge goes left): mirrored.
  const al = g.anchorAt(s, "left", 0.5);
  const ofLeft = g.routeToPoint(s, P("left"), { x: -400, y: 200 });
  assert.ok(axisAligned(ofLeft));
  assert.deepEqual(ofLeft[0], { x: al.x, y: al.y });
  assert.ok(ofLeft[1].x < al.x, "first segment to the left");
  assert.ok(near(ofLeft[1].x, (al.x - 400) / 2), "step in the middle");
  const behindLeft = g.routeToPoint(s, P("left"), { x: 300, y: 200 });
  assert.deepEqual(behindLeft[1], { x: al.x - g.PORT_STUB, y: al.y });
  for (const pts of [right, left, equal, ofLeft, behindLeft]) {
    for (let i = 1; i < pts.length; i++) {
      assert.ok(Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y) > 1e-6, "no zero segment");
    }
  }
});

test("pathOf draws only corners (M/L), pointAlong follows the total length", async (t) => {
  if (!fs.existsSync(tsc)) { t.skip("node_modules missing (tsc) — geometry not testable"); return; }
  const g = await geometry();
  const pts = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }];
  const d = g.pathOf(pts);
  assert.match(d, /^M-?[\d.]+,-?[\d.]+( L-?[\d.]+,-?[\d.]+){2}$/, `unexpected path format: ${d}`);
  assert.doesNotMatch(d, /[CQSTA]/, "no curve commands — the edges are meant to be angular");
  assert.equal(d, "M0,0 L100,0 L100,100");
  // Third slots yield 1/3·84 = 28.000000000000004 — none of that should land in the DOM.
  assert.equal(g.pathOf([{ x: 1 / 3, y: 28.000000000000004 }, { x: 2, y: 3 }]), "M0.33,28 L2,3");

  // Fraction of the TOTAL LENGTH (200): 0.25 → 50 px on the first segment, 0.75 → 50 px on the second.
  assert.deepEqual(g.pointAlong(pts, 0), { x: 0, y: 0 });
  assert.deepEqual(g.pointAlong(pts, 0.25), { x: 50, y: 0 });
  assert.deepEqual(g.pointAlong(pts, 0.5), { x: 100, y: 0 });
  assert.deepEqual(g.pointAlong(pts, 0.75), { x: 100, y: 50 });
  assert.deepEqual(g.pointAlong(pts, 1), { x: 100, y: 100 });
  // Outside 0…1 the point stays at the ends instead of running past them.
  assert.deepEqual(g.pointAlong(pts, -1), { x: 0, y: 0 });
  assert.deepEqual(g.pointAlong(pts, 2), { x: 100, y: 100 });
  // Degenerate inputs do not crash.
  assert.deepEqual(g.pointAlong([{ x: 5, y: 6 }], 0.5), { x: 5, y: 6 });
  assert.deepEqual(g.pointAlong([], 0.5), { x: 0, y: 0 });

  // On a real detour: the middle lies on the line, the ends are the anchors. The chord
  // midpoint, by contrast, would float in free space — as with the old arc, whose delete button sat beside it.
  const R = (x, y) => ({ x, y, w: g.NODE_W, h: g.NODE_H });
  const s = R(700, 100);
  const dz = R(100, 100);
  const way = g.route(s, P("right"), dz, P("left"), 8);
  assert.ok(gapToPolyline(way, g.pointAlong(way, 0.5)) < 1e-6);
  assert.deepEqual(g.pointAlong(way, 0), way[0]);
  assert.deepEqual(g.pointAlong(way, 1), way[way.length - 1]);
  const chord = { x: (way[0].x + way[way.length - 1].x) / 2, y: (way[0].y + way[way.length - 1].y) / 2 };
  assert.ok(gapToPolyline(way, chord) > 9, "the counter-check would have to lie beside it — otherwise the test checks nothing");
});
