// Completion of the language service: `completions { position, trigger? }` — when typing a word, after a trigger character of the server and
// on request (⌃Space). An entry with `range` replaces that range, one with `snippet` is inserted as a snippet (LSP placeholders
// `$1`/`${1:x}`/`$0` in CodeMirror's form; Tab jumps to the next placeholder).
//
// The suggestion list follows VS Code (suggestWidget.ts, suggest.css; computations in lib/suggestion-list.ts, shape in lsp-theme.ts):
// - per row the kind's codicon in its colour (in the selected row in the chosen font), the name in the editor font, hits bold and blue,
//   `labelDetails.detail` dimmed behind it, `labelDetails.description` on the right; a deprecated entry struck through.
// - the detail of an entry without `labelDetails` appears on the right ONLY in the selected row (VS Code `showInlineDetails`); detail and docs
//   are fetched by the view for the selected row (`completion_resolve` — typescript-language-server only delivers both there).
// - the docs beside the list are CLOSED by default (VS Code `expandSuggestionDocs`): ⌃Space with an open list or the "›" of the selected row
//   toggles them — at once in EVERY editor of the window, remembered in the browser; the detail on top in the editor font, the docs below,
//   the ✕ closes them. Expandable only with docs or a detail ≠ name (VS Code `canExpandCompletionItem`).
// - ↵ AND Tab accept the selected suggestion, even right after opening; the first row is selected; 430 px wide, 12 rows high at the
//   editor's line height.
//
// Behaviour like VS Code:
// - Accepting inserts the text AND the server's additional edits (`additionalTextEdits`, the import of an auto-import): if the entry is already
//   resolved, in ONE step (one undo); otherwise it is resolved after inserting and the edits are added if nothing changed before them in the
//   meantime (lib/suggestion-list.ts `additionInText`). Then the entry's command, as far as the editor knows it (new suggestions, parameter hints).
// - When the list appears while typing: the trigger characters OF THE SERVER (status `triggers`), words only in code — not in comments and
//   strings (except JSON/YAML, `editor.quickSuggestions`); an open, incomplete list keeps asking where it stands.
// - The docs beside the list build their Markdown view only when CodeMirror really mounts them AND they are open: an answer CodeMirror
//   discards (the list changed while resolving — it then calls no `destroy`) leaves no React root behind.
import {
  acceptCompletion, autocompletion, completionStatus, insertCompletionText, pickedCompletion, selectedCompletion, snippet, startCompletion,
  type Completion, type CompletionContext, type CompletionResult,
} from "@codemirror/autocomplete";
import { Prec, StateEffect, StateField, type EditorState, type Extension, type Text, type TransactionSpec } from "@codemirror/state";
import { EditorView, ViewPlugin, keymap } from "@codemirror/view";
import { language, syntaxTree } from "@codemirror/language";
import { isNotSupported, lspAreaOf, lspPosOf, type LspCompletion } from "@/lib/api";
import {
  SYMBOL_COLORS, SUGGESTION_COLORS, SUGGESTION_DIMENSIONS, triggerAt, canExpand, fastSuggestion, syntaxKind, suggestionSymbol, additionInText,
  type Change,
} from "@/lib/suggestion-list";
import { hoverSections } from "@/lib/hover-sections";
import { tr } from "@/lib/i18n";
import { triggerOf, questions, can, lspFileOf, type LspFile } from "@/components/code/lsp-core";
import { showParameterHints } from "@/components/code/lsp-signature";
import { hoverNode } from "@/components/code/lsp-markdown";
import { colorize, languageForName } from "@/components/code/code-colorize";
import { codiconNode } from "@/components/code/codicon";

/** LSP snippet → CodeMirror snippet: `$1` → `${1}`, `${1|a,b|}` → `${1:a}`, `$0` (final) last; a `#{` in the text stays text. */
export function asCmSnippet(s: string): string {
  const seq = (n: string) => (n === "0" ? "1000" : n);
  return s
    .replace(/#\{/g, "#\\{")
    .replace(/\$\{(\d+)\|([^,|}]*)[^}]*\|\}/g, (_m, n: string, a: string) => `\${${seq(n)}:${a}}`)
    .replace(/\$\{(\d+)(:[^}]*)?\}/g, (_m, n: string, rest = "") => `\${${seq(n)}${rest}}`)
    .replace(/\$(\d+)/g, (_m, n: string) => `\${${seq(n)}}`);
}

