// Command palette and editor helpers (editor navigation as in VS Code) — the pure computations, EXECUTED:
//
// (1) Palette (lib/commandPalette.ts): the mode from the prefix (`>` `@` `#` `:` `?`, files without a prefix — typing switches), the keys
//     of the palette (⇧⌘P and F1, ⌘P ⇧⌘O ⌘T ⌃G, matched by the key label, Mod = ⌘ only on the Mac) and its table (each prefix exactly once),
//     and the project of a file at workspace level (the longest folder, no prefix mix-up).
//     Entry scoring, `:12:4` (`rowColumn`/`rowsOffset`) and the flat symbol list (`symbolList`) are not in lib/commandPalette.ts any more;
//     their successors (the VS Code fuzzy scorer, `rowsTarget` with visible columns, `flatSymbols`/`symbolRows`) live in lib/fuzzy-scorer.ts
//     and lib/quick-input.ts and are guarded with their own sabotages in web/test/quick-input.test.mjs.
// (2) Breadcrumbs (lib/symbol-chain.ts `symbolChain`): the chain of nested symbols at a position, outermost first, with siblings;
//     a position outside ⇒ empty.
// (3) Sticky scroll (`stickyChain`): which ranges stick at the top at a scroll position (header above, end below), row by row, and
//     the cap of 5 (seven levels ⇒ five rows).
//
// Each sabotage is a copy of the source with ONE changed spot (the spot appears exactly once, otherwise the sabotage is stale);
// the assigned check must fail on it — the counter-test that the check enters the path it promises.
//
// Run:  node --test --test-reporter=tap web/test/editor-helpers.test.mjs
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

const SOURCES = { palette: read("src", "lib", "commandPalette.ts"), chain: read("src", "lib", "symbol-chain.ts") };
const FILE = { palette: "commandPalette.ts", chain: "symbol-chain.ts" };
const SABOTAGES = {
  palette: {
    "prefix anywhere": { old: "if (p && e.startsWith(p)) return { mode, rest: e.slice(p.length) };", fresh: "if (p && e.includes(p)) return { mode, rest: e.slice(e.indexOf(p) + 1) };", catches: "mode" },
    "Mod always ⌘": { old: `if (x === "mod") desired[mac ? "meta" : "ctrl"] = true;`, fresh: `if (x === "mod") desired.meta = true;`, catches: "keys" },
    "Shift ignored": { old: "if (CHARACTER.test(key)) return mods && e.shiftKey === desired.shift && ", fresh: "if (CHARACTER.test(key)) return mods && ", catches: "keys" },
    // The key LABEL counts (layout, keyCode), the position (`code`) only without both — on QWERTZ `KeyY` carries the "Z" (⌥Z; CodeMirror would type "Ω").
    "key via key": { old: "if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3).toLowerCase();", fresh: "", catches: "keys" },
    "layout skipped": { old: "if (b && CHARACTER.test(b)) return b.toLowerCase();", fresh: "", catches: "keys" },
    "keyCode skipped": { old: "if ((kc >= 65 && kc <= 90) || (kc >= 48 && kc <= 57)) return String.fromCharCode(kc).toLowerCase();", fresh: "", catches: "keys" },
    "punctuation only without modifier": { old: "return e.key === key && (e.shiftKey || !desired.shift) && (e.altKey || !desired.alt);", fresh: "return e.key === key && !e.shiftKey && !e.altKey;", catches: "keys" },
    // F1 opens the commands as in VS Code (the second key of `workbench.action.showCommands`), `?` is help.
    "F1 missing": { old: 'keys: ["Mod-Shift-p", "F1"]', fresh: 'keys: ["Mod-Shift-p"]', catches: "keys" },
    "no help": { old: 'row: ":", help: "?" }', fresh: 'row: ":", help: "" }', catches: "mode" },
    "project by prefix": { old: "!(abs === w || abs.startsWith(`${w}/`))) continue;", fresh: "!abs.startsWith(w)) continue;", catches: "project" },
    "first project wins": { old: "if (!best || w.length > normPath(best.path).length) best = p;", fresh: "if (!best) best = p;", catches: "project" },
    // A file's identity is a string comparison — "//", "/./" and a trailing slash used to yield two buffers.
    "file not normalised": { old: "const abs = normPath(`${wsPath}/", fresh: "const abs = (`${wsPath}/", catches: "project" },
    "project folder not normalised": { old: "const w = normPath(p?.path ?? \"\");", fresh: "const w = String(p?.path ?? \"\").replace(/\\/+$/, \"\");", catches: "project" },
    "\"..\" stays": { old: "if (part === \"..\") { if (out.length && out[out.length - 1] !== \"..\") out.pop(); else if (!abs) out.push(\"..\"); continue; }", fresh: "", catches: "project" },
  },
  chain: {
    "top level only": { old: "level = best.children ?? [];\n  }\n  return out;\n}\n\n/** At most", fresh: "level = [];\n  }\n  return out;\n}\n\n/** At most", catches: "breadcrumbs" },
    "end open": { old: "const contains = (r: LspRange, p: LspPos) => notAfter(r.start, p) && notAfter(p, r.end);", fresh: "const contains = (r: LspRange, p: LspPos) => notAfter(r.start, p);", catches: "breadcrumbs" },
    "no cap": { old: "while (out.length < max && level.length) {", fresh: "while (level.length) {", catches: "sticky" },
    "visible header sticks": { old: "if (header < z && end > z", fresh: "if (header <= z + 1 && end > z", catches: "sticky" },
    "end forgotten": { old: "if (header < z && end > z", fresh: "if (header < z", catches: "sticky" },
    "one line for all rows": { old: "const z = rowUnder(out.length);", fresh: "const z = rowUnder(0);", catches: "sticky" },
  },
};

