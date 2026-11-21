// The color picker as in VS Code 1.143.
//
// (1) lib/color-picker.ts, EXECUTED: RGBA/HSVA as in base/common/color.ts (channels truncated, three decimals, hue stays at S = 0),
//     the surfaces as SaturationBox/Strip (point -> S/V, value -> hue with 360 => 0, opacity via HSVA), markers and sliders,
//     `Color.Format.CSS.format`, `isLighter`, the notations (`selectNextColorPresentation`, setter, `guessColorPresentation`), LSP
//     there and back.
// (2) The wiring (read): click on the square and dwelling open it, the LSP hover is silent over a color, releasing writes `textEdit`
//     before the label together with additional edits and the range moves along, a foreign change closes, an own one does not; the
//     server gets color and range (`color_presentation`); the measures from colorPicker.css; the picker hangs on every editor with a
//     language.
// Every counter-test changes ONE spot and must turn red.
//
// Run:  node --test --test-reporter=tap web/test/color-picker.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");
const read = (...p) => fs.readFileSync(path.join(webDir, ...p), "utf8");
const withoutComments = (s) => s.replace(/^\s*\/\/.*$/gm, "");

const SHEET = read("src", "lib", "color-picker.ts");
const SAB_COMPUTATION = {
  "RGBA rounded instead of truncated": ["return { r: clamp(r, 0, 255) | 0,", "return { r: Math.round(clamp(r, 0, 255)),"],
  "hue rounded": ["return { h: clamp(h, 0, 360) | 0,", "return { h: Math.round(clamp(h, 0, 360)),"],
  "S unrounded": ["s: round(clamp(s, 0, 1), 3), v: round(clamp(v, 0, 1), 3)", "s: clamp(s, 0, 1), v: round(clamp(v, 0, 1), 3)"],
  "hue lost": ["export const fromHsva = (c: HSVA): ColorValue => ({ rgba: rgbaFromHsva(c), hsva: c });", "export const fromHsva = (c: HSVA): ColorValue => fromRgba(rgbaFromHsva(c));"],
  "V upside down": ["v = clamp(1 - y / Math.max(1, height), 0, 1);", "v = clamp(y / Math.max(1, height), 0, 1);"],
  "360 stays": ["return fromHsva(hsva(h === 360 ? 0 : h, c.hsva.s, c.hsva.v, c.hsva.a));", "return fromHsva(hsva(h, c.hsva.s, c.hsva.v, c.hsva.a));"],
  "opacity via RGBA": ["export const fromOpacity = (c: ColorValue, value: number): ColorValue => fromHsva(hsva(c.hsva.h, c.hsva.s, c.hsva.v, value));", "export const fromOpacity = (c: ColorValue, value: number): ColorValue => fromRgba(rgba(c.rgba.r, c.rgba.g, c.rgba.b, value));"],
  "slider upside down": ["export const sliderTop = (value: number, height: number): number => (1 - value) * height;", "export const sliderTop = (value: number, height: number): number => value * height;"],
  "CSS always rgba": ["return a === 1 ? `#${hex2(r)}${hex2(g)}${hex2(b)}` : `rgba(${r}, ${g}, ${b}, ${+a.toFixed(2)})`;", "return `rgba(${r}, ${g}, ${b}, ${+a.toFixed(2)})`;"],
  "light from 100": ["(c.r * 299 + c.g * 587 + c.b * 114) / 1000 >= 128", "(c.r * 299 + c.g * 587 + c.b * 114) / 1000 >= 100"],
  "header without background": ["(color.rgba.a < 0.5 ? isLight(background) : isLight(color.rgba))", "isLight(color.rgba)"],
  "next without wrap-around": ["(count > 0 ? (index + 1) % count : 0)", "(count > 0 ? Math.min(index + 1, count - 1) : 0)"],
  "index always 0": ["(index > count - 1 ? 0 : index)", "0"],
  "guess only equal": ["if (i < 0) { const beginning", "if (i < -1) { const beginning"],
  "to LSP without /255": ["({ red: c.rgba.r / 255, green: c.rgba.g / 255,", "({ red: c.rgba.r, green: c.rgba.g / 255,"],
  "from LSP truncated": ["rgba(Math.round(255 * c.red),", "rgba(Math.floor(255 * c.red),"],
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-color-picker-"));
const src = path.join(tmp, "src"), out = path.join(tmp, "out");
fs.mkdirSync(src, { recursive: true });
fs.writeFileSync(path.join(src, "real.ts"), SHEET);
const copies = Object.entries(SAB_COMPUTATION).map(([name, [old, fresh]], i) => {
  const places = SHEET.split(old).length - 1;
  fs.writeFileSync(path.join(src, `s${i}.ts`), SHEET.replace(old, fresh));
  return { name, places, file: `s${i}.ts` };
});
try {
  execFileSync(process.execPath, [tsc, ...fs.readdirSync(src).map((d) => path.join(src, d)), "--outDir", out, "--rootDir", src, "--module", "es2022", "--target", "es2022", "--strict", "--skipLibCheck", "--lib", "es2022,dom", "--noUnusedLocals", "false"], { stdio: "pipe" });
} catch (e) {
  const text = `${String(e.stdout || "")}${String(e.stderr || "")}`;
  if (text.split("\n").some((z) => /error TS\d+/.test(z) && /real\.ts\(/.test(z)) || !fs.existsSync(path.join(out, "real.js"))) throw new Error(`tsc: ${text}`.slice(0, 4000));
}
const load = (d) => import(pathToFileURL(path.join(out, d.replace(/\.ts$/, ".js"))).href);
const real = await load("real.ts");
const sabotaged = await Promise.all(copies.map(async (k) => ({ ...k, M: await load(k.file) })));
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }

function computation(M) {
  const { rgba, hsva, hsvaFromRgba, rgbaFromHsva, fromRgba, fromHsva, fromLsp, toLsp, cssColor, isLight, headerLight, fromSaturation, saturationMarker, stripValue, sliderTop,
    fromHue, hueValue, fromOpacity, nextNotation, indexAfterNewNotations, rateNotation, sameColor } = M;
  // base/common/color.ts: channels clamped and truncated, alpha three decimals; HSVA: h truncated, s/v/a three decimals.
  assert.deepEqual(rgba(12.7, -3, 255.9, 0.12345), { r: 12, g: 0, b: 255, a: 0.123 });
  assert.deepEqual(hsva(359.9, 0.33333, 1.2, 0.5), { h: 359, s: 0.333, v: 1, a: 0.5 });
  assert.deepEqual(hsvaFromRgba(rgba(51, 102, 255, 1)), { h: 225, s: 0.8, v: 1, a: 1 }, "#3366ff");
  assert.deepEqual(rgbaFromHsva(hsva(225, 0.8, 1, 1)), { r: 51, g: 102, b: 255, a: 1 });
  assert.deepEqual(hsvaFromRgba(rgba(0, 0, 0, 1)), { h: 0, s: 0, v: 0, a: 1 });
  // The hue stays if the color arises from HSVA (saturation 0).
  const gray = fromHsva(hsva(120, 0, 0.5, 1));
  assert.equal(gray.hsva.h, 120);
  assert.deepEqual(gray.rgba, { r: 128, g: 128, b: 128, a: 1 }, "toRGBA rounds (0.5 * 255 = 127.5 -> 128)");
  // LSP there and back (channels x255 rounded, /255).
  const blue = fromLsp({ red: 0.2, green: 0.4, blue: 1, alpha: 1 });
  assert.deepEqual(blue.rgba, { r: 51, g: 102, b: 255, a: 1 });
  assert.deepEqual(toLsp(blue), { red: 0.2, green: 0.4, blue: 1, alpha: 1 });
  assert.equal(fromLsp({ red: 0.3, green: 0, blue: 0, alpha: 1 }).rgba.r, 77, "0.3 * 255 = 76.5 -> 77 (rounded)");
  // Color.Format.CSS.format
  assert.equal(cssColor(blue), "#3366ff");
  assert.equal(cssColor(fromRgba(rgba(0, 0, 0, 0.4))), "rgba(0, 0, 0, 0.4)");
  // isLighter (YIQ >= 128); header light by the color, below alpha 0.5 by the background.
  assert.equal(isLight(rgba(255, 255, 0)), true);
  assert.equal(isLight(rgba(51, 102, 255)), false);
  assert.equal(isLight(rgba(128, 128, 128)), true, "exactly 128 is light");
  assert.equal(headerLight(fromRgba(rgba(0, 0, 0, 0.4)), rgba(248, 248, 248)), true, "transparent over a light ground");
  assert.equal(headerLight(fromRgba(rgba(0, 0, 0, 0.6)), rgba(248, 248, 248)), false);
  // Saturation field: top left whitish (S 0, V 1), bottom right black; hue and alpha stay.
  const half = fromRgba(rgba(255, 0, 0, 0.5));
  const p = fromSaturation(half, 110, 37.5, 220, 150);
  assert.deepEqual(p.hsva, { h: 0, s: 0.5, v: 0.75, a: 0.5 });
  assert.deepEqual(fromSaturation(half, -10, 200, 220, 150).hsva, { h: 0, s: 0, v: 0, a: 0.5 }, "clamped");
  assert.deepEqual(saturationMarker(p, 220, 150), { left: 110, top: 37.5 });
  // Strip: 1 at the top, 0 at the bottom; hue (1 - value) * 360, 360 => 0; opacity via HSVA.
  assert.equal(stripValue(0, 150), 1);
  assert.equal(stripValue(150, 150), 0);
  assert.equal(sliderTop(0.25, 150), 112.5);
  assert.equal(fromHue(blue, 0).hsva.h, 0, "bottom: 360 => 0");
  assert.equal(fromHue(blue, 0.5).hsva.h, 180);
  assert.equal(hueValue(fromHue(blue, 0.5)), 0.5);
  const through = fromOpacity(gray, 0.25);
  assert.equal(through.hsva.h, 120, "opacity keeps the hue (HSVA)");
  assert.equal(through.rgba.a, 0.25);
  assert.equal(sameColor(blue, fromLsp({ red: 0.2, green: 0.4, blue: 1, alpha: 1 })), true);
  // Notations
  assert.equal(nextNotation(0, 3), 1);
  assert.equal(nextNotation(2, 3), 0);
  assert.equal(indexAfterNewNotations(2, 3), 2, "the index stays");
  assert.equal(indexAfterNewNotations(3, 3), 0, "past the end: 0");
  const L = ["rgb(51, 102, 255)", "#3366ff", "hsl(225, 100%, 60%)"];
  assert.equal(rateNotation(L, "#3366FF", 0), 1, "equal ignoring case");
  assert.equal(rateNotation(L, "hsl(225,100%,60%)", 0), 2, "same beginning up to the parenthesis");
  assert.equal(rateNotation(L, "blue", 1), 1, "nothing fits: stays");
}

test("(1) computation executed, and every sabotage is caught", () => {
  computation(real);
  assert.deepEqual(copies.filter((k) => k.places !== 1).map((k) => k.name), [], "sabotages whose spot does not appear exactly once");
  const through = sabotaged.filter((k) => { try { computation(k.M); return true; } catch { return false; } }).map((k) => k.name);
  assert.deepEqual(through, [], "sabotages that are not caught");
});

const Q = {
  w: read("src", "components", "code", "color-picker.ts"),
  colors: read("src", "components", "code", "lsp-colors.ts"),
  hover: read("src", "components", "code", "lsp-hover.ts"),
  extension: read("src", "components", "code", "lsp-extension.ts"),
  actions: fs.readFileSync(path.join(webDir, "..", "server", "backend", "electron", "server", "lsp", "actions.js"), "utf8"),
};
const has = (text, chunk, what) => assert.ok(withoutComments(text).includes(chunk), what);
function wiring(q) {
  has(q.extension, `outlineExtension, stickyScroll, lspColors, colorPicker,`, "picker not in the editor");
  has(q.hover, `if (colorForPicker(view, pos)) return null;`, "the LSP hover shows over a color (VS Code: only the picker)");
  has(q.colors, `b.add(x.from, x.to, Decoration.mark({ color: x.color, inclusive: false }));`, "without ranges the picker does not know which color stands where");
  has(q.colors, `return tr.docChanged ? { squares: d.squares.map(tr.changes), areas: d.areas.map(tr.changes) } : d;`, "ranges do not move along");
  // Opening
  has(q.w, `if (openColorPicker(this.view, pos, "click")) { e.preventDefault(); return true; }`, "click on the square does not open");
  has(q.w, `this.on = setTimeout(() => { this.on = null; openColorPicker(this.view, pos, "hover"); }, PICKER_HOVER_MS);`, "dwelling does not open");
  has(q.w, `export const PICKER_HOVER_MS = 300;`, "hover time is not VS Code's");
  has(q.w, `if (e.key === "Escape" && this.view.state.field(pickerField, false)) { closeColorPicker(this.view);`, "Esc does not close");
  has(q.w, `this.dom.addEventListener("mousedown", (e) => e.preventDefault());`, "a click into the picker takes the focus from the editor (Esc then does not close)");
  has(q.w, `if (this.view.state.field(pickerField, false)?.source !== "hover") return;\n      this.afterTimer = setTimeout(() => { this.afterTimer = null; if (!this.dragging) closeColorPicker(this.view); }, PICKER_HOVER_MS);`, "the picker from dwelling does not close on leaving (or the one from the click does, or while dragging)");
  has(q.w, `this.dom.addEventListener("mouseenter", () => this.hold());`, "back in the picker it closes anyway");
  has(q.w, `if (open?.source === "hover" && !this.closeTimer) this.closeTimer = setTimeout(`, "the picker from the click closes when the pointer leaves the text (VS Code: stays)");
  has(q.w, `if (this.view.state.field(pickerField, false)?.source === "hover" && !this.closeTimer) this.closeTimer = setTimeout(`, "the picker from the click closes when the pointer leaves the editor (VS Code: stays)");
  has(q.w, `if (open && f && open.from === f.from) { this.picker()?.hold(); return; }`, "back on its own color it closes anyway");
  // Closing on a foreign change, not on an own one
  has(q.w, `if (v && t.docChanged) return t.isUserEvent(PICKER_EVENT) ? v : null;`, "foreign change does not close / own one closes");
  has(q.w, `view.dispatch({ changes, effects: setArea.of({ from, to }), userEvent: PICKER_EVENT, scrollIntoView: false });`, "writing without origin or without range");
  // Writing: textEdit before label, additional edits, range moves along; only on release
  has(q.w, `const main = s.textEdit\n      ? { from: lspOffsetOf(doc, s.textEdit.range.start), to: lspOffsetOf(doc, s.textEdit.range.end), insert: s.textEdit.newText }\n      : { from: b.from, to: b.to, insert: s.label };`, "textEdit does not go before the label");
  has(q.w, `changes = view.state.changes([...addition, main]);`, "additional edits are missing");
  has(q.w, `const from = changes.mapPos(main.from, -1), to = changes.mapPos(main.to, 1);`, "range does not move along");
  has(q.w, `this.dragging = false;\n        void this.write();`, "release does not write");
  has(q.w, `this.set(this.original); void this.write();`, "original does not reset");
  has(q.w, `this.index = nextNotation(this.index, this.notations.length);`, "header row does not switch");
  has(q.w, `if (guess) this.index = rateNotation(`, "notation of the original not guessed");
  has(q.w, `questions(d, "color_presentation", { color: toLsp(color), range: { start: lspPosOf(doc, b.from), end: lspPosOf(doc, b.to) } })`, "server does not get color/range");
  has(q.w, `if (this.destroyed || seq !== this.askSeq || isNotSupported(r)) return null;`, "an older answer overwrites a younger one");
  // Measures from colorPicker.css
  has(q.w, `".cm-color-picker": { height: "190px",`, "height is not 190 px");
  has(q.w, `".cm-color-picker .colorpicker-header": { display: "flex", height: "24px",`, "header is not 24 px");
  has(q.w, `".cm-color-picker .original-color": { width: "74px",`, "original is not 74 px");
  has(q.w, `".cm-color-picker .saturation-wrap": { overflow: "hidden", height: "150px", position: "relative", minWidth: "220px", flex: "1" },`, "saturation field is not like VS Code");
  has(q.w, `".cm-color-picker .strip": { width: "25px", height: "150px" },`, "strip is not 25 x 150");
  has(q.w, `width: "9px", height: "9px", margin: "-5px 0 0 -5px",`, "circle is not 9 px");
  has(q.w, `".cm-color-picker .picked-color.light": { color: "#000" },`, "light color without dark text");
  // Server: the action passes through
  has(q.actions, `const r = await s.v.request("textDocument/colorPresentation", {`, "B does not ask the server");
}
const SAB_SOURCES = [
  ["extension", "picker missing", `lspColors, colorPicker,`, `lspColors,`],
  ["hover", "hover over color", `if (colorForPicker(view, pos)) return null;`, ``],
  ["colors", "no ranges", `b.add(x.from, x.to, Decoration.mark({ color: x.color, inclusive: false }));`, ``],
  ["colors", "ranges stay", `areas: d.areas.map(tr.changes) }`, `ranges: d.areas }`],
  ["w", "focus gone", `this.dom.addEventListener("mousedown", (e) => e.preventDefault());`, ``],
  ["w", "click picker closes", `?.source !== "hover") return;`, `?.source === "never") return;`],
  ["w", "leaving does not close", `if (!this.dragging) closeColorPicker(this.view); }, PICKER_HOVER_MS);`, `}, PICKER_HOVER_MS);`],
  ["w", "closes while dragging", `this.afterTimer = null; if (!this.dragging) closeColorPicker(this.view);`, `this.afterTimer = null; closeColorPicker(this.view);`],
  ["w", "return to the color does not hold", `if (open && f && open.from === f.from) { this.picker()?.hold(); return; }`, `if (open && f && open.from === f.from) { return; }`],
  ["w", "click picker closes in the text", `if (open?.source === "hover" && !this.closeTimer)`, `if (open && !this.closeTimer)`],
  ["w", "click picker closes outside", `if (this.view.state.field(pickerField, false)?.source === "hover" && !this.closeTimer)`, `if (this.view.state.field(pickerField, false) && !this.closeTimer)`],
  ["w", "return does not hold", `this.dom.addEventListener("mouseenter", () => this.hold());`, ``],
  ["w", "click dead", `if (openColorPicker(this.view, pos, "click")) { e.preventDefault(); return true; }`, ``],
  ["w", "hover dead", `openColorPicker(this.view, pos, "hover"); }, PICKER_HOVER_MS);`, `}, PICKER_HOVER_MS);`],
  ["w", "hover time", `export const PICKER_HOVER_MS = 300;`, `export const PICKER_HOVER_MS = 800;`],
  ["w", "Esc", `if (e.key === "Escape" && this.view.state.field(pickerField, false)) { closeColorPicker(this.view);`, `if (e.key === "Escape" && this.view.state.field(pickerField, false)) {`],
  ["w", "own change closes", `return t.isUserEvent(PICKER_EVENT) ? v : null;`, `return null;`],
  ["w", "foreign change stays", `return t.isUserEvent(PICKER_EVENT) ? v : null;`, `return v;`],
  ["w", "label before textEdit", `const main = s.textEdit\n      ?`, `const main = false\n      ?`],
  ["w", "without additional edits", `changes = view.state.changes([...addition, main]);`, `changes = view.state.changes([main]);`],
  ["w", "range stays", `const from = changes.mapPos(main.from, -1), to = changes.mapPos(main.to, 1);`, `const from = b.from, to = b.to;`],
  ["w", "release does not write", `this.dragging = false;\n        void this.write();`, `this.dragging = false;`],
  ["w", "original", `this.set(this.original); void this.write();`, `this.set(this.original);`],
  ["w", "header does not switch", `this.index = nextNotation(this.index, this.notations.length);`, ``],
  ["w", "not guessed", `if (guess) this.index = rateNotation(`, `if (false) this.index = rateNotation(`],
  ["w", "server without range", `range: { start: lspPosOf(doc, b.from), end: lspPosOf(doc, b.to) } })`, `range: null })`],
  ["w", "old answer", `if (this.destroyed || seq !== this.askSeq || isNotSupported(r)) return null;`, `if (this.destroyed || isNotSupported(r)) return null;`],
  ["w", "height", `".cm-color-picker": { height: "190px",`, `".cm-color-picker": { height: "200px",`],
  ["w", "Header", `display: "flex", height: "24px",`, `display: "flex", height: "28px",`],
  ["w", "original wide", `width: "74px",`, `width: "60px",`],
  ["w", "Field", `minWidth: "220px", flex: "1" },`, `minWidth: "200px", flex: "1" },`],
  ["w", "Strip", `{ width: "25px", height: "150px" }`, `{ width: "20px", height: "150px" }`],
  ["w", "circle", `width: "9px", height: "9px", margin: "-5px 0 0 -5px",`, `width: "12px", height: "12px", margin: "-6px 0 0 -6px",`],
  ["w", "text light", `".cm-color-picker .picked-color.light": { color: "#000" },`, ``],
  ["actions", "B does not ask", `const r = await s.v.request("textDocument/colorPresentation", {`, `const r = await Promise.resolve([], {`],
];
test("(2) wiring: opening, closing, writing, measures, with counter-tests", () => {
  wiring(Q);
  const wrong = [], through = [];
  for (const [file, name, old, fresh] of SAB_SOURCES) {
    if (Q[file].split(old).length - 1 !== 1) { wrong.push(name); continue; }
    try { wiring({ ...Q, [file]: Q[file].replace(old, fresh) }); through.push(name); } catch { /* caught */ }
  }
  assert.deepEqual(wrong, [], "sabotages whose spot does not appear exactly once");
  assert.deepEqual(through, [], "sabotages that are not caught");
});
