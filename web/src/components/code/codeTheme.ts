// Theme of the code editor — ONE version for the editor of the Coding → Files page and the code area in the chat (components/CodePane.tsx),
// for the diff tab (components/code/DiffTab.tsx) and for peek (components/code/lsp-peek.ts). web/test/diff-tab.test.mjs guards that neither
// code editor defines its own theme (`HighlightStyle.define`, `codeTheme`/`darkSyntax`) — the Markdown editor (MarkdownEditor.tsx)
// deliberately has its own.
//
// In the colours of VS Code:
// - Syntax colours, selection, caret, current line (as a frame, not a fill), line numbers from Dark Modern / Light Modern — the tables
//   below (`DARK_MODERN`, `LIGHT_MODERN`, `SURFACE_DARK`, `SURFACE_LIGHT`; web/test/editor-look.test.mjs holds them against the spec).
//   The surface colours are variables `--cb-*` on the editor (one base theme per mode), the rules read only the variables.
// - In light mode the Light Modern syntax applies by itself (`themeType: "light"`); `darkSyntax` switches Dark Modern on AND sets
//   `EditorView.darkTheme` — otherwise both syntax colours would run at once in the dark CodePane.
// - Where VS Code colours a language differently from the general rule, a highlighter applies only in it (`onlyIn`, recognised by the
//   tree's top node): CSS selectors (tag, class, id, pseudo-class) and YAML keys.
// - What every code editor also has: bracket-pair colouring (brackets.ts), indentation lines (indentation-lines.ts) and the
//   search/replace widget (search-widget.ts). The fold arrows (fold-margin.ts) only the file editor — diff and peek do not fold.
//
// The editor sits IN the page surface — without its own opaque background: surface and edge are transparent.
import { EditorView, drawSelection } from "@codemirror/view";
import { Prec, type Extension } from "@codemirror/state";
import { HighlightStyle, syntaxHighlighting, type TagStyle } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import type { NodeType } from "@lezer/common";
import { textPx } from "@/lib/appearance";
import { BRACKET_COLORS } from "@/lib/bracket-colors";
import { bracketColors } from "@/components/code/brackets";
import { indentationLines } from "@/components/code/indentation-lines";
import { searchWidget } from "@/components/code/search-widget";
import { scrollShadow } from "@/components/code/scroll-shadow";
import { gutterCovers } from "@/components/code/gutter-background";
import { CURSOR_BLINK_MS, EDITOR_FONT, EDITOR_FONT_SIZE, EDITOR_LINE_FACTOR, SCROLL_COLORS } from "@/lib/editor-defaults";

/** The syntax colours of a theme (roles as in VS Code's TextMate rules). */
type SyntaxColors = {
  keyword: string; controlWord: string; string: string; regexp: string; escape: string; fn: string; type: string;
  variable: string; constant: string; count: string; comment: string; tag: string; attribute: string; angleBracket: string; operator: string;
  punctuation: string; heading: string; reference: string; meta: string; marker: string; invalid: string; inserted: string;
  deleted: string; changed: string; rawText: string;
};
export const DARK_MODERN: SyntaxColors = {
  keyword: "#569cd6", controlWord: "#c586c0", string: "#ce9178", regexp: "#d16969", escape: "#d7ba7d", fn: "#dcdcaa",
  type: "#4ec9b0", variable: "#9cdcfe", constant: "#4fc1ff", count: "#b5cea8", comment: "#6a9955", tag: "#569cd6", attribute: "#9cdcfe",
  angleBracket: "#808080", operator: "#d4d4d4", punctuation: "#d4d4d4", heading: "#569cd6", reference: "#4daafc", meta: "#dcdcaa",
  marker: "#c8c8c8", invalid: "#f44747", inserted: "#b5cea8", deleted: "#ce9178", changed: "#569cd6", rawText: "#ce9178",
};
export const LIGHT_MODERN: SyntaxColors = {
  keyword: "#0000ff", controlWord: "#af00db", string: "#a31515", regexp: "#811f3f", escape: "#ee0000", fn: "#795e26",
  type: "#267f99", variable: "#001080", constant: "#0070c1", count: "#098658", comment: "#008000", tag: "#800000", attribute: "#e50000",
  angleBracket: "#800000", operator: "#000000", punctuation: "#3b3b3b", heading: "#800000", reference: "#005fb8", meta: "#795e26",
  marker: "#000000", invalid: "#cd3131", inserted: "#098658", deleted: "#a31515", changed: "#0451a5", rawText: "#800000",
};

