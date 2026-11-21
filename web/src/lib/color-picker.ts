// Port of: microsoft/vscode src/vs/base/common/color.ts (MIT)
// Port of: microsoft/vscode src/vs/editor/contrib/colorPicker/browser/colorPickerModel.ts (MIT)
// Port of: microsoft/vscode src/vs/editor/contrib/colorPicker/browser/colorPickerParts/colorPickerSaturationBox.ts (MIT)
// Port of: microsoft/vscode src/vs/editor/contrib/colorPicker/browser/colorPickerParts/colorPickerStrip.ts (MIT)
// The color picker's computation: pure, no DOM. Like VS Code 1.143.1: a color carries RGBA (channels 0…255 whole, alpha 0…1 to three
// places) AND, if it came from HSVA, that HSVA (so the hue stays put when saturation is 0, base/common/color.ts `Color`); the saturation
// box sets S and V (`s = x / width`, `v = 1 − y / height`), the hue strip H (`h = (1 − value) · 360`, 360 ⇒ 0), the opacity strip A; the
// position of the markers the other way round. The header shows the server's notation (`textDocument/colorPresentation`), a click takes
// the next one (`selectNextColorPresentation`), and on opening the picker guesses the original's notation (`guessColorPresentation`).
// The header text is light or dark by `isLighter` (YIQ ≥ 128; below alpha 0.5 by the editor's background).
// A module without imports (the guard web/test/color-picker.test.mjs runs it).

export type RGBA = { r: number; g: number; b: number; a: number };
export type HSVA = { h: number; s: number; v: number; a: number };
export type ColorValue = { rgba: RGBA; hsva: HSVA };
/** A color in LSP form (channels 0…1). */
export type LspColorValue = { red: number; green: number; blue: number; alpha: number };

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
const round = (x: number, places: number) => { const f = 10 ** places; return Math.round(x * f) / f; };

/** base/common/color.ts `new RGBA(r, g, b, a)`: channels clamped and truncated (`| 0`), alpha clamped to three places. */
export function rgba(r: number, g: number, b: number, a = 1): RGBA {
  return { r: clamp(r, 0, 255) | 0, g: clamp(g, 0, 255) | 0, b: clamp(b, 0, 255) | 0, a: round(clamp(a, 0, 1), 3) };
}
/** base/common/color.ts `new HSVA(h, s, v, a)`: the hue truncated, S/V/A to three places. */
export function hsva(h: number, s: number, v: number, a = 1): HSVA {
  return { h: clamp(h, 0, 360) | 0, s: round(clamp(s, 0, 1), 3), v: round(clamp(v, 0, 1), 3), a: round(clamp(a, 0, 1), 3) };
}

/** `HSVA.fromRGBA`. */
export function hsvaFromRgba(c: RGBA): HSVA {
  const r = c.r / 255, g = c.g / 255, b = c.b / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
  const s = max === 0 ? 0 : delta / max;
  let m: number;
  if (delta === 0) m = 0;
  else if (max === r) m = ((((g - b) / delta) % 6) + 6) % 6;
  else if (max === g) m = (b - r) / delta + 2;
  else m = (r - g) / delta + 4;
  return hsva(Math.round(m * 60), s, max, c.a);
}
/** `HSVA.toRGBA`. */
export function rgbaFromHsva(c: HSVA): RGBA {
  const { h, s, v, a } = c;
  const k = v * s, x = k * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - k;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = k; g = x; } else if (h < 120) { r = x; g = k; } else if (h < 180) { g = k; b = x; }
  else if (h < 240) { g = x; b = k; } else if (h < 300) { r = x; b = k; } else if (h <= 360) { r = k; b = x; }
  return rgba(Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255), a);
}

/** `new Color(RGBA)`: the HSVA computed from it. */
export const fromRgba = (c: RGBA): ColorValue => ({ rgba: c, hsva: hsvaFromRgba(c) });
/** `new Color(HSVA)`: the HSVA stays as it was set. */
export const fromHsva = (c: HSVA): ColorValue => ({ rgba: rgbaFromHsva(c), hsva: c });
/** The server's color (colorPickerParticipantUtils.ts: `new RGBA(Math.round(255 * red), …, alpha)`). */
export const fromLsp = (c: LspColorValue): ColorValue => fromRgba(rgba(Math.round(255 * c.red), Math.round(255 * c.green), Math.round(255 * c.blue), c.alpha));
/** For `textDocument/colorPresentation` (`updateColorPresentations`: channels / 255, alpha as it is). */
export const toLsp = (c: ColorValue): LspColorValue => ({ red: c.rgba.r / 255, green: c.rgba.g / 255, blue: c.rgba.b / 255, alpha: c.rgba.a });
/** `Color.equals` (by RGBA). */
export const sameColor = (a: ColorValue, b: ColorValue): boolean => a.rgba.r === b.rgba.r && a.rgba.g === b.rgba.g && a.rgba.b === b.rgba.b && a.rgba.a === b.rgba.a;

