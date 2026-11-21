// Status bar and outline of the editor as in VS Code:
//
// (1) The computations, EXECUTED:
//     lib/editor-status.ts — the visible column (a tab jumps to the tab stop, 1-based), characters over all selections, the text as VS
//       Code `getSelectionLabel`, the guessed indentation (tab against spaces, most frequent step, a tie takes the smaller one, without a
//       hint the preset) and what the editor makes of it (unit + tab size, tab at the insertion mark), language mode (whole names first)
//       and line ending;
//     lib/symbol-kinds.ts — kinds as number or name, colour per group (light/dark; property, struct, constant in the text colour as VS
//       Code), the codicon per kind as `SymbolKinds.toIcon`, the order as `DocumentSymbolComparator` (position · name · category, at every
//       depth), visible rows after collapsing, the chain of symbols at the cursor (inside to outside, with end limit), "collapse all" at every
//       depth;
//     lib/codicon-symbols.ts — every name VS Code gives a kind has a path, equal code points the same glyph;
//     lib/diagnostic-status.ts — severity as number or word, forgetting, reporting only real changes, sum without duplicates and without
//       unknowns (with `known`/`files`: no known number is UNKNOWN), relocation on rename (the number moves along, an occupied target stays).
// (2) The sources: every status bar entry in the SAME form (the language service too), "line, column" opens the palette with `:`, the
//     counters read the stock and a closed buffer stops counting, unknown shows "–" and the numbers are in the name; the indentation is the
//     one the editor runs (facets from components/code/indentation.ts, hooked into the BufferEditor, tab as VS Code); CodePane inserts the old
//     toggles as entries and passes the line ending of the buffer; the outline follows the cursor; the breadcrumbs under the tabs — the file
//     with a file symbol, a folder segment reads its entries via `/files/tree` WITH the instance of the view, the sheet hangs on the body via
//     portal and closes via document `mousedown` (no click catcher); a segment shows its SIBLINGS, the bar scrolls inside itself and stays at
//     the end; the outline draws the codicon and orders by the remembered choice in the "…".
//
// Each sabotage is a copy of the source with ONE changed spot (exactly once there); the assigned check must fail on it.
//
// Run:  node --test --test-reporter=tap web/test/editor-status.test.mjs
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

