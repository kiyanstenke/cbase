// The grid of the editor groups as in VS Code 1.143: lib/editor-raster.ts, EXECUTED —
//   - the tree (order of the groups as GRID_APPEARANCE, locations),
//   - insertion as Grid.addView with `splitSizing: auto` (the root turns with ONE group, evenly distributed stays even, otherwise the new
//     one gets half of the source and the children give up the overhang from the back — pulled along in pixels; across wraps a new branch
//     with the size of the sheet),
//   - removal as Grid.removeView (the size goes to the neighbour before, the last child takes the place of its branch, the root promotes),
//   - moving as Grid.moveView, neighbours per direction as getNeighborViews (real overlap, wrap-around at the edge),
//   - pixels as SplitView (rounded, minimum sizes 220 × 70, the rest from the back), separators, dragging as SplitView.resize incl. 2×2 coupling,
//     "increase width" as GridView.resizeView,
//   - aligning as SplitView `saveProportions` (what a minimum size forced becomes the share — otherwise the grid jumps when a group closes),
//   - the eight VS Code layouts, flipping, equalising (all / one branch),
//   - remembering: unreadable is null, never "empty" (also shares that only break when computing); a branch with a single child steps back,
//     even if that child is a branch.
// Each sabotage is a copy of the source with ONE changed spot (the spot occurs exactly once, otherwise the sabotage is stale); the assigned
// check must fail on it.
//
// Run:  node --test --test-reporter=tap web/test/editor-raster.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const SOURCE = fs.readFileSync(path.join(webDir, "src", "lib", "editor-raster.ts"), "utf8");
// lib/editor-raster.ts has no imports — every version (the sabotaged ones too) is transpiled and loaded afresh.
const ts = createRequire(import.meta.url)(path.join(webDir, "node_modules", "typescript"));
const load = (source) => {
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const m = { exports: {} };
  new Function("exports", "module", js)(m.exports, m);
  return m.exports;
};

// ── Shorthand: B = sheet, Z = branch, W = grid ──
const B = (id, share) => ({ kind: "sheet", id, share });
const Z = (share, ...children) => ({ kind: "branch", share, children });
const W = (situation, ...children) => ({ situation, root: Z(1, ...children) });
const NB = "sideBySide", UN = "mutually";
// Shares to six places (the computation divides by 3).
const round = (x) => JSON.parse(JSON.stringify(x, (_k, v) => (typeof v === "number" ? Math.round(v * 1e6) / 1e6 : v)));
const equal = (a, b, m) => assert.deepEqual(round(a), round(b), m);
const box = (R, r, id, w = 1000, h = 600) => R.layoutPx(r, w, h).boxes.get(id);
const widths = (R, r, ids, w = 1000) => ids.map((x) => box(R, r, x, w).w);
/** The tree only (without `backfill`). */
const tree = (r) => ({ situation: r.situation, root: r.root });

