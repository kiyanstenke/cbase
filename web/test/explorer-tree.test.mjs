// The tree of the explorer as rows as in VS Code, lib/explorer-tree.ts, EXECUTED: compact folders (one row as long as a folder contains
// exactly one folder; their FIRST segment decides whether they are open, expanding/collapsing hits all segments; never across a file,
// at most 64 deep), "loading" rows of open folders without content, the field "new" at its place (folder at the top, file before the
// first file) with a broken chain, keys as in VS Code (up/down skip "loading", left to the parent, right expands and goes in), type
// navigation and the shift range. An open-drawn chain puts all segments into `open`; left/right/Home/End first walk through the
// segments in a compact row, PageUp/PageDown jump a page; the chains of the server tell the content of the chain's folders;
// `explorer.autoRevealExclude`. Each sabotage is a copy of the source with ONE changed spot; the assigned check must fail on it.
//
// Run:  node --test --test-reporter=tap web/test/explorer-tree.test.mjs
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
const SOURCE = fs.readFileSync(path.join(webDir, "src", "lib", "explorer-tree.ts"), "utf8");

const SABOTAGES = {
  "the last segment decides": { old: "open.has(e.path)", fresh: "open.has(last.path)", catches: "rows" },
  "no compact folders": { old: `if (!k || k.length !== 1 || k[0].type !== "dir") break;`, fresh: `if (!k || k.length !== 1 || k[0].type !== "dir" || chain.length > 0) break;`, catches: "rows" },
  "chain across a file": { old: `if (!k || k.length !== 1 || k[0].type !== "dir") break;`, fresh: "if (!k || k.length !== 1) break;", catches: "rows" },
  "segment not findable": { old: " || (z.kind === \"entry\" && z.chain.some((g) => g.path === path))", fresh: "", catches: "rows" },
  "chain without cap": { old: "chain.length < CHAIN_MAX", fresh: "true", catches: "chain" },
  "loading row missing": { old: `if (dir !== "") rows.push(`, fresh: `if (dir === "\\u0000") rows.push(`, catches: "load" },
  "field does not break the chain": { old: "if (fresh) abort.add(fresh.parent);", fresh: "", catches: "fresh" },
  "new folder not at the top": { old: `if (newHere && fresh.type === "dir") setNew();`, fresh: "", catches: "fresh" },
  "new file at the end": { old: `if (newHere && !set && e.type !== "dir") setNew();`, fresh: "", catches: "fresh" },
  "only the last segment toggles": { old: "for (const g of row.chain) { if (target) n.add(g.path); else n.delete(g.path); }", fresh: "{ const g = row.chain[row.chain.length - 1]; if (target) n.add(g.path); else n.delete(g.path); }", catches: "toggle" },
  "down lands on \"loading\"": { old: "const j = entries.find((x) => x > i);", fresh: "const j = i + 1 < rows.length ? i + 1 : undefined;", catches: "keys" },
  "left goes to the sibling": { old: "if (rows[j].depth < z.depth && rows[j].kind === \"entry\")", fresh: "if (rows[j].depth <= z.depth && rows[j].kind === \"entry\")", catches: "keys" },
  "right does not expand": { old: "if (!z.open) return { on: z.path };", fresh: "", catches: "keys" },
  "left does not collapse": { old: "if (z.type === \"dir\" && z.open) return { close: z.path };", fresh: "", catches: "keys" },
  "one character stays put": { old: "search.length === 1 ? i + 1 : i", fresh: "i", catches: "type" },
  "case matters": { old: "const search = input.toLowerCase();", fresh: "const search = input;", catches: "type" },
  "range with \"loading\"": { old: `.filter((z) => z.kind === "entry").map((z) => z.path);`, fresh: ".map((z) => z.path);", catches: "area" },
  "range without anchor": { old: "if (a < 0) return [rows[b].path];", fresh: "if (a < 0) return [];", catches: "area" },
  "chain collapses when broken": { old: "for (const g of z.chain) if (!open.has(g.path)) (n ??= new Set(open)).add(g.path);", fresh: "", catches: "segments" },
  "every render a new state": { old: "return n ?? open;", fresh: "return n ?? new Set(open);", catches: "segments" },
  "left leaves the segment": { old: `if (key === "left" && g > 0) return { focus: kz.chain[g - 1].path };`, fresh: "", catches: "segments" },
  "right leaves the segment": { old: "if (key === \"right\" && g < last) return { focus: kz.chain[g + 1].path };", fresh: "", catches: "segments" },
  "PageDown one step": { old: "* Math.max(1, page)", fresh: "* 1", catches: "pages" },
  "PageDown past the end": { old: "Math.max(0, Math.min(entries.length - 1, ", fresh: "Math.max(0, (", catches: "pages" },
  "seed without segments": { old: "for (const g of e.chain) { out.push(", fresh: "for (const g of e.chain.slice(0, 1)) { out.push(", catches: "seed" },
  "seed follows links": { old: `if (e.type !== "dir" || e.symlink || !e.chain?.length) continue;`, fresh: `if (e.type !== "dir" || !e.chain?.length) continue;`, catches: "seed" },
  "node_modules is shown": { old: "return path.split(\"/\").some((part) => names.includes(part));", fresh: "return names.includes(path);", catches: "seed" },
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-explorer-tree-"));
const src = path.join(tmp, "src"), out = path.join(tmp, "out");
fs.mkdirSync(src, { recursive: true });
fs.writeFileSync(path.join(src, "explorer-tree.ts"), SOURCE);
const copies = Object.entries(SABOTAGES).map(([name, s], i) => {
  const file = `explorer-tree-sabotage-${i}.ts`;
  fs.writeFileSync(path.join(src, file), SOURCE.replace(s.old, s.fresh));
  return { name, file, catches: s.catches, places: SOURCE.split(s.old).length - 1 };
});
execFileSync(process.execPath, [tsc, ...fs.readdirSync(src).map((f) => path.join(src, f)), "--outDir", out, "--module", "es2022", "--target", "es2022", "--strict", "--skipLibCheck"], { stdio: "pipe" });
const load = (file) => import(pathToFileURL(path.join(out, file.replace(/\.ts$/, ".js"))).href);

// A tree like a web project: src -> components is compact (src contains only components), components has two entries, docs contains
// only ONE file (no chain across a file), data is not loaded yet.
const d = (p) => ({ name: p.split("/").pop(), path: p, type: "dir" });
const f = (p) => ({ name: p.split("/").pop(), path: p, type: "file" });
const K = {
  "": [d("src"), d("data"), d("docs"), f("README.md")],
  src: [d("src/components")],
  "src/components": [d("src/components/code"), f("src/components/A.tsx")],
  "src/components/code": [f("src/components/code/B.tsx")],
  docs: [f("docs/x.md")],
};
const short = (rows) => rows.map((z) => (z.kind === "entry" ? `${z.depth}:${z.chain.map((g) => g.name).join("/")}${z.open ? "+" : ""}` : `${z.depth}:${z.kind}${z.type ? `-${z.type}` : ""}`));

const CHECKS = {
  segments: (m) => {
    // An open-drawn chain: the first segment decides, so the others are missing in `open` - openSegments adds them.
    const open = new Set(["src"]);
    const z = m.visibleRows(K, open);
    const n = m.openSegments(z, open);
    assert.deepEqual([...n].sort(), ["src", "src/components"], "all segments of an open chain");
    // If the chain breaks (a file arrives in src), src/components stays open.
    const broken = { ...K, src: [d("src/components"), f("src/fresh.ts")] };
    assert.deepEqual(short(m.visibleRows(broken, n)).slice(0, 4), ["0:src+", "1:components+", "2:code", "2:A.tsx"], "the chain does not collapse when broken");
    assert.equal(m.openSegments(m.visibleRows(K, n), n), n, "nothing missing: the same set (no new state per render)");
    // Left/right/Home/End in a compact row (VS Code compressedNavigation).
    const zz = m.visibleRows(K, new Set());
    assert.deepEqual(m.keyStep(zz, "src/components", "left"), { focus: "src" }, "left to the previous segment");
    assert.deepEqual(m.keyStep(zz, "src", "right"), { focus: "src/components" }, "right to the next segment");
    assert.deepEqual(m.keyStep(zz, "src/components", "beginning"), { focus: "src" }, "Home to the first segment");
    assert.deepEqual(m.keyStep(zz, "src", "end"), { focus: "src/components" }, "End to the last segment");
    assert.deepEqual(m.keyStep(zz, "src/components", "right"), { on: "src/components" }, "at the last segment right expands");
    assert.deepEqual(m.keyStep(zz, "src", "down"), { focus: "data" }, "down leaves the row");
  },
  pages: (m) => {
    const many = { "": Array.from({ length: 30 }, (_, i) => f(`f${String(i).padStart(2, "0")}.ts`)) };
    const z = m.visibleRows(many, new Set());
    assert.deepEqual(m.keyStep(z, "f00.ts", "pageDown", 10), { focus: "f10.ts" });
    assert.deepEqual(m.keyStep(z, "f25.ts", "pageDown", 10), { focus: "f29.ts" }, "not past the end");
    assert.deepEqual(m.keyStep(z, "f29.ts", "pageDown", 10), {}, "at the end: nothing");
    assert.deepEqual(m.keyStep(z, "f05.ts", "pageUp", 10), { focus: "f00.ts" });
  },
  seed: (m) => {
    const list = [
      { name: "deep", path: "deep", type: "dir", chain: [d("deep/a"), d("deep/a/b"), d("deep/a/b/c")] },
      { name: "link", path: "link", type: "dir", symlink: true, chain: [d("link/x")] },
      d("empty"),
    ];
    const seed = m.chainsSeed(list);
    assert.deepEqual(seed.map(([o, k]) => [o, k.map((x) => x.path)]), [["deep", ["deep/a"]], ["deep/a", ["deep/a/b"]], ["deep/a/b", ["deep/a/b/c"]]],
      "each folder of the chain knows exactly its segment - the content of the last one stays unknown, a link seeds nothing");
    // Seeded, "deep/a/b/c" already stands there collapsed (VS Code resolveSingleChildDescendants).
    const children = { "": list, ...Object.fromEntries(seed) };
    assert.deepEqual(short(m.visibleRows(children, new Set())).slice(0, 1), ["0:deep/a/b/c"]);
    assert.equal(m.showExcluded("web/node_modules/react/index.js"), true, "autoRevealExclude: an ancestor");
    assert.equal(m.showExcluded("bower_components"), true, "the path itself");
    assert.equal(m.showExcluded("src/node_modules_docs.md"), false, "whole names only");
    assert.equal(m.showExcluded("src/a.ts"), false);
  },
  rows: (m) => {
    assert.deepEqual(short(m.visibleRows(K, new Set())), ["0:src/components", "0:data", "0:docs", "0:README.md"]);
    const open = m.visibleRows(K, new Set(["src"]));
    assert.deepEqual(short(open), ["0:src/components+", "1:code", "1:A.tsx", "0:data", "0:docs", "0:README.md"], "the first segment decides");
    assert.equal(open[0].path, "src/components", "the row stands for the last segment");
    assert.deepEqual(open[1].ancestors, ["src/components"], "one indent line per folder row above");
    assert.deepEqual(short(m.visibleRows(K, new Set(["src"]), { compact: false })), ["0:src+", "1:components", "0:data", "0:docs", "0:README.md"]);
    assert.equal(m.visibleRows(K, new Set()).find((z) => z.path === "docs")?.type, "dir", "no chain across a file");
    assert.equal(m.rowOf(open, "src"), 0, "a middle segment finds its row");
    assert.equal(m.rowOf(open, "nowhere"), -1);
  },
  chain: (m) => {
    const deep = { "": [d("t")] };
    let p = "t";
    for (let i = 0; i < 100; i++) { deep[p] = [d(`${p}/t`)]; p = `${p}/t`; }
    assert.equal(m.compactChain(deep, d("t")).length, m.CHAIN_MAX, "a link in a circle does not become an endless chain");
  },
  load: (m) => {
    const z = m.visibleRows(K, new Set(["data"]));
    assert.deepEqual(short(z), ["0:src/components", "0:data+", "1:loading", "0:docs", "0:README.md"]);
    assert.deepEqual(m.missingOpen(K, z), ["data"]);
  },
  fresh: (m) => {
    const open = new Set(["src"]);
    assert.deepEqual(short(m.visibleRows(K, open, { fresh: { parent: "src/components", type: "file" } })),
      ["0:src/components+", "1:code", "1:fresh-file", "1:A.tsx", "0:data", "0:docs", "0:README.md"], "a new file before the first file");
    assert.deepEqual(short(m.visibleRows(K, open, { fresh: { parent: "src/components", type: "dir" } })),
      ["0:src/components+", "1:fresh-dir", "1:code", "1:A.tsx", "0:data", "0:docs", "0:README.md"], "a new folder at the top");
    assert.deepEqual(short(m.visibleRows(K, open, { fresh: { parent: "src", type: "file" } })),
      ["0:src+", "1:components", "1:fresh-file", "0:data", "0:docs", "0:README.md"], "the field breaks the chain at its folder");
    assert.deepEqual(short(m.visibleRows(K, new Set(), { fresh: { parent: "", type: "file" } })).slice(2, 4), ["0:docs", "0:fresh-file"], "in the root after the folders");
  },
  toggle: (m) => {
    const row = m.visibleRows(K, new Set())[0];
    const on = m.toggle(new Set(), row);
    assert.deepEqual([...on].sort(), ["src", "src/components"], "all segments at once");
    assert.deepEqual([...m.toggle(on, { ...row, open: true })], []);
    assert.deepEqual(m.ancestors("a/b/c.ts"), ["a", "a/b"]);
  },
  keys: (m) => {
    const z = m.visibleRows(K, new Set(["src"]));
    assert.deepEqual(m.keyStep(z, "src/components/A.tsx", "up"), { focus: "src/components/code" });
    assert.deepEqual(m.keyStep(z, "src/components/A.tsx", "down"), { focus: "data" });
    assert.deepEqual(m.keyStep(z, "src/components/A.tsx", "left"), { focus: "src/components" }, "left goes to the parent");
    assert.deepEqual(m.keyStep(z, "src", "left"), { close: "src/components" }, "at the first segment left collapses the row");
    assert.deepEqual(m.keyStep(z, "docs", "right"), { on: "docs" });
    assert.deepEqual(m.keyStep(z, "src/components", "right"), { focus: "src/components/code" }, "right goes into the open folder");
    assert.deepEqual(m.keyStep(z, "README.md", "right"), {});
    assert.deepEqual(m.keyStep(z, "docs", "beginning"), { focus: "src/components" });
    assert.deepEqual(m.keyStep(z, "docs", "end"), { focus: "README.md" });
    assert.deepEqual(m.keyStep(z, null, "down"), { focus: "src/components" });
    const l = m.visibleRows(K, new Set(["data"]));
    assert.deepEqual(m.keyStep(l, "data", "down"), { focus: "docs" }, "down skips \"loading\"");
  },
  type: (m) => {
    const z = m.visibleRows(K, new Set());
    assert.equal(m.typeNavigation(z, null, "d"), "data");
    assert.equal(m.typeNavigation(z, "data", "d"), "docs", "one character goes to the next");
    assert.equal(m.typeNavigation(z, "docs", "d"), "data", "at the end from the start");
    assert.equal(m.typeNavigation(z, "docs", "do"), "docs", "several characters stay on a match");
    assert.equal(m.typeNavigation(z, null, "SRC/c"), "src/components", "the label of the compact row, case-insensitive");
    assert.equal(m.typeNavigation(z, null, "x"), null);
  },
  area: (m) => {
    const z = m.visibleRows(K, new Set(["data"]));
    assert.deepEqual(m.area(z, "docs", "src/components"), ["src/components", "data", "docs"], "without \"loading\", in order");
    assert.deepEqual(m.area(z, "way", "docs"), ["docs"], "an invisible anchor: only the target");
    assert.deepEqual(m.area(z, "docs", "way"), []);
  },
};

test("explorer tree: rows, chains, field, keys, type navigation and range keep their promise", async () => {
  const m = await load("explorer-tree.ts");
  for (const check of Object.values(CHECKS)) check(m);
});

test("explorer tree: each sabotage fails its check", async (t) => {
  for (const k of copies) {
    assert.equal(k.places, 1, `sabotage "${k.name}" is stale: the spot occurs ${k.places}x in the source`);
    const m = await load(k.file);
    assert.throws(() => CHECKS[k.catches](m), `sabotage "${k.name}" went unnoticed by "${k.catches}"`);
  }
  t.diagnostic(`${copies.length} sabotages caught`);
});
