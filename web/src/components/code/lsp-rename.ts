// Rename symbol (F2): `prepare_rename` at the caret ⇒ a field right at the symbol, the old name prefilled and selected; Enter ⇒
// `rename { position, newName }` ⇒ the WorkspaceEdit into the BUFFERS (unsaved like VS Code, files without a tab as a background tab with a dot;
// the own file via the view, ⌘Z undoes it there). Esc or a click beside it cancels. `403 OUTSIDE` (a location would lie outside the instance)
// ⇒ hint, nothing changed. Before that the view reconciles every open buffer of the same language (lib/lsp-change.ts `reconcileWith`) and notes
// the versions; if one moved before the answer arrives, nothing is changed.
import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView, showTooltip, type Tooltip } from "@codemirror/view";
import { isNotSupported, lspAreaOf, lspErrorCode, lspPosOf, type LspPos } from "@/lib/api";
import { reconcileWith, applyWorkspaceEdit } from "@/lib/lsp-change";
import { tr } from "@/lib/i18n";
import { questions, can, lspFileOf, overView, showHint } from "@/components/code/lsp-core";

type Field = { from: number; to: number; old: string; position: LspPos };
const set = StateEffect.define<Field | null>();
const field = StateField.define<Field | null>({
  create: () => null,
  update(f, tr) {
    for (const e of tr.effects) if (e.is(set)) return e.value;
    return f && tr.docChanged ? null : f; // the text beneath changed: the field no longer applies
  },
  provide: (f) => showTooltip.from(f, (x): Tooltip | null => (x ? { pos: x.from, above: false, strictSide: false, create: (v) => draw(v, x) } : null)),
});

function close(view: EditorView, focus = true) {
  if (view.dom.isConnected && view.state.field(field, false)) view.dispatch({ effects: set.of(null) });
  if (focus) view.focus();
}

function draw(view: EditorView, f: Field) {
  const dom = document.createElement("div");
  dom.className = "cm-lsp-rename";
  const input = document.createElement("input");
  input.type = "text";
  input.value = f.old;
  input.spellcheck = false;
  input.setAttribute("aria-label", tr("New name"));
  const under = document.createElement("div");
  under.className = "cm-lsp-rename-hint";
  under.textContent = tr("Enter to Rename");
  const fieldWrapper = document.createElement("div");
  fieldWrapper.className = "cm-lsp-rename-field"; // VS Code: the focus frame sits on the wrapper, not on the field
  fieldWrapper.append(input);
  dom.append(fieldWrapper, under);
  let finished = false;
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") { e.preventDefault(); finished = true; close(view); }
    else if (e.key === "Enter") {
      e.preventDefault();
      finished = true;
      const fresh = input.value.trim();
      close(view);
      if (fresh && fresh !== f.old) void renamePath(view, f, fresh);
    }
  });
  input.addEventListener("blur", () => { if (!finished) { finished = true; queueMicrotask(() => close(view, false)); } });
  return {
    dom,
    mount: () => { input.focus(); input.select(); },
  };
}

async function renamePath(view: EditorView, f: Field, fresh: string) {
  const d = lspFileOf(view.state);
  if (!d) return;
  try {
    const state = await reconcileWith(d.buffer.target, d.language, d.buffer);
    state.set(d.buffer, d.buffer.version); // the version the request goes out with (lspQuestion reads it before every await)
    const r = await questions(d, "rename", { position: f.position, newName: fresh });
    if (isNotSupported(r)) { showHint(view, tr("The language service is not available for this file right now.")); return; }
    const e = await applyWorkspaceEdit(d.buffer.target, r.edit, { editor: d.editor, view: overView(view, d, "input.rename"), state });
    if (e.kind === "changed") showHint(view, tr("Changed in the meantime — nothing changed."));
    else if (e.kind === "error") showHint(view, tr("Not renamed ({file}): {msg}", { file: e.file ?? "", msg: e.text }));
  } catch (err) {
    showHint(view, lspErrorCode(err) === "OUTSIDE"
      ? tr("The rename would touch files outside the instance — nothing was changed.")
      : tr("Rename failed: {msg}", { msg: String((err as Error)?.message ?? err) }));
  }
}

/** F2: open the field at the symbol at the caret. */
export async function startRename(view: EditorView): Promise<void> {
  const d = lspFileOf(view.state);
  if (!can(d, "rename") || view.state.readOnly) return;
  const doc = view.state.doc, head = view.state.selection.main.head, position = lspPosOf(doc, head);
  let r;
  try { r = await questions(d, "prepare_rename", { position }); } catch (e) { showHint(view, tr("Rename failed: {msg}", { msg: String((e as Error)?.message ?? e) })); return; }
  if (view.state.doc !== doc || !view.dom.isConnected) return;
  if (isNotSupported(r)) { showHint(view, tr("The language service is not available for this file right now.")); return; }
  if ("error" in r) { showHint(view, r.error || tr("This element cannot be renamed.")); return; }
  const b = lspAreaOf(doc, r.range);
  view.dispatch({ effects: set.of({ from: b.from, to: b.to, old: r.placeholder || doc.sliceString(b.from, b.to), position }) });
}

export const renameExtension: Extension = field;