const CHECKS = {
  tree(R) {
    const r = W(NB, B("a", 0.5), Z(0.5, B("b", 0.5), Z(0.5, B("c", 0.5), B("d", 0.5))));
    assert.deepEqual(R.sheets(r), ["a", "b", "c", "d"], "the order of the grid is depth-first (GRID_APPEARANCE)");
    assert.deepEqual(R.locationOf(r, "c"), [1, 1, 0]);
    assert.equal(R.locationOf(r, "x"), null);
    assert.equal(R.nodeAt(r, [1, 1, 1]).id, "d");
    assert.equal(R.nodeAt(r, [0, 0]), null, "there is nothing below a sheet");
    assert.equal(R.orientationOfTheBranch(r, []), NB);
    assert.equal(R.orientationOfTheBranch(r, [1]), UN, "across at each level");
    assert.equal(R.orientationOfTheBranch(r, [1, 1]), NB);
    equal(R.individual("g1"), W(NB, B("g1", 1)), "one group: the root is a branch all the same");
    equal(R.queue(["a", "b"], UN, [1, 3]), W(UN, B("a", 0.25), B("b", 0.75)));
    equal(R.queue(["a", "b"], NB, [1, -1]), W(NB, B("a", 0.5), B("b", 0.5)), "unusable shares: equal");
  },
  insert(R) {
    // With ONE group the root turns into the direction (Grid.addView).
    equal(R.insertClipboard(R.individual("a"), "b", "a", "bottom"), W(UN, B("a", 0.5), B("b", 0.5)), "split one group at the bottom: the root is stacked");
    equal(R.insertClipboard(R.individual("a"), "b", "a", "left"), W(NB, B("b", 0.5), B("a", 0.5)), "left: before");
    // In the same situation: evenly distributed stays even (SplitView Sizing.Auto → Distribute).
    equal(R.insertClipboard(W(NB, B("a", 0.5), B("b", 0.5)), "c", "a", "right"), W(NB, B("a", 1 / 3), B("c", 1 / 3), B("b", 1 / 3)), "evenly distributed: all equal, the new one right of the source");
    equal(R.insertClipboard(W(NB, B("a", 0.5), B("b", 0.5)), "c", "b", "left"), W(NB, B("a", 1 / 3), B("c", 1 / 3), B("b", 1 / 3)), "left: before the source");
    // … not evenly distributed: the new one halves the source (Sizing.Split).
    const half = R.insertClipboard(W(NB, B("a", 0.7), B("b", 0.3)), "c", "a", "right");
    equal(tree(half), W(NB, B("a", 0.35), B("c", 0.35), B("b", 0.3)), "uneven: the source halved in shares");
    equal(half.backfill, { branch: [], fresh: 1, source: 0, prior: [0.7, 0.3] }, "… and the step remembered, for the pixels");
    assert.equal(R.insertClipboard(W(NB, B("a", 0.5), B("b", 0.5)), "c", "a", "right").backfill, undefined, "evenly distributed: nothing to pull along");
    // Across the situation: the sheet is wrapped into a branch (with ITS size), both half.
    equal(R.insertClipboard(W(NB, B("a", 0.7), B("b", 0.3)), "c", "a", "bottom"), W(NB, Z(0.7, B("a", 0.5), B("c", 0.5)), B("b", 0.3)), "across: a new branch in place of the sheet");
    equal(R.insertClipboard(W(NB, B("a", 0.5), B("b", 0.5)), "c", "b", "top"), W(NB, B("a", 0.5), Z(0.5, B("c", 0.5), B("b", 0.5))), "top: before it in the new branch");
    // In a nested branch of the same situation.
    equal(R.insertClipboard(W(NB, B("a", 0.5), Z(0.5, B("b", 0.5), B("c", 0.5))), "d", "c", "bottom"), W(NB, B("a", 0.5), Z(0.5, B("b", 1 / 3), B("c", 1 / 3), B("d", 1 / 3))), "bottom in a branch that is stacked");
    const r = W(NB, B("a", 0.5), B("b", 0.5));
    assert.equal(R.insertClipboard(r, "a", "b", "right"), r, "an id that is already there: same tree");
    assert.equal(R.insertClipboard(r, "c", "x", "right"), r, "an unknown source: same tree");
  },
  remove(R) {
    equal(R.remove(W(NB, B("a", 1 / 3), B("b", 1 / 3), B("c", 1 / 3)), "b"), W(NB, B("a", 0.5), B("c", 0.5)), "evenly distributed stays even");
    equal(R.remove(W(NB, B("a", 0.2), B("b", 0.5), B("c", 0.3)), "b"), W(NB, B("a", 0.7), B("c", 0.3)), "the size goes to the neighbour BEFORE");
    equal(R.remove(W(NB, B("a", 0.2), B("b", 0.5), B("c", 0.3)), "a"), W(NB, B("b", 0.7), B("c", 0.3)), "the first gives it to the second");
    // The last child takes the place of its branch; the sizes of the grandparent branch stay.
    equal(R.remove(W(NB, B("a", 0.4), Z(0.6, B("b", 0.5), B("c", 0.5))), "b"), W(NB, B("a", 0.4), B("c", 0.6)), "a sheet moves up with the size of its branch");
    equal(R.remove(W(NB, B("a", 0.4), Z(0.6, B("b", 0.5), Z(0.5, B("c", 0.25), B("d", 0.75)))), "b"),
      W(NB, B("a", 0.4), B("c", 0.15), B("d", 0.45)), "a branch hands its children (in its situation) to the grandparent branch, by its share");
    // The root: a sheet stays, a branch becomes the new root (across).
    equal(R.remove(W(NB, B("a", 0.5), Z(0.5, B("b", 0.5), B("c", 0.5))), "a"), W(UN, B("b", 0.5), B("c", 0.5)), "the branch becomes the root, its situation stays stacked");
    equal(R.remove(W(NB, B("a", 0.5), B("b", 0.5)), "a"), W(NB, B("b", 1)));
    const one = R.individual("a");
    assert.equal(R.remove(one, "a"), one, "the last group stays");
    assert.equal(R.remove(one, "x"), one);
  },
  move(R) {
    equal(R.move(W(NB, B("a", 0.2), B("b", 0.3), B("c", 0.5)), "a", "b", "right"), W(NB, B("b", 0.3), B("a", 0.2), B("c", 0.5)), "in the same branch: reordered, the size moves along");
    equal(R.move(W(NB, B("a", 0.2), B("b", 0.3), B("c", 0.5)), "c", "a", "left"), W(NB, B("c", 0.5), B("a", 0.2), B("b", 0.3)));
    const r = W(NB, B("a", 0.2), B("b", 0.3), B("c", 0.5));
    assert.equal(R.move(r, "a", "b", "left"), r, "already there: same tree");
    assert.equal(R.move(r, "a", "a", "right"), r);
    // Into another branch: remove, then insert.
    equal(R.move(W(NB, B("a", 0.5), B("b", 0.5)), "a", "b", "bottom"), W(UN, B("b", 0.5), B("a", 0.5)), "across: two columns become two rows (the root turns with ONE group)");
    equal(R.move(W(NB, B("a", 1 / 3), B("b", 1 / 3), B("c", 1 / 3)), "c", "a", "bottom"), W(NB, Z(0.5, B("a", 0.5), B("c", 0.5)), B("b", 0.5)));
  },
  neighbors(R) {
    const g4 = W(NB, Z(0.5, B("a", 0.5), B("b", 0.5)), Z(0.5, B("c", 0.5), B("d", 0.5)));
    assert.deepEqual(R.neighbors(g4, "a", "right"), ["c"]);
    assert.deepEqual(R.neighbors(g4, "a", "bottom"), ["b"]);
    assert.deepEqual(R.neighbors(g4, "d", "top"), ["c"]);
    assert.deepEqual(R.neighbors(g4, "a", "left"), [], "at the edge without wrap-around: none");
    assert.deepEqual(R.neighbors(g4, "a", "left", true), ["c"], "with wrap-around: from the other side (VS Code `wrap`)");
    assert.deepEqual(R.neighbors(g4, "a", "top", true), ["b"]);
    assert.deepEqual(R.neighbors(g4, "d", "right", true), ["b"]);
    assert.deepEqual(R.neighbors(g4, "d", "bottom", true), ["c"]);
    // Real overlap only — a corner is not adjacency.
    const staggered = W(NB, Z(0.5, B("a", 0.5), B("b", 0.5)), Z(0.5, B("c", 0.3), B("d", 0.7)));
    assert.deepEqual(R.neighbors(staggered, "b", "right"), ["d"]);
    assert.deepEqual(R.neighbors(staggered, "a", "right"), ["c", "d"], "both reach into the range of a");
    const spec = W(NB, Z(0.5, B("a", 0.5), B("b", 0.5)), Z(0.5, B("c", 0.5), B("d", 0.5)));
    assert.deepEqual(R.neighbors(R.pull(spec, [1], 0, 0, 600), "a", "right"), ["c"], "at the corner d touches a only in a point");
    assert.deepEqual(R.neighbors(W(NB, B("a", 0.5), Z(0.5, B("b", 0.5), B("c", 0.5))), "a", "right"), ["b", "c"], "in the order of the grid");
    assert.deepEqual(R.neighbors(g4, "x", "right"), []);
  },
  sizes(R) {
    assert.deepEqual(R.sizesPx([1 / 3, 1 / 3, 1 / 3], 1000, [220, 220, 220]), [333, 333, 334], "rounded, the rest from the back (distributeEmptySpace)");
    assert.deepEqual(R.sizesPx([0.1, 0.9], 1000, [220, 220]), [220, 780], "at least the minimum size");
    assert.deepEqual(R.sizesPx([0.5, 0.5], 300, [220, 220]), [220, 220], "too small: it overhangs (as VS Code)");
    assert.equal(R.minimumSize(B("a", 1), NB, NB), 220);
    assert.equal(R.minimumSize(B("a", 1), NB, UN), 70);
    assert.equal(R.minimumSize(Z(1, B("a", 0.5), B("b", 0.5)), UN, NB), 220, "across the situation: the largest");
    assert.equal(R.minimumSize(Z(1, B("a", 0.5), B("b", 0.5)), UN, UN), 140, "along the situation: the sum");
    const r = W(NB, B("a", 0.5), Z(0.5, B("b", 0.5), B("c", 0.5)));
    const l = R.layoutPx(r, 1000, 600);
    assert.deepEqual([...l.boxes], [["a", { x: 0, y: 0, w: 500, h: 600 }], ["b", { x: 500, y: 0, w: 500, h: 300 }], ["c", { x: 500, y: 300, w: 500, h: 300 }]]);
    assert.deepEqual(l.separator, [
      { branch: [], index: 0, situation: NB, x: 500, y: 0, length: 600, lengthBranch: 1000 },
      { branch: [1], index: 0, situation: UN, x: 500, y: 300, length: 500, lengthBranch: 600 },
    ], "the separators: vertical between the columns, horizontal in the right branch");
    assert.deepEqual(box(R, W(NB, B("a", 0.95), B("b", 0.05)), "b"), { x: 780, y: 0, w: 220, h: 600 }, "a too small share is drawn at the minimum width");
  },
  drag(R) {
    const two = W(NB, B("a", 0.5), B("b", 0.5));
    assert.equal(box(R, R.pull(two, [], 0, 100, 1000), "a").w, 600, "the line follows the pointer");
    const far = R.pull(two, [], 0, 400, 1000);
    assert.equal(box(R, far, "a").w, 780, "no further than the minimum size of the others (220)");
    assert.equal(box(R, far, "a", 2000).w, 1560, "the share at the limit is remembered, not the pull beyond it (the window grows afterwards)");
    assert.equal(box(R, R.pull(two, [], 0, -400, 1000), "a").w, 220);
    // Several behind it give way one after the other (SplitView.resize).
    const three = W(NB, B("a", 0.4), B("b", 0.3), B("c", 0.3));
    const d = R.pull(three, [], 0, 300, 1000);
    assert.deepEqual(["a", "b", "c"].map((x) => box(R, d, x).w), [560, 220, 220], "first the next one down to 220, then the one after");
    const back = R.pull(three, [], 1, -300, 1000);
    assert.deepEqual(["a", "b", "c"].map((x) => box(R, back, x).w), [220, 220, 560], "to the left: those before give way, away from the line");
    // 2×2 (GridView trySet2x2): the inner lines move together.
    const g4 = W(NB, Z(0.5, B("a", 0.5), B("b", 0.5)), Z(0.5, B("c", 0.5), B("d", 0.5)));
    assert.equal(R.is2x2(g4), true);
    const z4 = R.pull(g4, [0], 0, 100, 600);
    assert.deepEqual([box(R, z4, "a").h, box(R, z4, "c").h], [400, 400], "in the 2×2 grid the line of the other branch moves along");
    assert.equal(R.is2x2(W(NB, Z(0.5, B("a", 0.6), B("b", 0.4)), Z(0.5, B("c", 0.5), B("d", 0.5)))), false, "offset it is no coupled 2×2");
    const three2 = W(NB, Z(0.5, B("a", 0.5), B("b", 0.5)), B("c", 0.5));
    const z3 = R.pull(three2, [0], 0, 100, 600);
    assert.equal(box(R, z3, "c").h, 600, "without 2×2 only the own branch");
    assert.equal(R.pull(two, [], 1, 100, 1000), two, "a line that does not exist: same tree");
    assert.equal(R.pull(two, [], 0, Number.NaN, 1000), two);
  },
  change(R) {
    // "Increase width" (60 px): the own branch, the rest from the back (the child itself last).
    const three = W(NB, B("a", 0.3), B("b", 0.3), B("c", 0.4));
    const g = R.changeSize(three, "a", NB, 60, 1000, 600);
    assert.deepEqual(["a", "b", "c"].map((x) => box(R, g, x).w), [360, 300, 340], "the last one gives way (SplitView.resizeView)");
    // If the own branch lies across, the branch above changes the width of the whole branch (GridView.resizeView: grandparent branch first).
    const r = W(NB, B("a", 0.5), Z(0.5, B("b", 0.5), B("c", 0.5)));
    const b = R.changeSize(r, "b", NB, 60, 1000, 600);
    assert.deepEqual([box(R, b, "a").w, box(R, b, "b").w, box(R, b, "c").w], [440, 560, 560], "the column of b gets wider, a gives way");
    const small = R.changeSize(W(NB, B("a", 0.5), B("b", 0.5)), "a", NB, -400, 1000, 600);
    assert.equal(box(R, small, "a").w, 220, "never below the minimum size");
    assert.equal(R.changeSize(three, "x", NB, 60, 1000, 600), three);
  },
  align(R) {
    // a | (b / c d e) at 1000 × 600: the right column needs 3 × 220 = 660, a is drawn at 340 instead of 500 (SplitView: the rest from the back).
    const r = W(NB, B("a", 0.5), Z(0.5, B("b", 0.5), Z(0.5, B("c", 1 / 3), B("d", 1 / 3), B("e", 1 / 3))));
    assert.equal(box(R, r, "a").w, 340);
    const a = R.aligned(r, 1000, 600);
    equal(a.root.children.map((k) => k.share), [0.34, 0.66], "what is drawn becomes the share (saveProportions)");
    assert.equal(box(R, R.remove(a, "e"), "a").w, 340, "if a group closes afterwards, the grid does not jump");
    assert.equal(R.aligned(a, 1000, 600), a, "once aligned there is nothing left to do: same tree");
    const free = W(NB, B("a", 0.5), B("b", 0.5));
    assert.equal(R.aligned(free, 1000, 600), free, "no minimum size applies: same tree");
    assert.equal(R.aligned(r, 500, 600), r, "if the area does not suffice for the minimum sizes, it stays (otherwise it would hang on a too small window)");
    assert.equal(R.aligned(r, 0, 0), r, "unmeasured: same tree");
    // Deeper: x | (y / a b) — the row a b is as wide as its column (500), not as the area.
    const deep = W(NB, B("x", 0.5), Z(0.5, B("y", 0.5), Z(0.5, B("a", 0.9), B("b", 0.1))));
    const t = R.aligned(deep, 1000, 600);
    equal(t.root.children[1].children[1].children.map((k) => k.share), [0.56, 0.44], "a branch deep in the tree too, with the length of its box");
    equal(t.root.children.map((k) => k.share), [0.5, 0.5], "what does not jam stays");
    const up = R.aligned(W(UN, B("a", 0.95), B("b", 0.05)), 1000, 600);
    equal(up.root.children.map((k) => k.share), [530 / 600, 70 / 600], "stacked with the minimum height 70");
  },
  bringAlong(R) {
    // VS Code SplitView.addView with Sizing.Split, then relayout → resize: [a 700 | b 300] split to the left of a — the new one gets half
    // of the source (350), the children give up the overhang (350) from back to front: b down to 220, then a; the new one last. 350 / 430 / 220.
    const twoWay = W(NB, B("a", 0.7), B("b", 0.3));
    const left = R.insertClipboard(twoWay, "n", "a", "left");
    assert.deepEqual(widths(R, left, ["n", "a", "b"]), [350, 350, 300], "without pixels: the source halved");
    const l = R.aligned(left, 1000, 600);
    assert.deepEqual(widths(R, l, ["n", "a", "b"]), [350, 430, 220], "left: b gives way first, then a — as VS Code");
    assert.equal(l.backfill, undefined, "resolved: the backfill is dropped");
    assert.equal(R.aligned(l, 1000, 600), l, "afterwards there is nothing left to do");
    // To the right VS Code points `highPriorityIndexes` at the source: it gives up first — halved.
    assert.deepEqual(widths(R, R.aligned(R.insertClipboard(twoWay, "n", "a", "right"), 1000, 600), ["a", "n", "b"]), [350, 350, 300], "right: the source first");
    const three = R.aligned(R.insertClipboard(W(NB, B("x", 0.2), B("a", 0.5), B("b", 0.3)), "n", "a", "left"), 1200, 600);
    assert.deepEqual(widths(R, three, ["x", "n", "a", "b"], 1200), [240, 300, 440, 220], "first b down to 220, then a; x before and the new one stay");
    const deep = R.aligned(R.insertClipboard(W(UN, B("o", 0.5), Z(0.5, B("a", 0.7), B("b", 0.3))), "n", "a", "left"), 1000, 600);
    assert.deepEqual(widths(R, deep, ["n", "a", "b"]), [350, 430, 220], "in a branch deep in the tree too");
    // The new one started below its minimum size (200): it is clamped too, the last one gives the rest (distributeEmptySpace).
    const tight = R.aligned(R.insertClipboard(W(NB, B("a", 0.4), B("b", 0.6)), "n", "a", "left"), 1000, 600);
    equal(tight.root.children.map((c) => c.share), [0.22, 0.4, 0.38], "the new one never below 220, b gives the rest");
    const narrow = R.aligned(left, 600, 600);
    equal(narrow.root.children.map((c) => c.share), [0.35, 0.35, 0.3], "if the area does not suffice for the minimum sizes: it stays halved");
    assert.equal(narrow.backfill, undefined, "… and the backfill is dropped all the same");
    assert.equal(R.aligned(left, 0, 0), left, "unmeasured: the backfill waits");
    assert.equal(R.move(left, "b", "n", "left").backfill, undefined, "every further computation drops it");
  },
  layouts(R) {
    const L = (situation, groups) => ({ situation, groups });
    const ids = ["a", "b", "c", "d"];
    equal(R.byLayout(L(NB, [{}]), ids), W(NB, B("a", 1)), "single column");
    equal(R.byLayout(L(NB, [{}, {}, {}]), ids), W(NB, B("a", 1 / 3), B("b", 1 / 3), B("c", 1 / 3)), "three columns");
    equal(R.byLayout(L(UN, [{}, {}]), ids), W(UN, B("a", 0.5), B("b", 0.5)), "two rows");
    equal(R.byLayout(L(NB, [{ groups: [{}, {}] }, { groups: [{}, {}] }]), ids), W(NB, Z(0.5, B("a", 0.5), B("b", 0.5)), Z(0.5, B("c", 0.5), B("d", 0.5))), "2×2");
    equal(R.byLayout(L(UN, [{}, { groups: [{}, {}] }]), ids), W(UN, B("a", 0.5), Z(0.5, B("b", 0.5), B("c", 0.5))), "two columns at the bottom");
    equal(R.byLayout(L(NB, [{}, { groups: [{}, {}] }]), ids), W(NB, B("a", 0.5), Z(0.5, B("b", 0.5), B("c", 0.5))), "two rows on the right");
    equal(R.byLayout(L(NB, [{ groups: [{}] }, {}]), ids), W(NB, B("a", 0.5), B("b", 0.5)), "a group with ONE child is a sheet (createSerializedGrid)");
    assert.equal(R.groupsIn(L(NB, [{ groups: [{ groups: [{}, {}] }] }, {}])), 2, "counted by the same rule");
    assert.equal(R.groupsIn(L(NB, [{ groups: [{}, {}] }, { groups: [{}, {}] }])), 4);
    assert.equal(R.byLayout(L(NB, [{}, {}, {}]), ["a", "b"]), null, "too few groups: null");
    assert.equal(R.byLayout(L(NB, []), ids), null);
    // Flipping and equalising.
    const r = W(NB, B("a", 0.3), Z(0.7, B("b", 0.2), B("c", 0.8)));
    equal(R.flip(r), { situation: UN, root: r.root }, "the whole tree flips, the shares stay");
    equal(R.equalDistributed(r), W(NB, B("a", 0.5), Z(0.5, B("b", 0.5), B("c", 0.5))), "\"reset sizes\": every branch equal");
    equal(R.equallyDistributedAt(r, [1]), W(NB, B("a", 0.3), Z(0.7, B("b", 0.5), B("c", 0.5))), "double click: only the branch of the line");
    assert.equal(R.equallyDistributedAt(r, [0]), r, "a sheet is no branch");
  },
  remember(R) {
    const r = W(NB, B("a", 0.5), Z(0.5, B("b", 0.5), B("c", 0.5)));
    equal(R.rasterFrom(JSON.parse(JSON.stringify(r)), ["a", "b", "c"]), r, "the tree comes back");
    equal(R.rasterFrom(W(NB, B("a", 2), B("b", 6)), ["a", "b"]), W(NB, B("a", 0.25), B("b", 0.75)), "the shares per branch computed to 1");
    for (const [raw, ids, why] of [
      [null, ["a"], "nothing"], ["x", ["a"], "no object"], [{ situation: "slash", root: Z(1, B("a", 1)) }, ["a"], "foreign situation"],
      [W(NB, B("a", 1)), ["a", "b"], "a group is missing"], [W(NB, B("a", 0.5), B("x", 0.5)), ["a", "b"], "a foreign group instead of a missing one"],
      [W(NB, B("a", 0.5), B("a", 0.5)), ["a"], "a group twice"], [W(NB, B("a", 0), B("b", 1)), ["a", "b"], "a share of 0"],
      [W(NB, B("a", 1), Z(1)), ["a"], "an empty branch"], [{ situation: NB, root: B("a", 1) }, ["a"], "the root is a sheet"],
      [{ situation: NB, root: Z(0, B("a", 1)) }, ["a"], "the root with share 0 (no parent branch re-checks it)"],
    ]) assert.equal(R.rasterFrom(raw, ids), null, `unreadable is null, not empty: ${why}`);
    equal(R.rasterFrom(W(NB, Z(0.5, B("a", 1)), B("b", 0.5)), ["a", "b"]), W(NB, B("a", 0.5), B("b", 0.5)), "a branch with one child steps back");
    // If the only child is a branch, ITS children move up (they lie in the situation of the branch above), by the share of the branch.
    equal(R.rasterFrom(W(NB, B("x", 0.5), Z(0.5, Z(1, B("a", 0.5), B("b", 0.5)))), ["x", "a", "b"]), W(NB, B("x", 0.5), B("a", 0.25), B("b", 0.25)),
      "a branch whose only child is a branch: the grandchildren move up, by the share of the branch");
    // Two shares of 1e308 are finite each, their sum is not — computed they would be zeros.
    assert.equal(R.rasterFrom(W(NB, B("a", 1e308), B("b", 1e308)), ["a", "b"]), null, "shares that yield ∞ or 0 when computed: null");
    equal(R.rasterFrom(W(NB, Z(1, B("a", 0.5), B("b", 0.5))), ["a", "b"]), W(UN, B("a", 0.5), B("b", 0.5)), "the root with ONE branch: it becomes the root (across)");
  },
};

