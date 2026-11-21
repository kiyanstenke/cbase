// Code actions: "Refactor …" (⌃⇧R, `refactor`), "Source Action …" (`source`) and "Quick Fix …" (⌘., `quickfix`) as a list at the caret
// (components/code/EditorMenu.tsx); plus the light bulb in the gutter where quick fixes exist at the caret (asked debounced, only where the
// server reports `quick_fix`). Chosen ⇒ `code_action_apply { id }` ⇒ the WorkspaceEdit goes into the buffers (lib/lsp-change.ts: unsaved,
// background tabs, the own file via the view; first every open buffer of the language is reconciled, then the versions are checked).
// `409 STALE_ACTION` (older than 5 min), `403 OUTSIDE` and "changed in the meantime" are reported at the caret; nothing is changed then.
import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView, GutterMarker, ViewPlugin, gutter, type ViewUpdate } from "@codemirror/view";
import { RangeSet } from "@codemirror/state";
import { isNotSupported, lspErrorCode, lspRangeOf, type LspCodeAction } from "@/lib/api";
import { reconcileWith, applyWorkspaceEdit } from "@/lib/lsp-change";
import { tr } from "@/lib/i18n";
import { questions, can, lspFileOf, overView, showHint, type LspFile } from "@/components/code/lsp-core";
import { openEditorMenu } from "@/components/code/EditorMenu";
import { glyphMargin } from "@/components/code/gutters";

export type ActionKind = "quickfix" | "refactor" | "source";
const CAPABILITY = { quickfix: "quick_fix", refactor: "refactor", source: "source_action" } as const;
const EMPTY = { quickfix: "No code actions available", refactor: "No refactorings available", source: "No source actions available" } as const;
const TITLE = { quickfix: "Quick Fix", refactor: "Refactor", source: "Source Action" } as const;

async function fetchActions(view: EditorView, d: LspFile, kind: ActionKind): Promise<LspCodeAction[] | null> {
  const s = view.state.selection.main;
  const r = await questions(d, "code_actions", { range: lspRangeOf(view.state.doc, s.from, s.to), kinds: [kind] });
  return isNotSupported(r) ? null : r.actions ?? [];
}

/** Apply a chosen action. */
export async function applyAction(view: EditorView, d: LspFile, id: string): Promise<void> {
  try {
    const state = await reconcileWith(d.buffer.target, d.language, d.buffer);
    state.set(d.buffer, d.buffer.version); // the version the request goes out with (lspQuestion reads it before every await)
    const r = await questions(d, "code_action_apply", { id });
    if (isNotSupported(r)) { showHint(view, tr("The language service is not available for this file right now.")); return; }
    const e = await applyWorkspaceEdit(d.buffer.target, r.edit, { editor: d.editor, view: overView(view, d, "input.codeaction"), state });
    if (e.kind === "changed") showHint(view, tr("Changed in the meantime — nothing changed."));
    else if (e.kind === "error") showHint(view, tr("Not applied ({file}): {msg}", { file: e.file ?? "", msg: e.text }));
  } catch (err) {
    const c = lspErrorCode(err);
    showHint(view, c === "STALE_ACTION" ? tr("The action is out of date — please invoke it again.")
      : c === "OUTSIDE" ? tr("The action would change files outside the instance — nothing was changed.")
      : tr("Action failed: {msg}", { msg: String((err as Error)?.message ?? err) }));
  }
}

function showList(view: EditorView, d: LspFile, kind: ActionKind, actions: LspCodeAction[], perKey: boolean) {
  const pos = view.coordsAtPos(view.state.selection.main.head) ?? { left: 0, bottom: 0 };
  const sorted = [...actions].sort((a, b) => Number(Boolean(b.preferred)) - Number(Boolean(a.preferred)));
  openEditorMenu({
    x: pos.left, y: pos.bottom + 4, perKey, title: tr(TITLE[kind]), back: () => view.focus(),
    groups: [sorted.map((a) => ({
      id: a.id, label: a.title,
      disabled: Boolean(a.disabled),
      hint: typeof a.disabled === "string" ? a.disabled : undefined,
      execute: () => { void applyAction(view, d, a.id); },
    }))],
  });
}

/** ⌃⇧R / source action … / ⌘.: the list at the caret. */
export async function showCodeActions(view: EditorView, kind: ActionKind): Promise<void> {
  const d = lspFileOf(view.state);
  if (!can(d, CAPABILITY[kind])) return;
  let a;
  try { a = await fetchActions(view, d, kind); } catch (e) { showHint(view, tr("Action failed: {msg}", { msg: String((e as Error)?.message ?? e) })); return; }
  if (!a?.length) { showHint(view, tr(EMPTY[kind])); return; }
  showList(view, d, kind, a, true);
}

// ── The light bulb ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
type Bulb = { row: number; actions: LspCodeAction[] } | null;
const setBulb = StateEffect.define<Bulb>();
const bulbField = StateField.define<Bulb>({
  create: () => null,
  update(b, tr) {
    for (const e of tr.effects) if (e.is(setBulb)) return e.value;
    return b && tr.docChanged ? null : b;
  },
});
class BulbMarker extends GutterMarker {
  toDOM(view: EditorView) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cm-lsp-bulb";
    b.title = tr("Quick Fix (⌘.)");
    b.setAttribute("aria-label", b.title);
    b.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.1V17h6v-.2c0-.8.4-1.6 1-2.1A7 7 0 0 0 12 2z"/></svg>';
    b.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const s = view.state.field(bulbField, false), d = lspFileOf(view.state);
      if (s && d) showList(view, d, "quickfix", s.actions, false);
    });
    return b;
  }
}
const MARKER = new BulbMarker();
const bulbMargin = gutter({
  class: "cm-lsp-bulb-margin",
  markers: (view) => {
    const b = view.state.field(bulbField, false);
    if (!b || b.row > view.state.doc.lines) return RangeSet.empty;
    return RangeSet.of([MARKER.range(view.state.doc.line(b.row).from)]);
  },
  initialSpacer: () => MARKER,
});
const bulbQuestions = ViewPlugin.fromClass(class {
  tick: ReturnType<typeof setTimeout> | null = null;
  seq = 0;
  constructor(readonly view: EditorView) {}
  update(u: ViewUpdate) {
    if (!u.selectionSet && !u.docChanged && !u.focusChanged) return;
    if (this.tick) clearTimeout(this.tick);
    this.tick = setTimeout(() => { this.tick = null; void this.fetch(); }, 500);
  }
  async fetch() {
    const v = this.view, d = lspFileOf(v.state), seq = ++this.seq, doc = v.state.doc;
    const empty = () => { if (v.dom.isConnected && v.state.field(bulbField, false)) v.dispatch({ effects: setBulb.of(null) }); };
    if (!can(d, "quick_fix") || !v.hasFocus || v.state.readOnly) { empty(); return; }
    let a: LspCodeAction[] | null = null;
    try { a = await fetchActions(v, d, "quickfix"); } catch { /* no bulb */ }
    if (seq !== this.seq || v.state.doc !== doc || !v.dom.isConnected) return;
    const usable = (a ?? []).filter((x) => !x.disabled);
    if (!usable.length) { empty(); return; }
    v.dispatch({ effects: setBulb.of({ row: doc.lineAt(v.state.selection.main.head).number, actions: usable }) });
  }
  destroy() { if (this.tick) clearTimeout(this.tick); }
});

// The light bulb sits in the glyph margin, left of the line numbers (components/code/gutters.ts).
export const lspBulb: Extension = [bulbField, bulbQuestions, glyphMargin(bulbMargin)];
