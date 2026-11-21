// The sections of the explorer as in VS Code, lib/explorer-sections.ts, EXECUTED: the folder open, OUTLINE and TIMELINE collapsed (as
// VS Code starts); a collapsed section is only its header (22 px), the remembered sizes of the open ones ARE their content heights
// (if the sum does not fit the space: proportionally, VS Code SplitView `proportionalLayout`), at least 120 px each (VS Code
// `minimumBodySize`); a drag bar moves only two open ones (otherwise it is off), keeps the others and clamps at the minimum - and it
// FOLLOWS THE MOUSE: after `pull` by `way` it stands exactly `way` further in `sectionHeights`; the remembered state is validated (what
// is missing or does not fit is the default). Each sabotage is a copy of the source with ONE changed spot; the assigned check must
// fail on it.
//
// Run:  node --test --test-reporter=tap web/test/explorer-sections.test.mjs
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
const SOURCE = fs.readFileSync(path.join(webDir, "src", "lib", "explorer-sections.ts"), "utf8");

const SABOTAGES = {
  "all open by default": { old: "open: { files: true, layout: false, timeAxis: false },", fresh: "open: { files: true, layout: true, timeAxis: true },", catches: "preset" },
  "header 24 px": { old: "export const HEADER_HEIGHT = 22;", fresh: "export const HEADER_HEIGHT = 24;", catches: "heights" },
  "no minimum": { old: "const min = Math.min(MIN_CONTENT, Math.floor(rest / open.length));", fresh: "const min = 0;", catches: "heights" },
  "remainder gets lost": { old: "const h = i === open.length - 1 ? rest - allocated : ", fresh: "const h = ", catches: "heights" },
  "sizes as weights above the minimum (old behavior)": {
    old: "if (!tooSmall.length) { for (const id of free) content[id] = share(id); break; }",
    fresh: "if (true) { const f = rest - min * open.length, g = open.reduce((a, id) => a + Math.max(1, s.size[id]), 0); for (const id of open) content[id] = min + (f * Math.max(1, s.size[id])) / g; break; }",
    catches: "follows",
  },
  "minimum without redistribution": { old: "for (const id of tooSmall) { content[id] = min; slotFree -= min; }", fresh: "for (const id of tooSmall) { content[id] = min; }", catches: "heights" },
  "drag not rounded": { old: "content(top) + Math.round(distance)", fresh: "content(top) + distance", catches: "follows" },
  "collapsed has content": { old: "const out = { files: HEADER_HEIGHT, layout: HEADER_HEIGHT, timeAxis: HEADER_HEIGHT } as Record<SectionId, number>;", fresh: "const out = { files: 100, layout: 100, timeAxis: 100 } as Record<SectionId, number>;", catches: "heights" },
  "bar above a collapsed one": { old: "for (let k = i + 1; k < SECTIONS.length; k++) if (s.open[SECTIONS[k]]) { bottom = SECTIONS[k]; break; }", fresh: "bottom = SECTIONS[i + 1] ?? null;", catches: "paar" },
  "bar without pair moves": { old: "return top && bottom ? [top, bottom] : null;", fresh: "return [top ?? \"files\", bottom ?? \"timeAxis\"];", catches: "paar" },
  "drag without clamp": { old: "const newTop = Math.max(lowerLimit, Math.min(sum - lowerLimit, content(top) + Math.round(distance)));", fresh: "const newTop = content(top) + Math.round(distance);", catches: "drag" },
  "drag changes the sum": { old: "size[bottom] = sum - newTop;", fresh: "size[bottom] = content(bottom);", catches: "drag" },
  "ratio of the others jumps": { old: "for (const id of SECTIONS) if (s.open[id]) size[id] = content(id);", fresh: "", catches: "drag" },
  "toggling forgets the size": { old: "return { open: { ...s.open, [id]: !s.open[id] }, size: s.size };", fresh: "return { open: { ...s.open, [id]: !s.open[id] }, size: SECTIONS_DEFAULT.size };", catches: "toggle" },
  "remembered state unvalidated": { old: "size[id] = typeof g === \"number\" && Number.isFinite(g) && g > 0 ? g : SECTIONS_DEFAULT.size[id];", fresh: "size[id] = g as number;", catches: "remember" },
  "missing open/closed becomes closed": { old: "open[id] = typeof openRaw[id] === \"boolean\" ? (openRaw[id] as boolean) : SECTIONS_DEFAULT.open[id];", fresh: "open[id] = Boolean(openRaw[id]);", catches: "remember" },
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-explorer-sections-"));
const src = path.join(tmp, "src"), out = path.join(tmp, "out");
fs.mkdirSync(src, { recursive: true });
fs.writeFileSync(path.join(src, "explorer-sections.ts"), SOURCE);
const copies = Object.entries(SABOTAGES).map(([name, s], i) => {
  const file = `explorer-sections-sabotage-${i}.ts`;
  fs.writeFileSync(path.join(src, file), SOURCE.replace(s.old, s.fresh));
  return { name, file, catches: s.catches, places: SOURCE.split(s.old).length - 1 };
});
execFileSync(process.execPath, [tsc, ...fs.readdirSync(src).map((f) => path.join(src, f)), "--outDir", out, "--module", "es2022", "--target", "es2022", "--strict", "--skipLibCheck"], { stdio: "pipe" });
const load = (file) => import(pathToFileURL(path.join(out, file.replace(/\.ts$/, ".js"))).href);

const status = (open, size = { files: 400, layout: 200, timeAxis: 200 }) => ({ open, size });
const sum = (h) => h.files + h.layout + h.timeAxis;

const CHECKS = {
  preset: (m) => {
    assert.deepEqual(m.SECTIONS, ["files", "layout", "timeAxis"]);
    assert.deepEqual(m.SECTIONS_DEFAULT.open, { files: true, layout: false, timeAxis: false }, "VS Code starts with the folder open, outline and timeline collapsed");
  },
  heights: (m) => {
    assert.equal(m.HEADER_HEIGHT, 22, "the header of a section is 22 px (VS Code Pane.headerSize)");
    const onlyFolder = m.sectionHeights(m.SECTIONS_DEFAULT, 600);
    assert.deepEqual(onlyFolder, { files: 556, layout: 22, timeAxis: 22 }, "collapsed only the header, the rest to the open one");
    const all = m.sectionHeights(status({ files: true, layout: true, timeAxis: true }), 866);
    assert.equal(sum(all), 866, "the heights fill the space exactly");
    assert.ok(all.files > all.layout && all.layout === all.timeAxis, "in the ratio of the sizes (400:200:200)");
    const narrow = m.sectionHeights(status({ files: true, layout: true, timeAxis: false }, { files: 5000, layout: 1, timeAxis: 200 }), 400);
    assert.ok(narrow.layout - 22 >= 120, `an open section gets at least 120 px (was ${narrow.layout - 22})`);
    assert.equal(sum(narrow), 400);
    assert.equal(sum(m.sectionHeights(status({ files: true, layout: true, timeAxis: true }, { files: 1, layout: 1, timeAxis: 1 }), 166)), 166, "fractional shares: the remainder goes to the last one, nothing is missing");
    assert.deepEqual(m.sectionHeights(status({ files: false, layout: false, timeAxis: false }), 500), { files: 22, layout: 22, timeAxis: 22 }, "all collapsed: only the headers");
  },
  pair: (m) => {
    const s = status({ files: true, layout: false, timeAxis: true });
    assert.deepEqual(m.pullPair(s, 0), ["files", "timeAxis"], "across a collapsed one");
    assert.deepEqual(m.pullPair(s, 1), ["files", "timeAxis"]);
    assert.equal(m.pullPair(m.SECTIONS_DEFAULT, 0), null, "only one open: the bar moves nothing");
    assert.equal(m.pullPair(status({ files: false, layout: true, timeAxis: true }), 0), null, "none open above it");
  },
  // Dragging and recomputing: the bar stands exactly `way` further (like VS Code SplitView), at any space and any state.
  follows: (m) => {
    const positions = [
      [status({ files: true, layout: true, timeAxis: false }), 566, 0],
      [status({ files: true, layout: true, timeAxis: true }), 866, 0],
      [status({ files: true, layout: true, timeAxis: true }), 866, 1],
      [status({ files: true, layout: false, timeAxis: true }, { files: 5000, layout: 1, timeAxis: 30 }), 700, 1],
      [status({ files: true, layout: true, timeAxis: true }, { files: 123, layout: 77, timeAxis: 300 }), 1000, 0],
    ];
    for (const [s, slot, i] of positions) {
      const prior = m.sectionHeights(s, slot);
      const [top, bottom] = m.pullPair(s, i);
      for (const distance of [10, 50, 100, -10, -37, 3.4]) {
        const after = m.sectionHeights(m.pull(s, prior, i, distance), slot);
        const desired = Math.max(120 - (prior[top] - 22), Math.min((prior[bottom] - 22) - 120, Math.round(distance)));
        assert.equal(after[top] - prior[top], desired, `space ${slot}, bar ${i}, drag ${distance}: the bar moved ${after[top] - prior[top]} instead of ${desired}`);
        assert.equal(after[bottom] - prior[bottom] + desired, 0, `space ${slot}, drag ${distance}: the lower one gives up exactly that`);
        for (const id of m.SECTIONS) if (id !== top && id !== bottom) assert.equal(after[id], prior[id], `space ${slot}, drag ${distance}: ${id} stays`);
        assert.equal(sum(after), slot);
      }
    }
    // Another space afterwards: proportional, not by weights above the minimum.
    const s = status({ files: true, layout: true, timeAxis: false }, { files: 300, layout: 200, timeAxis: 200 });
    assert.deepEqual(m.sectionHeights(s, 66 + 1000), { files: 22 + 600, layout: 22 + 400, timeAxis: 22 }, "double space: both double (proportional)");
  },
  drag: (m) => {
    const s = status({ files: true, layout: true, timeAxis: true });
    const h = { files: 22 + 400, layout: 22 + 200, timeAxis: 22 + 200 };
    const n = m.pull(s, h, 0, 50);
    assert.deepEqual(n.size, { files: 450, layout: 150, timeAxis: 200 }, "the two swap, the third stays");
    const clamp = m.pull(s, h, 0, 500);
    assert.deepEqual([clamp.size.files, clamp.size.layout], [480, 120], "clamped at the minimum");
    const ratio = m.pull(status({ files: true, layout: true, timeAxis: true }, { files: 1, layout: 1, timeAxis: 1 }), h, 1, 0);
    assert.deepEqual(ratio.size, { files: 400, layout: 200, timeAxis: 200 }, "the measured heights become the sizes (nothing jumps)");
    assert.equal(m.pull(m.SECTIONS_DEFAULT, h, 0, 50), m.SECTIONS_DEFAULT, "without a pair nothing changes");
  },
  toggle: (m) => {
    const s = status({ files: true, layout: false, timeAxis: false }, { files: 400, layout: 333, timeAxis: 200 });
    const n = m.toggle(s, "layout");
    assert.equal(n.open.layout, true);
    assert.equal(n.size.layout, 333, "when expanded the old size comes back");
  },
  remember: (m) => {
    assert.deepEqual(m.stateFrom(null), m.SECTIONS_DEFAULT);
    assert.deepEqual(m.stateFrom({ open: { layout: true }, size: { timeAxis: 150, files: -3, layout: "x" } }),
      { open: { files: true, layout: true, timeAxis: false }, size: { files: 400, layout: 200, timeAxis: 150 } }, "what is missing or does not fit is the default");
    assert.deepEqual(m.stateFrom({ open: { files: false } }).open.files, false, "a remembered collapsed stays collapsed");
  },
};

test("explorer sections: default, heights, drag bar, toggling, remembered state", async () => {
  const m = await load("explorer-sections.ts");
  for (const check of Object.values(CHECKS)) check(m);
});

test("explorer sections: each sabotage fails its check", async (t) => {
  for (const k of copies) {
    assert.equal(k.places, 1, `sabotage "${k.name}" is stale: the spot occurs ${k.places}x in the source`);
    const m = await load(k.file);
    assert.throws(() => CHECKS[k.catches](m), `sabotage "${k.name}" went unnoticed by "${k.catches}"`);
  }
  t.diagnostic(`${copies.length} sabotages caught`);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
