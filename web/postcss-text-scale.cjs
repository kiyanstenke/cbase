// ── Text scale: every font size in the app follows ONE factor ───────────────────────────────────
//
// The text-size setting writes the factor as `--cb-text-scale` on <html> (lib/appearance.ts; at "Normal"
// nothing is set and the fallback 1 below applies). This plugin inserts it AT BUILD TIME into every font
// size the app has, including any someone writes tomorrow as `text-[13px]`. So there is no helper to
// remember: a new size scales by itself, and a form the plugin does not know breaks the build.
//
// It runs AFTER Tailwind (postcss.config.mjs, second key). The order is load-bearing: before Tailwind it
// would only see `@import "tailwindcss"` and the handwritten rules, not a single `text-[…]` class.
//
// Why no `zoom` and no rem: `zoom` shifts the measured block heights of the memory brake (lib/contain)
// and puts `fixed` menus next to their trigger; rem would mean rewriting 1,527 classes and would scale
// every spacing too. Here only the TEXT grows: spacing, icons and fixed heights stay, and the ratio of
// two sizes stays exactly the same.
//
// The rules:
//  · `font-size` with an absolute value (px, rem, pt…, `var(--text-*)` or calc/min/max/clamp of those)
//    becomes  max(min(V, 9px), calc(V * var(--cb-text-scale, 1)))
//    The lower bound only matters for a factor < 1: 10 px does not fall to 8.7 px at "Compact", and
//    anything already under 9 px does not shrink at all. At factor 1 the result is exactly V.
//  · `line-height` and `--tw-leading` with px, rem or `calc(var(--spacing) * N)` become
//    calc(V * var(--cb-text-scale, 1)) — without a lower bound. Otherwise lines would overlap as soon
//    as the text grows while the line height stays in px.
//  · In the `font` shorthand (the body: `15px/1.55 …`) the same two rules apply to size and line
//    height; the family stays.
//  · Left unchanged: em, %, unitless numbers, keywords, `var(--leading-*)`, `var(--text-*--line-height)`,
//    `var(--tw-leading, …)` and anything that already contains `--cb-text-scale` (so a second run is
//    character-identical). A unitless number is NEVER touched: it is relative to its own font and
//    would otherwise grow twice.
//  · An absolute form no rule knows — viewport units (`1vw`, `max(12px, 1vw)`), a foreign `var(…)`, a
//    size keyword such as `small`, px mixed with em — is a BUILD ERROR with file and value. Whoever
//    really needs one writes the factor in themselves (`calc(… * var(--cb-text-scale, 1))`); the
//    plugin leaves that alone.
//
// Only files outside node_modules. In an unbuilt run (`next dev`, Tailwind without optimisation) ALL
// utility declarations carry `node_modules/tailwindcss/index.css` as their source, so a per-declaration
// check would skip every `text-[…]` class there. What counts is therefore the file being processed (the
// root): xterm.css comes in as its own root from node_modules and stays untouched, so a third-party
// update there cannot break the strict mode.
//
// `next dev` and `next build` write the same values differently (`calc(var(--spacing) * 5)` vs
// `calc(var(--spacing)*5)`, `var(--a, var(--b))` vs `var(--a,var(--b))`). The normalised form is
// therefore what is compared and written — the result is the same in both runs.
//
// Latch: web/test/textScale.test.mjs (Tailwind + this plugin over globals.css, both runs). The runtime
// counterpart is `textPx()` in lib/appearance.ts — the same formula as a string for inline styles
// (CodeMirror), bound in the same test.
"use strict";

const SCALE = "var(--cb-text-scale, 1)";
const LOWER_LIMIT = "9px";

const GLOBAL = new Set(["inherit", "initial", "unset", "revert", "revert-layer"]);
const SIZE_RELATIVE = new Set(["smaller", "larger"]);
const SYSTEM_FONT = new Set(["caption", "icon", "menu", "message-box", "small-caption", "status-bar"]);
const UNIT_ABSOLUTE = new Set(["px", "rem", "pt", "pc", "in", "cm", "mm", "q"]);
const UNIT_RELATIVE = new Set(["em", "%", "ex", "ch", "cap", "ic", "lh"]);
const FUNCTIONS = new Set(["calc", "min", "max", "clamp"]);

