// The Problems view in the lower panel as in VS Code:
//
// (1) The computations of lib/problems-list.ts, EXECUTED: globs (comma only outside {} and [], `**` across segments, `*` within one
//     segment; an INVALID glob "[z-a]" never throws and never matches; every expression built once), the filter as in VS Code (whole
//     input as text, "!" negates, each segment as include/exclude glob, ".ts" = "*.ts"), the ordering (most severe first, then
//     position; files by their most severe problem, then path), filtering (exclusion, inclusion shows the whole file, name/source/code
//     fuzzy, message as a part with `*`, negation, severity toggles, active file only, "Show Excluded Files" on by default, never
//     hints), what the view says when empty (not loaded yet ⇒ nothing; none in the active file) and when "n of m" is shown, the
//     visible rows (collapsed, ←, multi-line by default with a toggle), stable keys, the excerpt, how a jump takes the focus (click
//     keeps it, double-click gives it to the editor), the badge and "ts(2304)".
// (2) The sources: the list in the form of the explorer with the empty texts of VS Code (focusable), only the excerpt drawn, memo per
//     row, selection by key, assistive technology; the panel with three tabs as a tab list, measured on the container before the
//     first paint, dragged on the element, badge from the stock including infos; CodePane jumps to line AND column and passes the
//     focus request on to the editor; the terminal reports its end, lets the workbench keys through and sends the size debounced;
//     the debug console is only the REPL, the rest is in "Run and Debug"; the diagnostics carry column, source and code and are null
//     before the first load; the Dark/Light Modern colors; maximized hides the siblings.
//
// Each sabotage is a copy of the source with ONE changed spot (exactly once there); the assigned check must fail on it.
//
// Run:  node --test --test-reporter=tap web/test/problems-list.test.mjs
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

const SOURCE = read("src", "lib", "problems-list.ts");
const SABOTAGES = {
  "comma inside brackets separates": { old: "if (c === \",\" && !inBracket && !inCorner)", fresh: "if (c === \",\")", catches: "globs" },
  "** only one segment": { old: "if (g[i] === \"/\") { re += \"(?:[^/]*/)*\"; i++; } else re += \".*\";", fresh: "re += \"[^/]*\";", catches: "globs" },
  "star across segments": { old: "re += \"[^/]*\"; i++; continue;", fresh: "re += \".*\"; i++; continue;", catches: "globs" },
  "invalid glob throws": { old: "try { re = build(); } catch { re = NEVER; }", fresh: "re = build();", catches: "invalid" },
  "invalid glob matches everything": { old: "const NEVER = /.^/;", fresh: "const NEVER = /.*/;", catches: "invalid" },
  "expressions rebuilt per call": { old: "let re = CACHE.get(key);", fresh: "let re: RegExp | undefined;", catches: "cache" },
  "extension without star": { old: "const p = segment[0] === \".\" ? `*${segment}` : segment;", fresh: "const p = segment;", catches: "filter" },
  "exclusion as inclusion": { old: "if (rest) exclusion.push(...pattern(rest));", fresh: "if (rest) inclusion.push(...pattern(rest));", catches: "filter" },
  "negation not recognized": { old: "const negated = raw.startsWith(\"!\");", fresh: "const negated = false;", catches: "filter" },
  "wildcard literal": { old: ".replace(/\\\\\\*/g, \".*\")", fresh: "", catches: "filter" },
  "fuzzy as part": { old: "for (const c of b) if (c === a[j]) j++;", fresh: "j = b.includes(a) ? a.length : 0;", catches: "filter" },
  "excluded not as a filter": { old: "|| f.onlyActiveFile || !f.excludedShow;", fresh: "|| f.onlyActiveFile;", catches: "filter" },
  "light first": { old: "valueOf(b.severity) - valueOf(a.severity)", fresh: "valueOf(a.severity) - valueOf(b.severity)", catches: "ordering" },
  "column does not count": { old: " || (a.column ?? 1) - (b.column ?? 1)", fresh: "", catches: "ordering" },
  "files by path only": { old: "valueOf(b.entries[0].severity) - valueOf(a.entries[0].severity) || ", fresh: "", catches: "ordering" },
  "hints counted": { old: "if (!p || p.severity === \"hint\") continue;", fresh: "if (!p) continue;", catches: "filtering" },
  "exclusion has no effect": { old: "if (filter.exclusion.some((r) => r.test(g.file))) continue;", fresh: "", catches: "filtering" },
  "inclusion does not show everything": { old: "const whole = filter.inclusion.some((r) => r.test(g.file)) || ", fresh: "const whole = ", catches: "filtering" },
  "negated keeps matches": { old: "if (filter.negated && !whole) return !matches;", fresh: "if (filter.negated && !whole) return true;", catches: "filtering" },
  "severity toggle without effect": { old: "if (!showsSeverity(filter, p.severity)) return false;", fresh: "if (p.severity === \"hint\") return false;", catches: "filtering" },
  "active file only without effect": { old: "if (filter.onlyActiveFile && g.file !== (o.activeFile ?? null)) continue;", fresh: "", catches: "filtering" },
  "source does not count": { old: "(p.source ? matchesFuzzy(filter.text, p.source) : false) || ", fresh: "", catches: "filtering" },
  "excluded never hidden": { old: "if (!filter.excludedShow && excluded(g.file)) continue;", fresh: "", catches: "filtering" },
  "excluded off by default": { old: "excludedShow: toggle.excludedShow ?? true,", fresh: "excludedShow: toggle.excludedShow ?? false,", catches: "filtering" },
  "unloaded means none": { old: "if (problems === null) return { loaded: false, groups: [], total: 0, shown: 0, activeFileHasProblems: false };", fresh: "", catches: "empty" },
  "loading shows an empty text": { old: "if (!list.loaded) return \"loading\";", fresh: "", catches: "empty" },
  "active file without its own text": { old: "if (filter.onlyActiveFile) return list.activeFileHasProblems ? \"filtered\" : \"activeFile\";", fresh: "", catches: "empty" },
  "n of m even unfiltered": { old: "list.total !== 0 && list.shown !== list.total", fresh: "list.total !== 0", catches: "empty" },
  "collapsed shows children": { old: "if (open) g.entries.forEach", fresh: "g.entries.forEach", catches: "rows" },
  "left arrow does not collapse": { old: "return { index: i, collapse: z.open ? z.group.file : null };", fresh: "return { index: i, collapse: null };", catches: "rows" },
  "multi-line only the first line": { old: "const rows = singleLine.has(key) ? all.slice(0, 1) : all;", fresh: "const rows = all.slice(0, 1);", catches: "rows" },
  "single-line without effect": { old: "all.slice(0, 1) : all;", fresh: "all : all;", catches: "rows" },
  "key by position in the list": { old: "const base = `${file}#${p.line}:${p.column ?? 1}:${p.severity}:${p.source ?? \"\"}:${p.code ?? \"\"}:${p.message}`;", fresh: "const base = `${file}#`;", catches: "key" },
  "equal ones share a key": { old: "return n ? `${base}~${n}` : base;", fresh: "return base;", catches: "key" },
  "filtered keys shifted": { old: "key: g.key.filter((_, i) => keep[i])", fresh: "key: g.key", catches: "key" },
  "position without height": { old: "y += z.height * row;", fresh: "y += row;", catches: "excerpt" },
  "excerpt draws everything": { old: "{ from: Math.max(0, lo - margin), until: Math.min(n, until + margin) }", fresh: "{ from: 0, until: n }", catches: "excerpt" },
  "excerpt one line too early": { old: "if (positions.top[m] <= roles) lo = m; else hi = m - 1;", fresh: "if (positions.top[m] < roles) lo = m; else hi = m - 1;", catches: "excerpt" },
  "double-click keeps the focus": { old: "? { fixed: true, focus: true }", fresh: "? { fixed: true, focus: false }", catches: "jump" },
  "click takes the focus": { old: ": { fixed: false, focus: false };", fresh: ": { fixed: false, focus: true };", catches: "jump" },
  "badge without K": { old: "if (whole <= 999) return String(whole);", fresh: "return String(whole);", catches: "badge" },
  "1K+ missing": { old: "return thousand > bottom ? `${bottom}K+` : `${bottom}K`;", fresh: "return `${bottom}K`;", catches: "badge" },
  "code without parentheses": { old: "? \"\" : `(${String(code)})`;", fresh: "? \"\" : String(code);", catches: "badge" },
};

