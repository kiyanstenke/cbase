// Indentation lines in the code editor: one hairline per indentation level, the active block's (at the caret) lighter — VS Code
// `editor.guides.indentation` and `highlightActiveIndentation`. A small decoration of our own instead of a package: the computation is in
// lib/indentation.ts (the file's unit detected like `editor.detectIndentation`, lines per line, active block, the line's style), here it
// is drawn — as background images of the line, so no element per line is needed and nothing lies over the text.
//
// The unit is detected when the view is created, when tab width or indentation default change and when the WHOLE text is replaced
// (another file in the same view) — not on every keystroke (VS Code detects once on opening). A remembered accessor computes the lines per
// line over the whole document; only the visible range is drawn, and the active block is followed from the caret's line into the visible
// range, even if the caret is far outside. The colours are set by the theme (components/code/codeTheme.ts, `--cb-guide`,
// `--cb-guide-active`).
import type { EditorState, Extension } from "@codemirror/state";
import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from "@codemirror/view";
import { getIndentUnit, language } from "@codemirror/language";
import { activeGuide, insetColumns, detectUnit, guideCalculator, linesStyle } from "@/lib/indentation";

/** This many lines from the start are read by the unit detection. */
const DETECTION_ROWS = 2000;

const rowsDeco = new Map<string, Decoration>();
function deco(stages: number, unit: number, active: number): Decoration {
  const k = `${stages}:${unit}:${active}`;
  let d = rowsDeco.get(k);
  if (!d) {
    d = Decoration.line({ attributes: { style: linesStyle(stages, unit, active) } });
    rowsDeco.set(k, d);
  }
  return d;
}

function detect(st: EditorState): number {
  const rows: string[] = [];
  for (let i = 1; i <= Math.min(st.doc.lines, DETECTION_ROWS); i++) rows.push(st.doc.line(i).text);
  return detectUnit(rows, getIndentUnit(st), st.tabSize);
}

export const indentationLines: Extension = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  unit: number;
  constructor(view: EditorView) {
    this.unit = detect(view.state);
    this.decorations = this.build(view);
  }
  update(u: ViewUpdate) {
    const setting = u.startState.tabSize !== u.state.tabSize || getIndentUnit(u.startState) !== getIndentUnit(u.state);
    let whole = false;
    if (u.docChanged) u.changes.iterChangedRanges((fromA, toA) => { if (fromA === 0 && toA === u.startState.doc.length) whole = true; });
    if (setting || whole) this.unit = detect(u.state);
    if (setting || u.docChanged || u.viewportChanged || u.selectionSet) this.decorations = this.build(u.view);
  }
  build(view: EditorView): DecorationSet {
    const st = view.state, doc = st.doc, tab = st.tabSize, n = doc.lines;
    const text = (i: number) => doc.line(i + 1).text;
    const aside = /python/i.test(st.facet(language)?.name ?? ""); // Python: a blank line before a shallower line no longer belongs to the block
    const f = guideCalculator(n, text, this.unit, tab, aside);
    const l0 = doc.lineAt(view.viewport.from).number - 1, l1 = doc.lineAt(view.viewport.to).number - 1;
    const marker = doc.lineAt(st.selection.main.head).number - 1;
    const guide = activeGuide(n, f, (i) => insetColumns(text(i), tab) >= 0, marker, Math.min(l0, marker), Math.max(l1, marker));
    const out = [];
    for (let i = l0; i <= l1; i++) {
      const stages = f(i);
      if (!stages) continue;
      out.push(deco(stages, this.unit, guide && i >= guide.from && i <= guide.until ? guide.level : -1).range(doc.line(i + 1).from));
    }
    return Decoration.set(out);
  }
}, { decorations: (p) => p.decorations });
