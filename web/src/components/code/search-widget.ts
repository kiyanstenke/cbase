// The find/replace widget of the code editor, styled like VS Code: floating at the top right over the text, one field with the toggles
// Match Case (Aa), Match Whole Word (ab) and Use Regular Expression (.*), next to it "n of m" or "No results", up/down (Shift+Enter /
// Enter), "Find in Selection" and close (Esc); on the left the arrow for the replace row with "Preserve Case" (AB) in the field, "Replace"
// (Enter) and "Replace All" (Cmd+Enter). Cmd+F opens (Ctrl+F elsewhere), Alt+Cmd+F with the replace row (Ctrl+H); what is taken over as the
// search text is decided by lib/search-rules.ts `searchSeed` (VS Code: the selection of one line or the word at the caret, nothing for
// several lines or with focus in the widget). Typing jumps to the next match from where the search began (VS Code `findOnType`). Up/down in
// the field browse the search history. An invalid regular expression turns the field red and names the error below it. Matches show in the
// text (the @codemirror/search highlight) and in the overview ruler (all counted ones, via `searchHits`; drawn by
// components/code/overviewRuler.ts — the widget draws no marks of its own). While the widget is open, space of its height is made above the
// first line (VS Code `find.addExtraSpaceOnTop`), and a match is never scrolled under the widget (`scrollMargins`).
//
// Built on @codemirror/search (`search({ top, createPanel })`): state, query, find-next and replace stay there — this module is the form,
// "Find in Selection" (a `test` filter on the query, the range in `areaField`) and replacing with preserved case (lib/preserve-case.ts).
// The rules are pure, in lib/search-rules.ts and lib/search-counter.ts (guard in web/test/editor-look.test.mjs). Lives in `codeTheme`
// (components/code/codeTheme.ts), so it applies to the file editor, diff and peek. The command table (lib/editor-commands.ts) holds
// "Search" and "Replace" for the palette — this module binds the keys, since diff and peek without the table have search too.

import { EditorSelection, Prec, StateEffect, StateField, type EditorState, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, keymap, runScopeHandlers, type Panel, type ViewUpdate } from "@codemirror/view";
import {
  SearchQuery, closeSearchPanel, findNext, findPrevious, getSearchQuery, openSearchPanel, replaceAll, replaceNext, search, searchPanelOpen,
  setSearchQuery,
} from "@codemirror/search";
import { command, registerCommand } from "@/lib/editor-commands";
import { countHits, counterDisplay } from "@/lib/search-counter";
import { SEED_MAX, TOGGLE_KEYS, SearchHistory, replacementFor, regexError, searchSeed, searchKey, type Toggle } from "@/lib/search-rules";
import { preserveCase } from "@/lib/preserve-case";
import { isMac } from "@/lib/chat-bar";
import { textPx } from "@/lib/appearance";
import { tr } from "@/lib/i18n";
import type { EditorContext } from "@/components/code/lsp-core";

const MAC = isMac();
const SVG = "http://www.w3.org/2000/svg";
/** After this much quiet a typed search text enters the history (VS Code `_delayedUpdateHistory`). */
const HISTORY_MS = 500;
/** One history per window for the search and replace fields (VS Code: per workspace). */
const searchHistory = new SearchHistory(), replaceHistory = new SearchHistory();

type Query = "caseSensitive" | "wholeWord" | "regexp";
const TOGGLE: { kind: Query; text: string; title: string }[] = [
  { kind: "caseSensitive", text: "Aa", title: "Match Case" },
  { kind: "wholeWord", text: "ab", title: "Match Whole Word" },
  { kind: "regexp", text: ".*", title: "Use Regular Expression" },
];
/** The label of a shortcut: Cmd/Alt+Cmd on the Mac, otherwise "Ctrl+"/"Alt+". */
const mod = () => (MAC ? "⌘" : tr("Ctrl+"));
const option = () => (MAC ? "⌥⌘" : "Alt+");

