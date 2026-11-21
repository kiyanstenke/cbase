"use client";

import { useSyncExternalStore } from "react";

// ── Appearance: the accent colour ────────────────────────────────────────────────────────────
//
// A device preference like colour scheme and text size: it lives in localStorage, never goes to the
// server and takes effect before the first paint (init script). The user picks ONE colour via a
// colour picker; the four values are DERIVED from it, in OKLCH — hue and chroma stay, only the
// lightness is shifted per theme. Two independent choices for light and dark would never have
// matched. The rules are read off the cobalt (#1f57f7 / #e4ebfe light, #4d89ff / #1f2d45 dark), so
// its derivation hits the fixed values to within a hair.
//
// The promise: on EVERY surface of the app the accent as text is NEVER weaker than the cobalt on the
// same surface — hence ≥ 4.5 : 1 wherever the cobalt reaches 4.5 : 1. Computing only against white and
// #181818 is not enough: on the ground #eeece6, on menus (#2d2d2d), in the composer (#363636) and on
// its own tinted surface a choice fell to 3.1 : 1 where the cobalt has 3.6–4.7. Because in light mode
// EVERY surface is lighter than the accent and in dark mode EVERY one darker, the promise is a limit
// on luminance:
//
//   light  accent  = the choice itself — only if it is lighter than the cobalt #1f57f7 is it pulled
//                    darker until it no longer is. So white text on it, too, is as with the cobalt
//                    (5.58 : 1). The border (#dfe3e9: cobalt 4.33) allows no lighter limit.
//   dark   accent  = the choice a quarter of the way towards white, chroma kept (clamped in sRGB) —
//                    cobalt L 0.533 → 0.650, the step of #4d89ff. Then clamped to a luminance BAND:
//                    never darker than #4d89ff (0.267), and white text on it ≥ 3 : 1 (≤ 0.295; the
//                    dark cobalt has 3.31). The band is narrow but solvable for every hue.
//   Surfaces (accent-soft) have the lightness of the fixed ones (L 0.940 light, 0.297 dark) and the
//   hue of the choice, chroma in the same ratio as with the cobalt — and where necessary are pulled
//   lighter (light) or darker (dark) until the accent as text on them is no weaker than the cobalt
//   on its own (4.68 light, 4.17 dark).
//   NOT part of the promise: surfaces translucently tinted with the accent itself (`bg-accent/10` …
//   `/20`, `cb-kit-pane-accent`). There a choice lies up to 0.3 below the cobalt (light `accent/12`
//   on white 4.47 instead of 4.68) — its tone tints the surface too.
//
// Why a clamp instead of dark text on light accents: the app writes `text-white` on `bg-accent` in
// about 45 places (web and iOS) and `text-accent` on surfaces in about 200 — buttons, counters,
// checks, links, markers. Clamping the colour keeps ALL of them readable without touching a single
// place, and every future one too. The price: a very light yellow appears as gold in dark mode and as
// olive in light mode; every choice has almost the luminance of the cobalt in dark mode. The iOS app
// computes the same rules (Kit/AccentColor.swift).
//
// Applied through ONE `<style id="cb-accent">` in the <head> that overrides the three variables per
// theme. Its selectors deliberately carry more weight than those in globals.css (`:root:root` >
// `:root`, `:root:root[data-theme="dark"]` > `:root[data-theme="dark"]`) — otherwise the order of
// the stylesheets in the <head> would decide, and Next may change that. With no choice the element
// does not exist: then the fixed values from globals.css apply BYTE-FOR-BYTE.

export const ACCENT_KEY = "cbase-accent";
/** Cobalt — the default. Choosing it means: no choice (nothing stored, no style). */
export const ACCENT_DEFAULT = "#1f57f7";
export const ACCENT_STYLE_ID = "cb-accent";

/** The presets. `label` is the English i18n key. In light mode each is its own accent (not lighter
 *  than the cobalt) — teal, green, amber and rose are shown as the clamp pulls them, not as the raw
 *  hexes. */
export const ACCENT_DEFAULTS: { hex: string; label: string }[] = [
  { hex: ACCENT_DEFAULT, label: "Default" },
  { hex: "#483ce4", label: "Indigo" }, // the former accent
  { hex: "#7c3aed", label: "Violet" },
  { hex: "#0b746d", label: "Teal" },
  { hex: "#037836", label: "Green" },
  { hex: "#aa4c00", label: "Amber" },
  { hex: "#d0003d", label: "Rose" },
  { hex: "#52525b", label: "Graphite" },
];

export type AccentRoles = { accent: string; soft: string };
export type AccentDerivation = { base: string; light: AccentRoles; dark: AccentRoles };

