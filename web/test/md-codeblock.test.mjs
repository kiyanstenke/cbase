// Code blocks in the live-preview Markdown editor. A ``` or ~~~ block stands as a BOX like `CodeBlock` in components/Markdown.tsx: no
// visible fences, monospace, tight lines, long lines scroll inside the box.
//
// (1) lib/md-codeblock.ts, EXECUTED (compiled with tsc) against a REAL CodeMirror state with the app's Markdown parser:
//     - read mode: every top-level block is ONE block widget over whole lines, its code without fences and without the fence's
//       indent, the language from the info line, an open block runs to the end;
//     - editing: if the caret is in the block there is no widget but every line (fences included) in the code box, first and last
//       marked; if it is outside, the widget;
//     - a fence in a list or quote stays source text (replacing would eat the "- " / "> ");
//     - the offset of every line (click -> caret) points to its text in the document.
// (2) The binding to the drawing (source text of components/MarkdownEditor.tsx): the field hangs in the editor, "reading" means read
//     mode OR no focus (as with the tables), the box scrolls horizontally inside itself (`white-space: pre`, `overflow-x: auto`,
//     `contain: inline-size` — otherwise the whole editor would scroll), the line height is tight (<= 1.2, the box characters touch),
//     background and border from the tokens `--color-code`/`--color-edge`, the classes from ONE list (CODE_CLASS).
//
// Every sabotage is a copy of the source with ONE changed spot (the spot appears exactly once, otherwise the sabotage is stale); the
// assigned check must fail on it.
//
// Run:  node --test --test-reporter=tap web/test/md-codeblock.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EditorState, Facet } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");
const read = (...p) => fs.readFileSync(path.join(webDir, ...p), "utf8");
const SOURCE = read("src", "lib", "md-codeblock.ts");
const EDITOR = read("src", "components", "MarkdownEditor.tsx");

