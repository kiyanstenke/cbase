// Guard for the search like VS Code, server side: `POST <apiBase>/files/search` knows "whole word" (`wholeWord`), the filters
// `include`/`exclude` (globs like VS Code, comma-separated), the switch `exclusions` ("use exclude settings and ignore files") and
// `open` (paths of unsaved buffers — `openMatches` comes back).
//
// The promises, each with the way that breaks it:
//   (1) The cores (runtime/fileAccess.js — ONE computation for B and the program in the container), every rule with a sabotage on a
//       copy of the function text (exactly one place) that its check must catch:
//       - `searchGlob`: `**` only as a whole segment (within a segment like `*`), `*`/`?` do not hit `/`, `[…]` classes including `!`,
//         `\` in ignore files;
//       - `searchPattern`: "whole word" like VS Code, without ".*" literal, case; globs separated by comma (not inside `{}`/`[]`),
//         `{a,b}` expanded, `./x` and `/x` from the root, a pattern hits the path and everything below, an empty filter means "all";
//       - `searchArea`: VS Code's defaults (files.exclude + search.exclude), .gitignore/.ignore/.git/info/exclude per folder (last rule
//         wins, `!` takes back, `x/` folders only, anchored with `/`, a deeper file only below), the switch turns everything off;
//       - `searchLines`: per line the columns of EVERY hit, `\r` at the line end is dropped, preview capped.
//   (2) B (files.js `searchFiles`) over a real tree: the fields work, .gitignore and defaults apply, the switch opens them,
//       `openMatches` names only buffers in the area.
//   (3) Parity: the container's program (`node -e PROGRAM`, operation "search") returns the same hits and the same `openMatches` as
//       B on the same tree; an excluded or ignored folder is not entered (the core over a counting `fs`).
//   (4) The route reads the fields in ONE place for main and copy (devtools/code-route.js `searchFields`).
//
// Run (gate deadlines as in check.mjs):
//   CBASE_LIMIT_GRACE_MS=2000 CBASE_LIMIT_MIN_WAIT_MS=2000 CBASE_SWEEP_MS=2000 CBASE_AGENT_STALL_MS=3600000 \
//   CBASE_MAIN_AGENT_WAIT_MS=3600000 CBASE_EMBED_OFFLINE=1 node --test --test-reporter=tap server/backend/test/file-search-fields.test.js
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CORES, PROGRAM } from "../electron/server/runtime/fileAccess.js";
import { searchFiles } from "../electron/server/files.js";
import { searchFields } from "../electron/server/devtools/code-route.js";

// ── (1) The cores, with sabotages ────────────────────────────────────────────────────────────────────────────────────────────────────
const NAMES = ["searchGlob", "searchPattern", "searchArea", "searchLines"];
const SOURCES = Object.fromEntries(NAMES.map((n) => [n, CORES[n].toString()]));
const build = (sources) => new Function(`${NAMES.map((n) => sources[n]).join("\n")}\nreturn { ${NAMES.join(", ")} };`)();
const O = (o) => ({ query: "foo", regex: false, caseSensitive: false, wholeWord: false, include: "", exclude: "", ...o });
const lagen = (findings) => findings.map((f) => [f.start, f.end]);

const IGNORE = {
  "/w/.gitignore": "dist/\n*.log\n!keep.log\n/only-top\n# comment\n\\#hash\n",
  "/w/sub/.gitignore": "x.txt\n",
  "/w/.git/info/exclude": "secret\n",
  "/w/.ignore": "tmp\n",
};
const areaOf = (K, o = {}) => K.searchArea("/w", o, (abs) => IGNORE[abs] ?? null, (w, folder, file) => [w, folder, file].filter(Boolean).join("/"));

