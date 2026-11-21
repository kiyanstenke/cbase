// Sticky scroll: when the header line of an enclosing scope (class, function — from the language server's document outline,
// components/code/lsp-layout.ts) has scrolled out of view, it stays pinned at the top, at most STICKY_CAP lines, outermost first
// (computed by lib/symbol-chain.ts `stickyChain`). Clicking a pinned line jumps to it.
//
// FORM: a strip ABOVE the scroll area (child of `.cm-editor`, not of the scroller — it does not scroll along), rows with the editor's
// line height and font, the line number where the number gutter is, the text where the text is (follows horizontal scrolling) and in the
// view's syntax colors (`highlightTree` with the view's theme). The background is the first opaque one below the editor (the editor itself
// is transparent, codeTheme.ts); a hairline separates the strip from the code — flat like the app.
//
// Without an outline (file without server, server without `document_symbol`) and in a view whose scroll area does not scroll itself
// (the side-by-side view of the diff tab scrolls outside), the strip stays empty.
import type { Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { highlightingFor, syntaxTree } from "@codemirror/language";
import { highlightTree } from "@lezer/highlight";
import { stickyChain } from "@/lib/symbol-chain";
import { layoutChanged, layoutOf, jumpTo } from "@/components/code/lsp-layout";
import { backgroundUnder } from "@/components/code/gutter-background";

type Measurement = {
  rows: number[];      // 0-based, outermost first
  height: number;         // line height
  top: number;          // top edge of the scroll area in .cm-editor
  width: number;        // width of the scroll area without scrollbar
  gutter: number;         // width of the gutters (fixed at the left edge)
  numberLeft: number; numberWidth: number; // the number gutter (0 = none)
  textLeft: number;     // start of the line text relative to the scroll area (follows horizontal scrolling)
  background: string;
};

/** The text of a line in the view's syntax colors. */
function rowPaint(view: EditorView, line0: number, target: HTMLElement) {
  const line = view.state.doc.line(line0 + 1);
  const until = line.from + Math.min(line.length, 400);
  let pos = line.from;
  const chunk = (from: number, to: number, kind: string) => {
    if (to <= from) return;
    const s = document.createElement("span");
    if (kind) s.className = kind;
    s.textContent = view.state.sliceDoc(from, to);
    target.appendChild(s);
  };
  try {
    highlightTree(syntaxTree(view.state), { style: (tags) => highlightingFor(view.state, tags) }, (from, to, kind) => {
      from = Math.max(from, pos); to = Math.min(to, until);
      if (to <= from) return;
      chunk(pos, from, ""); chunk(from, to, kind); pos = to;
    }, line.from, until);
  } catch { /* without colors */ }
  chunk(pos, until, "");
}

const sticky = ViewPlugin.fromClass(class {
  dom: HTMLDivElement;
  last = "";
  /** The height of the strip — the editor keeps the caret below it (`scrollMargins`), otherwise a jump would land under it. */
  height = 0;
  roles: () => void;
  constructor(readonly view: EditorView) {
    this.dom = document.createElement("div");
    this.dom.className = "cm-sticky";
    this.dom.setAttribute("data-sticky-scroll", "");
    this.dom.style.display = "none";
    // mousedown instead of click: otherwise the editor below would get the press and put the caret there.
    this.dom.addEventListener("mousedown", (e) => {
      const z = (e.target as HTMLElement).closest<HTMLElement>("[data-sticky-row]");
      if (!z || e.button !== 0) return;
      e.preventDefault();
      const n = Number(z.dataset.stickyRow);
      if (Number.isInteger(n) && n < view.state.doc.lines) jumpTo(view, view.state.doc.line(n + 1).from, "start");
    });
    view.dom.appendChild(this.dom);
    this.roles = () => this.plane();
    view.scrollDOM.addEventListener("scroll", this.roles, { passive: true });
    this.plane();
  }
  update(u: ViewUpdate) {
    if (u.docChanged || u.viewportChanged || u.geometryChanged || layoutChanged(u)) this.plane();
  }
  plane() {
    this.view.requestMeasure({ key: this, read: (v) => this.miss(v), write: (m, v) => this.draw(m, v) });
  }
  miss(v: EditorView): Measurement | null {
    const sym = layoutOf(v.state);
    if (!sym?.length || !v.dom.isConnected) return null;
    const s = v.scrollDOM, height = v.defaultLineHeight, pad = v.documentPadding.top;
    const rowUnder = (i: number) => v.state.doc.lineAt(v.lineBlockAtHeight(Math.max(0, s.scrollTop - pad + i * height + height / 2)).from).number - 1;
    const rows = stickyChain(sym, rowUnder).map((x) => x.range.start.line);
    if (!rows.length) return null;
    const dr = v.dom.getBoundingClientRect(), sr = s.getBoundingClientRect(), cr = v.contentDOM.getBoundingClientRect();
    const gutter = (v.dom.querySelector(".cm-gutters") as HTMLElement | null)?.getBoundingClientRect().width ?? 0;
    const seq = (v.dom.querySelector(".cm-lineNumbers") as HTMLElement | null)?.getBoundingClientRect();
    const row = v.contentDOM.querySelector(".cm-line") as HTMLElement | null;
    const inset = row ? parseFloat(getComputedStyle(row).paddingLeft) || 0 : 6;
    return {
      rows, height, top: sr.top - dr.top, width: s.clientWidth, gutter,
      numberLeft: seq ? seq.left - sr.left : 0, numberWidth: seq ? seq.width : 0,
      textLeft: cr.left - sr.left + inset, background: backgroundUnder(v.dom.parentElement),
    };
  }
  draw(m: Measurement | null, v: EditorView) {
    const sig = m ? JSON.stringify(m) + "|" + m.rows.map((z) => (z < v.state.doc.lines ? v.state.doc.line(z + 1).text : "")).join("\n") : "";
    if (sig === this.last) return;
    this.last = sig;
    this.height = m ? m.rows.length * m.height : 0;
    const d = this.dom;
    d.textContent = "";
    if (!m) { d.style.display = "none"; return; }
    Object.assign(d.style, { display: "block", top: `${m.top}px`, width: `${m.width}px`, background: m.background });
    for (const z of m.rows) {
      if (z >= v.state.doc.lines) continue;
      const queue = document.createElement("div");
      queue.className = "cm-sticky-row";
      queue.dataset.stickyRow = String(z);
      queue.style.height = `${m.height}px`; // the editor's line height (measured, grows with the text size); the text sits centered in it
      if (m.numberWidth) {
        const seq = document.createElement("span");
        seq.className = "cm-sticky-number";
        seq.textContent = String(z + 1);
        Object.assign(seq.style, { left: `${m.numberLeft}px`, width: `${m.numberWidth}px` });
        queue.appendChild(seq);
      }
      const window = document.createElement("span");
      window.className = "cm-sticky-window";
      window.style.left = `${m.gutter}px`;
      const text = document.createElement("span");
      text.className = "cm-sticky-text";
      text.style.left = `${m.textLeft - m.gutter}px`;
      rowPaint(v, z, text);
      window.appendChild(text);
      queue.appendChild(window);
      d.appendChild(queue);
    }
  }
  destroy() {
    this.view.scrollDOM.removeEventListener("scroll", this.roles);
    this.dom.remove();
  }
}, {
  provide: (p) => EditorView.scrollMargins.of((view) => { const s = view.plugin(p); return s?.height ? { top: s.height } : null; }),
});

const stickyTheme = EditorView.theme({
  // No fixed line height (web/test/textScale.test.mjs): the row has the measured height of an editor line, number and text sit centered —
  // the same position as in the line itself, where the text is centered between equal halves of the leading.
  // Like VS Code (stickyScroll.css): no border, a shadow below (`editorStickyScroll.shadow` = scrollbar.shadow, 0 4px 2px -2px), hover
  // `editorStickyScrollHover.background`, numbers in the color of the number gutter, text in the editor's font.
  ".cm-sticky": { position: "absolute", left: "0", zIndex: "250", boxShadow: "var(--cb-scroll-shadow, #000000) 0 4px 2px -2px", fontFamily: "var(--cb-editor-font, var(--font-mono))", lineHeight: "normal", cursor: "pointer", overflow: "hidden" },
  ".cm-sticky-row": { position: "relative", whiteSpace: "pre" },
  ".cm-sticky-row:hover": { backgroundColor: "var(--cb-sticky-hover, var(--color-hover))" },
  ".cm-sticky-number": { position: "absolute", top: "50%", transform: "translateY(-50%)", boxSizing: "border-box", padding: "0 3px 0 5px", textAlign: "right", color: "var(--cb-line-number, var(--color-dim))" },
  ".cm-sticky-window": { position: "absolute", top: "0", right: "0", bottom: "0", overflow: "hidden" },
  ".cm-sticky-text": { position: "absolute", top: "50%", transform: "translateY(-50%)", color: "var(--color-fg)" },
});

/** For files with a language (components/code/lsp-extension.ts). */
export const stickyScroll: Extension = [sticky, stickyTheme];
