// The minimap draws only what changes and measures its font once.
//
// MEASURED: `@replit/codemirror-minimap` 0.5.2 draws after EVERY editor update — five times per keystroke (see (2)) — and empties its font
// cache before every draw (`TextState.beforeDraw`: `this._fontInfoMap.clear()`, "TODO … because it's slow" in its own source). Every token kind
// then asks anew: a probe node in `.cm-content` and `getComputedStyle` — ≈ 50 style computations per keystroke, 4.5 ms of script at ×1 in
// `getFontInfo` alone. The reason for clearing is a theme change (the library detects it via the editor's classes, but consumes the detection in
// `shouldUpdate` before `updateImpl` asks for it).
//
// HERE, without changing the library (no patch-package in the repo): a ViewPlugin extension BESIDE the minimap fetches its instance
// (`view.plugin(<plugin from showMinimap.extensions>)`) and replaces three things on THIS instance or its class:
//   (1) `text.beforeDraw` no longer clears: when the font KEY changes, the text component gets the cache of that key, SHARED by all minimaps in
//       the window (every opened file is a new instance — measured ≈ 20 ms per open at ×4). The key: the editor's classes (theme, font size:
//       CodeMirror generates classes per theme; without `cm-focused`), `data-theme` on the document (light/dark via variables) and the app's
//       text size (`--cb-text-scale`, inline style on the document). The token classes are keys of the cache anyway.
//   (2) `render` draws only when something the minimap shows changes: text, selection, diagnostics, folds, viewport or size change,
//       focus, reconfiguration, editor classes (`redraws`). Measured, it drew FIVE times per keystroke, each in its own frame (input,
//       completion, semantic highlighting, git gutter …) — batching per frame would not help. VS Code draws the minimap only when its inputs
//       change (`MinimapWidget` `onLinesChanged`/`onCursorStateChanged`/`onDecorationsChanged`/`onScrollChanged` …). Scrolling is drawn by the
//       library itself (own `scroll` listener) — untouched.
//   (3) The text component no longer parses itself. The library parsed the WHOLE document a second time (`TextState.updateImpl`:
//       `state.facet(language).parser.parse(doc.toString(), fragments)` — fully on open, incrementally per keystroke) although CodeMirror
//       already has the same tree. Replaced on the text component's CLASS (prototype, once per window): `updateImpl` gets the state with a
//       language whose "parser" returns the editor's tree (`syntaxTree(state)`, `withTreeOfTheEditor`) — otherwise the library runs unchanged
//       (highlighting, lines, folds). The editor's tree can be incomplete (CodeMirror keeps parsing large files in the background); when it
//       grows, the minimap recomputes and redraws (`treeGrown` in `shouldUpdate` and `redraws`) — like the editor's own highlighting. So that
//       even the FIRST minimap of the window does not parse, `minimapFont` comes BEFORE `showMinimap` and fetches the class beforehand from a
//       probe editor without text (`prepareSetup`).
// If it does not find the instance or the methods (other version), it does nothing — the minimap then behaves like the library.
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { foldEffect, language, syntaxTree, unfoldEffect } from "@codemirror/language";
import { setDiagnosticsEffect } from "@codemirror/lint";
import { showMinimap } from "@replit/codemirror-minimap";

/** The minimap's text component, as far as we touch it. */
export type MinimapText = { beforeDraw: () => void; _fontInfoMap?: Map<string, unknown> };
/** The minimap instance, as far as we touch it. */
export type MinimapInstance = { text?: MinimapText; update?: (u: MinimapUpdate) => void; render?: () => void };

const TAMED = new WeakSet<object>();
const BUNDLED = new WeakSet<object>();

/** The ViewPlugins `showMinimap` switches on (`Facet.define({ enables })` stores them in `extensions`) — the minimap itself and its
 *  overlay; which one carries the text component is decided by the instance (`text.beforeDraw`). */
