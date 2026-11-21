// Accent color (src/lib/accent.ts): ONE chosen color, from which accent and tinted surface are derived per
// theme and applied through a <style id="cb-accent"> element, before first paint, by an init script that
// carries the computation via `toString()`.
//
// Four promises, each of which fails silently:
//  (1) Whatever is chosen: white text on the accent stays legible (light >= 4.5 : 1, dark >= 3 : 1), and
//      the accent as text is never weaker on ANY surface of the app than the cobalt on the same surface:
//      every surface role from globals.css in its theme, the composer, the iPhone surfaces and the own
//      tinted surface (accent-soft). So also >= 4.5 : 1 wherever the cobalt reaches it. The app writes
//      `text-white` on `bg-accent` in about 45 places and `text-accent` on surfaces in about 200; if the
//      clamp fell, white text on yellow or indigo would sit at 3.1 : 1 in the composer, with no red line
//      anywhere.
//  (2) The default stays the default: the transcript of the fixed values matches globals.css, and the
//      derivation of the cobalt hits it (otherwise the rules are not read off it).
//  (3) The init script computes the SAME as the function: the function must not use anything from outside
//      its body, or the script dies silently in its try/catch.
//  (4) Invalid means default: no style, nothing stored.
//
// Run:  node --test web/test/accent.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");

// accent.ts imports react, so the output must find it: put it under web/node_modules.
const out = fs.mkdtempSync(path.join(webDir, "node_modules", ".accent-test-"));
let mod;
try {
  execFileSync(process.execPath, [
    tsc, path.join(webDir, "src", "lib", "accent.ts"), "--module", "esnext", "--target", "es2022",
    "--moduleResolution", "bundler", "--skipLibCheck", "--lib", "es2022,dom", "--outDir", out,
  ], { cwd: webDir, stdio: "pipe" });
  mod = await import(pathToFileURL(path.join(out, "accent.js")).href);
} finally {
  try { fs.rmSync(out, { recursive: true, force: true }); }
  catch (e) { console.warn("[test] temp directory was left behind:", String(e?.message || e).slice(0, 120)); }
}
const {
  ACCENT_INIT_SCRIPT, ACCENT_KEY, ACCENT_DEFAULT, ACCENT_DEFAULT_VALUES, ACCENT_STYLE_ID, ACCENT_DEFAULTS,
  deriveAccent, accentCss, getAccent, setAccent, xtermWithAccent,
} = mod;

const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = (hex) => {
  const x = parseInt(hex.slice(1), 16);
  return 0.2126 * lin(((x >> 16) & 255) / 255) + 0.7152 * lin(((x >> 8) & 255) / 255) + 0.0722 * lin((x & 255) / 255);
};
const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const channels = (hex) => [0, 2, 4].map((i) => parseInt(hex.slice(1 + i, 3 + i), 16));
// color-mix(in srgb, a p, b): mixing happens in the gamma-encoded channels.
const shuffle = (a, p, b) => "#" + channels(a).map((v, i) => Math.round(v * p + channels(b)[i] * (1 - p)).toString(16).padStart(2, "0")).join("");
const globalsCss = fs.readFileSync(path.join(webDir, "src", "app", "globals.css"), "utf8");

