// Semantic highlighting like VS Code: where the server reports `semantic_tokens`, the view fetches the tokens of the whole file and lays
// each token's rule class over the syntax colouring (lib/semantics.ts: rule and colours from Dark/Light Modern). Until the new answer
// arrives, the old marks move with the text; an answer for an outdated state is discarded and asked for again. Without the capability the
// syntax colouring stands alone (like VS Code without a provider).
//
// When it asks — like VS Code `ModelSemanticColoring`:
// - every change CANCELS the running request (`AbortSignal` → B sends the server `$/cancelRequest`) and schedules the next after the
//   quiet period `semanticsDelay` (moving average of the last six request durations, 300–2,000 ms);
// - while a request runs, no second starts (a trigger is remembered and asked after);
// - 409 (the state moved, also ServerCancelled) ⇒ reschedule; the server asks for new tokens (`workspace/semanticTokens/refresh`,
//   event LSP_SEMANTICS_EVENT) ⇒ at once; the server becomes ready ⇒ at once;
// - after `destroy` nothing is scheduled or asked any more.
import { RangeSetBuilder, StateEffect, StateField, type Extension, type Text } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { isNotSupported } from "@/lib/api";
import { subscribeLspStatus, subscribeSemanticsRefresh } from "@/lib/lsp-status";
import { SEMANTICS_RULES, semanticsClass, semanticsSpans, semanticsDelay } from "@/lib/semantics";
import { questions, can, lspFileOf } from "@/components/code/lsp-core";

const set = StateEffect.define<DecorationSet>();
const field = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(d, tr) {
    for (const e of tr.effects) if (e.is(set)) return e.value;
    return tr.docChanged ? d.map(tr.changes) : d;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const markers = new Map<string, Decoration>();
const marker = (rule: string) => {
  let m = markers.get(rule);
  if (!m) { m = Decoration.mark({ class: semanticsClass(rule) }); markers.set(rule, m); }
  return m;
};

/** Tokens → marks in the text (lib/semantics.ts `semanticsSpans` computes the spans: ascending, non-overlapping, cut at line end). */
export function semanticsMarkers(doc: Text, data: readonly number[], legend: { types: readonly string[]; modifiers: readonly string[] }): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  for (const s of semanticsSpans(doc, data, legend)) b.add(s.from, s.until, marker(s.rule));
  return b.finish();
}

const httpStatus = (e: unknown) => Number((e as { httpStatus?: unknown } | null)?.httpStatus) || 0;

const fetch = ViewPlugin.fromClass(class {
  tick: ReturnType<typeof setTimeout> | null = null;
  running: AbortController | null = null;
  again = false;
  destroyed = false;
  durations: number[] = [];
  off: () => void = () => {};
  key = "";
  constructor(readonly view: EditorView) { this.followUp(); this.plane(0); }
  /** Follow the file's status (when the capability appears, ask at once) and the server's requests for new tokens. */
  followUp() {
    const d = lspFileOf(this.view.state);
    const k = d ? d.buffer.key : "";
    if (k === this.key) return;
    this.off();
    this.key = k;
    if (!d) { this.off = () => {}; return; }
    const status = subscribeLspStatus(d.buffer.target, d.buffer.path, () => this.plane(0));
    const please = subscribeSemanticsRefresh(d.buffer.target, d.language, () => this.plane(0));
    this.off = () => { status(); please(); };
  }
  update(u: ViewUpdate) {
    this.followUp();
    if (!u.docChanged) return;
    this.running?.abort(); // outdated: the server does not finish them (VS Code cancels on every change)
    this.plane(semanticsDelay(this.durations));
  }
  plane(ms: number) {
    if (this.destroyed) return;
    if (this.tick) clearTimeout(this.tick);
    this.tick = setTimeout(() => { this.tick = null; void this.fetch(); }, ms);
  }
  async fetch() {
    const v = this.view, d = lspFileOf(v.state);
    if (this.destroyed || !v.dom.isConnected) return;
    if (!can(d, "semantic_tokens")) {
      if (v.state.field(field, false) !== Decoration.none) v.dispatch({ effects: set.of(Decoration.none) });
      return;
    }
    if (this.running) { this.again = true; return; } // never two at once — once more afterwards
    const ac = new AbortController(), doc = v.state.doc, begin = performance.now();
    this.running = ac;
    let r;
    try { r = await questions(d, "semantic_tokens", {}, ac.signal); }
    catch (e) {
      if (!ac.signal.aborted && httpStatus(e) === 409) this.again = true; // the state moved: reschedule
      r = null;
    } finally {
      if (this.running === ac) this.running = null;
    }
    if (this.destroyed || ac.signal.aborted) return; // cancelled: the change has already scheduled the next
    if (r) this.durations = [...this.durations, performance.now() - begin].slice(-6);
    const further = this.again;
    this.again = false;
    if (!r || !v.dom.isConnected) { if (further) this.plane(semanticsDelay(this.durations)); return; }
    if (v.state.doc !== doc) { this.plane(semanticsDelay(this.durations)); return; } // outdated: the marks move on, ask again at once
    if (further) this.plane(0);
    if (isNotSupported(r)) return;
    v.dispatch({ effects: set.of(semanticsMarkers(doc, r.data ?? [], r.legend ?? { types: [], modifiers: [] })) });
  }
  destroy() {
    this.destroyed = true;
    if (this.tick) clearTimeout(this.tick);
    this.running?.abort();
    this.off();
  }
});

// The colours per mode (a base theme because only it knows `&dark`/`&light`). The class also colours the spans of the syntax colouring inside it,
// and the leading `.cm-content` makes it more specific than any highlight of @lezer/highlight.
const colors = EditorView.baseTheme(Object.fromEntries(SEMANTICS_RULES.flatMap(([rule, dark, light]) => {
  if (!dark || !light) return [];
  const k = semanticsClass(rule);
  return [
    [`&dark .cm-content .${k}, &dark .cm-content .${k} *`, { color: dark }],
    [`&light .cm-content .${k}, &light .cm-content .${k} *`, { color: light }],
  ];
})));

export const lspSemantics: Extension = [field, fetch, colors];