const SABOTAGES = {
  "sheets reversed": { old: "else for (const c of k.children) go(c); };", fresh: "else for (const c of [...k.children].reverse()) go(c); };", catches: "tree" },
  "root does not turn": { old: "if (sheets(k).length === 1 && k.situation !== orientationOfTheDirection(direction)) k.situation = orientationOfTheDirection(direction);", fresh: "", catches: "insert" },
  "evenly distributed gets halved": { old: "if (distributed(parent.children)) { parent.children.splice(i + (rear(direction) ? 1 : 0), 0, sheet); equal(parent.children); }", fresh: "if (false) { }", catches: "insert" },
  "source not halved": { old: "sheet.share = source.share / 2; source.share /= 2;", fresh: "sheet.share = source.share;", catches: "insert" },
  "left lands right": { old: "parent.children.splice(i + (rear(direction) ? 1 : 0), 0, sheet); equal(", fresh: "parent.children.splice(i + 1, 0, sheet); equal(", catches: "insert" },
  "wrapping loses the size": { old: "parent.children[i] = { kind: \"branch\", share: old.share, children: pair };", fresh: "parent.children[i] = { kind: \"branch\", share: 0.5, children: pair };", catches: "insert" },
  "size to the neighbour behind": { old: "const ref = parent.children[i === 0 ? 1 : i - 1];", fresh: "const ref = parent.children[i === parent.children.length - 1 ? i - 1 : i + 1];", catches: "remove" },
  "removal without equalising": { old: "if (distributed(parent.children)) { parent.children.splice(i, 1); equal(parent.children); }", fresh: "if (false) { }", catches: "remove" },
  "children without the share of the branch": { old: "...siblings.children.map((c) => ({ ...c, share: c.share * parent.share }))", fresh: "...siblings.children", catches: "remove" },
  "promoted root does not turn": { old: "return { situation: landscape(k.situation), root: { kind: \"branch\", share: 1, children: siblings.children } };", fresh: "return { situation: k.situation, root: { kind: \"branch\", share: 1, children: siblings.children } };", catches: "remove" },
  "reordering without index correction": { old: "z.children.splice(from < to ? to - 1 : to, 0, x);", fresh: "z.children.splice(dest, 0, x);", catches: "move" },
  "corner is a neighbour": { old: "o.from < g.until - EPS && g.from < o.until - EPS", fresh: "o.from <= g.until + EPS && g.from <= o.until + EPS", catches: "neighbors" },
  "no wrap-around upwards": { old: "if (direction === \"top\" && Math.abs(b.y) < EPS) g.situation = 1;", fresh: "if (false) g.situation = 1;", catches: "neighbors" },
  "no wrap-around to the right": { old: "else if (direction === \"right\" && Math.abs(b.x + b.w - 1) < EPS) g.situation = 0;", fresh: "", catches: "neighbors" },
  "pixels without minimum size": { old: "const g = shares.map((a, i) => Math.max(mins[i] ?? 0, Math.round(a * length)));", fresh: "const g = shares.map((a) => Math.round(a * length));", catches: "sizes" },
  "rest from the front": { old: "for (let i = g.length - 1; i >= 0 && rest !== 0; i--) {", fresh: "for (let i = 0; i < g.length && rest !== 0; i++) {", catches: "sizes" },
  "branch minimum summed across": { old: "return situation === axis ? m.reduce((x, y) => x + y, 0) : Math.max(...m);", fresh: "return m.reduce((x, y) => x + y, 0);", catches: "sizes" },
  "separator wrong": { old: "x: nb ? pos : b.x, y: nb ? b.y : pos,", fresh: "x: pos, y: pos,", catches: "sizes" },
  "dragging without limit": { old: "const delta = Math.min(maxDelta, Math.max(minDelta, distance));", fresh: "const delta = distance;", catches: "drag" },
  "only the neighbour gives way": { old: "for (let i = index + 1; i < g.length; i++) down.push(i);", fresh: "down.push(index + 1);", catches: "drag" },
  "2×2 not coupled": { old: "if (branch.length === 1 && is2x2(r)) withShares(branchAt(k, [1 - branch[0]]), g);", fresh: "", catches: "drag" },
  "2×2 also when offset": { old: "return Math.abs(a.children[0].share - b.children[0].share) < EPS;", fresh: "return true;", catches: "drag" },
  "width without the branch above": { old: "setKind(branchAt(k, largeLocation), largeSituation, parentLocation[parentLocation.length - 1], desired[largeSituation], lengthOf(largeLocation, largeSituation));", fresh: "", catches: "change" },
  "the child gives way first": { old: "followUp.push(index);", fresh: "followUp.unshift(index);", catches: "change" },
  "aligning without effect": { old: "if (matches && z.children.some((c, i) => Math.round(c.share * length) < mins[i])) withShares(", fresh: "if (false) withShares(", catches: "align" },
  "aligning even when it does not fit": { old: "const matches = mins.reduce((x, y) => x + y, 0) <= length;", fresh: "const matches = true;", catches: "align" },
  "aligning only at the root": { old: "z.children.forEach((c, i) => { if (c.kind === \"branch\") go(c, [...location, i], landscape(situation), nb ? g[i] : w, nb ? h : g[i]); });", fresh: "", catches: "align" },
  "aligning with the length of the area": { old: "landscape(situation), nb ? g[i] : w, nb ? h : g[i]); });", fresh: "landscape(situation), w, h); });", catches: "align" },
  "aligning never stops": { old: "Math.round(c.share * length) < mins[i])) withShares(", fresh: "Math.round(c.share * length) <= mins[i])) withShares(", catches: "align" },
  "single child as branch": { old: "const children = g.groups && g.groups.length > 1 ? g.groups : null;", fresh: "const children = g.groups && g.groups.length > 0 ? g.groups : null;", catches: "layouts" },
  "counted differently": { old: "n + (g.groups && g.groups.length > 1 ? groupsIn(g) : 1)", fresh: "n + (g.groups && g.groups.length ? groupsIn(g) : 1)", catches: "layouts" },
  "flipping does not flip": { old: "export const flip = (r: Raster): Raster => ({ situation: landscape(r.situation), root: r.root });", fresh: "export const flip = (r: Raster): Raster => ({ situation: r.situation, root: r.root });", catches: "layouts" },
  "equalising not recursive": { old: "const go = (z: MBranch) => { equal(z.children); for (const c of z.children) if (c.kind === \"branch\") go(c); };", fresh: "const go = (z: MBranch) => { equal(z.children); };", catches: "layouts" },
  "double click equalises everything": { old: "equal(branchAt(k, branch).children);", fresh: "equal(k.root.children); equal(branchAt(k, branch).children);", catches: "layouts" },
  "foreign group remembered": { old: "if (typeof k.id !== \"string\" || !ids.includes(k.id) || seen.has(k.id)) return null;", fresh: "if (typeof k.id !== \"string\" || seen.has(k.id)) return null;", catches: "remember" },
  "duplicate group remembered": { old: "|| seen.has(k.id)) return null;", fresh: ") return null;", catches: "remember" },
  "missing group remembered": { old: "if (!w || w.kind !== \"branch\" || seen.size !== ids.length) return null;", fresh: "if (!w || w.kind !== \"branch\") return null;", catches: "remember" },
  "share 0 remembered": { old: "!(k.share > 0) || ", fresh: "", catches: "remember" },
  "not normalised": { old: "for (const c of children) c.share /= s;", fresh: "", catches: "remember" },
  "single child stays a branch": { old: "if (c.children.length > 1) { fresh.push(c); continue; }", fresh: "{ fresh.push(c); continue; }", catches: "remember" },
  "grandchildren without the share of the branch": { old: "else fresh.push(...e.children.map((x) => ({ ...x, share: x.share * c.share })));", fresh: "else fresh.push(...e.children);", catches: "remember" },
  "shares unchecked after computing": { old: "if (!children.every((c) => c.share > 0 && Number.isFinite(c.share))) return null;", fresh: "", catches: "remember" },
  // Insertion in pixels
  "backfill not remembered": { old: "k.backfill = { branch: parentLocation, fresh: j, source: i, prior };", fresh: "", catches: "bringAlong" },
  "backfill not resolved": { old: "if (matches && nz && sameLocations(location, nz.branch)", fresh: "if (false && nz && sameLocations(location, nz.branch)", catches: "bringAlong" },
  "backfill even when it does not fit": { old: "if (matches && nz && sameLocations(location, nz.branch)", fresh: "if (nz && sameLocations(location, nz.branch)", catches: "bringAlong" },
  "backfill stays": { old: "let k: MRaster | null = nz ? clone(r) : null;", fresh: "let k: MRaster | null = nz ? (r as MRaster) : null;", catches: "bringAlong" },
  "the source does not give up first": { old: "if (nz.source !== nz.fresh) followUp.unshift(nz.source);", fresh: "", catches: "bringAlong" },
  "the new one gives up first": { old: "followUp.push(nz.fresh);", fresh: "followUp.unshift(nz.fresh);", catches: "bringAlong" },
  "overhang from the front": { old: "for (let i = g.length - 1; i >= 0; i--) if (i !== nz.source && i !== nz.fresh) followUp.push(i);", fresh: "for (let i = 0; i < g.length; i++) if (i !== nz.source && i !== nz.fresh) followUp.push(i);", catches: "bringAlong" },
  "overhang without minimum size": { old: "for (const x of followUp) { const n = Math.max(mins[x], g[x] + over);", fresh: "for (const x of followUp) { const n = g[x] + over;", catches: "bringAlong" },
  "backfill without equalising from the back": { old: "let empty = length - g.reduce((x, y) => x + y, 0);", fresh: "let empty = 0;", catches: "bringAlong" },
  "the new one gets the whole source": { old: "g.splice(nz.fresh, 0, before[nz.source] / 2);", fresh: "g.splice(nz.fresh, 0, before[nz.source]);", catches: "bringAlong" },
  "root with one branch stays": { old: "if (e && e.kind === \"branch\") return { situation: landscape(o.situation), root: { kind: \"branch\", share: 1, children: e.children } };", fresh: "", catches: "remember" },
};