function el<K extends keyof HTMLElementTagNameMap>(tag: K, kind: string, attrs: Record<string, string> = {}): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = kind;
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}
/** An icon (16 px grid, 1.3 px stroke) from paths. */
function symbol(...paths: string[]): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("aria-hidden", "true");
  for (const d of paths) {
    const p = document.createElementNS(SVG, "path");
    p.setAttribute("d", d);
    p.setAttribute("fill", "none");
    p.setAttribute("stroke", "currentColor");
    p.setAttribute("stroke-width", "1.3");
    p.setAttribute("stroke-linecap", "round");
    p.setAttribute("stroke-linejoin", "round");
    svg.appendChild(p);
  }
  return svg;
}
const ARROW_RIGHT = "M6 4l4 4-4 4", ARROW_BOTTOM = "M4 6l4 4 4-4";
function button(kind: string, title: string, content: Node | string, click: () => void): HTMLButtonElement {
  const b = el("button", `cm-search-button ${kind}`, { type: "button", title: title, "aria-label": title });
  b.append(content);
  // mousedown instead of a focus change: focus stays in the field, as in VS Code.
  b.addEventListener("mousedown", (e) => e.preventDefault());
  b.addEventListener("click", click);
  return b;
}
const setToggle = (b: HTMLButtonElement, on: boolean) => { b.toggleAttribute("data-on", on); b.setAttribute("aria-pressed", String(on)); };

// ── Find in Selection: the range, a filter on the query, the highlighted lines ────────────────────────────────────────────────────
type Chunk = { from: number; to: number };
const setArea = StateEffect.define<readonly Chunk[] | null>();
const areaField = StateField.define<readonly Chunk[] | null>({
  create: () => null,
  update(v, t) {
    for (const e of t.effects) if (e.is(setArea)) return e.value;
    if (!v || !searchPanelOpen(t.state)) return null; // the range goes with the widget
    if (!t.docChanged) return v;
    const fresh = v.map((r) => ({ from: t.changes.mapPos(r.from, 1), to: t.changes.mapPos(r.to, -1) })).filter((r) => r.to > r.from);
    return fresh.length ? fresh : null;
  },
});
const AREA_ROW = Decoration.line({ class: "cm-search-area" });
const areaDeco = EditorView.decorations.compute([areaField], (st) => {
  const b = st.field(areaField);
  if (!b) return Decoration.none;
  const out: Range<Decoration>[] = [];
  let last = 0;
  for (const r of b) {
    for (let n = Math.max(st.doc.lineAt(r.from).number, last + 1); n <= st.doc.lineAt(r.to).number; n++) { out.push(AREA_ROW.range(st.doc.line(n).from)); last = n; }
  }
  return Decoration.set(out, true);
});
/** The filter of every query: without a range everything, otherwise only matches entirely inside it. One function for all — otherwise every query would be "new". */
const inArea = (_hits: string, st: EditorState, from: number, to: number): boolean => {
  const b = st.field(areaField, false);
  return !b || b.some((r) => from >= r.from && to <= r.to);
};
/** The range from the selection (VS Code `_onFindInSelectionToggle`): every non-empty selection; if it ends at the start of a later line, at the
 *  end of the line before. null: no selection. */
function areaFromSelection(st: EditorState): Chunk[] | null {
  const out: Chunk[] = [];
  for (const r of st.selection.ranges) {
    if (r.empty) continue;
    const l = st.doc.lineAt(r.to);
    const to = r.to === l.from && l.number > st.doc.lineAt(r.from).number ? l.from - 1 : r.to;
    if (to > r.from) out.push({ from: r.from, to });
  }
  return out.length ? out : null;
}
const query = (spec: { search: string; replace: string; caseSensitive: boolean; wholeWord: boolean; regexp: boolean }) =>
  new SearchQuery({ ...spec, literal: true, test: inArea });

