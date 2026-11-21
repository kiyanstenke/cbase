// The suggestion list and parameter hints styled like VS Code — the pure computations. Drawing happens in
// components/code/lsp-completion.ts and lsp-signature.ts; the look lives in components/code/lsp-theme.ts.
//
// Sources (VS Code):
// - Kind → codicon: `CompletionItemKinds.toIcon` (src/vs/editor/common/languages.ts); unknown ⇒ `symbol-property`. LSP counts
//   kinds from 1 (CompletionItemKind), Monaco from 0 — LSP applies here.
// - Codicon → glyph: several names share a glyph (src/vs/base/common/codiconsLibrary.ts: symbol-function/-constructor = the one of
//   symbol-method, symbol-module = symbol-namespace, symbol-struct = symbol-structure, symbol-text = symbol-key, …). The glyph is named
//   as in lib/codicon-symbols.ts (the same characters as the outline) or else in lib/codicons.ts.
// - Codicon → color: src/vs/editor/contrib/symbolIcons/browser/symbolIcons.css + symbolIcons.ts — orange (class, enum, value,
//   event), violet (method, function, constructor), blue (enum member, field, interface, variable); everything else in the text
//   color (property too).
// - List colors: editorSuggestWidget.* (suggestWidget.ts) via quickInputList.focus* and list.* (Dark Modern inherits the defaults,
//   Light Modern sets list.activeSelection* itself).
// - Metrics: suggestWidget.ts `getLayoutInfo` — 430 px wide, 12 rows at the editor's line height, 1 px border; the docs beside it 330 px
//   (suggestWidgetDetails.ts); expandable only with docs or a detail ≠ name (`canExpandCompletionItem`, suggest.ts).
// - When the list appears while typing: `editor.quickSuggestions` (other on, comments and strings off; JSON/YAML strings on), the
//   server's trigger characters (suggestModel.ts). Parameter hints: at most 440 px (parameterHints.css), counter "n/m" with leading
//   zeros (parameterHintsWidget.ts), paging wraps around (`editor.parameterHints.cycle` is on by default).
//
// Pure (only the codicon type): EXERCISED in web/test/suggestion-list.test.mjs.
import type { GlyphName } from "./codicons";

/** LSP CompletionItemKind → the codicon name VS Code sets (it determines the color). */
const KIND_CODICON: Readonly<Record<number, string>> = {
  1: "symbol-text", 2: "symbol-method", 3: "symbol-function", 4: "symbol-constructor", 5: "symbol-field", 6: "symbol-variable",
  7: "symbol-class", 8: "symbol-interface", 9: "symbol-module", 10: "symbol-property", 11: "symbol-unit", 12: "symbol-value",
  13: "symbol-enum", 14: "symbol-keyword", 15: "symbol-snippet", 16: "symbol-color", 17: "symbol-file", 18: "symbol-reference",
  19: "symbol-folder", 20: "symbol-enum-member", 21: "symbol-constant", 22: "symbol-struct", 23: "symbol-event", 24: "symbol-operator",
  25: "symbol-type-parameter",
};
/** The name → the glyph (codicons file), where VS Code draws an alias. */
const GLYPH: Readonly<Record<string, GlyphName>> = {
  "symbol-text": "symbol-key", "symbol-method": "symbol-method", "symbol-function": "symbol-method", "symbol-constructor": "symbol-method",
  "symbol-field": "symbol-field", "symbol-variable": "symbol-variable", "symbol-class": "symbol-class", "symbol-interface": "symbol-interface",
  "symbol-module": "symbol-namespace", "symbol-property": "symbol-property", "symbol-unit": "symbol-ruler", "symbol-value": "symbol-enum",
  "symbol-enum": "symbol-enum", "symbol-keyword": "symbol-keyword", "symbol-snippet": "symbol-snippet", "symbol-color": "symbol-color",
  "symbol-file": "symbol-file", "symbol-reference": "references", "symbol-folder": "folder", "symbol-enum-member": "symbol-enum-member",
  "symbol-constant": "symbol-constant", "symbol-struct": "symbol-struct", "symbol-event": "symbol-event", "symbol-operator": "symbol-operator",
  "symbol-type-parameter": "symbol-type-parameter",
};
export type SymbolColor = "orange" | "violet" | "blue";
const COLOR: Readonly<Record<string, SymbolColor>> = {
  "symbol-class": "orange", "symbol-enum": "orange", "symbol-value": "orange", "symbol-event": "orange",
  "symbol-method": "violet", "symbol-function": "violet", "symbol-constructor": "violet",
  "symbol-enum-member": "blue", "symbol-field": "blue", "symbol-interface": "blue", "symbol-variable": "blue",
};
/** symbolIcon.*Foreground in Dark Modern (dark) and Light Modern (light). */
export const SYMBOL_COLORS: Readonly<Record<SymbolColor, { dark: string; light: string }>> = {
  orange: { dark: "#ee9d28", light: "#d67e00" },
  violet: { dark: "#b180d7", light: "#652d90" },
  blue: { dark: "#75beff", light: "#007acc" },
};

