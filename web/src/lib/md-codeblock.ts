// Code blocks in the live-preview markdown editor (components/MarkdownEditor.tsx) — a ``` or ~~~ block is drawn as a BLOCK like
// `CodeBlock` in components/Markdown.tsx: box on the code background, language as header, monospace, tight lines (box-drawing characters
// ─ ┐ │ ▼ ◀ meet vertically), long lines scroll INSIDE the box instead of wrapping, no visible fences. An ASCII diagram embedded
// this way no longer gets torn apart by the editor.
//
// Two shapes, as with the tables in the editor:
//   - Widget: the block is REPLACED by a block widget — in reading mode always, when editing as long as the caret is not inside it. A
//     click into the code puts the caret exactly at the clicked place (the source opens there).
//   - Source: if the caret is in the block, it appears raw, WITH fences, editable like any line — but every line in the same code box
//     (line decorations: background, monospace, tight lines; first/last line rounded). So only the fence opens on clicking in, not the
//     whole shape.
//
// Only top-level blocks: a fence in a list or a quote carries its marker on the same lines ("- ```", "> ```") — replacing line by line
// would eat them. Those stay source.
//
// As a StateField (block decorations change the height and may only come from the state). When the editor "reads" (reading mode or
// without focus) and whether it is editable is decided by the caller — only the calculation and the drawing are here.

import { syntaxTree } from "@codemirror/language";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { type EditorState, type Range, StateField, type Text, type Transaction } from "@codemirror/state";

/** A code block: `language` from the info line (first word), `rows` the content WITHOUT fences and without the fence's indentation
 *  (CommonMark), `rel[i]` the offset of row i to the block start — relative, so a reused widget does not hang on old numbers after a
 *  change further up. */
export interface CodeBlockModel { src: string; language: string; rows: string[]; rel: number[] }

/** The classes the theme in MarkdownEditor.tsx hangs on — ONE list for calculation and style. */
export const CODE_CLASS = {
  widget: "cm-code-widget", language: "cm-code-language", pre: "cm-code-pre",
  row: "cm-code-row", first: "cm-code-row-first", last: "cm-code-row-last",
} as const;

type SyntaxNode = ReturnType<typeof syntaxTree>["topNode"];

/** First and last line (numbers) of a FencedCode node, snapped to whole lines. */
function blockRows(doc: Text, node: SyntaxNode): { first: number; last: number } {
  const first = doc.lineAt(node.from).number;
  const endLine = doc.lineAt(node.to);
  const last = endLine.from === node.to && node.to > doc.line(first).from ? endLine.number - 1 : endLine.number;
  return { first, last: Math.max(first, last) };
}

export function codeBlockModel(doc: Text, node: SyntaxNode): CodeBlockModel {
  const { first, last } = blockRows(doc, node);
  const header = doc.line(first);
  const start = header.from;
  // Closed if the last fence stands on a LINE of its own after the opening one. An open block runs to the end.
  const markers = node.getChildren("CodeMark");
  const closed = markers.length > 1 && doc.lineAt(markers[markers.length - 1].from).number > first;
  const info = node.getChild("CodeInfo");
  const language = info ? doc.sliceString(info.from, info.to).trim().split(/\s+/)[0] ?? "" : "";
  const inset = /^ */.exec(header.text)?.[0].length ?? 0;
  const rows: string[] = [];
  const rel: number[] = [];
  for (let n = first + 1; n <= (closed ? last - 1 : last); n++) {
    const z = doc.line(n);
    const cut = Math.min(inset, /^ */.exec(z.text)?.[0].length ?? 0);
    rows.push(z.text.slice(cut));
    rel.push(z.from + cut - start);
  }
  return { src: doc.sliceString(start, doc.line(last).to), language, rows, rel };
}

