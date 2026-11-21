// The minimap draws only what changes and measures its font once. MEASURED in a real browser: `@replit/codemirror-minimap`
// 0.5.2 drew five times per keystroke and emptied its font-info storage before every draw — about 50 style computations per key.
// components/code/minimap-font.ts replaces `text.beforeDraw` and `update`/`render` on the instance. The promises and who keeps them:
//
//   (1) The calculation, EXECUTED with the real packages (@codemirror/state, @codemirror/lint, @codemirror/language, the minimap itself):
//       `minimapPlugins` finds the minimap's ViewPlugins; `tameFontCache` no longer empties but gives ONE shared storage per key (same
//       key => the same one, across instances; new key => another; at most STORAGE_MAX); without the field the original runs;
//       `drawOnlyAtChange` draws on text, selection, view/measures, focus, configuration, diagnostics, folds and new classes — otherwise
//       not, and the update still runs through the library.
//   (2) The library still carries what the replacement builds on (version in the lockfile, `beforeDraw` empties `_fontInfoMap`, `render`
//       calls `beforeDraw`, `update` calls `render`, `getFontInfo` reads the storage) — a new version turns this guard red, not silently slow.
//   (3) The sources: CodePane hangs `minimapFont` BEFORE `showMinimap`; the extension prepares the class and tames on creation and after
//       every update.
//   (4) The text side no longer parses itself — EXECUTED on the REAL class of the library (`TextState`, one subclass per check so that
//       sabotages do not wrap each other): without replacement it parses (counter-probe of the setup), with `partsSyntaxTree` NO parse on
//       creation and on a change, and the lines including highlighting are the same as the library's (also after the rest in idle time);
//       if only the editor's tree grows, it recomputes (`shouldUpdate`) and draws (`redraws`) anew, otherwise not.
//
// Every sabotage changes exactly ONE spot (it must appear exactly once in the source) and must be caught.
//
// Run:  node --test --test-reporter=tap web/test/minimap-font.test.mjs
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const read = (...p) => fs.readFileSync(path.join(webDir, ...p), "utf8");
const SOURCE = read("src", "components", "code", "minimap-font.ts");
const PANE = read("src", "components", "CodePane.tsx");
const require = createRequire(path.join(webDir, "package.json"));
const ts = require("typescript");
const MINIMAP_DIST = fs.readFileSync(path.join(webDir, "node_modules", "@replit", "codemirror-minimap", "dist", "index.js"), "utf8");
const LOCK = JSON.parse(read("package-lock.json"));

// Compiles into a throwaway folder with a link to web/node_modules — the packages load as in the build (ESM, ONE version of @codemirror/*).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-minimap-font-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
fs.symlinkSync(path.join(webDir, "node_modules"), path.join(tmp, "node_modules"), "dir");
fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ type: "module" }));
let seq = 0;
async function load(source) {
  const file = path.join(tmp, `minimap-font-${seq++}.mjs`);
  fs.writeFileSync(file, ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText);
  return import(pathToFileURL(file).href);
}
const { EditorState } = await import(pathToFileURL(path.join(tmp, "node_modules", "@codemirror", "state", "dist", "index.js")).href);
const { setDiagnosticsEffect } = await import(pathToFileURL(path.join(tmp, "node_modules", "@codemirror", "lint", "dist", "index.js")).href);
const { foldEffect, language, syntaxHighlighting, defaultHighlightStyle, ensureSyntaxTree, syntaxTree } = await import(pathToFileURL(path.join(tmp, "node_modules", "@codemirror", "language", "dist", "index.js")).href);
const { javascript } = await import(pathToFileURL(path.join(tmp, "node_modules", "@codemirror", "lang-javascript", "dist", "index.js")).href);
const { ViewPlugin } = await import(pathToFileURL(path.join(tmp, "node_modules", "@codemirror", "view", "dist", "index.js")).href);
const { showMinimap } = await import(pathToFileURL(path.join(tmp, "node_modules", "@replit", "codemirror-minimap", "dist", "index.js")).href);