/**
 * The derivation. Returns `null` for invalid input — anything but `#rgb`/`#rrggbb` (the `#` may be
 * missing) is invalid, and invalid means "default" everywhere.
 *
 * CAUTION: this function and `accentCss` are copied into the init script via `toString()`
 * (`ACCENT_INIT_SCRIPT`). They must therefore use NOTHING from outside their body — no module
 * constant, no helper function, only `Math`, `parseInt` and their parameters — and only language
 * features the bundler does not turn into helper functions (no `?.`, `??`, spread).
 * web/test/accent.test.mjs runs the init script and compares it with this computation.
 */
export function deriveAccent(input: unknown): AccentDerivation | null {
  if (typeof input !== "string") return null;
  var hits = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(input.trim());
  if (!hits) return null;
  var h = hits[1].toLowerCase();
  if (h.length === 3) h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
  var base = "#" + h;
  var lin = function (c: number) { return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  var gam = function (c: number) { return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; };
  var lum = function (hex: string) {
    var x = parseInt(hex.slice(1), 16);
    return 0.2126 * lin(((x >> 16) & 255) / 255) + 0.7152 * lin(((x >> 8) & 255) / 255) + 0.0722 * lin((x & 255) / 255);
  };
  // sRGB → OKLab (Björn Ottosson)
  var n = parseInt(h, 16);
  var r = lin(((n >> 16) & 255) / 255), g = lin(((n >> 8) & 255) / 255), b = lin((n & 255) / 255);
  var l1 = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  var m1 = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  var s1 = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  var L0 = 0.2104542553 * l1 + 0.793617785 * m1 - 0.0040720468 * s1;
  var A0 = 1.9779984951 * l1 - 2.428592205 * m1 + 0.4505937099 * s1;
  var B0 = 0.0259040371 * l1 + 0.7827717662 * m1 - 0.808675766 * s1;
  var C0 = Math.sqrt(A0 * A0 + B0 * B0);
  if (C0 < 0.002) C0 = 0; // grey: the hue would be noise
  var hue = Math.atan2(B0, A0);
  // OKLCH → linear sRGB, unclamped
  var linRgb = function (L: number, C: number) {
    var a = C * Math.cos(hue), bb = C * Math.sin(hue);
    var l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * bb, 3);
    var m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * bb, 3);
    var s = Math.pow(L - 0.0894841775 * a - 1.291485548 * bb, 3);
    return [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    ];
  };
  var inside = function (v: number[]) {
    return v[0] >= -1e-7 && v[0] <= 1 + 1e-7 && v[1] >= -1e-7 && v[1] <= 1 + 1e-7 && v[2] >= -1e-7 && v[2] <= 1 + 1e-7;
  };
  // The colour at L and C — if it lies outside sRGB, the chroma is reduced.
  var color = function (L: number, C: number) {
    var v = linRgb(L, C);
    if (inside(v)) return v;
    var lo = 0, hi = C;
    for (var i = 0; i < 22; i++) {
      var mid = (lo + hi) / 2;
      if (inside(linRgb(L, mid))) lo = mid; else hi = mid;
    }
    return linRgb(L, lo);
  };
  var hex = function (v: number[]) {
    var s = "#";
    for (var i = 0; i < 3; i++) {
      var k = Math.round(Math.min(1, Math.max(0, gam(Math.min(1, Math.max(0, v[i]))))) * 255);
      s += (k < 16 ? "0" : "") + k.toString(16);
    }
    return s;
  };
  // Shift L until the luminance of the ROUNDED value lies in the band [lower, upper] (bisection;
  // luminance rises with L). The rounded value is compared, i.e. exactly the one that is shipped —
  // the edges need no rounding margin.
  var clamp = function (L: number, C: number, bottom: number, top: number) {
    var x = hex(color(L, C)), y = lum(x), lo = 0, hi = 1, i = 0, mid = 0;
    if (y > top) {
      lo = 0; hi = L;
      for (i = 0; i < 26; i++) { mid = (lo + hi) / 2; if (lum(hex(color(mid, C))) > top) hi = mid; else lo = mid; }
      return hex(color(lo, C));
    }
    if (y < bottom) {
      lo = L; hi = 1;
      for (i = 0; i < 26; i++) { mid = (lo + hi) / 2; if (lum(hex(color(mid, C))) < bottom) lo = mid; else hi = mid; }
      return hex(color(hi, C));
    }
    return x;
  };
  // The limits are the cobalt's — its fixed values from globals.css, here as literals (nothing from
  // outside the body; web/test/accent.test.mjs holds them against ACCENT_DEFAULT_VALUES).
  // `tLight`/`tDark`: contrast of the cobalt as text on its surface.
  var kLight = lum("#1f57f7"), kDark = lum("#4d89ff");
  var tLight = (lum("#e4ebfe") + 0.05) / (kLight + 0.05), tDark = (kDark + 0.05) / (lum("#1f2d45") + 0.05);
  // 0.295: white text on the dark accent ≥ 3 : 1 (⇔ ≤ 0.30), with margin.
  var lightAccent = lum(base) <= kLight ? base : clamp(L0, C0, 0, kLight);
  var darkAccent = clamp(L0 + (1 - L0) * 0.25, C0, kDark, 0.295);
  return {
    base: base,
    light: {
      accent: lightAccent,
      soft: clamp(0.9404, C0 * 0.1095, tLight * (lum(lightAccent) + 0.05) - 0.05, 1),
    },
    dark: {
      accent: darkAccent,
      soft: clamp(0.2967, C0 * 0.1957, 0, (lum(darkAccent) + 0.05) / tDark - 0.05),
    },
  };
}

