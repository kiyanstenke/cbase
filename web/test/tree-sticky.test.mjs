// Sticky scroll in the tree as in VS Code: lib/tree-sticky.ts, EXECUTED against the rules of VS Code's `StickyScrollController`:
// nothing at the top; the expanded ancestors of the topmost visible row stick; a folder is pushed up as soon as its last
// descendant scrolls out below; a folder exactly in its slot does not stick; a collapsed row never sticks; at most 7
// (`workbench.tree.stickyScrollMaxItemCount`) and never over 40 % of the height; a click scrolls the folder to its slot in the
// stack. Every sabotage is a copy of the source with ONE changed spot; the assigned check must fail on it.
//
// Run:  node --test --test-reporter=tap web/test/tree-sticky.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");
const SOURCE = fs.readFileSync(path.join(webDir, "src", "lib", "tree-sticky.ts"), "utf8");

const SABOTAGES = {
  "eight instead of seven": { old: "export const STICKY_MAX = 7;", fresh: "export const STICKY_MAX = 8;", catches: "cap" },
  "no 40 %": { old: " || out[i].top + h > view * STICKY_SHARE", fresh: "", catches: "cap" },
  "never pushed up": { old: "return { index: i, top: Math.min(stack, bottomEdgeLast - h) };", fresh: "return { index: i, top: stack };", catches: "shift" },
  "last descendant with siblings": { old: "while (j + 1 < n && rows[j + 1].depth > rows[i].depth) j++;", fresh: "while (j + 1 < n && rows[j + 1].depth >= rows[i].depth) j++;", catches: "shift" },
  "sticks in its slot": { old: "if (Math.abs(i * h - scrollTop - stack) < 0.5) return null;", fresh: "", catches: "slot" },
  "slot only exact": { old: "if (Math.abs(i * h - scrollTop - stack) < 0.5) return null;", fresh: "if (i * h - scrollTop === stack) return null;", catches: "broken" },
  "collapsed sticks": { old: "if (!rows[i].open) return null;", fresh: "", catches: "reason" },
  "click scrolls to the edge": { old: "Math.max(0, index * h - slot * h)", fresh: "Math.max(0, index * h)", catches: "click" },
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-tree-sticky-"));
const src = path.join(tmp, "src"), out = path.join(tmp, "out");
fs.mkdirSync(src, { recursive: true });
fs.writeFileSync(path.join(src, "tree-sticky.ts"), SOURCE);
const copies = Object.entries(SABOTAGES).map(([name, s], i) => {
  const file = `tree-sticky-sabotage-${i}.ts`;
  fs.writeFileSync(path.join(src, file), SOURCE.replace(s.old, s.fresh));
  return { name, file, catches: s.catches, places: SOURCE.split(s.old).length - 1 };
});
execFileSync(process.execPath, [tsc, ...fs.readdirSync(src).map((f) => path.join(src, f)), "--outDir", out, "--module", "es2022", "--target", "es2022", "--strict", "--skipLibCheck"], { stdio: "pipe" });
const load = (file) => import(pathToFileURL(path.join(out, file.replace(/\.ts$/, ".js"))).href);

const H = 22;
const d = (depth) => ({ depth, open: true }), f = (depth) => ({ depth, open: false });
// 0 a/ · 1 a/b/ · 2–4 a/b/{1,2,3} · 5 a/c · 6 d/ · 7–29 d/…
const TREE = [d(0), d(1), f(2), f(2), f(2), f(1), d(0), ...Array.from({ length: 23 }, () => f(1))];
// ten nested folders with twenty files below
const CHAIN = [...Array.from({ length: 10 }, (_, i) => d(i)), ...Array.from({ length: 20 }, () => f(10))];

const CHECKS = {
  reason: (m) => {
    assert.deepEqual(m.stickyNode(TREE, 0, H, 400), [], "at the very top nothing sticks");
    assert.deepEqual(m.stickyNode(TREE, 49, H, 400), [{ index: 0, top: 0 }, { index: 1, top: 22 }], "the ancestors of the topmost visible row");
    assert.deepEqual(m.stickyNode(TREE, 98, H, 400), [{ index: 0, top: 0 }], "a/c is below the stack: a/b is no longer its ancestor");
  },
  shift: (m) => {
    assert.deepEqual(m.stickyNode(TREE, 76, H, 400), [{ index: 0, top: 0 }, { index: 1, top: 12 }], "a/b moves up as soon as its last descendant scrolls out below");
  },
  slot: (m) => {
    assert.deepEqual(m.stickyNode(TREE, 132, H, 400), [], "d/ is exactly in its slot: it does not stick");
    assert.deepEqual(m.stickyNode(TREE, 133, H, 400), [{ index: 6, top: 0 }]);
  },
  cap: (m) => {
    assert.equal(m.STICKY_MAX, 7, "VS Code workbench.tree.stickyScrollMaxItemCount");
    const seven = m.stickyNode(CHAIN, 12 * H, H, 10000);
    assert.deepEqual(seven.map((k) => k.index), [0, 1, 2, 3, 4, 5, 6], "at most seven");
    assert.deepEqual(seven.map((k) => k.top), [0, 22, 44, 66, 88, 110, 132]);
    assert.equal(m.stickyNode(CHAIN, 12 * H, H, 200).length, 3, "never over 40 % of the height (VS Code maxWidgetViewRatio)");
  },
  // The row height is fractional (22 px x text size "Small" = 20.58). With the real height the right folder sticks from row ~50;
  // with the rounded one (21) the calculation would be one row off, and "in its slot" also holds for fractional positions.
  broken: (m) => {
    const h = 20.58;
    // 0 a/ ... 60 files in a ... 61 b/ ... 100 files in b
    const Z = [d(0), ...Array.from({ length: 60 }, () => f(1)), d(0), ...Array.from({ length: 100 }, () => f(1))];
    const top = 61 * h + 3; // b/ has just scrolled out at the top
    assert.deepEqual(m.stickyNode(Z, top, h, 400).map((k) => k.index), [61], "with the real height: b/ sticks");
    assert.deepEqual(m.stickyNode(Z, top, 21, 400).map((k) => k.index), [0], "with the rounded one: still a/, one row off (the bug)");
    assert.deepEqual(m.stickyNode(Z, 61 * h + 0.3, h, 400), [], "b/ is in its slot (0.3 px rounding of the scroll position): it does not stick");
  },
  click: (m) => {
    assert.equal(m.stickyTarget(5, 2, H), 66, "the folder is afterwards in its slot in the stack");
    assert.equal(m.stickyTarget(1, 3, H), 0);
  },
};

test("Sticky scroll in the tree: sticking ancestors, pushing up, in its slot, cap, click", async () => {
  const m = await load("tree-sticky.ts");
  for (const check of Object.values(CHECKS)) check(m);
});

test("Sticky scroll in the tree: every sabotage fails at its check", async (t) => {
  for (const k of copies) {
    assert.equal(k.places, 1, `sabotage "${k.name}" is stale: the spot occurs ${k.places}x in the source`);
    const m = await load(k.file);
    assert.throws(() => CHECKS[k.catches](m), `sabotage "${k.name}" went unnoticed by "${k.catches}"`);
  }
  t.diagnostic(`${copies.length} sabotages caught`);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