const CHECKS = {
  glob(K) {
    const G = (g, p) => K.searchGlob(g).test(p);
    assert.equal(G("**/*.ts", "a.ts"), true, "**/ also hits no segment");
    assert.equal(G("**/*.ts", "x/y/a.ts"), true);
    assert.equal(G("a/**/b", "a/b"), true);
    assert.equal(G("a/**/b", "a/x/y/b"), true);
    assert.equal(G("a/**/b", "ab"), false, "a ** between segments needs the separators");
    assert.equal(G("a**b", "a/b"), false, "** within a segment counts like *");
    assert.equal(G("a**b", "axxb"), true);
    assert.equal(G("src/**", "src"), true);
    assert.equal(G("src/**", "src/a/b"), true);
    assert.equal(G("src/**", "srcx"), false);
    assert.equal(G("*", "a/b"), false, "* does not hit /");
    assert.equal(G("?", "/"), false, "? does not hit /");
    assert.equal(G("**", "a/b/c"), true);
  },
  kind(K) {
    const G = (g, p, o) => K.searchGlob(g, o).test(p);
    assert.equal(G("*.[jt]s", "a.ts"), true, "character class");
    assert.equal(G("*.[jt]s", "a.cs"), false);
    assert.equal(G("[a-c]x", "bx"), true, "Area");
    assert.equal(G("[a-c]x", "dx"), false);
    assert.equal(G("[!a]b", "cb"), true, "negation");
    assert.equal(G("[!a]b", "ab"), false);
    assert.equal(G("x[,]y", "x,y"), true, "an escaped comma");
    assert.equal(G("[]]", "]"), true, "] right after [ is literal");
    assert.equal(G("a[", "a["), true, "[ without closing is literal");
    assert.equal(G("\\#x", "#x", { escape: true }), true, "\\ in ignore files");
  },
  wordHits(K) {
    const M = K.searchPattern;
    const m = M(O({ wholeWord: true }));
    assert.deepEqual(lagen(m.findings("foo foobar foo_x (foo) xfoo foo")), [[0, 3], [18, 21], [28, 31]], "whole word: edge or separator left and right");
    assert.deepEqual(lagen(M(O({ query: "(foo", wholeWord: true })).findings("x(foo y")), [[1, 5]], "a separator as first character of the hit counts as boundary");
    assert.deepEqual(lagen(M(O({ query: "foo.", wholeWord: true })).findings("foo.bar")), [[0, 4]], "a separator as last character of the hit counts as boundary");
    assert.deepEqual(lagen(M(O()).findings("foo foobar")), [[0, 3], [4, 7]], "without the switch every hit");
  },
  verbatim(K) {
    const M = K.searchPattern;
    assert.deepEqual(lagen(M(O({ query: "a.c" })).findings("abc a.c")), [[4, 7]], "without .* the dot is literal");
    assert.deepEqual(lagen(M(O({ query: "a.c", regex: true })).findings("abc a.c")), [[0, 3], [4, 7]], "with .* the dot is an expression");
    assert.deepEqual(lagen(M(O({ query: "FOO" })).findings("foo FOO")), [[0, 3], [4, 7]], "without Aa: case-insensitive");
    assert.deepEqual(lagen(M(O({ query: "FOO", caseSensitive: true })).findings("foo FOO")), [[4, 7]], "with Aa: only the same spelling");
    assert.match(M(O({ query: "(", regex: true })).error, /Invalid regular expression/);
    assert.equal(M(O({ query: "x*", regex: true })).findings("abc").length, 4, "an empty hit advances by one character");
  },
  include(K) {
    const p = (include) => K.searchPattern(O({ include })).pathMatches;
    assert.equal(p("")("any/where.js"), true, "an empty filter means everything");
    assert.equal(p("**")("any/where.js"), true);
    assert.equal(p("*.ts")("lib/x.ts"), true, "without ./ at any depth");
    assert.equal(p("*.ts")("lib/x.js"), false);
    assert.equal(p("src")("src/a.ts"), true, "a folder hits everything below");
    assert.equal(p("src")("lib/src/d.ts"), true, "a folder without ./ at any depth");
    assert.equal(p("./src")("lib/src/d.ts"), false, "./ applies from the root");
    assert.equal(p("./src")("src/test/c.ts"), true);
    assert.equal(p("/lib")("lib/x.md"), true, "/x applies from the root");
    assert.equal(p("/lib")("a/lib/x.md"), false);
    assert.equal(p("*.{ts,md}")("lib/x.md"), true, "braces are expanded");
    assert.equal(p("*.{ts,md}")("lib/x.js"), false);
    assert.equal(p("*.js, *.md")("lib/x.md"), true, "comma separates patterns");
    assert.equal(p("src/**/*.ts")("lib/src/test/c.ts"), true);
    assert.equal(p("**/test/**")("src/test/c.ts"), true);
    assert.equal(p("./a[,]b")("a,b/x.ts"), true, "a comma inside a class does not separate (\"search in folder…\" escapes like this)");
    assert.equal(p("./x[{]a[,]b[}]")("x{a,b}/f.ts"), true, "braces inside a class do not expand");
    assert.equal(p("./x[{]a[,]b[}]")("xa/f.ts"), false);
    assert.equal(p("./[[]1[]]")("[1]/f.ts"), true, "[ and ] escaped");
  },
  exclude(K) {
    const m = K.searchPattern(O({ include: "./src", exclude: "test, *.js" }));
    assert.equal(m.pathMatches("src/a.ts"), true);
    assert.equal(m.pathMatches("src/b.js"), false, "excluded beats included");
    assert.equal(m.pathMatches("src/test/c.ts"), false, "an excluded folder takes everything below with it");
    assert.equal(m.folderFrom("src/test"), true, "the folder is not entered");
    assert.equal(m.folderFrom("src"), false);
    assert.equal(K.searchPattern(O({ exclude: "{build,dist}" })).folderFrom("pkg/dist"), true, "a comma inside braces does not separate");
  },
  area(K) {
    const b = areaOf(K);
    const cases = [
      ["dist", "o", true, ".gitignore dist/"], ["a/dist", "o", true, "without / at any depth"], ["dist", "d", false, "dist/ hits folders only"],
      ["a.log", "d", true, "*.log"], ["keep.log", "d", false, "! takes back"], ["only-top", "o", true, "/only-top"],
      ["a/only-top", "o", false, "anchored with /"], ["sub/x.txt", "d", true, "deeper .gitignore"], ["x.txt", "d", false, "deeper .gitignore applies only below"],
      ["#hash", "d", true, "\\# escaped"], ["secret", "o", true, ".git/info/exclude"], ["tmp", "o", true, ".ignore"],
      ["node_modules", "o", true, "default node_modules"], ["a/node_modules", "o", true, "default at any depth"], [".git", "o", true, "default .git"],
      ["bower_components", "o", true, "default bower_components"], ["x.code-search", "d", true, "default *.code-search"], ["src", "o", false, "src stays"],
      ["build", "o", false, "no fixed exclusion for build any more"],
    ];
    for (const [rel, kind, desired, why] of cases) assert.equal(kind === "o" ? b.folderFrom(rel) : b.fileFrom(rel), desired, `${rel}: ${why}`);
    const M = K.searchPattern(O());
    assert.equal(b.inArea("dist/a.ts", M), false, "inArea: an ignored folder takes the file with it");
    assert.equal(b.inArea("src/a.ts", M), true);
    assert.equal(b.inArea("src/a.ts", K.searchPattern(O({ include: "./lib" }))), false, "inArea: with the filters");
    const offArea = areaOf(K, { exclusions: false });
    for (const [rel, kind] of [["dist", "o"], ["node_modules", "o"], [".git", "o"], ["a.log", "d"]]) {
      assert.equal(kind === "o" ? offArea.folderFrom(rel) : offArea.fileFrom(rel), false, `without the switch: ${rel} is searched`);
    }
  },
  rows(K) {
    const M = K.searchPattern(O());
    const r = K.searchLines("foo x foo\r\nbar\r\nfoo\r\n", M, 100);
    assert.deepEqual(r.rows, [{ line: 1, text: "foo x foo", hits: [[0, 3], [6, 9]] }, { line: 3, text: "foo", hits: [[0, 3]] }], "every hit per line, \\r is dropped");
    assert.equal(r.n, 3, "counted per hit (like VS Code)");
    assert.equal(K.searchLines("foo\r\n", K.searchPattern(O({ query: "o$", regex: true })), 10).n, 1, "CRLF: $ hits before the \\r");
    assert.equal(K.searchLines("foo foo foo", M, 2).n, 2, "the cap counts hits");
    const lang = K.searchLines("x".repeat(1500) + "foo", M, 10).rows[0];
    assert.equal(lang.text.length, 1000, "the preview is capped");
    assert.deepEqual(lang.hits, [[1500, 1503]], "the columns apply in the whole line");
  },
};