const LIBS = { status: "editor-status", kinds: "symbol-kinds", diagnostic: "diagnostic-status", icons: "codicon-symbols" };
const SOURCES = Object.fromEntries(Object.entries(LIBS).map(([k, d]) => [k, read("src", "lib", `${d}.ts`)]));
const SABOTAGES = {
  "tab counts one": { lib: "status", old: "column = row[i] === \"\\t\" ? column + tg - (column % tg) : column + 1;", fresh: "column = column + 1;", catches: "column" },
  "column 0-based": { lib: "status", old: "return column + 1;", fresh: "return column;", catches: "column" },
  "several selections with line": { lib: "status", old: "  if (l.selections > 1) {\n", fresh: "  if (false) {\n", catches: "selectionText" },
  "selection without characters": { lib: "status", old: "? { key: \"{a} selections ({n} characters selected)\", values: { a: l.selections, n: l.character } }", fresh: "? { key: \"{a} selections\", values: { a: l.selections } }", catches: "selectionText" },
  "tab file with spaces": { lib: "status", old: "return e.kind === \"tab\" ? { unit: \"\\t\", tabSize: Math.max(1, defaultTab) }", fresh: "return e.kind === \"tab\" ? { unit: \" \".repeat(defaultTab), tabSize: Math.max(1, defaultTab) }", catches: "facets" },
  "spaces with tab size of the setting": { lib: "status", old: "tabSize: Math.max(1, e.width) };", fresh: "tabSize: 4 };", catches: "facets" },
  "tab inserts spaces in tab files": { lib: "status", old: "  if (unit.includes(\"\\t\")) return \"\\t\";\n", fresh: "", catches: "facets" },
  "tab fills a whole step": { lib: "status", old: "return \" \".repeat(n - ((visibleColumn(row, offset, tabSize) - 1) % n));", fresh: "return \" \".repeat(n);", catches: "facets" },
  "status bar guesses tabs as spaces": { lib: "status", old: "return unit.includes(\"\\t\") ? { kind: \"tab\", width: tabSize }", fresh: "return false ? { kind: \"tab\", width: tabSize }", catches: "facets" },
  "characters of the first selection only": { lib: "status", old: "o.areas.reduce((s, b) => s + Math.abs(b.to - b.from), 0)", fresh: "Math.abs((o.areas[0]?.to ?? 0) - (o.areas[0]?.from ?? 0))", catches: "column" },
  "tabs overlooked": { lib: "status", old: "if (tabs > empty) return { kind: \"tab\", width: preset.width };", fresh: "", catches: "indentation" },
  "tie takes the larger": { lib: "status", old: "(c === count && d < best)", fresh: "(c === count && d > best)", catches: "indentation" },
  "without hint not the preset": { lib: "status", old: "if (!empty) return preset;", fresh: "", catches: "indentation" },
  "whole names overlooked": { lib: "status", old: "if (WHOLE[name]) return WHOLE[name];", fresh: "", catches: "language" },
  "CRLF as LF": { lib: "status", old: "(ze === \"\\r\\n\" ? \"CRLF\" : \"LF\")", fresh: "(\"LF\" as \"LF\" | \"CRLF\")", catches: "language" },
  "name not translated": { lib: "kinds", old: "Math.max(0, NAMES.indexOf(String(kind).toLowerCase()))", fresh: "0", catches: "kinds" },
  "method as variable": { lib: "kinds", old: "6: \"method\", 9: \"method\"", fresh: "6: \"variable\", 9: \"method\"", catches: "kinds" },
  "property blue": { lib: "kinds", old: "  8: \"variable\", 11: \"variable\"", fresh: "  7: \"variable\", 8: \"variable\", 11: \"variable\"", catches: "kinds" },
  "struct orange": { lib: "kinds", old: "5: \"kind\", 10: \"kind\", 24: \"kind\",", fresh: "5: \"kind\", 10: \"kind\", 23: \"kind\", 24: \"kind\",", catches: "kinds" },
  "icon without fallback": { lib: "kinds", old: ": \"symbol-property\";", fresh: ": \"\";", catches: "kinds" },
  "icon with space": { lib: "kinds", old: "NAMES[n].replace(/ /g, \"-\")", fresh: "NAMES[n]", catches: "kinds" },
  "position by line only": { lib: "kinds", old: "a.line - b.line || a.character - b.character;", fresh: "a.line - b.line;", catches: "sorting" },
  "position without name": { lib: "kinds", old: "position: (a, b) => compareArea(a.range, b.range) || compareName(a.name, b.name),", fresh: "position: (a, b) => compareArea(a.range, b.range),", catches: "sorting" },
  "name without numbers": { lib: "kinds", old: "{ numeric: true }", fresh: "{ numeric: false }", catches: "sorting" },
  "category by name": { lib: "kinds", old: "kind: (a, b) => kindNumber(a.kind) - kindNumber(b.kind) || ", fresh: "kind: (a, b) => ", catches: "sorting" },
  "category without name": { lib: "kinds", old: "kindNumber(b.kind) || compareName(a.name, b.name),", fresh: "kindNumber(b.kind),", catches: "sorting" },
  "children not sorted": { lib: "kinds", old: "{ ...s, children: sortSymbols(s.children, ordering) }", fresh: "s", catches: "sorting" },
  "sorting changes the original": { lib: "kinds", old: "return [...(symbols ?? [])].sort(f)", fresh: "return ((symbols ?? []) as TreeSymbol[]).sort(f)", catches: "sorting" },
  "unknown ordering stays": { lib: "kinds", old: "? (v as SymbolOrdering) : \"position\");", fresh: "? (v as SymbolOrdering) : (v as SymbolOrdering));", catches: "sorting" },
  "function without glyph": { lib: "icons", old: "\"symbol-function\": \"symbol-method\", ", fresh: "", catches: "icons" },
  "null without glyph": { lib: "icons", old: "\"symbol-null\": \"symbol-boolean\",", fresh: "", catches: "icons" },
  "name instead of glyph": { lib: "icons", old: "return GLYPH[EQUAL[name] ?? name] ?? null;", fresh: "return GLYPH[name] ?? null;", catches: "icons" },
  "light and dark swapped": { lib: "kinds", old: "return f ? (dark ? f.dark : f.light) : null;", fresh: "return f ? (dark ? f.light : f.dark) : null;", catches: "kinds" },
  "collapsed shows children": { lib: "kinds", old: "const open = hasChildren && !closed.has(id);", fresh: "const open = hasChildren;", catches: "tree" },
  "chain outside only": { lib: "kinds", old: "level = level[i].children ?? [];", fresh: "level = [];", catches: "tree" },
  "chain without end limit": { lib: "kinds", old: "beforeOrEqual(s.range.start, pos) && beforeOrEqual(pos, s.range.end)", fresh: "beforeOrEqual(s.range.start, pos)", catches: "tree" },
  "collapse all only at the top": { lib: "kinds", old: "return treeRows(symbols, new Set()).filter((z) => z.hasChildren).map((z) => z.id);", fresh: "return (symbols ?? []).flatMap((s, i) => (s.children?.length ? [String(i)] : []));", catches: "tree" },
  "warning as error": { lib: "diagnostic", old: "if (s === 1 || s === \"error\") error++;", fresh: "if (s === 1 || s === \"error\" || s === 2) error++;", catches: "diagnostic" },
  "word not counted": { lib: "diagnostic", old: "else if (s === 2 || s === \"warning\") warnings++;", fresh: "else if (s === 2) warnings++;", catches: "diagnostic" },
  "forgetting does not work": { lib: "diagnostic", old: "if (z === null) { if (!old) return; STATE.delete(key); }", fresh: "if (z === null) { return; }", catches: "diagnostic" },
  "reports the same": { lib: "diagnostic", old: "if (old && old.error === z.error && old.warnings === z.warnings && (old.infos ?? 0) === (z.infos ?? 0)) return;", fresh: "", catches: "diagnostic" },
  // The badge on the PROBLEMS tab counts infos too (VS Code `ActivityUpdater`).
  "infos not counted": { lib: "diagnostic", old: "else if (s === 3 || s === \"info\") infos++;", fresh: "", catches: "diagnostic" },
  "infos not summed": { lib: "diagnostic", old: "infos += z.infos ?? 0;", fresh: "", catches: "diagnostic" },
  "sum twice": { lib: "diagnostic", old: "for (const k of new Set(key))", fresh: "for (const k of key)", catches: "diagnostic" },
  "unknown counts as known": { lib: "diagnostic", old: "if (z) { known++; error += z.error;", fresh: "known++; if (z) { error += z.error;", catches: "diagnostic" },
  "relocation forgets the number": { lib: "diagnostic", old: "for (const [, k2, z] of relocation) STATE.set(k2, z);", fresh: "", catches: "diagnostic" },
  "relocation overwrites an occupied target": { lib: "diagnostic", old: " && !STATE.has(k2)) relocation.push", fresh: ") relocation.push", catches: "diagnostic" },
  "relocation reports nothing": { lib: "diagnostic", old: "  for (const [, k2, z] of relocation) STATE.set(k2, z);\n  version++;\n  for (const fn of [...LISTENERS]) fn();", fresh: "  for (const [, k2, z] of relocation) STATE.set(k2, z);", catches: "diagnostic" },
};

