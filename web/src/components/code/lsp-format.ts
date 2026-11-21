// Format document: `format` — the server decides who formats (Prettier/ruff/black in the project container, otherwise the language server);
// whether it works is told by `features` (`format`), otherwise the command is hidden. "Format on save" (CodePane) uses the same computation
// (`formattedText`). The change only arrives if the buffer still shows the formatted state (whoever kept typing keeps their keystrokes).
// In the triggering view it goes through the view (⌘Z undoes it), otherwise through the buffer.
import { indentUnit } from "@codemirror/language";
import type { EditorView } from "@codemirror/view";
import { isNotSupported, lspLanguageOf } from "@/lib/api";
import { lspFeatures } from "@/lib/lsp-status";
import { asAreas, applyToText, type Buffer } from "@/lib/buffer";
import { questions, can, overView, showHint, type LspFile } from "@/components/code/lsp-core";
import { tr } from "@/lib/i18n";

const fileOf = (p: Buffer): LspFile | null => {
  const sp = lspLanguageOf(p.path);
  return sp ? { buffer: p, language: sp.language, editor: null } : null;
};

/** Indentation for the language server (`tabSize`/`insertSpaces`, lsp/actions.js `format`; Prettier/ruff/black read their own configuration). */
export type FormatOptions = { tabSize?: number; insertSpaces?: boolean };
const optionsOf = (view: EditorView): FormatOptions => ({ tabSize: view.state.tabSize, insertSpaces: !view.state.facet(indentUnit).includes("\t") });

/** The formatted text — null if there is no formatter, it fails or the buffer looks different in the meantime. */
export async function formattedText(p: Buffer, text: string, o: FormatOptions = {}): Promise<string | null> {
  const d = fileOf(p);
  if (!d || !lspFeatures(p.target, p.path).has("format") || p.text !== text) return null;
  const v = p.version;
  const r = await questions(d, "format", { ...o });
  if (isNotSupported(r) || p.version !== v) return null;
  return applyToText(text, asAreas(text, r.edits ?? []));
}

/** ⌥⇧F in the view `view` (file of the facet). */
export async function formatDocument(view: EditorView, d: LspFile | null): Promise<void> {
  if (!can(d, "format")) return;
  const p = d.buffer, v = p.version, text = p.text;
  let r;
  try { r = await questions(d, "format", optionsOf(view)); } catch (e) { showHint(view, tr("Formatting failed: {msg}", { msg: String((e as Error)?.message ?? e) })); return; }
  if (isNotSupported(r)) { showHint(view, tr("There is no formatter for this file.")); return; }
  if (p.version !== v) { showHint(view, tr("Changed in the meantime — not formatted.")); return; }
  let areas;
  try { areas = asAreas(text, r.edits ?? []); } catch (e) { showHint(view, tr("Formatting failed: {msg}", { msg: String((e as Error)?.message ?? e) })); return; }
  if (!areas.length) return;
  if (!overView(view, d, "input.format").apply(areas)) p.change(areas);
}