const SABOTAGES = {
  "** within a segment like segments": { in: "searchGlob", old: "if (c === \"*\") { while (s[j + 1] === \"*\") j++; tok.push({ a: \"star\" }); continue; }", fresh: "if (c === \"*\") { if (s[j + 1] === \"*\") { j++; tok.push({ a: \"alles\" }); continue; } tok.push({ a: \"star\" }); continue; }", catches: "glob" },
  "** between segments without separator": { in: "searchGlob", old: "if (!last) { if (i > 0) tok.push({ a: \"lit\", c: \"/\" }); tok.push({ a: \"front\" }); return; }", fresh: "if (!last) { tok.push({ a: \"front\" }); return; }", catches: "glob" },
  "* hits /": { in: "searchGlob", old: "else if (t.a === \"star\") { if (c !== \"/\") next.add(s); }", fresh: "else if (t.a === \"star\") { next.add(s); }", catches: "glob" },
  "class negation ignored": { in: "searchGlob", old: "return t.not ? !inside : inside;", fresh: "return inside;", catches: "kind" },
  "class literal": { in: "searchGlob", old: "tok.push({ a: \"kind\", set, not });", fresh: "tok.push({ a: \"lit\", c: \"[\" });", catches: "kind" },
  "whole word ignored": { in: "searchPattern", old: "if (!o.wholeWord || wholeTerm(row, s, e))", fresh: "if (true)", catches: "wordHits" },
  "separator at the hit does not count": { in: "searchPattern", old: "(s === 0 || separator(z[s - 1]) || (e > s && separator(z[s])))", fresh: "(s === 0 || separator(z[s - 1]))", catches: "wordHits" },
  "not escaped": { in: "searchPattern", old: "o.regex ? q : q.replace(", fresh: "true ? q : q.replace(", catches: "verbatim" },
  "case swapped": { in: "searchPattern", old: "o.caseSensitive ? \"g\" : \"gi\"", fresh: "o.caseSensitive ? \"gi\" : \"g\"", catches: "verbatim" },
  "./ not anchored": { in: "searchPattern", old: "if (p.startsWith(\"./\")) { p = p.slice(2); anchored = true; }", fresh: "if (p.startsWith(\"./\")) { p = p.slice(2); }", catches: "include" },
  "folder does not hit below": { in: "searchPattern", old: "candidates.some((k) => m.re.test(k) || m.under.test(k))", fresh: "candidates.some((k) => m.re.test(k))", catches: "include" },
  "root only": { in: "searchPattern", old: "if (!m.anchored) for (", fresh: "if (false) for (", catches: "include" },
  "braces not expanded": { in: "searchPattern", old: "if (n > 5) return [g];", fresh: "return [g];", catches: "include" },
  "brace in class expands": { in: "searchPattern", old: "if (c === \"[\") { const k = classesEnd(g, i); if (k >= 0) { i = k; continue; } }", fresh: "", catches: "include" },
  "empty filter excludes everything": { in: "searchPattern", old: "(!one.length || one.some((m) => matches(rel, m)))", fresh: "one.some((m) => matches(rel, m))", catches: "include" },
  "comma in class separates": { in: "searchPattern", old: "if (c === \"[\") { const k = classesEnd(s, i); if (k >= 0) { current += s.slice(i, k + 1); i = k; continue; } }", fresh: "", catches: "include" },
  "exclusion ignored": { in: "searchPattern", old: " && !result.some((m) => matches(rel, m))", fresh: "", catches: "exclude" },
  "comma in braces separates": { in: "searchPattern", old: "if (c === \"{\") depth++;", fresh: "if (false) depth++;", catches: "exclude" },
  "defaults missing": { in: "searchArea", old: "const standard = (rel) => STANDARD.some((g) => g.test(rel));", fresh: "const standard = (rel) => false;", catches: "area" },
  "! does not take back": { in: "searchArea", old: "res = !x.neg;", fresh: "res = true;", catches: "area" },
  "x/ also hits files": { in: "searchArea", old: "if (x.onlyFolder && !isFolder) continue;", fresh: "", catches: "area" },
  "anchored at any depth": { in: "searchArea", old: "x.anchored ? x.glob.test(relB) : x.glob.test(nameText(relB))", fresh: "x.glob.test(nameText(relB))", catches: "area" },
  "deeper ignore file not read": { in: "searchArea", old: "of stack(parent(rel))", fresh: "of stack(\"\")", catches: "area" },
  ".git/info/exclude not read": { in: "searchArea", old: "[\".git/info/exclude\", \".gitignore\", \".ignore\"]", fresh: "[\".gitignore\", \".ignore\"]", catches: "area" },
  "switch without effect": { in: "searchArea", old: "const enabled = o.exclusions !== false;", fresh: "const enabled = true;", catches: "area" },
  "inArea without folders": { in: "searchArea", old: "if (folderFrom(d) || m.folderFrom(d)) return false;", fresh: "", catches: "area" },
  "\\r stays": { in: "searchLines", old: "if (z.endsWith(\"\\r\")) z = z.slice(0, -1);", fresh: "", catches: "rows" },
  "only the first hit per line": { in: "searchLines", old: "pattern.findings(z, slot - n)", fresh: "pattern.findings(z, 1)", catches: "rows" },
  "preview uncapped": { in: "searchLines", old: "z.length > PREVIEW ? z.slice(0, PREVIEW) : z", fresh: "z", catches: "rows" },
};