/** The content of the `<style id="cb-accent">`. Same rule as above: nothing from outside. */
export function accentCss(a: AccentDerivation): string {
  return ":root:root{--color-accent:" + a.light.accent + ";--color-accent-soft:" + a.light.soft + "}" +
    ":root:root[data-theme=\"dark\"]{--color-accent:" + a.dark.accent + ";--color-accent-soft:" + a.dark.soft + "}";
}

/** The fixed values from globals.css — they apply as long as nothing is chosen. A copy for the
 *  colour fields of the settings; web/test/accent.test.mjs holds it against globals.css. */
export const ACCENT_DEFAULT_VALUES: { light: AccentRoles; dark: AccentRoles } = {
  light: { accent: "#1f57f7", soft: "#e4ebfe" },
  dark: { accent: "#4d89ff", soft: "#1f2d45" },
};

/** What REALLY applies for a choice in both themes — for the default the fixed values, not their
 *  derivation (which only hits them to within a hair). */
export function accentValues(hex: string | null): { light: AccentRoles; dark: AccentRoles } {
  const a = deriveAccent(hex);
  return !a || a.base === ACCENT_DEFAULT ? ACCENT_DEFAULT_VALUES : a;
}

/** `#rrggbb` in lower case, or `null` for anything invalid. */
export function normAccent(input: unknown): string | null {
  const a = deriveAccent(input);
  return a ? a.base : null;
}

// Inline script for layout.tsx: creates the style element BEFORE the first paint (same build as
// THEME_INIT_SCRIPT). An invalid or missing value and the default create nothing.
export const ACCENT_INIT_SCRIPT =
  "(function(){try{var a=(" + deriveAccent.toString() + ")(localStorage.getItem('" + ACCENT_KEY + "'));" +
  "if(!a||a.base==='" + ACCENT_DEFAULT + "')return;var s=document.createElement('style');s.id='" + ACCENT_STYLE_ID + "';" +
  "s.textContent=(" + accentCss.toString() + ")(a);document.head.appendChild(s);}catch(e){}})();";

/** The stored choice — `null` means default (nothing stored, invalid or cobalt). */
export function getAccent(): string | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const v = normAccent(localStorage.getItem(ACCENT_KEY));
    return v === ACCENT_DEFAULT ? null : v;
  } catch {
    return null;
  }
}

/** Set, replace or — for the default — remove the style element. */
export function applyAccent(hex: string | null) {
  if (typeof document === "undefined") return;
  const a = deriveAccent(hex);
  const old = document.getElementById(ACCENT_STYLE_ID);
  if (!a || a.base === ACCENT_DEFAULT) {
    old?.remove();
    return;
  }
  const el = old ?? document.createElement("style");
  el.id = ACCENT_STYLE_ID;
  el.textContent = accentCss(a);
  if (!old) document.head.appendChild(el);
}

const listeners = new Set<() => void>();
function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Store + apply. `null`, invalid or cobalt means: back to the default. */
export function setAccent(hex: string | null) {
  const v = normAccent(hex);
  const choice = v === ACCENT_DEFAULT ? null : v;
  try {
    if (choice) localStorage.setItem(ACCENT_KEY, choice);
    else localStorage.removeItem(ACCENT_KEY);
  } catch {
    /* private mode or similar — then only for this session */
  }
  applyAccent(choice);
  listeners.forEach((fn) => fn());
}

/** Reactive choice. The server snapshot is the default (like the prerendered HTML). */
export function useAccent(): string | null {
  return useSyncExternalStore(subscribe, getAccent, () => null);
}

/** The accent that REALLY applies in a theme — for places that cannot read a CSS variable (xterm
 *  draws on a canvas). With no choice `null`: then their own values stay. */
export function accentFor(hex: string | null, mode: "light" | "dark"): string | null {
  const a = deriveAccent(hex);
  if (!a || a.base === ACCENT_DEFAULT) return null;
  return mode === "dark" ? a.dark.accent : a.light.accent;
}

/** Dip an xterm theme's cursor and selection into the chosen accent (opacity as before: 0.22 light,
 *  0.30 dark). Without a choice the theme comes back unchanged. */
export function xtermWithAccent(theme: Record<string, string>, mode: "light" | "dark", hex: string | null): Record<string, string> {
  const color = accentFor(hex, mode);
  if (!color) return theme;
  return { ...theme, cursor: color, selectionBackground: color + (mode === "dark" ? "4d" : "38") };
}
