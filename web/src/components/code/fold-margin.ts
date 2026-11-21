// The fold arrows in the file editor's margin: chevrons as in VS Code (open ⌄, closed ›, colour `editorGutter.foldingControlForeground`)
// instead of CodeMirror's text characters, and an open arrow appears only while the pointer is over the margin (VS Code
// `editor.showFoldingControls: "mouseover"`); a folded spot keeps its arrow and its line is highlighted (`editor.foldBackground`). Every arrow
// has a name for screen readers and pointing devices (VS Code: "Click to collapse/expand the range."). Replaces basicSetup's fold gutter
// (components/CodePane.tsx sets `foldGutter: false` there and takes this one — two margins would be two arrow columns). Guard:
// web/test/editor-look.test.mjs (binding to CodePane).
import type { Extension, Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { foldGutter, foldedRanges } from "@codemirror/language";
import { tr } from "@/lib/i18n";
import { marginAtText } from "@/components/code/gutters";

const SVG = "http://www.w3.org/2000/svg";
/** A chevron (16 px, stroke 1.5 px) — down (open) or to the right (folded). */
function arrow(open: boolean): HTMLElement {
  const s = document.createElement("span");
  s.className = "cm-fold";
  if (open) s.setAttribute("data-open", "");
  const name = tr(open ? "Click to collapse the range." : "Click to expand the range.");
  s.setAttribute("role", "button");
  s.setAttribute("aria-expanded", String(open));
  s.setAttribute("aria-label", name);
  s.title = name;
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS(SVG, "path");
  p.setAttribute("d", open ? "M4 6l4 4 4-4" : "M6 4l4 4-4 4");
  p.setAttribute("fill", "none");
  p.setAttribute("stroke", "currentColor");
  p.setAttribute("stroke-width", "1.5");
  p.setAttribute("stroke-linecap", "round");
  p.setAttribute("stroke-linejoin", "round");
  svg.appendChild(p);
  s.appendChild(svg);
  return s;
}

/** The line where a folded range begins, highlighted (VS Code `editor.foldBackground`). */
const FOLDED = Decoration.line({ class: "cm-folded" });
const foldedRows = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = this.build(view); }
  update(u: ViewUpdate) {
    if (u.docChanged || foldedRanges(u.state) !== foldedRanges(u.startState)) this.decorations = this.build(u.view);
  }
  build(view: EditorView): DecorationSet {
    const out: Range<Decoration>[] = [];
    let last = -1;
    foldedRanges(view.state).between(0, view.state.doc.length, (from) => {
      const l = view.state.doc.lineAt(from);
      if (l.from !== last) { out.push(FOLDED.range(l.from)); last = l.from; }
    });
    return Decoration.set(out, true);
  }
}, { decorations: (p) => p.decorations });

const form = EditorView.theme({
  ".cm-foldGutter .cm-gutterElement": { display: "flex", alignItems: "center", justifyContent: "center", width: "16px", cursor: "pointer" },
  ".cm-fold": { display: "grid", placeItems: "center", color: "var(--cb-fold)", transition: "opacity 120ms ease" },
  ".cm-fold[data-open]": { opacity: "0" },
  ".cm-gutters:hover .cm-fold[data-open]": { opacity: "1" },
  ".cm-folded": { backgroundColor: "var(--cb-fold-background)" },
});

// Directly at the text, right of line numbers and git margin (components/code/gutters.ts).
export const foldMargin: Extension = [marginAtText(foldGutter({ markerDOM: arrow })), foldedRows, form];