test("(1) the cores: glob, pattern, area, rows", () => {
  const K = build(SOURCES);
  for (const [k, check] of Object.entries(CHECKS)) {
    try { check(K); } catch (e) { throw new Error(`${k}: ${e.message}`); }
  }
  // The built-in functions are the same as the built ones (otherwise the sabotages would check a different computation).
  for (const check of Object.values(CHECKS)) check(CORES);
});

test("(1) counter-tests: every sabotage stands exactly once in its core and is caught by its check", () => {
  const stale = Object.entries(SABOTAGES).filter(([, s]) => SOURCES[s.in].split(s.old).length !== 2).map(([n]) => n);
  assert.deepEqual(stale, [], "sabotages whose place does not stand exactly once in its core");
  const notCaught = [];
  for (const [name, s] of Object.entries(SABOTAGES)) {
    let caught = false;
    try { CHECKS[s.catches](build({ ...SOURCES, [s.in]: SOURCES[s.in].replace(s.old, s.fresh) })); } catch { caught = true; }
    if (!caught) notCaught.push(`${name} (${s.catches})`);
  }
  assert.deepEqual(notCaught, [], "sabotages that no check catches");
  console.log(`  [file-search-fields] ${Object.keys(SABOTAGES).length} sabotages, each caught`);
});