// ── Per suggestion: the server's entry, the file, the state of the request, the resolved part ──────────────────────────────────────────
type Entry = {
  item: LspCompletion; file: LspFile; view: EditorView;
  /** The text the server computed against (ranges of the additional edits). */
  doc: Text;
  resolved: Promise<void> | null;
  /** Resolved (or nothing to resolve): what `item` says is everything. */
  finished: boolean;
  detailNode: HTMLElement | null;
  rightNode: HTMLElement | null;
};
const ENTRY = new WeakMap<Completion, Entry>();
/** With `labelDetails` (VS Code: not "string-label") the description is always on the right; otherwise the detail, only in the selected row. */
const withLabelDetails = (it: LspCompletion) => Boolean(it.labelDetail || it.description);
const singleLine = (s: string) => s.replace(/\r\n|\r|\n/g, "");

/** Fetch detail, docs, additional edits and command (once per entry). An older list or an error: nothing is remembered — the next
 *  selection of the row asks again. */
function resolve(e: Entry): Promise<void> {
  if (e.resolved) return e.resolved;
  const identifier = e.item.resolve;
  if (!identifier) { e.finished = true; return (e.resolved = Promise.resolve()); }
  let running: Promise<void> | null = null;
  running = (async () => {
    try {
      const r = await questions(e.file, "completion_resolve", { resolve: identifier });
      if (isNotSupported(r) || !r.resolved) { if (e.resolved === running) e.resolved = null; return; }
      e.item = {
        ...e.item, ...(r.detail ? { detail: r.detail } : {}), ...(r.documentation ? { documentation: r.documentation } : {}),
        ...(r.additionalTextEdits ? { additionalTextEdits: r.additionalTextEdits } : {}), ...(r.command ? { command: r.command } : {}),
      };
      e.finished = true;
      rowBringAlong(e);
    } catch { if (e.resolved === running) e.resolved = null; }
  })();
  e.resolved = running;
  return running;
}

// ── Accepting: text, additional edits, command ───────────────────────────────────────────────────────────────────────────────────────
/** The additional edits of an entry in the view's current text (or null): ranges against the state of the request, valid only entirely before `before`. */
function additionNow(e: Entry, state: EditorState, before: number): Change[] | null {
  const eds = e.item.additionalTextEdits ?? [];
  const changes = eds.map((ed) => ({ ...lspAreaOf(e.doc, ed.range), insert: ed.newText }));
  return additionInText(changes, before, (until) => e.doc.sliceString(0, until), (until) => state.doc.sliceString(0, until));
}
function command(view: EditorView, cmd: LspCompletion["command"]): void {
  if (cmd === "editor.action.triggerSuggest") startCompletion(view);
  else if (cmd === "editor.action.triggerParameterHints") showParameterHints(view);
}
function accept(c: Completion, area: { from: number; to: number } | null) {
  return (view: EditorView, _c: Completion, from: number, to: number) => {
    const e = ENTRY.get(c);
    if (!e) return;
    const it = e.item, text = it.insertText ?? it.label;
    const f = area ? Math.min(area.from, from) : from, t = area ? Math.max(area.to, to) : to;
    const addition = e.finished ? additionNow(e, view.state, f) : null;
    if (it.snippet) {
      snippet(asCmSnippet(text))(view, c, f, t);
      if (addition) view.dispatch({ changes: addition, userEvent: "input.complete" });
    } else {
      const main: TransactionSpec = { ...insertCompletionText(view.state, text, f, t), annotations: pickedCompletion.of(c) };
      // Without `sequential` both parts apply to the text BEFORE the step — one undo takes text and import together.
      if (addition) view.dispatch(main, { changes: addition });
      else view.dispatch(main);
    }
    if (!e.finished) {
      // Not resolved yet (VS Code "async additional edits"): add after resolving if nothing changed before them.
      void resolve(e).then(() => {
        if (!e.finished || !view.dom.isConnected) return;
        const late = additionNow(e, view.state, f);
        if (late) view.dispatch({ changes: late, userEvent: "input.complete" });
      });
    }
    command(view, it.command);
  };
}