/** The rules of a theme: which @lezer/highlight tags carry which role. The most specific tag wins (`t.function(…)` before the name,
 *  `t.angleBracket` before `t.bracket`). `this`, `true`/`null`, `${ }` and `=>` get the keyword colour as in VS Code; numbers have their own. */
function syntaxRules(f: SyntaxColors): TagStyle[] {
  return [
    { tag: [t.keyword, t.definitionKeyword, t.modifier, t.operatorKeyword, t.self, t.bool, t.null, t.atom, t.special(t.brace), t.function(t.punctuation)], color: f.keyword },
    { tag: [t.controlKeyword, t.moduleKeyword], color: f.controlWord },
    { tag: [t.name, t.variableName, t.propertyName], color: f.variable },
    { tag: [t.function(t.variableName), t.function(t.propertyName), t.function(t.definition(t.variableName)), t.function(t.definition(t.propertyName)), t.macroName], color: f.fn },
    { tag: [t.typeName, t.className, t.namespace], color: f.type },
    { tag: [t.constant(t.name), t.constant(t.variableName), t.constant(t.propertyName)], color: f.constant },
    { tag: [t.number, t.integer, t.float, t.unit], color: f.count },
    { tag: [t.string, t.special(t.string), t.docString, t.character, t.attributeValue, t.color], color: f.string },
    { tag: [t.regexp], color: f.regexp },
    { tag: [t.escape], color: f.escape },
    { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: f.comment },
    { tag: [t.tagName], color: f.tag },
    { tag: [t.attributeName], color: f.attribute },
    { tag: [t.angleBracket], color: f.angleBracket },
    { tag: [t.operator], color: f.operator },
    { tag: [t.punctuation, t.separator, t.bracket], color: f.punctuation },
    { tag: [t.heading], color: f.heading, fontWeight: "bold" },
    { tag: [t.link, t.url], color: f.reference, textDecoration: "underline" },
    { tag: [t.emphasis], fontStyle: "italic" },
    { tag: [t.strong], fontWeight: "bold" },
    { tag: [t.strikethrough], textDecoration: "line-through" },
    { tag: [t.meta, t.processingInstruction, t.documentMeta], color: f.meta },
    { tag: [t.labelName], color: f.marker },
    { tag: [t.inserted], color: f.inserted },
    { tag: [t.deleted], color: f.deleted },
    { tag: [t.changed], color: f.changed },
    { tag: [t.monospace], color: f.rawText },
    { tag: [t.invalid], color: f.invalid },
  ];
}

// Dark: Dark Modern, only with `darkSyntax` (CodePane, diff tab and peek switch it on in dark mode).
const darkHighlightStyle = HighlightStyle.define([
  ...syntaxRules(DARK_MODERN),
]);
// Light: Light Modern, lives in `codeTheme` and applies only while the editor is NOT dark (`themeType`) — without it light mode would be
// coloured by CodeMirror's default (basicSetup, `defaultHighlightStyle` as fallback), not VS Code.
const lightHighlightStyle = HighlightStyle.define(syntaxRules(LIGHT_MODERN), { themeType: "light" });
export const darkSyntax = [Prec.highest(syntaxHighlighting(darkHighlightStyle)), EditorView.darkTheme.of(true)];

/** A highlighter that applies only in languages whose tree has one of these top nodes — without loading the language packages. It sets a
 *  class; the colour (one variable per mode) lives in `codeSurface` and is more specific than the general highlighting. */
function onlyIn(top: readonly string[], rules: TagStyle[]): Extension {
  const style = HighlightStyle.define(rules);
  // HighlightStyle accepts only a language or a node type as scope; the scope is an ordinary property that @lezer/highlight asks at
  // every top node (also of an embedded language).
  (style as unknown as { scope: (type: NodeType) => boolean }).scope = (type) => top.includes(type.name);
  return syntaxHighlighting(style);
}
/** CSS, SCSS, Less (`StyleSheet`): selectors in Dark Modern #d7ba7d, Light Modern #800000. */
export const CSS_TOP = ["StyleSheet"];
/** YAML (`Stream`): keys in Dark Modern #569cd6, Light Modern #800000. */
export const YAML_TOP = ["Stream"];
const languageColors: Extension = [
  onlyIn(CSS_TOP, [{ tag: [t.tagName, t.className, t.labelName], class: "cm-css-selector" }]),
  onlyIn(YAML_TOP, [{ tag: [t.definition(t.propertyName)], class: "cm-yaml-key" }]),
];

