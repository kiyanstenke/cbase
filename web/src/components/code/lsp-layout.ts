// The outline of a view — fetched ONCE per view and shared by three readers: the breadcrumbs in the path bar (components/code/Breadcrumbs.tsx,
// via `useBreadcrumbs`), sticky scroll (components/code/sticky-scroll.ts) and the `@` mode of the command palette (palette-modes.ts — it asks
// fresh on opening, reads this one until then). Fetched only where the server reports `document_symbol`: at start, batched after changes
// (LAYOUT_PAUSE_MS) and as soon as the capability appears (the status arrives after the first read). Until the next answer the ranges move
// with every change (`mapPos`) — otherwise sticky scroll would pin the wrong line after an inserted line. An answer to an older text is
// dropped (the request for the new one is already running).
//
// THE CHAIN AT THE CURSOR (breadcrumbs): ONE entry per buffer in the window (`bufferKey`), written by the view that last moved it with
// focus — a second, hidden view of the same file (Coding → Files next to the chat) does not overwrite it.
import { EditorSelection, StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { useCallback, useSyncExternalStore } from "react";
import { isNotSupported, lspOffsetOf, lspPosOf, type LspPos, type LspRange, type LspSymbol } from "@/lib/api";
import { subscribeLspStatus } from "@/lib/lsp-status";
import { symbolChain, type ChainsSegment } from "@/lib/symbol-chain";
import { questions, can, lspFileOf } from "@/components/code/lsp-core";

/** How long after the last change the outline is fetched again. */
export const LAYOUT_PAUSE_MS = 700;

// ── The outline in the view's state ────────────────────────────────────────────────────────────────────────────────────────────────
const setLayout = StateEffect.define<LspSymbol[] | null>();
const layoutField = StateField.define<LspSymbol[] | null>({
  create: () => null,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setLayout)) return e.value;
    if (!v || !tr.docChanged) return v;
    const pos = (p: LspPos, assoc: number) => lspPosOf(tr.newDoc, tr.changes.mapPos(lspOffsetOf(tr.startState.doc, p), assoc));
    const area = (r: LspRange): LspRange => ({ start: pos(r.start, 1), end: pos(r.end, -1) });
    const mapping = (s: LspSymbol): LspSymbol => ({
      ...s, range: area(s.range), selectionRange: area(s.selectionRange ?? s.range), ...(s.children ? { children: s.children.map(mapping) } : {}),
    });
    return v.map(mapping);
  },
});
/** The view's outline — null: none (yet), the file has no server or it cannot. */
export const layoutOf = (s: EditorState): LspSymbol[] | null => s.field(layoutField, false) ?? null;
export const layoutChanged = (u: ViewUpdate): boolean => u.startState.field(layoutField, false) !== u.state.field(layoutField, false);

/** Jump to a position (breadcrumbs, `@`, sticky scroll): caret there, centred in view, focus into the editor. */
export function jumpTo(view: EditorView, r: LspRange | number, y: "center" | "start" = "center"): void {
  if (!view.dom.isConnected) return;
  const off = typeof r === "number" ? Math.min(Math.max(0, r), view.state.doc.length) : lspOffsetOf(view.state.doc, r.start);
  view.dispatch({ selection: EditorSelection.cursor(off), effects: EditorView.scrollIntoView(off, { y }), userEvent: "select" });
  view.focus();
}

// ── The chain at the cursor, per buffer ────────────────────────────────────────────────────────────────────────────────────────────
export type Breadcrumbs = { chain: readonly ChainsSegment[]; jump: (r: LspRange) => void };
type Entry = Breadcrumbs & { view: EditorView };
const CRUMBS = new Map<string, Entry>();
const SUBSCRIBERS = new Map<string, Set<() => void>>();
const sameChain = (a: readonly ChainsSegment[], b: readonly ChainsSegment[]) =>
  a.length === b.length && a.every((g, i) => g.symbol.name === b[i].symbol.name && g.symbol.range.start.line === b[i].symbol.range.start.line && g.siblings.length === b[i].siblings.length);
function report(k: string) { for (const fn of [...(SUBSCRIBERS.get(k) ?? [])]) fn(); }

