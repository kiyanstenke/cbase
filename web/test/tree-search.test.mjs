// Searching in the tree as in VS Code: lib/tree-search.ts, EXECUTED over real rows from lib/explorer-tree.ts:
// the hit in the name (contiguous first, fuzzy as a subsequence with merged ranges, case-insensitive), highlighting shows all
// rows, filtering only the matching ones and the folders above them (the children of a matching folder drop out, as in VS Code),
// only loaded content is searched (a never-loaded folder reports `unloaded`; a link is not entered) and Alt+Cmd+F or Ctrl+Alt+F
// opens it. Every sabotage is a copy of the source with ONE changed spot; the assigned check must fail on it.
//
// Run:  node --test --test-reporter=tap web/test/tree-search.test.mjs
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
const lib = (n) => fs.readFileSync(path.join(webDir, "src", "lib", n), "utf8");
const SOURCE = lib("tree-search.ts");

const SABOTAGES = {
  "contiguous only": { old: "  if (!fuzzy) return null;\n", fresh: "  return null;\n", catches: "hits" },
  "fuzzy even without the toggle": { old: "  if (!fuzzy) return null;\n", fresh: "", catches: "hits" },
  "case matters": { old: "const n = name.toLowerCase();", fresh: "const n = name;", catches: "hits" },
  "ranges fragmented": { old: "if (last && last[1] === j) last[1] = j + 1; else out.push([j, j + 1]);", fresh: "out.push([j, j + 1]);", catches: "hits" },
  "unloaded silent": { old: "if (children[e.path] === undefined) unloaded = true;", fresh: "if (children[e.path] === undefined) unloaded = false;", catches: "search" },
  "link entered": { old: "if (e.type === \"dir\" && !e.symlink) {", fresh: "if (e.type === \"dir\") {", catches: "search" },
  "filtering shows everything": { old: "if (!pattern || mode === \"highlight\")", fresh: "if (true)", catches: "filter" },
  "children of a hit stay": { old: "(z.chain.some((g) => hits.has(g.path)) || ancestors.has(z.path))", fresh: "([...hits.keys()].some((p) => z.path === p || z.path.startsWith(`${p}/`)) || ancestors.has(z.path))", catches: "filter" },
  "parents of a hit drop out": { old: " || ancestors.has(z.path))", fresh: ")", catches: "filter" },
  "only the next folder above": { old: "for (let i = p.lastIndexOf(\"/\"); i > 0; i = p.lastIndexOf(\"/\", i - 1)) {", fresh: "for (let i = p.lastIndexOf(\"/\"); i > 0; i = -1) {", catches: "filter" },
  "jump without wrap-around": { old: "const i = (Math.max(0, start) + k) % n;", fresh: "const i = Math.max(0, start) + k; if (i >= n) break;", catches: "jump" },
  "jump from the start instead of from the focus": { old: "const i = (Math.max(0, start) + k) % n;", fresh: "const i = k;", catches: "jump" },
  "jump to the row instead of the segment": { old: "if (g) return { index: i, path: g.path };", fresh: "if (g) return { index: i, path: z.path };", catches: "jump" },
  "key with Shift": { old: "if (e.code !== \"KeyF\" || !e.altKey || e.shiftKey) return false;", fresh: "if (e.code !== \"KeyF\" || !e.altKey) return false;", catches: "key" },
  "Ctrl on the Mac": { old: "return mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;", fresh: "return e.metaKey || e.ctrlKey;", catches: "key" },
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-tree-search-"));
const src = path.join(tmp, "src"), out = path.join(tmp, "out");
fs.mkdirSync(src, { recursive: true });
fs.writeFileSync(path.join(src, "explorer-tree.ts"), lib("explorer-tree.ts"));
fs.writeFileSync(path.join(src, "tree-search.ts"), SOURCE);
const copies = Object.entries(SABOTAGES).map(([name, s], i) => {
  const file = `tree-search-sabotage-${i}.ts`;
  fs.writeFileSync(path.join(src, file), SOURCE.replace(s.old, s.fresh));
  return { name, file, catches: s.catches, places: SOURCE.split(s.old).length - 1 };
});
execFileSync(process.execPath, [tsc, ...fs.readdirSync(src).map((f) => path.join(src, f)), "--outDir", out, "--module", "es2022", "--target", "es2022", "--strict", "--skipLibCheck"], { stdio: "pipe" });
const load = (file) => import(pathToFileURL(path.join(out, file.replace(/\.ts$/, ".js"))).href);
const tree = await load("explorer-tree.ts");

const e = (p, type, x = {}) => ({ name: p.slice(p.lastIndexOf("/") + 1), path: p, type, ...x });
const CHILDREN = {
  "": [e("src", "dir"), e("README.md", "file"), e("lib", "dir")], // "lib" was never open: not loaded
  src: [e("src/app.ts", "file"), e("src/util", "dir")],
  "src/util": [e("src/util/apple.ts", "file")],
};
const OPEN = new Set(["src", "src/util"]);
const ROWS = tree.visibleRows(CHILDREN, OPEN, { compact: false });
const LOADED = { "": [e("src", "dir"), e("reference", "dir", { symlink: true })], src: [e("src/app.ts", "file")] };
const paths = (r) => r.rows.map((z) => z.path);

const CHECKS = {
  hits: (m) => {
    assert.deepEqual(m.nameHits("app.ts", "ap", true), [[0, 2]]);
    assert.deepEqual(m.nameHits("README.md", "read", false), [[0, 4]], "case-insensitive");
    assert.deepEqual(m.nameHits("README.md", "rdm", true), [[0, 1], [3, 5]], "fuzzy: the characters in order, neighbors merged");
    assert.equal(m.nameHits("README.md", "rdm", false), null, "without \"Fuzzy\" only contiguous");
    assert.equal(m.nameHits("app.ts", "", true), null, "an empty pattern matches nothing");
    assert.equal(m.nameHits("app.ts", "pax", true), null);
  },
  search: (m) => {
    const r = m.treeSearch(CHILDREN, ROWS, "ap", "highlight", true);
    assert.deepEqual([...r.hits.keys()].sort(), ["src/app.ts", "src/util/apple.ts"]);
    assert.equal(r.count, 2);
    assert.equal(r.unloaded, true, "\"lib\" was never loaded: the search says so");
    assert.deepEqual(paths(r), paths({ rows: ROWS }), "highlighting shows all rows");
    assert.equal(m.treeSearch(LOADED, ROWS, "x", "highlight", true).unloaded, false, "a link is not an unloaded folder (it is not entered)");
  },
  filter: (m) => {
    assert.deepEqual(paths(m.treeSearch(CHILDREN, ROWS, "ap", "filter", true)), ["src", "src/app.ts", "src/util", "src/util/apple.ts"], "the hits and the folders above them");
    assert.deepEqual(paths(m.treeSearch(CHILDREN, ROWS, "util", "filter", true)), ["src", "src/util"], "the children of a matching folder drop out (VS Code)");
    assert.deepEqual(paths(m.treeSearch(CHILDREN, ROWS, "apple", "filter", false)), ["src", "src/util", "src/util/apple.ts"], "ALL folders above a hit, not only the next one");
    assert.deepEqual(paths(m.treeSearch(CHILDREN, ROWS, "", "filter", true)), paths({ rows: ROWS }), "without a pattern nothing is filtered");
  },
  // While typing: the first hit FROM THE FOCUS (wrapping around), and the matching segment (in a compact row not the row).
  jump: (m) => {
    const r = m.treeSearch(CHILDREN, ROWS, "ap", "highlight", true);
    const row = (p) => ROWS.findIndex((z) => z.path === p);
    assert.deepEqual(m.nextHit(ROWS, r.hits, 0), { index: row("src/app.ts"), path: "src/app.ts" }, "from the start: the first hit");
    assert.deepEqual(m.nextHit(ROWS, r.hits, row("src/util")), { index: row("src/util/apple.ts"), path: "src/util/apple.ts" }, "from the focus");
    assert.deepEqual(m.nextHit(ROWS, r.hits, row("README.md")), { index: row("src/app.ts"), path: "src/app.ts" }, "after the last one: from the beginning again (VS Code loop)");
    assert.equal(m.nextHit(ROWS, new Map(), 0), null);
    const compact = tree.visibleRows({ "": [e("a", "dir")], a: [e("a/b", "dir")], "a/b": [e("a/b/c.ts", "file")] }, new Set(["a/b"]), { compact: true });
    const rk = m.treeSearch({ "": [e("a", "dir")], a: [e("a/b", "dir")], "a/b": [e("a/b/c.ts", "file")] }, compact, "a", "highlight", false);
    assert.equal(m.nextHit(compact, rk.hits, 0).path, "a", "in the compact row \"a/b\" the matching segment \"a\"");
  },
  key: (m) => {
    const t = (x) => ({ code: "KeyF", metaKey: false, ctrlKey: false, altKey: true, shiftKey: false, ...x });
    assert.equal(m.isSearchKey(t({ metaKey: true }), true), true, "⌥⌘F");
    assert.equal(m.isSearchKey(t({ ctrlKey: true }), false), true, "Strg+Alt+F");
    assert.equal(m.isSearchKey(t({ ctrlKey: true }), true), false, "on the Mac not with Ctrl");
    assert.equal(m.isSearchKey(t({ metaKey: true, shiftKey: true }), true), false, "Alt+Shift+Cmd+F is another key");
    assert.equal(m.isSearchKey(t({ metaKey: true, code: "KeyG" }), true), false);
  },
};

test("Tree search: hits, highlighting, filtering, loaded content only, key", async () => {
  const m = await load("tree-search.ts");
  for (const check of Object.values(CHECKS)) check(m);
});

test("Tree search: every sabotage fails at its check", async (t) => {
  for (const k of copies) {
    assert.equal(k.places, 1, `sabotage "${k.name}" is stale: the spot occurs ${k.places}x in the source`);
    const m = await load(k.file);
    assert.throws(() => CHECKS[k.catches](m), `sabotage "${k.name}" went unnoticed by "${k.catches}"`);
  }
  t.diagnostic(`${copies.length} sabotages caught`);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
