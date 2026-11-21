// No `:has()` without a subject in the web client's styles.
//
// Why: the rule `:has(> [data-lower-panel][data-maximized]) > :not(…)` in globals.css had no subject (universal), so Chrome
// recomputed styles after EVERY insertion anywhere in the document: a probe node in `.cm-content` + `getComputedStyle` cost 8.5 ms
// (0.41 ms without the rule, 0.01 ms without any `:has`). The minimap (@replit/codemirror-minimap `getFontInfo`) inserts such a
// probe node per token kind while drawing, so every file click caused 3-4 long tasks (about 440 ms). Today the column carries the
// attribute itself (`data-panel-maximized`, CodePane via `panelMaximized` from lib/panel-layout.ts).
//
// (1) Every `:has(` in the styles (CSS files under web/src, strings in .ts/.tsx — the CodeMirror themes) belongs to a compound
//     selector WITH a subject (class, attribute, id, element or `&`), never one that starts with `:has(`/`*:has(`.
// (2) The rule for the maximized panel is an attribute on the column; column and panel ask ONE computation (`panelMaximized`).
// Counter-tests built in: the old rule back, a `*:has(` in a theme, a `:has(` behind a comma, the column without the attribute,
// the panel with its own condition — each must break a check.
//
// Run:  node --test --test-reporter=tap web/test/style-has.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, "..", "src");
const read = (...p) => fs.readFileSync(path.join(src, ...p), "utf8");

