// The command palette's preview in the editor (quick input like VS Code): while ⌃G ("Go to Line") or ⇧⌘O ("Go to Symbol") is open, the
// editor scrolls the chosen target to the centre and backs its lines (VS Code `AbstractEditorNavigationQuickAccessProvider`:
// `revealRangeInCenter` + decoration `rangeHighlight`, whole lines) — the cursor stays where it was. Escape (closing without accepting)
// restores the remembered state (selection and scroll position), an accept leaves the jump and only removes the backing.
import { StateEffect, StateField, type EditorSelection, type Extension } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";

const set = StateEffect.define<{ from: number; until: number } | null>();
const field = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(old, tr) {
    let deco = old.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(set)) continue;
      if (!e.value) { deco = Decoration.none; continue; }
      const doc = tr.state.doc;
      const a = doc.lineAt(Math.min(e.value.from, doc.length)).number, b = doc.lineAt(Math.min(e.value.until, doc.length)).number;
      const rows = [];
      for (let n = a; n <= b; n++) rows.push(Decoration.line({ class: "cm-qi-area" }).range(doc.line(n).from));
      deco = Decoration.set(rows);
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});
/** What the view still needs for the backing: the field, if its STATE does not carry it. Whether it is there is only told by the state — the
 *  buffer editor switches the file via `setState` (a new state without the field), the view stays the same; whoever remembered the view showed
 *  no backing in the second file any more (web/test/palette-preview.test.mjs). */
export function previewExtension(view: Pick<EditorView, "state">): Extension[] {
  return view.state.field(field, false) === undefined ? [field] : [];
}

/** The state before the preview. */
export type ViewStatus = { view: EditorView; selection: EditorSelection; top: number; left: number };
export function rememberView(view: EditorView | null): ViewStatus | null {
  if (!view || !view.dom.isConnected) return null;
  return { view, selection: view.state.selection, top: view.scrollDOM.scrollTop, left: view.scrollDOM.scrollLeft };
}
/** Show the target: back `from`/`until` (offsets), scroll `middle` to the centre — without moving the cursor. */
export function showPreview(view: EditorView, from: number, until: number, middle: number = from): void {
  if (!view.dom.isConnected) return;
  const extra = previewExtension(view);
  const len = view.state.doc.length;
  view.dispatch({
    effects: [
      ...(extra.length ? [StateEffect.appendConfig.of(extra)] : []),
      set.of({ from: Math.max(0, Math.min(from, len)), until: Math.max(0, Math.min(until, len)) }),
      EditorView.scrollIntoView(Math.max(0, Math.min(middle, len)), { y: "center" }),
    ],
  });
}
/** Remove the backing. */
export function withoutPreview(view: EditorView | null | undefined): void {
  if (!view || !view.dom.isConnected || !view.state.field(field, false)) return;
  view.dispatch({ effects: set.of(null) });
}
/** Back to the remembered state (closing without accepting). */
export function reinstate(status: ViewStatus | null): void {
  if (!status || !status.view.dom.isConnected) return;
  withoutPreview(status.view);
  const len = status.view.state.doc.length;
  if (status.selection.ranges.every((r) => r.to <= len)) status.view.dispatch({ selection: status.selection });
  status.view.scrollDOM.scrollTop = status.top;
  status.view.scrollDOM.scrollLeft = status.left;
}