/** The surface colours (VS Code `editor.*`, `editorWidget.*`, …) as variables on the editor — Dark Modern. `--cb-widget-edge` is
 *  VS Code 1.143's `editorWidget.border` (Dark Modern #cccccc33, Light Modern #3b3b3b33 — the edge of suggestion list and hover). */
export const SURFACE_DARK: Readonly<Record<string, string>> = {
  "--cb-text": "#cccccc", "--cb-selection": "#264f78", "--cb-selection-inactive": "#3a3d41", "--cb-cursor": "#aeafad", "--cb-line-highlight-border": "#282828",
  "--cb-line-number": "#6e7681", "--cb-line-number-active": "#cccccc", "--cb-selection-highlight": "#add6ff26", "--cb-word-highlight": "#575757b8",
  "--cb-match": "#9e6a03", "--cb-match-other": "#ea5c0055", "--cb-bracket-match": "#0064001a",
  "--cb-bracket-match-edge": "#888888", "--cb-guide": "#404040", "--cb-guide-active": "#707070", "--cb-fold": "#c5c5c5", "--cb-fold-background": "#264f784d",
  "--cb-fold-placeholder": "#808080", "--cb-widget-background": "#202020", "--cb-widget-edge": "#cccccc33", "--cb-widget-shadow": "#0000005c",
  "--cb-widget-text": "#cccccc", "--cb-input-background": "#313131", "--cb-input-edge": "#3c3c3c", "--cb-focus": "#0078d4",
  "--cb-option-active-background": "#2489db82", "--cb-option-active-edge": "#2488db", "--cb-option-active-text": "#ffffff",
  "--cb-symbol-hover": "#5a5d5e50", "--cb-error-text": "#f85149", "--cb-link": "#4daafc", "--cb-link-active": "#4e94ce",
  "--cb-error-background": "#5a1d1d", "--cb-error-edge": "#be1100", "--cb-search-area": "#3a3d4166", "--cb-css-selector": "#d7ba7d",
  "--cb-yaml-key": "#569cd6", "--cb-widget-border": "#313131", "--cb-scroll-shadow": SCROLL_COLORS.dark.shadow,
  "--cb-sticky-hover": SCROLL_COLORS.dark.stickyHover,
};
/** … and Light Modern. */
export const SURFACE_LIGHT: Readonly<Record<string, string>> = {
  "--cb-text": "#3b3b3b", "--cb-selection": "#add6ff", "--cb-selection-inactive": "#e5ebf1", "--cb-cursor": "#000000", "--cb-line-highlight-border": "#eeeeee",
  "--cb-line-number": "#6e7681", "--cb-line-number-active": "#171184", "--cb-selection-highlight": "#add6ff80", "--cb-word-highlight": "#57575740",
  "--cb-match": "#a8ac94", "--cb-match-other": "#ea5c0055", "--cb-bracket-match": "#0064001a",
  "--cb-bracket-match-edge": "#b9b9b9", "--cb-guide": "#d3d3d3", "--cb-guide-active": "#939393", "--cb-fold": "#424242", "--cb-fold-background": "#add6ff4d",
  "--cb-fold-placeholder": "#808080", "--cb-widget-background": "#f8f8f8", "--cb-widget-edge": "#3b3b3b33", "--cb-widget-shadow": "#00000029",
  "--cb-widget-text": "#3b3b3b", "--cb-input-background": "#ffffff", "--cb-input-edge": "#cecece", "--cb-focus": "#005fb8",
  "--cb-option-active-background": "#bed6ed", "--cb-option-active-edge": "#005fb8", "--cb-option-active-text": "#000000",
  "--cb-symbol-hover": "#b8b8b850", "--cb-error-text": "#f85149", "--cb-link": "#005fb8", "--cb-link-active": "#0000ff",
  "--cb-error-background": "#f2dede", "--cb-error-edge": "#be1100", "--cb-search-area": "#b4b4b44d", "--cb-css-selector": "#800000",
  "--cb-yaml-key": "#800000", "--cb-widget-border": "#e5e5e5", "--cb-scroll-shadow": SCROLL_COLORS.light.shadow,
  "--cb-sticky-hover": SCROLL_COLORS.light.stickyHover,
};
const bracketVariables = (colors: readonly string[]) => ({
  "--cb-bracket-0": colors[0], "--cb-bracket-1": colors[1], "--cb-bracket-2": colors[2], "--cb-bracket-mismatched": BRACKET_COLORS.mismatched,
});
// ONE base theme, because only it knows `&dark`/`&light` — it sets nothing but the variables, no other theme sets them.
const colorVariables = EditorView.baseTheme({
  "&dark": { ...SURFACE_DARK, ...bracketVariables(BRACKET_COLORS.dark) },
  "&light": { ...SURFACE_LIGHT, ...bracketVariables(BRACKET_COLORS.light) },
});