function files(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...files(p));
    else if (/\.(css|ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

/** The style texts of a file: CSS without comments; in .ts/.tsx only the string literals ("…", '…', `…`). */
function styleTexts(name, text) {
  const withoutBlock = text.replace(/\/\*[\s\S]*?\*\//g, "");
  if (name.endsWith(".css")) return [withoutBlock];
  const without = withoutBlock.replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
  return [...without.matchAll(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g)].map((m) => m[0].slice(1, -1));
}

/** The `:has(` sites without a subject: the top-level compound selector that `:has(` belongs to — inside a parenthesis
 *  (`x:is(…, :has(…))`) the one carrying the outermost parenthesis — starts with `:` or `*`. */
export function withoutSubject(text) {
  const findings = [];
  let i = -1;
  while ((i = text.indexOf(":has(", i + 1)) >= 0) {
    // The outermost open parenthesis before `:has(` (up to the start of the rule).
    let start = i, t = 0;
    for (let k = i - 1; k >= 0; k--) {
      const c = text[k];
      if (c === "{" || c === "}" || c === ";") break;
      if (c === ")") t++;
      else if (c === "(") { if (t === 0) start = k; else t--; }
    }
    // From there backwards to the start of the compound selector (skipping parentheses).
    let j = start; t = 0;
    while (j > 0) {
      const c = text[j - 1];
      if (c === ")" || c === "]") t++;
      else if (c === "(" || c === "[") { if (t === 0) break; t--; }
      else if (t === 0 && /[\s,>+~{}]/.test(c)) break;
      j--;
    }
    if (/^[:*]/.test(text.slice(j))) findings.push(text.slice(j, i + 40).replace(/\s+/g, " "));
  }
  return findings;
}

const CHECKS = {
  stile(q) {
    const findings = [];
    for (const [name, text] of Object.entries(q.files)) for (const s of styleTexts(name, text)) for (const f of withoutSubject(s)) findings.push(`${name}: ${f}`);
    assert.deepEqual(findings, [], "`:has()` without subject — every insertion in the document recomputes the styles");
  },
  panel(q) {
    assert.ok(q.css.includes("[data-panel-maximized] > :not([data-lower-panel]):not([data-editor-status-bar]) { display: none; }"), "maximized does not hide the siblings");
    assert.ok(q.pane.includes("data-panel-maximized={panelMaximized(lay.state) ? \"\" : undefined}"), "the column does not derive the attribute from `panelMaximized`");
    assert.ok(q.panel.includes("data-maximized={panelMaximized(state) ? \"\" : undefined}"), "the panel asks its own condition");
    assert.ok(!/state\.maximized\s*&&\s*(state\.)?open/.test(q.panel), "the panel computes \"maximized\" itself");
    assert.ok(q.layout.includes("export const panelMaximized = (s: PanelState): boolean => s.maximized && s.open;"), "panelMaximized is missing or computes differently");
  },
};

const all = Object.fromEntries(files(src).map((p) => [path.relative(src, p), fs.readFileSync(p, "utf8")]));
const Q = { files: all, css: read("app", "globals.css"), pane: read("components", "CodePane.tsx"), panel: read("components", "code", "panel", "LowerPanel.tsx"), layout: read("lib", "panel-layout.ts") };
const CSS = path.join("app", "globals.css");
const THEME = path.join("components", "code", "codeTheme.ts");

const SABOTAGES = {
  "old rule back": { field: "files", file: CSS, old: "[data-panel-maximized] > :not(", fresh: ":has(> [data-lower-panel][data-maximized]) > :not(", catches: "stile" },
  "universal in the theme": { field: "files", file: THEME, old: "\".cm-panels-top:has(> .cm-search-wrapper)\"", fresh: "\"*:has(> .cm-search-wrapper)\"", catches: "stile" },
  "behind a comma": { field: "files", file: CSS, old: "[data-content-card]:has([data-three-cards]) {", fresh: "[data-content-card], :has([data-three-cards]) {", catches: "stile" },
  "column without attribute": { field: "pane", old: " data-panel-maximized={panelMaximized(lay.state) ? \"\" : undefined}", fresh: "", catches: "panel" },
  "panel with own condition": { field: "panel", old: "data-maximized={panelMaximized(state) ? \"\" : undefined}", fresh: "data-maximized={stand.maximized && stand.open ? \"\" : undefined}", catches: "panel" },
  "maximized without open": { field: "layout", old: "s.maximized && s.open;", fresh: "s.maximized;", catches: "panel" },
  "rule gone": { field: "css", old: "[data-panel-maximized] > :not([data-lower-panel]):not([data-editor-status-bar]) { display: none; }", fresh: "", catches: "panel" },
};

test("(1)(2) no `:has()` without subject; the maximized panel as attribute of the column (including counter-tests)", () => {
  for (const [k, p] of Object.entries(CHECKS)) {
    try { p(Q); } catch (e) { throw new Error(`${k}: ${e.message}`); }
  }
  // The check recognises these forms, and only these.
  assert.deepEqual(withoutSubject(":has(> [a]) > :not([b]) { x }").length, 1);
  assert.deepEqual(withoutSubject("a, *:has(.b) {}").length, 1);
  assert.deepEqual(withoutSubject("[a]:is(:hover, :has(:focus-visible), [k]) .p {}"), []);
  assert.deepEqual(withoutSubject(".has-\\[x\\]:has(:focus-visible) {}"), []);
  assert.deepEqual(withoutSubject("& .cm-tooltip:has(> .x)"), []);
  const notCaught = [];
  for (const [name, s] of Object.entries(SABOTAGES)) {
    const text = s.field === "files" ? Q.files[s.file] : Q[s.field];
    assert.equal(text.split(s.old).length, 2, `sabotage "${name}": spot is not there exactly once`);
    const fresh = text.replace(s.old, s.fresh);
    const q = s.field === "files" ? { ...Q, files: { ...Q.files, [s.file]: fresh } } : { ...Q, [s.field]: fresh };
    let caught = false;
    try { CHECKS[s.catches](q); } catch { caught = true; }
    if (!caught) notCaught.push(name);
  }
  assert.deepEqual(notCaught, [], "sabotages that no check catches");
  console.log(`  [style-has] ${Object.keys(Q.files).length} files, ${Object.keys(SABOTAGES).length} sabotages, each caught`);
});