// ── (1) The calculation ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
const SABOTAGES = {
  "fences in the code": { old: "for (let n = first + 1; n <= (closed ? last - 1 : last); n++) {", fresh: "for (let n = first; n <= last; n++) {", catches: "read" },
  "open block loses the last line": { old: "n <= (closed ? last - 1 : last)", fresh: "n <= last - 1", catches: "open" },
  "language lost": { old: "const language = info ? doc.sliceString(info.from, info.to).trim().split(/\\s+/)[0] ?? \"\" : \"\";", fresh: "const language = \"\";", catches: "language" },
  "fence indent stays": { old: "const cut = Math.min(inset, /^ */.exec(z.text)?.[0].length ?? 0);", fresh: "const cut = 0;", catches: "inset" },
  "offset without indent": { old: "rel.push(z.from + cut - start);", fresh: "rel.push(z.from - start);", catches: "inset" },
  "also in lists and quotes": { old: "if (node.name !== \"FencedCode\") return false;", fresh: "if (node.name !== \"FencedCode\") return true;", catches: "level" },
  "caret ignored": { old: "if (!reading && sel.from <= to && sel.to >= from) {", fresh: "if (false) {", catches: "marker" },
  "read mode shows source": { old: "if (!reading && sel.from <= to", fresh: "if (sel.from <= to", catches: "read" },
  "first line unmarked": { old: "n === first ? CODE_CLASS.first : \"\"", fresh: "\"\"", catches: "marker" },
  "last line unmarked": { old: "n === last ? CODE_CLASS.last : \"\"", fresh: "\"\"", catches: "marker" },
  "widget equal without editability": { old: "other.model.src === this.model.src && other.editable === this.editable", fresh: "other.model.src === this.model.src", catches: "widget" },
  "widget not as block": { old: "Decoration.replace({ widget, block: true })", fresh: "Decoration.replace({ widget })", catches: "read" },
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-md-codeblock-"));
const src = path.join(tmp, "src"), out = path.join(tmp, "out"), reference = path.join(tmp, "node_modules");
fs.mkdirSync(src, { recursive: true });
fs.symlinkSync(path.join(webDir, "node_modules"), reference, "dir");
fs.writeFileSync(path.join(src, "md-codeblock.ts"), SOURCE);
const copies = Object.entries(SABOTAGES).map(([name, s], i) => {
  const file = `md-codeblock-sabotage-${i}.ts`;
  fs.writeFileSync(path.join(src, file), SOURCE.replace(s.old, () => s.fresh));
  return { name, file, catches: s.catches, places: SOURCE.split(s.old).length - 1 };
});
try {
  execFileSync(process.execPath, [tsc, ...fs.readdirSync(src).map((d) => path.join(src, d)), "--outDir", out, "--rootDir", src, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler", "--strict", "--skipLibCheck", "--lib", "es2022,dom"], { stdio: "pipe" });
} catch (e) {
  const text = `${String(e.stdout || "")}${String(e.stderr || "")}`;
  const realError = text.split("\n").filter((z) => /error TS\d+/.test(z) && !/-sabotage-\d+\.ts\(/.test(z));
  if (realError.length || !fs.existsSync(path.join(out, "md-codeblock.js"))) throw new Error(`tsc: ${text}`.slice(0, 4000));
}
const load = (file) => import(pathToFileURL(path.join(out, file.replace(/\.ts$/, ".js"))).href);
const real = await load("md-codeblock.ts");
const sabotaged = await Promise.all(copies.map(async (k) => ({ ...k, mod: await load(k.file) })));
try {
  fs.unlinkSync(reference); // the link first — never delete into web/node_modules
  fs.rmSync(tmp, { recursive: true, force: true });
} catch (e) { console.warn("[test] temp directory was left behind:", String(e?.message || e).slice(0, 120)); }

const DIAGRAM = [
  "Agent-Runtime ─┐ (shares network)",
  "               ▼",
  "   Machine Client (pangolin-cli, Container)          strat-dev",
  "               │ WireGuard (UDP 21820)",
  "               ▼",
  "   orbit-gerbil ◀── WireGuard (UDP 51820) ─── Site (pangolin-cli, Windows service)",
];
const DOC = ["# Network", "", "Text before.", "", "```", ...DIAGRAM, "```", "", "~~~ts title", "const x = 1;", "~~~", "", "Text after."].join("\n");

/** A real state with the app's Markdown; "reading" hangs on a facet so that the field reads it from the state as in the editor. */
function state(M, doc, { reading = true, marker = 0 } = {}) {
  const Reading = Facet.define({ combine: (v) => v.at(-1) ?? false });
  const field = M.codeBlockField({ reading: (s) => s.facet(Reading), editable: () => true, fresh: () => true });
  let s = EditorState.create({ doc, selection: { anchor: marker }, extensions: [markdown({ base: markdownLanguage }), Reading.of(reading), field] });
  ensureSyntaxTree(s, s.doc.length, 5000);
  s = s.update({}).state; // recompute after the full tree
  const deco = [];
  const it = s.field(field).iter();
  for (; it.value; it.next()) deco.push({ from: it.from, to: it.to, widget: it.value.spec.widget, block: it.value.spec.block, kind: it.value.spec.class ?? "" });
  return { s, deco, widgets: deco.filter((d) => d.widget), rows: deco.filter((d) => !d.widget) };
}
const rowOf = (s, pos) => s.doc.lineAt(pos).number;

const CHECKS = {
  read(M) {
    const { s, widgets, rows } = state(M, DOC);
    assert.equal(widgets.length, 2, "two blocks, two widgets");
    assert.equal(rows.length, 0, "no source text in read mode");
    const [a, b] = widgets;
    assert.equal(a.widget.constructor.name, "CodeBlockWidget");
    // Whole lines: from the fence to the end of the closing fence.
    assert.equal(a.from, s.doc.line(5).from);
    assert.equal(a.to, s.doc.line(12).to);
    assert.equal(rowOf(s, b.from), 14);
    assert.equal(b.to, s.doc.line(16).to);
    assert.deepEqual(a.widget.model.rows, DIAGRAM, "the diagram line by line, without fences");
    assert.deepEqual(b.widget.model.rows, ["const x = 1;"]);
    // Block decoration: only so a box stands instead of inline text (and only so may it change the height).
    assert.ok(widgets.every((w) => w.block === true), "widget as block decoration");
    // Reading (read mode or no focus): the box stays even if the caret happens to be in the block.
    const inside = state(M, DOC, { reading: true, marker: DOC.indexOf("Machine Client") });
    assert.equal(inside.widgets.length, 2, "reading: widget despite caret in the block");
    assert.equal(inside.rows.length, 0);
  },
  open(M) {
    const doc = "Before\n\n```\nline 1\nline 2";
    const { widgets } = state(M, doc);
    assert.equal(widgets.length, 1);
    assert.deepEqual(widgets[0].widget.model.rows, ["line 1", "line 2"], "an open block runs to the end");
  },
  language(M) {
    const { widgets } = state(M, DOC);
    assert.equal(widgets[0].widget.model.language, "", "no language without an info line");
    assert.equal(widgets[1].widget.model.language, "ts", "first word of the info line");
  },
  inset(M) {
    const doc = "  ```\n  a\n    b\nc\n  ```";
    const { s, widgets } = state(M, doc);
    const m = widgets[0].widget.model;
    assert.deepEqual(m.rows, ["a", "  b", "c"], "the fence indent goes, nothing more");
    for (let i = 0; i < m.rows.length; i++) {
      const pos = widgets[0].from + m.rel[i];
      assert.equal(s.doc.sliceString(pos, pos + m.rows[i].length), m.rows[i], `offset of line ${i} points to its text`);
    }
    const d = state(M, DOC);
    const a = d.widgets[0];
    const pos = a.from + a.widget.model.rel[5];
    assert.equal(d.s.doc.lineAt(pos).text, DIAGRAM[5]);
  },
  level(M) {
    const doc = "- Item\n\n  ```\n  code\n  ```\n\n> ```\n> quoted\n> ```\n\n```\ntop\n```";
    const { widgets } = state(M, doc);
    assert.deepEqual(widgets.map((w) => w.widget.model.rows), [["top"]], "only the top-level block is replaced");
  },
  marker(M) {
    const inside = DOC.indexOf("Machine Client");
    const { s, widgets, rows } = state(M, DOC, { reading: false, marker: inside });
    assert.equal(widgets.length, 1, "the other block stays a widget");
    assert.equal(widgets[0].widget.model.language, "ts");
    assert.deepEqual(rows.map((z) => rowOf(s, z.from)), [5, 6, 7, 8, 9, 10, 11, 12], "every line of the block, fences included");
    assert.ok(rows.every((z) => z.kind.split(" ").includes(M.CODE_CLASS.row)), "every line in the code box");
    assert.deepEqual(rows.filter((z) => z.kind.includes(M.CODE_CLASS.first)).map((z) => rowOf(s, z.from)), [5], "first line rounded");
    assert.deepEqual(rows.filter((z) => z.kind.includes(M.CODE_CLASS.last)).map((z) => rowOf(s, z.from)), [12], "last line rounded");
    // Caret outside: both widgets.
    const outside = state(M, DOC, { reading: false, marker: 0 });
    assert.equal(outside.widgets.length, 2);
    assert.equal(outside.rows.length, 0);
    // A caret at the end of the closing fence counts as inside (that is where ↓ leads out of the block).
    assert.equal(state(M, DOC, { reading: false, marker: s.doc.line(12).to }).widgets.length, 1);
  },
  widget(M) {
    const { widgets } = state(M, DOC);
    const m = widgets[0].widget.model;
    assert.equal(new M.CodeBlockWidget(m, true).eq(new M.CodeBlockWidget(m, true)), true);
    assert.equal(new M.CodeBlockWidget(m, true).eq(new M.CodeBlockWidget(m, false)), false, "editable or not is a different DOM (click)");
    assert.equal(new M.CodeBlockWidget(m, true).eq(new M.CodeBlockWidget({ ...m, src: m.src + "x" }, true)), false);
  },
};

const check = (name, M) => CHECKS[name](M);

test("(1) read mode: one block widget per block, code without fences, open block to the end, language", () => {
  for (const n of ["read", "open", "language"]) check(n, real);
});
test("(1) removal of the fence indent and offset of every line (click -> caret)", () => check("inset", real));
test("(1) top level only — fences in a list and quote stay source text", () => check("level", real));
test("(1) editing: caret in the block -> source text in the code box, first/last line marked; outside -> widget", () => check("marker", real));
test("(1) widget: equal only with the same source AND the same editability", () => check("widget", real));

test("(1) counter-probes: every sabotage appears exactly once in the source and is caught by its check", () => {
  assert.deepEqual(copies.filter((k) => k.places !== 1).map((k) => `${k.name} (${k.places}x)`), [], "sabotages whose spot does not appear exactly once in the source");
  const notCaught = [];
  for (const k of sabotaged) {
    let red = false;
    try { check(k.catches, k.mod); } catch { red = true; }
    if (!red) notCaught.push(`${k.name} → ${k.catches}`);
  }
  assert.deepEqual(notCaught, [], "sabotages that no check catches");
  const without = Object.keys(CHECKS).filter((p) => !copies.some((k) => k.catches === p));
  assert.deepEqual(without, [], "checks without a sabotage");
  console.log(`  [md-codeblock] calculation: ${Object.keys(CHECKS).length} checks, ${sabotaged.length} sabotages, each caught`);
});

// ── (2) The binding to the drawing ─────────────────────────────────────────────────────────────────────────────────────────────
/** The style rule of a selector from the theme (`` [`.${CODE_CLASS.x}`]: { … } ``) as text — up to the first closing brace. */
const rule = (q, selector) => {
  const i = q.indexOf("[`" + selector + "`]: {");
  return i < 0 ? "" : q.slice(i, q.indexOf("},", i));
};
const count = (r, prop) => Number(new RegExp(`${prop}: "([\\d.]+)"`).exec(r)?.[1] ?? NaN);
const W = ".${CODE_CLASS.widget}", PRE = ".${CODE_CLASS.pre}", ROW = ".cm-line.${CODE_CLASS.row}";

const BINDINGS = {
  mounted(q) {
    assert.match(q, /import \{ CODE_CLASS, codeBlockField \} from "@\/lib\/md-codeblock";/);
    const ext = q.slice(q.indexOf("const extensions = useMemo("), q.indexOf("ReadingMode.of(reading)"));
    assert.match(ext, /\n\s+codeField,\n/, "the field hangs in the editor");
    assert.ok(ext.indexOf("focusField") < ext.indexOf("codeField"), "the focus field before the code field, which reads it on creation");
  },
  reading(q) {
    const start = q.indexOf("const codeField = codeBlockField({");
    const f = q.slice(start, q.indexOf("});", start));
    assert.match(f, /reading: \(s\) => s\.facet\(ReadingMode\) \|\| !s\.field\(focusField\),/, "reading = read mode OR no focus");
    assert.match(f, /editable: \(s\) => !s\.facet\(ReadingMode\),/);
    assert.match(f, /fresh: blockNew,/, "the same occasions as the tables");
    assert.match(q, /\|\| syntaxTree\(tr\.state\) !== syntaxTree\(tr\.startState\)/, "the tree delivered later recomputes too");
  },
  roles(q) {
    assert.match(rule(q, PRE), /whiteSpace: "pre"/, "no wrapping in the box");
    assert.match(rule(q, PRE), /overflowX: "auto"/, "long lines scroll in the box");
    assert.match(rule(q, W), /contain: "inline-size"/, "the box does not pass its width outward — otherwise the whole editor scrolls");
  },
  narrow(q) {
    for (const k of [PRE, ROW]) {
      const lh = count(rule(q, k), "lineHeight");
      assert.ok(lh > 0 && lh <= 1.2, `${k}: line height ${lh} — above 1.2 the box characters tear`);
      assert.match(rule(q, k), /fontFamily: "var\(--font-mono\)"/, `${k}: Monospace`);
    }
  },
  colors(q) {
    assert.match(rule(q, W), /background: "var\(--color-code\)"/, "background like CodeBlock (bg-code)");
    assert.match(rule(q, W), /border: "1px solid var\(--color-edge\)"/, "border like CodeBlock (border-edge)");
    assert.match(rule(q, W), /borderRadius: "12px"/, "rounded like CodeBlock (rounded-xl)");
    assert.match(rule(q, ROW), /background: "var\(--color-code\)"/, "the source text on the same background");
    for (const k of ["first", "last"]) assert.ok(rule(q, ".cm-line.${CODE_CLASS." + k + "}"), `style of the ${k} line`);
    assert.doesNotMatch(q, /["'.]cm-code-(widget|pre|language|row)/, "classes only via CODE_CLASS");
  },
};

const BINDING_SABOTAGES = {
  "field missing": { old: "      codeField,\n", fresh: "", catches: "mounted" },
  "focus ignored": { old: "reading: (s) => s.facet(ReadingMode) || !s.field(focusField),", fresh: "reading: (s) => s.facet(ReadingMode),", catches: "reading" },
  "tree forgotten": { old: "  || syntaxTree(tr.state) !== syntaxTree(tr.startState)\n", fresh: "", catches: "reading" },
  "wrapping in the box": { old: "whiteSpace: \"pre\", tabSize", fresh: "whiteSpace: \"pre-wrap\", tabSize", catches: "roles" },
  "whole editor scrolls": { old: " contain: \"inline-size\",", fresh: "", catches: "roles" },
  "line height of the body text": { old: "lineHeight: \"1.2\",\n    scrollbarWidth", fresh: "lineHeight: \"1.65\",\n    scrollbarWidth", catches: "narrow" },
  "source text wide": { old: "lineHeight: \"1.2\",\n    padding", fresh: "lineHeight: \"1.5\",\n    padding", catches: "narrow" },
  "fixed background": { old: "border: \"1px solid var(--color-edge)\", background: \"var(--color-code)\",", fresh: "border: \"1px solid var(--color-edge)\", background: \"#222\",", catches: "colors" },
  "class as a literal": { old: "[`.${CODE_CLASS.language}`]: {", fresh: "[\".cm-code-language\"]: {", catches: "colors" },
};

test("(2) binding: field hooked in, reading like the tables, box scrolls inside itself, tight lines, colours from the tokens", () => {
  for (const b of Object.values(BINDINGS)) b(EDITOR);
});

test("(2) counter-probes of the bindings: every sabotage appears exactly once and is caught", () => {
  const list = Object.entries(BINDING_SABOTAGES);
  assert.deepEqual(list.filter(([, s]) => EDITOR.split(s.old).length !== 2).map(([n]) => n), [], "sabotages whose spot does not appear exactly once in the editor");
  const notCaught = list.filter(([, s]) => {
    try { BINDINGS[s.catches](EDITOR.replace(s.old, () => s.fresh)); return true; } catch { return false; }
  }).map(([n, s]) => `${n} → ${s.catches}`);
  assert.deepEqual(notCaught, [], "sabotages that no binding catches");
  const without = Object.keys(BINDINGS).filter((b) => !list.some(([, s]) => s.catches === b));
  assert.deepEqual(without, [], "bindings without a sabotage");
});