export function minimapPlugins(facet: unknown = showMinimap): ViewPlugin<object>[] {
  const out: ViewPlugin<object>[] = [];
  const go = (x: unknown) => { if (x instanceof ViewPlugin) out.push(x as ViewPlugin<object>); else if (Array.isArray(x)) x.forEach(go); };
  go((facet as { extensions?: unknown })?.extensions);
  return out;
}

/** The font data per key, shared by all minimaps of the window (a new file is a new instance — it does not measure again what
 *  another already measured). At most `STORAGE_MAX` keys; the oldest falls out. */
export const STORAGE_MAX = 8;
export const FONT_STORAGE = new Map<string, Map<string, unknown>>();
function storageFor(shared: Map<string, Map<string, unknown>>, k: string): Map<string, unknown> {
  let m = shared.get(k);
  if (m) { shared.delete(k); shared.set(k, m); return m; }
  shared.set(k, (m = new Map()));
  while (shared.size > STORAGE_MAX) shared.delete(shared.keys().next().value as string);
  return m;
}

/** (1) Replaces `beforeDraw` of the text component: if `key()` has changed since the last draw, it gets the shared cache of that
 *  key (`_fontInfoMap`; if the field is missing, the original runs — clearing); otherwise nothing happens. false: nothing to tame or already tamed. */
export function tameFontCache(text: MinimapText | null | undefined, key: () => string, shared: Map<string, Map<string, unknown>> = FONT_STORAGE): boolean {
  if (!text || typeof text.beforeDraw !== "function" || TAMED.has(text)) return false;
  const clear = text.beforeDraw.bind(text);
  let last: string | null = null;
  text.beforeDraw = () => {
    const k = key();
    if (k === last) return;
    last = k;
    if (text._fontInfoMap instanceof Map) text._fontInfoMap = storageFor(shared, k);
    else clear();
  };
  TAMED.add(text);
  return true;
}

/** The update, as far as `redraws` reads it (CodeMirror `ViewUpdate`). */
export type MinimapUpdate = Pick<ViewUpdate, "docChanged" | "selectionSet" | "viewportChanged" | "geometryChanged" | "heightChanged" | "focusChanged" | "transactions" | "startState" | "state">;
/** Does this update change what the minimap shows? (Text, selection, diagnostics, folds, viewport/size, focus, configuration — the editor's
 *  classes are checked by `drawOnlyAtChange` alongside.) */
export function redraws(u: MinimapUpdate): boolean {
  if (u.docChanged || u.selectionSet || u.viewportChanged || u.geometryChanged || u.heightChanged || u.focusChanged) return true;
  if (u.startState.facet(showMinimap) !== u.state.facet(showMinimap)) return true;
  if (treeGrown(u)) return true;
  return u.transactions.some((tr) => tr.reconfigured || tr.effects.some((e) => e.is(setDiagnosticsEffect) || e.is(foldEffect) || e.is(unfoldEffect)));
}

/** (2) Replaces `update` and `render` of the instance: an update that changes nothing shown (and leaves the editor's classes alone) runs
 *  through the library (its states stay current) but does not draw. false: nothing to replace or already replaced. */
export function drawOnlyAtChange(m: MinimapInstance | null | undefined, classes: () => string): boolean {
  if (!m || typeof m.update !== "function" || typeof m.render !== "function" || BUNDLED.has(m)) return false;
  const update = m.update.bind(m), render = m.render.bind(m);
  let silent = false, last = classes();
  m.update = (u: MinimapUpdate) => {
    const k = classes();
    silent = !redraws(u) && k === last;
    last = k;
    try { update(u); } finally { silent = false; }
  };
  m.render = () => { if (!silent) render(); };
  BUNDLED.add(m);
  return true;
}

/** The class of the text component, as far as (3) touches it (the library's `TextState`). */
export type MinimapTextClass = { updateImpl: (state: EditorState, changes?: unknown) => void; shouldUpdate: (u: MinimapUpdate) => boolean };
const TREE_SHARED = new WeakSet<object>();