// ── Replace with preserved case (otherwise @codemirror/search replaces itself) ─────────────────────────────────────────────────────
const preserveCaseOn = new WeakMap<EditorView, boolean>();
type Hits = { from: number; to: number; match?: RegExpExecArray };
function next(st: EditorState, q: SearchQuery, start: number): Hits | null {
  let r = q.getCursor(st, start).next();
  if (r.done) r = q.getCursor(st, 0, start).next();
  return r.done ? null : (r.value as Hits);
}
const substituteFor = (st: EditorState, q: SearchQuery, t: Hits) =>
  preserveCase(st.sliceDoc(t.from, t.to), replacementFor(q.replace, q.regexp, t.match ? [...t.match] : null));
function replaceOne(view: EditorView): boolean {
  if (!preserveCaseOn.get(view)) return replaceNext(view);
  const st = view.state, q = getSearchQuery(st), { from, to } = st.selection.main;
  if (st.readOnly || !q.search || !q.valid) return false;
  let t = next(st, q, from);
  if (!t) return false;
  const changes: { from: number; to: number; insert: string }[] = [];
  if (t.from === from && t.to === to) {
    changes.push({ from: t.from, to: t.to, insert: substituteFor(st, q, t) });
    const further = next(st, q, t.to);
    t = further && further.from !== t.from ? further : null;
  }
  const cs = st.changes(changes);
  const sel = t ? EditorSelection.single(t.from, t.to).map(cs) : undefined;
  view.dispatch({ changes: cs, selection: sel, effects: sel ? [EditorView.scrollIntoView(sel.main, { y: "nearest", yMargin: 80 })] : [], userEvent: "input.replace" });
  return true;
}
function replaceAllMatches(view: EditorView): boolean {
  if (!preserveCaseOn.get(view)) return replaceAll(view);
  const st = view.state, q = getSearchQuery(st);
  if (st.readOnly || !q.search || !q.valid) return false;
  const changes: { from: number; to: number; insert: string }[] = [];
  const it = q.getCursor(st);
  for (let r = it.next(); !r.done; r = it.next()) changes.push({ from: r.value.from, to: r.value.to, insert: substituteFor(st, q, r.value as Hits) });
  if (!changes.length) return false;
  view.dispatch({ changes, userEvent: "input.replace.all" });
  return true;
}

// ── Space above the first line while the widget is open ────────────────────────────────────────────────────────────────────────
class Gap extends WidgetType {
  toDOM() { const d = document.createElement("div"); d.className = "cm-search-gap"; d.setAttribute("aria-hidden", "true"); return d; }
  eq() { return true; }
  get estimatedHeight() { return 33; }
}
const GAP = Decoration.set([Decoration.widget({ widget: new Gap(), block: true, side: -1 }).range(0)]);
const gapField = StateField.define<boolean>({
  create: (st) => searchPanelOpen(st),
  update: (_v, t) => searchPanelOpen(t.state),
  provide: (f) => EditorView.decorations.from(f, (open) => (open ? GAP : Decoration.none)),
});

// ── The matches for the overview ruler ─────────────────────────────────────────────────────────────────────────────────────────
const setHits = StateEffect.define<readonly number[]>();
const NO: readonly number[] = [];
/** The starts of the counted matches (at most as many as the counter counts) while the widget is open — otherwise none. Set after every
 *  count; in between they stay (the next count step follows in the next frame). */
export const searchHits = StateField.define<readonly number[]>({
  create: () => NO,
  update(v, t) {
    for (const e of t.effects) if (e.is(setHits)) return e.value;
    return searchPanelOpen(t.state) ? v : NO;
  },
});

const panels = new WeakMap<EditorView, SearchPanel>();

class SearchPanel implements Panel {
  readonly dom: HTMLElement;
  readonly top = true;
  readonly field: HTMLInputElement;
  readonly replaceField: HTMLInputElement;
  readonly widget: HTMLElement;
  private readonly fieldWrapper: HTMLElement;
  private readonly notice: HTMLElement;
  private readonly switcher: HTMLButtonElement;
  private readonly countEl: HTMLElement;
  private readonly up: HTMLButtonElement;
  private readonly down: HTMLButtonElement;
  private readonly areaButton: HTMLButtonElement;
  private readonly fallButton: HTMLButtonElement;
  private readonly toggles = new Map<Query, HTMLButtonElement>();
  private query: SearchQuery;
  private tick = 0;
  private historyTimer: ReturnType<typeof setTimeout> | null = null;
  /** Typing jumps to the next match from here (where the search began). */
  anchor: number;
  replaceOpen = false;
  /** The height of the widget (for the space above and the scroll margin). */
  height = 33;

