// Suggestion list, parameter hints and defaults of the editor as in VS Code out of the box.
//
// (1) The computations lib/suggestion-list.ts and lib/editor-defaults.ts, EXECUTED (compiled with tsc, together with lib/codicons.ts and
//     lib/codicon-symbols.ts): kind -> codicon, glyph and color for every LSP kind (VS Code `CompletionItemKinds.toIcon`, the aliases of
//     the glyphs, symbolIcons.css) and for an unknown kind; every glyph exists at EXACTLY one place: lib/codicon-symbols.ts (the symbols
//     of the outline) or lib/codicons.ts; the colors of Dark/Light Modern (symbolIcon.*, editorSuggestWidget.*, snippet placeholder);
//     the dimensions of the list; counter, wrapping paging and active parameter of the parameter hints; font, size, line height,
//     cursor blinking and the shadow when scrolling. Also: expandable as in VS Code (`canExpandCompletionItem`), the trigger characters
//     of the server and `editor.quickSuggestions` (comment, string, embedding), the additional edits of a suggestion (`additionInText`,
//     only right before the insertion point, only if the text before it is unchanged) and the code settings (lib/code-settings.ts: only
//     deviations stored, the old default 13 without a marker counts as not chosen).
// (2) The bindings (source text): how the list is built (own symbols, delay, Tab, Ctrl+Space, docs closed by default, resolving, position
//     of the docs), its colors per mode, its shape (lsp-theme.ts), the keys and the docs of the parameter hints, and where the defaults
//     take effect (codeTheme.ts, CodePane.tsx, sticky-scroll.ts, scroll-shadow.ts). Also: accepting with import and command, resolving
//     without remembered failure, docs for all editors and only built once attached, instantly acceptable, trigger characters of the
//     server (list and parameter hints), only the name dimmed when deprecated, the edge of VS Code 1.143, the chosen font size in
//     editor, diff and peek.
//
// Every sabotage is a copy of the source with ONE changed spot (the spot occurs exactly once, otherwise the sabotage is stale); the
// assigned check must fail on it.
//
// Run:  node --test --test-reporter=tap web/test/suggestion-list.test.mjs
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

// ── (1) The computations ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// lib/code-settings.ts imports lib/editor-defaults.ts without an extension (webpack); for Node with `.js`.
const SOURCES = {
  list: read("src", "lib", "suggestion-list.ts"), defaults: read("src", "lib", "editor-defaults.ts"), codicons: read("src", "lib", "codicons.ts"),
  settings: read("src", "lib", "code-settings.ts").replace(`from "./editor-defaults";`, `from "./editor-defaults.js";`),
};
const FILE = { list: "suggestion-list", defaults: "editor-defaults", codicons: "codicons", settings: "code-settings" };
const SABOTAGES = [
  { name: "kinds as Monaco from 0", source: "list", old: "KIND_CODICON[kind]) || \"symbol-property\"", fresh: "KIND_CODICON[kind + 1]) || \"symbol-property\"", catches: "symbols" },
  { name: "unknown as text", source: "list", old: "KIND_CODICON[kind]) || \"symbol-property\"", fresh: "KIND_CODICON[kind]) || \"symbol-text\"", catches: "symbols" },
  { name: "function without name", source: "list", old: "3: \"symbol-function\"", fresh: "3: \"symbol-method\"", catches: "symbols" },
  { name: "function without glyph alias", source: "list", old: "\"symbol-function\": \"symbol-method\"", fresh: "\"symbol-function\": \"symbol-property\"", catches: "symbols" },
  { name: "module without namespace", source: "list", old: "\"symbol-module\": \"symbol-namespace\"", fresh: "\"symbol-module\": \"symbol-struct\"", catches: "symbols" },
  { name: "type parameter without glyph", source: "list", old: "\"symbol-type-parameter\": \"symbol-type-parameter\"", fresh: "\"symbol-type-parameter\": \"symbol-property\"", catches: "symbols" },
  { name: "property blue", source: "list", old: "\"symbol-enum-member\": \"blue\",", fresh: "\"symbol-enum-member\": \"blue\", \"symbol-property\": \"blue\",", catches: "symbols" },
  { name: "value not orange", source: "list", old: "\"symbol-value\": \"orange\", ", fresh: "", catches: "symbols" },
  { name: "markdown asks while typing", source: "list", old: "  if (language === \"markdown\") return false;\n", fresh: "", catches: "trigger" },
  { name: "violet light like dark", source: "list", old: "violet: { dark: \"#b180d7\", light: \"#652d90\" }", fresh: "violet: { dark: \"#b180d7\", light: \"#b180d7\" }", catches: "colors" },
  { name: "choice light in blue", source: "list", old: "selectedBackground: \"#e8e8e8\"", fresh: "selectedBackground: \"#0060c0\"", catches: "colors" },
  { name: "highlight dark wrong", source: "list", old: "highlight: \"#2aaaff\", selectedHighlight: \"#2aaaff\", snippetField: \"#7c7c7c4d\"", fresh: "highlight: \"#18a3ff\", selectedHighlight: \"#2aaaff\", snippetField: \"#7c7c7c4d\"", catches: "colors" },
  { name: "placeholder light like dark", source: "list", old: "snippetField: \"#0a326433\"", fresh: "snippetField: \"#7c7c7c4d\"", catches: "colors" },
  { name: "list 400 wide", source: "list", old: "width: 430,", fresh: "width: 400,", catches: "dimensions" },
  { name: "ten rows", source: "list", old: "rows: 12,", fresh: "rows: 10,", catches: "dimensions" },
  { name: "docs 300 wide", source: "list", old: "docsWidth: 330", fresh: "docsWidth: 300", catches: "dimensions" },
  { name: "expandable with detail = name", source: "list", old: "(it.detail && it.detail !== it.label)", fresh: "it.detail", catches: "dimensions" },
  { name: "the shortest trigger character", source: "list", old: "z.length > best.length", fresh: "z.length < best.length", catches: "trigger" },
  { name: "embedding is string", source: "list", old: "    if (n === \"Interpolation\" || n === \"FormatReplacement\") return \"otherwise\";\n", fresh: "", catches: "trigger" },
  { name: "suggestions in a comment", source: "list", old: "  if (kind === \"comment\") return false;\n", fresh: "", catches: "trigger" },
  { name: "suggestions in every string", source: "list", old: "return language === \"json\" || language === \"yaml\";", fresh: "return true;", catches: "trigger" },
  { name: "addition after the insertion point", source: "list", old: " || a.to > before", fresh: "", catches: "addition" },
  { name: "addition without comparing the text", source: "list", old: "priorUntil(end) === nowUntil(end) ?", fresh: "true ?", catches: "addition" },
  { name: "old default 13 stays", source: "settings", old: "  if (s.v !== REVISION && s.fontSize === OLD_FONT_SIZE) out.fontSize = CODE_DEFAULTS.fontSize;\n", fresh: "", catches: "settings" },
  { name: "everything stored", source: "settings", old: "if (e[k] !== CODE_DEFAULTS[k]) out[k] = e[k];", fresh: "result[k] = e[k];", catches: "settings" },
  { name: "wrong type adopted", source: "settings", old: "if (matches(k, s[k])) out[k] = s[k];", fresh: "if (k in s) result[k] = s[k];", catches: "settings" },
  { name: "default 13", source: "settings", old: "fontSize: EDITOR_FONT_SIZE, tabSize: 2,", fresh: "fontSize: 13, tabSize: 2,", catches: "settings" },
  { name: "counter without zeros", source: "list", old: ".padStart(String(count).length, \"0\")", fresh: "", catches: "signatures" },
  { name: "counter from 0", source: "list", old: "String(active + 1)", fresh: "String(active)", catches: "signatures" },
  { name: "paging without wrap-around", source: "list", old: "return (((active + step) % count) + count) % count;", fresh: "return Math.max(0, Math.min(count - 1, active + step));", catches: "signatures" },
  { name: "parameter of the response before the signature", source: "list", old: "sig?.activeParameter ?? response ?? 0", fresh: "response ?? sig?.activeParameter ?? 0", catches: "signatures" },
  { name: "class at two places", source: "codicons", old: "  \"close\": { box:", fresh: "  \"symbol-class\": { box: \"0 0 16 16\", paths: [{\"d\":\"M0 0H16V16H0Z\"}] },\n  \"close\": { box:", catches: "symbols" },
  { name: "font without Menlo", source: "defaults", old: "EDITOR_FONT = \"Menlo, Monaco,", fresh: "EDITOR_FONT = \"SF Mono, Monaco,", catches: "defaults" },
  { name: "13 px", source: "defaults", old: "EDITOR_FONT_SIZE = 12;", fresh: "EDITOR_FONT_SIZE = 13;", catches: "defaults" },
  { name: "line height 1.6", source: "defaults", old: "EDITOR_LINE_FACTOR = 1.5;", fresh: "EDITOR_LINE_FACTOR = 1.6;", catches: "defaults" },
  { name: "blinking 1200 ms", source: "defaults", old: "CURSOR_BLINK_MS = 1000;", fresh: "CURSOR_BLINK_MS = 1200;", catches: "defaults" },
  { name: "shadow 3 px", source: "defaults", old: "SCROLL_SHADOW_HEIGHT = 6;", fresh: "SCROLL_SHADOW_HEIGHT = 3;", catches: "defaults" },
  { name: "shadow light black", source: "defaults", old: "light: { shadow: \"#dddddd\"", fresh: "light: { shadow: \"#000000\"", catches: "defaults" },
  { name: "shadow when unscrolled", source: "defaults", old: "scrollTop > 0;", fresh: "scrollTop >= 0;", catches: "defaults" },
];

