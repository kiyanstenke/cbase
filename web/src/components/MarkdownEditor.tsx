"use client";

// Obsidian-style live-preview Markdown editor on CodeMirror 6.
// Markdown is formatted as you type (large headings, **bold** bold, mono code, quotes,
// lists). Syntax markers (#, **, `) are hidden, except in the active line (edit mode) or
// always (reading mode).
// Tables are not text with hidden markers but a grid: they are REPLACED by a block widget that
// draws the same grid as the Markdown renderer, as long as the caret is not inside (see
// "Tables" below). Code blocks (``` / ~~~) likewise: a box like `CodeBlock` in Markdown.tsx
// instead of fences and body-text lines (lib/md-codeblock.ts, "Code blocks" below).

import { useMemo } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  lineNumbers as cmLineNumbers,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { type EditorState, Facet, type Range, StateEffect, StateField, type Text, type Transaction } from "@codemirror/state";
import { tags as t } from "@lezer/highlight";
import { textPx } from "@/lib/appearance";
import { textSizeMeasurement } from "@/lib/text-size-cm";
import { CODE_CLASS, codeBlockField } from "@/lib/md-codeblock";

// Reading mode (read-only, all markers always hidden), passed to the editor as a facet.
const ReadingMode = Facet.define<boolean, boolean>({
  combine: (values) => (values.length ? values[values.length - 1] : false),
});

// Bullet character instead of "-"/"*"/"+"
class BulletWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const s = document.createElement("span");
    s.className = "cm-bullet";
    s.textContent = "•";
    return s;
  }
}

const CONCEAL_MARKS = new Set(["HeaderMark", "EmphasisMark", "CodeMark", "StrikethroughMark", "QuoteMark"]);

// Quote line: left bar instead of "> ", as in the Markdown renderer (Markdown.tsx).
const quoteLine = Decoration.line({ class: "cm-quote-line" });

function buildDecorations(view: EditorView): DecorationSet {
  // Without FOCUS the editor behaves like reading mode: no markers anywhere. Otherwise the line
  // where the caret happens to sit would show its raw "# " or "**" even though nobody clicked
  // in. Where the editor stands in for a reading view (artifacts), that would not be an
  // edit hint but simply wrongly rendered text.
  const reading = view.state.facet(ReadingMode) || !view.hasFocus;
  const sel = view.state.selection.main;
  const doc = view.state.doc;
  // Collected instead of streamed through a RangeSetBuilder: that requires ascending positions,
  // and a multi-line quote registers all its line decorations on entering the Blockquote node,
  // i.e. before the marker decorations of its first line. `Decoration.set(..., true)` sorts itself.
  const ranges: Range<Decoration>[] = [];

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        const name = node.name;

        // Quote: the bar is ALWAYS there, even in the active line; it hides no characters but is
        // what the renderer makes of the ">".
        if (name === "Blockquote") {
          for (let pos = node.from; pos <= node.to && pos <= doc.length;) {
            const quoted = doc.lineAt(pos);
            ranges.push(quoteLine.range(quoted.from));
            pos = quoted.to + 1;
          }
          return;
        }

        const line = doc.lineAt(node.from);
        // Show raw Markdown in the active line (edit mode only).
        const cursorOnLine = !reading && sel.from <= line.to && sel.to >= line.from;
        if (cursorOnLine) return;

        // Unordered lists: replace the marker with a bullet.
        if (name === "ListMark") {
          const ch = doc.sliceString(node.from, node.to);
          if (ch === "-" || ch === "*" || ch === "+") {
            ranges.push(Decoration.replace({ widget: new BulletWidget() }).range(node.from, node.to));
          }
          return;
        }

        if (!CONCEAL_MARKS.has(name)) return;
        const parent = node.node.parent?.name ?? "";
        if (name === "CodeMark" && parent !== "InlineCode") return; // leave code fences visible
        if (name === "HeaderMark" && !parent.startsWith("ATXHeading")) return; // leave the Setext underline

        let end = node.to;
        if (name === "HeaderMark" || name === "QuoteMark") {
          while (end < line.to && doc.sliceString(end, end + 1) === " ") end++; // "# "/"> " including the space
        }
        ranges.push(Decoration.replace({}).range(node.from, end));
      },
    });
  }
  return Decoration.set(ranges, true);
}

const concealPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }
    update(u: ViewUpdate) {
      if (
        u.docChanged ||
        u.selectionSet ||
        u.viewportChanged ||
        u.focusChanged ||
        u.startState.facet(ReadingMode) !== u.state.facet(ReadingMode)
      ) {
        this.decorations = buildDecorations(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

// ── Tables ──────────────────────────────────────────────────────────────────
// A parser `Table` node (GFM) is replaced by a block widget that draws the same grid as
// `Table` in Markdown.tsx: header row, alignment, hairlines, inline formatting in the cells.
// If the caret is in the table (and the editor has focus), the source text appears instead;
// a click into a widget cell puts the caret exactly there.
//
// As a StateField, not in the ViewPlugin above: block decorations change the document height
// and therefore may only come from state; a ViewPlugin must not supply them.

type SyntaxNode = ReturnType<typeof syntaxTree>["topNode"];
type Alignment = "left" | "center" | "right";
// `rel`: offset of the cell from the table start. Stored absolutely it would be wrong after any
// edit further up in the text; the widget is reused through `eq` (same source text).
interface Cell { rel: number; node: SyntaxNode | null }
interface TablesModel { src: string; alignment: Alignment[]; header: Cell[]; rows: Cell[][] }

// Whether the editor has focus is view state. The table field sees it only through an effect
// that the focus change triggers (`focusChangeEffect`).
const focusSwitch = StateEffect.define<boolean>();
const focusField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(focusSwitch)) value = e.value;
    return value;
  },
});
const focusObserver = EditorView.focusChangeEffect.of((_state, focus) => focusSwitch.of(focus));

// The cells of a row come from the PIPES, not from the `TableCell` nodes: for an empty cell the
// parser creates no node (`| a |  | c |` has two nodes but three columns), so from the nodes
// alone "c" slid into the second column. A segment before the first or after the last pipe
// counts only with content, as in the parser.
function cellsOf(doc: Text, row: SyntaxNode, tableFrom: number): Cell[] {
  const pipes: number[] = [];
  const nodeValue: SyntaxNode[] = [];
  for (let c = row.firstChild; c; c = c.nextSibling) {
    if (c.name === "TableDelimiter") pipes.push(c.from);
    else if (c.name === "TableCell") nodeValue.push(c);
  }
  const limits = [row.from, ...pipes.map((p) => p + 1)];
  const ends = [...pipes, row.to];
  const out: Cell[] = [];
  for (let i = 0; i < limits.length; i++) {
    const from = limits[i];
    const to = ends[i];
    const empty = !doc.sliceString(from, to).trim();
    if (empty && (i === 0 || i === limits.length - 1) && pipes.length) continue;
    const node = nodeValue.find((k) => k.from >= from && k.to <= to) ?? null;
    out.push({ rel: (node ? node.from : from) - tableFrom, node });
  }
  return out;
}

function tablesModel(state: EditorState, table: SyntaxNode, from: number): TablesModel {
  const doc = state.doc;
  const header: Cell[] = [];
  const rows: Cell[][] = [];
  let alignment: Alignment[] = [];
  for (let row = table.firstChild; row; row = row.nextSibling) {
    if (row.name === "TableHeader") header.push(...cellsOf(doc, row, from));
    else if (row.name === "TableRow") rows.push(cellsOf(doc, row, from));
    else if (row.name === "TableDelimiter" && !alignment.length) {
      alignment = doc.sliceString(row.from, row.to).split("|").map((c) => c.trim()).filter(Boolean)
        .map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : "left"));
    }
  }
  return { src: doc.sliceString(from, table.to), alignment, header, rows };
}