// The surface. Where CodeMirror writes its base theme more specifically with `&light`/`&dark` (selection), the rule here is just as
// specific — at equal specificity the theme wins over the base theme.
const codeSurface = EditorView.theme({
  // Font, size and line height as VS Code ships them (lib/editor-defaults.ts) — as variables also for the parts outside the role area
  // (suggestion list, parameter hints, rename field, lsp-theme.ts).
  "&": {
    fontSize: textPx(EDITOR_FONT_SIZE), backgroundColor: "transparent", color: "var(--cb-text)", height: "100%",
    "--cb-editor-font": EDITOR_FONT, "--cb-line-height": String(EDITOR_LINE_FACTOR),
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--cb-editor-font)", lineHeight: "var(--cb-line-height, 1.5)" },
  ".cm-gutters": { backgroundColor: "transparent", border: "none", color: "var(--cb-line-number)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--cb-line-number-active)" },
  // VS Code `editor.lineHighlightBorder`: a 2 px frame around the line, no fill (the indentation lines stay visible below).
  ".cm-activeLine": { backgroundColor: "transparent", boxShadow: "inset 0 0 0 2px var(--cb-line-highlight-border)" },
  ".cm-cursor, .cm-dropCursor": { borderLeft: "2px solid var(--cb-cursor)", marginLeft: "-1px" },
  ".cm-selectionBackground": { background: "var(--cb-selection-inactive)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": { background: "var(--cb-selection)" },
  "::selection": { backgroundColor: "var(--cb-selection)" },
  ".cm-selectionMatch": { backgroundColor: "var(--cb-selection-highlight)" },
  "&.cm-focused .cm-matchingBracket, .cm-matchingBracket": { backgroundColor: "var(--cb-bracket-match)", outline: "1px solid var(--cb-bracket-match-edge)", outlineOffset: "-1px" },
  "&.cm-focused .cm-nonmatchingBracket, .cm-nonmatchingBracket": { backgroundColor: "transparent" },
  // The class also colours the syntax span inside it (otherwise its colour would win).
  ".cm-bracket-0, .cm-bracket-0 *": { color: "var(--cb-bracket-0)" },
  ".cm-bracket-1, .cm-bracket-1 *": { color: "var(--cb-bracket-1)" },
  ".cm-bracket-2, .cm-bracket-2 *": { color: "var(--cb-bracket-2)" },
  ".cm-bracket-mismatched, .cm-bracket-mismatched *": { color: "var(--cb-bracket-mismatched)" },
  ".cm-content .cm-css-selector": { color: "var(--cb-css-selector)" },
  ".cm-content .cm-yaml-key": { color: "var(--cb-yaml-key)" },
  ".cm-foldPlaceholder": { backgroundColor: "transparent", border: "none", color: "var(--cb-fold-placeholder)", padding: "0 4px", margin: "0 2px" },
  ".cm-panels": { backgroundColor: "var(--color-panel)", color: "var(--color-fg)", borderColor: "var(--color-edge)" },
  // The search floats (search-widget.ts): its bar at the top is a shell without height, background and edge.
  ".cm-panels-top:has(> .cm-search-wrapper)": { backgroundColor: "transparent", border: "none" },
  ".cm-searchMatch": { backgroundColor: "var(--cb-match-other)" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "var(--cb-match)" },
});

/** The chosen font size (lib/code-settings.ts) over the default of `codeTheme` — for file editor, diff and peek (VS Code
 *  `editor.fontSize`). `Prec.highest`: at equal specificity the theme attached last wins, and CodeMirror attaches the themes of the higher
 *  level last — a later theme of the same level would lose against `codeTheme`. */
export const fontSize = (px: number): Extension => Prec.highest(EditorView.theme({ "&": { fontSize: textPx(px) } }));

export const codeTheme: Extension = [
  codeSurface, colorVariables, syntaxHighlighting(lightHighlightStyle), languageColors, bracketColors, indentationLines, searchWidget,
  // The caret blinks as in VS Code, 500 ms on, 500 ms off; the shadow on top as soon as it is scrolled.
  drawSelection({ cursorBlinkRate: CURSOR_BLINK_MS }), scrollShadow,
  // The gutter covers as in VS Code (`editorGutter.background` = `editor.background`) — horizontally scrolled text runs under it.
  gutterCovers,
];
