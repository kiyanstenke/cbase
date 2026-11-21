// The shape of the language-service parts in the editor: tooltips (hover, completion, signature, hint, rename field) as a flat sheet in the
// app's colour roles (like `cb-pop`: opaque, hairline edge, no glass), occurrences subtly backed, the light bulb muted in the gutter.
//
// In the shape of VS Code: the tooltips in the widget colours of Dark/Light Modern (`--cb-widget-*` from components/code/codeTheme.ts, without
// them the app's roles), the hover (`.cm-lsp-hover`, lsp-markdown.tsx `hoverNode`) at most 500 px wide, scrolls within itself, sections
// separated by hairlines, code in the editor's font and colours without a box; likewise the definition preview (cmd-hover.ts). Occurrences
// at the cursor like `editor.wordHighlightBackground`.
import { EditorView } from "@codemirror/view";
import { textPx } from "@/lib/appearance";
import { SUGGESTION_DIMENSIONS } from "@/lib/suggestion-list";

const M = SUGGESTION_DIMENSIONS;

export const lspTheme = EditorView.theme({
  ".cm-tooltip": {
    border: "1px solid var(--cb-widget-edge, var(--color-edge))", borderRadius: "4px", backgroundColor: "var(--cb-widget-background, var(--color-panel))",
    color: "var(--cb-widget-text, var(--color-fg))", boxShadow: "0 2px 8px var(--cb-widget-shadow, rgba(0,0,0,0.14))",
  },
  // The suggestion list like VS Code (suggest.css, suggestWidget.ts; colours from lib/suggestion-list.ts as variables on the editor, set in
  // lsp-completion.ts): 430 px, 12 rows at the editor's line height (SUGGESTION_DIMENSIONS), corners cornerRadius.large (8 px), the editor's
  // font.
  ".cm-tooltip.cm-suggestion-list": { backgroundColor: "var(--cb-suggestion-background)", borderRadius: "8px", boxShadow: "0 2px 8px var(--cb-widget-shadow, rgba(0,0,0,0.14))" },
  ".cm-tooltip.cm-suggestion-list > ul": {
    width: `${M.width}px`, minWidth: `${M.minWidth}px`, maxWidth: `min(${M.width}px, 95vw)`, maxHeight: `calc(${M.rows} * var(--cb-line-height, 1.5) * 1em)`,
    fontFamily: "var(--cb-editor-font, var(--font-mono))", borderRadius: "8px",
  },
  ".cm-tooltip.cm-suggestion-list > ul > li": {
    display: "flex", alignItems: "center", boxSizing: "border-box", height: "calc(var(--cb-line-height, 1.5) * 1em)",
    lineHeight: "var(--cb-line-height, 1.5)", padding: "0 10px 0 2px", whiteSpace: "pre", overflow: "hidden", cursor: "pointer",
    color: "var(--cb-widget-text, var(--color-fg))",
  },
  ".cm-tooltip.cm-suggestion-list > ul > li[aria-selected]": { backgroundColor: "var(--cb-suggestion-selected-background)", color: "var(--cb-suggestion-selected-text)" },
  ".cm-suggestion-symbol": { display: "flex", alignItems: "center", flexShrink: "0", width: "16px", height: "16px", margin: "0 4px 0 2px", color: "var(--cb-widget-text, var(--color-fg))" },
  ".cm-suggestion-symbol-orange": { color: "var(--cb-symbol-orange)" },
  ".cm-suggestion-symbol-violet": { color: "var(--cb-symbol-violet)" },
  ".cm-suggestion-symbol-blue": { color: "var(--cb-symbol-blue)" },
  "li[aria-selected] .cm-suggestion-symbol": { color: "var(--cb-suggestion-selected-icon)" },
  ".cm-suggestion-codicon": { width: "16px", height: "16px", flexShrink: "0" },
  ".cm-tooltip.cm-suggestion-list .cm-completionLabel": { flexShrink: "0", overflow: "hidden", textOverflow: "ellipsis" },
  ".cm-tooltip.cm-suggestion-list li.cm-suggestion-with-label .cm-completionLabel": { flexShrink: "1" },
  ".cm-tooltip.cm-suggestion-list .cm-completionMatchedText": { textDecoration: "none", fontWeight: "bold", color: "var(--cb-suggestion-highlight)" },
  ".cm-tooltip.cm-suggestion-list li[aria-selected] .cm-completionMatchedText": { color: "var(--cb-suggestion-highlight-selected)" },
  // Deprecated like VS Code (suggest.css `.deprecated`): only the name dimmed and struck through, not the symbol.
  ".cm-suggestion-stale .cm-completionLabel": { opacity: "0.66", textDecoration: "line-through" },
  ".cm-suggestion-stale .cm-completionMatchedText": { fontWeight: "normal", color: "inherit" },
  ".cm-suggestion-signature": { opacity: "0.6", overflow: "hidden", textOverflow: "ellipsis", flexShrink: "1" },
  ".cm-suggestion-right": { display: "flex", alignItems: "center", marginLeft: "auto", paddingLeft: "1.1em", overflow: "hidden", flexShrink: "4", maxWidth: "70%" },
  ".cm-suggestion-detail, .cm-suggestion-description": { fontSize: "85%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  // The detail without labelDetails only in the selected row and only while the docs are closed (then it stands up there).
  ".cm-suggestion-detail": { display: "none" },
  ".cm-suggestion-list:not(.cm-suggestion-with-docs) li[aria-selected] .cm-suggestion-detail": { display: "inline" },
  ".cm-suggestion-more": { display: "none", alignItems: "center", justifyContent: "center", width: "18px", height: "18px", marginLeft: "4px", flexShrink: "0", cursor: "pointer" },
  ".cm-suggestion-list:not(.cm-suggestion-with-docs) li[aria-selected]:hover .cm-suggestion-more": { display: "flex" },
  // The docs beside the list: closed by default (invisible but measured — CodeMirror creates them when the row changes).
  ".cm-tooltip.cm-completionInfo": { padding: "0", backgroundColor: "var(--cb-suggestion-background)", borderRadius: "8px", maxHeight: `calc(${M.rows} * var(--cb-line-height, 1.5) * 1em + 2px)`, overflowY: "auto" },
  ".cm-suggestion-list:not(.cm-suggestion-with-docs) > .cm-completionInfo": { visibility: "hidden", pointerEvents: "none" },
  ".cm-completionInfo.cm-completionInfo-right": { left: "calc(100% - 1px)" },
  ".cm-completionInfo.cm-completionInfo-left": { right: "calc(100% - 1px)" },
  ".cm-completionInfo.cm-completionInfo-bottom": { left: "0" },
  ".cm-suggestion-docs": { position: "relative", lineHeight: "var(--cb-line-height, 1.5)" },
  ".cm-suggestion-docs-header": { minHeight: "calc(var(--cb-line-height, 1.5) * 1em)" },
  ".cm-suggestion-docs-type": { margin: "0 24px 0 0", padding: "4px 0 4px 5px", opacity: "0.7", whiteSpace: "pre", overflow: "hidden", textOverflow: "ellipsis", fontFamily: "var(--cb-editor-font, var(--font-mono))" },
  ".cm-suggestion-docs-beides .cm-suggestion-docs-type": { paddingBottom: "12px" },
  ".cm-suggestion-docs-close": { position: "absolute", top: "6px", right: "2px", display: "flex", width: "16px", height: "16px", cursor: "pointer" },
  ".cm-suggestion-docs-text": { padding: "0 5px 4px", fontFamily: "var(--font-sans)", whiteSpace: "normal" },
  ".cm-suggestion-docs-text .cm-hover-section": { padding: "0" },
  ".cm-suggestion-docs-text .cm-hover-text p": { margin: "0 0 4px" },
  ".cm-suggestion-docs-text a": { color: "var(--cb-link, var(--color-accent))" },
  ".cm-snippetField": { backgroundColor: "var(--cb-snippet-field)" },
  ".cm-lsp-md": { maxWidth: "520px", maxHeight: "320px", overflow: "auto", padding: "6px 10px", fontSize: textPx(12.5), lineHeight: "1.45", fontFamily: "var(--font-sans)" },
  ".cm-lsp-md pre, .cm-lsp-md code": { fontFamily: "var(--font-mono)", fontSize: textPx(12) },
  ".cm-lsp-md pre": { margin: "4px 0", whiteSpace: "pre-wrap" },
  ".cm-lsp-md p": { margin: "4px 0" },
  // The hover like in VS Code.
  // Tabs in the hover's code at the editor's tab width: the node sets `tab-size` itself (lsp-hover.ts, cmd-hover.ts), otherwise 4 instead of 8.
  ".cm-lsp-hover": { maxWidth: "500px", maxHeight: "320px", overflow: "auto", fontSize: textPx(13), lineHeight: "1.45", fontFamily: "var(--font-sans)", tabSize: "4" },
  ".cm-hover-section": { padding: "4px 8px" },
  ".cm-hover-section + .cm-hover-section": { borderTop: "1px solid var(--cb-widget-edge, var(--color-edge))" },
  ".cm-hover-code": { margin: "0", padding: "0", background: "none", whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "var(--font-mono)", fontSize: textPx(12.5), lineHeight: "1.5" },
  ".cm-hover-section .cm-hover-code + .cm-hover-code, .cm-hover-section .cm-hover-text + .cm-hover-code, .cm-hover-section .cm-hover-code + .cm-hover-text": { marginTop: "6px" },
  ".cm-hover-text p": { margin: "4px 0" },
  ".cm-hover-text a": { color: "var(--cb-link, var(--color-accent))" },
  ".cm-cmd-preview .cm-hover-code": { whiteSpace: "pre", overflowX: "auto" },
  ".cm-cmd-more": { fontSize: textPx(13) },
  // The parameter hints like VS Code (parameterHints.css): at most 440 px, the editor's font and line height, corners 8 px; with several
  // signatures on the left ˄ n/m ˅ and a half-opaque hairline before it; the docs under a hairline.
  ".cm-tooltip:has(> .cm-lsp-signature)": { borderRadius: "8px" },
  ".cm-lsp-signature": { lineHeight: "var(--cb-line-height, 1.5)" },
  ".cm-lsp-signature-wrapper": { display: "flex", flexDirection: "row", maxWidth: "440px", maxHeight: "250px", overflowY: "auto" },
  ".cm-lsp-signature-several .cm-lsp-signature-wrapper": { minHeight: "3.3em" },
  ".cm-lsp-signature-control": { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end", minWidth: "22px", padding: "0 2px" },
  ".cm-lsp-signature-button": { display: "flex", width: "16px", height: "16px", cursor: "pointer" },
  ".cm-lsp-signature-button svg": { width: "16px", height: "16px" },
  ".cm-lsp-signature-count": { lineHeight: "1", textAlign: "center", fontFamily: "var(--cb-editor-font, var(--font-mono))" },
  ".cm-lsp-signature-body": { position: "relative", flex: "1", minWidth: "0" },
  ".cm-lsp-signature-several .cm-lsp-signature-body": { borderLeft: "1px solid color-mix(in srgb, var(--cb-widget-edge, var(--color-edge)) 50%, transparent)" },
  ".cm-lsp-signature-header": { padding: "4px 5px", fontFamily: "var(--cb-editor-font, var(--font-mono))", whiteSpace: "pre-wrap" },
  ".cm-lsp-signature-header.cm-lsp-signature-with-docs": { borderBottom: "1px solid color-mix(in srgb, var(--cb-widget-edge, var(--color-edge)) 50%, transparent)" },
  ".cm-lsp-signature-active": { fontWeight: "bold", color: "var(--cb-suggestion-highlight)" },
  ".cm-lsp-signature-docs": { padding: "0 10px 0 5px" },
  ".cm-lsp-signature-paragraph": { margin: "8px 0", maxWidth: "none", maxHeight: "none", overflow: "visible", padding: "0", fontSize: "inherit", lineHeight: "inherit" },
  ".cm-lsp-hint": { padding: "5px 10px", fontSize: textPx(12), maxWidth: "420px", fontFamily: "var(--font-sans)" },
  // The rename field like VS Code (renameWidget.ts/.css): box in editorWidget.background with widget.border and shadow 0 0 8px 2px,
  // corners 4 px, at least 200 px; inside it the field (input.*) with a 3 px border, focus frame focusBorder; the editor's font and size,
  // the hint below it at 80 % of that.
  ".cm-tooltip:has(> .cm-lsp-rename)": { borderRadius: "4px", border: "1px solid var(--cb-widget-border, var(--cb-widget-edge))", boxShadow: "0 0 8px 2px var(--cb-widget-shadow, rgba(0,0,0,0.14))" },
  ".cm-lsp-rename": { padding: "4px", minWidth: "200px", color: "var(--cb-widget-text, var(--color-fg))" },
  ".cm-lsp-rename-field": {
    padding: "3px", borderRadius: "4px", border: "1px solid var(--cb-input-edge, var(--color-edge))", backgroundColor: "var(--cb-input-background, var(--color-bg))",
  },
  ".cm-lsp-rename-field:focus-within": { outline: "1px solid var(--cb-focus, var(--color-accent))", outlineOffset: "-1px" },
  ".cm-lsp-rename input": {
    width: "100%", boxSizing: "border-box", padding: "0", border: "none", outline: "none", backgroundColor: "transparent",
    color: "inherit", fontFamily: "var(--cb-editor-font, var(--font-mono))", fontSize: "inherit", lineHeight: "var(--cb-line-height, 1.5)",
  },
  ".cm-lsp-rename-hint": { marginTop: "4px", padding: "0 2px", opacity: "0.8", fontSize: "80%", fontFamily: "var(--font-sans)" },
  ".cm-lsp-occurrences": { backgroundColor: "var(--cb-word-highlight, color-mix(in srgb, var(--color-accent) 16%, transparent))", borderRadius: "2px" },
  ".cm-lsp-bulb-margin .cm-gutterElement": { padding: "0 1px" },
  ".cm-lsp-bulb": { display: "grid", placeItems: "center", width: "14px", height: "100%", padding: "0", border: "0", background: "none", color: "var(--color-warn, #d9a400)", cursor: "pointer" },
});