// ── Compile: the source and one copy per sabotage, in ONE tsc run. ──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-problems-list-"));
const src = path.join(tmp, "src"), out = path.join(tmp, "out");
fs.mkdirSync(src, { recursive: true });
fs.writeFileSync(path.join(src, "problems-list.ts"), SOURCE);
const copies = [];
for (const [name, s] of Object.entries(SABOTAGES)) {
  const file = `problems-list-sabotage-${copies.length}.ts`;
  fs.writeFileSync(path.join(src, file), SOURCE.replace(s.old, s.fresh));
  copies.push({ name, file, catches: s.catches, places: SOURCE.split(s.old).length - 1 });
}
try {
  execFileSync(process.execPath, [tsc, ...fs.readdirSync(src).map((d) => path.join(src, d)), "--outDir", out, "--rootDir", src, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler", "--strict", "--skipLibCheck", "--lib", "es2022,dom"], { stdio: "pipe" });
} catch (e) {
  const text = `${String(e.stdout || "")}${String(e.stderr || "")}`;
  const realError = text.split("\n").filter((z) => /error TS\d+/.test(z) && !/-sabotage-\d+\.ts\(/.test(z));
  if (realError.length || !fs.existsSync(path.join(out, "problems-list.js"))) throw new Error(`tsc: ${text}`.slice(0, 4000));
}
const load = (file) => import(pathToFileURL(path.join(out, file.replace(/\.ts$/, ".js"))).href);
const real = await load("problems-list.ts");
const sabotaged = await Promise.all(copies.map(async (k) => ({ ...k, mod: fs.existsSync(path.join(out, k.file.replace(/\.ts$/, ".js"))) ? await load(k.file) : null })));
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { console.warn("[test] temp directory was left behind:", String(e?.message || e).slice(0, 120)); }

// ── (1) Checks of the computations ───────────────────────────────────────────────────────────────────────────────────────────────────
const P = (file, line, severity, message, extra = {}) => ({ file, line, column: 1, severity, message, ...extra });
const PROBLEMS = [
  P("src/b.ts", 3, "warning", "x is declared but never used", { source: "ts", code: 6133 }),
  P("src/a.ts", 9, "warning", "Unused import", { source: "eslint" }),
  P("src/a.ts", 2, "error", "Cannot find name 'foo'.", { source: "ts", code: 2304, column: 7 }),
  P("src/a.ts", 2, "error", "Type mismatch", { source: "ts", code: 2322, column: 3 }),
  P("gen/finder.ts", 1, "info", "Generated", { source: "py" }),
  P("src/a.ts", 4, "hint", "unnecessary", { source: "ts" }),
];
const names = (list) => list.groups.map((g) => `${g.file}:${g.entries.map((e) => `${e.line}.${e.column}`).join(",")}`);
const keyOf = (list, line, notice) => {
  for (const g of list.groups) { const i = g.entries.findIndex((e) => e.line === line && e.message === notice); if (i >= 0) return g.key[i]; }
  return null;
};
const CHECKS = {
  globs(L) {
    assert.deepEqual(L.partsGlobs("a,{b,c},[d,e], f"), ["a", "{b,c}", "[d,e]", " f"], "a comma inside {} and [] does not separate");
    const ts = L.globToRegExp("**/*.ts");
    assert.ok(ts.test("src/x/a.ts") && ts.test("a.ts") && !ts.test("a.tsx"), "**/*.ts");
    const nm = L.globToRegExp("**/node_modules/**");
    assert.ok(nm.test("node_modules/x/y.js") && nm.test("a/node_modules/b.js") && !nm.test("anode_modules/b.js"), "**/node_modules/**");
    const choice = L.globToRegExp("*.{ts,js}");
    assert.ok(choice.test("a.js") && choice.test("b.ts") && !choice.test("a/b.js"), "* stays within a segment, {a,b} chooses");
    assert.ok(L.globToRegExp("[!a]x.ts").test("bx.ts") && !L.globToRegExp("[!a]x.ts").test("ax.ts"), "[!…] negates");
    assert.ok(L.globToRegExp("?.ts").test("a.ts") && !L.globToRegExp("?.ts").test("ab.ts"), "? one character");
  },
  // "[z-a]" is invalid as a character class — building threw while rendering, and the whole page froze (no error boundary).
  invalid(L) {
    let re = null;
    assert.doesNotThrow(() => { re = L.globToRegExp("[z-a]"); }, "an invalid glob throws");
    assert.ok(!re.test("[z-a]") && !re.test("a") && !re.test(""), "an invalid glob never matches (VS Code glob.ts NULL)");
    let list = null;
    assert.doesNotThrow(() => { list = L.problemList(PROBLEMS, L.problemFilter("[z-a]")); }, "an invalid glob in the filter field tears down the list");
    assert.equal(list.shown, 0, "the invalid glob includes nothing");
    assert.deepEqual(names(L.problemList(PROBLEMS, L.problemFilter("[z-a], b.ts"))), ["src/b.ts:3.1"], "the valid segments keep working");
    assert.deepEqual(names(L.problemList(PROBLEMS, L.problemFilter("!src/[z-a]"))).length, 3, "an invalid exclusion excludes nothing");
  },
  // The list asks every file on each render — every expression is built once (VS Code `fuzzyRegExpCache`).
  cache(L) {
    assert.equal(L.globToRegExp("**/*.tsx"), L.globToRegExp("**/*.tsx"), "the same glob is rebuilt per call");
    assert.notEqual(L.globToRegExp("**/*.tsx"), L.globToRegExp("**/*.ts"));
  },
  filter(L) {
    const n = L.problemFilter("  !foo ");
    assert.equal(n.negated, true);
    assert.equal(n.text, "foo");
    assert.ok(n.exclusion.some((r) => r.test("foo/x.ts")) && n.exclusion.some((r) => r.test("a/foo")), "!foo excludes the folder and the file");
    assert.equal(n.inclusion.length, 0);
    const e = L.problemFilter(".ts");
    assert.ok(e.inclusion.some((r) => r.test("src/x.ts")), "\".ts\" means \"*.ts\"");
    const m = L.problemFilter("src, !gen");
    assert.equal(m.text, "src, !gen", "the text is the whole input");
    assert.equal(m.negated, false);
    assert.ok(m.inclusion.some((r) => r.test("src/a.ts")) && m.exclusion.some((r) => r.test("gen/b.ts")));
    assert.ok(L.matchesNotice("can*find", "Cannot find name") && L.matchesNotice("FIND", "Cannot find") && !L.matchesNotice("xyz", "abc"), "message: part, * as wildcard, case-insensitive");
    assert.ok(L.matchesFuzzy("atx", "App.tsx") && L.matchesFuzzy("ts", "ts") && !L.matchesFuzzy("aex", "App.tsx"), "fuzzy: characters in order");
    assert.equal(L.filterActive(L.problemFilter("")), false, "no filter is set by default (\"Show Excluded Files\" is on too)");
    assert.equal(L.filterActive(L.problemFilter("", { infos: false })), true);
    assert.equal(L.filterActive(L.problemFilter("", { excludedShow: false })), true, "hiding excluded files is a filter (funnel marked)");
  },
  ordering(L) {
    const l = L.problemList(PROBLEMS, L.problemFilter(""));
    assert.deepEqual(names(l), ["src/a.ts:2.3,2.7,9.1", "src/b.ts:3.1", "gen/finder.ts:1.1"], "most severe first, then position; files by their most severe problem, then path");
    assert.deepEqual(l.groups[0].entries.map((x) => x.severity), ["error", "error", "warning"]);
    assert.equal(l.groups[0].name, "a.ts");
    assert.equal(l.groups[0].folder, "src");
    assert.equal(L.compareProblems(P("x", 5, "info", ""), P("x", 1, "warning", "")) > 0, true, "severity before the line");
  },
  filtering(L) {
    const f = (input, toggle, o) => L.problemList(PROBLEMS, L.problemFilter(input, toggle), o);
    const all = f("");
    assert.equal(all.total, 5, "hints do not count");
    assert.equal(all.shown, 5);
    assert.deepEqual(names(f("find")), ["src/a.ts:2.7", "gen/finder.ts:1.1"], "text: message as a part; a matching NAME shows the whole file");
    assert.deepEqual(names(f("eslint")), ["src/a.ts:9.1"], "the source fuzzy");
    assert.deepEqual(names(f("2322")), ["src/a.ts:2.3"], "the code");
    assert.deepEqual(names(f("!unused")), ["src/a.ts:2.3,2.7", "src/b.ts:3.1", "gen/finder.ts:1.1"], "negated drops what matches");
    assert.deepEqual(names(f("!gen")), ["src/a.ts:2.3,2.7,9.1", "src/b.ts:3.1"], "!gen excludes the folder");
    assert.deepEqual(names(f("!**/b.ts")), ["src/a.ts:2.3,2.7,9.1", "gen/finder.ts:1.1"], "an exclusion drops the file even if the text matches nothing");
    assert.deepEqual(names(f("**/b.ts")), ["src/b.ts:3.1"], "an inclusion shows the whole file, otherwise the text decides");
    assert.deepEqual(names(f("b.ts, zzz")), ["src/b.ts:3.1"], "inclusion shows all problems of the file even if the text does not match");
    assert.deepEqual(names(f("", { error: false, infos: false })), ["src/a.ts:9.1", "src/b.ts:3.1"], "severity toggles");
    assert.deepEqual(names(f("", { onlyActiveFile: true }, { activeFile: "src/b.ts" })), ["src/b.ts:3.1"], "active file only");
    const empty = f("nonexistent");
    assert.equal(empty.shown, 0);
    assert.equal(empty.total, 5);
    // "Show Excluded Files" is ON by default (VS Code markersView.ts: `excludedFiles: !!panelState.useFilesExclude`).
    const withGit = [...PROBLEMS, P(".git/hooks/pre-commit", 1, "error", "in the git folder")];
    assert.equal(L.problemList(withGit, L.problemFilter("")).shown, 6, "by default problems in excluded files are shown too");
    assert.deepEqual(names(L.problemList(withGit, L.problemFilter("", { excludedShow: false }))), ["src/a.ts:2.3,2.7,9.1", "src/b.ts:3.1", "gen/finder.ts:1.1"], "switched off drops what files.exclude matches");
  },
  // What the view says without a row — and "n of m" only if something is missing.
  empty(L) {
    const f0 = L.problemFilter("");
    const notLoaded = L.problemList(null, f0);
    assert.equal(notLoaded.loaded, false, "a never loaded list does not mean \"no problems\"");
    assert.equal(L.emptyState(notLoaded, f0), "loading", "not loaded yet: no empty text (empty is not unknown)");
    assert.equal(L.emptyState(L.problemList([], f0), f0), "no");
    assert.equal(L.emptyState(L.problemList(PROBLEMS, f0), f0), null);
    const active = L.problemFilter("", { onlyActiveFile: true });
    assert.equal(L.emptyState(L.problemList(PROBLEMS, active, { activeFile: "src/c.ts" }), active), "activeFile", "active file only without a problem in it: the VS Code text for the current file");
    assert.equal(L.emptyState(L.problemList(PROBLEMS, active, { activeFile: "src/b.ts" }), active), null);
    const activeText = L.problemFilter("zzz", { onlyActiveFile: true });
    assert.equal(L.emptyState(L.problemList(PROBLEMS, activeText, { activeFile: "src/b.ts" }), activeText), "filtered", "the active file has problems, the text matches none");
    const zzz = L.problemFilter("zzz");
    assert.equal(L.emptyState(L.problemList(PROBLEMS, zzz), zzz), "filtered");
    assert.equal(L.showsFilterCount(L.problemList(PROBLEMS, f0)), false, "unfiltered there is no \"5 of 5\"");
    assert.equal(L.showsFilterCount(L.problemList(PROBLEMS, L.problemFilter("unused"))), true);
    assert.equal(L.showsFilterCount(L.problemList([], f0)), false);
    assert.equal(L.showsFilterCount(notLoaded), false);
  },
  rows(L) {
    const l = L.problemList(PROBLEMS, L.problemFilter(""));
    const z = L.visibleRows(l.groups, new Set(["src/b.ts"]));
    const kind = (x) => (x.kind === "file" ? x.key : `${x.entry.file}:${x.entry.line}.${x.entry.column}`);
    assert.deepEqual(z.map(kind), ["src/a.ts", "src/a.ts:2.3", "src/a.ts:2.7", "src/a.ts:9.1", "src/b.ts", "gen/finder.ts", "gen/finder.ts:1.1"], "collapsed: without children");
    assert.equal(z[4].open, false);
    assert.deepEqual(L.leftOf(z, 2), { index: 0, collapse: null }, "left arrow from a problem: to the file");
    assert.deepEqual(L.leftOf(z, 0), { index: 0, collapse: "src/a.ts" }, "left arrow on an open file: collapse");
    assert.deepEqual(L.leftOf(z, 4), { index: 4, collapse: null }, "left arrow on a collapsed file: nothing");
    assert.equal(z[1].multiline, false);
    // Multi-line messages show all lines by default (VS Code `MarkersViewModel` multiline = true), switchable to single-line per problem.
    const m = L.problemList([P("m.ts", 1, "error", "first\nsecond\r\nthird")], L.problemFilter(""));
    const zm = L.visibleRows(m.groups, new Set());
    assert.deepEqual(zm[1].rows, ["first", "second", "third"], "by default all lines of the message are shown");
    assert.equal(zm[1].height, 3);
    assert.equal(zm[1].multiline, true);
    const ze = L.visibleRows(m.groups, new Set(), new Set([zm[1].key]));
    assert.deepEqual(ze[1].rows, ["first"], "switched to single-line: only the first line");
    assert.equal(ze[1].height, 1);
    assert.equal(ze[1].multiline, true, "the toggle stays (the message HAS several lines)");
  },
  // The selection follows the problem — its key does not depend on the position in the list.
  key(L) {
    const prior = L.problemList(PROBLEMS, L.problemFilter(""));
    const after = L.problemList([P("src/a.ts", 1, "error", "new before"), ...PROBLEMS], L.problemFilter(""));
    assert.ok(keyOf(prior, 9, "Unused import"));
    assert.equal(keyOf(prior, 9, "Unused import"), keyOf(after, 9, "Unused import"), "a new problem before it shifts the key");
    const duplicate = L.problemList([P("d.ts", 1, "error", "x"), P("d.ts", 1, "error", "x")], L.problemFilter(""));
    assert.equal(new Set(duplicate.groups[0].key).size, 2, "two equal problems share a key");
    const filtered = L.problemList(PROBLEMS, L.problemFilter("unused"));
    for (const g of filtered.groups) {
      assert.equal(g.key.length, g.entries.length, "filtered: keys and problems diverge");
      g.entries.forEach((e, i) => assert.equal(g.key[i], keyOf(prior, e.line, e.message), "filtered: a problem carries a foreign key"));
    }
    const rowList = L.visibleRows(prior.groups, new Set());
    assert.equal(new Set(rowList.map((x) => x.key)).size, rowList.length, "every row has a key of its own");
  },
  // Only the visible excerpt is drawn (with a reserve), also with multi-line messages.
  excerpt(L) {
    const positions = L.rowPositions(Array.from({ length: 50 }, () => ({ height: 1 })), 22);
    assert.equal(positions.total, 1100);
    assert.deepEqual(L.excerpt(positions, 0, 100), { from: 0, until: 13 }, "top: the visible five and eight reserve");
    assert.deepEqual(L.excerpt(positions, 440, 100), { from: 12, until: 33 }, "scrolled: from the line at the top edge");
    assert.deepEqual(L.excerpt(positions, 450, 100, 0), { from: 20, until: 25 }, "without reserve exactly the visible ones");
    assert.deepEqual(L.excerpt(L.rowPositions([]), 0, 100), { from: 0, until: 0 });
    assert.deepEqual(L.rowPositions([{ height: 1 }, { height: 3 }, { height: 1 }], 22), { top: [0, 22, 88], total: 110 }, "a multi-line message is taller");
  },
  // A click opens as a preview and LEAVES the focus in the list; double-click and Enter open fixed and GIVE it to the editor.
  jump(L) {
    assert.deepEqual(L.jumpKind("click"), { fixed: false, focus: false }, "click");
    assert.deepEqual(L.jumpKind("spacebar"), { fixed: false, focus: false }, "space bar");
    assert.deepEqual(L.jumpKind("double-click"), { fixed: true, focus: true }, "double-click");
    assert.deepEqual(L.jumpKind("enter"), { fixed: true, focus: true }, "↵");
  },
  badge(L) {
    assert.deepEqual([0, -1, 5, 999, 1000, 1500, 12000].map(L.badgesText), ["", "", "5", "999", "1K", "1K+", "12K"]);
    assert.equal(L.sourceText("ts", 2304), "ts(2304)");
    assert.equal(L.sourceText("eslint", null), "eslint");
    assert.equal(L.sourceText(null, "E501"), "(E501)");
    assert.equal(L.sourceText(null, undefined), "");
    assert.equal(L.firstRow("a\r\nb"), "a");
  },
};

test("(1) computations: globs, invalid globs, filter, ordering, filtering, empty, rows, keys, excerpt, jump, badge", () => {
  for (const [k, check] of Object.entries(CHECKS)) {
    try { check(real); } catch (e) { throw new Error(`${k}: ${e.message}`); }
  }
});

test("(1) counter-tests: every sabotage appears exactly once in the source and is caught by its check", () => {
  const stale = copies.filter((k) => k.places !== 1).map((k) => `${k.name} (${k.places}×)`);
  assert.deepEqual(stale, [], "sabotages whose spot does not appear exactly once in the source");
  const notCaught = [];
  for (const s of sabotaged) {
    let caught = false;
    try { if (!s.mod) throw new Error("not compiled"); CHECKS[s.catches](s.mod); } catch { caught = true; }
    if (!caught) notCaught.push(`${s.name} (${s.catches})`);
  }
  assert.deepEqual(notCaught, [], "sabotages that no check catches");
  console.log(`  [problems-list] ${sabotaged.length} sabotages, each caught`);
});

// ── (2) The sources ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Only comments at the start of a line and JSX comments — a "/*" in the middle of a string (the placeholder "**/*.ts, !**/…") stays.
const withoutComments = (s) => s.replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\*[\s\S]*?\*\//gm, "");
const Q = {
  view: read("src", "components", "code", "panel", "ProblemsView.tsx"),
  panel: read("src", "components", "code", "panel", "LowerPanel.tsx"),
  pane: read("src", "components", "CodePane.tsx"),
  layout: read("src", "components", "code", "layout-problems.ts"),
  css: read("src", "app", "globals.css"),
  terminal: read("src", "components", "TerminalPanel.tsx"),
  debug: read("src", "components", "DebugPanel.tsx"),
  header: read("src", "components", "code", "explorer", "ExplorerHeader.tsx"),
  navCore: read("src", "components", "code", "lsp-nav-core.ts"),
  navConnection: read("src", "components", "code", "navigation-connection.tsx"),
};
/** The text between two marks (the first must be there). */
const between = (s, from, until) => { const i = s.indexOf(from); assert.ok(i >= 0, `mark missing: ${from.slice(0, 60)}`); const j = s.indexOf(until, i + from.length); return s.slice(i, j < 0 ? undefined : j); };
const SOURCE_CHECKS = {
  view(q) {
    const a = withoutComments(q.view);
    assert.ok(a.includes("className=\"cb-tree cb-scroll relative h-full overflow-auto outline-none\"") && a.includes("className=\"cb-tree-row\"") && a.includes("className=\"cb-tree-row flex-col !items-stretch\""), "the list does not carry the form of the explorer");
    assert.ok(a.includes("t(\"No problems have been detected in the workspace.\")") && a.includes("t(\"No results found with provided filter criteria.\")") && a.includes("t(\"Clear Filters\")"), "the empty texts are not those of VS Code");
    assert.ok(a.includes("t(\"No problems have been detected in the current file.\")"), "\"Active file only\" without a problem in it does not say what VS Code says");
    assert.ok(/<div tabIndex=\{0\} className="h-full px-5[^>]*data-panel-focus data-problems-empty=\{empty\}/.test(a), "the empty text is not focusable (Shift+Cmd+M would never close it)");
    assert.ok(a.includes("if (empty === \"loading\") return null;"), "a not yet loaded list shows an empty text");
    assert.ok(a.includes("onClick={() => { onSelect(z.key); onJump(p, jumpKind(\"click\")); }}") && a.includes("onDoubleClick={() => onJump(p, jumpKind(\"double-click\"))}") && a.includes("else onJump(z.entry, jumpKind(e.key === \"Enter\" ? \"enter\" : \"spacebar\"));"), "click, double-click and Enter do not choose the focus as VS Code does");
    assert.ok(!a.includes("box.current?.focus("), "the focus is pulled back after a jump (snatched the focus from the editor after a double-click)");
    for (const k of ["ArrowDown", "ArrowUp", "Home", "End", "ArrowLeft", "ArrowRight", "Enter"]) assert.ok(a.includes(`e.key === "${k}"`), `key ${k} missing`);
    assert.ok(a.includes("t(\"[Ln {z}, Col {s}]\", { z: p.line, s: p.column ?? 1 })"), "the position without a column");
    assert.ok(a.includes("<FileSymbol path={z.group.file}") && a.includes("sourceText(p.source, p.code)"), "file symbol or source missing");
    assert.ok(a.includes("placeholder={t(\"Filter (e.g. text, **/*.ts, !**/node_modules/**)\")}"), "the filter field does not carry the VS Code wording");
    for (const m of ["Show Errors", "Show Warnings", "Show Infos", "Show Excluded Files", "Show Active File Only"]) assert.ok(a.includes(`<MenuEntry label={t("${m}")}`), `funnel without "${m}"`);
    assert.ok(a.includes("{showsFilterCount(list) && "), "\"n of m\" is shown even if nothing is missing");
    assert.ok(a.includes("{rows.slice(from, until).map((z, k) => {") && a.includes("const { from, until } = excerpt(positions, view.roles, view.height);"), "the list draws every row, not only the excerpt");
    assert.ok(a.includes("const Row = memo(function Row(") && a.includes("<Row key={z.key}"), "up/down arrows redraw the whole list (no row on its own)");
    assert.ok(a.includes("const index = rows.findIndex((z) => z.key === active);") && a.includes("useEffect(() => { if (active && index < 0) setActive(null); }, [active, index]);"), "the selection does not follow the problem (or silently falls to the first row)");
    assert.ok(a.includes("role=\"tree\"") && a.includes("aria-activedescendant={") && a.includes("role=\"treeitem\""), "the list does not tell assistive technology which row is selected");
    assert.ok(a.includes("onClick={(e) => { e.stopPropagation(); onSingleLine(z.key); }}"), "a multi-line message cannot be switched to single-line");
  },
  panel(q) {
    const p = withoutComments(q.panel);
    assert.ok(p.includes("{PANEL_TAB.map((r) => (") && p.includes("uppercase") && p.includes("absolute bottom-[4px] left-2 right-2 h-px bg-accent"), "the tabs are not like VS Code (uppercase, underlined)");
    assert.ok(p.includes("<Badge text={badgesText(badge)}"), "the PROBLEMS tab carries no badge");
    assert.ok(p.includes("onBack={() => setHeight(panelBack(mass), true)}"), "double-click on the drag bar does not restore 40 %");
    const turn = between(p, "if (!finished) {", "if (z.frame) cancelAnimationFrame(z.frame);");
    assert.ok(turn.includes("requestAnimationFrame(") && !turn.includes("setHeight(") && !turn.includes("onAction("), "while dragging, every movement goes into state (all of CodePane re-renders, the terminal gets a SIGWINCH per frame)");
    assert.ok(p.includes("setHeight(panelHeight(z.wish, mass), true);"), "the dragged height is not clamped");
    assert.ok(p.includes("if (snap(z.wish, PANEL_MIN_HEIGHT) === \"off\") { onAction({ kind: \"close\" }); return; }"), "below half the minimum height the panel does not snap off (SplitView snap)");
    assert.ok(p.includes("measure(column, panelRef.current, m.editorMin)") && !p.includes("innerHeight"), "the panel measures on the window instead of its container");
    assert.ok(p.includes("useLayoutEffect(() => {\n    const column = panelRef.current?.parentElement;"), "the panel measures only after the first paint (it jumps)");
    // Several terminals: each stays mounted, the non-front ones only hidden (`hidden`), the panel only closed. Mounted means: EVERY
    // terminal is in the tree as long as there is one — independent of tab, open and the active one.
    assert.ok(p.includes("{terminal && (\n") && p.includes("{terminals.map((x) => (\n                <div key={x.seq} className={`absolute inset-0 ${x.seq === activeTerminal") && p.includes("<div className={`absolute inset-0 flex outline-none ${open && front === \"terminal\" ? \"\" : \"hidden\"}`} role=\"tabpanel\"")
      && p.includes("<div key={x.seq} className={`absolute inset-0 ${x.seq === activeTerminal ? \"\" : \"hidden\"}`} data-terminal-seq={x.seq}")
      && p.includes("const terminal = terminals.length > 0;") && p.includes("const visible = state.open || terminal;") && p.includes("if (!visible) return null;"), "the terminal dies on tab switch or closing");
    for (const k of ["Maximize Panel", "Restore Panel", "Hide Panel"]) assert.ok(p.includes(`t("${k}")`), `"${k}" missing`);
    assert.ok(p.includes("data-maximized={panelMaximized(state) ? \"\" : undefined}"), "maximized is not marked");
    assert.ok(p.includes("role=\"tab\"") && p.includes("aria-controls={contentId(r)}") && (p.match(/role="tabpanel"/g) ?? []).length === 3 && p.includes("onKeyDown={(e) => tabKey(e, r)}"), "the tabs are not a tab list (aria-controls, tabpanel, left/right arrows)");
    assert.ok(p.includes("label={t(\"Panel height\")}") && p.includes("value={{ now: h, min: PANEL_MIN_HEIGHT, max: mass.slot - mass.editorMin }}"), "the drag bar of the panel has no name or value for assistive technology");
    assert.ok(p.includes("problems: readonly ProblemEntry[] | null;"), "the panel does not know \"not loaded yet\"");
    assert.ok(p.includes("onlyActiveFile: false, excludedShow: true };"), "\"Show Excluded Files\" is not on by default (VS Code)");
  },
  pane(q) {
    const c = withoutComments(q.pane);
    assert.ok(c.includes("onJump={(p, o) => { nav.connection.rememberJump(p.file, { line: p.line - 1, character: (p.column ?? 1) - 1 }, undefined, { focus: o.focus }); void openFile(p.file, undefined, o.fixed); }}"), "CodePane does not jump to line AND column or does not pass the focus request on");
    assert.ok(c.includes("badge={problemCount.error + problemCount.warnings + (problemCount.infos ?? 0)}") && c.includes("const problemCount = useProblemCount(target, tabs.map((x) => x.path));"), "the badge does not count like VS Code (errors + warnings + infos from the stock)");
    // The title is the name of the shell (VS Code `${process}`) as soon as the terminal reports it.
    assert.ok(c.includes("terminals={lay.terminals.list.map((x) => ({ seq: x.seq, title: terminalTitle(x.cwd, projectName, shellNames[x.seq]), node: <TerminalPanel apiBase={apiBase} instance={instance} cwd={x.cwd} onEnded={() => layConn.terminalWay(x.seq)} onShell={(n) => setShellNames((m) => (m[x.seq] === n ? m : { ...m, [x.seq]: n }))} letThrough={(e) => keyForTheWorkbench(e) || G.groupThroughTheTerminal(e, isMac())} /> }))}")
      && c.includes("onTerminalEnd={layConn.terminalWay}"), "the terminal is not in the panel, does not report its end or takes the workbench keys");
    // In addition the terminal lets Cmd+1/Cmd+2 through (VS Code `commandsToSkipShell` names focusFirst/SecondEditorGroup) — checked
    // in web/test/editor-groups.test.mjs.
    assert.ok(c.includes("onClick={() => layConn.panelStep({ kind: \"toggle\", tab: \"problems\" })}"), "the counter of the status bar opens the problems without focus (VS Code toggleProblems)");
    assert.ok(!c.includes("bottom === \"terminal\" &&") && !c.includes("bottom === \"problems\" && (") && !/<TerminalPanel[^>]*onClose/.test(c), "an old box of the panel is still beside it");
    assert.ok(c.includes("debug={<DebugConsole output={debugOutput} onEvaluate={evaluate} />}") && c.includes("<DebugView") && c.includes("{mode === \"debug\" && ("), "the debug console is not only the REPL, or \"Run and Debug\" is missing in the side bar");
    assert.ok(c.includes("layConn.panelStep({ kind: \"show\", tab: \"debug\" });") && c.includes("setMode(\"debug\"); treeShowRef.current();"), "a debug start does not show the console, or a stop does not show \"Run and Debug\" (VS Code openOnDebugBreak)");
  },
  // Console = REPL; buttons, variables, watch, call stack, breakpoints in the side bar with a tab of their own.
  debug(q) {
    const d = withoutComments(q.debug);
    const console = between(d, "export function DebugConsole(", "function Section(");
    assert.ok(console.includes("data-panel-focus") && console.includes("onEvaluate(inputText.trim());"), "the debug console has no input (Shift+Cmd+M/Cmd+J would find no target)");
    assert.ok(!/Step |stepOver|onCmd|Variables|Call Stack/.test(console), "buttons, variables or call stack are in the console");
    for (const k of ["Variables", "Watch", "Call Stack", "Breakpoints"]) assert.ok(d.includes(`<Section title={t("${k}")}`), `"Run and Debug" without the section ${k}`);
    assert.ok(d.includes("buttonEl(t(\"Step over (F10)\"), \"stepOver\"") && d.includes("buttonEl(t(\"Continue (F5)\"), \"continue\""), "the step buttons are missing in \"Run and Debug\"");
    assert.ok(withoutComments(q.header).includes("{ m: \"debug\", title: t(\"Run and Debug · ⇧⌘D\"), symbol: <DebugSymbol /> },"), "the activity bar has no \"Run and Debug\" tab");
  },
  // The terminal in the panel.
  terminal(q) {
    const t = withoutComments(q.terminal);
    assert.ok(t.includes("{onClose && <div className=\"flex items-center gap-2 px-3 py-1.5\">"), "the terminal in the panel carries a header of its own");
    assert.ok(t.includes("es.addEventListener(\"exit\", () => { setStatus(\"exited\"); es?.close(); panelCall.current.onEnded?.(); });"), "the end of the shell stays as a dead terminal (VS Code disposes of it)");
    assert.ok(t.includes("term.attachCustomKeyEventHandler((e) => !panelCall.current.letThrough?.(e));"), "xterm takes Ctrl+B/Ctrl+J (VS Code commandsToSkipShell)");
    assert.equal(t.split("post(\"resize\"").length - 1, 1, "the size goes to the PTY at more than one place");
    assert.ok(t.includes("sizeClock = setTimeout(() => {") && t.includes("|| `${term.cols}x${term.rows}` === size) return;"), "the size goes to the PTY per frame (SIGWINCH flood while dragging)");
  },
  // The focus request of the jump arrives at the editor.
  focus(q) {
    const k = withoutComments(q.navCore), a = withoutComments(q.navConnection);
    assert.ok(k.includes("const focus = n.connection.takePending() !== false;") && k.includes("if (focus) view.focus();"), "a jump always focuses the editor");
    assert.ok(a.includes("targets(path, pos, o?.focus !== false, o?.until ?? null);") && a.includes("takePending() { const focus = z.pending?.focus !== false; z.pending = null; return focus; },"), "the focus request is lost between remembering and jumping");
  },
  source(q) {
    const g = withoutComments(q.layout);
    assert.ok(g.includes("column: d.range.start.character + 1, source: d.source, code: d.code"), "the diagnostics do not carry column, source or code");
    assert.ok(g.includes("useState<Problem[] | null>(null)"), "before the first load the list means \"no problems\" (empty is not unknown)");
  },
  css(q) {
    const c = q.css;
    assert.ok(c.includes("[data-panel-maximized] > :not([data-lower-panel]):not([data-editor-status-bar]) { display: none; }"), "maximized does not cover the editor");
    for (const f of ["--problem-symbol-error: #f14c4c;", "--problem-symbol-warning: #cca700;", "--problem-symbol-info: #3794ff;", "--problem-symbol-error: #e51400;", "--problem-symbol-warning: #bf8803;", "--problem-symbol-info: #1a85ff;", "--badge-background: #616161;", "--badge-background: #cccccc;"]) {
      assert.ok(c.includes(f), `color missing: ${f}`);
    }
  },
};
const SOURCE_SABOTAGES = {
  "list in a form of its own": { file: "view", old: "className=\"cb-tree cb-scroll relative h-full overflow-auto outline-none\"", fresh: "className=\"flex flex-col\"", catches: "view" },
  "own empty text": { file: "view", old: "t(\"No problems have been detected in the workspace.\")", fresh: "t(\"No issues.\")", catches: "view" },
  "empty text of the active file missing": { file: "view", old: "t(\"No problems have been detected in the current file.\")", fresh: "t(\"No issues.\")", catches: "view" },
  "empty text not focusable": { file: "view", old: "<div tabIndex={0} className=\"h-full px-5", fresh: "<div className=\"h-full px-5", catches: "view" },
  "loading shows an empty text": { file: "view", old: "if (empty === \"loading\") return null;", fresh: "", catches: "view" },
  "click takes the focus": { file: "view", old: "onJump(p, jumpKind(\"click\"))", fresh: "onJump(p, jumpKind(\"double-click\"))", catches: "view" },
  "focus pulled back after the jump": { file: "view", old: "onJump(p, jumpKind(\"click\")); }}", fresh: "onJump(p, jumpKind(\"click\")); requestAnimationFrame(() => box.current?.focus()); }}", catches: "view" },
  "double-click as preview": { file: "view", old: "onDoubleClick={() => onJump(p, jumpKind(\"double-click\"))}", fresh: "onDoubleClick={() => onJump(p, jumpKind(\"click\"))}", catches: "view" },
  "position without column": { file: "view", old: "s: p.column ?? 1 })", fresh: "s: 1 })", catches: "view" },
  "funnel without active file": { file: "view", old: "<MenuEntry label={t(\"Show Active File Only\")}", fresh: "<MenuEntry label={t(\"Active\")}", catches: "view" },
  "funnel without excluded files": { file: "view", old: "<MenuEntry label={t(\"Show Excluded Files\")}", fresh: "<MenuEntry label={t(\"Off\")}", catches: "view" },
  "n of m always": { file: "view", old: "{showsFilterCount(list) && ", fresh: "{true && ", catches: "view" },
  "whole list drawn": { file: "view", old: "{rows.slice(from, until).map((z, k) => {", fresh: "{rows.map((z, k) => {", catches: "view" },
  "row without memo": { file: "view", old: "const Row = memo(function Row(", fresh: "const Row = (function Row(", catches: "view" },
  "selection falls to the first row": { file: "view", old: "const index = rows.findIndex((z) => z.key === active);", fresh: "const index = Math.max(0, rows.findIndex((z) => z.key === active));", catches: "view" },
  "without active descendant": { file: "view", old: "aria-activedescendant={", fresh: "data-x={", catches: "view" },
  "single-line without toggle": { file: "view", old: "onSingleLine(z.key); }}", fresh: "}}", catches: "view" },
  // "Dies" means UNMOUNTED — React rebuilds the shell on the next show, the old one ends. The counter-tests really unmount the terminal
  // (shown only when in front, or only the active one); merely making it invisible would prove nothing about unmounting.
  "terminal dies on tab switch": { file: "panel", old: "{terminal && (\n", fresh: "{terminal && open && front === \"terminal\" && (\n", catches: "panel" },
  "the back terminal dies": { file: "panel", old: "{terminals.map((x) => (\n                <div key={x.seq} className={`absolute inset-0 ${x.seq === activeTerminal", fresh: "{terminals.filter((x) => x.seq === activeTerminal).map((x) => (\n                <div key={x.seq} className={`absolute inset-0 ${x.seq === activeTerminal", catches: "panel" },
  "terminal always visible": { file: "panel", old: "<div className={`absolute inset-0 flex outline-none ${open && front === \"terminal\" ? \"\" : \"hidden\"}`}", fresh: "<div className={`absolute inset-0 flex outline-none`}", catches: "panel" },
  "panel without badge": { file: "panel", old: "<Badge text={badgesText(badge)}", fresh: "<Badge text=\"\"", catches: "panel" },
  "double-click without default": { file: "panel", old: "onBack={() => setHeight(panelBack(mass), true)}", fresh: "onBack={() => {}}", catches: "panel" },
  "drag sets state per movement": { file: "panel", old: "      if (!z.frame) z.frame = requestAnimationFrame(() => {\n        z.frame = 0;\n        if (!el) return;\n        el.style.height", fresh: "      setHeight(panelHeight(z.wish, mass), false);\n      if (!z.frame) z.frame = requestAnimationFrame(() => {\n        z.frame = 0;\n        if (!el) return;\n        el.style.height", catches: "panel" },
  "height unclamped": { file: "panel", old: "setHeight(panelHeight(z.wish, mass), true);", fresh: "setHeight(z.wish, true);", catches: "panel" },
  "panel does not snap off": { file: "panel", old: "if (snap(z.wish, PANEL_MIN_HEIGHT) === \"off\") { onAction({ kind: \"close\" }); return; }", fresh: "", catches: "panel" },
  "window instead of container": { file: "panel", old: "measure(column, panelRef.current, m.editorMin)", fresh: "({ slot: window.innerHeight - 57, work: window.innerHeight, editorMin: m.editorMin })", catches: "panel" },
  "measurement after the paint": { file: "panel", old: "useLayoutEffect(() => {\n    const column", fresh: "useEffect(() => {\n    const column", catches: "panel" },
  "tabs without keyboard": { file: "panel", old: "onKeyDown={(e) => tabKey(e, r)}", fresh: "", catches: "panel" },
  "tabs without content reference": { file: "panel", old: "aria-controls={contentId(r)}", fresh: "", catches: "panel" },
  "drag bar without name": { file: "panel", old: "label={t(\"Panel height\")}", fresh: "label=\"\"", catches: "panel" },
  "excluded off by default (panel)": { file: "panel", old: "onlyActiveFile: false, excludedShow: true };", fresh: "onlyActiveFile: false, excludedShow: false };", catches: "panel" },
  "jump without column": { file: "pane", old: "character: (p.column ?? 1) - 1", fresh: "character: 0", catches: "pane" },
  "jump always takes the focus": { file: "pane", old: ", undefined, { focus: o.focus });", fresh: ");", catches: "pane" },
  "badge without infos": { file: "pane", old: "badge={problemCount.error + problemCount.warnings + (problemCount.infos ?? 0)}", fresh: "badge={problemCount.error + problemCount.warnings}", catches: "pane" },
  "badge from own count": { file: "pane", old: "badge={problemCount.error + problemCount.warnings + (problemCount.infos ?? 0)}", fresh: "badge={problems?.length ?? 0}", catches: "pane" },
  "shell end leaves the terminal": { file: "pane", old: " onEnded={() => layConn.terminalWay(x.seq)}", fresh: "", catches: "pane" },
  "shell end hits the active one instead of its own": { file: "pane", old: "onEnded={() => layConn.terminalWay(x.seq)}", fresh: "onEnded={() => layConn.terminalWay()}", catches: "pane" },
  "terminal takes the workbench keys": { file: "pane", old: " letThrough={(e) => keyForTheWorkbench(e) || G.groupThroughTheTerminal(e, isMac())}", fresh: "", catches: "pane" },
  "status bar without focus": { file: "pane", old: "onClick={() => layConn.panelStep({ kind: \"toggle\", tab: \"problems\" })}", fresh: "onClick={() => setBottom((b) => (b === \"problems\" ? null : \"problems\"))}", catches: "pane" },
  "old terminal box beside it": { file: "pane", old: "        <LowerPanel\n", fresh: "        {bottom === \"terminal\" && <div />}\n        <LowerPanel\n", catches: "pane" },
  "debug box in the panel": { file: "pane", old: "debug={<DebugConsole output={debugOutput} onEvaluate={evaluate} />}", fresh: "debug={<div />}", catches: "pane" },
  "stop does not show the side bar": { file: "pane", old: "setMode(\"debug\"); treeShowRef.current();", fresh: "", catches: "pane" },
  "console without focus target": { file: "debug", old: "          data-panel-focus\n          data-debug-input", fresh: "          data-debug-input", catches: "debug" },
  "steps in the console": { file: "debug", old: "<span aria-hidden className=\"font-mono text-[12px] text-accent\">›</span>", fresh: "<button>{t(\"Step over (F10)\")}</button><span aria-hidden className=\"font-mono text-[12px] text-accent\">›</span>", catches: "debug" },
  "view without breakpoints": { file: "debug", old: "<Section title={t(\"Breakpoints\")}", fresh: "<Section title={t(\"Variables\")}", catches: "debug" },
  "no tab for debugging": { file: "header", old: "    { m: \"debug\", title: t(\"Run and Debug · ⇧⌘D\"), symbol: <DebugSymbol /> },\n", fresh: "", catches: "debug" },
  "terminal with a header of its own": { file: "terminal", old: "{onClose && <div className=\"flex items-center gap-2 px-3 py-1.5\">", fresh: "{<div className=\"flex items-center gap-2 px-3 py-1.5\">", catches: "terminal" },
  "shell end reports nothing": { file: "terminal", old: " panelCall.current.onEnded?.();", fresh: "", catches: "terminal" },
  "xterm takes all keys": { file: "terminal", old: "term.attachCustomKeyEventHandler((e) => !panelCall.current.letThrough?.(e));", fresh: "", catches: "terminal" },
  "size per frame": { file: "terminal", old: "        clearTimeout(sizeClock);\n", fresh: "        if (term) post(\"resize\", { cols: term.cols, rows: term.rows });\n        clearTimeout(sizeClock);\n", catches: "terminal" },
  "size without comparison": { file: "terminal", old: " || `${term.cols}x${term.rows}` === size) return;", fresh: ") return;", catches: "terminal" },
  "jump always focuses": { file: "navCore", old: "if (focus) view.focus();", fresh: "view.focus();", catches: "focus" },
  "focus request is lost": { file: "navConnection", old: "targets(path, pos, o?.focus !== false, o?.until ?? null);", fresh: "targets(path, pos, true, o?.until ?? null);", catches: "focus" },
  "diagnostic without column": { file: "layout", old: "column: d.range.start.character + 1, ", fresh: "", catches: "source" },
  "unloaded as empty": { file: "layout", old: "useState<Problem[] | null>(null)", fresh: "useState<Problem[] | null>([])", catches: "source" },
  "maximized covers nothing": { file: "css", old: "[data-panel-maximized] > :not([data-lower-panel]):not([data-editor-status-bar]) { display: none; }", fresh: "", catches: "css" },
  "own error color": { file: "css", old: "--problem-symbol-error: #f14c4c;", fresh: "--problem-symbol-error: #ff0000;", catches: "css" },
};

test("(2) sources: list, panel, jump and focus, terminal, debug, diagnostics, colors (including counter-tests)", () => {
  for (const [k, check] of Object.entries(SOURCE_CHECKS)) {
    try { check(Q); } catch (e) { throw new Error(`${k}: ${e.message}`); }
  }
  const stale = Object.entries(SOURCE_SABOTAGES).filter(([, s]) => Q[s.file].split(s.old).length !== 2).map(([n]) => n);
  assert.deepEqual(stale, [], "sabotages whose spot does not appear exactly once in the source");
  const notCaught = [];
  for (const [name, s] of Object.entries(SOURCE_SABOTAGES)) {
    let caught = false;
    try { SOURCE_CHECKS[s.catches]({ ...Q, [s.file]: Q[s.file].replace(s.old, s.fresh) }); } catch { caught = true; }
    if (!caught) notCaught.push(`${name} (${s.catches})`);
  }
  assert.deepEqual(notCaught, [], "source sabotages that no check catches");
  console.log(`  [problems-list] ${Object.keys(SOURCE_SABOTAGES).length} source sabotages, each caught`);
});
