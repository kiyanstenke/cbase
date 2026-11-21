"use client";

// Where a view's cursor is: for the status bar's "Line L, Column C" (components/code/StatusBar.tsx) and the outline that follows the cursor
// (components/code/LayoutTree.tsx). ONE extension (`cursorReporter`, in CodePane's extension list) reports per view; it is read via
// `useCursorSituation(view)` — per view, not "the last one moved": the page holds several code areas (Coding → Files and the chats), each
// shows ITS cursor. The column computation (tabs up to the tab stop) is in lib/editor-status.ts.
import { EditorState } from "@codemirror/state";
import { indentUnit } from "@codemirror/language";
import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";
import { useCallback, useSyncExternalStore } from "react";
import { selectionSituation, indentationFromFacets, type SelectionSituation, type Indentation } from "@/lib/editor-status";

export type CursorSituation = SelectionSituation & {
  /** The main selection as an LSP position (0-based) — for the outline. */
  lsp: { line: number; character: number };
  tabSize: number;
  /** The indentation as the editor DRIVES it (from `indentUnit` and `tabSize`, components/code/indentation.ts) — for the status bar. */
  indentation: Indentation;
};

const SITUATIONS = new WeakMap<EditorView, CursorSituation>();
const LISTENERS = new Set<() => void>();

function report(view: EditorView) {
  const st = view.state, main = st.selection.main, row = st.doc.lineAt(main.head);
  const tabSize = st.facet(EditorState.tabSize);
  const old = SITUATIONS.get(view);
  const situation: CursorSituation = {
    ...selectionSituation({ row: row.number, rowText: row.text, offsetInLine: main.head - row.from, tabSize, areas: st.selection.ranges }),
    lsp: { line: row.number - 1, character: main.head - row.from },
    tabSize,
    indentation: indentationFromFacets(st.facet(indentUnit), tabSize),
  };
  if (old && old.row === situation.row && old.column === situation.column && old.character === situation.character && old.selections === situation.selections
    && old.lsp.character === situation.lsp.character && old.tabSize === situation.tabSize
    && old.indentation.kind === situation.indentation.kind && old.indentation.width === situation.indentation.width) return;
  SITUATIONS.set(view, situation);
  for (const fn of [...LISTENERS]) fn();
}

/** The extension: reports cursor and selection of the view. */
export const cursorReporter = ViewPlugin.fromClass(class {
  constructor(view: EditorView) { report(view); }
  update(u: ViewUpdate) {
    if (u.selectionSet || u.docChanged || u.startState.facet(EditorState.tabSize) !== u.state.facet(EditorState.tabSize)
      || u.startState.facet(indentUnit) !== u.state.facet(indentUnit)) report(u.view);
  }
});

const subscribe = (fn: () => void) => { LISTENERS.add(fn); return () => { LISTENERS.delete(fn); }; };
/** The position of a view's cursor (null: no view or nothing reported yet). `view` is asked anew on every report. */
export function useCursorSituation(view: () => EditorView | null | undefined): CursorSituation | null {
  const read = useCallback(() => { const v = view(); return v ? SITUATIONS.get(v) ?? null : null; }, [view]);
  return useSyncExternalStore(subscribe, read, () => null);
}
/** A value from the position: renders only when the VALUE changes (equal by `Object.is` — so choose a primitive, e.g. "space:2"). That
 *  way CodePane does not hang on every cursor move; the parts that show the cursor read it themselves. */
export function useCursorValue<W>(view: () => EditorView | null | undefined, select: (l: CursorSituation | null) => W): W {
  const read = useCallback(() => { const v = view(); return select(v ? SITUATIONS.get(v) ?? null : null); }, [view, select]);
  return useSyncExternalStore(subscribe, read, () => select(null));
}