// ── Docs beside the list: closed by default, for all editors of the window (VS Code `expandSuggestionDocs`), remembered in the browser ──
const DOCS_KEY = "cbase.editor.suggestion-docs";
const readDocs = () => { try { return localStorage.getItem(DOCS_KEY) === "1"; } catch { return false; } };
let docsGlobal = readDocs();
const DOCS_VIEWS = new Set<EditorView>();
let docsListens = false;
const toggleDocs = StateEffect.define<boolean>();
const docsField = StateField.define<boolean>({
  create: () => docsGlobal,
  update(v, trn) { for (const e of trn.effects) if (e.is(toggleDocs)) v = e.value; return v; },
});
const docsOpen = (state: EditorState) => state.field(docsField, false) ?? false;
function distributeDocs(): void {
  for (const v of DOCS_VIEWS) if (docsOpen(v.state) !== docsGlobal) v.dispatch({ effects: toggleDocs.of(docsGlobal) });
}
/** Open or close the docs — at once in every editor of the window, in other windows via the `storage` event. */
export function setSuggestionDocs(open: boolean): void {
  docsGlobal = open;
  try { localStorage.setItem(DOCS_KEY, open ? "1" : "0"); } catch { /* this session only */ }
  distributeDocs();
}
const docsSubscription = ViewPlugin.define((view) => {
  DOCS_VIEWS.add(view);
  if (!docsListens && typeof window !== "undefined") {
    docsListens = true;
    window.addEventListener("storage", (ev) => { if (ev.key === DOCS_KEY) { docsGlobal = ev.newValue === "1"; distributeDocs(); } });
  }
  return { destroy: () => { DOCS_VIEWS.delete(view); } };
});

// ── The row ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function symbolPart(c: Completion): Node | null {
  const e = ENTRY.get(c);
  if (!e) return null;
  const s = suggestionSymbol(e.item.kind);
  const wrapper = document.createElement("span");
  wrapper.className = `cm-suggestion-symbol${s.color ? ` cm-suggestion-symbol-${s.color}` : ""}`;
  wrapper.dataset.codicon = s.codicon;
  wrapper.appendChild(codiconNode(s.glyph, "cm-suggestion-codicon"));
  return wrapper;
}
function signaturePart(c: Completion): Node | null {
  const it = ENTRY.get(c)?.item;
  if (!it?.labelDetail) return null;
  const s = document.createElement("span");
  s.className = "cm-suggestion-signature";
  s.textContent = singleLine(it.labelDetail);
  return s;
}
function moreNode(): HTMLElement {
  const more = document.createElement("span");
  more.className = "cm-suggestion-more";
  more.title = tr("Read More");
  more.setAttribute("role", "button");
  more.appendChild(codiconNode("chevron-right", "cm-suggestion-codicon"));
  more.addEventListener("mousedown", (ev) => { ev.preventDefault(); ev.stopPropagation(); });
  more.addEventListener("click", (ev) => { ev.preventDefault(); ev.stopPropagation(); setSuggestionDocs(!docsGlobal); });
  return more;
}
function rightPart(c: Completion): Node | null {
  const e = ENTRY.get(c);
  if (!e) return null;
  const right = document.createElement("span");
  right.className = "cm-suggestion-right";
  const detail = document.createElement("span");
  const lbl = withLabelDetails(e.item);
  detail.className = lbl ? "cm-suggestion-description" : "cm-suggestion-detail";
  detail.textContent = singleLine((lbl ? e.item.description : e.item.detail) ?? "");
  e.detailNode = lbl ? null : detail;
  e.rightNode = right;
  right.appendChild(detail);
  if (canExpand(e.item)) right.appendChild(moreNode());
  return right;
}
/** After resolving: the detail of the selected row and its "›" (VS Code redraws the row). */
function rowBringAlong(e: Entry): void {
  if (e.detailNode && !withLabelDetails(e.item)) e.detailNode.textContent = singleLine(e.item.detail ?? "");
  const r = e.rightNode;
  if (r && canExpand(e.item) && !r.querySelector(".cm-suggestion-more")) r.appendChild(moreNode());
}

// ── The docs beside the list ─────────────────────────────────────────────────────────────────────────────────────────────────────
type Languages = Map<string, Awaited<ReturnType<typeof languageForName>>>;
type DocsPane = { dom: HTMLElement; e: Entry; closed: boolean; built: boolean; destroy: () => void };
/** The mounted docs per view — the one the expanding builds. */
const DOCS_PANE = new WeakMap<EditorView, DocsPane>();

