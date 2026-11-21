// The editor as VS Code. "Go to line" (⌃G) is held by web/test/editor-helpers.test.mjs.
//
// (1) The pure computations, EXECUTED (transpiled with tsc):
//     - lib/definition-preview.ts: which rows the definition preview shows — range, otherwise up to the end of the block (a closing row
//       belongs to it, `): void {` opens again), at most 8 rows as VS Code, trailing blank rows drop, outdented in CHARACTERS (a tab is one),
//       long rows truncated without splitting a surrogate pair.
//     - lib/cmd-link.ts: ⌘ (else Ctrl) without ⌥/⇧, an answer applies only to the last question on the same text in a mounted view, only
//       non-empty answers are remembered, and only briefly.
//     - lib/hover-sections.ts: sections of the hover — separators, docs below the signature even without a separator, code blocks with language.
//     - lib/bracket-colors.ts: the semantics of VS Code (a closing bracket closes the matching open one, even further out — the skipped
//       ones are red; open until end of file is red), the run with checkpoints (piecewise and after a change equal to the whole, `decide`
//       computes only as far as needed), what is string/comment/regex — against REAL Lezer trees (TS, JSX, Python, YAML, HTML, CSS) — and the
//       first deviation of two trees (never behind the first spot where the classification changes).
//     - lib/indentation.ts: indentation in columns, detected unit, guides per row (blank rows as VS Code, Python aside), the active block
//       (also with the marker far outside), remembered accesses per row, the style of a row.
//     - lib/search-counter.ts, lib/search-rules.ts, lib/preserve-case.ts: "n of m" with the marker INSIDE a hit, "19999+", the seed of the
//       search text (selection of one row, word, nothing in the widget and with several rows), the keys in the widget, the history (↑/↓),
//       the message of an invalid expression, `$1` in the replacement, "Preserve Case".
//     - components/code/gutters.ts: the row of the gutters as VS Code — [glyph margin: breakpoints, light bulb] · line numbers · git margin ·
//       fold arrows at the text —, measured against CodeMirror ITSELF (the facet `gutter()` writes to) with the configuration of BufferEditor
//       (basicSetup first) and the list from CodePane in ITS order; plus the diff tab.
// (2) The bindings to the rendering (source text, like web/test/diff-tab.test.mjs): the theme in the colours of VS Code with CSS selectors
//     and YAML keys (with the roots and tags of the REAL grammars), the fold arrows, the ⌘ hover including cancellation down to the fetch,
//     the hover, the brackets, the indentation guides, the widget, ONE Mac detection, the English texts, where the margins are hooked in,
//     and that there is NO lint margin (VS Code shows diagnostics only as a squiggle and in the hover; `linter()` alone draws no margin —
//     measured, counter-test `lintGutter()`).
//
// Each sabotage is a copy of the source with ONE changed spot (the spot occurs exactly once, otherwise the sabotage is stale); the assigned
// check must fail on it — the counter-test that the check enters the path it promises.
//
// Run:  node --test --test-reporter=tap web/test/editor-look.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TreeFragment } from "@lezer/common";
import { highlightTree, tagHighlighter, tags } from "@lezer/highlight";
import { parser as jsParser } from "@lezer/javascript";
import { parser as pyParser } from "@lezer/python";
import { parser as yamlParser } from "@lezer/yaml";
import { parser as htmlParser } from "@lezer/html";
import { parser as cssParser } from "@lezer/css";
import { parser as sassParser } from "@lezer/sass";
import { EditorState } from "@codemirror/state";
import { gutter, lineNumbers } from "@codemirror/view";
import { foldGutter } from "@codemirror/language";
import { linter, lintGutter } from "@codemirror/lint";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");
const read = (...p) => fs.readFileSync(path.join(webDir, ...p), "utf8");

// ── (1) The computations ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
const FILE = {
  preview: "definition-preview.ts", link: "cmd-link.ts", hover: "hover-sections.ts", brackets: "bracket-colors.ts", inset: "indentation.ts",
  search: "search-counter.ts", rules: "search-rules.ts", preserveCase: "preserve-case.ts", margin: "gutters.ts",
};
const FOLDER = { margin: ["src", "components", "code"] }; // otherwise src/lib
const SOURCES = Object.fromEntries(Object.entries(FILE).map(([k, d]) => [k, read(...(FOLDER[k] ?? ["src", "lib"]), d)]));
const SABOTAGES = {
  preview: {
    "no cap": { old: "for (let i = from + 1; start >= 0 && i < n && i - from + 1 <= max; i++) {", fresh: "for (let i = from + 1; start >= 0 && i < n; i++) {", catches: "previewCap" },
    "closing row missing": { old: "const closes = e === start && CLOSES.test(rows[i].trimStart());", fresh: "const closes = false;", catches: "previewBlock" },
    "does not open again": { old: "if (closes && !OPENS_AGAIN.test(rows[i].trimEnd())) break;", fresh: "if (closes) break;", catches: "previewBlock" },
    "same depth belongs to it": { old: "if (!(e < 0 || e > start || closes)) break;", fresh: "if (!(e < 0 || e >= start || closes)) break;", catches: "previewBlock" },
    "range skipped": { old: "if (until > from && until - from + 1 <= max) end = until;", fresh: "if (false) end = until;", catches: "previewArea" },
    "end character 0 counts": { old: "if (until > from && Number(area?.end?.character) === 0) until -= 1;", fresh: "", catches: "previewArea" },
    "not outdented": { old: "const cut = including.length ? Math.min(...including) : 0;", fresh: "const cut = 0;", catches: "previewOutdent" },
    "trailing blank rows stay": { old: "while (part.length > 1 && insetCharacter(part[part.length - 1]) < 0) part.pop();", fresh: "", catches: "previewBlock" },
    "long row untruncated": { old: "truncate(z.slice(cut), character)", fresh: "z.slice(cut)", catches: "previewOutdent" },
    "surrogate pair split": { old: "up >= 0xd800 && up <= 0xdbff ? n - 1 : n", fresh: "n", catches: "previewOutdent" },
    "inset in columns": { old: "export const insetCharacter = (z: string): number => { const m = /\\S/.exec(z); return m ? m.index : -1; };", fresh: "export const insetCharacter = (z: string): number => { const m = /\\S/.exec(z); return m ? z.slice(0, m.index).replace(/\\t/g, \"    \").length : -1; };", catches: "previewOutdent" },
  },
  link: {
    "⌥ counts": { old: "(mac ? e.metaKey : e.ctrlKey) && !e.altKey && !e.shiftKey", fresh: "(mac ? e.metaKey : e.ctrlKey) && !e.shiftKey", catches: "linkKey" },
    "Mac with Ctrl": { old: "mac ? e.metaKey : e.ctrlKey", fresh: "e.ctrlKey", catches: "linkKey" },
    "old question applies": { old: "question.seq === now.seq && ", fresh: "", catches: "linkApplies" },
    "applies after typing": { old: "question.doc === now.doc && ", fresh: "", catches: "linkApplies" },
    "applies when closed": { old: " && now.mounted", fresh: "", catches: "linkApplies" },
    "empty remembered": { old: "if (locations.length) this.m.set(key, { locations, until: now + this.validMs });\n    else this.m.delete(key);", fresh: "this.m.set(key, { locations, until: now + this.validMs });", catches: "linkStorage" },
    "every leaf a target": { old: "/(?:Name|Definition|Identifier)$/.test(node)", fresh: "true", catches: "linkBeforehand" },
    "name anywhere": { old: "/(?:Name|Definition|Identifier)$/", fresh: "/(?:Name|Definition|Identifier)/", catches: "linkBeforehand" },
    "never expires": { old: "if (now >= e.until) { this.m.delete(key); return undefined; }", fresh: "", catches: "linkStorage" },
  },
  hover: {
    "no separator": { old: "if (SEPARATOR.test(z)) { fresh(); continue; }", fresh: "", catches: "sections" },
    "docs stick to the signature": { old: "if (z.trim() && !text.some((x) => x.trim()) && now().length && now().every((t) => t.kind === \"code\")) { text = []; sections.push([]); }", fresh: "", catches: "sections" },
    "blank row prevents the cut": { old: "!text.some((x) => x.trim())", fresh: "!text.length", catches: "sections" },
    "character references raw": { old: "now().push({ kind: \"text\", text: lspMarkdownText(t) });", fresh: "now().push({ kind: \"text\", text: t });", catches: "sections" },
    "references in code too": { old: "(i % 2 ? part : part\n", fresh: "(false ? part : part\n", catches: "sections" },
    "masking stays": { old: "    .replace(MASK, \"$1\")\n", fresh: "", catches: "sections" },
    "asterisk unmasked": { old: "const MASK = /\\\\([!", fresh: "const MASK = /\\\\([*!", catches: "sections" },
    "language lost": { old: "language: f[2].toLowerCase()", fresh: "language: \"\"", catches: "codeBlocks" },
    "short fence closes": { old: "if (s.length >= length && [...s].every((c) => c === character)) break;", fresh: "if (s.length >= 3 && [...s].every((c) => c === character)) break;", catches: "codeBlocks" },
  },
  brackets: {
    "kinds mixed up": { old: "while (j >= 0 && findings[stack[j]].kind !== a - 3) j -= 1;", fresh: "while (j >= 0 && false) j -= 1;", catches: "bracketSemantics" },
    "skipped ones stay coloured": { old: "while (stack.length - 1 > j) findings[stack.pop()!].ok = false;", fresh: "while (stack.length - 1 > j) stack.pop();", catches: "bracketSemantics" },
    "unmatched closing one coloured": { old: "if (j < 0) { findings.push({ pos, kind: a - 3, open: false, depth: stack.length, ok: false }); continue; }", fresh: "if (j < 0) { findings.push({ pos, kind: a - 3, open: false, depth: stack.length, ok: true }); continue; }", catches: "bracketSemantics" },
    "open at the end coloured": { old: "if (this.far >= end) for (const k of this.stack) this.findings[k].ok = false;", fresh: "", catches: "bracketSemantics" },
    "depth after closing": { old: "findings.push({ pos, kind: a - 3, open: false, depth: stack.length, ok: true });", fresh: "findings.push({ pos, kind: a - 3, open: false, depth: stack.length + 1, ok: true });", catches: "bracketSemantics" },
    "strings count": { old: "if (r < notCode.length && notCode[r][0] <= pos) continue;", fresh: "", catches: "bracketSemantics" },
    "colours without cycle": { old: "(k.ok === false ? -1 : k.depth % 3)", fresh: "(k.ok === false ? -1 : Math.min(k.depth, 2))", catches: "bracketColor" },
    "undecided is red": { old: "k.ok === false ? -1", fresh: "!k.ok ? -1", catches: "bracketColor" },
    "wrong blue": { old: "dark: [\"#ffd700\", \"#da70d6\", \"#179fff\"]", fresh: "dark: [\"#ffd700\", \"#da70d6\", \"#0000ff\"]", catches: "bracketColor" },
    "checkpoint without stack": { old: "if (b === checkpoint) this.checkpoints.push({ pos: b, count: this.findings.length, stack: this.stack.slice() });", fresh: "if (b === checkpoint) this.checkpoints.push({ pos: b, count: this.findings.length, stack: [] });", catches: "bracketRun" },
    "dismiss without return": { old: "while (i > 0 && this.checkpoints[i].pos > pos) i -= 1;", fresh: "", catches: "bracketRun" },
    "open ones stay decided": { old: "for (const k of this.stack) this.findings[k].ok = null;", fresh: "", catches: "bracketRun" },
    "nothing decided": { old: "if (top === undefined || this.findings[top].pos < start || this.far >= end) return;", fresh: "return;", catches: "bracketRun" },
    "also decides the invisible": { old: "this.findings[top].pos < start || ", fresh: "", catches: "bracketRun" },
    "comments count": { old: "new Set([t.string, t.comment, t.regexp])", fresh: "new Set([t.string, t.regexp])", catches: "bracketTree" },
    "regex counts": { old: "new Set([t.string, t.comment, t.regexp])", fresh: "new Set([t.string, t.comment])", catches: "bracketTree" },
    "parent tags overlooked": { old: "tags.some((x) => x.set.some((s) => NOT_CODE_TAGS.has(s)))", fresh: "tags.some((x) => NOT_CODE_TAGS.has(x))", catches: "bracketTree" },
    "template type counts": { old: "if (n.name === \"TemplateType\") {", fresh: "if (n.name === \"-\") {", catches: "bracketTree" },
    "template type whole": { old: "if (c.name === \"Interpolation\") { if (c.from > a) raw.push([a, c.from]); a = c.to; }", fresh: "", catches: "bracketTree" },
    "YAML values count": { old: "(n.name === \"Literal\" && n.node.parent?.name !== \"Key\" && isYaml(n))", fresh: "false", catches: "bracketTree" },
    "YAML block counts": { old: " || n.name === \"BlockLiteralContent\"", fresh: "", catches: "bracketTree" },
    "kind irrelevant": { old: "if (af !== bf || a.type !== b.type) return Math.min(af, bf, limit);", fresh: "if (af !== bf) return Math.min(af, bf, limit);", catches: "treeDeviation" },
    "end irrelevant": { old: "if (at !== bt) limit = Math.min(at, bt);", fresh: "", catches: "treeDeviation" },
    "equal means same kind": { old: "const equal = a.tree !== null && a.tree === b.tree;", fresh: "const equal = a.type === b.type;", catches: "treeDeviation" },
    "always from the start": { old: "if (af >= limit && bf >= limit) return limit < until ? limit : -1;", fresh: "if (af >= limit && bf >= limit) return 0;", catches: "treeDeviation" },
  },
  inset: {
    "tab as one character": { old: "else if (c === \"\\t\") s += tab - (s % tab);\n    else return s;", fresh: "else if (c === \"\\t\") s += 1;\n    else return s;", catches: "inset" },
    "tabs overlooked": { old: "if (tabs > empty) return tab;", fresh: "", catches: "unit" },
    "largest instead of most frequent step": { old: "if (n > bestCount || (n === bestCount && d < best)) { best = d; bestCount = n; }", fresh: "if (d > best) { best = d; bestCount = n; }", catches: "unit" },
    "roundedDown": { old: "if (x >= 0) return Math.ceil(x / one);", fresh: "if (x >= 0) return Math.floor(x / one);", catches: "lines" },
    "blank row before deeper body": { old: "if (a < b) return 1 + Math.floor(a / one);", fresh: "if (a < b) return Math.floor(a / one);", catches: "lines" },
    "aside irrelevant": { old: "return aside ? Math.ceil(b / one) : 1 + Math.floor(b / one);", fresh: "return 1 + Math.floor(b / one);", catches: "lines" },
    "inset not remembered": { old: "const e = (i: number) => { let v = inset.get(i); if (v === undefined) { v = insetColumns(text(i), tab); inset.set(i, v); } return v; };", fresh: "const e = (i: number) => insetColumns(text(i), tab);", catches: "calculator" },
    "head not detected": { old: "if (hasText(row) && next(row, 1) >= 0 && f(next(row, 1)) > f(row)) { level = f(row); start = row + 1; }\n  else ", fresh: "", catches: "active" },
    "upwards only": { old: "while (until < Math.min(n - 1, limitUntil) && f(until + 1) > level) until += 1;", fresh: "", catches: "active" },
    "beyond the limit": { old: "while (until < Math.min(n - 1, limitUntil) && f(until + 1) > level) until += 1;", fresh: "while (until < n - 1 && f(until + 1) > level) until += 1;", catches: "active" },
    "active guide like the others": { old: "const color = j === active ? \"var(--cb-guide-active)\" : \"var(--cb-guide)\";", fresh: "const color = \"var(--cb-guide)\";", catches: "style" },
    "guides without unit": { old: "positions.push(`calc(${left} + ${j * unit}ch) 0`);", fresh: "positions.push(`calc(${left} + ${j}ch) 0`);", catches: "style" },
  },
  search: {
    "no cap": { old: "if (count >= cap) return { count, current, capped: true };", fresh: "", catches: "count" },
    "cap only afterwards": { old: "if (count >= cap) return { count, current, capped: true };", fresh: "if (count > cap) return { count, current, capped: true };", catches: "count" },
    "only the exact selection": { old: "t.from <= selection.to && t.to >= selection.from", fresh: "t.from === selection.from && t.to === selection.to", catches: "count" },
    "no positions": { old: "positions?.push(t.from);", fresh: "", catches: "count" },
    "invalid counts": { old: "if (!valid || s.count === 0) return { kind: \"no\" };", fresh: "if (s.count === 0) return { kind: \"no\" };", catches: "display" },
    "no question mark": { old: "n: s.current > 0 ? String(s.current) : \"?\"", fresh: "n: String(s.current)", catches: "display" },
    "no plus": { old: "m: s.capped ? `${s.count}+` : String(s.count)", fresh: "m: String(s.count)", catches: "display" },
  },
  rules: {
    "overwritten in the widget": { old: "if (!l.inWidget && !l.multiline) {", fresh: "if (!l.multiline) {", catches: "seed" },
    "several rows taken over": { old: "if (!l.inWidget && !l.multiline) {", fresh: "if (!l.inWidget) {", catches: "seed" },
    "replace takes the word": { old: "if (replace) raw = l.selection;\n    else raw = l.selection ?? l.word;", fresh: "raw = l.selection ?? l.word;", catches: "seed" },
    "not masked": { old: "l.regexp ? maskRegex(raw) : raw", fresh: "raw", catches: "seed" },
    "focus never in replace": { old: "focus: replace && (l.inSearchField || seed != null) ? \"replace\" : \"search\"", fresh: "focus: \"search\"", catches: "seed" },
    "too long taken over": { old: "(!raw || raw.length >= SEED_MAX)", fresh: "(!raw)", catches: "seed" },
    "tab always into replace": { old: "field === \"search\" && replaceOpen) return { kind: \"toReplace\" };", fresh: "field === \"search\") return { kind: \"toReplace\" };", catches: "key" },
    "no history": { old: "if ((e.key === \"ArrowUp\" || e.key === \"ArrowDown\") && without && !e.shiftKey && field !== \"other\") return { kind: e.key === \"ArrowUp\" ? \"historyBack\" : \"historyBefore\" };", fresh: "", catches: "key" },
    "toggle without ⌘ on the Mac": { old: "const option = mac ? e.altKey && e.metaKey && !e.ctrlKey : e.altKey && !e.metaKey && !e.ctrlKey;", fresh: "const option = e.altKey;", catches: "key" },
    "⌘↵ replaces one": { old: "return mod ? { kind: \"allReplace\" } : without ? { kind: \"replace\" } : null;", fresh: "return without ? { kind: \"replace\" } : null;", catches: "key" },
    "in selection without key": { old: "inSelection: \"L\", ", fresh: "", catches: "key" },
    "paging without new entry": { old: "if (current && !this.e.includes(current)) this.add(current);\n    let i", fresh: "let i", catches: "history" },
    "twice in the history": { old: "if (k >= 0) this.e.splice(k, 1);", fresh: "", catches: "history" },
    "history without cap": { old: "if (this.e.length > this.max) this.e.shift();", fresh: "", catches: "history" },
    "no empty field at the end": { old: "return this.i >= this.e.length ? \"\" : this.e[this.i];", fresh: "return this.e[Math.min(this.i, this.e.length - 1)];", catches: "history" },
    "without u toggle": { old: "try { new RegExp(value, \"gu\"); return null; }", fresh: "try { new RegExp(value, \"g\"); return null; }", catches: "regex" },
    "error swallowed": { old: "catch (e) { return e instanceof Error ? e.message : String(e); }", fresh: "catch { return null; }", catches: "regex" },
    "groups literal": { old: "if (n > 0 && n < hits.length) return (hits[n] ?? \"\") + i.slice(l);", fresh: "", catches: "replacement" },
    "replaced without regex": { old: "if (!regexp || !hits) return replacement;", fresh: "if (!hits) return replacement;", catches: "replacement" },
  },
  preserveCase: {
    "all upper case overlooked": { old: "if (hits.toUpperCase() === hits) return pattern.toUpperCase();", fresh: "", catches: "preserveCase" },
    "first letter overlooked": { old: "if (hasLarge(hits[0]) && pattern.length > 0) return pattern[0].toUpperCase() + pattern.slice(1);", fresh: "", catches: "preserveCase" },
    "not per part": { old: "if (hyphen && !underscore) return perPart(hits, pattern, \"-\");", fresh: "", catches: "preserveCase" },
    "split unequally": { old: " && hits.split(character).length === pattern.split(character).length", fresh: "", catches: "preserveCase" },
  },
  margin: {
    "glyph margin without level": { old: "export const glyphMargin = (e: Extension): Extension => Prec.high(e);", fresh: "export const glyphMargin = (e: Extension): Extension => e;", catches: "marginFollowUp" },
    "glyph margin at the very bottom": { old: "export const glyphMargin = (e: Extension): Extension => Prec.high(e);", fresh: "export const glyphMargin = (e: Extension): Extension => Prec.lowest(e);", catches: "marginFollowUp" },
    "fold arrows without level": { old: "export const marginAtText = (e: Extension): Extension => Prec.low(e);", fresh: "export const marginAtText = (e: Extension): Extension => e;", catches: "marginFollowUp" },
  },
};

