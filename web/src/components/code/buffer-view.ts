// The ONE CodeMirror extension that attaches every view to its buffer (lib/buffer.ts): the file tab (components/code/BufferEditor.tsx —
// Coding → Files and code tabs in the chat, every editor group), the editable side of the diff tab (components/code/DiffTab.tsx) and
// peek.
//
// - What the view types goes as a transaction to the buffer's history (lib/buffer-history.ts) and from there as areas (offsets BEFORE the
//   change) to the buffer — per transaction, in their order.
// - Undo belongs to the BUFFER, not the view (as in VS Code, where it belongs to the model): ⌘Z/⇧⌘Z (and "Edit → Undo", `beforeinput`) in
//   ANY view undoes the file's latest step, whichever group it was typed in; after "Split Editor" the new group has the history. The view's
//   own history (basicSetup) therefore takes no text change any more (`addToHistory: false` on the `transactionExtender`) — only
//   selections (⌘U).
// - What other views type (or `change` without a view) arrives as a transaction with the annotation `fromBuffer`, never into a history. The
//   annotation prevents the loop (an echo never goes back to the buffer) and tells every listener "not typed here" (`isBufferEcho`).
// - On attaching, the view reconciles: if it does not show the buffer's text (built from an older state), it takes it over in the next
//   microtask; until then it accepts no foreign areas (they would apply to another text) and computes no undo.
// - A rename across several files (lib/lsp-change.ts, `change(…, { history: true })`) puts its share in an already open file as its OWN
//   step in the buffer's history: ⌘Z in any view undoes it.
import { Annotation, EditorState, Prec, Transaction, type ChangeSet, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, keymap, type ViewUpdate } from "@codemirror/view";
import type { View, Area, EditorHolder, Buffer } from "@/lib/buffer";
import { BufferHistory, fromHistory } from "@/lib/buffer-history";

/** Marks transactions the buffer carries into a view (foreign changes). */
export const fromBuffer = Annotation.define<boolean>();
/** Was this transaction an echo of the buffer (not typed in THIS view)? */
export const isBufferEcho = (tr: Transaction): boolean => tr.annotation(fromBuffer) === true;
/** Does the update contain changes that originated in THIS view (typed, pasted, undo)? */
export const hereChanged = (u: ViewUpdate): boolean => u.transactions.some((tr) => tr.docChanged && !isBufferEcho(tr));

/** The changes of a transaction as areas in offsets of the text before (sorted, non-overlapping — the shape of `Buffer.ofView`). */
export function areasFrom(changes: ChangeSet): Area[] {
  const out: Area[] = [];
  changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => { out.push({ from: fromA, to: toA, insert: inserted.toString() }); });
  return out;
}
/** The transaction specs that bring foreign areas into a state (for an idle `EditorState` as for a view). */
export const echoSpec = (areas: readonly Area[]) => ({
  changes: areas.map((b) => ({ from: b.from, to: b.to, insert: b.insert })),
  annotations: [fromBuffer.of(true), Transaction.addToHistory.of(false)],
});
const shows = (doc: { length: number; toString(): string }, p: Buffer): boolean => doc.length === p.text.length && doc.toString() === p.text;

/** ⌘Z/⇧⌘Z in a view: apply the step of the buffer's history (it does not enter again). Always "handled" — the view's history knows no text
 *  change (otherwise it would undo a selection where the user expects text). */
function stepIn(view: EditorView, p: Buffer, direction: "back" | "before"): boolean {
  if (!shows(view.state.doc, p)) return true;
  const s = BufferHistory.of(p).step(direction);
  if (s) view.dispatch({ changes: s.changes, selection: s.selection, scrollIntoView: true, userEvent: direction === "back" ? "undo" : "redo", annotations: fromHistory.of(true) });
  return true;
}
/** The buffer's history before the view's (the same keys as CodeMirror's `historyKeymap`). */
const historyOfThePuffers = (p: Buffer): Extension => [
  Prec.highest(keymap.of([
    { key: "Mod-z", run: (v) => stepIn(v, p, "back"), preventDefault: true },
    { key: "Mod-y", mac: "Mod-Shift-z", run: (v) => stepIn(v, p, "before"), preventDefault: true },
    { linux: "Ctrl-Shift-z", run: (v) => stepIn(v, p, "before"), preventDefault: true },
  ])),
  Prec.highest(EditorView.domEventHandlers({
    beforeinput(e, v) {
      const r = e.inputType === "historyUndo" ? "back" : e.inputType === "historyRedo" ? "before" : null;
      if (!r) return false;
      e.preventDefault();
      return stepIn(v, p, r);
    },
  })),
  EditorState.transactionExtender.of((tr) => (tr.docChanged && tr.annotation(Transaction.addToHistory) === undefined ? { annotations: Transaction.addToHistory.of(false) } : null)),
];

/** A view's extension: connects it to `p` and its history for as long as it lives. `editor`: its editor (background tab if no tab holds the
 *  buffer — peek). A read-only buffer makes the view read-only. */
export function bufferView(p: Buffer, o: { editor?: EditorHolder | null } = {}): Extension {
  const plugin = ViewPlugin.define((view: EditorView) => {
    let reconciled = shows(view.state.doc, p);
    let alive = true;
    const viewHandle: View = {
      editor: o.editor ?? null,
      apply: (areas) => { if (reconciled) view.dispatch(echoSpec(areas)); },
    };
    const g = BufferHistory.of(p);
    const unregister = g.logIn(o.editor ?? null);
    const release = p.connect(viewHandle);
    if (!reconciled) {
      queueMicrotask(() => {
        if (!alive) return;
        view.dispatch({ ...echoSpec([{ from: 0, to: view.state.doc.length, insert: p.text }]) });
        reconciled = true;
      });
    }
    return {
      update(u: ViewUpdate) {
        if (!reconciled) return;
        for (const tr of u.transactions) if (tr.docChanged && !isBufferEcho(tr)) g.ofView(viewHandle, tr);
      },
      destroy() { alive = false; release(); unregister(); },
    };
  });
  return p.readonly ? [plugin, historyOfThePuffers(p), EditorState.readOnly.of(true)] : [plugin, historyOfThePuffers(p)];
}