  constructor(readonly view: EditorView) {
    this.query = getSearchQuery(view.state);
    this.anchor = view.state.selection.main.from;
    this.dom = el("div", "cm-search-wrapper");
    this.widget = el("div", "cm-search", { role: "dialog", "aria-label": tr("Search") });
    this.switcher = button("cm-search-switcher", tr("Toggle Replace##editor"), symbol(ARROW_RIGHT), () => this.showReplace(!this.replaceOpen, true));
    this.switcher.setAttribute("aria-expanded", "false");

    this.field = el("input", "cm-search-input", { type: "text", placeholder: tr("Search"), "aria-label": tr("Search"), "main-field": "true", spellcheck: "false" });
    this.fieldWrapper = el("div", "cm-search-field");
    this.fieldWrapper.append(this.field);
    for (const s of TOGGLE) {
      const title = `${tr(s.title)} (${option()}${TOGGLE_KEYS[s.kind]})`;
      const b = button("cm-search-toggle", title, s.text, () => this.toggle(s.kind));
      setToggle(b, false);
      if (s.kind === "wholeWord") b.classList.add("cm-search-word");
      this.toggles.set(s.kind, b);
      this.fieldWrapper.append(b);
    }
    this.notice = el("div", "cm-search-notice", { role: "alert" });
    const searchColumn = el("div", "cm-search-column");
    searchColumn.append(this.fieldWrapper, this.notice);
    this.countEl = el("div", "cm-search-count", { "aria-live": "polite" });
    this.up = button("", `${tr("Previous Match")} (⇧↵)`, symbol("M8 13V3", "M4 7l4-4 4 4"), () => { this.rememberHistory(); findPrevious(view); });
    this.down = button("", `${tr("Next Match")} (↵)`, symbol("M8 3v10", "M4 9l4 4 4-4"), () => { this.rememberHistory(); findNext(view); });
    this.areaButton = button("cm-search-toggle cm-search-area-button", `${tr("Find in Selection")} (${option()}${TOGGLE_KEYS.inSelection})`,
      symbol("M2.5 3.5h11", "M2.5 6.5h7", "M2.5 9.5h11", "M2.5 12.5h7"), () => this.toggle("inSelection"));
    setToggle(this.areaButton, false);
    const closeButton = button("", tr("Close (Esc)"), symbol("M4 4l8 8", "M12 4l-8 8"), () => { closeSearchPanel(view); view.focus(); });
    const row1 = el("div", "cm-search-row");
    row1.append(searchColumn, this.countEl, this.up, this.down, this.areaButton, closeButton);

    this.replaceField = el("input", "cm-search-input", { type: "text", placeholder: tr("Replace"), "aria-label": tr("Replace"), spellcheck: "false" });
    const replaceWrapper = el("div", "cm-search-field");
    this.fallButton = button("cm-search-toggle", `${tr("Preserve Case")} (${option()}${TOGGLE_KEYS.preserveCase})`, "AB", () => this.toggle("preserveCase"));
    setToggle(this.fallButton, Boolean(preserveCaseOn.get(view)));
    replaceWrapper.append(this.replaceField, this.fallButton);
    const one = button("", `${tr("Replace")} (↵)`, symbol("M2.5 5.5h6", "M6.5 3.5l2 2-2 2", "M10.5 9.5h3v4h-3z"), () => { this.rememberHistory(); replaceOne(view); });
    const all = button("", `${tr("Replace All")} (${mod()}↵)`, symbol("M2.5 5.5h6", "M6.5 3.5l2 2-2 2", "M9.5 8.5h3v3h-3z", "M11.5 11.5v2h2v-2"), () => { this.rememberHistory(); replaceAllMatches(view); });
    const row2 = el("div", "cm-search-row cm-search-replace");
    row2.append(replaceWrapper, one, all);

    const rows = el("div", "cm-search-rows");
    rows.append(row1, row2);
    if (!view.state.readOnly) this.widget.append(this.switcher);
    this.widget.append(rows);
    this.dom.append(this.widget);
    this.widget.addEventListener("keydown", (e) => this.key(e));
    this.field.addEventListener("input", () => { this.takeOver(); this.jumpAtTyping(); this.historySoon(); });
    this.replaceField.addEventListener("input", () => { this.takeOver(); this.historySoon(); });

    this.set(this.query);
    panels.set(view, this);
  }