export class CodeBlockWidget extends WidgetType {
  constructor(readonly model: CodeBlockModel, readonly editable: boolean) { super(); }
  eq(other: CodeBlockWidget) { return other.model.src === this.model.src && other.editable === this.editable; }
  toDOM(view: EditorView) {
    const { language, rows, rel } = this.model;
    const wrap = document.createElement("div");
    wrap.className = CODE_CLASS.widget;
    if (language) {
      const header = document.createElement("div");
      header.className = CODE_CLASS.language;
      header.textContent = language;
      wrap.appendChild(header);
    }
    const pre = document.createElement("pre");
    pre.className = CODE_CLASS.pre;
    const code = document.createElement("code");
    // ONE text node per row, separated by "\n": the click finds the row via the node and the column via the offset.
    const rowOf = new WeakMap<Node, number>();
    rows.forEach((z, i) => {
      if (i) code.appendChild(document.createTextNode("\n"));
      const t = document.createTextNode(z);
      rowOf.set(t, i);
      code.appendChild(t);
    });
    pre.appendChild(code);
    wrap.appendChild(pre);
    if (this.editable) {
      // Click: caret at the clicked place so that the source opens EXACTLY there. The start comes from the widget's current position
      // (`posAtDOM`). A click on the scrollbar hits no text and stays the scrollbar's.
      wrap.addEventListener("mousedown", (e) => {
        const target = e.target as HTMLElement | null;
        if (target === pre && e.offsetY > pre.clientHeight) return; // horizontal scrollbar
        e.preventDefault();
        const blockStart = view.posAtDOM(wrap);
        let pos = blockStart + (rel[0] ?? 0);
        const hits = hitsInText(e.clientX, e.clientY);
        const row = hits ? rowOf.get(hits.node) : undefined;
        if (hits && row !== undefined) pos = blockStart + rel[row] + hits.offset;
        else if (!rel.length) pos = blockStart;
        view.focus();
        view.dispatch({ selection: { anchor: Math.min(pos, view.state.doc.length) }, scrollIntoView: true });
      });
    }
    return wrap;
  }
  ignoreEvent() { return true; }
}

/** Which text node at which offset lies under the pointer — Chromium/Safari know `caretRangeFromPoint`, Firefox `caretPositionFromPoint`. */
function hitsInText(x: number, y: number): { node: Node; offset: number } | null {
  const d = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => globalThis.Range | null;
  };
  const p = d.caretPositionFromPoint?.(x, y);
  if (p) return { node: p.offsetNode, offset: p.offset };
  const r = d.caretRangeFromPoint?.(x, y);
  return r ? { node: r.startContainer, offset: r.startOffset } : null;
}

const rowsDeco = (classes: string) => Decoration.line({ class: classes });

/** The decorations of all top-level code blocks. `reading`: widget everywhere; otherwise widget where the caret is not, and the
 *  source in the code box where it is. */
export function codeBlockDecorations(state: EditorState, reading: boolean, editable: boolean): DecorationSet {
  const sel = state.selection.main;
  const doc = state.doc;
  const ranges: Range<Decoration>[] = [];
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name === "Document") return true;
      if (node.name !== "FencedCode") return false; // only the top level (see above)
      const { first, last } = blockRows(doc, node.node);
      const from = doc.line(first).from;
      const to = doc.line(last).to;
      if (!reading && sel.from <= to && sel.to >= from) {
        for (let n = first; n <= last; n++) {
          const k = [CODE_CLASS.row, n === first ? CODE_CLASS.first : "", n === last ? CODE_CLASS.last : ""].filter(Boolean).join(" ");
          ranges.push(rowsDeco(k).range(doc.line(n).from));
        }
        return false;
      }
      const widget = new CodeBlockWidget(codeBlockModel(doc, node.node), editable);
      ranges.push(Decoration.replace({ widget, block: true }).range(from, to));
      return false;
    },
  });
  return Decoration.set(ranges, true);
}

/** The field. `reading`/`editable` from the caller's state; `fresh` says whether a transaction must recalculate (the tree also grows
 *  without a change — the parser catches up in the background). */
export function codeBlockField(opt: {
  reading: (s: EditorState) => boolean;
  editable: (s: EditorState) => boolean;
  fresh: (tr: Transaction) => boolean;
}) {
  const compute = (s: EditorState) => codeBlockDecorations(s, opt.reading(s), opt.editable(s));
  return StateField.define<DecorationSet>({
    create: compute,
    update: (deco, tr) => (opt.fresh(tr) ? compute(tr.state) : deco),
    provide: (f) => EditorView.decorations.from(f),
  });
}