const MARKERS = new Set(["EmphasisMark", "CodeMark", "StrikethroughMark", "LinkMark", "URL", "LinkTitle", "LinkLabel"]);
const safeHref = (url: string) => (/^(https?:|mailto:|#|\/)/.test(url) ? url : "");

// Inline formatting of a cell as DOM, from the syntax tree and not from a second set of
// regexes: the parser is the one source for what is bold, code or a link.
function inlineDOM(doc: Text, node: SyntaxNode, into: Node) {
  let pos = node.from;
  const text = (from: number, to: number) => { if (to > from) into.appendChild(document.createTextNode(doc.sliceString(from, to))); };
  for (let c = node.firstChild; c; c = c.nextSibling) {
    text(pos, c.from);
    pos = c.to;
    if (MARKERS.has(c.name)) continue;
    let el: HTMLElement | null = null;
    switch (c.name) {
      case "Emphasis": el = document.createElement("em"); break;
      case "StrongEmphasis": el = document.createElement("strong"); break;
      case "Strikethrough": el = document.createElement("s"); break;
      case "InlineCode": el = document.createElement("code"); break;
      case "Escape": text(c.from + 1, c.to); continue;
      case "HardBreak": into.appendChild(document.createElement("br")); continue;
      case "Link": case "Image": case "Autolink": {
        const url = c.getChild("URL");
        const href = url ? safeHref(doc.sliceString(url.from, url.to)) : "";
        if (href) {
          const a = document.createElement("a");
          a.href = href; a.target = "_blank"; a.rel = "noreferrer noopener";
          el = a;
        } else {
          el = document.createElement("span");
        }
        break;
      }
      default: break;
    }
    if (el) { inlineDOM(doc, c, el); into.appendChild(el); }
    else inlineDOM(doc, c, into);
  }
  text(pos, node.to);
}

class TablesWidget extends WidgetType {
  constructor(readonly model: TablesModel, readonly doc: Text, readonly editable: boolean) { super(); }
  eq(other: TablesWidget) { return other.model.src === this.model.src && other.editable === this.editable; }
  toDOM(view: EditorView) {
    const { header, rows, alignment } = this.model;
    const columns = Math.max(header.length, 1);
    const wrap = document.createElement("div");
    wrap.className = "cm-table-widget";
    const table = document.createElement("table");
    const makeCell = (tag: "th" | "td", z: Cell | undefined, j: number) => {
      const el = document.createElement(tag);
      el.style.textAlign = alignment[j] ?? "left";
      if (z) {
        el.dataset.rel = String(z.rel);
        if (z.node) inlineDOM(this.doc, z.node, el);
      }
      return el;
    };
    const thead = document.createElement("thead");
    const headerRow = document.createElement("tr");
    for (let j = 0; j < columns; j++) headerRow.appendChild(makeCell("th", header[j], j));
    thead.appendChild(headerRow);
    table.appendChild(thead);
    const tbody = document.createElement("tbody");
    for (const row of rows) {
      const tr = document.createElement("tr");
      // Rows have as many columns as the header (GFM): extra cells drop out, missing ones stay
      // empty; otherwise the table would be a different width per row.
      for (let j = 0; j < columns; j++) tr.appendChild(makeCell("td", row[j], j));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    if (this.editable) {
      // Click into a cell: put the caret there so the source opens EXACTLY at that spot. The
      // position comes from the widget's current location (`posAtDOM`), not from stored numbers,
      // because the DOM is reused for identical source text.
      wrap.addEventListener("mousedown", (e) => {
        const cell = (e.target as HTMLElement | null)?.closest?.("[data-rel]") as HTMLElement | null;
        if (!cell) return;
        e.preventDefault();
        const start = view.posAtDOM(wrap);
        const pos = Math.min(start + Number(cell.dataset.rel), view.state.doc.length);
        view.focus();
        view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
      });
    }
    return wrap;
  }
  ignoreEvent() { return true; }
}

function tablesDecorations(state: EditorState): DecorationSet {
  const reading = state.facet(ReadingMode) || !state.field(focusField);
  const editable = !state.facet(ReadingMode);
  const sel = state.selection.main;
  const doc = state.doc;
  const ranges: Range<Decoration>[] = [];
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== "Table") return;
      // Block decorations must cover whole lines: snap to line start and end.
      const from = doc.lineAt(node.from).from;
      const endLine = doc.lineAt(node.to);
      const to = endLine.from === node.to && node.to > from ? doc.lineAt(node.to - 1).to : endLine.to;
      if (!reading && sel.from <= to && sel.to >= from) return false;
      const widget = new TablesWidget(tablesModel(state, node.node, from), doc, editable);
      ranges.push(Decoration.replace({ widget, block: true }).range(from, to));
      return false;
    },
  });
  return Decoration.set(ranges, true);
}

// The tree grows even WITHOUT a change: the parser works time-sliced in the background and
// delivers its tables (and code blocks) later in a transaction of its own.
const blockNew = (tr: Transaction) => tr.docChanged
  || tr.selection !== undefined
  || tr.effects.some((e) => e.is(focusSwitch))
  || syntaxTree(tr.state) !== syntaxTree(tr.startState)
  || tr.startState.facet(ReadingMode) !== tr.state.facet(ReadingMode);

const tablesField = StateField.define<DecorationSet>({
  create: tablesDecorations,
  update: (deco, tr) => (blockNew(tr) ? tablesDecorations(tr.state) : deco),
  provide: (f) => EditorView.decorations.from(f),
});