// Compile: all modules and one copy per sabotage, in ONE tsc run. bracket-colors.ts reads @lezer/highlight — the temp folder gets a link to
// web/node_modules for it (for tsc and for loading; Node follows it to the real path, so the trees of the check share the same tags).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-editor-look-"));
const src = path.join(tmp, "src"), out = path.join(tmp, "out"), reference = path.join(tmp, "node_modules");
fs.mkdirSync(src, { recursive: true });
fs.symlinkSync(path.join(webDir, "node_modules"), reference, "dir");
for (const [k, q] of Object.entries(SOURCES)) fs.writeFileSync(path.join(src, FILE[k]), q);
const copies = [];
for (const [k, list] of Object.entries(SABOTAGES)) {
  for (const [name, s] of Object.entries(list)) {
    const file = FILE[k].replace(/\.ts$/, `-sabotage-${copies.length}.ts`);
    fs.writeFileSync(path.join(src, file), SOURCES[k].replace(s.old, () => s.fresh));
    copies.push({ name, module: k, file, catches: s.catches, places: SOURCES[k].split(s.old).length - 1 });
  }
}
try {
  execFileSync(process.execPath, [tsc, ...fs.readdirSync(src).map((d) => path.join(src, d)), "--outDir", out, "--rootDir", src, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler", "--strict", "--skipLibCheck", "--lib", "es2022,dom"], { stdio: "pipe" });
} catch (e) {
  const text = `${String(e.stdout || "")}${String(e.stderr || "")}`;
  const realError = text.split("\n").filter((z) => /error TS\d+/.test(z) && !/-sabotage-\d+\.ts\(/.test(z));
  if (realError.length || !fs.existsSync(path.join(out, "definition-preview.js"))) throw new Error(`tsc: ${text}`.slice(0, 4000));
}
const load = (file) => import(pathToFileURL(path.join(out, file.replace(/\.ts$/, ".js"))).href);
const real = Object.fromEntries(await Promise.all(Object.entries(FILE).map(async ([k, d]) => [k, await load(d)])));
const sabotaged = await Promise.all(copies.map(async (k) => ({ ...k, mod: await load(k.file) })));
try {
  fs.unlinkSync(reference); // the link first — never delete into web/node_modules
  fs.rmSync(tmp, { recursive: true, force: true });
} catch (e) { console.warn("[test] temp directory was left behind:", String(e?.message || e).slice(0, 120)); }

const R = (l1, c1, l2, c2) => ({ start: { line: l1, character: c1 }, end: { line: l2, character: c2 } });
/** Brackets as "character colour" (-1 = red) — short and readable in the failure text. */
const colors = (K, text, notCode = []) => K.bracketsOf(text, notCode).map((k) => `${text[k.pos]}${K.bracketColor(k)}`).join(" ");
const TS = jsParser.configure({ dialect: "jsx ts" });
/** Brackets of a text with the classification from the real syntax tree. */
const inTree = (K, p, text) => colors(K, text, K.notCodeAreas(p.parse(text), 0, text.length));
/** The facet `gutter()` writes to (not exported) — fished out of the extension tree; its values are the margins in the row in which
 *  CodeMirror draws them (first by precedence, then by position in the configuration). */
const MARGINS = (() => {
  const stack = [gutter({ class: "x" })];
  while (stack.length) {
    const e = stack.pop();
    if (!e || typeof e !== "object") continue;
    if (Array.isArray(e)) { stack.push(...e); continue; }
    if (e.facet && e.value && typeof e.value === "object" && "class" in e.value) return e.facet;
    if ("inner" in e) stack.push(e.inner);
    if ("extension" in e) stack.push(e.extension);
  }
  throw new Error("the facet of the margins cannot be found — @codemirror/view has changed");
})();
const marginQueue = (ext) => EditorState.create({ extensions: ext }).facet(MARGINS).map((r) => r.class);
const margin = (k) => gutter({ class: k });
const notCodeText = (K, p, text) => K.notCodeAreas(p.parse(text), 0, text.length).map(([a, b]) => text.slice(a, b));
/** A tree whose parser was stopped at `stop` (as CodeMirror does in the background). */
const partTree = (text, stop) => { const p = TS.startParse(text); p.stopAt(stop); let t; while (!(t = p.advance())); return t; };
/** The first spot before `until` where two trees classify string/comment differently — -1: none. */
function firstCategorization(K, a, b, until) {
  const inside = (list) => { const m = new Uint8Array(until); for (const [x, y] of list) m.fill(1, x, Math.min(y, until)); return m; };
  const ma = inside(K.notCodeAreas(a, 0, until)), mb = inside(K.notCodeAreas(b, 0, until));
  for (let i = 0; i < until; i++) if (ma[i] !== mb[i]) return i;
  return -1;
}

const KIND = [
  "export class A {",
  "  /** doc */",
  "  method(x: number): string {",
  "    if (x) {",
  "      return \"a\";",
  "    }",
  "    return \"b\";",
  "  }",
  "",
  "  other() {}",
  "}",
];
const CODE = [
  "function f() {", //   0
  "  if (x) {", //       1
  "    a();", //         2
  "", //                 3
  "    b();", //         4
  "  }", //              5
  "", //                 6
  "}", //                7
];

const CHECKS = {
  previewBlock(V) {
    // Only the name is reported (targetSelectionRange): up to the closing bracket of the block, outdented.
    assert.deepEqual(V.definitionsPreview(KIND, R(2, 2, 2, 9)), {
      rows: ["method(x: number): string {", "  if (x) {", "    return \"a\";", "  }", "  return \"b\";", "}"], from: 2,
    });
    // A row without a deeper body stays alone — the next one of the same depth does not belong to it.
    assert.deepEqual(V.definitionsPreview(["const x = 1;", "const y = 2;"], R(0, 6, 0, 7)).rows, ["const x = 1;"]);
    // A signature over several rows: `): void {` closes the bracket and opens the body.
    assert.deepEqual(V.definitionsPreview(["function f(", "  a: string,", "): void {", "  body();", "}", "const z = 1;"], R(0, 9, 0, 10)).rows,
      ["function f(", "  a: string,", "): void {", "  body();", "}"]);
    // Python: the body ends at the shallower row; blank rows inside stay, at the end they drop.
    assert.deepEqual(V.definitionsPreview(["def f(x):", "    y = x", "", "    return y", "", "def g():", "    pass"], R(0, 4, 0, 5)).rows,
      ["def f(x):", "    y = x", "", "    return y"]);
  },
  previewCap(V) {
    const lang = ["function lang() {", ...Array.from({ length: 20 }, (_, i) => `  line${i}();`), "}"];
    const v = V.definitionsPreview(lang, R(0, 9, 0, 13));
    assert.equal(V.PREVIEW_ROWS, 8, "VS Code MAX_SOURCE_PREVIEW_LINES");
    assert.equal(v.rows.length, 8, "at most 8 rows");
    assert.equal("truncated" in v, false, "VS Code does not indicate that it was truncated");
    assert.equal(V.definitionsPreview(lang, R(0, 9, 0, 13), { max: 3 }).rows.length, 3);
  },
  previewArea(V) {
    // A range over several rows applies as it is — even if the block went on.
    assert.deepEqual(V.definitionsPreview(CODE, R(1, 2, 2, 8)).rows, ["if (x) {", "  a();"]);
    // If it ends at the start of a row, that row does not belong to it (the blank row before drops at the end).
    assert.deepEqual(V.definitionsPreview(CODE, R(1, 0, 4, 0)).rows, ["if (x) {", "  a();"]);
    // Outside the file it is clamped; an empty file has no preview.
    assert.equal(V.definitionsPreview(CODE, R(99, 0, 99, 1)).from, 7);
    assert.deepEqual(V.definitionsPreview([], R(0, 0, 0, 0)).rows, []);
  },
  previewOutdent(V) {
    assert.deepEqual(V.definitionsPreview(["\tfoo() {", "\t\tbar();", "\t}"], R(0, 1, 0, 4)).rows, ["foo() {", "\tbar();", "}"]);
    // In characters, not in columns (VS Code): a tab is ONE character, four spaces are deeper.
    assert.deepEqual(V.definitionsPreview(["\tf() {", "    x();", "\t}"], R(0, 1, 0, 2)).rows, ["f() {", "   x();", "}"]);
    assert.deepEqual(V.definitionsPreview(["    x = 1"], R(0, 4, 0, 5)).rows, ["x = 1"]);
    const v = V.definitionsPreview(["const s = \"" + "a".repeat(1000) + "\";"], R(0, 6, 0, 7), { character: 50 });
    assert.equal(v.rows[0].length, 51, "a long row is truncated");
    assert.ok(v.rows[0].endsWith("…"));
    const emoji = V.definitionsPreview(["x" + "😀".repeat(30)], R(0, 0, 0, 1), { character: 20 }).rows[0];
    assert.equal(emoji, "x" + "😀".repeat(9) + "…", "no half character at the cut");
  },
  linkKey(L) {
    const d = (o) => ({ metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...o });
    assert.equal(L.modPressed(d({ metaKey: true }), true), true);
    assert.equal(L.modPressed(d({ ctrlKey: true }), true), false, "on the Mac Ctrl is not ⌘");
    assert.equal(L.modPressed(d({ ctrlKey: true }), false), true, "otherwise Ctrl");
    assert.equal(L.modPressed(d({ metaKey: true }), false), false);
    assert.equal(L.modPressed(d({ metaKey: true, altKey: true }), true), false, "⌥⌘ is a different command");
    assert.equal(L.modPressed(d({ metaKey: true, shiftKey: true }), true), false);
  },
  linkApplies(L) {
    const doc = {}, question = { seq: 3, doc };
    assert.equal(L.responseApplies(question, { seq: 3, doc, mounted: true }), true);
    assert.equal(L.responseApplies(question, { seq: 4, doc, mounted: true }), false, "a newer question is running");
    assert.equal(L.responseApplies(question, { seq: 3, doc: {}, mounted: true }), false, "after typing");
    assert.equal(L.responseApplies(question, { seq: 3, doc, mounted: false }), false, "view closed");
  },
  linkStorage(L) {
    const s = new L.LocationsStorage();
    assert.equal(L.VALID_MS, 5000);
    s.remember("w", [], 0);
    assert.equal(s.fetch("w", 1), undefined, "an empty answer is not remembered");
    s.remember("w", ["location"], 0);
    assert.deepEqual(s.fetch("w", 4999), ["location"]);
    assert.equal(s.fetch("w", 5000), undefined, "stale after VALID_MS");
    s.remember("w", ["location"], 10);
    s.remember("w", [], 20);
    assert.equal(s.fetch("w", 21), undefined, "an empty answer deletes the old one");
    s.remember("v", ["x"], 0);
    s.empty();
    assert.equal(s.fetch("v", 1), undefined);
  },
  linkBeforehand(L) {
    for (const n of ["VariableName", "VariableDefinition", "PropertyName", "TypeName", "Identifier", "FieldIdentifier"]) assert.equal(L.looksLikeTarget(n), true, n);
    for (const n of ["const", "function", "String", "LineComment", "Number", "Equals", "NameSpaceX"]) assert.equal(L.looksLikeTarget(n), false, n);
  },
  sections(H) {
    // typescript-language-server: signature, docs without a separator — the docs still stand below a line.
    assert.deepEqual(H.hoverSections("```typescript\nfunction f(): void\n```\nDocs for f.\n\n*@param* x"), [
      [{ kind: "code", language: "typescript", text: "function f(): void" }],
      [{ kind: "text", text: "Docs for f.\n\n*@param* x" }],
    ]);
    // … also with a blank row in between.
    assert.equal(H.hoverSections("```ts\nx\n```\n\nDocs").length, 2);
    // pyright: explicit separator.
    assert.deepEqual(H.hoverSections("```python\ndef f()\n```\n---\nDoc").map((a) => a.map((t) => t.kind)), [["code"], ["text"]]);
    assert.deepEqual(H.hoverSections("a\n\n---\n\nb").map((a) => a.map((t) => t.text)), [["a"], ["b"]]);
    // Text before the code stays ONE section.
    assert.deepEqual(H.hoverSections("Text\n```js\nx\n```").map((a) => a.map((t) => t.kind)), [["text", "code"]]);
    assert.deepEqual(H.hoverSections(""), []);
    assert.deepEqual(H.hoverSections("\n---\n"), []);
    // Character references and masking in the text as characters (CSS server: "Syntax: &lt;line\-width&gt;"), literal in code spans; the
    // characters the chat markdown interprets stay masked.
    assert.deepEqual(H.hoverSections(String.raw`Syntax: &lt;line\-width&gt; &amp; &#60;x&#x3E; ${"`"}&lt;b\-&gt;${"`"} &unknown; \* color\.`),
      [[{ kind: "text", text: String.raw`Syntax: <line-width> & <x> ${"`"}&lt;b\-&gt;${"`"} &unknown; \* color.` }]]);
    assert.equal(H.lspMarkdownText(String.raw`a\(b\)`), "a(b)");
  },
  codeBlocks(H) {
    assert.deepEqual(H.hoverSections("~~~Python\nx = 1\n~~~"), [[{ kind: "code", language: "python", text: "x = 1" }]]);
    // A longer fence does not close at a shorter one.
    assert.deepEqual(H.hoverSections("````md\n```\ninner\n```\n````"), [[{ kind: "code", language: "md", text: "```\ninner\n```" }]]);
  },
  bracketSemantics(K) {
    assert.equal(colors(K, "f(a[b{c}])"), "(0 [1 {2 }2 ]1 )0");
    assert.equal(colors(K, "(]"), "(-1 ]-1", "a closing one without a matching open one is red and closes nothing; the open one stays open to the end");
    assert.equal(colors(K, ")"), ")-1");
    assert.equal(colors(K, "(("), "(-1 (-1", "open until end of file is red (VS Code)");
    assert.equal(colors(K, "{[}]"), "{0 [-1 }0 ]-1", "} closes the outer {, the skipped [ is red, the ] after it has no open one left");
    assert.equal(colors(K, "((a)"), "(-1 (1 )1", "the depth counts the red pair outside too");
    const t = "a(b\"(\"c)";
    assert.equal(colors(K, t, [[3, 6]]), "(0 )0", "inside a string nothing counts");
  },
  bracketColor(K) {
    assert.deepEqual([0, 1, 2, 3, 4, 5].map((depth) => K.bracketColor({ depth, ok: true })), [0, 1, 2, 0, 1, 2]);
    assert.equal(K.bracketColor({ depth: 4, ok: null }), 1, "not yet decided is not red");
    assert.equal(K.bracketColor({ depth: 0, ok: false }), -1);
    assert.deepEqual(K.BRACKET_COLORS.dark, ["#ffd700", "#da70d6", "#179fff"], "gold, orchid, blue (Dark Modern)");
    assert.deepEqual(K.BRACKET_COLORS.light, ["#0431fa", "#319331", "#7b3814"]);
    assert.match(K.BRACKET_COLORS.mismatched, /^#ff1212/);
  },
  bracketRun(K) {
    assert.equal(K.CHECKPOINT_GAP, 4000);
    const strings = (s) => [...s.matchAll(/"[^"]*"/g)].map((m) => [m.index, m.index + m[0].length]);
    const run = (s, gap = 16) => {
      const l = new K.BracketRun(gap);
      const nc = strings(s);
      return { l, text: (a, b) => s.slice(a, b), nc: (a, b) => nc.filter(([x, y]) => y > a && x < b) };
    };
    const whole = (s) => K.bracketsOf(s, strings(s));
    const a = "f(a, [b]) {\n" + "  g(\"(\", x[1]);\n".repeat(12) + "}\n(";
    // Computed piecewise is the same as in one go.
    const x = run(a);
    x.l.further(40, a.length, x.text, x.nc);
    x.l.further(a.length, a.length, x.text, x.nc);
    assert.deepEqual(x.l.findings, whole(a), "piecewise");
    // A change in the middle: recomputed from the checkpoint before it is the same as the new text as a whole.
    const p = a.indexOf("x[1]", 100);
    const b = `${a.slice(0, p)}(${a.slice(p)}`;
    const y = run(b);
    y.l.further(a.length, a.length, (u, v) => a.slice(u, v), run(a).nc);
    y.l.dismissFrom(p);
    assert.ok(y.l.far <= p, "back before the change");
    y.l.further(b.length, b.length, y.text, y.nc);
    assert.deepEqual(y.l.findings, whole(b), "after the change");
    // After dismissing, an open bracket is undecided again (not red until the run reaches the end).
    const c = `(${"x".repeat(40)}`;
    const z = run(c);
    z.l.further(c.length, c.length, z.text, z.nc);
    assert.equal(z.l.findings[0].ok, false);
    z.l.dismissFrom(35);
    assert.equal(z.l.far, 32);
    assert.equal(z.l.findings[0].ok, null, "undecided again");
    // `decide`: a visible open bracket is followed up to its counterpart …
    const d = `x(${"y".repeat(60)})`;
    const w = run(d);
    w.l.further(10, d.length, w.text, w.nc);
    assert.equal(w.l.findings[0].ok, null);
    w.l.decide(0, d.length, w.text, w.nc);
    assert.equal(w.l.findings[0].ok, true, "decided");
    // … an open one BEFORE the visible range is not (nobody sees its colour, the depth behind it is already fixed).
    const e = `{${"\n".repeat(20)}a()${"z".repeat(1000)}}`;
    const v = run(e);
    v.l.further(30, e.length, v.text, v.nc);
    v.l.decide(21, e.length, v.text, v.nc);
    assert.ok(v.l.far < 100, `not computed to the end (far ${v.l.far})`);
  },
  bracketTree(K) {
    // TypeScript with JSX: string, line comment, template (without its `${…}`), regular expression.
    const js = "const s = \"a(b\"; // c(d\nconst t = `x(${f([1])}y)`; const r = /a(b/; f(x);";
    assert.equal(inTree(K, TS, js), "{0 (1 [2 ]2 )1 }0 (0 )0");
    assert.deepEqual(notCodeText(K, TS, js), ["\"a(b\"", "// c(d", "`x(", "y)`", "/a(b/"]);
    assert.equal(inTree(K, TS, "/** @param {x} (a */ f(1);"), "(0 )0", "doc comment");
    assert.equal(inTree(K, TS, "const c = '(';"), "");
    // A TS template type (the tree does not colour it): text is not code, `${…}` is.
    assert.equal(inTree(K, TS, "type T = `a(${Record<string, [1]>})`;"), "{0 [1 ]1 }0");
    // Python: f-string with replacement field, comment, triple-quoted string.
    assert.equal(inTree(K, pyParser, "x = f\"({y(1)})\"\ns = \"(\" # )\nd = \"\"\"\n(\n\"\"\"\n"), "{0 (1 )1 }0");
    // YAML: unquoted values, quoted values, comment, block content — only the flow list counts.
    assert.equal(inTree(K, yamlParser, "a: b (c\nd: [e, f]\ng: \"(h\"\n# (\ni: |\n  (block\n"), "[0 ]0");
    // HTML: attribute value. CSS: attribute value and comment.
    assert.equal(inTree(K, htmlParser, "<div title=\"a(b\">(x)</div>"), "(0 )0");
    assert.equal(inTree(K, cssParser, "a[href=\"x(y\"] { color: rgb(1, 2, 3); } /* ( */"), "[0 ]0 {0 (1 )1 }0");
  },
  treeDeviation(K) {
    // The parser in the background: a partial tree and the finished tree of the same text are equal up to the cut.
    const text = "let a = [1, 2];\n".repeat(400) + "f(`(`);\n";
    const part = partTree(text, 1000);
    const full = TS.parse(text, TreeFragment.addTree(part));
    assert.equal(K.firstDeviation(part, full, 500), -1, "nothing to recompute before the cut");
    const r = K.firstDeviation(part, full, 3000);
    assert.ok(r > 900 && r <= part.length, `at the cut (${r}, partial tree ${part.length})`);
    assert.equal(K.firstDeviation(full, TS.parse(text), text.length), -1, "two trees of the same text without shared nodes");
    // Never behind the first spot where the classification changes: a truncated template …
    const t2 = "f(1);\n".repeat(50) + "const s = `a(b\n" + "x(y);\n".repeat(50) + "`;\ng(2);\n";
    const part2 = partTree(t2, 320), full2 = TS.parse(t2);
    const d2 = firstCategorization(K, part2, full2, t2.length), r2 = K.firstDeviation(part2, full2, t2.length);
    assert.ok(d2 >= 0 && r2 >= 0 && r2 <= d2, `template: deviation ${r2}, classification changes at ${d2}`);
    // … a node that ends differently (a comment after which nothing begins in one tree) …
    const a4 = "/* a */ x(1);", b4 = "/* a x(1); */";
    const d4 = firstCategorization(K, TS.parse(a4), TS.parse(b4), a4.length), r4 = K.firstDeviation(TS.parse(a4), TS.parse(b4), a4.length);
    assert.ok(d4 >= 0 && r4 >= 0 && r4 <= d4, `comment: deviation ${r4}, classification changes at ${d4}`);
    // … and a node of another kind at the same spot (same length, string ↔ regular expression).
    const a3 = "g(1);\nf(\"((\");\n", b3 = "g(1);\nf(/((/);\n";
    const d3 = firstCategorization(K, TS.parse(a3), TS.parse(b3), a3.length);
    assert.equal(d3, -1, "both are not code — the classification is equal");
    assert.equal(K.firstDeviation(TS.parse(a3), TS.parse(b3), a3.length), a3.indexOf("\"(("), "at the spot of the other node");
  },
  inset(E) {
    assert.equal(E.insetColumns("    x"), 4);
    assert.equal(E.insetColumns("\tx"), 4);
    assert.equal(E.insetColumns("  \tx"), 4, "a tab jumps to the next tab stop");
    assert.equal(E.insetColumns("\t\tx", 2), 4);
    assert.equal(E.insetColumns(""), -1);
    assert.equal(E.insetColumns("   "), -1, "only whitespace is empty");
  },
  unit(E) {
    assert.equal(E.detectUnit(["a {", "    b {", "        c", "    }", "}"], 2), 4, "four spaces despite preset 2");
    assert.equal(E.detectUnit(CODE, 4), 2);
    assert.equal(E.detectUnit(["a", "\tb", "\t\tc", "\td"], 2, 4), 4, "tabs: the tab width");
    assert.equal(E.detectUnit(["f(", "\t\ta,", "\t\tb", ")"], 2, 4), 4, "tabs: the tab width, even if every step goes two tabs deep");
    assert.equal(E.detectUnit(["a", "b"], 3), 3, "without indentation the preset");
    // The majority counts: many steps of 2, one of 4.
    assert.equal(E.detectUnit(["a", "  b", "    c", "a", "  b", "    c", "a", "    d"], 8), 2);
  },
  lines(E) {
    assert.deepEqual(E.guides(CODE, 2), [0, 1, 2, 2, 2, 1, 1, 0]);
    // A blank row between head and deeper body carries the guide of the body.
    assert.deepEqual(E.guides(["if (x) {", "", "  a();", "}"], 2), [0, 1, 1, 0]);
    // Rounded up: three spaces at unit 2 are two guides.
    assert.deepEqual(E.guides(["   x"], 2), [2]);
    // Python (aside): a blank row before a shallower row no longer belongs to the block.
    const py = ["def f():", "    a", "", "b"];
    assert.deepEqual(E.guides(py, 4, 4, true), [0, 1, 0, 0]);
    assert.deepEqual(E.guides(py, 4, 4, false), [0, 1, 1, 0]);
    assert.deepEqual(E.guides(["", "  a", ""], 2), [0, 1, 0], "at the edge of the file no guides");
  },
  calculator(E) {
    // Via accesses per row and remembered: three rows out of 100,000 read three rows, a second look reads none.
    let read = 0;
    const f = E.guideCalculator(100000, (i) => { read += 1; return i % 3 ? "    x" : ""; }, 4);
    assert.deepEqual([f(50000), f(50001), f(50002)], [1, 1, 1]);
    assert.equal(read, 3, "every row read once");
    f(50001);
    assert.equal(read, 3);
  },
  active(E) {
    const f = E.guides(CODE, 2);
    assert.deepEqual(E.activeGuideIn(CODE, f, 2), { level: 1, from: 2, until: 4 }, "in the body: the innermost guide over the block");
    assert.deepEqual(E.activeGuideIn(CODE, f, 1), { level: 1, from: 2, until: 4 }, "on the head: the guide of its body");
    assert.deepEqual(E.activeGuideIn(CODE, f, 5), { level: 1, from: 2, until: 4 }, "on the closing row: that of the closed body");
    assert.deepEqual(E.activeGuideIn(CODE, f, 0), { level: 0, from: 1, until: 6 });
    assert.deepEqual(E.activeGuideIn(CODE, f, 7), { level: 0, from: 1, until: 6 });
    assert.equal(E.activeGuideIn(["a", "b"], [0, 0], 0), null, "outermost none");
    assert.equal(E.activeGuideIn(CODE, f, 99), null);
    // The marker far below the visible range: the block is followed from it into the range — and no further than the limit.
    const z = ["f() {", ...Array.from({ length: 698 }, () => "  x();"), "}"];
    const g = E.guideCalculator(z.length, (i) => z[i], 2);
    const has = (i) => E.insetColumns(z[i]) >= 0;
    assert.deepEqual(E.activeGuide(z.length, g, has, 500, 0, 500), { level: 0, from: 1, until: 500 });
    assert.deepEqual(E.activeGuide(z.length, g, has, 500, 0, z.length - 1), { level: 0, from: 1, until: 698 });
  },
  style(E) {
    assert.equal(E.linesStyle(2, 4, 1),
      "background-image:linear-gradient(var(--cb-guide),var(--cb-guide)),linear-gradient(var(--cb-guide-active),var(--cb-guide-active));"
      + "background-position:calc(6px + 0ch) 0,calc(6px + 4ch) 0;background-size:1px 100%;background-repeat:no-repeat");
    assert.ok(!E.linesStyle(3, 2, -1).includes("active"), "without an active guide no bright one");
  },
  count(S) {
    const t = [{ from: 0, to: 3 }, { from: 5, to: 8 }, { from: 10, to: 13 }];
    assert.deepEqual(S.countHits(t, { from: 5, to: 8 }), { count: 3, current: 2, capped: false });
    assert.equal(S.countHits(t, { from: 6, to: 6 }).current, 2, "the marker INSIDE a hit: \"2 of 3\"");
    assert.equal(S.countHits(t, { from: 8, to: 8 }).current, 2, "at the end of a hit");
    assert.equal(S.countHits(t, { from: 4, to: 4 }).current, 0, "between the hits: \"?\"");
    assert.equal(S.countHits(t, { from: 2, to: 6 }).current, 1, "the first one the selection touches");
    const positions = [];
    S.countHits(t, { from: 0, to: 0 }, undefined, positions);
    assert.deepEqual(positions, [0, 5, 10], "the positions for the scroll bar");
    assert.equal(S.SEARCH_CAP, 19999);
    const many = (n) => Array.from({ length: n }, (_, i) => ({ from: i, to: i + 1 }));
    assert.deepEqual(S.countHits(many(19999), { from: 0, to: 0 }), { count: 19999, current: 1, capped: true }, "exactly at the cap: \"19999+\" as VS Code");
    assert.equal(S.countHits(many(19998), { from: 0, to: 0 }).capped, false);
    let read = 0;
    const stream = { *[Symbol.iterator]() { for (let i = 0; i < 25000; i++) { read += 1; yield { from: i, to: i + 1 }; } } };
    assert.equal(S.countHits(stream, { from: 0, to: 0 }).count, 19999);
    assert.equal(read, 19999, "stops reading at the cap");
  },
  display(S) {
    const counts = (count, current, capped = false) => ({ count, current, capped });
    assert.deepEqual(S.counterDisplay("", true, counts(0, 0)), { kind: "empty" });
    assert.deepEqual(S.counterDisplay("x", true, counts(0, 0)), { kind: "no" });
    assert.deepEqual(S.counterDisplay("(", false, counts(4, 1)), { kind: "no" }, "an invalid expression has no hits");
    assert.deepEqual(S.counterDisplay("x", true, counts(3, 2)), { kind: "counted", n: "2", m: "3" });
    assert.deepEqual(S.counterDisplay("x", true, counts(3, 0)), { kind: "counted", n: "?", m: "3" });
    assert.deepEqual(S.counterDisplay("x", true, counts(19999, 1, true)), { kind: "counted", n: "1", m: "19999+" });
  },
  seed(G) {
    const situation = (o) => ({ selection: null, multiline: false, word: null, inWidget: false, inSearchField: false, regexp: false, ...o });
    assert.deepEqual(G.searchSeed(situation({ word: "foo" }), false), { seed: "foo", focus: "search" }, "⌘F without selection: the word at the marker");
    assert.deepEqual(G.searchSeed(situation({ selection: "a.b", word: "x" }), false), { seed: "a.b", focus: "search" });
    assert.equal(G.searchSeed(situation({ selection: "a.b", regexp: true }), false).seed, "a\\.b", "masked in regex mode");
    assert.equal(G.searchSeed(situation({ selection: "a\nb", multiline: true }), false).seed, null, "several rows: the previous search text stays");
    assert.equal(G.searchSeed(situation({ selection: "a\nb", multiline: true }), true).seed, null);
    assert.equal(G.searchSeed(situation({ selection: "sel", inWidget: true, inSearchField: true }), false).seed, null, "⌘F in the widget: overwrite nothing");
    assert.deepEqual(G.searchSeed(situation({ word: "foo" }), true), { seed: null, focus: "search" }, "⌥⌘F takes no word, only a selection");
    assert.deepEqual(G.searchSeed(situation({ selection: "sel" }), true), { seed: "sel", focus: "replace" });
    assert.deepEqual(G.searchSeed(situation({ inWidget: true, inSearchField: true }), true), { seed: null, focus: "replace" }, "⌥⌘F in the search field: into the replace field");
    assert.equal(G.searchSeed(situation({ selection: "x".repeat(G.SEED_MAX) }), false).seed, null, "too long");
    assert.equal(G.SEED_MAX, 524288);
  },
  key(G) {
    const d = (key, o = {}) => ({ key, code: o.code ?? "", shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, ...o });
    const kind = (e, field, mac = true, open = true) => G.searchKey(e, field, mac, open)?.kind ?? null;
    assert.equal(kind(d("Enter"), "search"), "further");
    assert.equal(kind(d("Enter", { shiftKey: true }), "search"), "back");
    assert.equal(kind(d("Enter"), "replace"), "replace");
    assert.equal(kind(d("Enter", { metaKey: true }), "replace"), "allReplace", "⌘↵");
    assert.equal(kind(d("Enter", { ctrlKey: true }), "replace", false), "allReplace", "Ctrl+↵");
    assert.equal(kind(d("Escape"), "other"), "close");
    assert.deepEqual(G.searchKey(d("c", { code: "KeyC", altKey: true, metaKey: true }), "search", true, false), { kind: "toggle", toggle: "caseSensitive" });
    assert.deepEqual(G.searchKey(d("r", { code: "KeyR", altKey: true }), "search", false, false), { kind: "toggle", toggle: "regexp" });
    assert.deepEqual(G.searchKey(d("l", { code: "KeyL", altKey: true, metaKey: true }), "replace", true, true), { kind: "toggle", toggle: "inSelection" });
    assert.deepEqual(G.searchKey(d("p", { code: "KeyP", altKey: true, metaKey: true }), "replace", true, true), { kind: "toggle", toggle: "preserveCase" });
    assert.equal(kind(d("c", { code: "KeyC", altKey: true }), "search"), null, "on the Mac ⌥⌘, not ⌥ alone");
    assert.equal(kind(d("Tab"), "search"), "toReplace");
    assert.equal(kind(d("Tab"), "search", true, false), null, "without a replace row ⇥ leaves the widget");
    assert.equal(kind(d("Tab", { shiftKey: true }), "replace"), "toSearch");
    assert.equal(kind(d("ArrowUp"), "search"), "historyBack");
    assert.equal(kind(d("ArrowDown"), "replace"), "historyBefore");
    assert.equal(kind(d("ArrowUp"), "other"), null);
    assert.equal(kind(d("f", { code: "KeyF", metaKey: true }), "search"), null, "⌘F goes to the key binding");
  },
  history(G) {
    const v = new G.SearchHistory();
    v.add("a");
    v.add("b");
    assert.equal(v.back("b"), "a");
    assert.equal(v.back("a"), null, "before the first nothing");
    assert.equal(v.before("a"), "b");
    assert.equal(v.before("b"), "", "behind the last an empty field");
    assert.equal(v.before(""), null);
    // A newly typed text itself enters the history when paging — ↓ leads back to it.
    assert.equal(v.back("c"), "b");
    assert.equal(v.before("b"), "c");
    v.add("a");
    assert.deepEqual(v.entries, ["b", "c", "a"], "every entry once, the newest last");
    const k = new G.SearchHistory(2);
    for (const x of ["x", "y", "z"]) k.add(x);
    assert.deepEqual(k.entries, ["y", "z"]);
    assert.equal(G.HISTORY_MAX, 50);
  },
  regex(G) {
    assert.match(G.regexError("a(", true) ?? "", /unterminated|group/i, "the message of the runtime, as VS Code");
    assert.equal(G.regexError("a(", false), null, "without regex mode no error");
    assert.equal(G.regexError("", true), null);
    assert.equal(G.regexError("\\p{L}+", true), null);
    assert.notEqual(G.regexError("a\\-b", true), null, "with u toggle (VS Code and @codemirror/search)");
  },
  replacement(G) {
    assert.equal(G.replacementFor("x$1y", true, ["ab", "a"]), "xay");
    assert.equal(G.replacementFor("$&$&", true, ["ab"]), "abab");
    assert.equal(G.replacementFor("$$", true, ["ab"]), "$");
    assert.equal(G.replacementFor("$12", true, ["abc", "a", "b"]), "a2", "the longest number that is a group");
    assert.equal(G.replacementFor("$1", false, ["ab", "a"]), "$1", "without regex literal");
  },
  preserveCase(F) {
    assert.equal(F.preserveCase("FOO", "bar"), "BAR");
    assert.equal(F.preserveCase("foo", "Bar"), "bar");
    assert.equal(F.preserveCase("Foo", "bar"), "Bar");
    assert.equal(F.preserveCase("fOO", "Bar"), "bar");
    assert.equal(F.preserveCase("Foo-Bar", "baz-qux"), "Baz-Qux", "per part");
    assert.equal(F.preserveCase("FOO_bar", "baz_qux"), "BAZ_qux");
    assert.equal(F.preserveCase("Foo-Bar", "baz-qux-quux"), "Baz-qux-quux", "unequal number of parts: as a whole");
    assert.equal(F.preserveCase("Foo-bar_baz", "a-b_c"), "A-b_c", "both separators: as a whole");
    assert.equal(F.preserveCase("", "x"), "x");
  },
  marginFollowUp(R) {
    const VS_CODE = ["bp", "bulb", "cm-lineNumbers", "git", "cm-foldGutter"];
    // File tab (Coding → files, chat, both editor groups): BufferEditor puts basicSetup (with the line numbers) BEFORE the list from
    // CodePane's extension builder, which hooks in in ITS order: fold arrows, breakpoints, light bulb (editor extensions), git margin.
    const codePane = [R.marginAtText(foldGutter()), R.glyphMargin(margin("bp")), [R.glyphMargin(margin("bulb"))], margin("git")];
    assert.deepEqual(marginQueue([lineNumbers(), codePane]), VS_CODE, "file tab");
    // Wherever it is hooked in: the same list reversed changes only the order WITHIN the glyph margin.
    assert.deepEqual(marginQueue([lineNumbers(), [...codePane].reverse()]), ["bulb", "bp", "cm-lineNumbers", "git", "cm-foldGutter"], "hooked in reversed");
    // Diff tab, editable side: basicSetup without line numbers, own line numbers, then the light bulb — no git margin, no fold arrows.
    assert.deepEqual(marginQueue([lineNumbers(), [R.glyphMargin(margin("bulb"))]]), ["bulb", "cm-lineNumbers"], "diff tab");
  },
};
const MODULE_THE_CHECK = {
  previewBlock: "preview", previewCap: "preview", previewArea: "preview", previewOutdent: "preview",
  linkKey: "link", linkApplies: "link", linkStorage: "link", linkBeforehand: "link", sections: "hover", codeBlocks: "hover",
  bracketSemantics: "brackets", bracketColor: "brackets", bracketRun: "brackets", bracketTree: "brackets", treeDeviation: "brackets",
  inset: "inset", unit: "inset", lines: "inset", calculator: "inset", active: "inset", style: "inset",
  count: "search", display: "search", seed: "rules", key: "rules", history: "rules", regex: "rules", replacement: "rules", preserveCase: "preserveCase",
  marginFollowUp: "margin",
};
const check = (k, mod) => { try { CHECKS[k](mod); } catch (e) { throw new Error(`${k}: ${e.message}`); } };
const all = (module) => Object.keys(MODULE_THE_CHECK).filter((k) => MODULE_THE_CHECK[k] === module);

test("(1) definition preview: block, 8 rows, range, outdented in characters", () => { for (const k of all("preview")) check(k, real.preview); });
test("(1) ⌘ link: key, validity of an answer, storage only for hits", () => { for (const k of all("link")) check(k, real.link); });
test("(1) hover sections and code blocks", () => { for (const k of all("hover")) check(k, real.hover); });
test("(1) brackets: semantics of VS Code, run with checkpoints, real syntax trees, deviation of two trees", () => { for (const k of all("brackets")) check(k, real.brackets); });
test("(1) indentation: columns, unit, guides, remembered accesses, active block, style", () => { for (const k of all("inset")) check(k, real.inset); });
test("(1) search: counter, seed, keys, history, regex message, replacement, case", () => {
  for (const [module, mod] of [["search", real.search], ["rules", real.rules], ["preserveCase", real.preserveCase]]) for (const k of all(module)) check(k, mod);
});
test("(1) gutters as VS Code: glyph margin · line numbers · git margin · fold arrows, measured against CodeMirror", () => { for (const k of all("margin")) check(k, real.margin); });

test("(1) counter-tests: every sabotage occurs exactly once in the source and is caught by its check", () => {
  const stale = copies.filter((k) => k.places !== 1).map((k) => `${k.name} (${k.places}×)`);
  assert.deepEqual(stale, [], "sabotages whose spot does not occur exactly once in the source");
  const wrong = copies.filter((k) => MODULE_THE_CHECK[k.catches] !== k.module).map((k) => k.name);
  assert.deepEqual(wrong, [], "sabotage assigned to a check of another module");
  const notCaught = [];
  for (const s of sabotaged) {
    let caught = false;
    try { CHECKS[s.catches](s.mod); } catch { caught = true; }
    if (!caught) notCaught.push(`${s.name} (${s.catches})`);
  }
  assert.deepEqual(notCaught, [], "sabotages that no check catches");
  const without = Object.keys(CHECKS).filter((k) => !copies.some((s) => s.catches === k));
  assert.deepEqual(without, [], "checks without sabotage");
  console.log(`  [editor-look] computations: ${Object.keys(CHECKS).length} checks, ${sabotaged.length} sabotages, each caught`);
});

// ── (2) The bindings to the rendering ─────────────────────────────────────────────────────────────────────────────────────────────
const B = {
  theme: read("src", "components", "code", "codeTheme.ts"),
  codePane: read("src", "components", "CodePane.tsx"),
  fold: read("src", "components", "code", "fold-margin.ts"),
  cmd: read("src", "components", "code", "cmd-hover.ts"),
  hover: read("src", "components", "code", "lsp-hover.ts"),
  addon: read("src", "components", "code", "lsp-extension.ts"),
  lspTheme: read("src", "components", "code", "lsp-theme.ts"),
  search: read("src", "components", "code", "search-widget.ts"),
  lines: read("src", "components", "code", "indentation-lines.ts"),
  brackets: read("src", "components", "code", "brackets.ts"),
  core: read("src", "components", "code", "lsp-core.ts"),
  api: read("src", "lib", "api", "lsp.ts"),
  navigation: read("src", "components", "code", "lsp-navigation.ts"),
  i18n: read("src", "lib", "i18n-de.ts"),
  actions: read("src", "components", "code", "lsp-actions.ts"),
  buffer: read("src", "components", "code", "BufferEditor.tsx"),
  gitGutter: read("src", "components", "code", "git-gutter.ts"),
  diff: read("src", "components", "code", "DiffTab.tsx"),
  // All sources of the web UI in one text — "no lint margin" holds for every editor, not just one file.
  all: fs.readdirSync(path.join(webDir, "src"), { recursive: true }).filter((d) => /\.tsx?$/.test(d)).sort()
    .map((d) => `// ── ${d}\n${read("src", d)}`).join("\n"),
};
/** The colour of a role in a table of the theme (`export const NAME … = { … };`). */
function color(theme, table, role) {
  const a = theme.indexOf(`export const ${table}`);
  assert.ok(a >= 0, `table ${table} is missing`);
  const block = theme.slice(a, theme.indexOf("};", a));
  const m = new RegExp(`(?:^|[\\s,{])"?${role.replace(/[-]/g, "\\-")}"?: "(#[0-9a-f]{6,8})"`).exec(block);
  assert.ok(m, `${table}.${role} is missing`);
  return m[1];
}
/** The role a rule of the theme gives a tag (`{ tag: [… t.controlKeyword …], color: f.controlWord }`). */
function roleOf(theme, tag) {
  const row = theme.split("\n").find((z) => /^\s*\{ tag: \[/.test(z) && (z.includes(`${tag},`) || z.includes(`${tag}]`)));
  return row ? /color: f\.(\w+)/.exec(row)?.[1] ?? null : null;
}
/** A list `export const NAME = ["…"];` of the theme. */
const list = (theme, name) => JSON.parse(new RegExp(`^export const ${name} = (\\[[^\\]]*\\]);$`, "m").exec(theme)?.[1] ?? "null");
/** The spots of a text that a highlighter with the tags `tagList` hits (as `onlyIn` colours them). */
const hit = (tree, text, tagList) => {
  const out = [];
  highlightTree(tree, tagHighlighter([{ tag: tagList, class: "x" }]), (a, b) => out.push(text.slice(a, b)));
  return out;
};

const SPEC_VE6 = {
  DARK_MODERN: { keyword: "#569cd6", controlWord: "#c586c0", string: "#ce9178", fn: "#dcdcaa", type: "#4ec9b0", variable: "#9cdcfe", constant: "#4fc1ff", count: "#b5cea8", comment: "#6a9955", tag: "#569cd6", attribute: "#9cdcfe", operator: "#d4d4d4", punctuation: "#d4d4d4" },
  LIGHT_MODERN: { keyword: "#0000ff", controlWord: "#af00db", string: "#a31515", fn: "#795e26", type: "#267f99", variable: "#001080", constant: "#0070c1", count: "#098658", comment: "#008000", tag: "#800000", attribute: "#e50000", operator: "#000000" },
  // VS Code Dark Modern: editor.*, editorGutter.foldingControlForeground, editor.foldBackground, editorLink.activeForeground,
  // inputValidation.error*, the selectors in CSS (entity.other.attribute-name.*) and the keys in YAML (entity.name.tag).
  SURFACE_DARK: {
    "--cb-selection": "#264f78", "--cb-cursor": "#aeafad", "--cb-line-highlight-border": "#282828", "--cb-line-number": "#6e7681", "--cb-line-number-active": "#cccccc",
    "--cb-guide": "#404040", "--cb-guide-active": "#707070", "--cb-fold": "#c5c5c5", "--cb-fold-background": "#264f784d", "--cb-link-active": "#4e94ce",
    "--cb-error-background": "#5a1d1d", "--cb-error-edge": "#be1100", "--cb-css-selector": "#d7ba7d", "--cb-yaml-key": "#569cd6",
  },
  SURFACE_LIGHT: {
    "--cb-selection": "#add6ff", "--cb-cursor": "#000000", "--cb-line-highlight-border": "#eeeeee", "--cb-line-number": "#6e7681", "--cb-guide": "#d3d3d3",
    "--cb-guide-active": "#939393", "--cb-fold": "#424242", "--cb-fold-background": "#add6ff4d", "--cb-link-active": "#0000ff", "--cb-error-background": "#f2dede",
    "--cb-error-edge": "#be1100", "--cb-css-selector": "#800000", "--cb-yaml-key": "#800000",
  },
};
const ROLE_PER_TAG = {
  "t.keyword": "keyword", "t.definitionKeyword": "keyword", "t.controlKeyword": "controlWord", "t.moduleKeyword": "controlWord",
  "t.string": "string", "t.function(t.variableName)": "fn", "t.function(t.propertyName)": "fn", "t.typeName": "type",
  "t.className": "type", "t.variableName": "variable", "t.propertyName": "variable", "t.number": "count", "t.comment": "comment",
  "t.tagName": "tag", "t.attributeName": "attribute", "t.operator": "operator", "t.punctuation": "punctuation",
};

const BINDINGS = {
  theme(s) {
    for (const [table, desired] of Object.entries(SPEC_VE6)) for (const [role, f] of Object.entries(desired)) assert.equal(color(s.theme, table, role), f, `${table}.${role}`);
    for (const [tag, role] of Object.entries(ROLE_PER_TAG)) assert.equal(roleOf(s.theme, tag), role, `${tag} does not carry ${role}`);
    // The active row is a frame, not a fill; selection and marker read the variables.
    assert.match(s.theme, /"\.cm-activeLine": \{ backgroundColor: "transparent", boxShadow: "inset 0 0 0 2px var\(--cb-line-highlight-border\)" \}/);
    assert.match(s.theme, /"&\.cm-focused > \.cm-scroller > \.cm-selectionLayer \.cm-selectionBackground": \{ background: "var\(--cb-selection\)" \}/, "the selection in focus as specific as the base theme of CodeMirror");
    assert.match(s.theme, /"\.cm-cursor, \.cm-dropCursor": \{ borderLeft: "2px solid var\(--cb-cursor\)"/);
    // Light only without the dark marker, dark WITH it — otherwise both syntax colours would run at once.
    assert.match(s.theme, /^const lightHighlightStyle = HighlightStyle\.define\(syntaxRules\(LIGHT_MODERN\), \{ themeType: "light" \}\);$/m);
    assert.match(s.theme, /^export const darkSyntax = \[Prec\.highest\(syntaxHighlighting\(darkHighlightStyle\)\), EditorView\.darkTheme\.of\(true\)\];$/m);
    assert.match(s.theme, /"&dark": \{ \.\.\.SURFACE_DARK, \.\.\.bracketVariables\(BRACKET_COLORS\.dark\) \}/);
    assert.match(s.theme, /"&light": \{ \.\.\.SURFACE_LIGHT, \.\.\.bracketVariables\(BRACKET_COLORS\.light\) \}/);
    // What every code editor brings and the colours per language, plus the cursor blink rate of VS Code and the shadow when scrolling.
    assert.match(s.theme, /^export const codeTheme: Extension = \[\n\s+codeSurface, colorVariables, syntaxHighlighting\(lightHighlightStyle\), languageColors, bracketColors, indentationLines, searchWidget,\n\s+\/\/ [^\n]*\n\s+drawSelection\(\{ cursorBlinkRate: CURSOR_BLINK_MS \}\), scrollShadow,\n\s+\/\/ [^\n]*\n\s+gutterCovers,\n\];$/m);
    for (const i of ["0", "1", "2", "mismatched"]) assert.ok(s.theme.includes(`".cm-bracket-${i}, .cm-bracket-${i} *": { color: "var(--cb-bracket-${i})" }`), `bracket class ${i} without colour`);
    // CSS selectors and YAML keys: a highlighter only in the language, recognised by the root of the REAL tree.
    assert.match(s.theme, /\(style as unknown as \{ scope: \(type: NodeType\) => boolean \}\)\.scope = \(type\) => top\.includes\(type\.name\);/);
    const css = list(s.theme, "CSS_TOP"), yaml = list(s.theme, "YAML_TOP");
    for (const [name, p] of [["CSS", cssParser], ["Less", cssParser.configure({ dialect: "less" })], ["SCSS", sassParser], ["Sass", sassParser.configure({ dialect: "indented" })]]) {
      assert.ok(css?.includes(p.parse("a{}").type.name), `${name}: root ${p.parse("a{}").type.name} is missing in CSS_TOP`);
    }
    assert.ok(yaml?.includes(yamlParser.parse("a: b").type.name), "YAML: root is missing in YAML_TOP");
    assert.match(s.theme, /onlyIn\(CSS_TOP, \[\{ tag: \[t\.tagName, t\.className, t\.labelName\], class: "cm-css-selector" \}\]\)/);
    assert.match(s.theme, /onlyIn\(YAML_TOP, \[\{ tag: \[t\.definition\(t\.propertyName\)\], class: "cm-yaml-key" \}\]\)/);
    const cssText = "div.k#i:hover > a { color: red; }";
    assert.deepEqual(hit(cssParser.parse(cssText), cssText, [tags.tagName, tags.className, tags.labelName]), ["div", "k", "i", "hover", "a"], "the tags hit exactly the selectors");
    const yamlText = "a: b\nc:\n  d: [e]\n";
    assert.deepEqual(hit(yamlParser.parse(yamlText), yamlText, [tags.definition(tags.propertyName)]), ["a", "c", "d"], "the tag hits exactly the keys");
    assert.match(s.theme, /"\.cm-content \.cm-css-selector": \{ color: "var\(--cb-css-selector\)" \}/);
    assert.match(s.theme, /"\.cm-content \.cm-yaml-key": \{ color: "var\(--cb-yaml-key\)" \}/);
  },
  fold(s) {
    assert.match(s.codePane, /^import \{ foldMargin \} from "@\/components\/code\/fold-margin";$/m);
    assert.match(s.codePane, /\n\s+list\.push\(foldMargin\);/);
    assert.match(s.codePane, /basicSetup=\{\{ tabSize: settings\.tabSize, highlightActiveLine: true, foldGutter: false \}\}/, "two fold margins");
    assert.match(s.fold, /if \(open\) s\.setAttribute\("data-open", ""\);/, "the arrow of a folded spot must stay");
    assert.match(s.fold, /"\.cm-fold\[data-open\]": \{ opacity: "0" \}/);
    assert.match(s.fold, /"\.cm-gutters:hover \.cm-fold\[data-open\]": \{ opacity: "1" \}/);
    assert.match(s.fold, /"\.cm-fold": \{ display: "grid", placeItems: "center", color: "var\(--cb-fold\)"/);
    // A name for screen readers and pointing devices (VS Code "Click to collapse/expand the range.").
    assert.match(s.fold, /const name = tr\(open \? "Click to collapse the range\." : "Click to expand the range\."\);/);
    assert.match(s.fold, /s\.setAttribute\("role", "button"\);\n\s+s\.setAttribute\("aria-expanded", String\(open\)\);\n\s+s\.setAttribute\("aria-label", name\);\n\s+s\.title = name;/);
    // The row of a folded spot is highlighted (editor.foldBackground).
    assert.match(s.fold, /^export const foldMargin: Extension = \[marginAtText\(foldGutter\(\{ markerDOM: arrow \}\)\), foldedRows, form\];$/m);
    assert.match(s.fold, /"\.cm-folded": \{ backgroundColor: "var\(--cb-fold-background\)" \}/);
  },
  cmdHover(s) {
    // ⌘ counts only in THIS view; releasing and window switching are heard by ONE shared listener, blur only of the window itself.
    assert.match(s.cmd, /onEditor\("keydown", \(e\) => this\.key\(e\)\);/, "⌘ at the editor, not at the window");
    assert.doesNotMatch(s.cmd, /window\.addEventListener\("keydown"/);
    assert.match(s.cmd, /const windowWay = \(e: FocusEvent\) => \{ if \(e\.target === window\) for \(const a of views\) a\.lost\(\); \};/);
    assert.match(s.cmd, /if \(!prior && views\.size\) \{ window\.addEventListener\("keyup", released, true\); window\.addEventListener\("blur", windowWay\); \}/);
    assert.match(s.cmd, /if \(prior && !views\.size\) \{ window\.removeEventListener\("keyup", released, true\); window\.removeEventListener\("blur", windowWay\); \}/);
    assert.match(s.cmd, /destroy\(\) \{\n\s+report\(this, false\);/);
    // Cancelling, validity, storage.
    assert.match(s.cmd, /this\.abort\?\.abort\(\);/, "a running question is cancelled");
    assert.match(s.cmd, /questions\(d, "definition", \{ position: lspPosOf\(this\.view\.state\.doc, w\.from\) \}, abort\.signal\)/);
    assert.match(s.cmd, /if \(!abort\.signal\.aborted\) this\.locations\.remember\(k, locations, Date\.now\(\)\);/);
    assert.match(s.cmd, /const remembered = this\.locations\.fetch\(k, Date\.now\(\)\);\n\s+if \(remembered\) return remembered;/, "ask once per word");
    assert.match(s.cmd, /if \(!u\.docChanged\) return;[\s\S]{0,200}this\.locations\.empty\(\);/);
    assert.match(s.cmd, /const applies = \(\) => responseApplies\(question, \{ seq: this\.seq, doc: view\.state\.doc, mounted: view\.dom\.isConnected \}\);/);
    assert.match(s.cmd, /if \(!applies\(\)\) return;\n\s+if \(!locations\.length\) \{ if \(beforehand\) view\.dispatch\(\{ effects: setLink\.of\(null\) \}\); void this\.showLink\(d, w, applies\); return; \} \/\/ no definition, no link — except on a link/, "no dead link (on a link only the link) — the one shown beforehand goes too");
    // FAST: identifiers and remembered ones underlined at once, fetched up front without ⌘, ⌘ attaches to the running question.
    assert.match(s.cmd, /const beforehand = !onlyLink && \(Boolean\(remembered\) \|\| this\.identifier\(w\)\);\n\s+if \(beforehand\) view\.dispatch\(\{ effects: setLink\.of\(\{ \.\.\.w, tooltip: null \}\) \}\);/, "the underline does not wait for the server");
    assert.match(s.cmd, /return n\.from <= w\.from && n\.to >= w\.to && looksLikeTarget\(n\.name\);/);
    assert.match(s.cmd, /if \(!this\.mod\) this\.upfrontSchedule\(\);/, "fetch up front without ⌘");
    assert.match(s.cmd, /const upfront = this\.running\.get\(k\);\n\s+if \(upfront\) return upfront;/, "no second question while the up-front question runs");
    assert.match(s.cmd, /if \(this\.mod \|\| !d \|\| !can\(d, "definition"\) \|\| !view\.dom\.isConnected\) return;/);
    assert.match(s.cmd, /this\.upfrontAbort\?\.abort\(\); \/\/ at most ONE up-front question/, "no avalanche when fetching up front");
    assert.match(s.cmd, /questions\(d, "definition", \{ position: lspPosOf\(doc, w\.from\) \}, abort\.signal\)/);
    assert.match(s.cmd, /if \(!abort\.signal\.aborted && view\.state\.doc === doc\) this\.locations\.remember\(k, locations, Date\.now\(\)\);/);
    assert.match(s.cmd, /\}, remembered \? 0 : DEBOUNCE_MS\);/);
    assert.match(s.cmd, /if \(!applies\(\) \|\| !tip\) return;/, "discard a stale preview");
    assert.match(s.cmd, /this\.timer = setTimeout\(async \(\) => \{\n\s+const locations = onlyLink \? \[\] : await this\.definitions\(d, w\);/, "ask debounced");
    // Preview: several targets only as a hint, 8 rows, tabs at the tab width, link colour.
    assert.match(s.cmd, /if \(locations\.length > 1\) return tooltip\(null, null\);/);
    assert.match(s.cmd, /if \(count > 1 \|\| !rows\) \{[\s\S]{0,160}tr\("Click to show \{n\} definitions\.", \{ n: count \}\)/);
    assert.match(s.cmd, /const v = definitionsPreview\(rows, location\.range\);/);
    assert.match(s.cmd, /dom\.style\.tabSize = String\(view\.state\.tabSize\);/);
    assert.match(s.cmd, /"\.cm-cmd-link": \{ color: "var\(--cb-link-active\)"/);
    assert.match(s.cmd, /rowLoader\(d\.buffer\.target, d\.buffer\.path\)\(location\.file, location\.external \?\? null\)/, "external targets via read as the peek");
    assert.match(s.hover, /if \(!can\(d, "hover"\) \|\| cmdPressed\(view\)\) return null;/, "the normal hover is silent on ⌘");
    assert.match(s.addon, /lspHover, cmdHover, lspDiagnostics/);
  },
  abort(s) {
    // The signal of the ⌘ hover reaches down to the fetch.
    assert.match(s.core, /=> questionBuffer\(d\.buffer, action, body, signal\);/);
    assert.match(s.core, /const r = await lspQuestion\(p, action, body, signal\);/);
    assert.match(s.api, /\{ \.\.\.body, file, buffer, version, \.\.\.\(t \? \{ text \} : \{\}\) \}, signal\);/);
    assert.match(s.api, /transport<T>\(lspPath\(target, action\), \{ method: "POST", body: JSON\.stringify\(body\), \.\.\.\(signal \? \{ signal \} : \{\}\) \}\);/);
  },
  hover(s) {
    assert.match(s.hover, /const sections = hoverSections\(r\.contents\);/);
    assert.match(s.hover, /const k = hoverNode\(sections, \(t\) => colorize\(v\.state, t\.text, /, "code in the colours of the editor");
    assert.match(s.hover, /k\.dom\.style\.tabSize = String\(v\.state\.tabSize\);/, "tabs at the tab width of the editor");
    assert.match(s.lspTheme, /"\.cm-lsp-hover": \{ maxWidth: "500px", maxHeight: "320px", overflow: "auto"/);
    assert.match(s.lspTheme, /"\.cm-hover-section \+ \.cm-hover-section": \{ borderTop: "1px solid /, "hairlines between the sections");
  },
  brackets(s) {
    assert.match(s.brackets, /this\.run\.dismissFrom\(start\); \/\/ before it the text \(and its classification\) is unchanged/);
    assert.match(s.brackets, /const start = firstDeviation\(this\.tree, tree, this\.run\.far\);\n\s+if \(start >= 0\) \{ this\.run\.dismissFrom\(start\); fresh = true; \}/);
    assert.match(s.brackets, /this\.run\.further\(to, end, text, notCode\);\n\s+this\.run\.decide\(from, end, text, notCode\);/);
    assert.match(s.brackets, /const notCode = \(a: number, b: number\) => notCodeAreas\(tree, a, b\);/);
    assert.match(s.brackets, /const f = bracketColor\(findings\[i\]\);/);
    assert.doesNotMatch(s.brackets, /\bCAP\b|400[_ ]?000/, "no cap");
  },
  lines(s) {
    assert.match(s.lines, /if \(setting \|\| whole\) this\.unit = detect\(u\.state\);/, "detect once, not at every keystroke");
    assert.match(s.lines, /const setting = u\.startState\.tabSize !== u\.state\.tabSize \|\| getIndentUnit\(u\.startState\) !== getIndentUnit\(u\.state\);/);
    assert.match(s.lines, /if \(fromA === 0 && toA === u\.startState\.doc\.length\) whole = true;/);
    assert.match(s.lines, /const k = `\$\{stages\}:\$\{unit\}:\$\{active\}`;/);
    assert.match(s.lines, /const f = guideCalculator\(n, text, this\.unit, tab, aside\);/);
    assert.match(s.lines, /const guide = activeGuide\(n, f, \(i\) => insetColumns\(text\(i\), tab\) >= 0, marker, Math\.min\(l0, marker\), Math\.max\(l1, marker\)\);/);
    assert.match(s.lines, /d = Decoration\.line\(\{ attributes: \{ style: linesStyle\(stages, unit, active\) \} \}\);/);
  },
  search(s) {
    assert.match(s.search, /search\(\{ top: true, literal: true, createPanel: \(view\) => new SearchPanel\(view\)/);
    assert.match(s.search, /\{ key: "Mod-f", run: \(v\) => openSearch\(v, false\), preventDefault: true, scope: "editor search-panel" \}/);
    assert.match(s.search, /\{ key: MAC \? "Mod-Alt-f" : "Ctrl-h", run: \(v\) => openSearch\(v, true\), preventDefault: true, scope: "editor search-panel" \}/, "⌥⌘F (Ctrl+H) in the search field too");
    assert.match(s.search, /key: MAC \? `Mod-Alt-\$\{b\.toLowerCase\(\)\}` : `Alt-\$\{b\.toLowerCase\(\)\}`, run: toggleInEditor\(kind\)/);
    // This module sets seed and query; an open replace row stays open.
    assert.match(s.search, /const \{ seed, focus \} = searchSeed\(\{ selection, multiline, word: w \? st\.sliceDoc\(w\.from, w\.to\) : null, inWidget, inSearchField: Boolean\(p0 && active === p0\.field\), regexp: prior\.regexp \}, replace\);/);
    assert.match(s.search, /const q = query\(\{ search: seed \?\? prior\.search,/);
    assert.match(s.search, /p\.showReplace\(replace \|\| p\.replaceOpen\);/);
    assert.match(s.search, /this\.replaceOpen = on && !this\.view\.state\.readOnly;/);
    // Search in selection, preserve case, regex message.
    assert.match(s.search, /new SearchQuery\(\{ \.\.\.spec, literal: true, test: inArea \}\)/);
    assert.match(s.search, /return !b \|\| b\.some\(\(r\) => from >= r\.from && to <= r\.to\);/);
    assert.match(s.search, /if \(!v \|\| !searchPanelOpen\(t\.state\)\) return null; \/\/ the range goes with the widget/);
    assert.match(s.search, /preserveCase\(st\.sliceDoc\(t\.from, t\.to\), replacementFor\(q\.replace, q\.regexp, t\.match \? \[\.\.\.t\.match\] : null\)\)/);
    assert.match(s.search, /if \(!preserveCaseOn\.get\(view\)\) return replaceNext\(view\);/);
    assert.match(s.search, /if \(!preserveCaseOn\.get\(view\)\) return replaceAll\(view\);/);
    assert.match(s.search, /const error = regexError\(q\.search, q\.regexp\);\n\s+this\.fieldWrapper\.toggleAttribute\("data-error", error != null\);\n\s+this\.notice\.textContent = error \?\? "";/);
    assert.match(s.search, /"\.cm-search-field\[data-error\] \+ \.cm-search-notice": \{ display: "block" \}/);
    // Keys in the widget, history.
    assert.match(s.search, /const a = searchKey\(e, field, MAC, this\.replaceOpen\);\n\s+if \(!a\) \{ if \(runScopeHandlers\(view, e, "search-panel"\)\) e\.preventDefault\(\); return; \}/);
    assert.match(s.search, /const value = a\.kind === "historyBack" \? history\.back\(target\.value\) : history\.before\(target\.value\);/);
    // Room above the first row and no hit below the widget.
    assert.match(s.search, /areaField, areaDeco, gapField,/);
    assert.match(s.search, /Decoration\.widget\(\{ widget: new Gap\(\), block: true, side: -1 \}\)\.range\(0\)/);
    assert.match(s.search, /"\.cm-search-gap": \{ height: "var\(--cb-search-height, 33px\)" \}/);
    assert.match(s.search, /this\.view\.dom\.style\.setProperty\("--cb-search-height", `\$\{h\}px`\);/);
    assert.match(s.search, /EditorView\.scrollMargins\.of\(\(view\) => \{ const p = searchPanelOpen\(view\.state\) \? panels\.get\(view\) : null; return p \? \{ top: p\.height \} : null; \}\)/);
    // Counter and ticks, form.
    assert.match(s.search, /counts = countHits\(\{ \[Symbol\.iterator\]: \(\) => it \}, st\.selection\.main, undefined, findings\);/);
    assert.match(s.search, /const a = counterDisplay\(q\.search, q\.valid, counts\);/);
    assert.match(s.search, /const mod = \(\) => \(MAC \? "⌘" : tr\("Ctrl\+"\)\);/);
    assert.match(s.search, /\{ id: "actions\.find", title: "Search", shortcut: MAC \? "⌘F" : "⌃F"/, "Search in the palette");
    assert.match(s.search, /"\.cm-search": \{\n\s+position: "absolute", top: "0", right: "14px"/, "floating at the top right");
    assert.match(s.search, /"\.cm-search-wrapper": \{ position: "relative", height: "0", overflow: "visible" \}/, "the bar itself does not shift the text");
    assert.doesNotMatch(s.search, /fontSize: "\d/, "font via textPx (text size of the app)");
  },
  mac(s) {
    for (const [name, q] of [["cmd-hover", s.cmd], ["search-widget", s.search], ["lsp-navigation", s.navigation]]) {
      assert.match(q, /^import \{ isMac \} from "@\/lib\/chat-bar";$/m, `${name}: isMac aus lib/chat-bar`);
      assert.doesNotMatch(q, /navigator\.(platform|userAgent)|IS_MAC/, `${name}: a Mac detection of its own`);
    }
  },
  texts(s) {
    for (const k of ["Find in Selection", "Preserve Case", "Ctrl+", "Click to collapse the range.", "Click to expand the range.", "Click to show {n} definitions."]) {
      assert.ok(s.i18n.includes(`  ${JSON.stringify(k)}: "`), `i18n-de.ts: ${k}`);
    }
  },
  gutters(s) {
    // Where the margins are hooked in; the order that follows from it is measured in (1) against CodeMirror.
    assert.match(s.codePane, /^import \{ glyphMargin \} from "@\/components\/code\/gutters";$/m);
    assert.match(s.codePane, /\n\s+if \(activePath\) list\.push\(glyphMargin\(breakpointGutter\(/, "breakpoints in the glyph margin");
    assert.match(s.codePane, /\n\s+list\.push\(gitMargin\(paLoaded, t\), cursorReporter\);/, "the git margin without level, between line numbers and fold arrows");
    assert.doesNotMatch(s.codePane, /lineNumbers/, "the line numbers come from basicSetup — own ones would stand behind the git margin");
    assert.match(s.actions, /^export const lspBulb: Extension = \[bulbField, bulbQuestions, glyphMargin\(bulbMargin\)\];$/m, "the light bulb in the glyph margin");
    assert.match(s.fold, /^export const foldMargin: Extension = \[marginAtText\(foldGutter\(/m, "the fold arrows at the text");
    // In between the indentation of the file (components/code/indentation.ts) — it carries no margin.
    assert.match(s.buffer, /const config = \(\): Extension => \[basicSetup\(run\.current\.setup\), keymap\.of\(\[indentWithTab\]\), indentation\(run\.current\.setup\.tabSize \?\? 4\), run\.current\.extensions\];/, "basicSetup (line numbers) before the extensions of the view");
    assert.doesNotMatch(s.gitGutter, /\bPrec\.(high|highest|low|lowest)\(/, "the git margin without a level of its own");
    // Diff tab like the diff of VS Code: no git margin, no fold arrows.
    assert.doesNotMatch(s.diff, /\bgitMargin\b|\bfoldMargin\b|foldGutter\(/);
  },
  noLintMargin(s) {
    assert.doesNotMatch(s.all, /\blintGutter\s*\(/, "a margin with a dot per error row — VS Code has none");
  },
};
const B_SABOTAGES = [
  { name: "control word blue", file: "theme", old: "controlWord: \"#c586c0\"", fresh: "controlWord: \"#569cd6\"", catches: "theme" },
  { name: "selection light dark", file: "theme", old: "\"--cb-selection\": \"#add6ff\"", fresh: "\"--cb-selection\": \"#264f78\"", catches: "theme" },
  { name: "call as variable", file: "theme", old: "{ tag: [t.function(t.variableName), ", fresh: "{ tag: [", catches: "theme" },
  { name: "row as fill", file: "theme", old: "\".cm-activeLine\": { backgroundColor: \"transparent\", boxShadow: \"inset 0 0 0 2px var(--cb-line-highlight-border)\" }", fresh: "\".cm-activeLine\": { backgroundColor: \"var(--cb-line-highlight-border)\" }", catches: "theme" },
  { name: "dark without marker", file: "theme", old: "Prec.highest(syntaxHighlighting(darkHighlightStyle)), EditorView.darkTheme.of(true)]", fresh: "Prec.highest(syntaxHighlighting(darkHighlightStyle))]", catches: "theme" },
  { name: "always light", file: "theme", old: "{ themeType: \"light\" }", fresh: "{}", catches: "theme" },
  { name: "search missing", file: "theme", old: "bracketColors, indentationLines, searchWidget,", fresh: "bracketColors, indentationLines,", catches: "theme" },
  { name: "language colours missing", file: "theme", old: "syntaxHighlighting(lightHighlightStyle), languageColors, bracketColors", fresh: "syntaxHighlighting(lightHighlightStyle), bracketColors", catches: "theme" },
  { name: "fold arrow light like dark", file: "theme", old: "\"--cb-fold\": \"#424242\"", fresh: "\"--cb-fold\": \"#c5c5c5\"", catches: "theme" },
  { name: "link light", file: "theme", old: "\"--cb-link-active\": \"#0000ff\"", fresh: "\"--cb-link-active\": \"#005fb8\"", catches: "theme" },
  { name: "YAML key light blue", file: "theme", old: "\"--cb-yaml-key\": \"#800000\"", fresh: "\"--cb-yaml-key\": \"#0000ff\"", catches: "theme" },
  { name: "selectors everywhere", file: "theme", old: ".scope = (type) => top.includes(type.name);", fresh: ".scope = () => true;", catches: "theme" },
  { name: "CSS root wrong", file: "theme", old: "export const CSS_TOP = [\"StyleSheet\"];", fresh: "export const CSS_TOP = [\"Stylesheet\"];", catches: "theme" },
  { name: "two fold margins", file: "codePane", old: "highlightActiveLine: true, foldGutter: false }}", fresh: "highlightActiveLine: true, foldGutter: true }}", catches: "fold" },
  { name: "folded without arrow", file: "fold", old: "if (open) s.setAttribute(\"data-open\", \"\");", fresh: "s.setAttribute(\"data-open\", \"\");", catches: "fold" },
  { name: "arrows always", file: "fold", old: "\".cm-fold[data-open]\": { opacity: \"0\" },", fresh: "", catches: "fold" },
  { name: "arrow without name", file: "fold", old: "s.setAttribute(\"aria-label\", name);", fresh: "", catches: "fold" },
  { name: "folded without background", file: "fold", old: "foldGutter({ markerDOM: arrow })), foldedRows, form]", fresh: "foldGutter({ markerDOM: arrow })), form]", catches: "fold" },
  { name: "⌘ at the window", file: "cmd", old: "onEditor(\"keydown\", (e) => this.key(e));", fresh: "window.addEventListener(\"keydown\", (e) => this.key(e));", catches: "cmdHover" },
  { name: "every blur", file: "cmd", old: "if (e.target === window) for", fresh: "for", catches: "cmdHover" },
  { name: "never deregistered", file: "cmd", old: "if (prior && !views.size) { window.removeEventListener(\"keyup\", released, true); window.removeEventListener(\"blur\", windowWay); }", fresh: "", catches: "cmdHover" },
  { name: "no cancellation", file: "cmd", old: "this.abort?.abort();", fresh: "", catches: "cmdHover" },
  { name: "signal missing", file: "cmd", old: "this.view.state.doc, w.from) }, abort.signal)", fresh: "this.view.state.doc, w.from) })", catches: "cmdHover" },
  { name: "up front without signal", file: "cmd", old: "lspPosOf(doc, w.from) }, abort.signal)", fresh: "lspPosOf(doc, w.from) })", catches: "cmdHover" },
  { name: "cancelled ones remembered", file: "cmd", old: "if (!abort.signal.aborted) ", fresh: "", catches: "cmdHover" },
  { name: "avalanche", file: "cmd", old: "if (remembered) return remembered;", fresh: "", catches: "cmdHover" },
  { name: "old locations after typing", file: "cmd", old: "this.locations.empty();", fresh: "", catches: "cmdHover" },
  { name: "always applies", file: "cmd", old: "const applies = () => responseApplies(question, { seq: this.seq, doc: view.state.doc, mounted: view.dom.isConnected });", fresh: "const applies = () => true;", catches: "cmdHover" },
  { name: "dead link", file: "cmd", old: "void this.showLink(d, w, applies); return; } // no definition, no link", fresh: "void this.showLink(d, w, applies); } // no definition, no Link", catches: "cmdHover" },
  { name: "up-front link stays", file: "cmd", old: "if (beforehand) view.dispatch({ effects: setLink.of(null) }); ", fresh: "", catches: "cmdHover" },
  { name: "waits for the server", file: "cmd", old: "if (beforehand) view.dispatch({ effects: setLink.of({ ...w, tooltip: null }) });", fresh: "", catches: "cmdHover" },
  { name: "never up front", file: "cmd", old: "if (!this.mod) this.upfrontSchedule();", fresh: "", catches: "cmdHover" },
  { name: "asked twice", file: "cmd", old: "if (upfront) return upfront;", fresh: "", catches: "cmdHover" },
  { name: "up-front avalanche", file: "cmd", old: "this.upfrontAbort?.abort(); // at most ONE", fresh: "// at most ONE", catches: "cmdHover" },
  { name: "up front with ⌘", file: "cmd", old: "if (this.mod || !d || !can(d, \"definition\")", fresh: "if (!d || !can(d, \"definition\")", catches: "cmdHover" },
  { name: "first of several", file: "cmd", old: "if (locations.length > 1) return tooltip(null, null);", fresh: "", catches: "cmdHover" },
  { name: "preview with fixed tab width", file: "cmd", old: "dom.style.tabSize = String(view.state.tabSize);", fresh: "", catches: "cmdHover" },
  { name: "link colour", file: "cmd", old: "\".cm-cmd-link\": { color: \"var(--cb-link-active)\"", fresh: "\".cm-cmd-link\": { color: \"var(--cb-link)\"", catches: "cmdHover" },
  { name: "two hovers on ⌘", file: "hover", old: "if (!can(d, \"hover\") || cmdPressed(view)) return null;", fresh: "if (!can(d, \"hover\")) return null;", catches: "cmdHover" },
  { name: "⌘ hover not hooked in", file: "addon", old: "lspHover, cmdHover, lspDiagnostics", fresh: "lspHover, lspDiagnostics", catches: "cmdHover" },
  { name: "signal lost in the core", file: "core", old: "const r = await lspQuestion(p, action, body, signal);", fresh: "const r = await lspQuestion(p, action, body);", catches: "abort" },
  { name: "signal not at the fetch", file: "api", old: "...(signal ? { signal } : {})", fresh: "", catches: "abort" },
  { name: "hover with fixed tab width", file: "hover", old: "k.dom.style.tabSize = String(v.state.tabSize);", fresh: "", catches: "hover" },
  { name: "hover too wide", file: "lspTheme", old: "\".cm-lsp-hover\": { maxWidth: \"500px\"", fresh: "\".cm-lsp-hover\": { maxWidth: \"720px\"", catches: "hover" },
  { name: "no hairline", file: "lspTheme", old: "\".cm-hover-section + .cm-hover-section\": { borderTop: \"1px solid ", fresh: "\".cm-hover-section + .cm-hover-section\": { marginTop: \"1px solid ", catches: "hover" },
  { name: "text changed, brackets not", file: "brackets", old: "this.run.dismissFrom(start); // before it the text", fresh: "// beforehand", catches: "brackets" },
  { name: "new tree without recomputation", file: "brackets", old: "if (start >= 0) { this.run.dismissFrom(start); fresh = true; }", fresh: "", catches: "brackets" },
  { name: "visible ones undecided", file: "brackets", old: "this.run.decide(from, end, text, notCode);", fresh: "", catches: "brackets" },
  { name: "brackets with cap", file: "brackets", old: "const MARKERS = ", fresh: "const CAP = 400000;\nconst MARKERS = ", catches: "brackets" },
  { name: "unit at every keystroke", file: "lines", old: "if (setting || whole) this.unit = detect(u.state);", fresh: "if (u.docChanged || setting) this.unit = detect(u.state);", catches: "lines" },
  { name: "tab width irrelevant", file: "lines", old: "u.startState.tabSize !== u.state.tabSize || ", fresh: "", catches: "lines" },
  { name: "unit not in the key", file: "lines", old: "const k = `${stages}:${unit}:${active}`;", fresh: "const k = `${stages}:${active}`;", catches: "lines" },
  { name: "active block only in view", file: "lines", old: "marker, Math.min(l0, marker), Math.max(l1, marker));", fresh: "marker, l0, l1);", catches: "lines" },
  { name: "search at the bottom", file: "search", old: "search({ top: true,", fresh: "search({ top: false,", catches: "search" },
  { name: "⌥⌘F only in the text", file: "search", old: "openSearch(v, true), preventDefault: true, scope: \"editor search-panel\" }", fresh: "openSearch(v, true), preventDefault: true }", catches: "search" },
  { name: "no Ctrl+H", file: "search", old: "{ key: MAC ? \"Mod-Alt-f\" : \"Ctrl-h\",", fresh: "{ key: \"Mod-Alt-f\",", catches: "search" },
  { name: "replace collapses", file: "search", old: "p.showReplace(replace || p.replaceOpen);", fresh: "p.showReplace(replace);", catches: "search" },
  { name: "CodeMirror seeds", file: "search", old: "search: seed ?? prior.search,", fresh: "search: seed ?? getSearchQuery(view.state).search,", catches: "search" },
  { name: "replace read-only", file: "search", old: "this.replaceOpen = on && !this.view.state.readOnly;", fresh: "this.replaceOpen = on;", catches: "search" },
  { name: "selection without filter", file: "search", old: "literal: true, test: inArea })", fresh: "literal: true })", catches: "search" },
  { name: "range stays", file: "search", old: "if (!v || !searchPanelOpen(t.state)) return null;", fresh: "if (!v) return null;", catches: "search" },
  { name: "case never", file: "search", old: "if (!preserveCaseOn.get(view)) return replaceNext(view);", fresh: "return replaceNext(view);", catches: "search" },
  { name: "no red edge", file: "search", old: "this.fieldWrapper.toggleAttribute(\"data-error\", error != null);", fresh: "", catches: "search" },
  { name: "⌥⌘F dead in the field", file: "search", old: "if (!a) { if (runScopeHandlers(view, e, \"search-panel\")) e.preventDefault(); return; }", fresh: "if (!a) return;", catches: "search" },
  { name: "history dead", file: "search", old: "const value = a.kind === \"historyBack\" ? history.back(target.value) : history.before(target.value);", fresh: "const value: string | null = null;", catches: "search" },
  { name: "no room at the top", file: "search", old: "areaField, areaDeco, gapField,", fresh: "areaField, areaDeco,", catches: "search" },
  { name: "hit below the widget", file: "search", old: "return p ? { top: p.height } : null;", fresh: "return null;", catches: "search" },
  { name: "ticks without positions", file: "search", old: "st.selection.main, undefined, findings);", fresh: "st.selection.main);", catches: "search" },
  { name: "Ctrl+ hard-coded", file: "search", old: "tr(\"Ctrl+\")", fresh: "\"Ctrl+\"", catches: "search" },
  { name: "fixed font size", file: "search", old: "padding: \"0 6px\", fontSize: textPx(12)", fresh: "padding: \"0 6px\", fontSize: \"12px\"", catches: "search" },
  { name: "bar shifts the text", file: "search", old: "\".cm-search-wrapper\": { position: \"relative\", height: \"0\", overflow: \"visible\" }", fresh: "\".cm-search-wrapper\": { position: \"relative\" }", catches: "search" },
  { name: "own Mac detection", file: "navigation", old: "!(isMac() ? e.metaKey : e.ctrlKey)", fresh: "!(/Mac/.test(navigator.platform) ? e.metaKey : e.ctrlKey)", catches: "mac" },
  { name: "second IS_MAC", file: "cmd", old: "const modKey = () => (isMac() ? \"Meta\" : \"Control\");", fresh: "const IS_MAC = isMac();\nconst modKey = () => (IS_MAC ? \"Meta\" : \"Control\");", catches: "mac" },
  { name: "text without translation", file: "i18n", old: "  \"Ctrl+\": \"Strg+\",\n", fresh: "", catches: "texts" },
  { name: "breakpoints without glyph margin", file: "codePane", old: "list.push(glyphMargin(breakpointGutter(breakpoints[activePath] || [], (line) => toggleBreakpoint(line, activePath))));", fresh: "list.push(breakpointGutter(breakpoints[activePath] || [], (line) => toggleBreakpoint(line, activePath)));", catches: "gutters" },
  { name: "git margin with level", file: "codePane", old: "list.push(gitMargin(paLoaded, t), cursorReporter);", fresh: "list.push(marginAtText(gitMargin(paLoaded, t)), cursorReporter);", catches: "gutters" },
  { name: "own line numbers", file: "codePane", old: "highlightActiveLine: true, foldGutter: false }}", fresh: "highlightActiveLine: true, foldGutter: false, lineNumbers: false }}", catches: "gutters" },
  { name: "light bulb without glyph margin", file: "actions", old: "glyphMargin(bulbMargin)]", fresh: "bulbMargin]", catches: "gutters" },
  { name: "fold arrows without level", file: "fold", old: "marginAtText(foldGutter({ markerDOM: arrow }))", fresh: "foldGutter({ markerDOM: arrow })", catches: "gutters" },
  { name: "extensions before basicSetup", file: "buffer", old: "[basicSetup(run.current.setup), keymap.of([indentWithTab]), indentation(run.current.setup.tabSize ?? 4), run.current.extensions]", fresh: "[run.current.extensions, basicSetup(run.current.setup), keymap.of([indentWithTab]), indentation(run.current.setup.tabSize ?? 4)]", catches: "gutters" },
  { name: "git margin with its own level", file: "gitGutter", old: "    gutter({\n      class: \"cm-gitMarginColumn\",", fresh: "    Prec.low(gutter({\n      class: \"cm-gitMarginColumn\",", catches: "gutters" },
  { name: "fold arrows in the diff", file: "diff", old: "basicSetup({ lineNumbers: false, foldGutter: false,", fresh: "foldMargin, basicSetup({ lineNumbers: false, foldGutter: false,", catches: "gutters" },
  { name: "lint margin back", file: "all", old: "linter(async (view) => {", fresh: "lintGutter(), linter(async (view) => {", catches: "noLintMargin" },
  { name: "lint margin in the bundle", file: "all", old: "lspHover, cmdHover, lspDiagnostics", fresh: "lspHover, cmdHover, lintGutter(), lspDiagnostics", catches: "noLintMargin" },
];

test("(2) bindings: theme, fold arrows, ⌘ hover, hover, brackets, guides, search, Mac, texts, gutters, no lint margin", () => {
  for (const [k, f] of Object.entries(BINDINGS)) { try { f(B); } catch (e) { throw new Error(`${k}: ${e.message}`); } }
});
test("(2) no lint margin: linter() alone draws no margin — the counter-test lintGutter() draws one", () => {
  assert.deepEqual(marginQueue([linter(() => [])]), [], "the linter (squiggle, hover) brings no margin");
  assert.deepEqual(marginQueue([linter(() => []), lintGutter()]), ["cm-gutter-lint"], "the measurement sees a lint margin when there is one");
});
test("(2) counter-tests of the bindings: every sabotage occurs exactly once and is caught", () => {
  const stale = B_SABOTAGES.filter((x) => B[x.file].split(x.old).length - 1 !== 1).map((x) => x.name);
  assert.deepEqual(stale, [], "sabotages whose spot does not occur exactly once in the source");
  const notCaught = B_SABOTAGES.filter((x) => {
    const s = { ...B, [x.file]: B[x.file].replace(x.old, () => x.fresh) };
    try { BINDINGS[x.catches](s); return true; } catch { return false; }
  }).map((x) => `${x.name} (${x.catches})`);
  assert.deepEqual(notCaught, [], "sabotages that no check catches");
  const without = Object.keys(BINDINGS).filter((k) => !B_SABOTAGES.some((x) => x.catches === k));
  assert.deepEqual(without, [], "bindings without sabotage");
  console.log(`  [editor-look] bindings: ${Object.keys(BINDINGS).length} checks, ${B_SABOTAGES.length} sabotages, each caught`);
});
