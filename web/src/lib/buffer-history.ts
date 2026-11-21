// The ONE history of a buffer (VS Code: undo belongs to the MODEL, not the editor: the same file in two groups shares one undo stack,
// and after “split editor” (⌘\) the new group has the history). Each view used to have its own CodeMirror history, so ⌘Z in the
// second group undid nothing the first had typed.
//
// SHAPE: a resting CodeMirror state with `history()`, whose text follows the buffer, registered as a view of the buffer (lib/buffer.ts
// `connect`) as long as at least one editor view of the file lives (`logIn`, counted; without a view it lets go of the buffer, which may
// then close). Whoever types reports the transaction HERE (`ofView`): it enters the history WITH its selection and its `userEvent`
// (CodeMirror merges keystrokes as in one view) and goes to the buffer as areas; all other views receive it as an echo. Foreign changes
// (a change without a view, reload, discard) come in as an echo WITHOUT history. ⌘Z/⇧⌘Z in any view calls `step`: the history computes
// the step (the changes and the selection from back then), the view applies it (marked `fromHistory`) and reports it as if typed; it
// does not enter the history again.
//
// A rename part on an open file (lib/buffer.ts `change(…, { history: true })`) comes here as its OWN step: the history is the view
// with the youngest focus stamp (`focus` = ∞), and ⌘Z in any view undoes it.
//
// If the state drifts from the buffer (it changed while no view lived), the history starts over at the next `logIn` (VS Code likewise
// discards the stack if the model was changed without an editor). Tested by execution in web/test/buffer-history.test.mjs.
import { Annotation, EditorState, Transaction, type ChangeSet, type EditorSelection } from "@codemirror/state";
import { history, isolateHistory, redo, undo } from "@codemirror/commands";
import type { View, Area, EditorHolder, Buffer } from "./buffer.js";

/** A transaction that carries a history step into a view (⌘Z/⇧⌘Z); it does not enter the history again. */
export const fromHistory = Annotation.define<boolean>();
/** A history step as the view applies it. */
export type HistoryStep = { changes: ChangeSet; selection: EditorSelection | undefined };

const areasFrom = (changes: ChangeSet): Area[] => {
  const out: Area[] = [];
  changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => { out.push({ from: fromA, to: toA, insert: inserted.toString() }); });
  return out;
};

const HISTORIES = new WeakMap<Buffer, BufferHistory>();

export class BufferHistory implements View {
  /** The history takes every rename part (`change(…, { history })`): it is “last focused”. */
  readonly focus = Number.POSITIVE_INFINITY;
  /** The editor of a live view (a rename part otherwise opens no background tab for peek); the most recently registered counts. */
  get editor(): EditorHolder | null { for (let i = this.editors.length - 1; i >= 0; i--) { const e = this.editors[i].editor; if (e) return e; } return null; }
  private editors: { editor: EditorHolder | null }[] = [];
  private state: EditorState;
  private version: number;
  private count = 0;
  private release: (() => void) | null = null;
  /** While a view reports: the transaction that belongs in the history (`"already"`: a step of the history itself). */
  private next: Transaction | "already" | null = null;

  private constructor(private readonly p: Buffer) {
    this.state = BufferHistory.fresh(p.text);
    this.version = p.version;
  }
  private static fresh(text: string): EditorState { return EditorState.create({ doc: text, extensions: history() }); }

  /** The history of the buffer (created on first use). */
  static of(p: Buffer): BufferHistory {
    let g = HISTORIES.get(p);
    if (!g) { g = new BufferHistory(p); HISTORIES.set(p, g); }
    return g;
  }
  /** The history if there is one (without creating). */
  static from(p: Buffer): BufferHistory | null { return HISTORIES.get(p) ?? null; }

  /** Does it follow the buffer (the same state)? */
  get synchronous(): boolean { return this.version === this.p.version && this.state.doc.length === this.p.text.length; }
  /** How many steps go back/forward (for tests and menus). */
  get depth(): { back: number; before: number } {
    let back = 0, before = 0;
    undo({ state: this.state, dispatch: () => { back = 1; } });
    redo({ state: this.state, dispatch: () => { before = 1; } });
    return { back, before };
  }

  /** An editor view of the file lives; as long as one does, the history follows the buffer. If it drifts away, it starts over. */
  logIn(editor: EditorHolder | null = null): () => void {
    if (this.count === 0) {
      if (!this.synchronous || this.state.doc.toString() !== this.p.text) { this.state = BufferHistory.fresh(this.p.text); this.version = this.p.version; }
      this.release = this.p.connect(this);
    }
    this.count += 1;
    const entry = { editor };
    this.editors.push(entry);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.count -= 1;
      this.editors = this.editors.filter((x) => x !== entry);
      if (this.count === 0) { const l = this.release; this.release = null; l?.(); }
    };
  }

  /** A view typed (or applied a history step, `fromHistory`): into the history, then to the buffer. */
  ofView(a: View, tr: Transaction): void {
    this.next = tr.annotation(fromHistory) ? "already" : tr;
    try { this.p.ofView(a, areasFrom(tr.changes)); } finally { this.next = null; }
  }

  /** A view of the buffer: foreign changes (without history), or the transaction just reported (with). */
  apply(areas: readonly Area[]): void {
    const n = this.next;
    this.next = null;
    if (n === "already") { /* the state already carries the step */ }
    else if (n && this.state.doc.length === n.startState.doc.length) this.takeOn(n);
    else this.state = this.state.update({ changes: areas.map((b) => ({ from: b.from, to: b.to, insert: b.insert })), annotations: Transaction.addToHistory.of(false) }).state;
    this.version = this.p.version;
  }

  /** A rename part as its own step; false: the history does not follow the buffer right now. */
  own(areas: readonly Area[]): boolean {
    if (this.count === 0 || !this.synchronous) return false;
    this.state = this.state.update({
      changes: areas.map((b) => ({ from: b.from, to: b.to, insert: b.insert })),
      annotations: [Transaction.userEvent.of("input.rename"), isolateHistory.of("full")],
    }).state;
    this.p.ofView(this, areas); // the history itself gets no echo
    this.version = this.p.version;
    return true;
  }

  /** ⌘Z / ⇧⌘Z: compute the step (the view applies it, with `fromHistory`); null: nothing to do or not in sync. */
  step(direction: "back" | "before"): HistoryStep | null {
    if (!this.synchronous || this.p.readonly) return null;
    let t: Transaction | null = null;
    (direction === "back" ? undo : redo)({ state: this.state, dispatch: (x) => { t = x; } });
    const tr = t as Transaction | null;
    if (!tr) return null;
    this.state = tr.state;
    return { changes: tr.changes, selection: tr.selection };
  }

  /** A view's transaction with its selection before it (the history restores it on undo) and its kind (keystrokes merge as in one
   *  view). */
  private takeOn(tr: Transaction): void {
    let s = this.state;
    const prior = tr.startState.selection;
    if (prior.ranges.every((r) => r.to <= s.doc.length) && !s.selection.eq(prior)) s = s.update({ selection: prior, annotations: Transaction.addToHistory.of(false) }).state;
    const ann: Annotation<unknown>[] = [Transaction.time.of(tr.annotation(Transaction.time) ?? Date.now())];
    const ue = tr.annotation(Transaction.userEvent);
    if (ue) ann.push(Transaction.userEvent.of(ue));
    const iso = tr.annotation(isolateHistory);
    if (iso) ann.push(isolateHistory.of(iso));
    this.state = s.update({ changes: tr.changes, selection: tr.selection, annotations: ann }).state;
  }
}
