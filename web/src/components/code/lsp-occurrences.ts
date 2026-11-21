// Occurrences of the symbol at the caret: subtly highlighted — with a server semantically (`highlights { position }`, only where it reports
// `document_highlight`), otherwise all equal words in the WHOLE text (like VS Code; the overview ruler shows them all — `occurrencesAreas`,
// components/code/overviewRuler.ts). "Change All Occurrences" (⌘F2) turns the same ranges into a multi-cursor. Applies to EVERY file of
// the editor, also without a language (then the words).
import { EditorSelection, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { isNotSupported, lspAreaOf, lspPosOf } from "@/lib/api";
import { questions, can, lspFileOf } from "@/components/code/lsp-core";

const MARKER = Decoration.mark({ class: "cm-lsp-occurrences" });
const WORD_CHARACTER = /[\p{L}\p{N}_$]/u;
const CAP = 2000;

/** All whole occurrences of the word at `pos` in the whole text (without a server), at most 2,000; null if no word stands there. */
export function sameWords(state: EditorState, pos: number): { from: number; to: number }[] | null {
  const w = state.wordAt(pos);
  if (!w) return null;
  const word = state.sliceDoc(w.from, w.to);
  if (!word || !WORD_CHARACTER.test(word[0])) return null;
  const out: { from: number; to: number }[] = [];
  const text = state.doc.toString();
  for (let i = text.indexOf(word); i >= 0 && out.length < CAP; i = text.indexOf(word, i + word.length)) {
    const before = i > 0 ? text[i - 1] : "", after = text[i + word.length] ?? "";
    if ((!before || !WORD_CHARACTER.test(before)) && (!after || !WORD_CHARACTER.test(after))) out.push({ from: i, to: i + word.length });
  }
  return out;
}

/** The occurrences at the caret: from the server if it can, otherwise the equal words. */
async function occurrences(view: EditorView, pos: number): Promise<{ from: number; to: number }[] | null> {
  const d = lspFileOf(view.state);
  if (can(d, "document_highlight")) {
    const doc = view.state.doc;
    try {
      const r = await questions(d, "highlights", { position: lspPosOf(doc, pos) });
      if (view.state.doc !== doc) return null;
      if (!isNotSupported(r) && r.ranges?.length) return r.ranges.map((x) => lspAreaOf(doc, x));
    } catch { /* carry on without a server */ }
  }
  return sameWords(view.state, pos);
}

/** ⌘F2: every occurrence gets a caret (the main caret stays at its occurrence). */
export async function changeAllOccurrences(view: EditorView): Promise<boolean> {
  const head = view.state.selection.main.head, doc = view.state.doc;
  const b = await occurrences(view, head);
  if (!b?.length || view.state.doc !== doc) return false;
  const sorted = [...b].sort((x, y) => x.from - y.from);
  const main = Math.max(0, sorted.findIndex((x) => x.from <= head && head <= x.to));
  view.dispatch({ selection: EditorSelection.create(sorted.map((x) => EditorSelection.range(x.from, x.to)), main), scrollIntoView: true, userEvent: "select" });
  view.focus();
  return true;
}

const highlight = ViewPlugin.fromClass(class {
  deco: DecorationSet = Decoration.none;
  tick: ReturnType<typeof setTimeout> | null = null;
  seq = 0;
  constructor(readonly view: EditorView) {}
  update(u: ViewUpdate) {
    if (u.docChanged) this.deco = this.deco.map(u.changes);
    // Scrolled changes nothing: the search covers the whole text.
    if (!u.selectionSet && !u.docChanged) return;
    if (this.tick) clearTimeout(this.tick);
    const sel = u.state.selection;
    if (sel.ranges.length > 1 || !sel.main.empty) { this.deco = Decoration.none; return; }
    this.tick = setTimeout(() => { this.tick = null; void this.fetch(); }, 250);
  }
  async fetch() {
    const v = this.view, seq = ++this.seq, doc = v.state.doc, pos = v.state.selection.main.head;
    const b = await occurrences(v, pos);
    if (seq !== this.seq || v.state.doc !== doc || !v.dom.isConnected) return;
    // A single occurrence (only the word itself) is not marked — like VS Code.
    this.deco = b && b.length > 1 ? Decoration.set(b.filter((x) => x.to > x.from).sort((x, y) => x.from - y.from).map((x) => MARKER.range(x.from, x.to))) : Decoration.none;
    v.dispatch({}); // redraw
  }
  destroy() { if (this.tick) clearTimeout(this.tick); }
}, { decorations: (p) => p.deco });

export const occurrencesExtension: Extension = highlight;
/** The highlighted occurrences (for the overview ruler); without the extension none. */
export const occurrencesAreas = (view: EditorView): DecorationSet => view.plugin(highlight)?.deco ?? Decoration.none;