// (4) The library's real text side without a browser: an editor stand-in with state, classes and view; the minimap itself builds its
// selection side (a probe node) in the constructor — for that a document stand-in, only while it is being created. Every parse of the
// language is counted. 80 lines (about 2,300 characters): CodeMirror parses only the first 3,000 characters on creation
// (`Work.InitViewport`), the rest in the browser in the background — there is none here; so the editor's tree is complete and the
// comparison with the library is character by character.
const DOC = Array.from({ length: 80 }, (_, i) => `const a${i} = "s${i}"; // k${i}`).join("\n");
// CodeMirror gives the first parse of a state only 20 ms (`Work.Apply`); under load the editor's tree then stays shorter than the
// document, and the comparison with the self-parsing library would check the load instead of the replacement. So every state here is
// parsed FULLY: `ensureSyntaxTree` drives the parse context to the end, an empty update takes the finished tree into the field.
const fullParsed = (s) => {
  ensureSyntaxTree(s, s.doc.length, 1e9);
  const v = s.update({}).state;
  if (syntaxTree(v).length !== v.doc.length) throw new Error("setup: the editor's tree does not cover the document");
  return v;
};
const sMm = fullParsed(EditorState.create({ doc: DOC, extensions: [javascript(), syntaxHighlighting(defaultHighlightStyle), showMinimap.of({ create: () => ({ dom: {} }) })] }));
let parses = 0;
{ const p = sMm.facet(language).parser, orig = p.parse.bind(p); p.parse = (...a) => { parses++; return orig(...a); }; }
const withoutMinimapFacet = (s) => new Proxy(s, { get(z, n) { if (n === "facet") return (f) => (f === showMinimap ? null : z.facet(f)); const v = Reflect.get(z, n, z); return typeof v === "function" ? v.bind(z) : v; } });
const editor = (state) => ({ state, dom: { classList: new Set(["cm-editor"]), appendChild() {}, removeChild() {} }, viewport: { from: 0, to: 2000 } });
const TextState = (() => {
  const g = globalThis, old = { document: g.document, window: g.window };
  g.document = { createElement: () => ({ setAttribute() {} }) }; g.window = { getComputedStyle: () => ({ backgroundColor: "x" }) };
  try {
    const plugins = []; const go = (x) => { if (x instanceof ViewPlugin) plugins.push(x); else if (Array.isArray(x)) x.forEach(go); }; go(showMinimap.extensions);
    for (const p of plugins) { const m = p.create(editor(withoutMinimapFacet(sMm))); if (m?.text) return m.text.constructor; }
    return null;
  } finally { g.document = old.document; g.window = old.window; }
})();
// The library highlights the rest in idle time (`requestIdleCallback`, it asks `window` for it). Idle time here is a queue that the test
// empties itself — no pause on the clock (guard "bare pauses"), no race of two timers under load.
globalThis.window ??= {};
const waiting = new Map(); let nextId = 0;
globalThis.requestIdleCallback = window.requestIdleCallback = (f) => { const id = ++nextId; waiting.set(id, f); return id; };
globalThis.cancelIdleCallback = window.cancelIdleCallback = (id) => { waiting.delete(id); };
const idle = async () => {
  for (let round = 0; waiting.size; round++) {
    if (round > 1000) throw new Error("the idle queue does not empty");
    const [id, f] = waiting.entries().next().value; waiting.delete(id); f({ didTimeout: false, timeRemaining: () => 50 });
  }
};
const rows = (t) => JSON.stringify([...t.map]);

// A text page like the library's (`TextState`): its storage and its `beforeDraw`.
const textPage = () => { const t = { _fontInfoMap: new Map(), cleared: 0 }; t.beforeDraw = function () { this.cleared++; this._fontInfoMap.clear(); }; return t; };
// An update like CodeMirror `ViewUpdate` (only what `redraws` reads).
const s0 = EditorState.create({ doc: "abc" });
const upd = (o = {}) => { const tr = s0.update(o.spec ?? {}); return { docChanged: false, selectionSet: false, viewportChanged: false, geometryChanged: false, heightChanged: false, focusChanged: false, transactions: [tr], startState: s0, state: tr.state, ...o.flags }; };

