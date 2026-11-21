// Signature help of the language service: after "(" and "," the view asks `signature_help { position }` and shows the signature above the
// caret, the active parameter highlighted (`parameters[i].label` = [from, to] in the signature text), the docs as Markdown. While it is shown,
// it follows typing (debounced); ")", Esc, a jump to another line or an empty answer closes it.
//
// In the shape of VS Code's parameter hints (parameterHintsWidget.ts, parameterHints.css; computations in lib/suggestion-list.ts): signature in
// the editor font, the active parameter bold in `editorHoverWidget.highlightForeground`, below it the docs OF THE PARAMETER, then those of the
// signature (separated by a hairline). With several signatures on the left ˄ "n/m" ˅ — ↑/↓ (also ⌥↑/⌥↓) page in a circle, a click on the
// arrows too; the chosen signature stays while typing continues, as long as the server reports the same ones. ⇧⌘Space (otherwise ⇧Ctrl) asks by hand.
//
// When it asks (like VS Code `ParameterHintsModel`): after a trigger character OF THE SERVER (status `triggers.signature` — TypeScript "( , <",
// Python "( , )"), while the hints are open after every change — always after PARAMETER_TICK_MS (VS Code `DEFAULT_DELAY`). The trigger goes
// along as an LSP context (`trigger`: the character, also one of the `retriggerCharacters` with open hints, TypeScript ")"; `retrigger`: they
// are already shown). An empty answer closes them (that is how it ends after the closing bracket).
import { Prec, StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, keymap, showTooltip, type Tooltip, type ViewUpdate } from "@codemirror/view";
import { completionStatus } from "@codemirror/autocomplete";
import { isNotSupported, lspPosOf, type LspResponses } from "@/lib/api";
import { activeParameter, nextSignature, signatureCounter } from "@/lib/suggestion-list";
import type { CodiconName } from "@/lib/codicons";
import { tr } from "@/lib/i18n";
import { triggerOf, questions, can, lspFileOf } from "@/components/code/lsp-core";
import { markdownNode } from "@/components/code/lsp-markdown";
import { codiconNode } from "@/components/code/codicon";

type Data = LspResponses["signature_help"];
type Help = { pos: number; row: number; data: Data; selected: number };
/** Why it asks (LSP `SignatureHelpContext`): a trigger character or none (by hand, change), open or not. */
type Cause = { trigger?: string; retrigger: boolean };
const set = StateEffect.define<Help | null>();
const paginate = StateEffect.define<1 | -1>();
const field = StateField.define<Help | null>({
  create: () => null,
  update(h, tr) {
    for (const e of tr.effects) {
      if (e.is(set)) h = e.value;
      else if (e.is(paginate) && h) h = { ...h, selected: nextSignature(h.selected, h.data.signatures.length, e.value) };
    }
    if (!h) return h;
    if (tr.docChanged) h = { ...h, pos: tr.changes.mapPos(h.pos) };
    if (tr.selection && tr.state.doc.lineAt(tr.state.selection.main.head).number !== h.row) return null;
    return h;
  },
  provide: (f) => showTooltip.from(f, (h): Tooltip | null => (h ? { pos: h.pos, above: true, strictSide: false, create: (v) => draw(v, h) } : null)),
});

function draw(view: EditorView, h: Help) {
  const dom = document.createElement("div");
  const n = h.data.signatures.length;
  dom.className = `cm-lsp-signature${n > 1 ? " cm-lsp-signature-several" : ""}`;
  const wrapper = document.createElement("div");
  wrapper.className = "cm-lsp-signature-wrapper";
  dom.append(wrapper);
  const i = Math.min(Math.max(0, h.selected), n - 1);
  const s = h.data.signatures[i];
  if (n > 1) {
    const button = (name: CodiconName, step: 1 | -1, title: string) => {
      const b = document.createElement("span");
      b.className = "cm-lsp-signature-button";
      b.setAttribute("role", "button");
      b.title = title;
      b.append(codiconNode(name));
      b.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); view.dispatch({ effects: paginate.of(step) }); });
      return b;
    };
    const control = document.createElement("div");
    control.className = "cm-lsp-signature-control";
    const count = document.createElement("div");
    count.className = "cm-lsp-signature-count";
    count.textContent = signatureCounter(i, n);
    control.append(button("chevron-up", -1, tr("Previous signature")), count, button("chevron-down", 1, tr("Next signature")));
    wrapper.append(control);
  }
  const body = document.createElement("div");
  body.className = "cm-lsp-signature-body";
  wrapper.append(body);
  const header = document.createElement("div");
  header.className = "cm-lsp-signature-header";
  const ai = activeParameter(s, h.data.activeParameter);
  const param = s.parameters?.[ai];
  const p = param?.label;
  if (Array.isArray(p) && p[0] >= 0 && p[1] <= s.label.length && p[0] < p[1]) {
    header.append(s.label.slice(0, p[0]));
    const b = document.createElement("span");
    b.className = "cm-lsp-signature-active";
    b.textContent = s.label.slice(p[0], p[1]);
    header.append(b, s.label.slice(p[1]));
  } else header.textContent = s.label;
  body.append(header);
  const way: (() => void)[] = [];
  const docs = [param?.documentation, s.documentation].filter((x): x is string => Boolean(x && x.trim()));
  if (docs.length) {
    header.classList.add("cm-lsp-signature-with-docs");
    const bottom = document.createElement("div");
    bottom.className = "cm-lsp-signature-docs";
    for (const text of docs) { const m = markdownNode(text, "cm-lsp-md cm-lsp-signature-paragraph"); bottom.append(m.dom); way.push(m.destroy); }
    body.append(bottom);
  }
  return { dom, destroy: () => { for (const w of way) w(); } };
}

