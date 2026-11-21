// The search across files as in VS Code, web side.
//
// (1) The computation (lib/file-search.ts), EXECUTED: hits of a line with the three switches (Aa, ab, .*); the replacement of a hit like
//     VS Code ReplacePattern ($0, $&, $1...$99 including decay, $$, \n, \t, \\, \u \U \l \L) and "preserve case"; the plan of "Replace
//     All" (only the displayed hits, each checked at its place with the SAME fields - other fields replace nothing); the list (ONE row
//     per hit, the number in the header = the number of rows, CRLF, unsaved buffers instead of the disk); singular/plural like VS
//     Code; the masked folder of "Find in Folder..."; the preview like VS Code (`lcut`); `sameFields`.
// (2) The binding to the server (runtime/fileAccess.js - B and the program in the container): the same hits (`searchPattern`), the
//     same lines and columns (`searchLines`, also with CRLF), and the masked folder hits exactly itself in the server.
// (3) "Replace All" (lib/search-replace.ts) EXECUTED through lib/buffer.ts against a fake server (GET files/read, PUT files/write with
//     `base`/409 like server files.js): other fields replace nothing (an old version replaced every "f"), only the displayed hits, a
//     409 overwrites nothing and stays as a tab, a file with unsaved changes is not saved, a shifted text counts as stale, Undo
//     restores the disk and leaves what changed since.
// (4) The sources: SearchView asks with all fields including the open buffers, carries the fields with the results and allows "Replace
//     All" only with applicable results, notice reset, tree for the keyboard, jump with column and selection; CodePane masks the folder
//     and jumps with selection, the outline to the name; the navigation carries the end of the selection.
//
// Each sabotage is a copy of the source with ONE changed spot (exactly once there); the assigned check must fail on it.
//
// Run:  node --test --test-reporter=tap web/test/file-search.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");
const read = (...p) => fs.readFileSync(path.join(webDir, ...p), "utf8");

const SOURCE = read("src", "lib", "file-search.ts");
const REPLACE = read("src", "lib", "search-replace.ts");
const SABOTAGES = {
  "whole word ignored": { old: "if (!o.wholeWord || wholeTerm(row, s, e))", fresh: "if (true)", catches: "find" },
  "separator at the hit does not count": { old: "(s === 0 || separator(z[s - 1]) || (e > s && separator(z[s])))", fresh: "(s === 0 || separator(z[s - 1]))", catches: "find" },
  "no boundary on the right": { old: "&& (e === z.length || separator(z[e]) || (e > s && separator(z[e - 1])))", fresh: "&& true", catches: "find" },
  "not escaped": { old: "o.regex ? o.query : o.query.replace(", fresh: "true ? o.query : o.query.replace(", catches: "find" },
  "case swapped": { old: "o.caseSensitive ? \"g\" : \"gi\"", fresh: "o.caseSensitive ? \"gi\" : \"g\"", catches: "find" },
  "empty hit does not advance": { old: "re.lastIndex = s + 1;", fresh: "re.lastIndex = s;", catches: "find" },
  "without .* not literal": { old: "if (!regex) return preserved ? preserveSpelling(hits, replacement) : replacement;", fresh: "", catches: "replacement" },
  "$0 missing": { old: "if (n === \"0\" || n === \"&\") { group(0); i++; continue; }", fresh: "if (n === \"&\") { group(0); i++; continue; }", catches: "replacement" },
  "$nn missing": { old: "if (z !== undefined && z >= \"0\" && z <= \"9\") { group(Number(n + z)); i += 2; continue; }", fresh: "", catches: "replacement" },
  "group does not decay": { old: "rest = String(n % 10) + rest;", fresh: "return \"\";", catches: "replacement" },
  "\\u without effect": { old: "else if (f === \"u\") { out += s[i].toUpperCase(); op++; }", fresh: "else if (f === \"u\") { out += s[i]; op++; }", catches: "replacement" },
  "\\U only one character": { old: "if (f === \"U\") out += s[i].toUpperCase();", fresh: "if (f === \"U\") { out += s[i].toUpperCase(); op++; }", catches: "replacement" },
  "\\n not translated": { old: "if (n === \"n\") { text += \"\\n\"; i++; continue; }", fresh: "if (n === \"n\") { text += \"n\"; i++; continue; }", catches: "replacement" },
  "AB without parts": { old: "if (withBind !== withUnder) {", fresh: "if (false) {", catches: "preserved" },
  "AB all caps missing": { old: "if (hits.toUpperCase() === hits) return replacement.toUpperCase();", fresh: "", catches: "preserved" },
  "AB also with groups": { old: "if (chunks.every((s) => \"text\" in s)) {", fresh: "if (true) {", catches: "preserved" },
  "replace counts lines": { old: "count += f.length;", fresh: "count += 1;", catches: "replace" },
  "replace only the first": { old: "at = x.end; }", fresh: "at = x.end; break; }", catches: "replace" },
  "plan does not check the spot": { old: "const x = f.find((y) => y.start === t.from && y.end === t.until);", fresh: "const x = f[0];", catches: "plan" },
  "plan without CR": { old: "if (z.endsWith(\"\\r\")) z = z.slice(0, -1); return { a, z };", fresh: "return { a, z };", catches: "plan" },
  "lines without CR": { old: "    if (z.endsWith(\"\\r\")) z = z.slice(0, -1);\n    const f = citations(z, o, max - n);", fresh: "    const f = citations(z, o, max - n);", catches: "list" },
  "list per line instead of per hit": { old: ".map(([from, until]) => ({ row: m.line, from, until, text: m.text }))", fresh: ".slice(0, 1).map(([from, until]) => ({ row: m.line, from, until, text: m.text }))", catches: "list" },
  "buffer not instead of the disk": { old: "const kept = results.filter((e) => !buffer.has(e.path));", fresh: "const kept = [...results];", catches: "list" },
  "header without singular": { old: "if (m === 1) return \"{n} results in 1 file\";", fresh: "", catches: "key" },
  "does not escape the comma": { old: "path.replace(/[*?[\\]{},]/g, \"[$&]\")", fresh: "path.replace(/[*?[\\]{}]/g, \"[$&]\")", catches: "masked" },
  "preview without lcut": { old: "const before = lcut(text.slice(0, from), 26, \"…\");", fresh: "const before = text.slice(0, from);", catches: "preview" },
  "sameFields without filter": { old: "&& a!.include === b!.include", fresh: "", catches: "fields" },
  "sameFields without switch": { old: " && a!.exclusions === b!.exclusions", fresh: "", catches: "fields" },
};
const REPLACE_SABOTAGES = {
  "replaces like the old version (every hit of the current fields)": { old: "const plan = replacePlan(prior, d.hits, o.fields, o.replacement, o.preserved);", fresh: "const plan = { areas: [{ from: 0, to: prior.length, insert: prior.split(o.fields.query).join(o.replacement) }], stale: 0 };", catches: "fields" },
  "saves unsaved changes": { old: "if (wasUnsaved) { o.editor.openInBackground(p); entry.push({ target: k.target, path: k.path, display: d.path, prior, after, saved: false }); continue; }", fresh: "", catches: "unsaved" },
  "409 silent": { old: "{ notSaved.push(d.path); o.editor.openInBackground(p); } // 409", fresh: "{ } // 409", catches: "conflict" },
  "undo without check": { old: "if (p.status.state !== \"loaded\" || p.text !== d.after) { changed.push(d.display); continue; }", fresh: "if (p.status.state !== \"loaded\") { changed.push(d.display); continue; }", catches: "undo" },
  "undo does not save": { old: "if (!d.saved) { ed.openInBackground(p); continue; }", fresh: "if (true) { ed.openInBackground(p); continue; }", catches: "undo" },
  "without entry": { old: "entry: entry.length ? { files: entry } : null", fresh: "entry: null", catches: "undo" },
};