// ── Code blocks ─────────────────────────────────────────────────────────────
// Computation and widget live in lib/md-codeblock.ts; "reading" and "editable" as for tables.
const codeField = codeBlockField({
  reading: (s) => s.facet(ReadingMode) || !s.field(focusField),
  editable: (s) => !s.facet(ReadingMode),
  fresh: blockNew,
});

const mdHighlight = HighlightStyle.define([
  { tag: t.heading1, fontSize: "1.5em", fontWeight: "700", lineHeight: "1.5" },
  { tag: t.heading2, fontSize: "1.3em", fontWeight: "700", lineHeight: "1.5" },
  { tag: t.heading3, fontSize: "1.15em", fontWeight: "700" },
  { tag: t.heading4, fontSize: "1.05em", fontWeight: "700" },
  { tag: [t.heading5, t.heading6], fontWeight: "700" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.monospace, fontFamily: "var(--font-mono)", fontSize: "0.9em" },
  { tag: t.link, color: "var(--color-accent)" },
  { tag: t.url, color: "var(--color-dim)" },
  { tag: t.quote, color: "var(--color-dim)", fontStyle: "italic" },
  { tag: t.list, color: "var(--color-accent)" },
  { tag: t.processingInstruction, color: "var(--color-dim)" }, // visible markers (active line) subdued
]);