async function languagesOf(e: Entry): Promise<Languages> {
  const docs = e.item.documentation ?? "";
  if (!docs) return new Map();
  const own = e.view.state.facet(language);
  const names = [...new Set(hoverSections(docs).flat().flatMap((t) => (t.kind === "code" ? [t.language] : [])))];
  return new Map(await Promise.all(names.map(async (n) => [n, await languageForName(n, own)] as const)));
}
/** Build the content (once per docs): header with detail and ✕, below the docs as Markdown — only here the React root is created. */
async function buildDocs(p: DocsPane, upfront: Languages | null): Promise<void> {
  if (p.built || p.closed) return;
  p.built = true;
  const languages = upfront ?? await languagesOf(p.e);
  if (p.closed) return;
  const { item, view } = p.e;
  const detail = singleLine(item.detail ?? ""), docs = item.documentation ?? "";
  if (detail && docs) p.dom.classList.add("cm-suggestion-docs-beides");
  const header = document.createElement("div");
  header.className = "cm-suggestion-docs-header";
  if (detail) { const type = document.createElement("div"); type.className = "cm-suggestion-docs-type"; type.textContent = item.detail ?? ""; header.appendChild(type); }
  const marker = document.createElement("span");
  marker.className = "cm-suggestion-docs-close";
  marker.title = tr("Close");
  marker.setAttribute("role", "button");
  marker.appendChild(codiconNode("close", "cm-suggestion-codicon"));
  marker.addEventListener("mousedown", (ev) => { ev.preventDefault(); ev.stopPropagation(); setSuggestionDocs(false); });
  header.appendChild(marker);
  p.dom.appendChild(header);
  if (docs) {
    const k = hoverNode(hoverSections(docs), (t) => colorize(view.state, t.text, languages.get(t.language) ?? null));
    k.dom.className = "cm-suggestion-docs-text";
    p.dom.appendChild(k.dom);
    p.destroy = k.destroy;
  }
}
async function docsPart(c: Completion): Promise<{ dom: Node; destroy: () => void } | null> {
  const e = ENTRY.get(c);
  if (!e) return null;
  await resolve(e);
  const view = e.view;
  if (!canExpand(e.item) || selectedCompletion(view.state) !== c) return null;
  // With open docs, the preparation (languages of the code blocks) before returning — building still happens only once mounted (see header).
  const upfront = docsOpen(view.state) ? await languagesOf(e) : null;
  if (selectedCompletion(view.state) !== c) return null;
  const p: DocsPane = { dom: document.createElement("div"), e, closed: false, built: false, destroy: () => {} };
  p.dom.className = "cm-suggestion-docs";
  // CodeMirror mounts the docs only AFTER this promise (in a microtask) — or silently discards them. Check afterwards.
  setTimeout(() => {
    if (p.closed || !p.dom.isConnected) return;
    DOCS_PANE.set(view, p);
    if (docsOpen(view.state)) void buildDocs(p, upfront);
  }, 0);
  return { dom: p.dom, destroy: () => { p.closed = true; p.destroy(); if (DOCS_PANE.get(view) === p) DOCS_PANE.delete(view); } };
}
/** Expanded (also from another editor): build this view's mounted docs now. */
const docsBuild = EditorView.updateListener.of((u) => {
  if (!docsOpen(u.state) || docsOpen(u.startState)) return;
  const p = DOCS_PANE.get(u.view);
  if (p && !p.closed) void buildDocs(p, null);
});

/** Docs placement like VS Code: right of the list, top aligned; without room left, without both below. */
type Rectangle = { left: number; right: number; top: number; bottom: number };
function docsSituation(_view: EditorView, list: Rectangle, _choice: Rectangle, _docs: Rectangle, space: Rectangle) {
  const { docsWidth, minWidth } = SUGGESTION_DIMENSIONS;
  const right = space.right - list.right, left = list.left - space.left;
  if (right >= docsWidth) return { style: `top: -1px; width: ${docsWidth}px`, class: "cm-completionInfo-right" };
  if (left >= docsWidth) return { style: `top: -1px; width: ${docsWidth}px`, class: "cm-completionInfo-left" };
  return { style: `top: ${list.bottom - list.top - 1}px; width: ${Math.max(minWidth, list.right - list.left)}px`, class: "cm-completionInfo-bottom" };
}

// ── The source ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** The start of an open, INCOMPLETE list per view (moves with the text, falls with the list): continued typing there keeps
 *  asking, also inside a string (VS Code asks an open list again, wherever it is). */
const OPEN = new WeakMap<EditorView, number>();
const openFollowUps = EditorView.updateListener.of((u) => {
  const from = OPEN.get(u.view);
  if (from === undefined) return;
  if (completionStatus(u.state) === null) OPEN.delete(u.view);
  else if (u.docChanged) OPEN.set(u.view, u.changes.mapPos(from));
});
/** The names of the syntax nodes at the caret, from inside out. */
function nodeNames(state: EditorState, pos: number): string[] {
  const names: string[] = [];
  for (let n: ReturnType<typeof syntaxTree>["topNode"] | null = syntaxTree(state).resolveInner(pos, -1); n; n = n.parent) names.push(n.name);
  return names;
}

