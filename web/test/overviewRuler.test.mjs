// The overview ruler as in VS Code: the strip beside the editor scrollbar that shows diagnostics, git blocks, search hits and occurrences.
//
// (1) The computation in lib/overviewRuler.ts, EXECUTED (compiled with tsc): the lanes (VS Code `_initLanes` for 3, 2 and 1 lane), lane and
//     stack height per kind, the Dark/Light Modern colors (`editorOverviewRuler.*`, cursor, edge, slider), the rectangles (minimum height 6 px
//     around the middle, entirely inside the ruler, squeezed onto the scroll area, device pixels, one group per color — across kinds too —,
//     groups by stack height and color, merged up to 1 px gap only within the SAME lane), the cursor marks, the edge, the slider
//     (`ScrollbarState`: size, minimum size, position, click into the track, drag, clamp) and what goes into the ruler (severity, git block,
//     selection, not twice next to the search).
// (2) The bindings (source text): where the ruler hangs (file tabs via CodePane, peek with two lanes, NOT in the diff), that the search
//     widget no longer paints marks of its own and delivers its hits via `searchHits`, the seam to the git gutter (`rulerGit`), the
//     occurrences in the whole text, what the ruler reads and in which order it paints, click/drag/wheel, slider visibility and the
//     scrollbar form.
//
// Each sabotage is a copy of the source with ONE changed spot (the spot appears exactly once, otherwise the sabotage is stale); the
// assigned check must fail on it.
//
// Run:  node --test --test-reporter=tap web/test/overviewRuler.test.mjs
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
const read = (...p) => fs.readFileSync(path.join(webDir, ...p), "utf8");