/** VS Code `ParameterHintsModel.DEFAULT_DELAY`. */
const PARAMETER_TICK_MS = 120;
const sameSignatures = (a: Data, b: Data) => a.signatures.length === b.signatures.length && a.signatures.every((s, i) => s.label === b.signatures[i].label);

const question = ViewPlugin.fromClass(class {
  tick: ReturnType<typeof setTimeout> | null = null;
  seq = 0;
  cause: Cause = { retrigger: false };
  constructor(readonly view: EditorView) {}
  update(u: ViewUpdate) {
    if (!u.docChanged) return;
    const typed = u.transactions.some((tr) => tr.isUserEvent("input.type") || tr.isUserEvent("delete"));
    if (!typed) return;
    let text = "";
    u.changes.iterChanges((_a, _b, _c, _d, t) => { text += t.toString(); });
    const open = u.state.field(field, false);
    // With auto-closed brackets "()" is in the text — the typed trigger character is inside it.
    const z = triggerOf(lspFileOf(u.state));
    const character = z.signature.find((c) => text.includes(c)) ?? (open ? z.signatureRetrigger.find((c) => text.includes(c)) : undefined);
    if (character || open) this.plane(PARAMETER_TICK_MS, { ...(character ? { trigger: character } : {}), retrigger: Boolean(open) });
  }
  plane(ms: number, cause: Cause) {
    this.cause = cause;
    if (this.tick) clearTimeout(this.tick);
    this.tick = setTimeout(() => { this.tick = null; void this.fetch(); }, ms);
  }
  async fetch() {
    const v = this.view, d = lspFileOf(v.state);
    if (!can(d, "signature_help")) return;
    const seq = ++this.seq, doc = v.state.doc, pos = v.state.selection.main.head, cause = this.cause;
    let r;
    try { r = await questions(d, "signature_help", { position: lspPosOf(doc, pos), ...cause }); } catch { return; }
    if (seq !== this.seq || v.state.doc !== doc || !v.dom.isConnected) return;
    const empty = isNotSupported(r) || !r.signatures?.length;
    if (empty) { v.dispatch({ effects: set.of(null) }); return; }
    const data = r as Data, prior = v.state.field(field, false);
    const selected = prior && sameSignatures(prior.data, data) ? prior.selected : Math.max(0, data.active ?? 0);
    v.dispatch({ effects: set.of({ pos, row: doc.lineAt(pos).number, data, selected }) });
  }
  destroy() { if (this.tick) clearTimeout(this.tick); }
});

/** ⇧⌘Space: signature help by hand (VS Code `editor.action.triggerParameterHints`) — also the command of an accepted
 *  suggestion (lsp-completion.ts). */
export function showParameterHints(view: EditorView): boolean {
  if (!can(lspFileOf(view.state), "signature_help")) return false;
  view.plugin(question)?.plane(0, { retrigger: Boolean(view.state.field(field, false)) });
  return true;
}
const several = (v: EditorView) => (v.state.field(field, false)?.data.signatures.length ?? 0) > 1 && completionStatus(v.state) !== "active";
const paginateBy = (step: 1 | -1) => (v: EditorView) => (several(v) ? (v.dispatch({ effects: paginate.of(step) }), true) : false);
const keys = Prec.high(keymap.of([
  { key: "Escape", run: (v) => (v.state.field(field, false) ? (v.dispatch({ effects: set.of(null) }), true) : false) },
  { key: "ArrowUp", run: paginateBy(-1) }, { key: "ArrowDown", run: paginateBy(1) },
  { key: "Alt-ArrowUp", run: paginateBy(-1) }, { key: "Alt-ArrowDown", run: paginateBy(1) },
  { key: "Shift-Mod-Space", run: showParameterHints },
]));

export const lspSignature: Extension = [field, question, keys];