// ── (2)/(3) A real tree ─────────────────────────────────────────────────────────────────────────────────────────────────────────
function tree() {
  const w = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-search-fields-"));
  const create = (rel, content) => { fs.mkdirSync(path.dirname(path.join(w, rel)), { recursive: true }); fs.writeFileSync(path.join(w, rel), content); };
  create("src/a.ts", "const foo = 1;\nfoobar();\nfoo_bar\n(foo)\n");
  create("src/b.js", "foo\n");
  create("src/test/c.ts", "foo\n");
  create("lib/src/d.ts", "foo\n");
  create("lib/x.md", "foo\n");
  create("gen/e.ts", "foo\n");
  create("crlf.txt", "foo\r\nfoo foo\r\n");
  create("node_modules/m/i.js", "foo\n");
  create(".gitignore", "dist/\n*.log\n");
  create("dist/f.ts", "foo\n");
  create("x.log", "foo\n");
  return w;
}
const paths = (r) => r.results.map((x) => x.path);
const REASON = ["crlf.txt", "gen/e.ts", "lib/src/d.ts", "lib/x.md", "src/a.ts", "src/b.js", "src/test/c.ts"];

test("(2) B: the fields work through files.js searchFiles", () => {
  const w = tree();
  try {
    assert.deepEqual(paths(searchFiles(w, { query: "foo" })), REASON, "without filter everything except defaults and .gitignore");
    assert.deepEqual(paths(searchFiles(w, { query: "foo", exclusions: false })), ["crlf.txt", "dist/f.ts", "gen/e.ts", "lib/src/d.ts", "lib/x.md", "node_modules/m/i.js", "src/a.ts", "src/b.js", "src/test/c.ts", "x.log"].sort((a, b) => a.localeCompare(b)), "the switch opens defaults and ignore files");
    const crlf = searchFiles(w, { query: "foo", include: "crlf.txt" });
    assert.deepEqual(crlf.results[0].matches, [{ line: 1, text: "foo", hits: [[0, 3]] }, { line: 2, text: "foo foo", hits: [[0, 3], [4, 7]] }], "the columns per hit, without \\r");
    assert.equal(crlf.count, 3, "counted per hit");
    const wordHits = searchFiles(w, { query: "foo", wholeWord: true, include: "./src/a.ts" });
    assert.deepEqual(wordHits.results[0].matches.map((m) => m.line), [1, 4], "whole word: foobar and foo_bar drop out");
    assert.deepEqual(paths(searchFiles(w, { query: "foo", include: "src" })), ["lib/src/d.ts", "src/a.ts", "src/b.js", "src/test/c.ts"]);
    assert.deepEqual(paths(searchFiles(w, { query: "foo", include: "./src" })), ["src/a.ts", "src/b.js", "src/test/c.ts"]);
    assert.deepEqual(paths(searchFiles(w, { query: "foo", include: "*.{ts,md}", exclude: "test, gen" })), ["lib/src/d.ts", "lib/x.md", "src/a.ts"]);
    assert.deepEqual(paths(searchFiles(w, { query: "foo", include: "node_modules" })), [], "a filter does not open an excluded folder");
    assert.equal(searchFiles(w, { query: "foo", include: "./src", exclude: "*.ts" }).count, 1);
    assert.deepEqual(searchFiles(w, { query: "foo", include: "*.ts", open: ["src/fresh.ts", "dist/x.ts", "node_modules/y.ts", "lib/z.md", 3] }).openMatches, ["src/fresh.ts"], "openMatches: only buffers in the area");
    assert.deepEqual(searchFiles(w, { query: "" }), { results: [], count: 0, files: 0, truncated: false, openMatches: [] });
    assert.throws(() => searchFiles(w, { query: "(", regex: true }), /Invalid regular expression/);
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

test("(3) parity: the container program searches like B; an excluded folder is not entered", () => {
  const w = tree();
  try {
    const reason = { maxFiles: 5000, maxFile: 1024 * 1024, maxHits: 2000 };
    const cases = [
      { query: "foo", wholeWord: true }, { query: "foo", include: "src" }, { query: "foo", include: "./src" },
      { query: "foo", include: "*.{ts,md}", exclude: "test, gen" }, { query: "FOO", caseSensitive: true }, { query: "fo+", regex: true, exclude: "*.ts" },
      { query: "foo", exclusions: false }, { query: "o$", regex: true }, { query: "foo", open: ["src/fresh.ts", "dist/x.ts", "gen/y.ts"], exclude: "gen" },
    ];
    for (const f of cases) {
      const o = { regex: false, caseSensitive: false, wholeWord: false, include: "", exclude: "", ...reason, ...f };
      const offArea = JSON.parse(execFileSync(process.execPath, ["-e", PROGRAM, "--", "search", JSON.stringify(o), w], { encoding: "utf8" }));
      assert.equal(offArea.ok, true, JSON.stringify(offArea));
      const inProgram = offArea.results.map((e) => ({ path: e.rel, matches: e.matches })).sort((a, b) => a.path.localeCompare(b.path));
      const b = searchFiles(w, f);
      assert.deepEqual(inProgram, b.results, `case ${JSON.stringify(f)}`);
      assert.deepEqual(offArea.openMatches, b.openMatches, `openMatches ${JSON.stringify(f)}`);
    }
    // A counting fs: the core reads neither the excluded nor the ignored folder nor the defaults.
    const read = [];
    const counter = { ...fs, readdirSync: (d, o) => { read.push(path.relative(w, d).split(path.sep).join("/")); return fs.readdirSync(d, o); } };
    CORES.searchCore(counter, path, w, { query: "foo", regex: false, caseSensitive: false, wholeWord: false, include: "", exclude: "src/test, gen", ...reason });
    assert.ok(read.includes("src") && !read.includes("src/test") && !read.includes("gen"), `read: ${read.join(", ")}`);
    assert.ok(!read.includes("dist") && !read.includes("node_modules"), `ignored and default not entered: ${read.join(", ")}`);
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

test("(4) the route reads the fields in ONE place for main and copy", () => {
  assert.deepEqual(searchFields({ query: "x", wholeWord: 1, include: "src", exclude: "*.md" }), { query: "x", regex: false, caseSensitive: false, wholeWord: true, exclusions: true, include: "src", exclude: "*.md", open: [] });
  assert.equal(searchFields({ query: "x", exclusions: false }).exclusions, false, "the switch arrives");
  assert.equal(searchFields({ query: "x", includeHeavy: true }).exclusions, false, "an old client with includeHeavy: search everything");
  assert.equal(searchFields({ query: "x", includeHeavy: true, exclusions: true }).exclusions, true, "the new switch wins");
  assert.deepEqual(searchFields({ query: "x", open: ["a.ts", 3, "b".repeat(5000)] }).open, ["a.ts"], "open: strings only, capped");
  assert.equal(searchFields({ query: "x", open: Array.from({ length: 300 }, (_, i) => `f${i}`) }).open.length, 200);
  assert.deepEqual(searchFields({ query: "x", include: ["src"], exclude: 3 }).include, "", "a filter that is not a string does not filter");
  assert.equal(searchFields({ query: "x", include: "a".repeat(5000) }).include.length, 2000, "the filter is capped");
  const source = fs.readFileSync(new URL("../electron/server/devtools/code-route.js", import.meta.url), "utf8");
  const branches = source.split("\n").filter((z) => z.includes("sub === \"/files/search\""));
  assert.equal(branches.length, 2, "two branches of the search (copy and main)");
  for (const z of branches) assert.ok(z.includes("searchFields(b)"), `a branch reads the fields itself: ${z.trim().slice(0, 120)}`);
});