// The surfaces on which the accent appears as text. Every surface role from globals.css (ground, surface,
// hover, edge, code, frame, menu, card, including the cool ones under `.cb-kit` and the cards in the sheet),
// assigned by luminance to the theme in which it applies; plus the computed ones (composer, user bubble,
// strip under the field) and those of the iPhone: the app palette (`mobile/CbaseMobile/Kit/CbColor.swift`,
// copied by hand, no test reads the Swift file) and the levels painted by the system: the inside of every
// form/list on the BASE #1c1c1e (`ListLevel`, Kit/Theme.swift; the rows themselves carry `surface` via
// `CbForm`/`CbList`), the main window on the ELEVATED #2c2c2e/#3a3a3c (`WindowLevel`; light is the grouped
// ground).
const SURFACES = (() => {
  const light = new Map([
    ["ios #f2f2f7", "#f2f2f7"],
    ["ios drawer #f5f4ed", "#f5f4ed"], ["ios ground #faf9f5", "#faf9f5"], ["ios surface #ffffff", "#ffffff"],
    ["ios raised #f0eee6", "#f0eee6"], ["ios marked #ebe9df", "#ebe9df"],
  ]);
  const dark = new Map([
    ["ios #1c1c1e", "#1c1c1e"], ["ios #2c2c2e", "#2c2c2e"], ["ios #3a3a3c", "#3a3a3c"],
    ["ios drawer #0e0e0d", "#0e0e0d"], ["ios ground #171716", "#171716"], ["ios surface #1f1f1d", "#1f1f1d"],
    ["ios raised #272725", "#272725"], ["ios selection #333330", "#333330"],
  ]);
  const re = /--(color-(?:bg|panel|hover|edge|code|frame(?:-edge|-hover|-active)?)|cb-flat-(?:pop|card(?:-hover)?)):\s*(#[0-9a-fA-F]{6})\b/g;
  for (const [, name, value] of globalsCss.matchAll(re)) {
    const hex = value.toLowerCase(), y = lum(hex);
    assert.ok(y > 0.5 || y < 0.1, `--${name}: ${hex} is neither a light nor a dark surface`);
    (y > 0.5 ? light : dark).set(`${name} ${hex}`, hex);
  }
  const fgLight = "#1c1e22", fgDark = "#f3f3f3";
  light.set("composer (white)", shuffle("#ffffff", 0.35, "#ffffff"));
  light.set("cb-bubble", shuffle(fgLight, 0.06, "#ffffff"));
  light.set("cb-strip-bottom", shuffle(fgLight, 0.03, "#ffffff"));
  // The surface of the notices above the composer (`.cb-strip-surface`): the compact dot and the graph symbol
  // appear there in the accent color.
  light.set("cb-strip-surface (fg 5 % over white)", shuffle(fgLight, 0.05, "#ffffff"));
  dark.set("composer (fg 14 % over panel)", shuffle(fgDark, 0.14, "#181818"));
  dark.set("cb-strip-surface (fg 9.6 % over panel)", shuffle(fgDark, 0.096, "#181818"));
  dark.set("cb-bubble (bubble)", "#303030");
  return { light, dark };
})();
// Cobalt on the same surface: the yardstick. For the own tinted surface: cobalt on ITS.
const latte = (mode, surface) => contrast(ACCENT_DEFAULT_VALUES[mode].accent, surface);
const latteSoft = (mode) => contrast(ACCENT_DEFAULT_VALUES[mode].accent, ACCENT_DEFAULT_VALUES[mode].soft);
const EPS = 1e-9; // floating point: the computation compares luminance, the test the ratio

test("surfaces: all found in globals.css, including the ones from the proofreading", () => {
  const h = [...SURFACES.light.values()], d = [...SURFACES.dark.values()];
  for (const hex of ["#ffffff", "#eeece6", "#e9ebef", "#dfe3e9", "#f6f7f8"]) assert.ok(h.includes(hex), `light ${hex}`);
  for (const hex of ["#181818", "#121212", "#2a2a2a", "#2d2d2d", "#353535", "#373737", "#1c1c1e", "#2c2c2e"]) assert.ok(d.includes(hex), `dark ${hex}`);
  assert.ok(h.length >= 18 && d.length >= 18, `${h.length} light, ${d.length} dark`);
});

test("contrast: every choice keeps white text on the accent legible and the accent on every surface never weaker than the cobalt", (t) => {
  let n = 0;
  const min = new Map();
  const remember = (name, v) => { if (!(min.get(name) <= v)) min.set(name, v); };
  const check = (hex) => {
    const a = deriveAccent(hex);
    assert.ok(a, hex);
    for (const w of [a.light.accent, a.light.soft, a.dark.accent, a.dark.soft]) assert.match(w, /^#[0-9a-f]{6}$/, hex);
    assert.ok(contrast(a.light.accent, "#ffffff") >= 4.5, `${hex} light ${a.light.accent}: ${contrast(a.light.accent, "#ffffff").toFixed(2)}`);
    assert.ok(contrast(a.dark.accent, "#ffffff") >= 3, `${hex} dark ${a.dark.accent} against white`);
    remember("light white on accent", contrast(a.light.accent, "#ffffff"));
    remember("dark white on accent", contrast(a.dark.accent, "#ffffff"));
    for (const mode of ["light", "dark"]) {
      for (const [name, f] of SURFACES[mode]) {
        const k = contrast(a[mode].accent, f), desired = latte(mode, f);
        assert.ok(k >= desired - EPS, `${hex} ${mode} ${a[mode].accent} on ${name}: ${k.toFixed(3)} < cobalt ${desired.toFixed(3)}`);
        remember(`${mode} ${name}`, k);
      }
      // The own tinted surface carries `text-accent` in about 17 places (marks, counters, buttons).
      const k = contrast(a[mode].accent, a[mode].soft), desired = latteSoft(mode);
      assert.ok(k >= desired - EPS, `${hex} ${mode} ${a[mode].accent} on own accent-soft ${a[mode].soft}: ${k.toFixed(3)} < cobalt ${desired.toFixed(3)}`);
      remember(`${mode} own accent-soft`, k);
    }
    // The tinted surfaces also carry text in fg (selection, marks): they stay light or dark respectively.
    assert.ok(contrast(a.light.soft, "#1c1e22") >= 10, `${hex} light soft ${a.light.soft}`);
    assert.ok(contrast(a.dark.soft, "#f3f3f3") >= 10, `${hex} dark soft ${a.dark.soft}`);
    n++;
  };
  for (let r = 0; r < 256; r += 17) for (let g = 0; g < 256; g += 17) for (let b = 0; b < 256; b += 17) {
    check("#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join(""));
  }
  for (const hex of ["#facc15", "#a5f3fc", "#ffffff", "#000000", "#84cc16", "#ff00ff", "#00ffff"]) check(hex);
  assert.equal(n, 16 ** 3 + 7);
  // The promise in numbers: wherever the cobalt reaches 4.5 : 1, every choice does.
  for (const mode of ["light", "dark"]) for (const [name, f] of SURFACES[mode]) {
    if (latte(mode, f) >= 4.5) assert.ok(min.get(`${mode} ${name}`) >= 4.5 - EPS, `${mode} ${name}`);
  }
  const show = (name, f) => `${name} ${min.get(name).toFixed(2)}${f ? ` (cobalt ${f.toFixed(2)})` : ""}`;
  t.diagnostic(`${n} colors; smallest contrast — ` + [
    show("light white on accent"), show("light color-bg #eeece6", latte("light", "#eeece6")),
    show("light own accent-soft", latteSoft("light")), show("dark white on accent"),
    show("dark color-panel #181818", latte("dark", "#181818")), show("dark cb-flat-pop #2d2d2d", latte("dark", "#2d2d2d")),
    show("dark composer (fg 14 % over panel)", latte("dark", "#373737")), show("dark own accent-soft", latteSoft("dark")),
    show("dark ios #1c1c1e", latte("dark", "#1c1c1e")),
    show("light ios marked #ebe9df", latte("light", "#ebe9df")), show("dark ios surface #1f1f1d", latte("dark", "#1f1f1d")),
    show("dark ios selection #333330", latte("dark", "#333330")),
  ].join(", "));
  // The presets are chosen so that nothing is clamped in light mode: the field shows the tone that was
  // chosen. And none appears twice.
  for (const v of ACCENT_DEFAULTS) assert.equal(deriveAccent(v.hex).light.accent, v.hex, v.label);
  assert.equal(new Set(ACCENT_DEFAULTS.map((v) => v.hex)).size, ACCENT_DEFAULTS.length);
  assert.equal(ACCENT_DEFAULTS[0].hex, ACCENT_DEFAULT, "the default comes first");
});

test("default: the transcript matches globals.css, and the derivation of the cobalt hits it", () => {
  const css = globalsCss;
  const block = (sel) => {
    const i = css.indexOf(sel);
    assert.ok(i >= 0, `${sel} missing from globals.css`);
    return css.slice(i, css.indexOf("}", i));
  };
  const value = (b, name) => {
    const m = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6});`).exec(b);
    assert.ok(m, name);
    return m[1].toLowerCase();
  };
  // The dark block must carry EXACTLY this selector: the style element overrides it with
  // `:root:root[data-theme="dark"]`; only the higher specificity makes it independent of the order of the
  // stylesheets.
  const light = block("@theme {"), dark = block(':root[data-theme="dark"] {');
  assert.deepEqual(ACCENT_DEFAULT_VALUES, {
    light: { accent: value(light, "--color-accent"), soft: value(light, "--color-accent-soft") },
    dark: { accent: value(dark, "--color-accent"), soft: value(dark, "--color-accent-soft") },
  });
  assert.equal(ACCENT_DEFAULT, ACCENT_DEFAULT_VALUES.light.accent);
  const a = deriveAccent(ACCENT_DEFAULT);
  for (const m of ["light", "dark"]) for (const r of ["accent", "soft"]) {
    const d = channels(a[m][r]).map((v, i) => Math.abs(v - channels(ACCENT_DEFAULT_VALUES[m][r])[i]));
    assert.ok(Math.max(...d) <= 8, `${m}.${r}: derived ${a[m][r]}, fixed ${ACCENT_DEFAULT_VALUES[m][r]}`);
  }
  assert.match(accentCss(a), /^:root:root\{--color-accent:#[0-9a-f]{6};--color-accent-soft:#[0-9a-f]{6}\}:root:root\[data-theme="dark"\]\{/);
  // The clamp limits are the fixed values, as literals INSIDE the function (it must not use anything
  // from outside). If globals.css changes, the computation must follow.
  const source = deriveAccent.toString();
  for (const m of ["light", "dark"]) for (const r of ["accent", "soft"]) {
    assert.ok(source.includes(`"${ACCENT_DEFAULT_VALUES[m][r]}"`), `${m}.${r} ${ACCENT_DEFAULT_VALUES[m][r]} missing from deriveAccent`);
  }
});

// Doubles: localStorage and a <head> into which the style element goes.
function mocks(saved) {
  const storage = new Map(saved === undefined ? [] : [[ACCENT_KEY, saved]]);
  globalThis.localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
  };
  const children = [];
  const head = { appendChild: (el) => { children.push(el); el.remove = () => children.splice(children.indexOf(el), 1); return el; } };
  globalThis.document = {
    head,
    createElement: (tag) => ({ tagName: tag, id: "", textContent: "" }),
    getElementById: (id) => children.find((el) => el.id === id) ?? null,
  };
  return { storage, children };
}

test("init script: computes the same as the function; invalid, empty and default create nothing", () => {
  for (const value of [undefined, "", "rot", "#12345", "#1f57f7", "1F57F7", "#ggg000"]) {
    const { children } = mocks(value);
    new Function(ACCENT_INIT_SCRIPT)();
    assert.equal(children.length, 0, `stored ${JSON.stringify(value)}`);
  }
  for (const value of ["#e11d48", "e11d48", "#FC0", "#ffffff", "#000000"]) {
    const { children } = mocks(value);
    new Function(ACCENT_INIT_SCRIPT)();
    assert.equal(children.length, 1, value);
    assert.equal(children[0].tagName, "style");
    assert.equal(children[0].id, ACCENT_STYLE_ID);
    assert.equal(children[0].textContent, accentCss(deriveAccent(value)), value);
  }
});

test("saving: normalizes; the default and invalid values clear storage and style", () => {
  const { storage, children } = mocks(undefined);
  assert.equal(getAccent(), null);
  setAccent("#E11D48");
  assert.equal(storage.get(ACCENT_KEY), "#e11d48");
  assert.equal(getAccent(), "#e11d48");
  assert.equal(children.length, 1);
  setAccent("#0f766e");
  assert.equal(children.length, 1, "the same element is replaced, no second one appended");
  assert.equal(children[0].textContent, accentCss(deriveAccent("#0f766e")));
  setAccent("1f57f7");
  assert.equal(storage.has(ACCENT_KEY), false, "cobalt is not a choice");
  assert.equal(children.length, 0);
  setAccent("#0f766e");
  setAccent("broken");
  assert.equal(storage.has(ACCENT_KEY), false);
  assert.equal(children.length, 0);
  storage.set(ACCENT_KEY, "broken");
  assert.equal(getAccent(), null, "an invalid stored value reads as the default");
  // xterm: without a choice the theme stays untouched, with a choice cursor and selection take the accent.
  const theme = { cursor: "#1f57f7", selectionBackground: "rgba(31,87,247,0.22)", blue: "#1f57f7" };
  assert.equal(xtermWithAccent(theme, "light", null), theme);
  const x = xtermWithAccent(theme, "dark", "#e11d48");
  assert.equal(x.cursor, deriveAccent("#e11d48").dark.accent);
  assert.equal(x.selectionBackground, x.cursor + "4d");
  assert.equal(x.blue, "#1f57f7", "the ANSI color stays");
});
