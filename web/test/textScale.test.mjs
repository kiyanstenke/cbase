// The text scale (web/postcss-text-scale.cjs): every font size of the app follows ONE factor
// (`--cb-text-scale`, set by lib/appearance.ts). The promise only has a path if a NEW size grows
// along by itself; that is what the plugin behind Tailwind in the build is for, and this guard holds it:
//
//  (a) after Tailwind + plugin, globals.css contains NO absolute font size or line height without
//      `--cb-text-scale`, checked with a plain rule of its own (not the plugin's: a checker that
//      asks the thing under test checks nothing);
//  (b) no unitless line height (and nothing relative) was touched, else it would grow twice;
//  (c) a second run is character-identical (idempotent);
//  (d) an unknown absolute form breaks the build (`max(12px,1vw)`), and a file from node_modules
//      stays untouched;
//  (e) `textPx(n)` from lib/appearance.ts yields the same formula as the plugin: two versions, bound;
//  (f) in TSX a `fontSize` appears only as `textPx(…)`/`textCount(…)`, relative (em/%) or as a keyword;
//      every number, every variable and every shorthand `{ fontSize }` is on the named exception list below
//      (printed on every run; an exception without a finding is red); a `lineHeight` is never absolute
//      (px/rem/pt) and never from a variable, since a unitless line height grows with its font;
//  (g) the order in postcss.config.mjs: Tailwind first, the text scale after it.
//
// (a)-(c) run twice: unoptimized like `next dev` and optimized like `next build`; both write
// the same values differently, and the plugin normalizes. Together about 0.5 s.
//
// Run:  node --test web/test/textScale.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const src = path.join(webDir, "src");
const GLOBALS = path.join(src, "app", "globals.css");
const req = createRequire(path.join(webDir, "package.json"));

function load(name) {
  try {
    return req(name);
  } catch (e) {
    throw new Error(`${name} is missing in web/node_modules (npm -C web ci); the text scale cannot be checked without it: ${e.message}`);
  }
}
const postcss = load("postcss");
const tailwind = load("@tailwindcss/postcss");
const ts = load("typescript");
const textScale = req("./postcss-text-scale.cjs");

const PROPS = new Set(["font-size", "line-height", "--tw-leading", "font"]);

function decls(root) {
  const out = [];
  root.walkDecls((d) => {
    if (PROPS.has(d.prop)) out.push({ prop: d.prop, value: d.value, location: d.parent?.selector ?? d.parent?.name ?? "?" });
  });
  return out;
}