// ── (1) The computation ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
const SOURCE = read("src", "lib", "overviewRuler.ts");
const SABOTAGES = {
  "lanes without edge": { old: "const start = 1, rest = width - start;", fresh: "const start = 0, rest = width - start;", catches: "lanes" },
  "middle without remainder": { old: "const l = Math.floor(rest / 3), r = Math.floor(rest / 3), m = rest - l - r;", fresh: "const l = Math.floor(rest / 3), r = rest - 2 * Math.floor(rest / 3), m = Math.floor(rest / 3);", catches: "lanes" },
  "two lanes same as three": { old: "  if (lanes === 2) {", fresh: "  if (false) {", catches: "lanes" },
  "git on the right": { old: "add: { lane: LANE.left, z: 0 }", fresh: "add: { lane: LANE.right, z: 0 }", catches: "kinds" },
  "error below warning": { old: "error: { lane: LANE.right, z: 30 }", fresh: "error: { lane: LANE.right, z: 15 }", catches: "kinds" },
  "hits on the right": { old: "hits: { lane: LANE.middle, z: 10 }", fresh: "hits: { lane: LANE.right, z: 10 }", catches: "kinds" },
  "error opaque": { old: "error: \"#ff1212b3\", warning: \"#cca700\"", fresh: "error: \"#ff1212\", warning: \"#cca700\"", catches: "colors" },
  "changed light like dark": { old: "changed: \"#005fb899\"", fresh: "changed: \"#0078d499\"", catches: "colors" },
  "edge dark gray": { old: "cursor: \"#aeafadb3\", edge: \"#010409\"", fresh: "cursor: \"#aeafadb3\", edge: \"#7f7f7f4d\"", catches: "colors" },
  "slider opaque": { old: "dark: { quiet: \"#79797966\"", fresh: "dark: { quiet: \"#797979\"", catches: "colors" },
  "no minimum height": { old: "    if (y2 - y1 < min) {", fresh: "    if (false) {", catches: "rectangles" },
  "out at the bottom": { old: "const clampMiddle = (middle: number, half: number, ch: number) => (middle < half ? half : middle + half > ch ? ch - half : middle);", fresh: "const clampMiddle = (middle: number, half: number, ch: number) => (middle < half ? half : middle);", catches: "rectangles" },
  "without device pixels": { old: "const min = (MIN_HEIGHT * m.pixel) | 0, half = (min / 2) | 0;", fresh: "const min = MIN_HEIGHT, half = (min / 2) | 0;", catches: "rectangles" },
  "not squeezed": { old: "return { cw, ch, scale: ch / Math.max(m.total, 1), laneBoxes: lanePositions(cw, m.lanes) };", fresh: "return { cw, ch, scale: m.pixel, laneBoxes: lanePositions(cw, m.lanes) };", catches: "rectangles" },
  "never merged": { old: "if (p && t.lane === p.lane && t.y1 <= p.y2 + 1) {", fresh: "if (false) {", catches: "rectangles" },
  "merged with gap": { old: "if (p && t.lane === p.lane && t.y1 <= p.y2 + 1) {", fresh: "if (p && t.lane === p.lane && t.y1 <= p.y2 + 2) {", catches: "rectangles" },
  "merged across lanes": { old: "if (p && t.lane === p.lane && t.y1 <= p.y2 + 1) {", fresh: "if (p && t.y1 <= p.y2 + 1) {", catches: "rectangles" },
  "per kind instead of per color": { old: "const k = `${a.z}\\u0000${color}`;", fresh: "const k = `${a.z}\\u0000${e.kind}`;", catches: "rectangles" },
  "groups unordered": { old: ".sort((a, b) => a.z - b.z || (a.color < b.color ? -1 : a.color > b.color ? 1 : 0));", fresh: ";", catches: "rectangles" },
  "group unsorted": { old: "g.parts.sort((a, b) => a.y1 - b.y1);", fresh: "", catches: "rectangles" },
  "cursor in the middle of the line": { old: "const ys = top.map((o) => clampMiddle((o * scale) | 0, half, ch) - half)", fresh: "const ys = top.map((o) => clampMiddle((o * scale) | 0, half, ch))", catches: "cursor" },
  "cursor middle only": { old: "out.push({ color, x: laneBoxes.x[LANE.full], y: y1, w: laneBoxes.w[LANE.full], h: y2 - y1 });\n  return out;", fresh: "out.push({ color, x: laneBoxes.x[LANE.middle], y: y1, w: laneBoxes.w[LANE.middle], h: y2 - y1 });\n  return out;", catches: "cursor" },
  "cursor never merged": { old: "    if (y > y2 + 1) {", fresh: "    if (true) {", catches: "cursor" },
  "edge without top": { old: "return [{ color, x: 0, y: 0, w: 1, h: ch }, { color, x: 0, y: 0, w: cw, h: 1 }];", fresh: "return [{ color, x: 0, y: 0, w: 1, h: ch }];", catches: "edge" },
  "slider without minimum size": { old: "Math.max(SLIDER_MIN, Math.floor((view * lane) / total))", fresh: "Math.floor((view * lane) / total)", catches: "slider" },
  "slider always": { old: "if (!(total > 0 && total > view)) return", fresh: "if (false) return", catches: "slider" },
  "click sets the top edge": { old: "Math.round((y - s.size / 2) / s.ratio)", fresh: "Math.round(y / s.ratio)", catches: "slider" },
  "drag from zero": { old: "Math.round((s.situation + delta) / s.ratio)", fresh: "Math.round(delta / s.ratio)", catches: "slider" },
  "clamp without end": { old: "Math.max(0, Math.min(Math.max(0, total - view), target))", fresh: "Math.max(0, target)", catches: "slider" },
  "hints in the ruler": { old: "severity === \"info\" ? \"info\" : null", fresh: "severity === \"info\" || severity === \"hint\" ? \"info\" : null", catches: "sources" },
  "deleted before the first line": { old: "const z = Math.max(1, Math.min(b.from, rows));", fresh: "const z = Math.min(b.from, rows);", catches: "sources" },
  "block past the end": { old: "const from = Math.max(1, b.from), until = Math.min(b.until, rows);", fresh: "const from = Math.max(1, b.from), until = b.until;", catches: "sources" },
  "fresh as changed": { old: "kind: b.kind === \"fresh\" ? \"add\" : \"changed\"", fresh: "kind: \"changed\"", catches: "sources" },
  "multiple selections": { old: "if (selection.length !== 1) return null;", fresh: "", catches: "selection" },
  "multi-line selection": { old: "return s.includes(\"\\n\") || /^[ \\t]+$/.test(s) ? null : s;", fresh: "return /^[ \\t]+$/.test(s) ? null : s;", catches: "selection" },
  "whitespace only": { old: "return s.includes(\"\\n\") || /^[ \\t]+$/.test(s) ? null : s;", fresh: "return s.includes(\"\\n\") ? null : s;", catches: "selection" },
  "long selection": { old: "if (to <= from || to - from > 200) return null;", fresh: "if (to <= from) return null;", catches: "selection" },
  "selection counts too": { old: "if (i !== except) out.push(i);", fresh: "out.push(i);", catches: "selection" },
  "overlapping": { old: "i = text.indexOf(search, i + search.length)", fresh: "i = text.indexOf(search, i + 1)", catches: "selection" },
  "without cap": { old: "i >= 0 && out.length < cap;", fresh: "i >= 0;", catches: "selection" },
  "twice next to the search": { old: "if (!searchPanel.open || searchPanel.regexp || !searchPanel.text) return false;", fresh: "return false;", catches: "selection" },
  "regex like text": { old: "if (!searchPanel.open || searchPanel.regexp || !searchPanel.text) return false;", fresh: "if (!search.open || !search.text) return false;", catches: "selection" },
  "case always": { old: "searchPanel.caseSensitive ? searchPanel.text === search : searchPanel.text.toLowerCase() === search.toLowerCase()", fresh: "search.text === search", catches: "selection" },
};