// ── Compile: the sources and one copy per sabotage, in ONE tsc run. ──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-editor-status-"));
const src = path.join(tmp, "src"), out = path.join(tmp, "out");
fs.mkdirSync(src, { recursive: true });
for (const [k, d] of Object.entries(LIBS)) fs.writeFileSync(path.join(src, `${d}.ts`), SOURCES[k]);
const copies = [];
for (const [name, s] of Object.entries(SABOTAGES)) {
  const file = `${LIBS[s.lib]}-sabotage-${copies.length}.ts`;
  fs.writeFileSync(path.join(src, file), SOURCES[s.lib].replace(s.old, s.fresh));
  copies.push({ name, file, lib: s.lib, catches: s.catches, places: SOURCES[s.lib].split(s.old).length - 1 });
}
try {
  execFileSync(process.execPath, [tsc, ...fs.readdirSync(src).map((d) => path.join(src, d)), "--outDir", out, "--rootDir", src, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler", "--strict", "--skipLibCheck", "--lib", "es2022,dom"], { stdio: "pipe" });
} catch (e) {
  const text = `${String(e.stdout || "")}${String(e.stderr || "")}`;
  const realError = text.split("\n").filter((z) => /error TS\d+/.test(z) && !/-sabotage-\d+\.ts\(/.test(z));
  if (realError.length || Object.values(LIBS).some((d) => !fs.existsSync(path.join(out, `${d}.js`)))) throw new Error(`tsc: ${text}`.slice(0, 4000));
}
const load = (file) => import(pathToFileURL(path.join(out, file.replace(/\.ts$/, ".js"))).href);
const real = Object.fromEntries(await Promise.all(Object.entries(LIBS).map(async ([k, d]) => [k, await load(`${d}.ts`)])));
const sabotaged = await Promise.all(copies.map(async (k) => ({ ...k, mod: await load(k.file) })));
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { console.warn("[test] temp directory was left behind:", String(e?.message || e).slice(0, 120)); }

// ── Checks ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const P = (line, character) => ({ line, character });
const sym = (name, kind, from, until, children) => ({ name, kind, range: { start: from, end: until }, selectionRange: { start: from, end: from }, ...(children ? { children } : {}) });
const SYMBOLS = [
  sym("A", 5, P(0, 0), P(10, 1), [sym("m", 6, P(1, 2), P(4, 3), [sym("x", 13, P(2, 4), P(2, 20))]), sym("f", 8, P(5, 2), P(5, 10))]),
  sym("g", "function", P(12, 0), P(14, 1)),
];
// VS Code `SymbolKinds.toIcon` (src/vs/editor/common/languages.ts) — LSP number → codicon.
const VS_CODE_ICONS = {
  1: "symbol-file", 2: "symbol-module", 3: "symbol-namespace", 4: "symbol-package", 5: "symbol-class", 6: "symbol-method", 7: "symbol-property",
  8: "symbol-field", 9: "symbol-constructor", 10: "symbol-enum", 11: "symbol-interface", 12: "symbol-function", 13: "symbol-variable",
  14: "symbol-constant", 15: "symbol-string", 16: "symbol-number", 17: "symbol-boolean", 18: "symbol-array", 19: "symbol-object", 20: "symbol-key",
  21: "symbol-null", 22: "symbol-enum-member", 23: "symbol-struct", 24: "symbol-event", 25: "symbol-operator", 26: "symbol-type-parameter",
};
const CHECKS = {
  column(L) {
    assert.equal(L.visibleColumn("abc", 0, 4), 1, "1-based");
    assert.equal(L.visibleColumn("abc", 2, 4), 3);
    assert.equal(L.visibleColumn("\tx", 1, 4), 5, "a tab jumps to the tab stop");
    assert.equal(L.visibleColumn("ab\tx", 3, 4), 5, "a tab after two characters fills up to 4");
    assert.equal(L.visibleColumn("\t\tx", 2, 2), 5);
    const situation = L.selectionSituation({ row: 3, rowText: "\tfoo", offsetInLine: 2, tabSize: 2, areas: [{ from: 10, to: 14 }, { from: 20, to: 22 }] });
    assert.deepEqual(situation, { row: 3, column: 4, character: 6, selections: 2 }, "characters over all selections");
  },
  selectionText(L) {
    // VS Code `getSelectionLabel` (editorStatus.ts).
    assert.deepEqual(L.selectionText({ row: 3, column: 4, character: 0, selections: 1 }), { key: "Ln {z}, Col {s}", values: { z: 3, s: 4 } });
    assert.deepEqual(L.selectionText({ row: 3, column: 4, character: 5, selections: 1 }), { key: "Ln {z}, Col {s} ({n} selected)", values: { z: 3, s: 4, n: 5 } });
    assert.deepEqual(L.selectionText({ row: 3, column: 4, character: 12, selections: 3 }), { key: "{a} selections ({n} characters selected)", values: { a: 3, n: 12 } }, "several selections: without line and column");
    assert.deepEqual(L.selectionText({ row: 3, column: 4, character: 0, selections: 3 }), { key: "{a} selections", values: { a: 3 } }, "several cursors without characters");
  },
  facets(L) {
    // VS Code `detectIndentation`: a tab file indents with a tab (width = setting), a spaces file with its step (tab size = step).
    assert.deepEqual(L.indentationFacets({ kind: "tab", width: 4 }, 8), { unit: "\t", tabSize: 8 });
    assert.deepEqual(L.indentationFacets({ kind: "empty", width: 2 }, 8), { unit: "  ", tabSize: 2 });
    assert.deepEqual(L.indentationFromFacets("\t", 8), { kind: "tab", width: 8 }, "the status bar reads the facets back");
    assert.deepEqual(L.indentationFromFacets("    ", 4), { kind: "empty", width: 4 });
    assert.equal(L.tabInsertion("\t", "  ab", 2, 4), "\t", "tab in a tab file: a tab at the insertion mark");
    assert.equal(L.tabInsertion("    ", "ab", 2, 4), "  ", "spaces up to the next step");
    assert.equal(L.tabInsertion("  ", "", 0, 2), "  ", "at the line start a whole step");
    assert.equal(L.tabInsertion("    ", "\tx", 2, 4), "   ", "the visible column counts (a tab before)");
  },
  indentation(L) {
    const V = { kind: "empty", width: 4 };
    assert.deepEqual(L.indentationDetect("a\n  b\n    c\n  d\n", V), { kind: "empty", width: 2 });
    assert.deepEqual(L.indentationDetect("a\n\tb\n\t\tc\n", V), { kind: "tab", width: 4 }, "tabs in front");
    assert.deepEqual(L.indentationDetect("a\n  b\na\n    c\na\n", V), { kind: "empty", width: 2 }, "tie: the smaller step");
    assert.deepEqual(L.indentationDetect("a\nb\n", { kind: "tab", width: 8 }), { kind: "tab", width: 8 }, "without hint the preset");
  },
  language(L) {
    assert.equal(L.languageName("src/App.tsx"), "TypeScript JSX");
    assert.equal(L.languageName("Dockerfile"), "Dockerfile", "whole names first");
    assert.equal(L.languageName("tsconfig.json"), "JSON with Comments");
    assert.equal(L.languageName(".env.local"), "Dotenv");
    assert.equal(L.languageName("x.unknown"), "Plain Text");
    assert.equal(L.lineEndingName("\r\n"), "CRLF");
    assert.equal(L.lineEndingName("\n"), "LF");
  },
  kinds(A) {
    assert.equal(A.symbolGroup("class"), "kind", "a kind as name");
    assert.equal(A.symbolGroup("enum member"), "variable");
    assert.equal(A.symbolGroup(6), "method");
    assert.equal(A.symbolGroup(12), "method");
    assert.equal(A.symbolGroup(13), "variable");
    assert.equal(A.symbolGroup(2), "otherwise");
    assert.equal(A.symbolColor(5, true), "#ee9d28");
    assert.equal(A.symbolColor(5, false), "#d67e00");
    assert.equal(A.symbolColor(2, true), null, "the rest in the text colour");
    // VS Code `symbolIcon.propertyForeground`/`structForeground`/`constantForeground` = foreground.
    for (const k of [7, 14, 23]) assert.equal(A.symbolColor(k, true), null, `kind ${k} in the text colour as VS Code`);
    assert.equal(A.symbolColor(8, true), "#75beff", "fields blue");
    for (const [k, name] of Object.entries(VS_CODE_ICONS)) assert.equal(A.symbolIcon(Number(k)), name, `codicon of kind ${k}`);
    assert.equal(A.symbolIcon("enum member"), "symbol-enum-member", "a kind as name");
    assert.equal(A.symbolIcon(0), "symbol-property", "unknown as VS Code");
    assert.equal(A.symbolIcon(99), "symbol-property");
  },
  sorting(A) {
    // VS Code `DocumentSymbolComparator`; the input stays unchanged.
    const input = [
      sym("c", 12, P(5, 0), P(5, 5)),
      sym("b10", 13, P(5, 0), P(5, 5)),
      sym("b2", 5, P(1, 0), P(3, 0), [sym("z", 6, P(2, 0), P(2, 3)), sym("a", 8, P(1, 4), P(1, 8))]),
      sym("a", 12, P(5, 0), P(5, 9)),
    ];
    const names = (l) => l.map((s) => s.name);
    const pos = A.sortSymbols(input, "position");
    assert.deepEqual(names(pos), ["b2", "b10", "c", "a"], "position: start, end, then name");
    assert.deepEqual(names(pos[0].children), ["a", "z"], "at every depth");
    assert.deepEqual(names(A.sortSymbols(input, "name")), ["a", "b2", "b10", "c"], "name: numbers as numbers");
    assert.deepEqual(names(A.sortSymbols(input, "kind")), ["b2", "a", "c", "b10"], "category: kind, then name");
    assert.deepEqual(names(input), ["c", "b10", "b2", "a"], "the input stays");
    assert.deepEqual(names(input[2].children), ["z", "a"], "the children of the input too");
    assert.deepEqual([A.asOrdering("name"), A.asOrdering("kind"), A.asOrdering("nonsense"), A.asOrdering(null)], ["name", "kind", "position", "position"], "remembered: known values only");
  },
  icons(I) {
    const paths = Object.values(VS_CODE_ICONS).map((n) => I.codiconPath(n));
    assert.ok(paths.every((p) => typeof p === "string" && /^M[\s\S]*Z$/.test(p)), "a name without path");
    assert.equal(new Set(paths).size, 19, "19 different images for 26 kinds (string and key are the same \"abc\" in the codicons)");
    assert.equal(I.codiconPath("symbol-function"), I.codiconPath("symbol-method"), "same code point, same glyph");
    assert.equal(I.codiconPath("symbol-null"), I.codiconPath("symbol-boolean"));
    assert.equal(I.codiconPath("symbol-package"), I.codiconPath("symbol-namespace"));
    assert.equal(I.codiconPath("exists-not"), null);
  },
  tree(A) {
    assert.deepEqual(A.treeRows(SYMBOLS, new Set()).map((z) => `${z.id}:${z.depth}`), ["0:0", "0.0:1", "0.0.0:2", "0.1:1", "1:0"]);
    assert.deepEqual(A.treeRows(SYMBOLS, new Set(["0.0"])).map((z) => z.id), ["0", "0.0", "0.1", "1"], "collapsed: the children are missing");
    assert.deepEqual(A.chainsIds(SYMBOLS, P(2, 6)), ["0", "0.0", "0.0.0"], "the chain at the cursor, outside first");
    assert.deepEqual(A.chainsIds(SYMBOLS, P(5, 4)), ["0", "0.1"]);
    assert.deepEqual(A.chainsIds(SYMBOLS, P(11, 0)), [], "between two symbols none");
    assert.deepEqual(A.chainsIds(SYMBOLS, P(13, 0)), ["1"]);
    assert.deepEqual(A.allWithChildren(SYMBOLS), ["0", "0.0"], "collapse all: every depth");
  },
  diagnostic(D) {
    assert.deepEqual(D.countSeverity([{ severity: 1 }, { severity: "error" }, { severity: 2 }, { severity: "warning" }, { severity: 3 }, { severity: "info" }, { severity: 4 }, {}]), { error: 2, warnings: 2, infos: 2 }, "hints (4) never count");
    let notices = 0;
    const release = D.subscribeDiagnostics(() => { notices++; });
    try {
      assert.equal(D.diagnosticsOf("t:a"), null, "never asked: unknown");
      D.setDiagnostics("t:a", { error: 1, warnings: 2 });
      D.setDiagnostics("t:a", { error: 1, warnings: 2 });
      assert.equal(notices, 1, "the same number reports nothing");
      D.setDiagnostics("t:b", { error: 0, warnings: 1, infos: 2 });
      assert.deepEqual(D.sumDiagnostics(["t:a", "t:b", "t:a", "t:unknown"]), { error: 1, warnings: 3, infos: 2, known: 2, files: 3 }, "sum without duplicates and unknowns");
      D.setDiagnostics("t:b", { error: 0, warnings: 1, infos: 3 });
      assert.equal(notices, 3, "a new number of infos reports");
      D.setDiagnostics("t:a", null);
      assert.equal(D.diagnosticsOf("t:a"), null, "forget");
      assert.deepEqual(D.sumDiagnostics(["t:a", "t:b"]), { error: 0, warnings: 1, infos: 3, known: 1, files: 2 });
      assert.deepEqual(D.sumDiagnostics(["t:never"]), { error: 0, warnings: 0, infos: 0, known: 0, files: 1 }, "never asked is unknown, not \"no problems\"");
      // Renaming: the number moves along, an occupied target stays, a relocation reports.
      D.setDiagnostics("t:src/x", { error: 2, warnings: 0, infos: 1 });
      D.setDiagnostics("t:lib/y", { error: 0, warnings: 5 });
      D.setDiagnostics("t:src/y", { error: 9, warnings: 9 });
      const prior = notices;
      D.relocateDiagnostics((k) => (k.startsWith("t:src/") ? `t:lib/${k.slice(6)}` : null));
      assert.deepEqual([D.diagnosticsOf("t:lib/x"), D.diagnosticsOf("t:src/x")], [{ error: 2, warnings: 0, infos: 1 }, null], "the number moves along");
      assert.deepEqual([D.diagnosticsOf("t:lib/y"), D.diagnosticsOf("t:src/y")], [{ error: 0, warnings: 5, infos: 0 }, { error: 9, warnings: 9, infos: 0 }], "an occupied target stays");
      assert.equal(notices, prior + 1, "the relocation reports once");
      D.relocateDiagnostics(() => null);
      assert.equal(notices, prior + 1, "no relocation reports nothing");
      for (const k of ["t:b", "t:lib/x", "t:lib/y", "t:src/y"]) D.setDiagnostics(k, null);
    } finally { release(); }
  },
};
const LIB_THE_CHECK = { column: "status", selectionText: "status", facets: "status", indentation: "status", language: "status", kinds: "kinds", sorting: "kinds", tree: "kinds", diagnostic: "diagnostic", icons: "icons" };

test("(1) computations: column, indentation, language, kinds, tree, diagnostics", () => {
  for (const [k, check] of Object.entries(CHECKS)) {
    try { check(real[LIB_THE_CHECK[k]]); } catch (e) { throw new Error(`${k}: ${e.message}`); }
  }
});

test("(1) counter-tests: every sabotage occurs exactly once in its source and is caught by its check", () => {
  const stale = copies.filter((k) => k.places !== 1).map((k) => `${k.name} (${k.places}×)`);
  assert.deepEqual(stale, [], "sabotages whose spot does not occur exactly once in the source");
  const fakeLib = copies.filter((k) => LIB_THE_CHECK[k.catches] !== k.lib).map((k) => k.name);
  assert.deepEqual(fakeLib, [], "sabotage and check belong to different files");
  const notCaught = [];
  for (const s of sabotaged) {
    let caught = false;
    try { CHECKS[s.catches](s.mod); } catch { caught = true; }
    if (!caught) notCaught.push(`${s.name} (${s.catches})`);
  }
  assert.deepEqual(notCaught, [], "sabotages that no check catches");
  console.log(`  [editor-status] ${sabotaged.length} sabotages, each caught`);
});

// ── (2) The sources ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const withoutComments = (s) => s.replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
const Q = {
  bar: read("src", "components", "code", "StatusBar.tsx"),
  lsp: read("src", "components", "code", "LspStatusLine.tsx"),
  tree: read("src", "components", "code", "LayoutTree.tsx"),
  content: read("src", "components", "code", "LayoutContent.tsx"),
  actions: read("src", "components", "code", "LayoutActions.tsx"),
  pane: read("src", "components", "CodePane.tsx"),
  crumbs: read("src", "components", "code", "Breadcrumbs.tsx"),
  indent: read("src", "components", "code", "indentation.ts"),
  buffer: read("src", "components", "code", "BufferEditor.tsx"),
  cursor: read("src", "components", "code", "cursor-position.ts"),
};
const SOURCE_CHECKS = {
  statusBar(q) {
    const l = withoutComments(q.bar);
    assert.ok(withoutComments(q.lsp).includes("const BUTTON = STATUS_ENTRY;"), "the language service has a form of its own");
    assert.ok(l.includes("openPalette({ input: \":\", source: v ? sourceForView(v) : null });"), "\"line, column\" does not open \"Go to Line\"");
    assert.ok(l.includes("return sumDiagnostics(key);"), "the counters do not read the stock");
    assert.ok(l.includes("atClose((p) => setDiagnostics(p.key, null));"), "a closed buffer keeps counting");
    assert.ok(l.includes("atRename((target, old, fresh, newTarget) => relocateDiagnostics((k) => renamedKey(k, target, old, fresh, newTarget)));"), "a renamed file loses its number");
    assert.ok(l.includes("className=\"flex h-[22px] shrink-0 items-stretch"), "the bar is not 22 px high");
    // Unknown is not 0, the numbers are in the name; the text comes from selectionText.
    assert.ok(l.includes("{known ? z.error : \"–\"}") && l.includes("{known ? z.warnings : \"–\"}"), "unknown problems show as 0");
    assert.ok(l.includes("const known = z.known > 0;") && l.includes("z.known === z.files ? t(\"No problems\") : t(\"No known problems\")"), "\"No problems\" without a known number");
    assert.ok(l.includes("<StatusEntry title={title} name={name} on={on} onClick={onClick}") && l.includes("aria-label={name}"), "the counter gives screen readers no numbers");
    assert.ok(l.includes("const a = selectionText(situation);"), "\"line, column\" computes past the text of VS Code");
    assert.ok(!l.includes("indentationDetect("), "the status bar guesses the indentation itself (instead of reading what the editor runs)");
    assert.ok(!/<button(?![^>]*className=\{`\$\{STATUS_ENTRY\})/.test(l), "a bar button without the form of the entries");
  },
  pane(q) {
    const c = withoutComments(q.pane);
    const a = c.indexOf("<StatusBar"), e = c.indexOf("{settingsOpen && <SettingsModal");
    assert.ok(a > 0 && e > a, "CodePane does not render the status bar");
    const bar = c.slice(a, e);
    for (const must of [
      "<ProblemCounter t={t} target={target} paths={tabs.map((x) => x.path)} on={bottom === \"problems\"}",
      "<StatusEntry title={t(\"Debug panel\")}", "<CursorEntry t={t} view={activeView}", "lineEnding={pa.status.lineEnding}",
      "<LspStatusLine ", "<StatusEntry title={t(\"Zen mode (explorer off)\")}", "<StatusEntry title={t(\"Toggle terminal (Ctrl+`)\")}",
    ]) assert.ok(bar.includes(must), `missing in the status bar: ${must}`);
    assert.ok(!/<button\b/.test(bar), "a status bar toggle in its own form");
  },
  crumbs(q) {
    const k = withoutComments(q.crumbs);
    assert.ok(k.includes("instancePath(`${target.apiBase}/files/tree?path=${encodeURIComponent(folder)}`, target.instance)"), "the folder list reads past the instance of the view");
    assert.ok(k.includes("{file && <FileSymbol path={g} />}") && k.includes("{e.type === \"file\" && <FileSymbol path={e.name} />}"), "the files carry no file symbol");
    assert.ok(k.includes("return createPortal(") && k.includes("data-path-crumbs-pop"), "the sheet does not hang on the body via portal");
    assert.ok(k.includes("document.addEventListener(\"mousedown\", beside, true);") && !/fixed inset-0/.test(k), "the sheet closes via a click catcher instead of mousedown");
    // Every segment shows the parent folder with itself marked; the bar scrolls inside itself, to the end, without truncating.
    assert.ok(k.includes("const folder = parts.slice(0, i).join(\"/\");") && k.includes("onClick={(e) => show(e, folder, itself)}"), "a folder segment shows its entries instead of its siblings");
    assert.ok(k.includes("groups: [sortSymbols(g.siblings, \"position\").map("), "the symbol siblings are in the order of the language service instead of by position");
    assert.ok(k.includes("overflow-x-auto overflow-y-hidden whitespace-nowrap") && k.includes("ref={bar}"), "the bar does not scroll inside itself");
    assert.ok(k.includes("if (z > 0 && el.scrollLeft !== z) el.scrollLeft = z;") && k.includes("mo.observe(el, { childList: true, subtree: true, characterData: true });"), "the bar is not at the end");
    const pathPart = k.slice(k.indexOf("export function PathCrumbs"), k.indexOf("function CrumbsSheet"));
    assert.ok(pathPart.length > 0 && !/truncate|min-w-0 shrink /.test(pathPart.replace("flex h-[22px] min-w-0 shrink-0", "")), "a segment is truncated instead of scrolled");
    const c = withoutComments(q.pane);
    assert.ok(c.includes("{active && !controlled && (\n          <PathCrumbs target={target} path={active.path} open={(p) => openFile(p)} after={<Breadcrumbs target={target} path={active.path} location={`${area}:${g.id}`} />} />"), "CodePane does not show the breadcrumbs under the tabs (per group)");
  },
  indentation(q) {
    // Both facets from the guessed indentation, tab as VS Code — hooked into the BufferEditor (both forms of CodePane);
    // the status bar reads the facets back.
    const e = withoutComments(q.indent);
    assert.ok(e.includes("Prec.highest(EditorState.tabSize.compute([GUESSED, PRESET], (st) => facets(st).tabSize)),"), "the tab size does not follow the file");
    assert.ok(e.includes("Prec.highest(indentUnit.compute([GUESSED, PRESET], (st) => facets(st).unit)),"), "the unit does not follow the file");
    assert.ok(e.includes("Prec.high(keymap.of([{ key: \"Tab\", run: tabAsVSCode, shift: indentLess }])),"), "tab is not as VS Code");
    assert.ok(e.includes("const text = tabInsertion(unit, row.text, r.head - row.from, st.tabSize);"), "tab does not insert at the insertion mark");
    assert.ok(withoutComments(q.buffer).includes("indentation(run.current.setup.tabSize ?? 4)"), "the editor does not hook in the indentation");
    assert.ok(withoutComments(q.cursor).includes("indentation: indentationFromFacets(st.facet(indentUnit), tabSize),"), "the status bar does not read the facets");
    // The status bar reads the indentation itself from the view (as a base value — CodePane does not render per keystroke).
    assert.ok(withoutComments(q.pane).includes("<FileDetails t={t} path={active.path} view={activeView}"), "CodePane does not give the status bar the view of the editor");
    assert.ok(withoutComments(q.bar).includes("const one = useCursorValue(view, indentationOf);"), "the status bar does not read the indentation of the editor");
  },
  layout(q) {
    const b = withoutComments(q.tree);
    assert.ok(b.includes("chainsIds(sorted, cursor)"), "the outline does not follow the cursor");
    assert.ok(b.includes("setClosed(new Set(allWithChildren(sorted)))"), "\"Collapse all\" does not take every depth");
    // "Collapse all" and "…" are in the HEAD (OUTLINE section or tab), the choice applies to both places; "Follow
    // Cursor" (VS Code `outline.followCursor`) switches following off; the tree has no row of its own for it any more.
    const a = withoutComments(q.actions);
    assert.ok(b.includes("(followUps && cursor ? chainsIds(sorted, cursor) : [])"), "\"Follow Cursor\" off follows all the same");
    assert.ok(b.includes("if (collapsePrior.current === collapseSeq) return;"), "\"Collapse all\" already collapses when a file is opened");
    assert.ok(!b.includes("<Menu") && !b.includes("data-layout-collapse"), "the tree carries an action row of its own again");
    assert.ok(a.includes("onClick={choice.collapse}") && a.includes("<MenuEntry label={t(\"Follow Cursor\")} selected={choice.followUps} onClick={() => choice.setFollowUps(!choice.followUps)}"), "\"Collapse all\"/\"Follow Cursor\" are missing in the head");
    assert.ok(a.includes("window.localStorage.setItem(FOLLOW_UPS_KEY, f ? \"1\" : \"0\")"), "\"Follow Cursor\" is not remembered");
    assert.ok(b.includes("symbolColor(z.symbol.kind, dark)"), "the kinds are not coloured");
    // ONE outline for the tab and the section in the explorer: components/code/LayoutContent.tsx.
    assert.ok(withoutComments(q.pane).includes("<LayoutContent t={t} active={activePath} layout={outline} view={activeView} choice={layoutChoice}"), "CodePane does not give the outline the cursor");
    assert.ok(withoutComments(q.pane).split("<LayoutActions t={t} choice={layoutChoice} />").length - 1 === 2, "tab and section do not show the SAME outline actions");
    assert.ok(withoutComments(q.content).includes("<LayoutTree key={active} t={t} symbols={layout.symbols} cursor={cursor} ordering={choice.ordering} followUps={choice.followUps} collapseSeq={choice.collapseSeq}"), "the outline does not pass cursor or choice to the tree");
    assert.ok(withoutComments(q.content).includes("const cursor = useCursorSituation(view)?.lsp ?? null;"), "the outline does not read the cursor (itself, not via CodePane)");
    // The empty texts of VS Code (outlinePane).
    assert.ok(withoutComments(q.content).includes("t(\"The active editor cannot provide outline information.\")") && withoutComments(q.content).includes("t(\"No symbols found in document '{name}'\", { name: active.slice(active.lastIndexOf(\"/\") + 1) })"), "the empty texts are not those of VS Code");
    // A click jumps to the name of the symbol (line AND column), as VS Code.
    assert.ok(withoutComments(q.content).includes("onJump={(s) => onJump(s.selectionRange.start)} />") && withoutComments(q.pane).includes("onJump={(from) => { if (activePath) void openFile(activePath, { from }); }}"), "the outline jumps to column 0 instead of the name");
    // The codicon in the colour of the kind (without colour the text colour); ordered by the remembered choice in the "…".
    assert.ok(b.includes("<path d={codiconPath(symbolIcon(z.symbol.kind)) ?? \"\"} />") && b.includes("style={color ? { color: color } : undefined}"), "the outline does not draw the codicon of the kind");
    assert.ok(b.includes("const sorted = useMemo(() => sortSymbols(symbols, ordering), [symbols, ordering]);") && b.includes("treeRows(sorted, closed)"), "the outline does not order");
    // The (remembered) choice lives in components/code/LayoutActions.tsx.
    assert.ok(a.includes("useState<SymbolOrdering>(readOrdering)") && a.includes("window.localStorage.setItem(ORDERING_KEY, o)"), "the ordering is not remembered");
    assert.ok(a.includes("selected={choice.ordering === o} onClick={() => choice.setOrdering(o)}") && a.includes("t(\"Sort By: Category\")"), "the \"…\" does not offer the ordering");
  },
};
const SOURCE_SABOTAGES = {
  "folder list without instance": { file: "crumbs", old: "instancePath(`${target.apiBase}/files/tree?path=${encodeURIComponent(folder)}`, target.instance)", fresh: "`${target.apiBase}/files/tree?path=${encodeURIComponent(folder)}`", catches: "crumbs" },
  "file segment without symbol": { file: "crumbs", old: "{file && <FileSymbol path={g} />}", fresh: "", catches: "crumbs" },
  "sheet does not close on outside click": { file: "crumbs", old: "document.addEventListener(\"mousedown\", beside, true);", fresh: "", catches: "crumbs" },
  "breadcrumbs missing in CodePane": { file: "pane", old: "<PathCrumbs target={target} path={active.path}", fresh: "<Gone target={target} path={active.path}", catches: "crumbs" },
  "language service in its own form": { file: "lsp", old: "const BUTTON = STATUS_ENTRY;", fresh: "const BUTTON = \"rounded-full px-2.5 py-0.5\";", catches: "statusBar" },
  "line opens nothing": { file: "bar", old: "openPalette({ input: \":\", source: v ? sourceForView(v) : null });", fresh: "void v;", catches: "statusBar" },
  "unknown as 0": { file: "bar", old: "{known ? z.error : \"–\"}", fresh: "{z.error}", catches: "statusBar" },
  "no problems without number": { file: "bar", old: "z.known === z.files ? t(\"No problems\") : t(\"No known problems\")", fresh: "t(\"No problems\")", catches: "statusBar" },
  "counter without name": { file: "bar", old: "<StatusEntry title={title} name={name} on={on} onClick={onClick}", fresh: "<StatusEntry title={title} on={on} onClick={onClick}", catches: "statusBar" },
  "selection past the text": { file: "bar", old: "const a = selectionText(situation);", fresh: "const a = { key: \"Line {z}, Col {s}\", values: { z: situation.row, s: situation.column } };", catches: "statusBar" },
  "tab size fixed": { file: "indent", old: "Prec.highest(EditorState.tabSize.compute([GUESSED, PRESET], (st) => facets(st).tabSize)),", fresh: "", catches: "indentation" },
  "tab indents the line": { file: "indent", old: "Prec.high(keymap.of([{ key: \"Tab\", run: tabAsVSCode, shift: indentLess }])),", fresh: "", catches: "indentation" },
  "indentation not hooked in": { file: "buffer", old: "indentation(run.current.setup.tabSize ?? 4), ", fresh: "", catches: "indentation" },
  "status bar guesses itself": { file: "bar", old: "const one = useCursorValue(view, indentationOf);", fresh: "const one = \"empty:4\";", catches: "indentation" },
  "status bar without view": { file: "pane", old: "<FileDetails t={t} path={active.path} view={activeView}", fresh: "<FileDetails t={t} path={active.path} view={() => null}", catches: "indentation" },
  "closed keeps counting": { file: "bar", old: "atClose((p) => setDiagnostics(p.key, null));", fresh: "", catches: "statusBar" },
  "renamed loses the number": { file: "bar", old: "atRename((target, old, fresh, newTarget) => relocateDiagnostics(", fresh: "void ((target: unknown, old: unknown, fresh: unknown, newTarget: unknown) => relocateDiagnostics(", catches: "statusBar" },
  "Zen as own button": { file: "pane", old: "<StatusEntry title={t(\"Zen mode (explorer off)\")} on={zenPressed} onClick={treeToggle}>Zen</StatusEntry>", fresh: "<button onClick={treeToggle} className=\"rounded-full px-2.5\">Zen</button>", catches: "pane" },
  "line ending fixed": { file: "pane", old: "lineEnding={pa.status.lineEnding}", fresh: "lineEnding=\"\\n\"", catches: "pane" },
  "outline does not follow": { file: "tree", old: "chainsIds(sorted, cursor)", fresh: "([] as string[])", catches: "layout" },
  "outline with letters": { file: "tree", old: "<path d={codiconPath(symbolIcon(z.symbol.kind)) ?? \"\"} />", fresh: "<text>{String(z.symbol.kind)}</text>", catches: "layout" },
  "outline unsorted": { file: "tree", old: "treeRows(sorted, closed)", fresh: "treeRows(symbols, closed)", catches: "layout" },
  "ordering forgotten": { file: "actions", old: "window.localStorage.setItem(ORDERING_KEY, o)", fresh: "void o", catches: "layout" },
  "follow cursor without effect": { file: "tree", old: "(followUps && cursor ? chainsIds(sorted, cursor) : [])", fresh: "(cursor ? chainsIds(sorted, cursor) : [])", catches: "layout" },
  "follow cursor missing": { file: "actions", old: "<MenuEntry label={t(\"Follow Cursor\")} selected={choice.followUps} onClick={() => choice.setFollowUps(!choice.followUps)}", fresh: "<MenuEntry label={t(\"x\")} onClick={() => undefined}", catches: "layout" },
  "follow cursor forgotten": { file: "actions", old: "window.localStorage.setItem(FOLLOW_UPS_KEY, f ? \"1\" : \"0\")", fresh: "void f", catches: "layout" },
  "collapse on open": { file: "tree", old: "if (collapsePrior.current === collapseSeq) return;", fresh: "", catches: "layout" },
  "actions in one place only": { file: "pane", old: "<span className=\"flex-1\" /><LayoutActions t={t} choice={layoutChoice} />", fresh: "<span className=\"flex-1\" />", catches: "layout" },
  "old empty text": { file: "content", old: "t(\"The active editor cannot provide outline information.\")", fresh: "t(\"For files with a language service (TS/JS, Python, YAML, JSON).\")", catches: "layout" },
  "no symbols without name": { file: "content", old: "t(\"No symbols found in document '{name}'\", { name: active.slice(active.lastIndexOf(\"/\") + 1) })", fresh: "t(\"No symbols.\")", catches: "layout" },
  "symbol siblings alphabetical": { file: "crumbs", old: "groups: [sortSymbols(g.siblings, \"position\").map(", fresh: "groups: [g.siblings.map(", catches: "crumbs" },
  "folder shows entries": { file: "crumbs", old: "const folder = parts.slice(0, i).join(\"/\");", fresh: "const folder = file ? parts.slice(0, i).join(\"/\") : itself;", catches: "crumbs" },
  "bar cuts off": { file: "crumbs", old: "overflow-x-auto overflow-y-hidden whitespace-nowrap", fresh: "overflow-hidden whitespace-nowrap", catches: "crumbs" },
  "bar not at the end": { file: "crumbs", old: "if (z > 0 && el.scrollLeft !== z) el.scrollLeft = z;", fresh: "void z;", catches: "crumbs" },
  "symbols do not scroll along": { file: "crumbs", old: "mo.observe(el, { childList: true, subtree: true, characterData: true });", fresh: "", catches: "crumbs" },
  "segment truncated": { file: "crumbs", old: "              <span>{g}</span>", fresh: "              <span className=\"truncate\">{g}</span>", catches: "crumbs" },
  "outline without cursor": { file: "pane", old: "layout={outline} view={activeView}", fresh: "layout={outline} view={() => null}", catches: "layout" },
  "outline does not read the cursor": { file: "content", old: "const cursor = useCursorSituation(view)?.lsp ?? null;", fresh: "const cursor = null;", catches: "layout" },
  "outline jumps to column 0": { file: "content", old: "onJump={(s) => onJump(s.selectionRange.start)} />", fresh: "onJump={(s) => onJump({ line: s.selectionRange.start.line, character: 0 })} />", catches: "layout" },
  "outline does not pass the cursor": { file: "content", old: "cursor={cursor} ordering", fresh: "cursor={null} ordering", catches: "layout" },
};

test("(2) sources: one form for every entry, Go to Line, counters from the stock, outline follows the cursor, breadcrumbs", () => {
  for (const [k, check] of Object.entries(SOURCE_CHECKS)) {
    try { check(Q); } catch (e) { throw new Error(`${k}: ${e.message}`); }
  }
  const stale = Object.entries(SOURCE_SABOTAGES).filter(([, s]) => Q[s.file].split(s.old).length !== 2).map(([n]) => n);
  assert.deepEqual(stale, [], "sabotages whose spot does not occur exactly once in the source");
  const notCaught = [];
  for (const [name, s] of Object.entries(SOURCE_SABOTAGES)) {
    let caught = false;
    try { SOURCE_CHECKS[s.catches]({ ...Q, [s.file]: Q[s.file].replace(s.old, s.fresh) }); } catch { caught = true; }
    if (!caught) notCaught.push(`${name} (${s.catches})`);
  }
  assert.deepEqual(notCaught, [], "source sabotages that no check catches");
  console.log(`  [editor-status] ${Object.keys(SOURCE_SABOTAGES).length} source sabotages, each caught`);
});
