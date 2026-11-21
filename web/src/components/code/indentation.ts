"use client";

// A file's indentation as in VS Code: `editor.detectIndentation` — on opening, the indentation is GUESSED from the text
// (lib/editor-status.ts `indentationDetect`, once per file state, not per key) and given to the editor as BOTH facets: `indentUnit` (one tab
// or N spaces — what indenting, Enter and formatting insert) and `EditorState.tabSize` (the width of a tab — in a tab file the setting,
// otherwise the step; the status bar's column and the indentation lines are computed from it). Without this, basicSetup alone set
// `indentUnit` = spaces of the setting and `tabSize` stayed 4 — a tab file would indent with spaces and the column would be wrong.
//
// Tab as in VS Code: with a selection the lines indent (`indentMore`), without a selection the indentation comes AT THE CARET — in a tab
// file a tab, otherwise spaces up to the next step (`tabInsertion`); CodeMirror's `indentWithTab` indented the whole line. ⇧Tab outdents.
// The status bar reads the facets back (components/code/cursor-position.ts), not an estimate of its own. Attached in
// components/code/BufferEditor.tsx (both forms of CodePane); the computations are pure and executed in web/test/editor-status.test.mjs,
// the same test holds this wiring against the source.
import { EditorSelection, EditorState, Facet, Prec, StateField, type Extension } from "@codemirror/state";
import { indentUnit } from "@codemirror/language";
import { indentLess, indentMore } from "@codemirror/commands";
import { keymap, type Command } from "@codemirror/view";
import { indentationDetect, indentationFacets, tabInsertion, type Indentation } from "@/lib/editor-status";

/** The setting's tab size (the default without a hint in the text and the width of a tab in a tab file). */
const PRESET = Facet.define<number, number>({ combine: (v) => v[0] ?? 4 });
/** The guessed indentation — once, when the file's state is created (an idle state keeps it). */
const GUESSED = StateField.define<Indentation>({
  create: (st) => indentationDetect(st.doc.toString(), { kind: "empty", width: st.facet(PRESET) }),
  update: (v) => v,
});

/** Tab as in VS Code (see the header). */
export const tabAsVSCode: Command = (view) => {
  const st = view.state;
  if (st.readOnly) return false;
  if (st.selection.ranges.some((r) => !r.empty)) return indentMore(view);
  const unit = st.facet(indentUnit);
  view.dispatch(st.update(st.changeByRange((r) => {
    const row = st.doc.lineAt(r.head);
    const text = tabInsertion(unit, row.text, r.head - row.from, st.tabSize);
    return { changes: { from: r.head, insert: text }, range: EditorSelection.cursor(r.head + text.length) };
  }), { scrollIntoView: true, userEvent: "input" }));
  return true;
};

/** The extension: default, guessed indentation, both facets (before basicSetup) and Tab/⇧Tab (before `indentWithTab`). */
export function indentation(tabSize: number): Extension {
  const facets = (st: EditorState) => indentationFacets(st.field(GUESSED), st.facet(PRESET));
  return [
    PRESET.of(tabSize),
    GUESSED,
    Prec.highest(EditorState.tabSize.compute([GUESSED, PRESET], (st) => facets(st).tabSize)),
    Prec.highest(indentUnit.compute([GUESSED, PRESET], (st) => facets(st).unit)),
    Prec.high(keymap.of([{ key: "Tab", run: tabAsVSCode, shift: indentLess }])),
  ];
}
