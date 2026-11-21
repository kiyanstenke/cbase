// Port of: microsoft/vscode src/vs/editor/contrib/colorPicker/browser/colorDetector.ts (MIT)
// Port of: microsoft/vscode src/vs/editor/contrib/colorPicker/browser/colorPicker.css (MIT)
// Colour squares like VS Code: where the server reports `document_color` (CSS/SCSS/Less, JSON with a colour schema), a small square in that
// colour precedes every colour value — VS Code `ColorDetector`: the colours of the whole file on open, after a change only after `COLOR_NEW_MS`
// of quiet (until then the squares move with the text), at most 500. Size and border from colorPicker.css `.colorpicker-color-decoration`
// (border .1em #eee in dark, #000 in light; .8em wide and high; margin .1em top, .2em left and right; inline-block).
// The colour picker (click on the square, hover over the colour value) lives in components/code/color-picker.ts; it reads the AREAS of the
// colours from here (`colorAt`).
import { RangeSetBuilder, StateEffect, StateField, type EditorState, type Extension, type Text } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { isNotSupported, lspOffsetOf } from "@/lib/api";
import { subscribeLspStatus } from "@/lib/lsp-status";
import { COLOR_CAP, COLOR_NEW_MS, colorSquares, type ColorPlace } from "@/lib/color-square";
import { questions, can, lspFileOf } from "@/components/code/lsp-core";

class ColorSquare extends WidgetType {
  constructor(readonly css: string) { super(); }
  eq(o: ColorSquare) { return o.css === this.css; }
  toDOM() {
    const s = document.createElement("span");
    s.className = "cm-color-square";
    s.style.backgroundColor = this.css;
    s.textContent = " "; // VS Code: the content is a non-breaking space
    s.setAttribute("aria-hidden", "true");
    return s;
  }
  ignoreEvent() { return false; }
}

/** The squares of an answer as widgets before the start of each area. */
export function colorMarkers(doc: Text, colors: readonly ColorPlace[]): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  const places = colorSquares(colors).map((q) => ({ at: lspOffsetOf(doc, q.start), css: q.css })).sort((a, c) => a.at - c.at);
  for (const q of places) b.add(q.at, q.at, Decoration.widget({ widget: new ColorSquare(q.css), side: -1 }));
  return b.finish();
}
/** The areas of the colours (not drawn) — the colour picker asks which colour sits at a position. */
export function colorAreas(doc: Text, colors: readonly ColorPlace[]): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  const places = colors.slice(0, COLOR_CAP).map((f) => ({ from: lspOffsetOf(doc, f.range.start), to: lspOffsetOf(doc, f.range.end), color: f.color }))
    .filter((x) => x.to > x.from).sort((a, c) => a.from - c.from || a.to - c.to);
  for (const x of places) b.add(x.from, x.to, Decoration.mark({ color: x.color, inclusive: false }));
  return b.finish();
}

type Colors = { squares: DecorationSet; areas: DecorationSet };
const set = StateEffect.define<Colors>();
const field = StateField.define<Colors>({
  create: () => ({ squares: Decoration.none, areas: Decoration.none }),
  update(d, tr) {
    for (const e of tr.effects) if (e.is(set)) return e.value;
    return tr.docChanged ? { squares: d.squares.map(tr.changes), areas: d.areas.map(tr.changes) } : d;
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.squares),
});
const EMPTY: Colors = { squares: Decoration.none, areas: Decoration.none };

/** The colour whose area contains `pos` (start and end included — the square sits AT the start) — or null. */
export function colorAt(state: EditorState, pos: number): { from: number; to: number; color: ColorPlace["color"] } | null {
  const f = state.field(field, false);
  if (!f) return null;
  let hits: { from: number; to: number; color: ColorPlace["color"] } | null = null;
  f.areas.between(pos, pos, (from, to, d) => { if (!hits && from <= pos && pos <= to) hits = { from, to, color: d.spec.color }; });
  return hits;
}

const fetch = ViewPlugin.fromClass(class {
  tick: ReturnType<typeof setTimeout> | null = null;
  running: AbortController | null = null;
  destroyed = false;
  off: () => void = () => {};
  key = "";
  constructor(readonly view: EditorView) { this.followUp(); this.plane(0); }
  followUp() {
    const d = lspFileOf(this.view.state);
    const k = d ? d.buffer.key : "";
    if (k === this.key) return;
    this.off();
    this.key = k;
    this.off = d ? subscribeLspStatus(d.buffer.target, d.buffer.path, () => this.plane(0)) : () => {};
  }
  update(u: ViewUpdate) {
    this.followUp();
    if (!u.docChanged) return;
    this.running?.abort();
    this.plane(COLOR_NEW_MS);
  }
  plane(ms: number) {
    if (this.destroyed) return;
    if (this.tick) clearTimeout(this.tick);
    this.tick = setTimeout(() => { this.tick = null; void this.fetch(); }, ms);
  }
  async fetch() {
    const v = this.view, d = lspFileOf(v.state);
    if (this.destroyed || !v.dom.isConnected) return;
    if (!can(d, "document_color")) {
      const now = v.state.field(field, false);
      if (now && now !== EMPTY && (now.squares.size || now.areas.size)) v.dispatch({ effects: set.of(EMPTY) });
      return;
    }
    this.running?.abort();
    const ac = new AbortController(), doc = v.state.doc;
    this.running = ac;
    let r;
    try { r = await questions(d, "colors", {}, ac.signal); } catch { r = null; } finally { if (this.running === ac) this.running = null; }
    if (this.destroyed || ac.signal.aborted || !r || !v.dom.isConnected) return;
    if (v.state.doc !== doc) { this.plane(COLOR_NEW_MS); return; } // outdated: the squares move on, ask again at once
    if (isNotSupported(r)) return;
    v.dispatch({ effects: set.of({ squares: colorMarkers(doc, r.colors ?? []), areas: colorAreas(doc, r.colors ?? []) }) });
  }
  destroy() {
    this.destroyed = true;
    if (this.tick) clearTimeout(this.tick);
    this.running?.abort();
    this.off();
  }
});

// colorPicker.css: `.colorpicker-color-decoration { border: solid .1em #000; box-sizing: border-box; margin: .1em
// var(--vscode-colorPicker-colorDecoratorMargin) 0; width: var(--vscode-colorPicker-colorDecoratorWidth); height: .8em; line-height: .8em;
// display: inline-block; cursor: pointer }`, in dark `border: solid .1em #eee`; ColorDetector sets width .8em and margin .2em
// (`colorDecoratorInnerWidthInEm`, `colorDecoratorMarginInEm`).
const theme = EditorView.baseTheme({
  ".cm-color-square": {
    border: "solid .1em #000", boxSizing: "border-box", margin: ".1em .2em 0", width: ".8em", height: ".8em", lineHeight: ".8em",
    display: "inline-block", cursor: "pointer",
  },
  "&dark .cm-color-square": { borderColor: "#eee" },
});

export const lspColors: Extension = [field, fetch, theme];
