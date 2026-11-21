// The order of the margin columns in the code editor as in VS Code: [glyph margin: breakpoints, light bulb] · line numbers · git margin
// (dirty diff) · fold arrows right at the text.
//
// CodeMirror orders the margins by PRECEDENCE and only within a level by position in the configuration (components/code/BufferEditor.tsx:
// basicSetup with the line numbers first, then the view's extensions). The glyph margin therefore stands one level higher, the fold arrows
// one level lower, line numbers and git margin stay without a level in the middle — so the order holds wherever an extension is attached:
// file tab in Coding → Files and in the chat, both editor groups (components/CodePane.tsx `buildExtensions`), the editable side of the
// diff tab (there without git margin and fold arrows, as in VS Code's diff) and the peek.
//
// There is no margin for diagnostics: VS Code shows them as a squiggle and in the hover (components/code/lsp-diagnostics.ts without
// `lintGutter`). Guard: web/test/editor-look.test.mjs (the order measured against CodeMirror itself).
import { Prec, type Extension } from "@codemirror/state";

/** A margin of the glyph margin, left of the line numbers: breakpoints, light bulb. */
export const glyphMargin = (e: Extension): Extension => Prec.high(e);
/** The margin right at the text, right of line numbers and git margin: the fold arrows. */
export const marginAtText = (e: Extension): Extension => Prec.low(e);