const CHECKS = {
  async plugins(m) {
    const ps = m.minimapPlugins();
    assert.ok(ps.length >= 1, "the minimap's ViewPlugins are not found");
    assert.equal(m.minimapPlugins({ extensions: [[{}], "x"] }).length, 0, "something foreign is no ViewPlugin");
  },
  async storage(m) {
    const shared = new Map();
    let k = "theme-a";
    const a = textPage(), b = textPage();
    assert.equal(m.tameFontCache(a, () => k, shared), true);
    assert.equal(m.tameFontCache(a, () => k, shared), false, "tamed twice");
    m.tameFontCache(b, () => k, shared);
    a.beforeDraw(); a._fontInfoMap.set("tok", { color: "red" });
    a.beforeDraw(); a.beforeDraw();
    assert.equal(a._fontInfoMap.get("tok")?.color, "red", "the storage is emptied before every draw");
    b.beforeDraw();
    assert.equal(b._fontInfoMap, a._fontInfoMap, "two minimaps with the same key do not share (every file measures anew)");
    k = "theme-b"; a.beforeDraw();
    assert.notEqual(a._fontInfoMap, b._fontInfoMap, "a new key (theme, font size) keeps the old data");
    assert.equal(a._fontInfoMap.size, 0);
    assert.equal(a.cleared + b.cleared, 0, "the original empties although the field is there");
    for (let i = 0; i < m.STORAGE_MAX + 5; i++) { k = `t${i}`; a.beforeDraw(); }
    assert.ok(shared.size <= m.STORAGE_MAX, "the shared storage grows without a cap");
    const without = { cleared: 0, beforeDraw() { this.cleared++; } };
    m.tameFontCache(without, () => k, new Map()); k = "x"; without.beforeDraw(); without.beforeDraw();
    assert.equal(without.cleared, 1, "without `_fontInfoMap` the original runs (once per key)");
    assert.equal(m.tameFontCache(null, () => ""), false);
  },
  async draw(m) {
    let k = "cm-editor ͼ1";
    const inst = { drawn: 0, through: 0, update(u) { this.through++; this.render(); }, render() { this.drawn++; } };
    assert.equal(m.drawOnlyAtChange(inst, () => k), true);
    assert.equal(m.drawOnlyAtChange(inst, () => k), false, "replaced twice");
    const fall = (name, u, desired) => { const v = inst.drawn; inst.update(u); assert.equal(inst.drawn - v, desired, name); };
    fall("an update without anything shown (completion, semantics, git gutter) draws", upd(), 0);
    for (const f of ["docChanged", "selectionSet", "viewportChanged", "geometryChanged", "heightChanged", "focusChanged"]) fall(`${f} does not draw`, upd({ flags: { [f]: true } }), 1);
    fall("new diagnostics do not draw", upd({ spec: { effects: setDiagnosticsEffect.of([]) } }), 1);
    fall("a fold does not draw", upd({ spec: { effects: foldEffect.of({ from: 0, to: 1 }) } }), 1);
    fall("reconfiguring does not draw", upd({ flags: { transactions: [{ reconfigured: true, effects: [] }] } }), 1);
    k = "cm-editor ͼ2"; fall("new editor classes (theme) do not draw", upd(), 1);
    fall("quiet again afterwards", upd(), 0);
    const prior = inst.through; inst.update(upd());
    assert.equal(inst.through, prior + 1, "a silent update does not run through the library (its states go stale)");
    const v = inst.drawn; inst.render(); assert.equal(inst.drawn, v + 1, "drawing from outside (scrolling) is blocked");
    assert.equal(m.drawOnlyAtChange({ text: {} }, () => ""), false);
  },
};
CHECKS.tree = async (m) => {
  assert.ok(TextState, "the minimap's text page is not found");
  const kind = (share) => { const T = class extends TextState {}; if (share) assert.equal(m.partsSyntaxTree(T.prototype), true); return T; };
  const B = kind(false), E = kind(true);
  assert.equal(m.partsSyntaxTree(E.prototype), false, "replaced twice");
  assert.equal(m.partsSyntaxTree(null), false);
  let n = parses; const b = new B(editor(sMm));
  assert.ok(parses > n, "setup: the library does not parse without replacement (the counter-probe would prove nothing)");
  n = parses; const e = new E(editor(sMm));
  assert.equal(parses, n, "the minimap parses itself on creation (second parse of the whole document)");
  await idle();
  assert.ok(rows(b).includes("tok-") || rows(b).includes("ͼ"), "setup: without highlighting the comparison would check nothing");
  assert.equal(rows(e), rows(b), "the lines including highlighting differ from the library's");
  const tr = sMm.update({ changes: { from: 0, insert: "let x = 1;\n" } });
  const s1 = fullParsed(tr.state);
  const u = (t) => ({ docChanged: true, state: s1, startState: sMm, changes: t.changes, transactions: [t] });
  b.view = editor(s1); e.view = editor(s1);
  b.update(u(tr)); n = parses; e.update(u(tr));
  assert.equal(parses, n, "the minimap parses itself on every change");
  await idle();
  assert.equal(rows(e), rows(b), "after a change the lines differ");
  // Only the tree grows (CodeMirror keeps parsing in the background): here a change the library does not see (`docChanged: false`).
  const still = { docChanged: false, state: s1, startState: sMm, changes: tr.changes, transactions: [tr] };
  assert.equal(B.prototype.shouldUpdate.call(b, still), false, "setup: the library recomputed here anyway");
  assert.equal(E.prototype.shouldUpdate.call(e, still), true, "a grown tree does not reach the minimap");
  const equal = sMm.update({});
  assert.equal(E.prototype.shouldUpdate.call(e, { docChanged: false, state: equal.state, startState: sMm, transactions: [equal] }), false, "recomputes without cause");
  const flags = { selectionSet: false, viewportChanged: false, geometryChanged: false, heightChanged: false, focusChanged: false };
  assert.equal(m.redraws({ ...still, ...flags }), true, "a grown tree does not draw");
  assert.equal(m.redraws({ docChanged: false, ...flags, state: equal.state, startState: sMm, transactions: [equal] }), false, "draws with the same tree");
  assert.equal(m.withTreeOfTheEditor(s0), s0, "without a language the state is a different one");
};
const LIBRARY = (dist, lock) => {
  assert.equal(lock.packages["node_modules/@replit/codemirror-minimap"]?.version, "0.5.2", "another version of the minimap — re-check the replacement");
  for (const [place, what] of [
    ["beforeDraw() {\n        this._fontInfoMap.clear();", "beforeDraw empties `_fontInfoMap`"],
    ["this.text.beforeDraw();", "render calls beforeDraw"],
    ["this.diagnostic.update(update);\n            this.render();", "update calls render"],
    ["const cached = this._fontInfoMap.get(tags);", "getFontInfo reads `_fontInfoMap`"],
    ["minimapClass,\n                Overlay,", "showMinimap switches the minimap on via `enables`"],
    ["const parser = (_a = state.facet(language)) === null || _a === void 0 ? void 0 : _a.parser;\n        const tree = parser ? parser.parse(docToString, treeFragments) : undefined;", "updateImpl parses via `state.facet(language).parser`"],
    ["if (!this.shouldUpdate(update)) {\n            return;\n        }", "update asks shouldUpdate"],
    ["if (view.state.facet(Config).enabled) {\n            this.updateImpl(view.state);", "the text page constructor calls updateImpl"],
  ]) assert.ok(dist.includes(place), `the library no longer carries: ${what}`);
};
const SOURCES = (q, pane) => {
  assert.ok(pane.includes("if (settings.minimap) list.push(minimapFont, showMinimap.compute("), "CodePane does not hang minimapFont BEFORE showMinimap (the first minimap would then parse itself)");
  assert.ok(pane.includes(`import { minimapFont } from "@/components/code/minimap-font";`));
  assert.ok(q.includes("constructor(view: EditorView) { prepareSetup(); tame(view); }") && q.includes("update(u: { view: EditorView }) { tame(u.view); }"), "not tamed on creation AND after every update");
  assert.ok(q.includes("tameFontCache(m.text, () => fontKey(view));") && q.includes("drawOnlyAtChange(m, () => view.dom.className);"), "one of the two replacements is missing on the instance");
  assert.ok(q.includes("partsSyntaxTree(classOf(m.text));\n    tameFontCache") && q.includes("const m = probe.plugin(p) as MinimapInstance | null; if (m?.text) partsSyntaxTree(classOf(m.text));"), "the text page class is not replaced (in advance)");
  assert.ok(q.includes(`.filter((k) => k !== "cm-focused")`) && q.includes("html?.dataset.theme") && q.includes(`getPropertyValue("--cb-text-scale")`), "the key does not know theme/text size (or the focus empties)");
};