// The chain is stored ALSO per location (`data-editor-location` above the view — an editor group): the same file in two groups shows in each
// the chain at its OWN cursor (VS Code: breadcrumbs belong to the editor). Without a location (the chat) the chain of the view holding focus applies.
const locationKey = (k: string, location: string) => `${k}\u0000${location}`;
const locationOf = (view: EditorView): string | null => view.dom.closest<HTMLElement>("[data-editor-location]")?.dataset.editorLocation ?? null;
function set(k: string, view: EditorView, chain: readonly ChainsSegment[]) {
  const old = CRUMBS.get(k);
  if (old && old.view === view && sameChain(old.chain, chain)) { old.chain = chain; return; }
  CRUMBS.set(k, { chain, view, jump: (r) => jumpTo(view, r) });
  report(k);
}
function reportChain(view: EditorView) {
  const d = lspFileOf(view.state);
  if (!d) return;
  const k = d.buffer.key, old = CRUMBS.get(k), location = locationOf(view);
  const sym = layoutOf(view.state);
  const chain = sym ? symbolChain(sym, lspPosOf(view.state.doc, view.state.selection.main.head)) : [];
  if (location) set(locationKey(k, location), view, chain);
  if (old && old.view !== view && old.view.dom.isConnected && !view.hasFocus) return; // another view of the same file has focus
  set(k, view, chain);
}
function forgetChain(view: EditorView, k: string) {
  for (const [x, e] of [...CRUMBS]) {
    if (e.view !== view || (x !== k && !x.startsWith(`${k}\u0000`))) continue;
    CRUMBS.delete(x);
    report(x);
  }
}
/** React: the chain at the cursor of the file with this buffer key (lib/buffer.ts `bufferKey`) — null without a view or outline.
 *  `location`: the chain of the view at THIS location (an editor group, `data-editor-location`), not that of the view holding focus. */
export function useBreadcrumbs(key: string | null, location?: string | null): Breadcrumbs | null {
  const k = key ? (location ? locationKey(key, location) : key) : null;
  const subscription = useCallback((fn: () => void) => {
    if (!k) return () => {};
    let s = SUBSCRIBERS.get(k);
    if (!s) SUBSCRIBERS.set(k, (s = new Set()));
    s.add(fn);
    return () => { s.delete(fn); if (!s.size) SUBSCRIBERS.delete(k); };
  }, [k]);
  const read = useCallback(() => (k ? CRUMBS.get(k) ?? null : null), [k]);
  return useSyncExternalStore(subscription, read, () => null);
}

// ── Fetching ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const fetch = ViewPlugin.fromClass(class {
  tick: ReturnType<typeof setTimeout> | null = null;
  alive = true;
  key = "";
  unsubscribe: () => void = () => {};
  constructor(readonly view: EditorView) {
    this.followUp();
    this.plane(0);
  }
  /** Subscribe to the file's status — if `document_symbol` appears only with it, fetch then. */
  followUp() {
    const d = lspFileOf(this.view.state);
    const k = d?.buffer.key ?? "";
    if (k === this.key) return;
    this.unsubscribe();
    if (this.key) forgetChain(this.view, this.key);
    this.key = k;
    this.unsubscribe = d ? subscribeLspStatus(d.buffer.target, d.buffer.path, () => { if (!layoutOf(this.view.state)) this.plane(0); }) : () => {};
  }
  update(u: ViewUpdate) {
    this.followUp();
    if (u.docChanged) this.plane(LAYOUT_PAUSE_MS);
    if (u.selectionSet || u.docChanged || u.focusChanged || layoutChanged(u)) reportChain(u.view);
  }
  plane(ms: number) {
    if (this.tick) clearTimeout(this.tick);
    this.tick = setTimeout(() => { this.tick = null; void this.fetch(); }, ms);
  }
  async fetch() {
    const d = lspFileOf(this.view.state);
    if (!this.alive || !d || !can(d, "document_symbol") || !this.view.dom.isConnected) return;
    const doc = this.view.state.doc;
    try {
      const r = await questions(d, "outline");
      if (!this.alive || this.view.state.doc !== doc || lspFileOf(this.view.state)?.buffer !== d.buffer) return;
      this.view.dispatch({ effects: setLayout.of(isNotSupported(r) ? null : Array.isArray(r.symbols) ? r.symbols : []) });
    } catch { /* silent: the outline stays as it was — the next change asks again */ }
  }
  destroy() {
    this.alive = false;
    if (this.tick) clearTimeout(this.tick);
    this.unsubscribe();
    if (this.key) forgetChain(this.view, this.key);
  }
});

/** For files with a language (components/code/lsp-extension.ts): outline in state, fetching, chain at the cursor. */
export const outlineExtension: Extension = [layoutField, fetch];