/** Has CodeMirror parsed further since the last update (or anew, after a change)? Never without a language. */
export function treeGrown(u: Pick<MinimapUpdate, "startState" | "state">): boolean {
  return u.state.facet(language) !== null && syntaxTree(u.state) !== syntaxTree(u.startState);
}

/** The state as the text component reads it — only the language differs: its "parser" returns the editor's tree instead of
 *  parsing. Everything else (document, fields, facets like the highlighting) is the state itself. Without a language: the state itself. */
export function withTreeOfTheEditor(state: EditorState): EditorState {
  if (!state.facet(language)) return state;
  const languageStub = { parser: { parse: () => syntaxTree(state) } };
  return new Proxy(state, {
    get(target, name) {
      if (name === "facet") return (f: Parameters<EditorState["facet"]>[0]) => (f === language ? languageStub : target.facet(f));
      const value = Reflect.get(target, name, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** (3) Replaces on the text component's class `updateImpl` (without its own parse, without fragments) and `shouldUpdate` (also when the
 *  editor's tree has grown). false: nothing to replace or already replaced. */
export function partsSyntaxTree(kind: MinimapTextClass | null | undefined): boolean {
  if (!kind || typeof kind.updateImpl !== "function" || typeof kind.shouldUpdate !== "function" || TREE_SHARED.has(kind)) return false;
  const updateImpl = kind.updateImpl, shouldUpdate = kind.shouldUpdate;
  kind.updateImpl = function (this: unknown, state: EditorState) { return updateImpl.call(this, withTreeOfTheEditor(state)); };
  kind.shouldUpdate = function (this: unknown, u: MinimapUpdate) { return shouldUpdate.call(this, u) || treeGrown(u); };
  TREE_SHARED.add(kind);
  return true;
}

/** The class of a minimap instance's text component (its prototype). */
const classOf = (text: object): MinimapTextClass | null => (Object.getPrototypeOf(text) as MinimapTextClass | null) ?? null;

/** Fetches the text component's class from a probe editor without text and parent node, before the first real minimap exists (its constructor
 *  already calls `updateImpl`) — once per window. If that fails, `tameFontCache` fetches it from the first real instance. */
let prepared = false;
export function prepareSetup(): void {
  if (prepared || typeof document === "undefined") return;
  prepared = true;
  try {
    const probe = new EditorView({ state: EditorState.create({ extensions: [showMinimap.compute([], () => ({ create: () => ({ dom: document.createElement("div") }) }))] }) });
    try {
      for (const p of PLUGINS) { const m = probe.plugin(p) as MinimapInstance | null; if (m?.text) partsSyntaxTree(classOf(m.text)); }
    } finally { probe.destroy(); }
  } catch { /* other version: then at the first real instance */ }
}

/** The font key of an editor (see above). */
export function fontKey(view: EditorView): string {
  const classes = [...view.dom.classList].filter((k) => k !== "cm-focused").sort().join(" ");
  const html = typeof document !== "undefined" ? document.documentElement : null;
  return `${classes}|${html?.dataset.theme ?? ""}|${html?.style.getPropertyValue("--cb-text-scale") ?? ""}`;
}

const PLUGINS = minimapPlugins();
function tame(view: EditorView) {
  for (const p of PLUGINS) {
    const m = view.plugin(p) as MinimapInstance | null;
    if (!m?.text) continue;
    partsSyntaxTree(classOf(m.text));
    tameFontCache(m.text, () => fontKey(view));
    drawOnlyAtChange(m, () => view.dom.className);
  }
}

/** BEFORE `showMinimap` in the extensions: prepares the class, tames the instance after every update (a new instance after `setState`)
 *  and on creation if the minimap already exists. */
export const minimapFont = ViewPlugin.fromClass(class {
  constructor(view: EditorView) { prepareSetup(); tame(view); }
  update(u: { view: EditorView }) { tame(u.view); }
});
