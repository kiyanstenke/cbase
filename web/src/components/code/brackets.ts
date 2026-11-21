// Bracket-pair colouring in the code editor: every bracket `( ) [ ] { }` gets the colour of its depth (gold, orchid, blue — the
// Light Modern counterparts in light mode); a mismatched one (no partner, also an open one that is never closed) is red. The computation
// is lib/bracket-colors.ts: one `BracketRun` per view, working with checkpoints — after a text change from the last checkpoint before the
// first changed position, after a new syntax tree without a text change from the first position BEFORE what is already computed where
// the trees differ (`firstDeviation` — the background parser delivers many new trees that are equal at the front). Computation runs to the
// end of the visible area and on until every visible open bracket is decided. Whether a bracket sits in a string or a comment is told by
// the highlight tags of the syntax tree (`notCodeAreas`). A file without a language (no tree) stays uncoloured, as in VS Code.
//
// The colours are set by the theme (components/code/codeTheme.ts, variables `--cb-bracket-*`); the class also applies to the syntax span
// INSIDE the selection, otherwise its colour would win.
import type { Extension, Range } from "@codemirror/state";
import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { BracketRun, firstFrom, firstDeviation, bracketColor, notCodeAreas } from "@/lib/bracket-colors";

type Tree = ReturnType<typeof syntaxTree>;

const MARKERS = [0, 1, 2].map((i) => Decoration.mark({ class: `cm-bracket-${i}` }));
const MISMATCHED = Decoration.mark({ class: "cm-bracket-mismatched" });

export const bracketColors: Extension = ViewPlugin.fromClass(class {
  decorations: DecorationSet = Decoration.none;
  run = new BracketRun();
  tree: Tree;
  constructor(view: EditorView) {
    this.tree = syntaxTree(view.state);
    this.decorations = this.build(view);
  }
  update(u: ViewUpdate) {
    const tree = syntaxTree(u.state);
    let fresh = false;
    if (u.docChanged) {
      let start = Infinity;
      u.changes.iterChangedRanges((fromA) => { start = Math.min(start, fromA); });
      this.run.dismissFrom(start); // before it the text (and its classification) is unchanged
      fresh = true;
    } else if (tree !== this.tree) {
      const start = firstDeviation(this.tree, tree, this.run.far);
      if (start >= 0) { this.run.dismissFrom(start); fresh = true; }
    }
    this.tree = tree;
    if (fresh || u.viewportChanged) this.decorations = this.build(u.view);
  }
  build(view: EditorView): DecorationSet {
    const st = view.state, tree = syntaxTree(st);
    if (!tree.length) return Decoration.none;
    const { from, to } = view.viewport, end = st.doc.length;
    const text = (a: number, b: number) => st.sliceDoc(a, b);
    const notCode = (a: number, b: number) => notCodeAreas(tree, a, b);
    this.run.further(to, end, text, notCode);
    this.run.decide(from, end, text, notCode);
    const out: Range<Decoration>[] = [];
    const findings = this.run.findings;
    for (let i = firstFrom(findings, from); i < findings.length && findings[i].pos < to; i++) {
      const f = bracketColor(findings[i]);
      out.push((f < 0 ? MISMATCHED : MARKERS[f]).range(findings[i].pos, findings[i].pos + 1));
    }
    return Decoration.set(out);
  }
}, { decorations: (p) => p.decorations });
