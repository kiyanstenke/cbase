// Port of: microsoft/vscode src/vs/editor/contrib/colorPicker/browser/colorDetector.ts (MIT)
// The color square before a color value: the computation of VS Code `ColorDetector.updateColorDecorators` (src/vs/editor/contrib/colorPicker/browser/colorDetector.ts, 1.143.1):
// per color of the server (`textDocument/documentColor`, channels 0…1) a square BEFORE the range, background `rgba(r, g, b, a)` with
// rounded 0…255 channels and the alpha to three places (base/common/color.ts `RGBA`), at most `editor.colorDecoratorsLimit` (500).
// The dimensions live in components/code/lsp-colors.ts (from colorPicker.css `.colorpicker-color-decoration`). A module without imports
// (the guard web/test/link-colors.test.mjs runs it).

export type Color = { red: number; green: number; blue: number; alpha: number };
export type ColorPlace = { range: { start: { line: number; character: number }; end: { line: number; character: number } }; color: Color };

/** VS Code `editor.colorDecoratorsLimit` (default). */
export const COLOR_CAP = 500;
/** VS Code `ColorDetector.RECOMPUTE_TIME`: how long after a change until it asks again. */
export const COLOR_NEW_MS = 1000;

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
const places3 = (x: number) => Math.round(x * 1000) / 1000;

/** The square's background: `rgba(255, 0, 0, 1)`, like VS Code (channels rounded, alpha clamped to three places). */
export function colorCss(c: Color): string {
  const k = (x: number) => Math.round(clamp(Number(x) || 0, 0, 1) * 255);
  return `rgba(${k(c.red)}, ${k(c.green)}, ${k(c.blue)}, ${places3(clamp(Number(c.alpha) || 0, 0, 1))})`;
}

/** The squares of an answer: start of the range and background, in the server's order, capped. */
export function colorSquares(colors: readonly ColorPlace[]): { start: ColorPlace["range"]["start"]; css: string }[] {
  return colors.slice(0, COLOR_CAP).map((f) => ({ start: f.range.start, css: colorCss(f.color) }));
}