const hex2 = (n: number) => n.toString(16).padStart(2, "0");
/** `Color.Format.CSS.format`: opaque as `#rrggbb`, otherwise `rgba(r, g, b, a)` (alpha to two places). */
export function cssColor(c: ColorValue): string {
  const { r, g, b, a } = c.rgba;
  return a === 1 ? `#${hex2(r)}${hex2(g)}${hex2(b)}` : `rgba(${r}, ${g}, ${b}, ${+a.toFixed(2)})`;
}
/** `Color.isLighter` (YIQ ≥ 128). */
export const isLight = (c: RGBA): boolean => (c.r * 299 + c.g * 587 + c.b * 114) / 1000 >= 128;
/** Is the header text light? No if the color (below alpha 0.5: the background) is light; VS Code then sets `.light` (black). */
export const headerLight = (color: ColorValue, background: RGBA): boolean => (color.rgba.a < 0.5 ? isLight(background) : isLight(color.rgba));

// ── The surfaces ───────────────────────────────────────────────────────────────────────────────────────────

/** Saturation box: point → new color (hue and alpha stay). */
export function fromSaturation(c: ColorValue, x: number, y: number, width: number, height: number): ColorValue {
  const s = clamp(x / Math.max(1, width), 0, 1), v = clamp(1 - y / Math.max(1, height), 0, 1);
  return fromHsva(hsva(c.hsva.h, s, v, c.hsva.a));
}
/** The marker in the saturation box (center of the circle; the CSS subtracts 5 px). */
export const saturationMarker = (c: ColorValue, width: number, height: number) => ({ left: c.hsva.s * width, top: height - c.hsva.v * height });
/** A strip's value at `y` (top 1, bottom 0). */
export const stripValue = (y: number, height: number): number => clamp(1 - y / Math.max(1, height), 0, 1);
/** The position of a strip's slider. */
export const sliderTop = (value: number, height: number): number => (1 - value) * height;
/** Hue strip: `h = (1 − value) · 360`, 360 ⇒ 0. */
export function fromHue(c: ColorValue, value: number): ColorValue {
  const h = (1 - value) * 360;
  return fromHsva(hsva(h === 360 ? 0 : h, c.hsva.s, c.hsva.v, c.hsva.a));
}
export const hueValue = (c: ColorValue): number => 1 - c.hsva.h / 360;
/** Opacity strip (colorPickerBody.ts `onDidOpacityChange`): H, S, V stay, alpha = value. */
export const fromOpacity = (c: ColorValue, value: number): ColorValue => fromHsva(hsva(c.hsva.h, c.hsva.s, c.hsva.v, value));
export const opacityValue = (c: ColorValue): number => c.rgba.a;
/** The base color of the saturation box (full hue) and the gradient of the opacity strip (opaque → transparent). */
export const saturationBackground = (c: ColorValue): string => { const g = rgbaFromHsva(hsva(c.hsva.h, 1, 1, 1)); return `rgba(${g.r}, ${g.g}, ${g.b}, 1)`; };
export function opacityHistory(c: ColorValue): string {
  const { r, g, b } = c.rgba;
  return `linear-gradient(to bottom, rgba(${r}, ${g}, ${b}, 1) 0%, rgba(${r}, ${g}, ${b}, 0) 100%)`;
}

// ── The notations ───────────────────────────────────────────────────────────────────────────────────────────

/** `selectNextColorPresentation`: the next one, at the end the first again. */
export const nextNotation = (index: number, count: number): number => (count > 0 ? (index + 1) % count : 0);
/** The setter `colorPresentations`: the index stays, only beyond the end it falls to 0. */
export const indexAfterNewNotations = (index: number, count: number): number => (index > count - 1 ? 0 : index);
/** `guessColorPresentation`: same label (lowercase), otherwise same start up to the first bracket; otherwise `index` stays. */
export function rateNotation(labels: readonly string[], original: string, index: number): number {
  const small = original.toLowerCase();
  let i = labels.findIndex((l) => l === small);
  if (i < 0) { const beginning = original.split("(")[0].toLowerCase(); i = labels.findIndex((l) => l.toLowerCase().startsWith(beginning)); }
  return i < 0 ? index : i;
}