  showReplace(on: boolean, focus = false) {
    this.replaceOpen = on && !this.view.state.readOnly;
    this.widget.toggleAttribute("data-replace", this.replaceOpen);
    this.switcher.setAttribute("aria-expanded", String(this.replaceOpen));
    this.switcher.replaceChildren(symbol(this.replaceOpen ? ARROW_BOTTOM : ARROW_RIGHT));
    if (focus) (this.replaceOpen ? this.replaceField : this.field).focus();
    this.measureHeight();
  }

  mount() {
    this.field.focus();
    this.field.select();
    this.measureHeight();
    this.count();
  }
  update(u: ViewUpdate) {
    let fresh = false;
    for (const t of u.transactions) for (const e of t.effects) if (e.is(setSearchQuery) && !e.value.eq(this.query)) { this.set(e.value); fresh = true; }
    if (u.selectionSet && !u.transactions.some((t) => t.isUserEvent("select.search"))) this.anchor = u.state.selection.main.from;
    const areaNew = u.state.field(areaField) !== u.startState.field(areaField);
    if (u.selectionSet || areaNew) this.showArea();
    if (fresh || areaNew || u.docChanged || u.selectionSet) this.count();
  }
  destroy() {
    if (panels.get(this.view) === this) panels.delete(this.view);
    cancelAnimationFrame(this.tick);
    if (this.historyTimer) clearTimeout(this.historyTimer);
  }