/** Normalise whitespace: one space after each comma, none inside parentheses, `*` and `/` with
 *  spaces. `+`/`-` need spaces in calc anyway and stay as they are. */
function normalize(value) {
  return String(value)
    .replace(/\s+/g, " ")
    .replace(/\s*,\s*/g, ", ")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .replace(/\s*\*\s*/g, " * ")
    .replace(/\s*\/\s*/g, " / ")
    .trim();
}

/** The font-size formula — `textPx()` (lib/appearance.ts) produces the same string. */
function scaleSize(v) {
  return `max(min(${v}, ${LOWER_LIMIT}), calc(${v} * ${SCALE}))`;
}
function scaleRow(v) {
  return `calc(${v} * ${SCALE})`;
}

// Cut out var(…) including nested parentheses. Returns the rest with placeholders and the list of
// variable names in order.
function withoutVariables(value) {
  const names = [];
  let rest = "";
  let i = 0;
  while (i < value.length) {
    if (value.startsWith("var(", i) && !/[\w-]/.test(value[i - 1] || "")) {
      let depth = 0;
      let j = i + 3;
      for (; j < value.length; j++) {
        if (value[j] === "(") depth++;
        else if (value[j] === ")") { depth--; if (depth === 0) break; }
      }
      const inside = value.slice(i + 4, j);
      const name = inside.split(",")[0].trim();
      names.push(name);
      rest += " §V ";
      i = j + 1;
    } else {
      rest += value[i];
      i++;
    }
  }
  return { rest, names };
}

/**
 * What is this value? `kind` = "size" (font-size) or "row" (line-height, --tw-leading).
 * Returns { verdict: "absolute" | "leave" | "error", reason? }.
 */