export type SuggestionSymbol = { codicon: string; glyph: GlyphName; color: SymbolColor | null };
/** The symbol of a kind (LSP count); any other value ⇒ the property's (as VS Code does for an unknown kind). */
export function suggestionSymbol(kind: unknown): SuggestionSymbol {
  const codicon = (typeof kind === "number" && KIND_CODICON[kind]) || "symbol-property";
  return { codicon, glyph: GLYPH[codicon] ?? "symbol-property", color: COLOR[codicon] ?? null };
}

/** The list colors (editorSuggestWidget.*): background, selected row, symbol in it, hits in the name (bold) — per mode. */
/** Plus the background of a snippet placeholder (`editor.snippetTabstopHighlightBackground`, editorColors.ts). */
export const SUGGESTION_COLORS = {
  dark: { background: "#202020", selectedBackground: "#04395e", selectedText: "#ffffff", selectedIcon: "#ffffff", highlight: "#2aaaff", selectedHighlight: "#2aaaff", snippetField: "#7c7c7c4d" },
  light: { background: "#f8f8f8", selectedBackground: "#e8e8e8", selectedText: "#000000", selectedIcon: "#000000", highlight: "#0066bf", selectedHighlight: "#0066bf", snippetField: "#0a326433" },
} as const;

/** The list metrics (px; height in editor rows): width, minimum width, rows, width of the docs beside it. ONE place — the look
 *  (components/code/lsp-theme.ts) and the docs position (lsp-completion.ts `docsSituation`) both compute from it. */
export const SUGGESTION_DIMENSIONS = Object.freeze({ width: 430, minWidth: 220, rows: 12, docsWidth: 330 });

/** VS Code `canExpandCompletionItem`: expand (the "›" of the selected row, the docs beside it) only with docs or with a detail that
 *  is not the name. */
export function canExpand(it: { label: string; detail?: string; documentation?: string }): boolean {
  return Boolean(it.documentation || (it.detail && it.detail !== it.label));
}

/** The trigger character the text before the caret ends with (the longest wins; a server character is up to four long) —
 *  null: none. The characters come from the server (status `triggers`), not from a fixed list. */
export function triggerAt(prior: string, character: readonly string[]): string | null {
  let best: string | null = null;
  for (const z of character) if (z && prior.endsWith(z) && (!best || z.length > best.length)) best = z;
  return best;
}

/** A change in offsets (CodeMirror's `ChangeSpec`). */
export type Change = { from: number; to: number; insert: string };
/** The extra edits of an accepted suggestion (`additionalTextEdits` — the import of an auto-import) in the CURRENT text, or null.
 *  They are computed against the state of the request (`changes`, offsets there); as in VS Code (SuggestController, "async additional edits")
 *  they apply only if nothing BEFORE them changed since — here: they lie entirely before the insertion point `before`, and the text up to
 *  their end is the same at the request state (`priorUntil`) and now (`nowUntil`). Then their offsets match too. */
export function additionInText(changes: readonly Change[], before: number, priorUntil: (until: number) => string, nowUntil: (until: number) => string): Change[] | null {
  if (!changes.length) return null;
  let end = 0;
  for (const a of changes) {
    if (a.from > a.to || a.to > before) return null;
    end = Math.max(end, a.to);
  }
  return priorUntil(end) === nowUntil(end) ? changes.map((a) => ({ from: a.from, to: a.to, insert: a.insert })) : null;
}

export type SyntaxKind = "comment" | "string" | "otherwise";
/** Where the caret is, from the names of the syntax nodes from the inside out (Lezer: `LineComment`, `Comment`, `String`,
 *  `TemplateString`, `FormatString`, `QuotedLiteral`, …): the innermost comment or string decides; an embedding
 *  (`${…}` of a template, `{…}` of an f-string) is code. */
export function syntaxKind(names: readonly string[]): SyntaxKind {
  for (const n of names) {
    if (n === "Interpolation" || n === "FormatReplacement") return "otherwise";
    if (/Comment$/.test(n)) return "comment";
    if (/String$/.test(n) || n === "QuotedLiteral") return "string";
  }
  return "otherwise";
}
/** VS Code `editor.quickSuggestions` by default: suggestions while typing a word in code, not in comments and not in
 *  strings — except JSON and YAML (their language extensions set `strings: true`: keys and values are quoted) — and never in
 *  Markdown. Trigger characters and ⌃Space ask everywhere; an open list keeps asking where it stands. */
export function fastSuggestion(language: string, kind: SyntaxKind): boolean {
  // Markdown: `markdown.editor.quickSuggestions` is off by default in VS Code — there only `.`, `/`, `#` and ⌃Space ask.
  if (language === "markdown") return false;
  if (kind === "comment") return false;
  if (kind === "string") return language === "json" || language === "yaml";
  return true;
}

/** The parameter-hint counter: "1/3", with ten or more signatures "01/12" (VS Code `padStart`). */
export function signatureCounter(active: number, count: number): string {
  return `${String(active + 1).padStart(String(count).length, "0")}/${count}`;
}
/** The next signature when paging (↓ +1, ↑ −1) — wrapping around. */
export function nextSignature(active: number, count: number, step: 1 | -1): number {
  if (count <= 0) return 0;
  return (((active + step) % count) + count) % count;
}
/** Which parameter is highlighted: the signature's, else the response's (VS Code `signature.activeParameter ?? activeParameter`). */
export function activeParameter(sig: { activeParameter?: number } | undefined, response: number | undefined): number {
  return sig?.activeParameter ?? response ?? 0;
}