  private set(q: SearchQuery) {
    this.query = q;
    if (this.field.value !== q.search) this.field.value = q.search;
    if (this.replaceField.value !== q.replace) this.replaceField.value = q.replace;
    for (const [kind, b] of this.toggles) setToggle(b, Boolean(q[kind]));
    const error = regexError(q.search, q.regexp);
    this.fieldWrapper.toggleAttribute("data-error", error != null);
    this.notice.textContent = error ?? "";
  }
  /** The fields and toggles as a query on the search state. Literal as in VS Code: `\n` in the search text is not a line break. */
  private takeOver(change: Partial<Record<Query, boolean>> = {}, always = false) {
    const q = query({
      search: this.field.value, replace: this.replaceField.value,
      caseSensitive: change.caseSensitive ?? this.query.caseSensitive,
      wholeWord: change.wholeWord ?? this.query.wholeWord,
      regexp: change.regexp ?? this.query.regexp,
    });
    if (always || !q.eq(this.query)) { this.set(q); this.view.dispatch({ effects: setSearchQuery.of(q) }); }
  }
  /** A toggle: match case, whole word, regex, in selection, preserve case. */
  toggle(kind: Toggle) {
    if (kind === "preserveCase") {
      preserveCaseOn.set(this.view, !preserveCaseOn.get(this.view));
      setToggle(this.fallButton, Boolean(preserveCaseOn.get(this.view)));
      return;
    }
    if (kind === "inSelection") {
      const st = this.view.state;
      const fresh = st.field(areaField) ? null : areaFromSelection(st);
      if (!fresh && !st.field(areaField)) return; // without a selection there is nothing to restrict (the button is off then)
      // Set an equal query anew: the @codemirror/search highlight would otherwise compute with the old range.
      this.view.dispatch({ effects: [setArea.of(fresh), setSearchQuery.of(query(this.query))] });
      return;
    }
    this.takeOver({ [kind]: !this.query[kind] });
    this.jumpAtTyping();
  }
  private showArea() {
    const st = this.view.state, on = Boolean(st.field(areaField));
    setToggle(this.areaButton, on);
    this.areaButton.disabled = !on && !areaFromSelection(st);
  }
  /** Typing searches along: the first match from the anchor (otherwise from the start) is selected and made visible — focus stays in the field. */
  private jumpAtTyping() {
    const q = this.query, st = this.view.state;
    if (!q.search || !q.valid) return;
    let r = q.getCursor(st, this.anchor).next();
    if (r.done) r = q.getCursor(st, 0, this.anchor).next();
    if (r.done) return;
    this.view.dispatch({
      selection: EditorSelection.single(r.value.from, r.value.to),
      effects: EditorView.scrollIntoView(r.value.from, { y: "nearest", yMargin: 80 }),
      userEvent: "select.search",
    });
  }
  private historySoon() {
    if (this.historyTimer) clearTimeout(this.historyTimer);
    this.historyTimer = setTimeout(() => this.rememberHistory(), HISTORY_MS);
  }
  private rememberHistory() {
    searchHistory.add(this.field.value);
    replaceHistory.add(this.replaceField.value);
  }
  private key(e: KeyboardEvent) {
    const view = this.view;
    const field = e.target === this.field ? "search" : e.target === this.replaceField ? "replace" : "other";
    const a = searchKey(e, field, MAC, this.replaceOpen);
    if (!a) { if (runScopeHandlers(view, e, "search-panel")) e.preventDefault(); return; }
    e.preventDefault();
    switch (a.kind) {
      case "toggle": this.toggle(a.toggle); return;
      case "close": closeSearchPanel(view); view.focus(); return;
      case "further": this.rememberHistory(); findNext(view); return;
      case "back": this.rememberHistory(); findPrevious(view); return;
      case "replace": this.rememberHistory(); replaceOne(view); return;
      case "allReplace": this.rememberHistory(); replaceAllMatches(view); return;
      case "toReplace": this.replaceField.focus(); return;
      case "toSearch": this.field.focus(); return;
      case "historyBack": case "historyBefore": {
        const target = field === "search" ? this.field : this.replaceField, history = field === "search" ? searchHistory : replaceHistory;
        const value = a.kind === "historyBack" ? history.back(target.value) : history.before(target.value);
        if (value == null) return;
        target.value = value;
        this.takeOver();
        if (field === "search") this.jumpAtTyping();
      }
    }
  }

  /** Counts in the next frame (many changes in a row count once); the positions of the matches go to the overview ruler. */
  private count() {
    cancelAnimationFrame(this.tick);
    this.tick = requestAnimationFrame(() => {
      const st = this.view.state, q = getSearchQuery(st), findings: number[] = [];
      let counts = { count: 0, current: 0, capped: false };
      if (q.search && q.valid) {
        const it = q.getCursor(st);
        counts = countHits({ [Symbol.iterator]: () => it }, st.selection.main, undefined, findings);
      }
      const a = counterDisplay(q.search, q.valid, counts);
      this.countEl.textContent = a.kind === "empty" ? "" : a.kind === "no" ? tr("No results") : tr("{n} of {m}", { n: a.n, m: a.m });
      this.countEl.toggleAttribute("data-no", a.kind === "no");
      this.up.disabled = this.down.disabled = counts.count === 0;
      if (findings.length || this.view.state.field(searchHits).length) this.view.dispatch({ effects: setHits.of(findings) });
    });
  }
  /** The widget height as space above the first line (`--cb-search-height`) and as scroll margin. */
  private measureHeight() {
    this.view.requestMeasure({
      read: () => this.widget.offsetHeight,
      write: (h) => {
        if (!h || h === this.height) return;
        this.height = h;
        this.view.dom.style.setProperty("--cb-search-height", `${h}px`);
        this.view.requestMeasure();
      },
    });
  }
}