const SABOTAGES = {
  "only the first plugin": { old: "if (x instanceof ViewPlugin) out.push(x as ViewPlugin<object>); else if (Array.isArray(x)) x.forEach(go);", fresh: "if (Array.isArray(x)) x.forEach(go);", catches: "plugins" },
  "keeps emptying": { old: "    if (k === last) return;\n    last = k;\n    if (", fresh: "    last = k;\n    if (", catches: "storage" },
  "storage per instance": { old: "if (text._fontInfoMap instanceof Map) text._fontInfoMap = storageFor(shared, k);", fresh: "if (text._fontInfoMap instanceof Map) text._fontInfoMap = new Map();", catches: "storage" },
  "without cap": { old: "while (shared.size > STORAGE_MAX)", fresh: "while (false)", catches: "storage" },
  "always draws": { old: "silent = !redraws(u) && k === last;", fresh: "silent = false;", catches: "draw" },
  "forgets diagnostics": { old: "e.is(setDiagnosticsEffect) || ", fresh: "", catches: "draw" },
  "forgets folds": { old: "e.is(foldEffect) || ", fresh: "", catches: "draw" },
  "forgets the selection": { old: "u.docChanged || u.selectionSet || ", fresh: "u.docChanged || ", catches: "draw" },
  "forgets classes": { old: "&& k === last", fresh: "", catches: "draw" },
  "silent update swallowed": { old: "try { update(u); } finally { silent = false; }", fresh: "if (!silent) update(u); silent = false;", catches: "draw" },
  "only in the constructor": { old: "update(u: { view: EditorView }) { tame(u.view); }", fresh: "update() {}", catches: "sources" },
  "keeps parsing": { old: "return updateImpl.call(this, withTreeOfTheEditor(state));", fresh: "return updateImpl.call(this, state);", catches: "tree" },
  "language parser stays": { old: "(f === language ? languageStub : target.facet(f))", fresh: "target.facet(f)", catches: "tree" },
  "tree growth not followed": { old: "return shouldUpdate.call(this, u) || treeGrown(u);", fresh: "return shouldUpdate.call(this, u);", catches: "tree" },
  "does not draw on a grown tree": { old: "  if (treeGrown(u)) return true;\n", fresh: "", catches: "tree" },
  "always recomputes": { old: "syntaxTree(u.state) !== syntaxTree(u.startState)", fresh: "true", catches: "tree" },
  "wrapped twice": { old: "|| TREE_SHARED.has(kind)) return false;", fresh: ") return false;", catches: "tree" },
  "without probe": { old: "constructor(view: EditorView) { prepareSetup(); tame(view); }", fresh: "constructor(view: EditorView) { tame(view); }", catches: "sources" },
  "instance without class replacement": { old: "    partsSyntaxTree(classOf(m.text));\n", fresh: "", catches: "sources" },
  "focus empties": { old: `.filter((k) => k !== "cm-focused")`, fresh: "", catches: "sources" },
};