function verdict(valueRaw, kind) {
  const v = normalize(valueRaw);
  const small = v.toLowerCase();
  if (v.includes("--cb-text-scale")) return { verdict: "leave" };
  if (GLOBAL.has(small)) return { verdict: "leave" };
  if (kind === "row" && small === "normal") return { verdict: "leave" };
  if (kind === "size" && SIZE_RELATIVE.has(small)) return { verdict: "leave" };
  if (/^[a-z-]+$/.test(small)) return { verdict: "error", reason: `keyword "${v}" (fixed size without factor)` };

  const { rest, names } = withoutVariables(small);
  let abs = 0, rel = 0, withoutUnit = 0, leadVar = 0;
  for (const name of names) {
    if (kind === "row" && name === "--tw-leading") leadVar++;
    else if (/^--text-[\w-]+--line-height$/.test(name)) withoutUnit++;
    else if (/^--leading-[\w-]+$/.test(name)) withoutUnit++;
    else if (/^--text-[\w-]+$/.test(name)) abs++;
    else if (name === "--spacing") abs++;
    else return { verdict: "error", reason: `unknown variable ${name}` };
  }
  // Numbers with their unit; what remains may only be a function name, parenthesis, comma, operator.
  let leftOver = rest.replace(/§V/g, " ");
  const counts = /(^|[^\w.-])([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)([a-z%]*)/g;
  let m;
  while ((m = counts.exec(leftOver))) {
    const unit = m[3];
    if (!unit) withoutUnit++;
    else if (UNIT_ABSOLUTE.has(unit)) abs++;
    else if (UNIT_RELATIVE.has(unit)) rel++;
    else return { verdict: "error", reason: `unit "${unit}" has no rule` };
  }
  leftOver = leftOver.replace(counts, "$1");
  const words = leftOver.match(/[a-z_-][\w-]*/g) || [];
  for (const w of words) {
    if (!FUNCTIONS.has(w)) return { verdict: "error", reason: `"${w}" has no rule` };
  }
  if (/[^\s(),*/+-]/.test(leftOver.replace(/[a-z_-][\w-]*/g, ""))) return { verdict: "error", reason: "character has no rule" };

  if (leadVar) {
    // `var(--tw-leading, …)` is already scaled where `--tw-leading` is set — on its own it stays.
    return names.length === 1 && abs + rel + withoutUnit === 0 && /^\s*§V\s*$/.test(rest)
      ? { verdict: "leave" }
      : { verdict: "error", reason: "var(--tw-leading) inside a calculation" };
  }
  if (abs && rel) return { verdict: "error", reason: "absolute and relative units mixed" };
  if (abs) return { verdict: "absolute" };
  return { verdict: "leave" };
}

/** A value by the rule of its kind — or an error with a reason. */
function rewriteValue(value, kind) {
  const u = verdict(value, kind);
  if (u.verdict === "error") return u;
  if (u.verdict === "leave") return { verdict: "leave", value };
  const v = normalize(value);
  return { verdict: "absolute", value: kind === "size" ? scaleSize(v) : scaleRow(v) };
}

// Split the top level of a shorthand (spaces and `/` outside parentheses and quotes).
function split(value) {
  const parts = [];
  let current = "";
  let depth = 0;
  let quote = "";
  for (const z of value) {
    if (quote) { current += z; if (z === quote) quote = ""; continue; }
    if (z === '"' || z === "'") { quote = z; current += z; continue; }
    if (z === "(") depth++;
    if (z === ")") depth--;
    if (depth === 0 && (z === " " || z === "/")) {
      if (current) parts.push(current);
      current = "";
      if (z === "/") parts.push("/");
      continue;
    }
    current += z;
  }
  if (current) parts.push(current);
  return parts;
}

/** The `font` shorthand: rewrite the size (and the line height after `/`), the rest stays. */
function rewriteShorthand(valueRaw) {
  const v = normalize(valueRaw);
  const small = v.toLowerCase();
  if (v.includes("--cb-text-scale") || GLOBAL.has(small)) return { verdict: "leave", value: valueRaw };
  if (SYSTEM_FONT.has(small)) return { verdict: "error", reason: `system font "${v}" (fixed size without factor)` };
  const parts = split(v);
  // The size is the first member with a unit or calculation — a weight (`700`) before it has none.
  const i = parts.findIndex((t) => /^(?:[+-]?(?:\d+\.?\d*|\.\d+)[a-z%]+|(?:calc|min|max|clamp)\(|var\(--text-)/i.test(t));
  if (i < 0) return { verdict: "error", reason: "no font size found in the shorthand" };
  const size = rewriteValue(parts[i], "size");
  if (size.verdict === "error") return size;
  const out = [...parts];
  out[i] = size.value;
  let changed = size.verdict === "absolute";
  if (parts[i + 1] === "/" && parts[i + 2] != null) {
    const row = rewriteValue(parts[i + 2], "row");
    if (row.verdict === "error") return row;
    out[i + 2] = row.value;
    changed = changed || row.verdict === "absolute";
  }
  return changed ? { verdict: "absolute", value: out.join(" ") } : { verdict: "leave", value: valueRaw };
}

/** Rewrite one declaration; null = unchanged, otherwise { value } or { error }. */
function declaration(prop, value) {
  const p = prop.toLowerCase();
  let r;
  if (p === "font-size") r = rewriteValue(value, "size");
  else if (p === "line-height" || p === "--tw-leading") r = rewriteValue(value, "row");
  else if (p === "font") r = rewriteShorthand(value);
  else return null;
  if (r.verdict === "error") return { error: r.reason };
  if (r.verdict === "leave") return null;
  return { value: r.value };
}

function inNodeModules(file) {
  return typeof file === "string" && /[\\/]node_modules[\\/]/.test(file);
}

const plugin = () => ({
  postcssPlugin: "cbase-text-scale",
  OnceExit(root, { result }) {
    const file = (root.source && root.source.input && root.source.input.file) || result.opts.from || "";
    if (inNodeModules(file)) return;
    root.walkDecls((decl) => {
      const r = declaration(decl.prop, decl.value);
      if (!r) return;
      if (r.error) {
        throw decl.error(
          `text scale: "${decl.prop}: ${decl.value}" (rule ${(decl.parent && (decl.parent.selector || decl.parent.name)) || "?"}) ` +
            `in ${file || "(no file)"} — ${r.error}. ` +
            "A font size must be scalable (px/rem/var(--text-*)) or relative (em/%/number); " +
            "whoever inserts the factor themselves writes var(--cb-text-scale, 1) in it (web/postcss-text-scale.cjs).",
          { word: decl.value },
        );
      }
      decl.value = r.value;
    });
  },
});
plugin.postcss = true;

module.exports = plugin;
// For the latch (web/test/textScale.test.mjs) — the same functions the build uses.
module.exports.declaration = declaration;
module.exports.scaleSize = scaleSize;
module.exports.normalize = normalize;
module.exports.LOWER_LIMIT = LOWER_LIMIT;