/** Cmd+F (replace=false) / Alt+Cmd+F or Ctrl+H: opens the widget. The search text comes from `searchSeed` (selection of one line, otherwise the
 *  word at the caret; with several lines or focus in the widget the previous one stays); this module always sets the query — @codemirror/search
 *  would have taken over a multi-line selection. An open replace row stays open. */
export function openSearch(view: EditorView, replace: boolean): boolean {
  const st = view.state, sel = st.selection.main, prior = getSearchQuery(st);
  const p0 = searchPanelOpen(st) ? panels.get(view) : undefined;
  const active = view.root.activeElement;
  const inWidget = Boolean(p0 && active && p0.dom.contains(active));
  const multiline = !sel.empty && st.doc.lineAt(sel.from).number !== st.doc.lineAt(sel.to).number;
  const selection = sel.empty || multiline || sel.to - sel.from >= SEED_MAX ? (sel.empty ? null : "") : st.sliceDoc(sel.from, sel.to);
  const w = sel.empty ? st.wordAt(sel.head) : null;
  const { seed, focus } = searchSeed({ selection, multiline, word: w ? st.sliceDoc(w.from, w.to) : null, inWidget, inSearchField: Boolean(p0 && active === p0.field), regexp: prior.regexp }, replace);
  openSearchPanel(view);
  const p = panels.get(view);
  if (!p) return true;
  if (!inWidget) p.anchor = sel.from;
  const q = query({ search: seed ?? prior.search, replace: prior.replace, caseSensitive: prior.caseSensitive, wholeWord: prior.wholeWord, regexp: prior.regexp });
  if (!q.eq(getSearchQuery(view.state))) view.dispatch({ effects: setSearchQuery.of(q) });
  p.showReplace(replace || p.replaceOpen);
  const target = focus === "replace" && p.replaceOpen ? p.replaceField : p.field;
  target.focus();
  target.select();
  return true;
}
/** Alt+Cmd+C/W/R/L/P (Alt+… elsewhere) in the editor while the widget is open. */
function toggleInEditor(kind: Toggle) {
  return (view: EditorView): boolean => {
    const p = searchPanelOpen(view.state) ? panels.get(view) : null;
    if (!p) return false;
    p.toggle(kind);
    return true;
  };
}

// "Search" and "Replace" in the command table — for the palette (`>`); the shortcut is only shown there, it is bound below (no `keys`).
for (const b of [
  { id: "actions.find", title: "Search", shortcut: MAC ? "⌘F" : "⌃F", replace: false },
  { id: "editor.action.startFindReplaceAction", title: "Replace", shortcut: MAC ? "⌥⌘F" : "⌃H", replace: true, writing: true },
]) {
  if (!command(b.id)) registerCommand<EditorContext>({ id: b.id, title: b.title, shortcut: b.shortcut, ...(b.writing ? { writing: true } : {}), execute: (k) => { openSearch(k.view, b.replace); } });
}