const real = load(SOURCE);

test("grid: tree, insert, remove, move, neighbours, pixels, drag, width, align, backfill, layouts, remember — as VS Code", () => {
  for (const [k, check] of Object.entries(CHECKS)) {
    try { check(real); } catch (e) { throw new Error(`${k}: ${e.message}`); }
  }
});

test("grid: every sabotage occurs exactly once in the source and is caught by its check", () => {
  const stale = [], notCaught = [];
  for (const [name, s] of Object.entries(SABOTAGES)) {
    const n = SOURCE.split(s.old).length - 1;
    if (n !== 1) { stale.push(`${name} (${n}×)`); continue; }
    let caught = false;
    try { CHECKS[s.catches](load(SOURCE.replace(s.old, s.fresh))); } catch { caught = true; }
    if (!caught) notCaught.push(`${name} (${s.catches})`);
  }
  assert.deepEqual(stale, [], "sabotages whose spot does not occur exactly once in the source");
  assert.deepEqual(notCaught, [], "sabotages that no check catches");
  console.log(`  [editor-raster] ${Object.keys(SABOTAGES).length} sabotages on the computations, each caught`);
});

test("grid: the source carries the marks of its templates (lib/thirdParty.ts)", () => {
  for (const p of ["src/vs/base/browser/ui/grid/grid.ts", "src/vs/base/browser/ui/grid/gridview.ts", "src/vs/base/browser/ui/splitview/splitview.ts"]) {
    assert.ok(SOURCE.includes(`// Port of: microsoft/vscode ${p} (MIT)\n`), `the mark for ${p} is missing`);
  }
});