// ── Compile: both modules, lib/api/lsp.ts (with a network-free stand-in for core.ts) and one copy per sabotage, in ONE tsc run. ──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-editor-helpers-"));
const src = path.join(tmp, "src"), out = path.join(tmp, "out");
fs.mkdirSync(path.join(src, "api"), { recursive: true });
fs.writeFileSync(path.join(src, "api", "lsp.ts"), read("src", "lib", "api", "lsp.ts"));
fs.writeFileSync(path.join(src, "api", "core.ts"), "export async function api<T = unknown>(p: string, _o?: RequestInit): Promise<T> { throw new Error(`no network in test: ${p}`); }\n");
for (const [k, q] of Object.entries(SOURCES)) fs.writeFileSync(path.join(src, FILE[k]), q);
const copies = [];
for (const [k, list] of Object.entries(SABOTAGES)) {
  for (const [name, s] of Object.entries(list)) {
    const file = FILE[k].replace(/\.ts$/, `-sabotage-${copies.length}.ts`);
    fs.writeFileSync(path.join(src, file), SOURCES[k].replace(s.old, s.fresh));
    copies.push({ name, module: k, file, catches: s.catches, places: SOURCES[k].split(s.old).length - 1 });
  }
}
const allTs = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? allTs(path.join(dir, e.name)) : [path.join(dir, e.name)]));
try {
  execFileSync(process.execPath, [tsc, ...allTs(src), "--outDir", out, "--rootDir", src, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler", "--strict", "--skipLibCheck", "--lib", "es2022,dom"], { stdio: "pipe" });
} catch (e) {
  const text = `${String(e.stdout || "")}${String(e.stderr || "")}`;
  const realError = text.split("\n").filter((z) => /error TS\d+/.test(z) && !/-sabotage-\d+\.ts\(/.test(z));
  if (realError.length || !fs.existsSync(path.join(out, "symbol-chain.js"))) throw new Error(`tsc: ${text}`.slice(0, 4000));
}
const load = (file) => import(pathToFileURL(path.join(out, file.replace(/\.ts$/, ".js"))).href);
const real = { palette: await load(FILE.palette), chain: await load(FILE.chain) };
const sabotaged = await Promise.all(copies.map(async (k) => ({ ...k, mod: await load(k.file) })));
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { console.warn("[test] temp directory left behind:", String(e?.message || e).slice(0, 120)); }

// ── Helpers ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const R = (l1, c1, l2, c2) => ({ start: { line: l1, character: c1 }, end: { line: l2, character: c2 } });
/** One symbol: range in lines [from, until] (0-based), name in the header line from column 6. */
const S = (name, from, until, children) => ({ name, kind: 5, range: R(from, 0, until, 1), selectionRange: R(from, 6, from, 6 + name.length), ...(children ? { children: children } : {}) });
const press = (code, mods = {}) => ({ code, key: code.replace(/^Key/, "").toLowerCase(), metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods });

// One file:              line
//  class Store            0–40
//    def checkout         2–20
//      def count          5–12
//    def receipt          22–39
//  def help               42–50
const LAYOUT = [S("Store", 0, 40, [S("checkout", 2, 20, [S("count", 5, 12)]), S("receipt", 22, 39)]), S("help", 42, 50)];

// ── The checks (each against one module, so the sabotages hit them) ────────────────────────────────────────────────────────────
const CHECKS = {
  mode(P) {
    assert.deepEqual(P.paletteMode(""), { mode: "files", rest: "" });
    assert.deepEqual(P.paletteMode("app.ts"), { mode: "files", rest: "app.ts" });
    assert.deepEqual(P.paletteMode(">form"), { mode: "commands", rest: "form" });
    assert.deepEqual(P.paletteMode("@checkout"), { mode: "symbols", rest: "checkout" });
    assert.deepEqual(P.paletteMode("#Store"), { mode: "workArea", rest: "Store" });
    assert.deepEqual(P.paletteMode(":12:4"), { mode: "row", rest: "12:4" });
    assert.deepEqual(P.paletteMode("?"), { mode: "help", rest: "" }, "`?` is help (VS Code `HelpQuickAccessProvider`)");
    assert.deepEqual(P.paletteMode("?>"), { mode: "help", rest: ">" });
    // Only at the FRONT is it a prefix — a `>` inside the file name stays file search.
    assert.deepEqual(P.paletteMode("a>b"), { mode: "files", rest: "a>b" }, "a character in the middle of the input switches mode");
    assert.deepEqual(P.paletteMode("x:12"), { mode: "files", rest: "x:12" });
    // Each prefix belongs to exactly one mode; "files" has none.
    const prefixes = Object.values(P.PREFIX).filter(Boolean);
    assert.equal(new Set(prefixes).size, prefixes.length, "a prefix twice");
    assert.equal(P.PREFIX.files, "");
  },
  keys(P) {
    const to = (e, mac = true) => P.paletteCommandToKey(e, mac)?.prefix ?? null;
    assert.equal(to(press("KeyP", { metaKey: true, shiftKey: true, key: "P" })), ">", "⇧⌘P");
    assert.equal(to(press("KeyP", { metaKey: true })), "", "⌘P");
    assert.equal(to(press("KeyO", { metaKey: true, shiftKey: true, key: "O" })), "@", "⇧⌘O");
    assert.equal(to(press("KeyT", { metaKey: true })), "#", "⌘T");
    assert.equal(to(press("KeyG", { ctrlKey: true })), ":", "⌃G");
    assert.equal(to({ ...press("F1"), key: "F1" }), ">", "F1 opens the commands (VS Code)");
    assert.equal(to({ ...press("F1", { shiftKey: true }), key: "F1" }), null, "⇧F1 is not F1");
    // Counter-proofs: on the Mac ⌃P is not ⌘P, ⌘G is not ⌃G, ⌥⌘P is nothing; elsewhere Ctrl is the Mod.
    assert.equal(to(press("KeyP", { ctrlKey: true })), null, "⌃P opens the palette on the Mac");
    assert.equal(to(press("KeyG", { metaKey: true })), null, "⌘G (find next) opens the palette");
    assert.equal(to(press("KeyP", { metaKey: true, altKey: true, key: "π" })), null, "⌥⌘P opens the palette");
    assert.equal(to(press("KeyP", { metaKey: true, shiftKey: true, key: "P" })), ">");
    assert.equal(to(press("KeyP", { ctrlKey: true }), false), "", "Ctrl+P outside the Mac");
    assert.equal(to(press("KeyP", { metaKey: true }), false), null, "⌘ does not count as Mod outside the Mac");
    // The key does not come via `key`: with ⇧ `key` is upper case, with ⌥ another character.
    assert.equal(to({ ...press("KeyT", { metaKey: true }), key: "†" }), "#", "the key is read via key");
    // As in VS Code the key LABEL counts — on QWERTZ the "Z" sits on `KeyY` (and the "Y" on `KeyZ`).
    const wrap = (e) => P.matchesKey("Alt-z", e, true);
    P.setKeyBindings(new Map([["KeyY", "z"], ["KeyZ", "y"]]));
    try {
      assert.ok(wrap(press("KeyY", { altKey: true, key: "Ω" })), "⌥Z on QWERTZ (layout): the key carrying the \"Z\"");
      assert.ok(!wrap(press("KeyZ", { altKey: true, key: "Ω" })), "on QWERTZ the US \"Z\" position is the \"Y\"");
    } finally { P.setKeyBindings(null); }
    assert.ok(wrap({ ...press("KeyY", { altKey: true, key: "Ω" }), keyCode: 90 }), "⌥Z on QWERTZ without layout: keyCode says \"Z\"");
    assert.ok(!wrap({ ...press("KeyZ", { altKey: true, key: "Ω" }), keyCode: 89 }), "without layout: keyCode \"Y\" is not ⌥Z");
    assert.ok(wrap(press("KeyZ", { altKey: true, key: "Ω" })), "without layout and keyCode: the position (US)");
    // A punctuation mark: the key carries or produces it — on a German layout "\\" is ⌥⇧7, with ⌘ it is ⌘\\ (VS Code: same key).
    const share = (e) => P.matchesKey("Mod-\\", e, true);
    assert.ok(share({ ...press("Backslash", { metaKey: true }), key: "\\", keyCode: 220 }), "⌘\\ (US)");
    assert.ok(share({ ...press("Digit7", { metaKey: true, altKey: true, shiftKey: true }), key: "\\", keyCode: 55 }), "⌘\\ on QWERTZ (⌥⇧7 produces \"\\\")");
    assert.ok(!share({ ...press("Digit7", { metaKey: true, shiftKey: true }), key: "/", keyCode: 55 }), "⇧⌘7 (German \"/\") is not ⌘\\");
    assert.ok(!share({ ...press("Backslash", {}), key: "\\" }), "\\ without ⌘ is not ⌘\\");
    // The table: each prefix exactly once, each command with shortcut and key.
    const prefixes = P.PALETTE_COMMANDS.map((b) => b.prefix);
    assert.deepEqual([...prefixes].sort(), ["", "#", ":", ">", "@"]);
    for (const b of P.PALETTE_COMMANDS) assert.ok(b.shortcut && b.keys.length && b.title.endsWith("…"), `${b.id} without shortcut, key or "…"`);
  },
  project(P) {
    const pr = [{ id: "a", path: "/ws/proj" }, { id: "b", path: "/ws/proj/inner/" }, { id: "c", path: "/ws/project2" }];
    assert.equal(P.projectOfTheFile("/ws", pr, "proj/src/app.py")?.id, "a");
    assert.equal(P.projectOfTheFile("/ws/", pr, "/proj/inner/x.py")?.id, "b", "the longest folder wins");
    assert.equal(P.projectOfTheFile("/ws", pr, "project2/m.py")?.id, "c", "\"proj\" does not reach \"project2\"");
    assert.equal(P.projectOfTheFile("/ws", pr.slice(0, 1), "project2/m.py"), null, "\"proj\" is not a folder of \"project2\"");
    assert.equal(P.projectOfTheFile("/ws", pr, "notes.md"), null);
    // Normalised like the server (`path.resolve`) — otherwise two buffers for one file.
    assert.equal(P.projectOfTheFile("/ws//", [{ id: "n", path: "/ws/./proj//" }], "proj//src/./app.py")?.id, "n", "\"//\", \"/./\" and the trailing slash do not count");
    assert.equal(P.projectOfTheFile("/ws", pr, "other/../proj/inner/x.py")?.id, "b", "\"..\" removes the part before");
    assert.deepEqual(["a//b/./c/", "/x/../../y", "../a/./b", "./", "/", "a/.."].map(P.normPath), ["a/b/c", "/y", "../a/b", "", "/", ""]);
  },
  breadcrumbs(K) {
    const names = (pos) => K.symbolChain(LAYOUT, pos).map((g) => g.symbol.name);
    assert.deepEqual(names({ line: 7, character: 2 }), ["Store", "checkout", "count"], "in count");
    assert.deepEqual(names({ line: 15, character: 0 }), ["Store", "checkout"], "in checkout, below count");
    assert.deepEqual(names({ line: 30, character: 0 }), ["Store", "receipt"]);
    assert.deepEqual(names({ line: 41, character: 0 }), [], "between the symbols");
    assert.deepEqual(names({ line: 46, character: 3 }), ["help"]);
    assert.deepEqual(names({ line: 40, character: 1 }), ["Store"], "the end belongs to it");
    assert.deepEqual(names({ line: 40, character: 2 }), [], "past the end");
    const k = K.symbolChain(LAYOUT, { line: 7, character: 0 });
    assert.deepEqual(k[0].siblings.map((s) => s.name), ["Store", "help"], "siblings of the top level");
    assert.deepEqual(k[1].siblings.map((s) => s.name), ["checkout", "receipt"]);
    assert.deepEqual(K.symbolChain(null, { line: 0, character: 0 }), []);
  },
  sticky(K) {
    const chain = (top, cap) => K.stickyChain(LAYOUT, (i) => top + i, cap).map((s) => s.name);
    assert.deepEqual(chain(0), [], "nothing sticks at the very top (the header is visible)");
    assert.deepEqual(chain(1), ["Store"], "line 0 has scrolled out");
    assert.deepEqual(chain(2), ["Store", "checkout"], "row 0 covers line 2 (the header of checkout), row 1 line 3 — checkout sticks");
    assert.deepEqual(chain(3), ["Store", "checkout"]);
    assert.deepEqual(chain(6), ["Store", "checkout", "count"]);
    assert.deepEqual(chain(10), ["Store", "checkout"], "count ends in line 12 — it lies below row 2: count no longer sticks");
    assert.deepEqual(chain(25), ["Store", "receipt"]);
    assert.deepEqual(chain(39), ["Store"], "receipt ends in line 39 — line 40 lies below row 1: receipt no longer sticks");
    assert.deepEqual(chain(40), [], "Store ends in line 40 = below row 0 ⇒ nothing sticks any more");
    assert.deepEqual(chain(44), ["help"]);
    // The cap: seven nested levels, scrolled deep in ⇒ at most five rows, the outer ones first.
    let deep = S("e7", 6, 94);
    for (let n = 6; n >= 1; n--) deep = S(`e${n}`, n - 1, 100 - n, [deep]);
    const seven = K.stickyChain([deep], (i) => 50 + i).map((s) => s.name);
    assert.deepEqual(seven, ["e1", "e2", "e3", "e4", "e5"], "the cap of 5");
    assert.equal(K.STICKY_CAP, 5);
    assert.deepEqual(K.stickyChain([deep], (i) => 50 + i, 2).map((s) => s.name), ["e1", "e2"]);
    // A child on the same line as its parent symbol (export class … { constructor) gets no second row for that line.
    const equal = [S("outside", 0, 30, [S("inside", 0, 29, [S("kind", 2, 28)])])];
    assert.deepEqual(K.stickyChain(equal, (i) => 10 + i).map((s) => s.name), ["outside", "kind"]);
  },
};

test("(1) palette: mode from the prefix, keys, project of the file", () => {
  for (const k of ["mode", "keys", "project"]) {
    try { CHECKS[k](real.palette); } catch (e) { throw new Error(`${k}: ${e.message}`); }
  }
});

test("(2)/(3) breadcrumbs and sticky scroll from the same layout", () => {
  for (const k of ["breadcrumbs", "sticky"]) {
    try { CHECKS[k](real.chain); } catch (e) { throw new Error(`${k}: ${e.message}`); }
  }
});

test("counter-tests: each sabotage appears exactly once in the source and is caught by its check", () => {
  const stale = copies.filter((k) => k.places !== 1).map((k) => `${k.name} (${k.places}×)`);
  assert.deepEqual(stale, [], "sabotages whose spot is not exactly once in the source");
  const notCaught = [];
  for (const s of sabotaged) {
    let caught = false;
    try { CHECKS[s.catches](s.mod); } catch { caught = true; }
    if (!caught) notCaught.push(`${s.name} (${s.catches})`);
  }
  assert.deepEqual(notCaught, [], "sabotages no check catches");
  console.log(`  [editor-helpers] ${sabotaged.length} sabotages, each caught`);
});