// ── Compile: file-search, search-replace, the buffer with its computations and one copy per sabotage, in ONE tsc run. `api/core.ts` is a
// stand-in without network - the test sets the transport. Type errors count only in the real sources.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-file-search-"));
const src = path.join(tmp, "src"), out = path.join(tmp, "out");
fs.mkdirSync(path.join(src, "api"), { recursive: true });
for (const f of ["buffer.ts", "file-status.ts", "code-instance.ts", "diff-tab.ts", "chat-tabs.ts"]) fs.writeFileSync(path.join(src, f), read("src", "lib", f));
fs.writeFileSync(path.join(src, "api", "core.ts"), "export async function api<T = unknown>(p: string, _o?: RequestInit): Promise<T> { throw new Error(`no network in test: ${p}`); }\n");
fs.writeFileSync(path.join(src, "file-search.ts"), SOURCE);
fs.writeFileSync(path.join(src, "search-replace.ts"), REPLACE);
const copies = [];
for (const [name, s] of Object.entries(SABOTAGES)) {
  const file = `file-search-sabotage-${copies.length}.ts`;
  fs.writeFileSync(path.join(src, file), SOURCE.replace(s.old, () => s.fresh));
  copies.push({ name, file, catches: s.catches, places: SOURCE.split(s.old).length - 1 });
}
const replaceCopies = Object.entries(REPLACE_SABOTAGES).map(([name, s], i) => {
  const file = `search-replace-sabotage-${i}.ts`;
  fs.writeFileSync(path.join(src, file), REPLACE.replace(s.old, () => s.fresh));
  return { name, file, catches: s.catches, places: REPLACE.split(s.old).length - 1 };
});
const allTs = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? allTs(path.join(dir, e.name)) : [path.join(dir, e.name)]));
try {
  execFileSync(process.execPath, [tsc, ...allTs(src), "--outDir", out, "--rootDir", src, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler", "--strict", "--skipLibCheck", "--lib", "es2022,dom"], { stdio: "pipe" });
} catch (e) {
  const text = `${String(e.stdout || "")}${String(e.stderr || "")}`;
  const realError = text.split("\n").filter((z) => /error TS\d+/.test(z) && !/-sabotage-\d+\.ts\(/.test(z));
  if (realError.length || !fs.existsSync(path.join(out, "file-search.js"))) throw new Error(`tsc: ${text}`.slice(0, 4000));
}
const load = (file) => import(pathToFileURL(path.join(out, file.replace(/\.ts$/, ".js"))).href);
const real = await load("file-search.ts");
const sabotaged = await Promise.all(copies.map(async (k) => ({ ...k, mod: await load(k.file) })));
const replaceReal = await load("search-replace.ts");
const replaceSabotaged = await Promise.all(replaceCopies.map(async (k) => ({ ...k, mod: await load(k.file) })));
const P = await load("buffer.ts");
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { console.warn("[test] temp directory left behind:", String(e?.message || e).slice(0, 120)); }

const O = (o) => ({ query: "foo", regex: false, caseSensitive: false, wholeWord: false, ...o });
const F = (o) => ({ ...O(o), include: "", exclude: "", exclusions: true, ...o });
const positions = (f) => f.map((x) => [x.start, x.end]);
const T = (row, from, until, text = "") => ({ row, from, until, text });

const CHECKS = {
  find(D) {
    assert.deepEqual(positions(D.citations("foo foobar foo_x (foo) xfoo foo", O({ wholeWord: true }))), [[0, 3], [18, 21], [28, 31]], "whole word");
    assert.deepEqual(positions(D.citations("x(foo y", O({ query: "(foo", wholeWord: true }))), [[1, 5]], "a separator at the start of the hit is a boundary");
    assert.deepEqual(positions(D.citations("foo foobar", O())), [[0, 3], [4, 7]]);
    assert.deepEqual(positions(D.citations("abc a.c", O({ query: "a.c" }))), [[4, 7]], "without .* literal");
    assert.deepEqual(positions(D.citations("abc a.c", O({ query: "a.c", regex: true }))), [[0, 3], [4, 7]]);
    assert.deepEqual(positions(D.citations("foo FOO", O({ query: "FOO", caseSensitive: true }))), [[4, 7]]);
    assert.deepEqual(positions(D.citations("foo FOO", O({ query: "FOO" }))), [[0, 3], [4, 7]]);
    assert.equal(D.citations("abc", O({ query: "x*", regex: true })).length, 4, "an empty hit advances");
    assert.deepEqual(D.citations("foo", O({ query: "" })), [], "an empty query finds nothing");
    assert.deepEqual(D.citations("foo", O({ query: "(", regex: true })), [], "an invalid expression finds nothing");
    assert.ok("error" in D.searchExpression(O({ query: "(", regex: true })));
  },
  replacement(D) {
    const E = (e, tr, g, rx = true) => D.substituteFor(e, tr, g, rx);
    assert.equal(E("$1", "abc", ["b"], false), "$1", "without .* literal");
    assert.equal(E("<$1>", "abc", ["b"]), "<b>");
    assert.equal(E("[$&]", "abc", []), "[abc]");
    assert.equal(E("[$0]", "abc", []), "[abc]", "$0 is the hit");
    assert.equal(E("$$1", "abc", ["b"]), "$1");
    assert.equal(E("a\\nb\\tc\\\\", "x", []), "a\nb\tc\\");
    assert.equal(E("\\x", "x", []), "\\x", "an unknown sequence stays");
    assert.equal(E("$2", "x", ["a"]), "$2", "a group that does not exist stays, as in VS Code");
    assert.equal(E("$10", "x", ["a"]), "a0", "$10 with one group: group 1 and \"0\"");
    assert.equal(E("$10", "x", ["1", "2", "3", "4", "5", "6", "7", "8", "9", "ten"]), "ten", "$10 as group 10");
    assert.equal(E("\\u$1", "x", ["abc"]), "Abc", "\\u: the first character upper case");
    assert.equal(E("\\U$1", "x", ["abc"]), "ABC", "\\U: the whole group upper case");
    assert.equal(E("\\l$1", "x", ["ABC"]), "aBC");
    assert.equal(E("\\L$1", "x", ["ABC"]), "abc");
    assert.equal(E("\\u\\l$1-$1", "x", ["ab"]), "Ab-ab", "the cases apply only to the next group");
  },
  preserved(D) {
    const H = D.preserveSpelling;
    assert.equal(H("FOO", "bar"), "BAR", "all upper case");
    assert.equal(H("foo", "Bar"), "bar", "all lower case");
    assert.equal(H("Foo", "bar"), "Bar", "first letter upper case");
    assert.equal(H("fOO", "Bar"), "bar", "first letter lower case");
    assert.equal(H("foo-Bar", "baz-qux"), "baz-Qux", "per part with -");
    assert.equal(H("foo_BAR", "baz_qux"), "baz_QUX", "per part with _");
    assert.equal(D.substituteFor("bar", "FOO", undefined, false, true), "BAR", "without .* with AB");
    assert.equal(D.substituteFor("bar", "Foo", undefined, true, true), "Bar", "with .* without group with AB");
    assert.equal(D.substituteFor("$1x", "FOO", ["o"], true, true), "ox", "with groups AB does not apply (like VS Code)");
  },
  replace(D) {
    assert.deepEqual(D.replace("foo foo\nbar\nfoo", O(), "X"), { text: "X X\nbar\nX", count: 3 });
    assert.deepEqual(D.replace("foo foobar", O({ wholeWord: true }), "X"), { text: "X foobar", count: 1 });
    assert.deepEqual(D.replace("a1 b22", O({ query: "([a-z])(\\d+)", regex: true }), "$2$1"), { text: "1a 22b", count: 2 });
    assert.deepEqual(D.replace("nothing", O(), "X"), { text: "nothing", count: 0 });
  },
  plan(D) {
    const text = "foo x foo\nbar\nfoo";
    const list = [T(1, 0, 3), T(1, 6, 9), T(3, 0, 3)];
    assert.deepEqual(D.replacePlan(text, list, O(), "X"), { areas: [{ from: 0, to: 3, insert: "X" }, { from: 6, to: 9, insert: "X" }, { from: 14, to: 17, insert: "X" }], stale: 0 });
    assert.deepEqual(D.replacePlan(text, [list[0]], O(), "X").areas, [{ from: 0, to: 3, insert: "X" }], "only the displayed hits");
    assert.deepEqual(D.replacePlan(text, list, O({ query: "f" }), "X"), { areas: [], stale: 3 }, "other fields: nothing replaced");
    assert.deepEqual(D.replacePlan("a foo\n", [T(1, 0, 3)], O(), "X"), { areas: [], stale: 1 }, "a shifted text is stale");
    assert.equal(D.replacePlan("foo", [T(5, 0, 3)], O(), "X").stale, 1, "a line that no longer exists");
    assert.deepEqual(D.replacePlan("foo\r\nx", [T(1, 2, 3)], O({ query: "o$", regex: true }), "X").areas, [{ from: 2, to: 3, insert: "X" }], "CRLF: the \\r does not belong to the line");
    assert.equal(D.replacePlan("a1", [T(1, 0, 2)], O({ query: "([a-z])(\\d)", regex: true }), "$2$1").areas[0].insert, "1a", "groups from the text");
  },
  list(D) {
    const l = D.hitsList([{ path: "a.ts", matches: [{ line: 1, text: "foo x foo", hits: [[0, 3], [6, 9]] }] }, { path: "b.ts", matches: [{ line: 2, text: "xfoo" }] }], O());
    assert.deepEqual(l.map((d) => d.hits.map((x) => [x.row, x.from, x.until])), [[[1, 0, 3], [1, 6, 9]], [[2, 1, 4]]], "one row per hit; without columns from the text");
    assert.deepEqual(D.resultCounts(l), { hits: 3, files: 2 }, "the number in the header is the number of rows");
    assert.deepEqual(D.rowsHits("foo\r\nbar foo\r\n", O()), [{ line: 1, text: "foo", hits: [[0, 3]] }, { line: 2, text: "bar foo", hits: [[4, 7]] }], "CRLF like the server");
    const server = [{ path: "a.ts", matches: [{ line: 1, text: "foo", hits: [[0, 3]] }] }, { path: "c.ts", matches: [{ line: 1, text: "foo", hits: [[0, 3]] }] }];
    const buffer = new Map([["a.ts", "nil\nfoo foo"], ["b.ts", "foo"], ["d.ts", "foo"]]);
    assert.deepEqual(D.withBuffers(server, buffer, ["a.ts", "b.ts"], O()).map((x) => [x.path, x.matches.map((m) => [m.line, m.hits])]),
      [["a.ts", [[2, [[0, 3], [4, 7]]]]], ["b.ts", [[1, [[0, 3]]]]], ["c.ts", [[1, [[0, 3]]]]]], "unsaved buffers with THEIR text instead of the disk");
    assert.deepEqual(D.withBuffers(server, buffer, undefined, O()), server, "without openMatches (old server) as from the server");
  },
  key(D) {
    assert.deepEqual([D.resultKey(1, 1), D.resultKey(3, 1), D.resultKey(1, 2), D.resultKey(3, 2)],
      ["1 result in 1 file", "{n} results in 1 file", "1 result in {m} files", "{n} results in {m} files"], "singular and plural like VS Code");
    assert.equal(D.questionKey(2, 1), "Replace {n} occurrences in 1 file with “{fresh}”?");
    assert.equal(D.replacedKey(1, 1), "Replaced 1 occurrence across 1 file with “{fresh}”.");
  },
  masked(D) {
    assert.equal(D.globMasked("a,b/[x]{y}*?"), "a[,]b/[[]x[]][{]y[}][*][?]");
    assert.equal(D.globMasked("src/lib"), "src/lib", "an ordinary folder stays");
  },
  preview(D) {
    assert.deepEqual(D.previewParts("    const foo = 1;", 10, 13), { before: "const ", hits: "foo", after: " = 1;" }, "leading whitespace falls away");
    const lang = "alpha bravo charlie delta echo tango sierra kilo lima mike foo rest";
    const v = D.previewParts(lang, lang.indexOf("foo"), lang.indexOf("foo") + 3);
    assert.equal(v.before, "…tango sierra kilo lima mike ", "before it from the last word boundary with at least 26 characters, with \"…\" (VS Code lcut)");
    assert.equal(v.hits, "foo");
    assert.deepEqual(D.previewParts("abc", 5, 8), { before: "…", hits: "", after: "" }, "behind the shortened text only \"…\"");
  },
  fields(D) {
    const f = F();
    assert.equal(D.sameFields(f, F()), true);
    assert.equal(D.sameFields(f, F({ query: "fo" })), false);
    assert.equal(D.sameFields(f, F({ include: "src" })), false, "another filter");
    assert.equal(D.sameFields(f, F({ exclusions: false })), false, "another switch");
    assert.equal(D.sameFields(null, f), false);
  },
};

test("(1) computation: find, replacement, AB, plan, list, header, folder, preview, fields", () => {
  for (const [k, check] of Object.entries(CHECKS)) {
    try { check(real); } catch (e) { throw new Error(`${k}: ${e.message}`); }
  }
});

test("(1) counter-tests: each sabotage occurs exactly once in the source and is caught by its check", () => {
  const stale = copies.filter((k) => k.places !== 1).map((k) => `${k.name} (${k.places}×)`);
  assert.deepEqual(stale, [], "sabotages whose spot does not occur exactly once in the source");
  const notCaught = [];
  for (const s of sabotaged) {
    let caught = false;
    try { CHECKS[s.catches](s.mod); } catch { caught = true; }
    if (!caught) notCaught.push(`${s.name} (${s.catches})`);
  }
  assert.deepEqual(notCaught, [], "sabotages that no check catches");
  console.log(`  [file-search] ${sabotaged.length} sabotages, each caught`);
});

// ── (2) The binding to the server ────────────────────────────────────────────────────────────────────────────────────────────────────
const { CORES } = await import("../../server/backend/electron/server/runtime/fileAccess.js");
const QUERIES = [
  { query: "foo" }, { query: "FOO", caseSensitive: true }, { query: "foo", wholeWord: true }, { query: "(foo", wholeWord: true },
  { query: "foo.", wholeWord: true }, { query: "a.c" }, { query: "a.c", regex: true }, { query: "(\\w)(\\d)", regex: true },
  { query: "x*", regex: true }, { query: "^", regex: true }, { query: "$", regex: true }, { query: "\\bfoo", regex: true, wholeWord: true },
  { query: "ä", caseSensitive: false }, { query: " ", wholeWord: true }, { query: "-", wholeWord: true }, { query: "o$", regex: true },
];
const ROWS = ["", "foo", "foo foobar foo_x (foo) xfoo foo", "x(foo y", "foo.bar a.c abc", "a1 b2 c33", "FOO Foo foo", "Ä ä äb", "  - -x x- -", "\tfoo\t"];
const TEXTS = ["foo\r\nfoo foo\r\n", "a1\nb22\r\n\r\nfoo", ROWS.join("\n"), "x".repeat(1200) + "foo"];
const compare = (D) => {
  const deviation = [];
  for (const q of QUERIES) {
    const o = { regex: false, caseSensitive: false, wholeWord: false, ...q };
    const m = CORES.searchPattern(o);
    for (const z of ROWS) {
      const server = m.findings(z, 1000), web = D.citations(z, o);
      if (JSON.stringify(server) !== JSON.stringify(web)) deviation.push(`${JSON.stringify(q)} in ${JSON.stringify(z)}: server ${JSON.stringify(positions(server))}, web ${JSON.stringify(positions(web))}`);
    }
    for (const text of TEXTS) {
      const server = CORES.searchLines(text, m, 2000).rows, web = D.rowsHits(text, o);
      if (JSON.stringify(server) !== JSON.stringify(web)) deviation.push(`lines ${JSON.stringify(q)} in ${JSON.stringify(text.slice(0, 40))}`);
    }
  }
  return deviation;
};

test("(2) binding: the same hits and rows as the server; the masked folder hits exactly itself in the server", () => {
  assert.deepEqual(compare(real), [], "web and server find differently");
  const withoutBreak = sabotaged.filter((s) => (s.catches === "find" || s.name === "lines without CR") && compare(s.mod).length === 0).map((s) => s.name);
  assert.deepEqual(withoutBreak, [], "sabotages on citations/rowsHits that the binding does not break");
  const masked = (D) => {
    const deviation = [];
    for (const name of ["a,b", "x{1,2}", "[draft]", "q?", "st*r", "a]b", "plain", "a b"]) {
      const m = CORES.searchPattern({ query: "x", include: `./${D.globMasked(name)}`, exclude: "" });
      if (!m.pathMatches(`${name}/f.ts`) || m.pathMatches("different/f.ts") || (name !== "plain" && m.pathMatches("plain/f.ts"))) deviation.push(name);
    }
    return deviation;
  };
  assert.deepEqual(masked(real), [], "folders that the server does not hit exactly with the masked glob");
  assert.notDeepEqual(masked(sabotaged.find((s) => s.name === "does not escape the comma").mod), [], "counter-test: without the escaped comma a,b breaks");
});

// ── (3) "Replace All" executed - through the buffer against a fake server ────────────────────────────────────────────────────────
const sha = (t) => crypto.createHash("sha256").update(t, "utf8").digest("hex");
const Z = { apiBase: "/api/projects/p1", instance: null };
function server(files = {}) {
  const disk = new Map(Object.entries(files));
  const requests = [];
  const beforeTheWrite = new Map();
  const error = (status, fields, msg = "x") => Object.assign(new Error(msg), { httpStatus: status, ...fields });
  const t = async (url, opts = {}) => {
    const u = new URL(url, "http://x");
    const body = opts.body ? JSON.parse(opts.body) : null;
    const file = u.searchParams.get("path") ?? body?.path;
    requests.push({ path: u.pathname, method: opts.method ?? "GET", file });
    if (u.pathname.endsWith("/files/read")) {
      if (!disk.has(file)) throw error(400, {}, `ENOENT: no such file or directory, stat '/x/${file}'`);
      const c = disk.get(file);
      return { content: c, sha: sha(c) };
    }
    if (u.pathname.endsWith("/files/write")) {
      if (beforeTheWrite.has(file)) { disk.set(file, beforeTheWrite.get(file)); beforeTheWrite.delete(file); } // someone else wrote
      const now = disk.get(file);
      if (body.base !== undefined && (now === undefined || sha(now) !== body.base)) throw error(409, { code: "CHANGED", current: now === undefined ? null : sha(now), missing: now === undefined });
      disk.set(file, body.content);
      return { ok: true, sha: sha(body.content) };
    }
    throw error(404, {}, `unknown: ${u.pathname}`);
  };
  return { t, read: (d) => disk.get(d), writes: () => requests.filter((a) => a.method === "PUT").map((a) => a.file), beforeTheWrite: (d, c) => beforeTheWrite.set(d, c) };
}
const fresh = (files) => { P.forgetAllBuffers(); const s = server(files); P.setTransport(s.t); return s; };
const fakeEditor = () => { const open = []; return { open, openInBackground(p) { open.push(p.path); } }; };
const list = (filePath, text, fields) => real.hitsList([{ path: filePath, matches: real.rowsHits(text, fields) }], fields);
const replaceWith = (M, o) => M.allReplace({ replacement: "X", preserved: false, toCanon: (p) => ({ target: Z, path: p }), ...o });

const REPLACE_CHECKS = {
  async fields(M) {
    const s = fresh({ "a.ts": "foo fff\nfoo\n" });
    const ed = fakeEditor();
    const l = list("a.ts", "foo fff\nfoo\n", F());
    const r = await replaceWith(M, { list: l, fields: F({ query: "f" }), editor: ed });
    assert.deepEqual([r.replaced, r.stale, s.read("a.ts")], [0, 2, "foo fff\nfoo\n"], "a list of \"foo\" with the fields of \"f\" replaces NOTHING");
    const r2 = await replaceWith(M, { list: l, fields: F(), editor: ed });
    assert.deepEqual([r2.replaced, r2.files, r2.stale, s.read("a.ts")], [2, 1, 0, "X fff\nX\n"], "with the fields of the list exactly the hits");
  },
  async onlyDisplayed(M) {
    const s = fresh({ "a.ts": "foo foo\n" });
    const l = list("a.ts", "foo foo\n", F());
    l[0].hits = l[0].hits.slice(0, 1);
    const r = await replaceWith(M, { list: l, fields: F(), editor: fakeEditor() });
    assert.deepEqual([r.replaced, s.read("a.ts")], [1, "X foo\n"], "only the displayed hits");
  },
  async conflict(M) {
    const s = fresh({ "a.ts": "foo\n", "b.ts": "foo\n" });
    s.beforeTheWrite("a.ts", "foreign foo\n");
    const ed = fakeEditor();
    const r = await replaceWith(M, { list: [...list("a.ts", "foo\n", F()), ...list("b.ts", "foo\n", F())], fields: F(), editor: ed });
    assert.equal(s.read("a.ts"), "foreign foo\n", "a 409 overwrites nothing");
    assert.equal(s.read("b.ts"), "X\n", "the other file is saved");
    assert.deepEqual(r.notSaved, ["a.ts"], "the conflict is reported");
    assert.deepEqual(ed.open, ["a.ts"], "the file is added as a tab (the question is there)");
  },
  async unsaved(M) {
    const s = fresh({ "a.ts": "foo\n" });
    const p = P.buffer(Z, "a.ts");
    const release = p.hold("tab");
    await p.load();
    p.change([{ from: 4, to: 4, insert: "foo new\n" }]);
    const ed = fakeEditor();
    const r = await replaceWith(M, { list: list("a.ts", p.text, F()), fields: F(), editor: ed });
    assert.deepEqual([r.replaced, p.text, p.dirty, s.read("a.ts"), s.writes()], [2, "X\nX new\n", true, "foo\n", []], "a file with unsaved changes stays unsaved");
    assert.deepEqual(ed.open, ["a.ts"]);
    release();
  },
  async stale(M) {
    const s = fresh({ "a.ts": "new\nfoo\n" });
    const r = await replaceWith(M, { list: list("a.ts", "foo\nnew\n", F()), fields: F(), editor: fakeEditor() });
    assert.deepEqual([r.replaced, r.stale, s.read("a.ts")], [0, 1, "new\nfoo\n"], "a shifted text is not replaced at the wrong place");
  },
  async undo(M) {
    const s = fresh({ "a.ts": "foo\n", "b.ts": "foo foo\n" });
    const ed = fakeEditor();
    const r = await replaceWith(M, { list: [...list("a.ts", "foo\n", F()), ...list("b.ts", "foo foo\n", F())], fields: F(), editor: ed });
    assert.ok(r.entry, "an entry for taking back");
    assert.deepEqual([s.read("a.ts"), s.read("b.ts")], ["X\n", "X X\n"]);
    // b.ts changes afterwards - it stays, a.ts comes back.
    const pb = P.buffer(Z, "b.ts"); const releaseB = pb.hold("tab"); await pb.load(); pb.change([{ from: 0, to: 0, insert: "// " }]); await pb.save(); releaseB();
    const z = await M.undo(r.entry, ed);
    assert.deepEqual([z.back, z.changed, s.read("a.ts"), s.read("b.ts")], [1, ["b.ts"], "foo\n", "// X X\n"], "undo restores the disk, what changed since stays");
  },
};

test("(3) \"Replace All\" executed: other fields, only displayed hits, 409, unsaved changes, stale, undo", async () => {
  for (const [k, check] of Object.entries(REPLACE_CHECKS)) {
    try { await check(replaceReal); } catch (e) { throw new Error(`${k}: ${e.message}`); }
  }
  const stale = replaceCopies.filter((k) => k.places !== 1).map((k) => `${k.name} (${k.places}×)`);
  assert.deepEqual(stale, [], "sabotages whose spot does not occur exactly once in search-replace.ts");
  const notCaught = [];
  for (const s of replaceSabotaged) {
    let caught = false;
    try { await REPLACE_CHECKS[s.catches](s.mod); } catch { caught = true; }
    if (!caught) notCaught.push(`${s.name} (${s.catches})`);
  }
  assert.deepEqual(notCaught, [], "sabotages that no check catches");
  P.setTransport(null);
  console.log(`  [file-search] ${replaceSabotaged.length} sabotages on search-replace.ts, each caught`);
});

// ── (4) The sources ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const withoutComments = (s) => s.replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
const Q = {
  search: read("src", "components", "code", "SearchView.tsx"),
  pane: read("src", "components", "CodePane.tsx"),
  core: read("src", "components", "code", "lsp-nav-core.ts"),
  nav: read("src", "components", "code", "navigation-connection.tsx"),
};
const SOURCE_CHECKS = {
  question(q) {
    const c = withoutComments(q.search);
    assert.ok(c.includes("useMemo(() => ({ query, regex, caseSensitive, wholeWord, include, exclude, exclusions }), [query, regex, caseSensitive, wholeWord, include, exclude, exclusions])"), "the fields are incomplete");
    assert.ok(c.includes("body: JSON.stringify({ ...f, open: [...open.keys()] })"), "the search does not send all fields together with the unsaved buffers");
    assert.ok(c.includes("setRes({ fields: f, list: hitsList(withBuffers(r.results, open, r.openMatches, f), f), truncated: r.truncated })"), "the results do not carry their fields or bypass the buffers");
    for (const d of ["aa", "ab", "regex", "preserved", "exclusions"]) assert.ok(c.includes(`data="${d}"`), `the switch ${d} is missing`);
    assert.ok(c.includes("const counts = res ? resultCounts(res.list) : null;"), "the header does not count the rows of the list");
    assert.ok(c.includes("t(resultKey(counts.hits, counts.files), { n: counts.hits, m: counts.files })"), "the header without singular/plural");
    assert.ok(c.includes("useEffect(() => { setNotice(\"\"); }, [fields]);"), "the notice is never reset");
    assert.ok(c.includes("data-search-all-closed"), "\"Collapse All\" is missing");
    assert.ok(!/fixed inset-0/.test(c) && !/\bfetch\(/.test(c), "click catcher or own request");
  },
  replace(q) {
    const c = withoutComments(q.search);
    assert.ok(c.includes("const applies = Boolean(res && sameFields(res.fields, fields));"), "\"Replace All\" does not check the fields of the results");
    assert.ok(c.includes("const ready = applies && !busy && !replacedCurrently && Boolean(counts?.hits);"), "\"Replace All\" is ready during the search");
    assert.ok(c.includes("disabled={!ready}"), "the button is not disabled");
    assert.ok(c.includes("if (!ready || !res || !counts) return;"), "alt+cmd+Enter bypasses the lock");
    assert.ok(c.includes("if (!ok || !sameFields(r0.fields, fields)) return;"), "not checked again after the question");
    assert.ok(c.includes("await replaceAll({ list: r0.list, fields: r0.fields, replacement: fresh, preserved, toCanon: (p) => coord.toCanon(p), editor })"), "\"Replace All\" does not take the displayed hits with their fields");
    assert.ok(c.includes("t(questionKey(counts.hits, counts.files), { n: counts.hits, m: counts.files, fresh })"), "the question does not name the number of the list");
    assert.ok(c.includes("r0.truncated ? ` ${t(\"The search was truncated — only the occurrences shown will be replaced.\")}`"), "no warning for a truncated search");
    assert.ok(c.includes("const r = await undo(e, editor);") && c.includes("if (entry) { e.preventDefault(); void back(); }"), "no undo");
  },
  tree(q) {
    const c = withoutComments(q.search);
    assert.ok(c.includes("<div role=\"group\">"), "the hits are not in a group");
    assert.ok(c.includes("tabIndex={carrier === tid ? 0 : -1}") && c.includes("tabIndex={carrier === did ? 0 : -1}"), "no single tab stop");
    assert.ok(c.includes("onKeyDown={key}") && c.includes("if (e.key === \"ArrowDown\") go(i + 1);"), "no arrow keys");
    assert.ok(c.includes("aria-selected={carrier === tid}"), "aria-selected is missing");
    assert.ok(c.includes("d.hits.map((x, j) => {"), "not one row per hit");
  },
  jump(q) {
    const c = withoutComments(q.search);
    assert.ok(c.includes("onOpen(path, { from: { line: x.row - 1, character: x.from }, until: { line: x.row - 1, character: x.until } })"), "the hit does not jump to its column with selection");
    const p = withoutComments(q.pane);
    // `focus`: cmd+P opens in the background, the jump then does not take the focus.
    assert.ok(p.includes("if (goto) nav.connection.rememberJump(path, jumpFrom(goto).from, undefined, { until: jumpFrom(goto).until ?? null, focus });"), "CodePane jumps without column/selection");
    assert.ok(p.includes("onOpen={(p, jump) => openFile(p, jump)}"), "CodePane does not pass on the search's jump");
    // components/code/LayoutContent.tsx passes `selectionRange.start` through (bound there in web/test/editor-status.test.mjs).
    assert.ok(p.includes("onJump={(from) => { if (activePath) void openFile(activePath, { from }); }}"), "the outline does not jump to the name");
    assert.ok(withoutComments(q.core).includes("selection: { anchor: off, head: header }"), "the navigation does not select");
    assert.ok(withoutComments(q.nav).includes("pendingUntil(k) { return a.pending(k) ? z.pending?.until ?? null : null; },"), "the end of the selection gets lost");
  },
  connection(q) {
    const c = withoutComments(q.pane);
    assert.ok(c.includes("<SearchView calls={calls} t={t} target={target} preset={searchFolder && { seq: searchFolder.seq, include: `./${globMasked(searchFolder.path)}` }} editor={editorHolder}"), "CodePane does not render the search with the masked folder from the root");
    assert.ok(c.includes("setSearchFolder((s) => ({ path: p, seq: (s?.seq ?? 0) + 1 })); setMode(\"search\");"), "\"Find in Folder...\" does not open the search (every request with a new number)");
    assert.ok(c.includes("onSearchInFolder={searchInFolder}"), "the tree does not get the \"Find in Folder...\" connection");
    assert.ok(!/function SearchPanel\(/.test(c), "the old search is still in CodePane");
  },
};
const SOURCE_SABOTAGES = {
  "results without fields": { file: "search", old: "setRes({ fields: f, list:", fresh: "setRes({ fields: { ...f, query: \"\" }, list:", catches: "question" },
  "without buffer": { file: "search", old: "body: JSON.stringify({ ...f, open: [...open.keys()] })", fresh: "body: JSON.stringify(f)", catches: "question" },
  "no AB switch": { file: "search", old: "data=\"preserved\"", fresh: "data=\"large\"", catches: "question" },
  "header counts the server's rows": { file: "search", old: "const counts = res ? resultCounts(res.list) : null;", fresh: "const counts = res ? { hits: res.list.length, files: res.list.length } : null;", catches: "question" },
  "notice stays": { file: "search", old: "useEffect(() => { setNotice(\"\"); }, [fields]);", fresh: "", catches: "question" },
  "replaces with new fields": { file: "search", old: "const applies = Boolean(res && sameFields(res.fields, fields));", fresh: "const applies = Boolean(res);", catches: "replace" },
  "ready during the search": { file: "search", old: "const ready = applies && !busy && !replacedCurrently && Boolean(counts?.hits);", fresh: "const ready = applies && Boolean(counts?.hits);", catches: "replace" },
  "fields of the field instead of the list": { file: "search", old: "list: r0.list, fields: r0.fields,", fresh: "list: r0.list, fields,", catches: "replace" },
  "no undo with cmd+Z": { file: "search", old: "if (entry) { e.preventDefault(); void back(); }", fresh: "", catches: "replace" },
  "hits without group": { file: "search", old: "<div role=\"group\">", fresh: "<div>", catches: "tree" },
  "every row a tab stop": { file: "search", old: "tabIndex={carrier === tid ? 0 : -1}", fresh: "tabIndex={0}", catches: "tree" },
  "jump without selection": { file: "search", old: ", until: { line: x.row - 1, character: x.until } })", fresh: " })", catches: "jump" },
  "CodePane column 0": { file: "pane", old: "nav.connection.rememberJump(path, jumpFrom(goto).from, undefined, { until: jumpFrom(goto).until ?? null, focus });", fresh: "nav.connection.rememberJump(path, { line: jumpFrom(goto).from.line, character: 0 });", catches: "jump" },
  "outline to the line start": { file: "pane", old: "onJump={(from) => { if (activePath) void openFile(activePath, { from }); }}", fresh: "onJump={(from) => { if (activePath) void openFile(activePath, from.line + 1); }}", catches: "jump" },
  "navigation without head": { file: "core", old: "selection: { anchor: off, head: header }", fresh: "selection: { anchor: off }", catches: "jump" },
  "folder unescaped": { file: "pane", old: "include: `./${globMasked(searchFolder.path)}`", fresh: "include: `./${searchFolder.path}`", catches: "connection" },
  "tree without connection": { file: "pane", old: "onSearchInFolder={searchInFolder}", fresh: "", catches: "connection" },
};

test("(4) sources: fields with buffers, lock and undo, tree, jump with selection, connection in CodePane", () => {
  for (const [k, check] of Object.entries(SOURCE_CHECKS)) {
    try { check(Q); } catch (e) { throw new Error(`${k}: ${e.message}`); }
  }
  const stale = Object.entries(SOURCE_SABOTAGES).filter(([, s]) => Q[s.file].split(s.old).length !== 2).map(([n]) => n);
  assert.deepEqual(stale, [], "sabotages whose spot does not occur exactly once in the source");
  const notCaught = [];
  for (const [name, s] of Object.entries(SOURCE_SABOTAGES)) {
    let caught = false;
    try { SOURCE_CHECKS[s.catches]({ ...Q, [s.file]: Q[s.file].replace(s.old, () => s.fresh) }); } catch { caught = true; }
    if (!caught) notCaught.push(`${name} (${s.catches})`);
  }
  assert.deepEqual(notCaught, [], "source sabotages that no check catches");
  console.log(`  [file-search] ${Object.keys(SOURCE_SABOTAGES).length} source sabotages, each caught`);
});