test("(1)+(4) minimap: plugins, shared font storage, drawing only on change, the editor's syntax tree — EXECUTED", async () => {
  const m = await load(SOURCE);
  for (const [name, p] of Object.entries(CHECKS)) { try { await p(m); } catch (e) { throw new Error(`${name}: ${e.message}`); } }
});
test("(2) the library carries what the replacement builds on", () => { LIBRARY(MINIMAP_DIST, LOCK); });
test("(3) the sources", () => { SOURCES(SOURCE, PANE); });
test("counter-probes: every sabotage appears exactly once and is caught", async () => {
  const stale = [], notCaught = [];
  for (const [name, s] of Object.entries(SABOTAGES)) {
    const n = SOURCE.split(s.old).length - 1;
    if (n !== 1) { stale.push(`${name} (${n}x)`); continue; }
    const q = SOURCE.replace(s.old, s.fresh);
    let caught = false;
    try { if (s.catches === "sources") SOURCES(q, PANE); else await CHECKS[s.catches](await load(q)); } catch { caught = true; }
    if (!caught) notCaught.push(name);
  }
  // On the library and on CodePane: one counter-probe each.
  let b = false; try { LIBRARY(MINIMAP_DIST.replace("this.text.beforeDraw();", ""), LOCK); } catch { b = true; }
  if (!b) notCaught.push("library without beforeDraw");
  let c = false; try { SOURCES(SOURCE, PANE.replace("list.push(minimapFont, showMinimap.compute(", "list.push(showMinimap.compute(")); } catch { c = true; }
  if (!c) notCaught.push("CodePane without minimapFont");
  let d = false; try { LIBRARY(MINIMAP_DIST.replace("const tree = parser ? parser.parse(docToString, treeFragments) : undefined;", "const tree = syntaxTree(state);"), LOCK); } catch { d = true; }
  if (!d) notCaught.push("library parses differently");
  assert.deepEqual(stale, [], "sabotages whose spot does not appear exactly once");
  assert.deepEqual(notCaught, [], "sabotages that no check catches");
  console.log(`  [minimap-font] ${Object.keys(SABOTAGES).length + 3} sabotages, each caught`);
});