// Second scale: EXACTLY that of the Markdown renderer (HEADING_CLASS in Markdown.tsx). Needed
// where the editor sits IN PLACE of a reading view: the same text must not suddenly get other
// heading sizes just because it is now editable.
const readingHighlight = HighlightStyle.define([
  { tag: t.heading1, fontSize: "1.25em", fontWeight: "700", letterSpacing: "-0.01em" },
  { tag: t.heading2, fontSize: "1.13em", fontWeight: "700", letterSpacing: "-0.01em" },
  { tag: t.heading3, fontSize: "1.05em", fontWeight: "600" },
  { tag: t.heading4, fontWeight: "600" },
  { tag: t.heading5, fontWeight: "600", color: "var(--color-dim)" },
  { tag: t.heading6, fontSize: "0.95em", fontWeight: "600", textTransform: "uppercase", letterSpacing: "0.03em", color: "var(--color-dim)" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through", opacity: "0.7" },
  { tag: t.monospace, fontFamily: "var(--font-mono)", fontSize: "0.9em" },
  { tag: t.link, color: "var(--color-accent)" },
  { tag: t.url, color: "var(--color-dim)" },
  { tag: t.quote, color: "var(--color-dim)" },
  { tag: t.list, color: "var(--color-accent)" },
  { tag: t.processingInstruction, color: "var(--color-dim)" },
]);

// The editor paints NO background of its own; it lies flat in its caller's surface (in the dialogs a
// `rounded-2xl bg-bg` trough). Root, scroll area and gutter must not each carry `var(--color-bg)`: on the
// page it is opaque and thus invisible, but in the dark flat sheet `--color-bg` is 6 % white (globals.css,
// "flat overlays"), so three such layers over the trough made a light, square box with its own
// scrollbar in the middle of the round field. The same holds in every dark card
// (`.cb-flat .cb-kit-pane` sets `--color-bg` equally translucent).
const editorTheme = EditorView.theme({
  // `textPx`: the app text size (lib/appearance.ts); the text-scale plugin does not see CodeMirror themes.
  "&": { backgroundColor: "transparent", color: "var(--color-fg)", fontSize: textPx(14) },
  "&.cm-focused": { outline: "none" },
  ".cm-content": {
    fontFamily: "var(--font-sans)",
    padding: "10px 2px",
    lineHeight: "1.65",
    caretColor: "var(--color-accent)",
  },
  // Scrollbar in the colour roles like `cb-scroll` (globals.css); untreated, Chrome would draw a grey track that
  // in the dark would again stand out as a light stripe in the trough. Standard properties only, no WebKit
  // pseudo-elements: ONE rule set per scroll area.
  ".cm-scroller": {
    fontFamily: "inherit",
    backgroundColor: "transparent",
    overscrollBehavior: "contain",
    scrollbarWidth: "thin",
    scrollbarColor: "var(--color-edge) transparent",
  },
  ".cm-gutters": { backgroundColor: "transparent", border: "none" },
  ".cm-cursor": { borderLeftColor: "var(--color-accent)" },
  ".cm-bullet": { color: "var(--color-accent)", paddingRight: "0.45em" },
  // Quote: left bar instead of "> ", the same as in the Markdown renderer (border-accent/55, pl-3).
  ".cm-quote-line": {
    borderLeft: "3px solid color-mix(in srgb, var(--color-accent) 55%, transparent)",
    paddingLeft: "12px",
  },
  // Table widget: the same measures as `Table` in Markdown.tsx (hairline under each row, 0.95em,
  // semibold header) so a table in the editor looks like a read one.
  ".cm-table-widget": { margin: "8px 0", overflowX: "auto" },
  ".cm-table-widget table": { width: "100%", borderCollapse: "collapse", fontSize: "0.95em", lineHeight: "1.5" },
  ".cm-table-widget th": { borderBottom: "1px solid var(--color-edge)", padding: "6px 10px", fontWeight: "600", verticalAlign: "top" },
  ".cm-table-widget td": { borderBottom: "1px solid var(--color-edge)", padding: "6px 10px", verticalAlign: "top" },
  ".cm-table-widget code": { fontFamily: "var(--font-mono)", fontSize: "0.9em", background: "var(--color-code)", borderRadius: "6px", padding: "1px 6px" },
  ".cm-table-widget a": { color: "var(--color-accent)", textDecoration: "underline", textUnderlineOffset: "2px" },
  ".cm-table-widget s": { opacity: "0.7" },
  // Code block: the same box as `CodeBlock` in Markdown.tsx (rounded-xl, border-edge, bg-code, language as header
  // cb-cs-10 semibold uppercase/dim, <pre> cb-cs-13 p-3 mono). The line height is TIGHT (1.2): the box-drawing characters
  // of a mono font fill ascender to descender (SF Mono ~1.19 em, Menlo ~1.16 em); at the body-text line height (1.65) a
  // "│" would tear into pieces. Long lines scroll INSIDE the box (`overflow-x: auto`, `white-space: pre`), whereas the
  // editor otherwise wraps (`EditorView.lineWrapping`); not here.
  // `contain: inline-size`: the box does not pass its width outward; without it the longest code line made `.cm-content`
  // (flex child, `min-width: auto`) as wide as itself and the WHOLE editor scrolled horizontally.
  [`.${CODE_CLASS.widget}`]: {
    margin: "8px 0", overflow: "hidden", borderRadius: "12px", contain: "inline-size",
    border: "1px solid var(--color-edge)", background: "var(--color-code)",
  },
  [`.${CODE_CLASS.language}`]: {
    borderBottom: "1px solid color-mix(in srgb, var(--color-edge) 70%, transparent)", padding: "4px 12px",
    fontSize: textPx(10), fontWeight: "600", textTransform: "uppercase", letterSpacing: "0.025em",
    color: "var(--color-dim)", fontFamily: "var(--font-sans)", lineHeight: "1.5",
  },
  [`.${CODE_CLASS.pre}`]: {
    margin: "0", padding: "12px", overflowX: "auto", whiteSpace: "pre", tabSize: "4",
    fontFamily: "var(--font-mono)", fontSize: textPx(13), lineHeight: "1.2",
    scrollbarWidth: "thin", scrollbarColor: "var(--color-edge) transparent",
  },
  // Source of a code block (caret inside): the same shape line by line, fences included, editable. No
  // `margin`: CodeMirror measures line heights, and an outer margin on a `.cm-line` would shift click and caret positions.
  [`.cm-line.${CODE_CLASS.row}`]: {
    background: "var(--color-code)", fontFamily: "var(--font-mono)", fontSize: textPx(13), lineHeight: "1.2",
    padding: "0 12px !important", borderLeft: "1px solid var(--color-edge)", borderRight: "1px solid var(--color-edge)",
  },
  // The highlighter's inline marks (monospace 0.9em) would otherwise shrink the code once more.
  [`.cm-line.${CODE_CLASS.row} span`]: { fontSize: "inherit", fontFamily: "inherit" },
  [`.cm-line.${CODE_CLASS.first}`]: {
    paddingTop: "12px !important", borderTop: "1px solid var(--color-edge)",
    borderTopLeftRadius: "12px", borderTopRightRadius: "12px",
  },
  [`.cm-line.${CODE_CLASS.last}`]: {
    paddingBottom: "12px !important", borderBottom: "1px solid var(--color-edge)",
    borderBottomLeftRadius: "12px", borderBottomRightRadius: "12px",
  },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "rgba(228,85,31,0.14)",
  },
});