// Compile the module and one copy per sabotage in ONE tsc run.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-ruler-"));
const src = path.join(tmp, "src"), out = path.join(tmp, "out");
fs.mkdirSync(src, { recursive: true });
fs.writeFileSync(path.join(src, "overviewRuler.ts"), SOURCE);
const copies = Object.entries(SABOTAGES).map(([name, s], i) => {
  const file = `overview-ruler-sabotage-${i}.ts`;
  fs.writeFileSync(path.join(src, file), SOURCE.replace(s.old, () => s.fresh));
  return { name, file, catches: s.catches, places: SOURCE.split(s.old).length - 1 };
});
try {
  execFileSync(process.execPath, [tsc, ...fs.readdirSync(src).map((d) => path.join(src, d)), "--outDir", out, "--rootDir", src, "--module", "es2022", "--target", "es2022", "--strict", "--skipLibCheck"], { stdio: "pipe" });
} catch (e) {
  const text = `${String(e.stdout || "")}${String(e.stderr || "")}`;
  const realError = text.split("\n").filter((z) => /error TS\d+/.test(z) && !/-sabotage-\d+\.ts\(/.test(z));
  if (realError.length || !fs.existsSync(path.join(out, "overviewRuler.js"))) throw new Error(`tsc: ${text}`.slice(0, 4000));
}
const load = (file) => import(pathToFileURL(path.join(out, file.replace(/\.ts$/, ".js"))).href);
const real = await load("overviewRuler.ts");
const sabotaged = await Promise.all(copies.map(async (k) => ({ ...k, mod: await load(k.file) })));
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { console.warn("[test] temp directory was left behind:", String(e?.message || e).slice(0, 120)); }

/** VS Code Dark/Light Modern — the reference of this check (provenance in the head of lib/overviewRuler.ts). */
const VS_CODE = {
  dark: { error: "#ff1212b3", warning: "#cca700", info: "#3794ff", add: "#2ea04399", changed: "#0078d499", deleted: "#f8514999", hits: "#d186167e", word: "#a0a0a0cc", selection: "#a0a0a0cc", cursor: "#aeafadb3", edge: "#010409" },
  light: { error: "#ff1212b3", warning: "#bf8803", info: "#1a85ff", add: "#2ea04399", changed: "#005fb899", deleted: "#f8514999", hits: "#d186167e", word: "#a0a0a0cc", selection: "#a0a0a0cc", cursor: "#000000b3", edge: "#e5e5e5" },
};
/** A ruler of 14 × 560 px over a scroll area of 560 px (1 px of scroll area = 1 device pixel), unless stated otherwise. */
const M = (o = {}) => ({ width: 14, height: 560, total: 560, pixel: 1, lanes: 3, ...o });
const E = (kind, top, bottom) => ({ kind, top, bottom });
const short = (rs) => rs.map((r) => `${r.color}@${r.x}+${r.w}:${r.y}-${r.y + r.h}`);

const CHECKS = {
  lanes(L) {
    assert.deepEqual(L.lanePositions(14, 3), { x: [0, 1, 5, 1, 10, 1, 5, 1], w: [0, 4, 5, 9, 4, 13, 9, 13] }, "3 lanes in 14 px: 1 px edge, 4 · 5 · 4");
    assert.deepEqual(L.lanePositions(28, 3), { x: [0, 1, 10, 1, 19, 1, 10, 1], w: [0, 9, 9, 18, 9, 27, 18, 27] }, "device pixel ratio 2");
    assert.deepEqual(L.lanePositions(14, 2), { x: [0, 1, 1, 1, 7, 1, 1, 1], w: [0, 6, 6, 6, 7, 13, 13, 13] }, "2 lanes: middle = left, right gets the remainder");
    assert.deepEqual(L.lanePositions(14, 1), { x: [0, 1, 1, 1, 1, 1, 1, 1], w: [0, 13, 13, 13, 13, 13, 13, 13] });
    assert.deepEqual(L.LANE, { left: 1, middle: 2, right: 4, full: 7 });
  },
  kinds(L) {
    const desired = { error: [4, 30], warning: [4, 20], info: [4, 10], add: [1, 0], changed: [1, 0], deleted: [1, 0], hits: [2, 10], word: [2, 0], selection: [2, 0] };
    assert.deepEqual(Object.fromEntries(Object.entries(L.RULER_KIND).map(([k, v]) => [k, [v.lane, v.z]])), desired);
  },
  colors(L) {
    assert.deepEqual(L.RULER_COLORS, VS_CODE);
    assert.deepEqual(L.SLIDER_COLORS, { dark: { quiet: "#79797966", hover: "#646464b3", active: "#bfbfbf66" }, light: { quiet: "#64646466", hover: "#646464b3", active: "#00000099" } });
    assert.equal(L.RULER_WIDTH, 14);
    assert.equal(L.HORIZONTAL_HEIGHT, 12);
  },
  rectangles(L) {
    const F = VS_CODE.dark, R = (e, m = M()) => short(L.rulerRectangles(e, m, F));
    // Minimum height 6 px around the middle, entirely inside the ruler; width and position from the lane.
    assert.deepEqual(R([E("error", 100, 101)]), ["#ff1212b3@10+4:97-103"]);
    assert.deepEqual(R([E("add", 0, 1)]), ["#2ea04399@1+4:0-6"], "at the top of the ruler");
    assert.deepEqual(R([E("add", 559, 560)]), ["#2ea04399@1+4:554-560"], "at the bottom of the ruler");
    assert.deepEqual(R([E("hits", 100, 140)]), ["#d186167e@5+5:100-140"], "tall enough: as it is");
    // Squeezed onto the scroll area, in device pixels.
    assert.deepEqual(R([E("info", 1000, 1200)], M({ total: 5600 })), ["#3794ff@10+4:100-120"]);
    assert.deepEqual(R([E("info", 100, 101)], M({ pixel: 2 })), ["#3794ff@19+9:195-207"], "minimum height 12 device pixels at factor 2");
    // Merging: at most 1 px gap in the same lane and color.
    assert.deepEqual(R([E("word", 100, 110), E("word", 111, 120)]), ["#a0a0a0cc@5+5:100-120"]);
    assert.deepEqual(R([E("word", 100, 110), E("word", 112, 120)]), ["#a0a0a0cc@5+5:100-110", "#a0a0a0cc@5+5:112-120"]);
    assert.deepEqual(R([E("word", 111, 120), E("word", 100, 110)]), ["#a0a0a0cc@5+5:100-120"], "independent of the order of the entries");
    assert.deepEqual(R([E("word", 100, 110), E("selection", 110, 120)]), ["#a0a0a0cc@5+5:100-120"], "same color = one group, across kinds too");
    assert.deepEqual(R([E("add", 100, 110), E("changed", 110, 120)]), ["#0078d499@1+4:110-120", "#2ea04399@1+4:100-110"], "different color: never merged");
    // Painted by stack height, then color: git (0) · info, hits (10) · warning (20) · error (30).
    const queue = L.rulerRectangles([E("error", 0, 10), E("warning", 20, 30), E("hits", 40, 50), E("info", 60, 70), E("add", 80, 90)], M(), F).map((r) => r.color);
    assert.deepEqual(queue, ["#2ea04399", "#3794ff", "#d186167e", "#cca700", "#ff1212b3"]);
    // One group (same stack height and color) across two lanes: never merged across the lane.
    assert.deepEqual(R([E("word", 100, 110), E("add", 111, 120)], M()).length, 2, "different color anyway");
    assert.deepEqual(short(L.rulerRectangles([E("word", 100, 110), E("add", 111, 120)], M(), { ...F, add: F.word })), ["#a0a0a0cc@5+5:100-110", "#a0a0a0cc@1+4:111-120"], "middle and left stay separate, even in one color");
  },
  cursor(L) {
    const C = (o, m = M()) => short(L.cursorRectangles(o, m, "#c"));
    assert.deepEqual(C([200]), ["#c@1+13:199-201"], "2 px at the top edge of the line, across all lanes");
    assert.deepEqual(C([0]), ["#c@1+13:0-2"]);
    assert.deepEqual(C([560]), ["#c@1+13:558-560"]);
    assert.deepEqual(C([300, 200]), ["#c@1+13:199-201", "#c@1+13:299-301"], "two marks, sorted");
    assert.deepEqual(C([200, 202]), ["#c@1+13:199-203"], "close together: one stroke");
    assert.deepEqual(C([200], M({ lanes: 2 })), ["#c@1+13:199-201"]);
    assert.deepEqual(C([]), []);
  },
  edge(L) {
    assert.deepEqual(short(L.edge(M(), "#k")), ["#k@0+1:0-560", "#k@0+14:0-1"], "left over the full height and on top");
    assert.deepEqual(short(L.edge(M({ pixel: 2 }), "#k")), ["#k@0+1:0-1120", "#k@0+28:0-1"]);
  },
  slider(L) {
    assert.deepEqual(L.slider(560, 560, 560, 0), { needed: false, size: 560, situation: 0, ratio: 0 }, "everything visible: no slider");
    const s = L.slider(560, 560, 7536, 0);
    assert.equal(s.size, 41);
    assert.equal(s.ratio, 519 / 6976);
    assert.equal(L.slider(560, 560, 7536, 4993).situation, 371);
    assert.equal(L.slider(560, 560, 100000, 0).size, 20, "minimum size");
    // Click into the track: the middle of the slider jumps there; dragging starts from the position at press.
    assert.equal(L.scrollTargetFromClick(392, s), 4993);
    assert.equal(L.scrollTargetFromClick(392, L.slider(560, 560, 560, 0)), 0);
    const at = L.slider(560, 560, 7536, 4993);
    assert.equal(L.scrollTargetFromDrag(at, 0), Math.round(371 / at.ratio));
    assert.equal(L.scrollTargetFromDrag(at, -171), Math.round(200 / at.ratio));
    assert.equal(L.clampScroll(-5, 560, 7536), 0);
    assert.equal(L.clampScroll(99999, 560, 7536), 6976);
    assert.equal(L.clampScroll(10, 560, 300), 0);
  },
  sources(L) {
    assert.deepEqual(["error", "warning", "info", "hint"].map(L.kindOfSeverity), ["error", "warning", "info", null]);
    assert.deepEqual(L.gitInRuler({ kind: "fresh", from: 3, until: 6 }, 100), { kind: "add", from: 3, until: 6 });
    assert.deepEqual(L.gitInRuler({ kind: "changed", from: 98, until: 120 }, 100), { kind: "changed", from: 98, until: 100 });
    assert.equal(L.gitInRuler({ kind: "changed", from: 120, until: 130 }, 100), null);
    assert.deepEqual(L.gitInRuler({ kind: "deleted", from: 0, until: 0 }, 100), { kind: "deleted", from: 1, until: 1 }, "before the first line: at it");
    assert.deepEqual(L.gitInRuler({ kind: "deleted", from: 140, until: 140 }, 100), { kind: "deleted", from: 100, until: 100 });
    assert.equal(L.gitInRuler({ kind: "fresh", from: 1, until: 1 }, 0), null);
  },
  selection(L) {
    const text = "aaa foo Foo foo\n  foo";
    const t = (from, to) => text.slice(from, to);
    assert.equal(L.selectionSearchText([{ from: 4, to: 7 }], t), "foo");
    assert.equal(L.selectionSearchText([{ from: 4, to: 7 }, { from: 12, to: 15 }], t), null, "multiple selections");
    assert.equal(L.selectionSearchText([{ from: 4, to: 4 }], t), null, "empty");
    assert.equal(L.selectionSearchText([{ from: 12, to: 18 }], t), null, "beyond one line");
    assert.equal(L.selectionSearchText([{ from: 16, to: 18 }], t), null, "spaces only");
    assert.equal(L.selectionSearchText([{ from: 16, to: 21 }], t), "  foo");
    assert.equal(L.selectionSearchText([{ from: 0, to: 201 }], () => "x".repeat(201)), null, "more than 200 characters");
    assert.equal(L.selectionSearchText([{ from: 0, to: 200 }], () => "x".repeat(200)), "x".repeat(200));
    assert.deepEqual(L.occurrencesIn(text, "foo", 4), [12, 18], "literal and case-sensitive, without the selection itself");
    assert.deepEqual(L.occurrencesIn("aaaa", "aa", -1), [0, 2], "without overlap");
    assert.deepEqual(L.occurrencesIn("x".repeat(10), "x", -1, 3), [0, 1, 2], "Cap");
    const search = (o) => ({ open: true, text: "foo", regexp: false, caseSensitive: false, ...o });
    assert.equal(L.selectionAsSearch("Foo", search()), true, "case-insensitive: the same search");
    assert.equal(L.selectionAsSearch("Foo", search({ caseSensitive: true })), false);
    assert.equal(L.selectionAsSearch("foo", search({ open: false })), false, "widget closed");
    assert.equal(L.selectionAsSearch("foo", search({ regexp: true })), false, "regular expression");
    assert.equal(L.selectionAsSearch("bar", search()), false);
  },
};

test("(1) lanes, kinds, colors like VS Code", () => { for (const k of ["lanes", "kinds", "colors"]) CHECKS[k](real); });
test("(1) rectangles: minimum height, squeezed, device pixels, per color, merged per pixel, order", () => { CHECKS.rectangles(real); });
test("(1) cursor marks and edge", () => { CHECKS.cursor(real); CHECKS.edge(real); });
test("(1) slider: size, position, click into the track, drag, clamp", () => { CHECKS.slider(real); });
test("(1) what goes into the ruler: severity, git block, selection, not duplicated next to the search", () => { CHECKS.sources(real); CHECKS.selection(real); });
test("(1) counter-tests: every sabotage appears exactly once in the source and is caught by its check", () => {
  assert.deepEqual(copies.filter((k) => k.places !== 1).map((k) => `${k.name} (${k.places}×)`), [], "sabotages whose spot does not appear exactly once in the source");
  const notCaught = sabotaged.filter((s) => { try { CHECKS[s.catches](s.mod); return true; } catch { return false; } }).map((s) => `${s.name} (${s.catches})`);
  assert.deepEqual(notCaught, [], "sabotages that no check catches");
  assert.deepEqual(Object.keys(CHECKS).filter((k) => !copies.some((s) => s.catches === k)), [], "checks without sabotage");
  console.log(`  [overviewRuler] computation: ${Object.keys(CHECKS).length} checks, ${sabotaged.length} sabotages, each caught`);
});

// ── (2) The bindings ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
const B = {
  ruler: read("src", "components", "code", "overviewRuler.ts"),
  codePane: read("src", "components", "CodePane.tsx"),
  peek: read("src", "components", "code", "lsp-peek.ts"),
  diff: read("src", "components", "code", "DiffTab.tsx"),
  search: read("src", "components", "code", "search-widget.ts"),
  git: read("src", "components", "code", "git-gutter.ts"),
  occurrences: read("src", "components", "code", "lsp-occurrences.ts"),
  theme: read("src", "components", "code", "codeTheme.ts"),
  // All web UI sources — "one ruler, no second one beside it" holds everywhere.
  all: fs.readdirSync(path.join(webDir, "src"), { recursive: true }).filter((d) => /\.tsx?$/.test(d)).sort()
    .map((d) => `// ── ${d}\n${read("src", d)}`).join("\n"),
};
const BINDINGS = {
  location(s) {
    assert.match(s.codePane, /^import \{ overviewRuler \} from "@\/components\/code\/overviewRuler";$/m);
    assert.match(s.codePane, /\n\s+list\.push\(overviewRuler\(\)\); \/\/ overview ruler/, "file tabs (Coding → Files, both groups, chat code tabs) via buildExtensions");
    assert.match(s.peek, /\n\s+overviewRuler\(2\), \/\/ two lanes/, "the peek with two lanes");
    assert.doesNotMatch(s.diff, /overviewRuler/, "the diff scrolls outside (MergeView) — no ruler per side there");
    assert.match(s.ruler, /^export function overviewRuler\(lanes: 2 \| 3 = 3\): Extension \{\n\s+return \[PLUGIN\[lanes\], EditorView\.editorAttributes\.of\(\{ class: "cm-with-ruler" \}\), sliderColors, form\];/m);
  },
  oneRuler(s) {
    // The search widget no longer paints on its own; its hits reach the ruler via a state field.
    assert.doesNotMatch(s.all, /cm-search-bar|--cb-match-bar/, "the old marks of the search widget");
    assert.match(s.search, /^export const searchHits = StateField\.define<readonly number\[\]>\(\{/m);
    assert.match(s.search, /return searchPanelOpen\(t\.state\) \? v : NO;/, "widget closed: no hits in the ruler");
    assert.match(s.search, /if \(findings\.length \|\| this\.view\.state\.field\(searchHits\)\.length\) this\.view\.dispatch\(\{ effects: setHits\.of\(findings\) \}\);/);
    assert.match(s.search, /areaField, areaDeco, gapField, searchHits,/);
    assert.equal((s.all.match(/class Ruler \{/g) ?? []).length, 1, "exactly one ruler");
  },
  seam(s) {
    // Git: ONE line in the gutter delivers its blocks, the ruler reads the facet.
    assert.match(s.git, /^import \{ rulerGit \} from "@\/components\/code\/overviewRuler";$/m);
    assert.match(s.git, /\n\s+rulerGit\.from\(field, \(v\) => v\.blocks\),/);
    assert.match(s.ruler, /^export const rulerGit = Facet\.define<readonly DiffBlock\[\], readonly DiffBlock\[\]>\(\{ combine: \(w\) => w\[0\] \?\? \[\] \}\);$/m);
    // The other sources.
    assert.match(s.ruler, /forEachDiagnostic\(st, \(d, from, to\) => \{ const kind = kindOfSeverity\(d\.severity\); if \(kind\) area\(kind, from, to\); \}\);/);
    assert.match(s.ruler, /for \(const b of st\.facet\(rulerGit\)\) \{\n\s+const g = gitInRuler\(b, doc\.lines\);/);
    assert.match(s.ruler, /for \(const p of st\.field\(searchHits, false\) \?\? \[\]\) \{/);
    assert.match(s.ruler, /occurrencesAreas\(v\)\.between\(0, doc\.length, \(from, to\) => \{ area\("word", from, to\); \}\);/);
    assert.match(s.ruler, /if \(search && !selectionAsSearch\(search, \{ open: searchPanelOpen\(st\), text: q\.search, regexp: q\.regexp, caseSensitive: q\.caseSensitive \}\)\) \{/);
    assert.match(s.ruler, /const cursor = st\.selection\.ranges\.map\(\(r\) => offset \+ v\.lineBlockAt\(r\.head\)\.top\);/, "every caret");
    // The occurrences of the word in the WHOLE text (otherwise they would be missing in the ruler outside the viewport).
    assert.match(s.occurrences, /const text = state\.doc\.toString\(\);/);
    assert.doesNotMatch(s.occurrences, /visibleRanges/);
    assert.match(s.occurrences, /if \(!u\.selectionSet && !u\.docChanged\) return;/);
    assert.match(s.occurrences, /^export const occurrencesAreas = \(view: EditorView\): DecorationSet => view\.plugin\(highlight\)\?\.deco \?\? Decoration\.none;$/m);
  },
  paint(s) {
    // Positions in the scroll area (they do not move while scrolling), device pixels, colors by light/dark; entries, then cursor, the edge last.
    assert.match(s.ruler, /const offset = v\.documentTop - sd\.getBoundingClientRect\(\)\.top \+ sd\.scrollTop;/);
    assert.match(s.ruler, /mass: \{ width: RULER_WIDTH, height: sd\.clientHeight, total: sd\.scrollHeight, pixel: window\.devicePixelRatio \|\| 1, lanes: this\.lanes \}/);
    assert.match(s.ruler, /const cw = Math\.round\(mass\.width \* mass\.pixel\), ch = Math\.round\(mass\.height \* mass\.pixel\);/);
    assert.match(s.ruler, /const f = RULER_COLORS\[m\.dark \? "dark" : "light"\];/);
    assert.match(s.ruler, /dark: st\.facet\(EditorView\.darkTheme\)/);
    assert.match(s.ruler, /for \(const r of \[\.\.\.rulerRectangles\(m\.entries, mass, f\), \.\.\.cursorRectangles\(m\.cursor, mass, f\.cursor\), \.\.\.edge\(mass, f\.edge\)\]\) \{/);
    assert.match(s.ruler, /if \(u\.transactions\.length \|\| u\.geometryChanged \|\| u\.heightChanged\) this\.plane\(\);/, "every source arrives as a transaction");
    assert.match(s.ruler, /this\.view\.requestMeasure\(\{ key: this, read: \(v\) => this\.read\(v\), write: \(m\) => this\.draw\(m\) \}\);/);
    assert.match(s.ruler, /window\.addEventListener\("resize", fresh\);/, "a new pixel ratio is not a transaction");
  },
  operate(s) {
    // A click into the track jumps (middle of the slider), the same press keeps dragging; focus stays in the text; the wheel scrolls the editor.
    assert.match(s.ruler, /e\.preventDefault\(\); \/\/ no focus change, no text selection/);
    assert.match(s.ruler, /if \(y < this\.s\.situation \|\| y >= this\.s\.situation \+ this\.s\.size\) \{[\s\S]{0,200}sd\.scrollTop = clampScroll\(scrollTargetFromClick\(y, this\.s\), sd\.clientHeight, sd\.scrollHeight\);/);
    assert.match(s.ruler, /this\.turn = \{ start: this\.s, y: e\.clientY, id: e\.pointerId \};\n\s+this\.dom\.setPointerCapture\(e\.pointerId\);/);
    assert.match(s.ruler, /sd\.scrollTop = clampScroll\(scrollTargetFromDrag\(this\.turn\.start, e\.clientY - this\.turn\.y\), sd\.clientHeight, sd\.scrollHeight\);/);
    assert.match(s.ruler, /on\(this\.dom, "wheel", \(e\) => this\.wheel\(e\), \{ passive: false \}\);/);
    assert.match(s.ruler, /sd\.scrollBy\(\{ top: e\.deltaY \* f, left: e\.deltaX \* f \}\);/);
    // Visible over the editor, while dragging and shortly after scrolling; fades out in 800 ms.
    assert.match(s.ruler, /on\(view\.scrollDOM, "scroll", \(\) => \{ this\.sliderNew\(\); this\.show\(\); \}, \{ passive: true \}\);/);
    assert.match(s.ruler, /on\(view\.dom, "mouseenter", \(\) => \{ this\.over = true; this\.show\(\); \}\);/);
    assert.match(s.ruler, /if \(this\.over \|\| this\.turn\) return;\n\s+this\.clock = setTimeout\(/);
    assert.match(s.ruler, /^const VISIBLE_MS = 500;$/m);
    assert.match(s.ruler, /transition: "opacity 800ms linear"/);
    assert.match(s.ruler, /"\.cm-ruler\[data-visible\] \.cm-ruler-slider": \{ opacity: "1", transition: "opacity 100ms linear" \}/);
    assert.match(s.ruler, /"\.cm-ruler\[data-dragging\] \.cm-ruler-slider": \{ background: "var\(--cb-slider-active\)" \}/);
  },
  form(s) {
    // The native bar keeps its width (always) but is invisible; WebKit rules also apply under a `.cb-scroll`.
    assert.match(s.ruler, /"&\.cm-with-ruler \.cm-scroller": \{ overflowY: "scroll", scrollbarWidth: "auto", scrollbarColor: "auto" \}/);
    assert.match(s.ruler, /"&\.cm-with-ruler \.cm-scroller::-webkit-scrollbar": \{ width: `\$\{RULER_WIDTH\}px`, height: `\$\{HORIZONTAL_HEIGHT\}px` \}/);
    assert.match(s.ruler, /"&\.cm-with-ruler \.cm-scroller::-webkit-scrollbar-thumb:vertical": \{ background: "transparent" \}/);
    assert.match(s.ruler, /"&\.cm-with-ruler \.cm-scroller::-webkit-scrollbar-thumb:horizontal": \{ background: "var\(--cb-slider\)" \}/);
    assert.match(s.ruler, /"\.cm-ruler": \{ position: "absolute", top: "0", right: "0", width: `\$\{RULER_WIDTH\}px`/);
    assert.match(s.ruler, /this\.dom\.setAttribute\("aria-hidden", "true"\);/);
    assert.match(s.ruler, /"&dark": \{ "--cb-slider": SLIDER_COLORS\.dark\.quiet, /);
    assert.match(s.ruler, /"&light": \{ "--cb-slider": SLIDER_COLORS\.light\.quiet, /);
  },
};
const B_SABOTAGES = [
  { name: "file tab without ruler", file: "codePane", old: "    list.push(overviewRuler()); // overview ruler", fresh: "    // overview ruler", catches: "location" },
  { name: "peek with three lanes", file: "peek", old: "overviewRuler(2), // two lanes", fresh: "overviewRuler(), // two lanes", catches: "location" },
  { name: "ruler in the diff", file: "diff", old: "basicSetup({ lineNumbers: false, foldGutter: false,", fresh: "overviewRuler(), basicSetup({ lineNumbers: false, foldGutter: false,", catches: "location" },
  { name: "scrollbar not switched", file: "ruler", old: "EditorView.editorAttributes.of({ class: \"cm-with-ruler\" }), ", fresh: "", catches: "location" },
  { name: "old marks back", file: "all", old: "  \".cm-search-area\": { backgroundColor: \"var(--cb-search-area)\" },\n", fresh: "  \".cm-search-area\": { backgroundColor: \"var(--cb-search-area)\" },\n  \".cm-search-bar\": { position: \"absolute\" },\n", catches: "oneRuler" },
  { name: "hits after closing", file: "search", old: "return searchPanelOpen(t.state) ? v : NO;", fresh: "return v;", catches: "oneRuler" },
  { name: "hits never reported", file: "search", old: "this.view.dispatch({ effects: setHits.of(findings) });", fresh: "void findings;", catches: "oneRuler" },
  { name: "field not attached", file: "search", old: "areaField, areaDeco, gapField, searchHits,", fresh: "areaField, areaDeco, gapField,", catches: "oneRuler" },
  { name: "second ruler", file: "all", old: "class Ruler {", fresh: "class Ruler {}\nclass Ruler {", catches: "oneRuler" },
  { name: "git not delivered", file: "git", old: "    rulerGit.from(field, (v) => v.blocks),", fresh: "", catches: "seam" },
  { name: "diagnostics missing", file: "ruler", old: "if (kind) area(kind, from, to); });", fresh: "void kind; });", catches: "seam" },
  { name: "hits missing", file: "ruler", old: "for (const p of st.field(searchHits, false) ?? []) {", fresh: "for (const p of [] as number[]) {", catches: "seam" },
  { name: "occurrences missing", file: "ruler", old: "occurrencesAreas(v).between(0, doc.length, (from, to) => { area(\"word\", from, to); });", fresh: "", catches: "seam" },
  { name: "selection twice next to the search", file: "ruler", old: "if (search && !selectionAsSearch(search, { open: searchPanelOpen(st), text: q.search, regexp: q.regexp, caseSensitive: q.caseSensitive })) {", fresh: "if (search) {", catches: "seam" },
  { name: "main caret only", file: "ruler", old: "const cursor = st.selection.ranges.map((r) => offset + v.lineBlockAt(r.head).top);", fresh: "const cursor = [offset + v.lineBlockAt(st.selection.main.head).top];", catches: "seam" },
  { name: "occurrences only in the viewport", file: "occurrences", old: "  const text = state.doc.toString();", fresh: "  const text = state.sliceDoc(view.visibleRanges[0].from, view.visibleRanges[0].to);", catches: "seam" },
  { name: "scrolling searches again", file: "occurrences", old: "if (!u.selectionSet && !u.docChanged) return;", fresh: "if (!u.selectionSet && !u.docChanged && !u.viewportChanged) return;", catches: "seam" },
  { name: "position in the viewport instead of the scroll area", file: "ruler", old: "const offset = v.documentTop - sd.getBoundingClientRect().top + sd.scrollTop;", fresh: "const offset = v.documentTop - sd.getBoundingClientRect().top;", catches: "paint" },
  { name: "without device pixels", file: "ruler", old: "pixel: window.devicePixelRatio || 1,", fresh: "pixel: 1,", catches: "paint" },
  { name: "always dark", file: "ruler", old: "const f = RULER_COLORS[m.dark ? \"dark\" : \"light\"];", fresh: "const f = RULER_COLORS.dark;", catches: "paint" },
  { name: "cursor below the entries", file: "ruler", old: "[...rulerRectangles(m.entries, mass, f), ...cursorRectangles(m.cursor, mass, f.cursor), ", fresh: "[...cursorRectangles(m.cursor, mass, f.cursor), ...rulerRectangles(m.entries, mass, f), ", catches: "paint" },
  { name: "pixel ratio stays stale", file: "ruler", old: "    window.addEventListener(\"resize\", fresh);\n", fresh: "", catches: "paint" },
  { name: "only on text change", file: "ruler", old: "if (u.transactions.length || u.geometryChanged || u.heightChanged) this.plane();", fresh: "if (u.docChanged) this.plane();", catches: "paint" },
  { name: "focus moves", file: "ruler", old: "e.preventDefault(); // no focus change, no text selection", fresh: "// allows focus change", catches: "operate" },
  { name: "click on the slider jumps", file: "ruler", old: "if (y < this.s.situation || y >= this.s.situation + this.s.size) {", fresh: "if (true) {", catches: "operate" },
  { name: "drag from the track", file: "ruler", old: "scrollTargetFromDrag(this.turn.start, e.clientY - this.turn.y)", fresh: "scrollTargetFromDrag(this.turn.start, e.clientY)", catches: "operate" },
  { name: "wheel dead", file: "ruler", old: "sd.scrollBy({ top: e.deltaY * f, left: e.deltaX * f });", fresh: "void f;", catches: "operate" },
  { name: "slider stays put", file: "ruler", old: "on(view.scrollDOM, \"scroll\", () => { this.sliderNew(); this.show(); }, { passive: true });", fresh: "", catches: "operate" },
  { name: "vanishes under the pointer", file: "ruler", old: "if (this.over || this.turn) return;", fresh: "", catches: "operate" },
  { name: "not active while dragging", file: "ruler", old: "\".cm-ruler[data-dragging] .cm-ruler-slider\": { background: \"var(--cb-slider-active)\" },", fresh: "", catches: "operate" },
  { name: "native bar visible", file: "ruler", old: "\"&.cm-with-ruler .cm-scroller::-webkit-scrollbar-thumb:vertical\": { background: \"transparent\" },", fresh: "", catches: "form" },
  { name: "bar only on overflow", file: "ruler", old: "{ overflowY: \"scroll\", scrollbarWidth: \"auto\", scrollbarColor: \"auto\" }", fresh: "{ scrollbarWidth: \"auto\", scrollbarColor: \"auto\" }", catches: "form" },
  { name: "inherits scrollbar-color", file: "ruler", old: "{ overflowY: \"scroll\", scrollbarWidth: \"auto\", scrollbarColor: \"auto\" }", fresh: "{ overflowY: \"scroll\" }", catches: "form" },
  { name: "ruler read aloud", file: "ruler", old: "this.dom.setAttribute(\"aria-hidden\", \"true\");", fresh: "", catches: "form" },
];

test("(2) bindings: where the ruler hangs, one ruler, the seams, painting, operating, scrollbar form", () => {
  for (const [k, f] of Object.entries(BINDINGS)) { try { f(B); } catch (e) { throw new Error(`${k}: ${e.message}`); } }
});
test("(2) counter-tests of the bindings: every sabotage appears exactly once and is caught", () => {
  const stale = B_SABOTAGES.filter((x) => B[x.file].split(x.old).length - 1 !== 1).map((x) => `${x.name} (${B[x.file].split(x.old).length - 1}×)`);
  assert.deepEqual(stale, [], "sabotages whose spot does not appear exactly once in the source");
  const notCaught = B_SABOTAGES.filter((x) => {
    const s = { ...B, [x.file]: B[x.file].replace(x.old, () => x.fresh) };
    try { BINDINGS[x.catches](s); return true; } catch { return false; }
  }).map((x) => `${x.name} (${x.catches})`);
  assert.deepEqual(notCaught, [], "sabotages that no check catches");
  assert.deepEqual(Object.keys(BINDINGS).filter((k) => !B_SABOTAGES.some((x) => x.catches === k)), [], "bindings without sabotage");
  console.log(`  [overviewRuler] bindings: ${Object.keys(BINDINGS).length} checks, ${B_SABOTAGES.length} sabotages, each caught`);
});