// Compile: both modules, the codicons and one copy per sabotage, in ONE tsc run.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-suggestion-"));
const src = path.join(tmp, "src"), out = path.join(tmp, "out");
fs.mkdirSync(src, { recursive: true });
fs.writeFileSync(path.join(src, "codicon-symbols.ts"), read("src", "lib", "codicon-symbols.ts"));
for (const [k, q] of Object.entries(SOURCES)) fs.writeFileSync(path.join(src, `${FILE[k]}.ts`), q);
const copies = SABOTAGES.map((s, i) => {
  const file = `${FILE[s.source]}-sabotage-${i}.ts`;
  fs.writeFileSync(path.join(src, file), SOURCES[s.source].replace(s.old, () => s.fresh));
  return { ...s, file, places: SOURCES[s.source].split(s.old).length - 1 };
});
try {
  execFileSync(process.execPath, [tsc, ...fs.readdirSync(src).map((d) => path.join(src, d)), "--outDir", out, "--rootDir", src, "--module", "es2022", "--target", "es2022", "--strict", "--skipLibCheck"], { stdio: "pipe" });
} catch (e) {
  const text = `${String(e.stdout || "")}${String(e.stderr || "")}`;
  const realError = text.split("\n").filter((z) => /error TS\d+/.test(z) && !/-sabotage-\d+\.ts\(/.test(z));
  if (realError.length || !fs.existsSync(path.join(out, "suggestion-list.js"))) throw new Error(`tsc: ${text}`.slice(0, 4000));
}
const load = (file) => import(pathToFileURL(path.join(out, file.replace(/\.ts$/, ".js"))).href);
const SYM = await load("codicon-symbols.ts");
const real = { list: await load("suggestion-list.ts"), defaults: await load("editor-defaults.ts"), codicons: await load("codicons.ts"), settings: await load("code-settings.ts") };
const sabotaged = await Promise.all(copies.map(async (k) => ({ ...k, mod: { ...real, [k.source]: await load(k.file) } })));
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { console.warn("[test] temp directory was left behind:", String(e?.message || e).slice(0, 120)); }

/** VS Code: LSP kind (1…25) -> [codicon name, drawn glyph, color]: `toIcon`, codiconsLibrary.ts, symbolIcons.css. */
const KINDS = {
  1: ["symbol-text", "symbol-key", null], 2: ["symbol-method", "symbol-method", "violet"], 3: ["symbol-function", "symbol-method", "violet"],
  4: ["symbol-constructor", "symbol-method", "violet"], 5: ["symbol-field", "symbol-field", "blue"], 6: ["symbol-variable", "symbol-variable", "blue"],
  7: ["symbol-class", "symbol-class", "orange"], 8: ["symbol-interface", "symbol-interface", "blue"], 9: ["symbol-module", "symbol-namespace", null],
  10: ["symbol-property", "symbol-property", null], 11: ["symbol-unit", "symbol-ruler", null], 12: ["symbol-value", "symbol-enum", "orange"],
  13: ["symbol-enum", "symbol-enum", "orange"], 14: ["symbol-keyword", "symbol-keyword", null], 15: ["symbol-snippet", "symbol-snippet", null],
  16: ["symbol-color", "symbol-color", null], 17: ["symbol-file", "symbol-file", null], 18: ["symbol-reference", "references", null],
  19: ["symbol-folder", "folder", null], 20: ["symbol-enum-member", "symbol-enum-member", "blue"], 21: ["symbol-constant", "symbol-constant", null],
  22: ["symbol-struct", "symbol-struct", null], 23: ["symbol-event", "symbol-event", "orange"], 24: ["symbol-operator", "symbol-operator", null],
  25: ["symbol-type-parameter", "symbol-type-parameter", null],
};

const CHECKS = {
  symbols({ list: V, codicons: C }) {
    for (const [k, [codicon, glyph, color]] of Object.entries(KINDS)) assert.deepEqual(V.suggestionSymbol(Number(k)), { codicon, glyph, color }, `kind ${k}`);
    for (const k of [0, 26, -1, 2.5, "3", undefined, null]) assert.deepEqual(V.suggestionSymbol(k), { codicon: "symbol-property", glyph: "symbol-property", color: null }, `unknown kind ${String(k)}`);
    // Every glyph the list can draw exists at EXACTLY one place: in lib/codicon-symbols.ts (the same symbols as the
    // outline) or in lib/codicons.ts, in the form of the codicons (16 grid; `references` is 24 x 25 in the codicons repo).
    for (const [, glyph] of Object.values(KINDS)) {
      const sym = SYM.codiconPath(glyph), g = C.CODICONS[glyph];
      assert.ok(!(sym && g), `glyph ${glyph} exists at two places (lib/codicon-symbols.ts and lib/codicons.ts)`);
      assert.ok(sym ? /^M[\d.]/.test(sym) : g && /^0 0 \d+ \d+$/.test(g.box) && g.paths.length > 0 && g.paths.every((p) => /^M[\d.]/.test(p.d)), `glyph ${glyph} is missing or empty`);
    }
    for (const n of Object.keys(C.CODICONS)) assert.equal(SYM.codiconPath(n), null, `${n} is also in lib/codicon-symbols.ts`);
    for (const n of ["chevron-up", "chevron-down", "chevron-right", "close"]) assert.ok(C.CODICONS[n]?.paths.length, `codicon ${n} is missing`);
  },
  colors({ list: V }) {
    assert.deepEqual(V.SYMBOL_COLORS, { orange: { dark: "#ee9d28", light: "#d67e00" }, violet: { dark: "#b180d7", light: "#652d90" }, blue: { dark: "#75beff", light: "#007acc" } });
    assert.deepEqual(V.SUGGESTION_COLORS, {
      dark: { background: "#202020", selectedBackground: "#04395e", selectedText: "#ffffff", selectedIcon: "#ffffff", highlight: "#2aaaff", selectedHighlight: "#2aaaff", snippetField: "#7c7c7c4d" },
      light: { background: "#f8f8f8", selectedBackground: "#e8e8e8", selectedText: "#000000", selectedIcon: "#000000", highlight: "#0066bf", selectedHighlight: "#0066bf", snippetField: "#0a326433" },
    });
  },
  dimensions({ list: V }) {
    assert.deepEqual({ ...V.SUGGESTION_DIMENSIONS }, { width: 430, minWidth: 220, rows: 12, docsWidth: 330 }, "430 px, 12 rows, docs 330 px");
    // VS Code `canExpandCompletionItem`: docs or a detail that is not the name.
    assert.equal(V.canExpand({ label: "a", documentation: "d" }), true);
    assert.equal(V.canExpand({ label: "a", detail: "(x: number) => void" }), true);
    assert.equal(V.canExpand({ label: "value", detail: "value" }), false, "detail = name");
    assert.equal(V.canExpand({ label: "a" }), false);
  },
  trigger({ list: V }) {
    assert.equal(V.triggerAt("foo.", [".", "\"", "'"]), ".");
    assert.equal(V.triggerAt("a ->", ["-", "->", ">"]), "->", "the longest character of the server");
    assert.equal(V.triggerAt("abc", ["."]), null);
    assert.equal(V.triggerAt("abc.", []), null, "without characters from the server none");
    assert.equal(V.syntaxKind(["LineComment", "Script"]), "comment");
    assert.equal(V.syntaxKind(["Comment", "Script"]), "comment");
    assert.equal(V.syntaxKind(["String", "ImportDeclaration", "Script"]), "string");
    assert.equal(V.syntaxKind(["QuotedLiteral", "Pair", "Stream"]), "string");
    assert.equal(V.syntaxKind(["VariableName", "Interpolation", "TemplateString", "Script"]), "otherwise", "inside ${…} is code");
    assert.equal(V.syntaxKind(["VariableName", "FormatReplacement", "FormatString", "Script"]), "otherwise", "inside the {…} of an f-string is code");
    assert.equal(V.syntaxKind(["VariableName", "Script"]), "otherwise");
    for (const s of ["ts", "python", "yaml", "json"]) {
      assert.equal(V.fastSuggestion(s, "otherwise"), true, `${s}: code`);
      assert.equal(V.fastSuggestion(s, "comment"), false, `${s}: comment`);
    }
    assert.equal(V.fastSuggestion("ts", "string"), false);
    assert.equal(V.fastSuggestion("python", "string"), false);
    assert.equal(V.fastSuggestion("json", "string"), true, "JSON: strings on");
    assert.equal(V.fastSuggestion("yaml", "string"), true, "YAML: strings on");
    assert.equal(V.fastSuggestion("css", "otherwise"), true, "CSS: code on");
    assert.equal(V.fastSuggestion("markdown", "otherwise"), false, "Markdown: markdown.editor.quickSuggestions off");
  },
  addition({ list: V }) {
    const t = "const a = 1;\nzae", until = (x) => (n) => x.slice(0, n);
    const imp = [{ from: 0, to: 0, insert: "import x;\n" }];
    assert.deepEqual(V.additionInText(imp, 13, until(t), until(t)), imp, "the import before the insertion point");
    assert.deepEqual(V.additionInText([{ from: 0, to: 5, insert: "let" }], 13, until(t), until(`${t}hleEverything`)), [{ from: 0, to: 5, insert: "let" }], "typed behind it: applies");
    assert.equal(V.additionInText([{ from: 0, to: 5, insert: "let" }], 13, until(t), until(`CONST${t.slice(5)}`)), null, "changed before it: discarded");
    assert.equal(V.additionInText([{ from: 15, to: 15, insert: "x" }], 13, until(t), until(t)), null, "after the insertion point");
    assert.equal(V.additionInText([{ from: 5, to: 3, insert: "" }], 13, until(t), until(t)), null, "reversed range");
    assert.equal(V.additionInText([], 13, until(t), until(t)), null, "nothing");
  },
  settings({ settings: E }) {
    const V = E.CODE_DEFAULTS;
    assert.deepEqual({ ...V }, { fontSize: 12, tabSize: 2, wordWrap: false, minimap: true, formatOnSave: false, preview: true });
    assert.deepEqual(E.fromStorage(null), { ...V });
    assert.deepEqual(E.fromStorage({ fontSize: 13, tabSize: 2, wordWrap: false, minimap: true, formatOnSave: false }), { ...V }, "a stored state from before (whole object, without marker): 13 was the default");
    assert.equal(E.fromStorage({ fontSize: 14 }).fontSize, 14, "a chosen size stays");
    assert.equal(E.fromStorage({ v: 2, fontSize: 13 }).fontSize, 13, "with a marker 13 is chosen");
    assert.deepEqual(E.fromStorage({ fontSize: "14", wordWrap: 1, minimap: false, foreign: 1 }), { ...V, minimap: false }, "wrong type and foreign keys drop out");
    assert.deepEqual(E.forStorage({ ...V }), { v: 2 }, "only the marker: nothing chosen");
    assert.deepEqual(E.forStorage({ ...V, fontSize: 13, wordWrap: true }), { v: 2, fontSize: 13, wordWrap: true });
    const e = { ...V, fontSize: 13, preview: false };
    assert.deepEqual(E.fromStorage(JSON.parse(JSON.stringify(E.forStorage(e)))), e, "round trip");
  },
  signatures({ list: V }) {
    assert.equal(V.signatureCounter(0, 3), "1/3");
    assert.equal(V.signatureCounter(2, 3), "3/3");
    assert.equal(V.signatureCounter(0, 12), "01/12");
    assert.equal(V.signatureCounter(11, 12), "12/12");
    assert.equal(V.nextSignature(0, 3, 1), 1);
    assert.equal(V.nextSignature(2, 3, 1), 0, "Down on the last: to the first");
    assert.equal(V.nextSignature(0, 3, -1), 2, "Up on the first: to the last");
    assert.equal(V.nextSignature(0, 0, 1), 0);
    assert.equal(V.activeParameter({ activeParameter: 2 }, 1), 2, "the one of the signature takes precedence");
    assert.equal(V.activeParameter({}, 1), 1);
    assert.equal(V.activeParameter(undefined, undefined), 0);
  },
  defaults({ defaults: E }) {
    assert.equal(E.EDITOR_FONT, "Menlo, Monaco, Consolas, 'Droid Sans Mono', 'Courier New', monospace");
    assert.equal(E.EDITOR_FONT_SIZE, 12);
    assert.equal(E.EDITOR_LINE_FACTOR, 1.5);
    assert.equal(E.CURSOR_BLINK_MS, 1000, "500 ms on, 500 ms off");
    assert.equal(E.SCROLL_SHADOW_HEIGHT, 6);
    assert.deepEqual(E.SCROLL_COLORS, { dark: { shadow: "#000000", stickyHover: "#2a2d2e" }, light: { shadow: "#dddddd", stickyHover: "#f0f0f0" } });
    assert.equal(E.scrollShadowVisible(0), false);
    assert.equal(E.scrollShadowVisible(1), true);
  },
};

test("(1) Symbols per kind (codicon, glyph, color) as in VS Code, unknown = property, every glyph existing", () => { CHECKS.symbols(real); });
test("(1) Colors of the list, the symbols and the placeholder in Dark/Light Modern", () => { CHECKS.colors(real); });
test("(1) Dimensions of the list, expandable; counter, wrapping paging, active parameter", () => { CHECKS.dimensions(real); CHECKS.signatures(real); });
test("(1) Trigger characters of the server, quickSuggestions, additional edits, code settings", () => {
  CHECKS.trigger(real); CHECKS.addition(real); CHECKS.settings(real);
});
test("(1) Defaults of the editor: Menlo 12/18, blinking, shadow when scrolled", () => { CHECKS.defaults(real); });
test("(1) Counter-tests: every sabotage occurs exactly once in the source and is caught by its check", () => {
  assert.deepEqual(copies.filter((k) => k.places !== 1).map((k) => `${k.name} (${k.places}x)`), [], "sabotages whose spot does not occur exactly once in the source");
  const notCaught = sabotaged.filter((s) => { try { CHECKS[s.catches](s.mod); return true; } catch { return false; } }).map((s) => `${s.name} (${s.catches})`);
  assert.deepEqual(notCaught, [], "sabotages that no check catches");
  assert.deepEqual(Object.keys(CHECKS).filter((k) => !copies.some((s) => s.catches === k)), [], "checks without sabotage");
  console.log(`  [suggestion-list] computation: ${Object.keys(CHECKS).length} checks, ${sabotaged.length} sabotages, each caught`);
});

// ── (2) The bindings ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
const B = {
  vv: read("src", "components", "code", "lsp-completion.ts"),
  sig: read("src", "components", "code", "lsp-signature.ts"),
  theme: read("src", "components", "code", "lsp-theme.ts"),
  code: read("src", "components", "code", "codeTheme.ts"),
  pane: read("src", "components", "CodePane.tsx"),
  former: read("src", "lib", "code-settings.ts"),
  diff: read("src", "components", "code", "DiffTab.tsx"),
  peek: read("src", "components", "code", "lsp-peek.ts"),
  sticky: read("src", "components", "code", "sticky-scroll.ts"),
  scroll: read("src", "components", "code", "scroll-shadow.ts"),
};
const has = (text, place, what) => assert.ok(text.includes(place), `${what}: "${place.slice(0, 90)}" is missing`);

const BINDINGS = {
  list(s) {
    has(s.vv, "icons: false,", "own symbols instead of those of CodeMirror");
    has(s.vv, "activateOnTypingDelay: 10,", "VS Code `quickSuggestionsDelay`");
    has(s.vv, "{ key: \"Tab\", run: acceptCompletion }", "Tab accepts the suggestion");
    has(s.vv, "{ key: \"Ctrl-Space\", run: (v) => (completionStatus(v.state) === \"active\" ? (setSuggestionDocs(!docsGlobal), true) : false) }", "Ctrl+Space toggles the docs when the list is open");
    assert.match(s.vv, /const keys = Prec\.highest\(keymap\.of\(\[/, "the keys before those of CodeMirror");
    has(s.vv, "let docsGlobal = readDocs();", "docs closed by default (remembered in the browser)");
    has(s.vv, "create: () => docsGlobal,", "every editor starts with the state of the window");
    has(s.vv, "const readDocs = () => { try { return localStorage.getItem(DOCS_KEY) === \"1\"; } catch { return false; } };", "only \"1\" means open");
    has(s.vv, "questions(e.file, \"completion_resolve\", { resolve: identifier })", "detail and docs are resolved");
    has(s.vv, "info: item.resolve || canExpand(item) ? docsPart : undefined,", "the docs next to it (to be resolved: known only afterwards)");
    has(s.vv, "if (!canExpand(e.item) || selectedCompletion(view.state) !== c) return null;", "expandable as in VS Code, only the chosen row");
    has(s.vv, "positionInfo: docsSituation,", "position of the docs as in VS Code");
    has(s.vv, "const { docsWidth, minWidth } = SUGGESTION_DIMENSIONS;", "the position computes with the dimensions of the list");
    has(s.vv, "interactionDelay: 0,", "Enter/Tab right after opening");
    has(s.vv, "if (right >= docsWidth) return { style: `top: -1px; width: ${docsWidth}px`, class: \"cm-completionInfo-right\" };", "right before left");
    for (const [part, pos] of [["symbolPart", 20], ["signaturePart", 60], ["rightPart", 80]]) has(s.vv, `{ render: ${part}, position: ${pos} }`, `row part ${part}`);
    has(s.vv, "detail.className = lbl ? \"cm-suggestion-description\" : \"cm-suggestion-detail\";", "description with labelDetails, otherwise the detail");
  },
  accept(s) {
    has(s.vv, "c.apply = accept(c, area);", "every suggestion accepts via `accept`");
    has(s.vv, "if (addition) view.dispatch(main, { changes: addition });", "resolved: text and import in ONE step");
    has(s.vv, "const addition = e.finished ? additionNow(e, view.state, f) : null;", "the additional edits only when resolved");
    has(s.vv, "const late = additionNow(e, view.state, f);", "not yet resolved: added afterwards");
    has(s.vv, "if (late) view.dispatch({ changes: late, userEvent: \"input.complete\" });", "... and applied");
    has(s.vv, "return additionInText(changes, before, (until) => e.doc.sliceString(0, until), (until) => state.doc.sliceString(0, until));", "computed against the state of the request");
    has(s.vv, "...(r.additionalTextEdits ? { additionalTextEdits: r.additionalTextEdits } : {}), ...(r.command ? { command: r.command } : {}),", "resolving brings import and command");
    has(s.vv, "    command(view, it.command);\n", "the command after accepting");
    has(s.vv, "if (cmd === \"editor.action.triggerSuggest\") startCompletion(view);", "new suggestions");
    has(s.vv, "else if (cmd === \"editor.action.triggerParameterHints\") showParameterHints(view);", "parameter hints");
    has(s.vv, "if (isNotSupported(r) || !r.resolved) { if (e.resolved === running) e.resolved = null; return; }", "an older list: nothing remembered");
  },
  docs(s) {
    has(s.vv, "for (const v of DOCS_VIEWS) if (docsOpen(v.state) !== docsGlobal) v.dispatch({ effects: toggleDocs.of(docsGlobal) });", "every editor of the window");
    has(s.vv, "  distributeDocs();\n}\nconst docsSubscription", "toggling distributes immediately");
    has(s.vv, "if (ev.key === DOCS_KEY) { docsGlobal = ev.newValue === \"1\"; distributeDocs(); }", "another window");
    has(s.vv, "if (p.closed || !p.dom.isConnected) return;", "discarded (never attached): never built");
    has(s.vv, "if (docsOpen(view.state)) void buildDocs(p, upfront);", "closed: only resolved, not built");
    has(s.vv, "const p = DOCS_PANE.get(u.view);\n  if (p && !p.closed) void buildDocs(p, null);", "expanded: build the attached docs");
    assert.ok(!/async function docsPart[\s\S]*?\n\}/.exec(s.vv)?.[0].includes("hoverNode("), "the React root is created only in buildDocs");
  },
  trigger(s) {
    has(s.vv, "const trigger = triggerAt(ctx.state.sliceDoc(Math.max(0, ctx.pos - 4), ctx.pos), triggerOf(d).completion);", "the characters of the server");
    has(s.vv, "if (!further && !fastSuggestion(d.language, syntaxKind(nodeNames(ctx.state, ctx.pos)))) return null;", "words not in comment/string");
    has(s.vv, "const further = view !== undefined && OPEN.get(view) === word.from;", "an open list keeps asking");
    assert.doesNotMatch(s.vv, /const TRIGGER/, "no fixed list of trigger characters");
    has(s.sig, "const character = z.signature.find((c) => text.includes(c)) ?? (open ? z.signatureRetrigger.find((c) => text.includes(c)) : undefined);", "parameter hints: characters of the server");
    has(s.sig, "if (character || open) this.plane(PARAMETER_TICK_MS, { ...(character ? { trigger: character } : {}), retrigger: Boolean(open) });", "open: every change asks again, with the cause");
    has(s.sig, "const PARAMETER_TICK_MS = 120;", "VS Code `DEFAULT_DELAY`");
    has(s.sig, "r = await questions(d, \"signature_help\", { position: lspPosOf(doc, pos), ...cause });", "the cause goes along");
  },
  colors(s) {
    has(s.vv, "const colorVariables = EditorView.baseTheme({ \"&dark\": variables(\"dark\"), \"&light\": variables(\"light\") });", "colors per mode");
    has(s.vv, "\"--cb-suggestion-selected-background\": f.selectedBackground,", "background of the selected row");
    has(s.vv, "\"--cb-symbol-orange\": SYMBOL_COLORS.orange[m],", "symbol color");
    has(s.vv, "\"--cb-snippet-field\": f.snippetField,", "placeholder");
    has(s.theme, "\".cm-snippetField\": { backgroundColor: \"var(--cb-snippet-field)\" },", "placeholder in the text");
    has(s.theme, "\".cm-tooltip.cm-suggestion-list .cm-completionMatchedText\": { textDecoration: \"none\", fontWeight: \"bold\", color: \"var(--cb-suggestion-highlight)\" },", "hits bold and blue, not underlined");
  },
  form(s) {
    has(s.theme, "width: `${M.width}px`, minWidth: `${M.minWidth}px`, maxWidth: `min(${M.width}px, 95vw)`, maxHeight: `calc(${M.rows} * var(--cb-line-height, 1.5) * 1em)`,", "the dimensions from SUGGESTION_DIMENSIONS");
    has(s.theme, "const M = SUGGESTION_DIMENSIONS;", "ONE place for the dimensions");
    has(s.theme, "\".cm-tooltip.cm-suggestion-list\": { backgroundColor: \"var(--cb-suggestion-background)\", borderRadius: \"8px\",", "corners 8 px");
    has(s.theme, "\".cm-suggestion-detail\": { display: \"none\" },", "the detail only in the chosen row");
    has(s.theme, "\".cm-suggestion-list:not(.cm-suggestion-with-docs) li[aria-selected] .cm-suggestion-detail\": { display: \"inline\" },", "... as long as the docs are closed");
    has(s.theme, "\".cm-suggestion-list:not(.cm-suggestion-with-docs) > .cm-completionInfo\": { visibility: \"hidden\", pointerEvents: \"none\" },", "docs closed: invisible but measured");
    has(s.theme, "\".cm-suggestion-stale .cm-completionLabel\": { opacity: \"0.66\", textDecoration: \"line-through\" },", "deprecated: the name dimmed and struck through");
    assert.doesNotMatch(s.theme, /cm-suggestion-stale \.cm-suggestion-symbol/, "the symbol of a deprecated entry stays");
    has(s.code, "\"--cb-widget-edge\": \"#cccccc33\",", "edge Dark Modern (editorWidget.border, VS Code 1.143)");
    has(s.code, "\"--cb-widget-edge\": \"#3b3b3b33\",", "edge Light Modern");
    has(s.theme, "\".cm-lsp-signature-wrapper\": { display: \"flex\", flexDirection: \"row\", maxWidth: \"440px\",", "parameter hints at most 440 px");
    has(s.theme, "\".cm-lsp-signature-active\": { fontWeight: \"bold\", color: \"var(--cb-suggestion-highlight)\" },", "active parameter bold");
    has(s.theme, "\".cm-lsp-rename\": { padding: \"4px\", minWidth: \"200px\",", "rename at least 200 px");
  },
  signature(s) {
    for (const k of ["{ key: \"ArrowUp\", run: paginateBy(-1) }, { key: \"ArrowDown\", run: paginateBy(1) },", "{ key: \"Alt-ArrowUp\", run: paginateBy(-1) }, { key: \"Alt-ArrowDown\", run: paginateBy(1) },", "{ key: \"Shift-Mod-Space\", run: showParameterHints },"]) has(s.sig, k, "key of the parameter hints");
    has(s.sig, "&& completionStatus(v.state) !== \"active\";", "Up/Down belong to the open suggestion list");
    has(s.sig, "count.textContent = signatureCounter(i, n);", "counter n/m");
    has(s.sig, "const ai = activeParameter(s, h.data.activeParameter);", "active parameter");
    has(s.sig, "const docs = [param?.documentation, s.documentation]", "first the docs of the parameter, then those of the signature");
    has(s.sig, "sameSignatures(prior.data, data) ? prior.selected :", "the chosen signature stays while typing on");
  },
  defaults(s) {
    has(s.code, "fontSize: textPx(EDITOR_FONT_SIZE),", "font size of the editor");
    has(s.code, "\"--cb-editor-font\": EDITOR_FONT, \"--cb-line-height\": String(EDITOR_LINE_FACTOR),", "font and line height as variables");
    has(s.code, "\".cm-scroller\": { fontFamily: \"var(--cb-editor-font)\", lineHeight: \"var(--cb-line-height, 1.5)\" },", "the text reads them");
    has(s.code, "drawSelection({ cursorBlinkRate: CURSOR_BLINK_MS }), scrollShadow,", "blinking and shadow in every code editor");
    has(s.code, "\"--cb-scroll-shadow\": SCROLL_COLORS.dark.shadow,", "shadow dark");
    has(s.code, "\"--cb-scroll-shadow\": SCROLL_COLORS.light.shadow,", "shadow light");
    has(s.former, "fontSize: EDITOR_FONT_SIZE, tabSize: 2,", "default of the setting \"font size\"");
    has(s.code, "export const fontSize = (px: number): Extension => Prec.highest(EditorView.theme({ \"&\": { fontSize: textPx(px) } }));", "the chosen size beats the default of codeTheme");
    has(s.pane, "const list: Extension[] = [codeTheme, fontSize(settings.fontSize), textSizeMeasurement];", "the editor in the chosen size");
    has(s.pane, "const next = saveCodeSettings(patch);", "remembered only via lib/code-settings.ts");
    assert.doesNotMatch(s.pane, /localStorage\.setItem\(SETTINGS_KEY/, "CodePane does not remember by itself");
    has(s.diff, "codeTheme, font.of(fontSize(sizeNow.current)),", "the diff in the size of the editor");
    has(s.diff, "for (const v of [x.a, x.b]) v?.dispatch({ effects: x.font.reconfigure(fontSize(size)) });", "... and follows it");
    has(s.peek, "codeTheme, fontSize(editorFontSize()),", "the preview of the definition likewise");
    has(s.sticky, "\".cm-sticky\": { position: \"absolute\", left: \"0\", zIndex: \"250\", boxShadow: \"var(--cb-scroll-shadow, #000000) 0 4px 2px -2px\",", "sticky scroll with shadow");
    assert.doesNotMatch(s.sticky.match(/"\.cm-sticky": \{[^\n]*/)?.[0] ?? "", /border/, "sticky scroll without edge (VS Code `editorStickyScroll.border` is empty)");
    has(s.sticky, "\".cm-sticky-row:hover\": { backgroundColor: \"var(--cb-sticky-hover, var(--color-hover))\" },", "hover as in VS Code");
    has(s.scroll, "on: scrollShadowVisible(v.scrollDOM.scrollTop)", "shadow only when scrolled");
    has(s.scroll, "view.scrollDOM.addEventListener(\"scroll\", this.listen, { passive: true });", "follows scrolling");
  },
};
const B_SABOTAGES = [
  { name: "symbols of CodeMirror", file: "vv", old: "icons: false,", fresh: "icons: true,", catches: "list" },
  { name: "sluggish list", file: "vv", old: "activateOnTypingDelay: 10,", fresh: "activateOnTypingDelay: 100,", catches: "list" },
  { name: "Tab types", file: "vv", old: "  { key: \"Tab\", run: acceptCompletion },\n", fresh: "", catches: "list" },
  { name: "Ctrl+Space only asks", file: "vv", old: "(completionStatus(v.state) === \"active\" ? (setSuggestionDocs(!docsGlobal), true) : false)", fresh: "false", catches: "list" },
  { name: "docs open by default", file: "vv", old: "create: () => docsGlobal,", fresh: "create: () => true,", catches: "list" },
  { name: "accepting with delay", file: "vv", old: "interactionDelay: 0,", fresh: "interactionDelay: 75,", catches: "list" },
  { name: "docs position with own width", file: "vv", old: "const { docsWidth, minWidth } = SUGGESTION_DIMENSIONS;", fresh: "const docsWidth = 330, minWidth = 220;", catches: "list" },
  { name: "docs even without docs", file: "vv", old: "if (!canExpand(e.item) || selectedCompletion(view.state) !== c) return null;", fresh: "if (selectedCompletion(view.state) !== c) return null;", catches: "list" },
  { name: "import never", file: "vv", old: "if (addition) view.dispatch(main, { changes: addition });\n      else view.dispatch(main);", fresh: "view.dispatch(main);", catches: "accept" },
  { name: "import never added afterwards", file: "vv", old: "if (late) view.dispatch({ changes: late, userEvent: \"input.complete\" });", fresh: "", catches: "accept" },
  { name: "resolving without import", file: "vv", old: "...(r.additionalTextEdits ? { additionalTextEdits: r.additionalTextEdits } : {}), ", fresh: "", catches: "accept" },
  { name: "command ignored", file: "vv", old: "    command(view, it.command);\n", fresh: "", catches: "accept" },
  { name: "failure remembered", file: "vv", old: "if (isNotSupported(r) || !r.resolved) { if (e.resolved === running) e.resolved = null; return; }", fresh: "if (isNotSupported(r) || !r.resolved) return;", catches: "accept" },
  { name: "docs only in the own editor", file: "vv", old: "  distributeDocs();\n}\nconst docsSubscription", fresh: "}\nconst docsSubscription", catches: "docs" },
  { name: "discarded docs built", file: "vv", old: "if (p.closed || !p.dom.isConnected) return;", fresh: "if (p.closed) return;", catches: "docs" },
  { name: "closed docs built", file: "vv", old: "if (docsOpen(view.state)) void buildDocs(p, upfront);", fresh: "void buildDocs(p, upfront);", catches: "docs" },
  { name: "fixed trigger characters", file: "vv", old: "triggerOf(d).completion);", fresh: "[\".\"]);", catches: "trigger" },
  { name: "suggestions everywhere", file: "vv", old: "if (!further && !fastSuggestion(", fresh: "if (false && !fastSuggestion(", catches: "trigger" },
  { name: "open list stops", file: "vv", old: "const further = view !== undefined && OPEN.get(view) === word.from;", fresh: "const further = false;", catches: "trigger" },
  { name: "fixed brackets", file: "sig", old: "z.signature.find((c) => text.includes(c))", fresh: "[\"(\", \",\"].find((c) => text.includes(c))", catches: "trigger" },
  { name: "cause missing", file: "sig", old: "{ position: lspPosOf(doc, pos), ...cause }", fresh: "{ position: lspPosOf(doc, pos) }", catches: "trigger" },
  { name: "never resolved", file: "vv", old: "questions(e.file, \"completion_resolve\", { resolve: identifier })", fresh: "Promise.resolve({ resolved: false })", catches: "list" },
  { name: "docs by CodeMirror", file: "vv", old: "    positionInfo: docsSituation,\n", fresh: "", catches: "list" },
  { name: "description only when chosen", file: "vv", old: "detail.className = lbl ? \"cm-suggestion-description\" : \"cm-suggestion-detail\";", fresh: "detail.className = \"cm-suggestion-detail\";", catches: "list" },
  { name: "light with dark colors", file: "vv", old: "\"&light\": variables(\"light\")", fresh: "\"&light\": variables(\"dark\")", catches: "colors" },
  { name: "hits underlined", file: "theme", old: "{ textDecoration: \"none\", fontWeight: \"bold\", color: \"var(--cb-suggestion-highlight)\" }", fresh: "{ fontWeight: \"bold\", color: \"var(--cb-suggestion-highlight)\" }", catches: "colors" },
  { name: "list 400 wide", file: "theme", old: "width: `${M.width}px`, minWidth", fresh: "width: \"400px\", minWidth", catches: "form" },
  { name: "deprecated symbol dimmed", file: "theme", old: "\".cm-suggestion-stale .cm-completionLabel\": {", fresh: "\".cm-suggestion-stale .cm-completionLabel, .cm-suggestion-stale .cm-suggestion-symbol\": {", catches: "form" },
  { name: "old edge dark", file: "code", old: "\"--cb-widget-edge\": \"#cccccc33\",", fresh: "\"--cb-widget-edge\": \"#454545\",", catches: "form" },
  { name: "detail in every row", file: "theme", old: "\".cm-suggestion-detail\": { display: \"none\" },", fresh: "", catches: "form" },
  { name: "docs always visible", file: "theme", old: "{ visibility: \"hidden\", pointerEvents: \"none\" }", fresh: "{}", catches: "form" },
  { name: "parameter hints 500 wide", file: "theme", old: "maxWidth: \"440px\",", fresh: "maxWidth: \"500px\",", catches: "form" },
  { name: "active parameter not bold", file: "theme", old: "\".cm-lsp-signature-active\": { fontWeight: \"bold\",", fresh: "\".cm-lsp-signature-active\": {", catches: "form" },
  { name: "Up does not page", file: "sig", old: "{ key: \"ArrowUp\", run: paginateBy(-1) }, ", fresh: "", catches: "signature" },
  { name: "Down steals from the list", file: "sig", old: "&& completionStatus(v.state) !== \"active\";", fresh: ";", catches: "signature" },
  { name: "without key by hand", file: "sig", old: "{ key: \"Shift-Mod-Space\", run: showParameterHints },", fresh: "", catches: "signature" },
  { name: "docs of the signature first", file: "sig", old: "[param?.documentation, s.documentation]", fresh: "[s.documentation, param?.documentation]", catches: "signature" },
  { name: "choice jumps back", file: "sig", old: "sameSignatures(prior.data, data) ? prior.selected :", fresh: "false ? prior.selected :", catches: "signature" },
  { name: "font of the app", file: "code", old: "\".cm-scroller\": { fontFamily: \"var(--cb-editor-font)\",", fresh: "\".cm-scroller\": { fontFamily: \"var(--font-mono)\",", catches: "defaults" },
  { name: "light with black shadow", file: "code", old: "\"--cb-scroll-shadow\": SCROLL_COLORS.light.shadow,", fresh: "\"--cb-scroll-shadow\": SCROLL_COLORS.dark.shadow,", catches: "defaults" },
  { name: "default 13", file: "former", old: "fontSize: EDITOR_FONT_SIZE, tabSize", fresh: "fontSize: 13, tabSize", catches: "defaults" },
  { name: "size loses against the theme", file: "code", old: "Prec.highest(EditorView.theme({ \"&\": { fontSize: textPx(px) } }))", fresh: "EditorView.theme({ \"&\": { fontSize: textPx(px) } })", catches: "defaults" },
  { name: "diff fixed at 12", file: "diff", old: "font.of(fontSize(sizeNow.current))", fresh: "font.of([])", catches: "defaults" },
  { name: "diff does not follow", file: "diff", old: "v?.dispatch({ effects: x.font.reconfigure(fontSize(size)) });", fresh: "void v;", catches: "defaults" },
  { name: "peek fixed at 12", file: "peek", old: "codeTheme, fontSize(editorFontSize()),", fresh: "codeTheme,", catches: "defaults" },
  { name: "editor fixed at 12", file: "pane", old: "[codeTheme, fontSize(settings.fontSize), textSizeMeasurement]", fresh: "[codeTheme, textSizeMeasurement]", catches: "defaults" },
  { name: "sticky with edge", file: "sticky", old: "zIndex: \"250\", boxShadow:", fresh: "zIndex: \"250\", borderBottom: \"1px solid var(--color-edge)\", boxShadow:", catches: "defaults" },
  { name: "shadow does not follow scrolling", file: "scroll", old: "view.scrollDOM.addEventListener(\"scroll\", this.listen, { passive: true });", fresh: "", catches: "defaults" },
];

test("(2) Bindings: list, accepting, docs, trigger characters, colors, shape, parameter hints, where the defaults take effect", () => {
  for (const [k, f] of Object.entries(BINDINGS)) { try { f(B); } catch (e) { throw new Error(`${k}: ${e.message}`); } }
});
test("(2) Counter-probes of the bindings: every sabotage occurs exactly once and is caught", () => {
  const stale = B_SABOTAGES.filter((x) => B[x.file].split(x.old).length - 1 !== 1).map((x) => `${x.name} (${B[x.file].split(x.old).length - 1}x)`);
  assert.deepEqual(stale, [], "sabotages whose spot does not occur exactly once in the source");
  const notCaught = B_SABOTAGES.filter((x) => {
    const s = { ...B, [x.file]: B[x.file].replace(x.old, () => x.fresh) };
    try { BINDINGS[x.catches](s); return true; } catch { return false; }
  }).map((x) => `${x.name} (${x.catches})`);
  assert.deepEqual(notCaught, [], "sabotages that no check catches");
  assert.deepEqual(Object.keys(BINDINGS).filter((k) => !B_SABOTAGES.some((x) => x.catches === k)), [], "bindings without sabotage");
  console.log(`  [suggestion-list] bindings: ${Object.keys(BINDINGS).length} checks, ${B_SABOTAGES.length} sabotages, each caught`);
});