// The editor sits in a reading view: tighter lines, and only the padding the caller names
// (`padding`). If the editor itself is the scroll area, the vertical padding must lie INSIDE it
// so the text runs under the edge. (No editor paints a background of its own, see `editorTheme`.)
const readingTheme = (padding: string) => EditorView.theme({
  // `!important` because both themes produce the same specificity and the order in the
  // stylesheet is not reliably that of the extensions (same trap as with `fontSize`).
  ".cm-content": { padding: `${padding} !important`, lineHeight: "1.6" },
  ".cm-line": { padding: "0 !important" },
  ".cm-quote-line": { paddingLeft: "12px !important" },
});

// Content padding in the field editor (`variant="editor"`) when the caller names one. Needed
// where the editor fills the whole trough and scrolls itself (dialogs): the padding then sits
// INSIDE the scroll area and the text runs to the round edge; padding on the trough would put
// the scroll area in as a second, indented frame.
const paddingTheme = (padding: string) => EditorView.theme({
  ".cm-content": { padding: `${padding} !important` },
});

const lineNumberTheme = EditorView.theme({
  ".cm-gutters": {
    color: "var(--color-dim)",
    borderRight: "1px solid var(--color-edge)",
    paddingRight: "6px",
  },
  ".cm-lineNumbers": { opacity: "1" },
  ".cm-lineNumbers .cm-gutterElement": { minWidth: "34px", padding: "0 8px 0 4px", color: "var(--color-dim)", opacity: "1" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--color-fg)" },
});

export function MarkdownEditor({
  value,
  onChange,
  reading = false,
  minHeight = "320px",
  maxHeight = "52vh",
  height,
  lineNumbers = false,
  fontSize,
  variant = "editor",
  padding,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  reading?: boolean;
  minHeight?: string;
  maxHeight?: string;
  height?: string;
  lineNumbers?: boolean;
  /** Font size as a CSS value: `textPx(n)` from lib/appearance.ts so it grows with the app text size. */
  fontSize?: string;
  /** "editor" = field editor (dialogs) with base padding; the caller's surface provides the background,
   *  the editor paints none. "reading" = the editor STANDS IN for a reading view: no padding of its
   *  own, tighter lines and the same heading sizes as the Markdown renderer. You should not see that
   *  the read text has become editable, only that it can be touched. */
  variant?: "editor" | "reading";
  /** Content padding (CSS shorthand). If the editor scrolls itself (`height="100%"`), the padding
   *  belongs here and not on the surface around it. Default: none for `variant="reading"`, the
   *  narrow base padding (10px 2px) for `variant="editor"`, for callers whose surface pads itself. */
  padding?: string;
  /** Class on the outer container: `h-full` if the editor should fill its parent's height and
   *  scroll inside itself (`height="100%"` alone is not enough: the container of the React
   *  wrapper would have no height). */
  className?: string;
}) {
  const sizeTheme = useMemo(
    () => fontSize ? EditorView.theme({ "&": { fontSize: `${fontSize} !important` }, ".cm-content": { lineHeight: "1.5" } }) : null,
    [fontSize],
  );
  const extensions = useMemo(
    () => [
      markdown({ base: markdownLanguage }),
      syntaxHighlighting(variant === "reading" ? readingHighlight : mdHighlight),
      concealPlugin,
      // Order: the focus field BEFORE the table field, which reads it on creation.
      focusField,
      focusObserver,
      tablesField,
      codeField,
      editorTheme,
      ...(variant === "reading" ? [readingTheme(padding ?? "0")] : padding ? [paddingTheme(padding)] : []),
      ...(lineNumbers ? [cmLineNumbers(), lineNumberTheme] : []),
      ...(sizeTheme ? [sizeTheme] : []),
      textSizeMeasurement,
      EditorView.lineWrapping,
      ReadingMode.of(reading),
    ],
    [reading, lineNumbers, sizeTheme, variant, padding],
  );

  return (
    <CodeMirror
      className={className}
      value={value}
      onChange={onChange}
      editable={!reading}
      readOnly={reading}
      theme="none"
      extensions={extensions}
      height={height}
      minHeight={height ? undefined : minHeight}
      maxHeight={height ? undefined : maxHeight}
      basicSetup={{
        // Added as an explicit extension so the gutter stays reliably visible
        // even read-only and without editor focus.
        lineNumbers: false,
        foldGutter: false,
        highlightActiveLine: false,
        highlightActiveLineGutter: false,
        highlightSelectionMatches: false,
        autocompletion: false,
        bracketMatching: false,
        closeBrackets: false,
        searchKeymap: false,
      }}
    />
  );
}