const form = EditorView.theme({
  ".cm-search-wrapper": { position: "relative", height: "0", overflow: "visible" },
  ".cm-search-gap": { height: "var(--cb-search-height, 33px)" },
  ".cm-search": {
    position: "absolute", top: "0", right: "14px", zIndex: "10", display: "flex", alignItems: "stretch", gap: "2px",
    padding: "4px 4px 4px 2px", backgroundColor: "var(--cb-widget-background)", color: "var(--cb-widget-text)",
    boxShadow: "0 0 8px 2px var(--cb-widget-shadow)", borderRadius: "0 0 4px 4px", fontFamily: "var(--font-sans)", fontSize: textPx(13),
  },
  ".cm-search-rows": { display: "flex", flexDirection: "column", gap: "4px" },
  ".cm-search-row": { display: "flex", alignItems: "center", gap: "2px", height: "24px" },
  ".cm-search-replace": { display: "none" },
  ".cm-search[data-replace] .cm-search-replace": { display: "flex" },
  ".cm-search-column": { position: "relative" },
  ".cm-search-field": {
    display: "flex", alignItems: "center", width: "240px", height: "24px", boxSizing: "border-box", padding: "0 2px 0 0",
    backgroundColor: "var(--cb-input-background)", border: "1px solid var(--cb-input-edge)", borderRadius: "2px",
  },
  ".cm-search-field:focus-within": { borderColor: "var(--cb-focus)" },
  ".cm-search-field[data-error]": { borderColor: "var(--cb-error-edge)" },
  ".cm-search-notice": {
    display: "none", position: "absolute", top: "100%", left: "0", right: "0", zIndex: "1", boxSizing: "border-box", padding: "4px 6px",
    backgroundColor: "var(--cb-error-background)", border: "1px solid var(--cb-error-edge)", borderTop: "none", fontSize: textPx(12), lineHeight: "1.4",
    whiteSpace: "normal", overflowWrap: "anywhere",
  },
  ".cm-search-field[data-error] + .cm-search-notice": { display: "block" },
  ".cm-search-input": {
    flex: "1", minWidth: "0", height: "100%", padding: "0 4px", border: "none", outline: "none", background: "transparent", color: "inherit",
    font: "inherit",
  },
  ".cm-search-button": {
    display: "grid", placeItems: "center", width: "22px", height: "22px", padding: "0", border: "1px solid transparent", borderRadius: "5px",
    background: "transparent", color: "inherit", cursor: "pointer", flex: "none",
  },
  ".cm-search-button:hover:not(:disabled)": { backgroundColor: "var(--cb-symbol-hover)" },
  ".cm-search-button:disabled": { opacity: "0.4", cursor: "default" },
  ".cm-search-switcher": { width: "16px", height: "auto", alignSelf: "stretch", borderRadius: "3px" },
  ".cm-search-toggle": { width: "20px", height: "20px", borderRadius: "3px", fontSize: textPx(11), fontFamily: "var(--font-mono)", letterSpacing: "-0.5px" },
  ".cm-search-toggle.cm-search-word": { textDecoration: "underline", textUnderlineOffset: "3px" },
  ".cm-search-toggle[data-on]": { backgroundColor: "var(--cb-option-active-background)", borderColor: "var(--cb-option-active-edge)", color: "var(--cb-option-active-text)" },
  ".cm-search-count": { minWidth: "72px", padding: "0 6px", fontSize: textPx(12), whiteSpace: "nowrap" },
  ".cm-search-count[data-no]": { color: "var(--cb-error-text)" },
  ".cm-search-area": { backgroundColor: "var(--cb-search-area)" },
});

export const searchWidget: Extension = [
  search({ top: true, literal: true, createPanel: (view) => new SearchPanel(view), scrollToMatch: (r) => EditorView.scrollIntoView(r, { y: "nearest", yMargin: 80 }) }),
  areaField, areaDeco, gapField, searchHits,
  // No match under the widget: the top edge of the scroll area counts as covered while it is open.
  EditorView.scrollMargins.of((view) => { const p = searchPanelOpen(view.state) ? panels.get(view) : null; return p ? { top: p.height } : null; }),
  Prec.high(keymap.of([
    // Also INSIDE the widget (scope "search-panel", via `searchKey` → runScopeHandlers): Alt+Cmd+F in the search field opens replace, Cmd+F brings the search field.
    { key: "Mod-f", run: (v) => openSearch(v, false), preventDefault: true, scope: "editor search-panel" },
    { key: MAC ? "Mod-Alt-f" : "Ctrl-h", run: (v) => openSearch(v, true), preventDefault: true, scope: "editor search-panel" },
    ...(Object.entries(TOGGLE_KEYS) as [Toggle, string][]).map(([kind, b]) => ({ key: MAC ? `Mod-Alt-${b.toLowerCase()}` : `Alt-${b.toLowerCase()}`, run: toggleInEditor(kind) })),
  ])),
  form,
];