// Absolute in the sense of this guard: a px/rem number, a font variable `var(--text-x)` (not its
// `--line-height`) or `var(--spacing)`. Deliberately NOT the plugin's rule.
const ABSOLUTE = /(?:\d)(?:px|rem)\b|var\(--text-(?![\w-]*--line-height)[\w-]+[,)]|var\(--spacing\)/;
// What must never be touched: a number without unit (also inside calc), em/%, var(--leading-...), var(--tw-leading, ...),
// keywords.
const RELATIVE = /^(?:[\d.\s()*/+-]|calc)+$|^-?[\d.]+(?:em|%)$|^var\(--leading-[\w-]+\)$|^var\(--tw-leading,|^[a-z-]+$/;

const runs = new Map();
async function run(optimize) {
  if (runs.has(optimize)) return runs.get(optimize);
  const css = fs.readFileSync(GLOBALS, "utf8");
  const without = await postcss([tailwind({ base: webDir, optimize })]).process(css, { from: GLOBALS });
  const including = await postcss([tailwind({ base: webDir, optimize }), textScale()]).process(css, { from: GLOBALS });
  const r = { without: decls(without.root), including: decls(including.root), css: including.css };
  runs.set(optimize, r);
  return r;
}

for (const optimize of [false, true]) {
  const name = optimize ? "optimized (next build)" : "unoptimized (next dev)";

  test(`(a) ${name}: no absolute font size or line height without --cb-text-scale`, async () => {
    const { including, without } = await run(optimize);
    assert.equal(including.length, without.length, "the plugin added or removed declarations; it may only rewrite values");
    const withoutFactor = including.filter((d) => ABSOLUTE.test(d.value) && !d.value.includes("--cb-text-scale"));
    assert.deepEqual(withoutFactor.map((d) => `${d.location} { ${d.prop}: ${d.value} }`), [],
      "These sizes do NOT grow with the app's text size: the plugin missed them (web/postcss-text-scale.cjs).");
    const rewritten = including.filter((d, i) => d.value !== without[i].value);
    const sizes = rewritten.filter((d) => d.prop === "font-size").length;
    console.log(`  [text scale] ${name}: ${including.length} font declarations, ${rewritten.length} rewritten (${sizes} font sizes)`);
    // Without a single rewrite (a) would be vacuously met, and the plugin would not be running at all.
    assert.ok(sizes >= 20, `only ${sizes} font sizes rewritten: does the plugin run behind Tailwind at all?`);
  });

  test(`(b) ${name}: numbers without unit, em/%, var(--leading-*) and var(--tw-leading, …) stay untouched`, async () => {
    const { including, without } = await run(optimize);
    const touched = [];
    let checked = 0;
    without.forEach((d, i) => {
      const v = d.value.replace(/\s+/g, " ").trim();
      if (d.prop === "font" || !RELATIVE.test(v)) return;
      checked++;
      if (including[i].value !== d.value) touched.push(`${d.location} { ${d.prop}: ${d.value} → ${including[i].value} }`);
    });
    assert.deepEqual(touched, [], "relative is relative: scaled it would grow twice (the font it refers to already grows)");
    assert.ok(checked >= 10, `only ${checked} relative values seen: the probe measures nothing`);
  });

  test(`(c) ${name}: a second run is character-identical`, async () => {
    const { css } = await run(optimize);
    const second = await postcss([textScale()]).process(css, { from: GLOBALS });
    assert.equal(second.css, css, "the plugin is not idempotent: `--cb-text-scale` is inserted twice");
  });
}

test("(d) an unknown absolute form breaks the build; a file from node_modules stays untouched", async () => {
  const own = path.join(src, "app", "sabotage.css");
  for (const css of [
    ".x { font-size: max(12px,1vw) }",
    ".x { font-size: 1vw }",
    ".x { font-size: var(--unknown) }",
    ".x { font-size: calc(1em + 2px) }",
    ".x { line-height: clamp(14px, 2vh, 20px) }",
    ".x { font: small-caption }",
  ]) {
    await assert.rejects(postcss([textScale()]).process(css, { from: own }), /text scale: .*sabotage\.css/, `not rejected: ${css}`);
  }
  // The escape word: whoever inserts the factor themselves may do anything.
  const itself = await postcss([textScale()]).process(".x { font-size: calc(clamp(34px,4.6vw,52px)*var(--cb-text-scale,1)) }", { from: own });
  assert.match(itself.css, /calc\(clamp\(34px,4\.6vw,52px\)\*var\(--cb-text-scale,1\)\)/);
  // node_modules: neither rewritten nor rejected (xterm.css: a third-party update must not break the build).
  const foreign = path.join(webDir, "node_modules", "@xterm", "xterm", "css", "xterm.css");
  const r = await postcss([textScale()]).process(".x { font-size: 1vw } .y { font-size: 12px }", { from: foreign });
  assert.equal(r.css, ".x { font-size: 1vw } .y { font-size: 12px }");
});

test("(e) textPx(n) from lib/appearance.ts is the same formula as the plugin, and the levels are the old chat sizes", async () => {
  // Compile and load appearance.ts (with its sheet shell-bridge.ts): the real module text,
  // no replica. Inside web/node_modules so that `react` resolves (model: appearance.test.mjs).
  const out = fs.mkdtempSync(path.join(webDir, "node_modules", ".text-scale-test-"));
  try {
    for (const file of ["appearance.ts", "shell-bridge.ts"]) {
      const source = fs.readFileSync(path.join(src, "lib", file), "utf8");
      const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
      fs.writeFileSync(path.join(out, file.replace(/\.ts$/, ".js")), js);
    }
    const app = await import(pathToFileURL(path.join(out, "appearance.js")).href);
    for (const n of [8, 9, 10, 10.5, 11.5, 12, 13, 15.5, 19, 28]) {
      const plugin = textScale.declaration("font-size", `${n}px`);
      assert.ok(plugin?.value, `the plugin does not rewrite font-size: ${n}px`);
      assert.equal(app.textPx(n), plugin.value, `textPx(${n}) and the plugin compute differently`);
    }
    assert.equal(app.TEXT_LOWER_LIMIT + "px", textScale.LOWER_LIMIT, "the lower limit is the same in both versions");
    // The factors: exactly the old chat levels (px) divided by 15.5, so whoever moved over keeps chat prose to the pixel.
    assert.deepEqual(app.TEXT_LEVELS.map((s) => s.key), ["compact", "small", "normal", "large", "veryLarge"]);
    assert.deepEqual(app.TEXT_LEVELS.map((s) => Math.round(s.factor * 15.5 * 1000) / 1000), [13.5, 14.5, 15.5, 17, 19]);
    // The lower limit only applies below 1: Compact keeps 10 px at 9, leaves 8 px alone; at 1 exactly n.
    assert.equal(app.textCount(10, "compact"), 9);
    assert.equal(app.textCount(8, "compact"), 8);
    assert.equal(app.textCount(12, "normal"), 12);
    assert.equal(app.textCount(12, "veryLarge"), Math.round(12 * 19 / 15.5));
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

// ── (f) Inline font sizes and line heights in TSX ───────────────────────────────────────────────
// What the plugin does not see: style objects (CodeMirror themes, `style={{ fontSize }}`), numbers for
// xterm, SVG attributes. A `fontSize` goes through `textPx(…)` (CSS value) or `textCount(…)` (number), is
// relative ("0.9em", "90%") or a keyword ("inherit"); everything else is listed here with a reason. That
// includes variables (`fontSize: size`, the shorthand `{ fontSize }`, a template): the guard cannot see where their value
// comes from, so someone must have written it down. A `lineHeight` is unitless
// (grows with its font), relative or a keyword; absolute (px/rem/pt) or from a
// variable it would stay put while the text inside grows, and lines would overlap.
const EXCEPTIONS = [
  { file: "components/settings/SettingsKit.tsx", value: "Math.max(10, Math.round(size * 0.25))",
    reason: "Ring: the number in the middle follows the diameter of the ring (fixed geometry), not the text size" },
  { file: "components/McpIcon.tsx", value: "\"15\"",
    reason: "SVG <text> in the 24 viewBox of an icon; icons stay" },
  { file: "lib/code-settings.ts", value: "EDITOR_FONT_SIZE",
    reason: "Default of the code setting \"font size\" (12 as VS Code on the Mac, lib/editor-defaults.ts; size at 100 %); the style computes `textPx(px)` (codeTheme.ts fontSize)" },
  { file: "components/CodePane.tsx", value: "Math.max(9, Math.min(28, Number(e.target.value) || EDITOR_FONT_SIZE))",
    reason: "Value range of the code setting (9…28 px at 100 %), not a style" },
  { file: "components/code/codeTheme.ts", value: "\"var(--cb-line-height, 1.5)\"",
    reason: "Line factor of the editor WITHOUT unit (1.5 as VS Code, lib/editor-defaults.ts), set as a variable on the editor; grows with the font" },
  { file: "components/code/lsp-theme.ts", value: "\"var(--cb-line-height, 1.5)\"",
    reason: "the same unitless line factor for suggestion list, parameter hints and rename field (lines as tall as in the editor)" },
  { file: "components/MarkdownEditor.tsx", value: "`${fontSize} !important`",
    reason: "Pass-through of the prop `fontSize` into the CodeMirror theme: the callers give `textPx(n)`, and their JSX attribute `fontSize=` is itself under this guard" },
  { file: "components/code/FileSymbol.tsx", value: "large",
    reason: "SVG <text> in the 16 viewBox of the file icon (abbreviations like TS/JS, size by length); icons stay as with Seti" },
  { file: "components/code/FileSymbol.tsx", value: "\"9.5\"",
    reason: "SVG <text> {} and <> in the 16 viewBox of the file icon; icons stay" },
  { file: "components/code/FileSymbol.tsx", value: "\"6.5\"",
    reason: "SVG <text> PDF in the 16 viewBox of the file icon; icons stay" },
];

const HELPER = /^text(?:Px|Count)\(/;
const RELATIVE_LITERAL = /^["'`]-?[\d.]+(?:em|%)["'`]$/;
const KEYWORD = /^["'`][a-z-]+["'`]$/;
const WITHOUT_UNIT = /^(?:["'`]-?[\d.]+["'`]|-?[\d.]+)$/;

/** The inline findings of a source file: `{ prop, value, row }` for every `fontSize`/`lineHeight` that
 *  does not grow with the text size by itself. Exported only in this file, for the counter-test. */
function inlineFindings(rel, text) {
  const findings = [];
  if (!/fontSize|lineHeight/.test(text)) return findings;
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const PROPS = ["fontSize", "lineHeight"];
  const visits = (n) => {
    let prop = null;
    let value = null;
    if (ts.isPropertyAssignment(n) && (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name)) && PROPS.includes(n.name.text)) {
      prop = n.name.text;
      value = n.initializer;
    } else if (ts.isShorthandPropertyAssignment(n) && PROPS.includes(n.name.text)) {
      prop = n.name.text;
      value = n.name;
    } else if (ts.isJsxAttribute(n) && PROPS.includes(n.name.getText(sf)) && n.initializer) {
      prop = n.name.getText(sf);
      value = ts.isJsxExpression(n.initializer) ? n.initializer.expression : n.initializer;
    }
    if (prop && value) {
      const t = value.getText(sf).replace(/\s+/g, " ");
      const ok = prop === "fontSize"
        ? HELPER.test(t) || RELATIVE_LITERAL.test(t) || KEYWORD.test(t)
        : HELPER.test(t) || RELATIVE_LITERAL.test(t) || KEYWORD.test(t) || WITHOUT_UNIT.test(t);
      if (!ok) findings.push({ file: rel, prop, value: t, row: sf.getLineAndCharacterOfPosition(value.getStart(sf)).line + 1 });
    }
    ts.forEachChild(n, visits);
  };
  visits(sf);
  return findings;
}

function tsxFiles() {
  return fs.readdirSync(src, { recursive: true })
    .map((p) => String(p).split(path.sep).join("/"))
    .filter((p) => /\.(ts|tsx)$/.test(p))
    .sort();
}

test("(f) counter-test: the inline checker finds every form that does not grow along, and leaves the growing ones alone", () => {
  // Without this probe, a checker that never finds anything would be just as green as one with nothing to find.
  const values = (code) => inlineFindings("probe.tsx", code).map((f) => `${f.prop}=${f.value}`);
  assert.deepEqual(values('<p style={{ fontSize: 13 }} />'), ["fontSize=13"]);
  assert.deepEqual(values('<p style={{ fontSize: "12px" }} />'), ['fontSize="12px"']);
  assert.deepEqual(values("<p style={{ fontSize: size }} />"), ["fontSize=size"]);
  assert.deepEqual(values("const s = { fontSize }; <p style={{ fontSize }} />"), ["fontSize=fontSize", "fontSize=fontSize"]);
  assert.deepEqual(values("<p style={{ fontSize: `${n}px` }} />"), ["fontSize=`${n}px`"]);
  assert.deepEqual(values('<p style={{ lineHeight: "18px" }} />'), ['lineHeight="18px"']);
  assert.deepEqual(values("<p style={{ lineHeight: `${h}rem` }} />"), ["lineHeight=`${h}rem`"]);
  assert.deepEqual(values("<p style={{ lineHeight: height }} />"), ["lineHeight=height"]);
  assert.deepEqual(values('<text fontSize="15" />'), ['fontSize="15"']);
  // What grows along: the helper, relative, keyword, unitless line height.
  assert.deepEqual(values('<p style={{ fontSize: textPx(13), lineHeight: "1.6" }} />'), []);
  assert.deepEqual(values('const t = { fontSize: textCount(12), lineHeight: 1.5 }; const u = { fontSize: "0.9em", lineHeight: "normal" };'), []);
  assert.deepEqual(values('<p style={{ fontSize: "inherit", lineHeight: "120%" }} />'), []);
});

test("(f) TSX: fontSize only via textPx/textCount (or relative), lineHeight never absolute; otherwise named as an exception", () => {
  const findings = [];
  for (const rel of tsxFiles()) findings.push(...inlineFindings(rel, fs.readFileSync(path.join(src, rel), "utf8")));
  const isException = (f) => EXCEPTIONS.some((a) => a.file === f.file && a.value === f.value);
  const violations = findings.filter((f) => !isException(f));
  for (const a of EXCEPTIONS) console.log(`  [text scale] exception ${a.file}: ${a.value} — ${a.reason}`);
  assert.deepEqual(violations.map((f) => `${f.file}:${f.row} ${f.prop} ${f.value}`), [],
    "These sizes do NOT grow with the app's text size: compute a font via `textPx(n)` (CSS value, takes effect live) or " +
      "`textCount(n)` (number, e.g. xterm; then listen to TEXT_SIZE_EVENT) from lib/appearance.ts, write a " +
      "line height without unit, or list it in EXCEPTIONS with a reason.");
  const dead = EXCEPTIONS.filter((a) => !findings.some((f) => f.file === a.file && f.value === a.value));
  assert.deepEqual(dead.map((a) => `${a.file}: ${a.value}`), [],
    "An exception without a finding: the occasion is gone, so the line should go too.");
});

test("(g) postcss.config.mjs: Tailwind first, the text scale afterwards", async () => {
  const cfg = (await import(pathToFileURL(path.join(webDir, "postcss.config.mjs")).href)).default;
  assert.deepEqual(Object.keys(cfg.plugins), ["@tailwindcss/postcss", "./postcss-text-scale.cjs"],
    "before Tailwind the plugin would see not a single `text-[…]` class; if it is missing, no size grows along");
});