async function source(ctx: CompletionContext): Promise<CompletionResult | null> {
  const d = lspFileOf(ctx.state);
  if (!can(d, "completion")) return null;
  const view = ctx.view;
  const word = ctx.matchBefore(/[\w$]+$/);
  const trigger = triggerAt(ctx.state.sliceDoc(Math.max(0, ctx.pos - 4), ctx.pos), triggerOf(d).completion);
  if (!ctx.explicit && !trigger) {
    if (!word) return null;
    const further = view !== undefined && OPEN.get(view) === word.from;
    if (!further && !fastSuggestion(d.language, syntaxKind(nodeNames(ctx.state, ctx.pos)))) return null;
  }
  const doc = ctx.state.doc;
  let r;
  try { r = await questions(d, "completions", { position: lspPosOf(doc, ctx.pos), ...(trigger && !word ? { trigger: trigger } : {}) }); } catch { return null; }
  if (ctx.aborted || isNotSupported(r) || !r.items?.length || !view) return null;
  const sorted = [...r.items].sort((a, b) => (a.sortText ?? a.label).localeCompare(b.sortText ?? b.label));
  const options: Completion[] = sorted.map((item, i) => {
    const area = item.range ? lspAreaOf(doc, item.range) : null;
    const c: Completion = {
      label: item.label,
      // Whether docs exist is only known after resolving (VS Code asks for the selected row).
      info: item.resolve || canExpand(item) ? docsPart : undefined,
      // The server's order as a slight precedence (CodeMirror sorts by match quality; this breaks ties).
      boost: Math.round(40 - (80 * i) / Math.max(1, sorted.length)),
    };
    c.apply = accept(c, area);
    ENTRY.set(c, { item, file: d, view, doc, resolved: null, finished: !item.resolve, detailNode: null, rightNode: null });
    return c;
  });
  const from = word ? word.from : ctx.pos;
  if (r.incomplete) OPEN.set(view, from);
  else OPEN.delete(view);
  return { from, options, validFor: r.incomplete ? undefined : /^[\w$]*$/ };
}

// The colours of the list and the symbols per mode (variables on the editor; a base theme because only it knows `&dark`/`&light`).
const variables = (m: "dark" | "light") => {
  const f = SUGGESTION_COLORS[m];
  return {
    "--cb-suggestion-background": f.background, "--cb-suggestion-selected-background": f.selectedBackground, "--cb-suggestion-selected-text": f.selectedText,
    "--cb-suggestion-selected-icon": f.selectedIcon, "--cb-suggestion-highlight": f.highlight, "--cb-suggestion-highlight-selected": f.selectedHighlight,
    "--cb-symbol-orange": SYMBOL_COLORS.orange[m], "--cb-symbol-violet": SYMBOL_COLORS.violet[m], "--cb-symbol-blue": SYMBOL_COLORS.blue[m],
    "--cb-snippet-field": f.snippetField,
  };
};
const colorVariables = EditorView.baseTheme({ "&dark": variables("dark"), "&light": variables("light") });

// ⌃Space with an open list: toggle the docs (VS Code `toggleSuggestionDetails`); Tab accepts the suggestion like ↵.
const keys = Prec.highest(keymap.of([
  { key: "Ctrl-Space", run: (v) => (completionStatus(v.state) === "active" ? (setSuggestionDocs(!docsGlobal), true) : false) },
  { key: "Tab", run: acceptCompletion },
]));

export const lspCompletion: Extension = [
  docsField,
  docsSubscription,
  docsBuild,
  openFollowUps,
  colorVariables,
  keys,
  autocompletion({
    override: [source],
    icons: false,
    activateOnTypingDelay: 10, // VS Code `editor.quickSuggestionsDelay`
    interactionDelay: 0, // VS Code accepts ↵/Tab at once, even right after opening
    tooltipClass: (state) => (docsOpen(state) ? "cm-suggestion-list cm-suggestion-with-docs" : "cm-suggestion-list"),
    optionClass: (c) => { const it = ENTRY.get(c)?.item; return [it?.deprecated ? "cm-suggestion-stale" : "", it && withLabelDetails(it) ? "cm-suggestion-with-label" : ""].filter(Boolean).join(" "); },
    addToOptions: [
      { render: symbolPart, position: 20 },
      { render: signaturePart, position: 60 },
      { render: rightPart, position: 80 },
    ],
    positionInfo: docsSituation,
  }),
];
