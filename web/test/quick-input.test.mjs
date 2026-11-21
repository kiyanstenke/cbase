// Quick Input like VS Code -- the computations EXECUTED, the wiring at the source:
//
// (1) Scoring (lib/fuzzy-scorer.ts, port of VS Code `fuzzyScorer.ts`/`filters.ts`): the matrix (sequence bonus, separator, start), the
//     request (words, quotes, path separators), name before path (prefix 1<<17, hit 1<<16, identity 1<<18), the order of Quick Open
//     (numeric file names), the prefilter `fuzzyContains` and the word filter of the commands (`matchesContiguousSubString` or
//     `matchesWords`).
// (2) Binding: the order of Cmd+P on the server (server/backend/electron/server/runtime/fast-open.js, where the cap bites) and on the
//     web (the same computation from lib/fuzzy-scorer.ts, the two stages of VS Code) are THE SAME over a set of paths and inputs --
//     also several words in swapped order --, with six sabotages on the server; plus its prefilter.
// (3) Window (lib/quick-input.ts): position and width, key caps, keys of the list (down/up round-robin, Ctrl+N/P, pages, Ctrl+Home/End,
//     Cmd+down/up groups), history (first, no duplicates, capped), the input of Cmd+P (`file:12:4`, `file:` = row 1, `file@sym` only
//     with a chosen file and at the LAST "@", links), the rows of Cmd+P (recently opened -- contiguous, without "/" only on the name --
//     / file results), of `>` (recently used / other commands, id), `:` (parsePosition with visible columns, negative, `::`), `@` (flat by
//     location, container, "Symbols (n)", `@:` by category, choice at the cursor), `#` (only the first word to the server, container
//     and path), `?`, the switch by key (the filter goes along) and the pieces of the highlighting.
// (4) Source: the window without veil and click catcher at a root of its own on the body, position and keys from lib/quick-input.ts,
//     the history is remembered, Cmd+T enters the word at the cursor of the FOCUSED editor, a switch by key takes the filter along,
//     progress only after 800 ms, only what was opened counts as accepted, a switch away from `:`/`@` restores the editor, right
//     arrow opens without focus, Open to the Side in `@` in the coordinates of the host, every wording is in lib/i18n-de.ts, the form
//     in globals.css (group name, indent, key caps). The preview itself: web/test/palette-preview.test.mjs.
//
// COUNTER-TESTS BUILT IN: every sabotage is a copy of the source with ONE changed place (the place stands exactly once, otherwise the
// sabotage is stale); the assigned check must fail on it.
//
// Run:  node --test --test-reporter=tap web/test/quick-input.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const repo = path.resolve(webDir, "..");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");
const read = (...p) => fs.readFileSync(path.join(webDir, ...p), "utf8");
const SERVER_FILE = path.join(repo, "server", "backend", "electron", "server", "runtime", "fast-open.js");

const SOURCES = { fuzzy: read("src", "lib", "fuzzy-scorer.ts"), qi: read("src", "lib", "quick-input.ts") };
const FILE = { fuzzy: "fuzzy-scorer.ts", qi: "quick-input.ts" };
const SABOTAGES = {
  fuzzy: {
    "no sequence bonus": { old: "if (sequenceL > 0) p += Math.min(sequenceL, 3) * 6 + Math.max(0, sequenceL - 3) * 3;", fresh: "", catches: "matrix" },
    "separator does not count": { old: "if (separator) p += separator;", fresh: "", catches: "matrix" },
    "several words as one": { old: "if (parts.length > 1) {", fresh: "if (false) {", catches: "matrix" },
    "no prefix bonus": { old: "const base = prefix ? NAME_PREFIX + Math.round((a.normalized.length / label.length) * 100) : NAME_THRESHOLD;", fresh: "const base = NAME_THRESHOLD;", catches: "queue" },
    "path before name": { old: "const nameFirst = !path || !a.containsPathSeparator;", fresh: "const nameFirst = false;", catches: "queue" },
    "no identity": { old: "if (path && a.pathNormalized.toLowerCase() === path.toLowerCase()) {", fresh: "if (false) {", catches: "queue" },
    "numbers as text": { old: "new Intl.Collator(undefined, { numeric: true, sensitivity: \"base\" })", fresh: "new Intl.Collator(undefined, { sensitivity: \"base\" })", catches: "queue" },
    "prefilter without order": { old: "const j = tk.indexOf(requestSmall[i], last + 1);", fresh: "const j = tk.indexOf(requestSmall[i]);", catches: "filter" },
    "commands only as substring": { old: "return partHits(word, target) ?? wordHits(word, target);", fresh: "return partHits(word, target);", catches: "filter" },
  },
  qi: {
    "width without cap": { old: "Math.min(window.width * QI_WIDTH_SHARE, QI_WIDTH_MAX)", fresh: "window.width * QI_WIDTH_SHARE", catches: "situation" },
    "not above the anchor": { old: "const middle = anchor ? anchor.left + anchor.width / 2 : window.width / 2;", fresh: "const middle = window.width / 2;", catches: "situation" },
    "key caps as one piece": { old: "while (i < chord.length && \"⌃⌥⇧⌘\".includes(chord[i])) clip.push(chord[i++]);", fresh: "", catches: "situation" },
    "no wrap-around": { old: "case \"next\": return (w + 1) % count;", fresh: "case \"next\": return Math.min(w + 1, count - 1);", catches: "keys" },
    "group via Option on the Mac": { old: "const group = mac ? e.metaKey : e.altKey;", fresh: "const group = e.altKey;", catches: "keys" },
    "progress at once": { old: "export const QI_PROGRESS_MS = 800;", fresh: "export const QI_PROGRESS_MS = 0;", catches: "situation" },
    "Home without Ctrl": { old: "if (k === \"Home\" && e.ctrlKey) return \"first\";", fresh: "if (k === \"Home\") return \"first\";", catches: "keys" },
    "history without cap": { old: "return [entry, ...list.filter((x) => x !== entry)].slice(0, Math.max(0, max));", fresh: "return [entry, ...list.filter((x) => x !== entry)];", catches: "history" },
    "history read with duplicates": { old: "if (typeof x === \"string\" && x && !out.includes(x)) out.push(x);", fresh: "if (typeof x === \"string\" && x) out.push(x);", catches: "history" },
    "column forgotten": { old: "column: Number.isFinite(s) ? s : null, symbol: null };", fresh: "column: null, symbol: null };", catches: "input" },
    "symbol not split off": { old: "if (parts.length > 1 && selected && (!selected.includes(\"@\") || parts.length > 2)) {", fresh: "if (false) {", catches: "input" },
    // The FIRST "@" switched to symbols ("icon@2x", "src/@core/app").
    "symbol at the first @": { old: "symbol: parts[parts.length - 1].trim() };", fresh: "symbol: parts.slice(1).join(\"@\").trim() };", catches: "input" },
    "@ in the path like any other": { old: "(!selected.includes(\"@\") || parts.length > 2)", fresh: "true", catches: "input" },
    "symbols without chosen file": { old: "if (parts.length > 1 && selected && (", fresh: "if (parts.length > 1 && (", catches: "input" },
    // "app.ts:" and "app.ts(" emptied the list -- VS Code goes to row 1.
    "suffix without number stays in the filter": { old: "    if (m[1] === \"\") return { filter: raw.slice(0, m.index).trim(), row: 1, column: null, symbol: null };\n", fresh: "", catches: "input" },
    "row despite @": { old: "if (at === 0 || (at > 0 && !ROWS_PATTERN.test(raw.slice(at + 1)))) return", fresh: "if (false) return", catches: "input" },
    "link without check": { old: "if (/\\s|\\\\/.test(e)) return { valid: false };", fresh: "", catches: "input" },
    "link: javascript allowed": { old: "[\"command\", \"data\", \"javascript\", \"private\"]", fresh: "[\"command\", \"data\", \"private\"]", catches: "input" },
    "history not scored": { old: ".filter((x) => x.w.score > 0)", fresh: "", catches: "files" },
    // The history was scored like the file results (fuzzy, on the path) -- VS Code: contiguous, without "/" only on the name.
    "history fuzzy": { old: ".map((p) => ({ p, w: evaluateEntry(p, a, false, access, storage) }))", fresh: ".map((p) => ({ p, w: evaluateEntry(p, a, true, access, storage) }))", catches: "files" },
    "history on the path": { old: "const access = a.containsPathSeparator ? FILE_ACCESS : FILE_ACCESS_NAME;", fresh: "const access = FILE_ACCESS;", catches: "files" },
    "history twice in the results": { old: "if (already.has(p)) continue;", fresh: "", catches: "files" },
    "commands without history first": { old: "    if (rx !== undefined) return -1;\n    if (ry !== undefined) return 1;\n", fresh: "", catches: "commands" },
    "no separator \"other commands\"": { old: "if (other && !inHistory) { group = GROUP_OTHER_COMMANDS; other = false; }", fresh: "", catches: "commands" },
    "id does not count": { old: "else if (f && f === e.id) matching.push({ e, hits: undefined });", fresh: "", catches: "commands" },
    "row not clamped": { old: "z = Math.min(Math.max(1, z), n);", fresh: "z = Math.max(1, z);", catches: "row" },
    "negative not from the end": { old: "z = z >= 0 ? z : n + 1 + z;", fresh: "", catches: "row" },
    "tab counts one": { old: "s = text[i] === \"\\t\" ? nextTabStop(s, tab) : s + 1;", fresh: "s = s + 1;", catches: "row" },
    "symbols not by location": { old: "out.sort((a, b) => beforePos(a.range.start, b.range.start) || beforePos(a.range.end, b.range.end));", fresh: "", catches: "symbols" },
    "container missing": { old: "go(s.children, String(s.name ?? \"\"));", fresh: "go(s.children, \"\");", catches: "symbols" },
    "@: without category": { old: "return fresh ? { ...x, group: { text: k, values: { n: count.get(k) ?? 0 } } } : x;", fresh: "return x;", catches: "symbols" },
    "rest not on the container": { old: "const c = nameScore(s.container, rest);\n        if (!c) continue;", fresh: "const c = nameScore(s.container, rest) ?? { score: 0, hits: [] };", catches: "symbols" },
    "choice not the innermost": { old: "for (let i = rows.length - 1; i >= 0; i--) {", fresh: "for (let i = 0; i < rows.length; i++) {", catches: "symbols" },
    "workspace without container": { old: "const description = s.container ? `${s.container} • ${s.file}` : s.file;", fresh: "const description = s.file;", catches: "work" },
    // `#` sent the whole rest to the language server -- VS Code only the first word.
    "workspace asks everything": { old: "return a.values && a.values.length > 1 ? a.values[0].original : a.original;", fresh: "return a.original;", catches: "work" },
    // A switch by key threw the filter away.
    "switch without filter": { old: "return { input: `${newPrefix}${String(old ?? \"\").slice(oldPrefix.length)}`, markFrom: newPrefix.length };", fresh: "return { input: newPrefix, markFrom: newPrefix.length };", catches: "help" },
    "link without host": { old: "if (!/^[a-z][a-z0-9+.-]+:\\/\\/[^/?#]/i.test(e)) return { valid: false };", fresh: "", catches: "input" },
    "help unsorted": { old: "[...entries].sort((a, b) => a.prefix.localeCompare(b.prefix))", fresh: "[...entries]", catches: "help" },
    "help keeps the rest": { old: "return candidates.length ? candidates[0].prefix : null;", fresh: "return candidates.length ? r : null;", catches: "help" },
    "help takes the shortest": { old: ".sort((a, b) => b.prefix.length - a.prefix.length)", fresh: "", catches: "help" },
    "pieces overlap": { old: "const s = Math.max(x.start, i);", fresh: "const s = x.start;", catches: "chunks" },
  },
};

// ── Compile: both modules and one copy per sabotage, in ONE tsc run (the copies of quick-input.ts take the real fuzzy-scorer.ts). ──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-quick-input-"));
const src = path.join(tmp, "src"), out = path.join(tmp, "out");
fs.mkdirSync(src, { recursive: true });
for (const [k, q] of Object.entries(SOURCES)) fs.writeFileSync(path.join(src, FILE[k]), q);
const copies = [];
for (const [k, list] of Object.entries(SABOTAGES)) {
  for (const [name, s] of Object.entries(list)) {
    const file = FILE[k].replace(/\.ts$/, `-sabotage-${copies.length}.ts`);
    fs.writeFileSync(path.join(src, file), SOURCES[k].replace(s.old, s.fresh));
    copies.push({ name, module: k, file, catches: s.catches, places: SOURCES[k].split(s.old).length - 1 });
  }
}
try {
  execFileSync(process.execPath, [tsc, ...fs.readdirSync(src).map((f) => path.join(src, f)), "--outDir", out, "--rootDir", src, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler", "--strict", "--skipLibCheck", "--lib", "es2022,dom"], { stdio: "pipe" });
} catch (e) {
  const text = `${String(e.stdout || "")}${String(e.stderr || "")}`;
  const realError = text.split("\n").filter((z) => /error TS\d+/.test(z) && !/-sabotage-\d+\.ts\(/.test(z));
  if (realError.length || !fs.existsSync(path.join(out, "quick-input.js"))) throw new Error(`tsc: ${text}`.slice(0, 4000));
}
const load = (file) => import(pathToFileURL(path.join(out, file.replace(/\.ts$/, ".js"))).href);
const real = { fuzzy: await load(FILE.fuzzy), qi: await load(FILE.qi) };
const sabotaged = await Promise.all(copies.map(async (k) => ({ ...k, mod: await load(k.file) })));
// The server: real and sabotages (as .mjs copies in the temp folder).
const SERVER_SOURCE = fs.readFileSync(SERVER_FILE, "utf8");
const SERVER_SABOTAGES = {
  "server does not sort": { old: "const sorted = list.slice().sort(L.compare);", fresh: "const sorted = list.slice();" },
  "server without prefix bonus": { old: "const base = pr ? NAME_PREFIX + Math.round((a.normalized.length / label.length) * 100) : NAME_THRESHOLD;", fresh: "const base = NAME_THRESHOLD;" },
  // The prefilter with ALL words without whitespace -- "prefix kiosk" did not find src/kiosk/prefix.ts.
  "server: all words in the prefilter": { old: "const first = search(several ? whole.values[0].original : whole.original);", fresh: "const first = search(whole.original);" },
  "server: no second search at the cap": { old: "if (first.limitHit && several) {", fresh: "if (false) {" },
  "server keeps score 0": { old: "const results = sorted.slice(0, n).filter((p) => L.score(p).score > 0);", fresh: "const results = sorted.slice(0, n);" },
  "server sorts only by the first word": { old: "const L = reader(whole);", fresh: "const L = reader(prepare(several ? whole.values[0].original : whole.original));" },
};
const server = await import(pathToFileURL(SERVER_FILE).href);
const serverCopies = [];
for (const [name, s] of Object.entries(SERVER_SABOTAGES)) {
  const f = path.join(tmp, `fast-open-sabotage-${serverCopies.length}.mjs`);
  fs.writeFileSync(f, SERVER_SOURCE.replace(s.old, s.fresh));
  serverCopies.push({ name, places: SERVER_SOURCE.split(s.old).length - 1, mod: await import(pathToFileURL(f).href) });
}
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { console.warn("[test] temp directory stayed behind:", String(e?.message || e).slice(0, 120)); }

// ── Helpers ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const R = (l1, c1, l2, c2) => ({ start: { line: l1, character: c1 }, end: { line: l2, character: c2 } });
const S = (name, kind, from, until, children) => ({ name, kind, range: R(from, 0, until, 1), selectionRange: R(from, 6, from, 6 + name.length), ...(children ? { children: children } : {}) });
// class Laden 0-40 { kiosk 2-20 { counts 5-12 }, bon 22-39 }, function helps 42-50 -- deliberately NOT delivered by location.
const LAYOUT = [S("helps", 12, 42, 50), S("Laden", 5, 0, 40, [S("bon", 6, 22, 39), S("kiosk", 6, 2, 20, [S("counts", 6, 5, 12)])])];
const press = (key, mods = {}) => ({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });
/** A document for `rowsTarget` (like the connector in palette-modes.ts: rows 1-based, offset -> row/column 1-based). */
function doc(rows) {
  const text = rows.join("\n");
  return {
    rows: rows.length,
    row: (n) => rows[n - 1],
    length: text.length,
    locationOf(o) {
      let rest = o;
      for (let i = 0; i < rows.length; i++) {
        if (rest <= rows[i].length) return { row: i + 1, column: rest + 1 };
        rest -= rows[i].length + 1;
      }
      return { row: rows.length, column: rows[rows.length - 1].length + 1 };
    },
  };
}
/** The row of Cmd+P with the web computation -- the two stages of VS Code (like the server): (1) the file search with the FIRST word
 * (`values[0]`, else the whole input) as pattern -- `fuzzyContains`, sorted by this pattern, capped; at the cap with several words
 * also the search with the whole input; (2) everything sorted by the WHOLE input, the best `cap`, score 0 drops. */
function webQueue(F, files, input, cap) {
  const whole = F.prepareRequest(input);
  if (!whole.normalized) return { results: [], truncated: false };
  const search = (pattern) => {
    const q = F.prepareRequest(pattern);
    const t = q.normalizedLowercase ? files.filter((p) => F.containsFuzzy(p, q.normalizedLowercase)) : [];
    t.sort((x, y) => F.compareEntries(x, y, q, true, F.FILE_ACCESS));
    return { results: t.slice(0, cap), limitHit: t.length > cap };
  };
  const several = (whole.values?.length ?? 0) > 1;
  const first = search(several ? whole.values[0].original : whole.original);
  const list = [...first.results];
  if (first.limitHit && several) for (const p of search(whole.original).results) if (!list.includes(p)) list.push(p);
  list.sort((x, y) => F.compareEntries(x, y, whole, true, F.FILE_ACCESS));
  return { results: list.slice(0, cap).filter((p) => F.evaluateEntry(p, whole, true, F.FILE_ACCESS).score > 0), truncated: first.limitHit || list.length > cap };
}
const PATHS = [
  "src/kiosk/prefix.ts", "docs/prefix-note.md", "src/lib/bufferpool.ts", "src/bpmn/x.ts", "README.md", "readme.txt", "src/a/b/c.ts",
  "file2.ts", "file10.ts", "file1.ts", "src/File2.ts", "src/index.ts", "web/src/index.tsx", "web/src/components/Index.tsx", "lib/ui/Ui.tsx",
  "src/kiosk/PrefixList.ts", "test/prefix.test.ts", "a/b.ts", "b/a.ts", "ab.ts", "x_a_b.ts", "src/kiosk/kiosk.ts", "kiosk.md", "Makefile",
  "src/very/deep/folder/structure/prefix.ts", "src/fooBar.ts", "src/foo_bar.ts", "src/foo-bar.ts", "src/foo.bar.ts", "pkg/zz/tief.txt",
];
const INPUTS = ["prefix", "pre", "bp", "src/kiosk", "PREFIX.TS", "src/kiosk/prefix.ts", "k p", "file", "file1", "x", "ts", "readme",
  "a/b", "\"prefix\"", "", "zzz", "ui", "index", "fb", "foo bar", "kiosk", "pt", "src\\kiosk",
  // Several words in ANY order -- also swapped; one that only the first word carries.
  "prefix kiosk", "kiosk prefix", "notiz docs", "docs notiz", "index web", "web index", "bar foo", "s p", "p s", "prefix zzz", "t s a"];

// ── The checks (each against one module, so that the sabotages hit them) ────────────────────────────────────────────────────────────
const CHECKS = {
  matrix(F) {
    assert.deepEqual(F.scoreFuzzy("prefix.ts", "pre", "pre", true), [32, [0, 1, 2]], "p 1+1+8, r 1+6+1, e 1+12+1");
    assert.deepEqual(F.scoreFuzzy("a/bc", "b", "b", true), [7, [2]], "after \"/\": +5");
    assert.deepEqual(F.scoreFuzzy("a_bc", "b", "b", true), [6, [2]], "after \"_\": +4");
    assert.deepEqual(F.scoreFuzzy("fooBar", "b", "b", true), [3, [3]], "inner capital +2 (without equal case)");
    assert.equal(F.scoreFuzzy("abc", "abcd", "abcd", true)[0], 0, "longer than the target");
    assert.equal(F.scoreFuzzy("xaybz", "ab", "ab", false)[0], 0, "contiguous demanded: the start must stand together");
    const a = F.prepareRequest("kiosk  prefix");
    assert.deepEqual(a.values.map((v) => v.normalized), ["kiosk", "prefix"], "two words, two values");
    assert.equal(a.normalized, "kioskprefix", "whitespace drops");
    assert.equal(F.prepareRequest("\"prefix\"").expectContiguousMatch, true, "quotes demand contiguous");
    assert.equal(F.prepareRequest("src\\kiosk").containsPathSeparator, true, "\"\\\" is a path separator");
    assert.equal(F.prepareRequest("a*b…c#").normalized, "abc", "\"*\", \"…\" and a trailing \"#\" drop");
  },
  queue(F) {
    const w = (p, q) => F.evaluateEntry(p, F.prepareRequest(q), true, F.FILE_ACCESS);
    const pr = w("src/kiosk/prefix.ts", "pre");
    assert.ok(pr.score > F.NAME_PREFIX && pr.score < F.PATH_IDENTITY, `prefix of the name: ${pr.score}`);
    assert.deepEqual(pr.labelMatch, [{ start: 0, end: 3 }]);
    const middle = w("src/kiosk/prefix.ts", "efi");
    assert.ok(middle.score > F.NAME_THRESHOLD && middle.score < F.NAME_PREFIX, `hit in the name: ${middle.score}`);
    const filePath = w("src/kiosk/prefix.ts", "skp");
    assert.ok(filePath.score > 0 && filePath.score < F.NAME_THRESHOLD, `hit only in the path: ${filePath.score}`);
    assert.ok(filePath.descriptionMatch?.length, "the path carries the highlighting");
    assert.equal(w("src/kiosk/prefix.ts", "SRC/kiosk/Prefix.TS").score, F.PATH_IDENTITY, "the path itself (case-insensitive, as on the Mac)");
    const withSeparator = w("src/kiosk/prefix.ts", "kiosk/prefix");
    assert.ok(withSeparator.score > 0 && withSeparator.score < F.NAME_THRESHOLD, "with \"/\" the path is scored, not the name");
    const queue = (q, list) => [...list].sort((x, y) => F.compareEntries(x, y, F.prepareRequest(q), true, F.FILE_ACCESS));
    assert.deepEqual(queue("prefix", ["docs/prefix-note.md", "src/very/deep/folder/structure/prefix.ts", "src/kiosk/prefix.ts"]),
      ["src/kiosk/prefix.ts", "src/very/deep/folder/structure/prefix.ts", "docs/prefix-note.md"]);
    assert.deepEqual(queue("bp", ["src/bpmn/x.ts", "src/lib/bufferpool.ts"]), ["src/lib/bufferpool.ts", "src/bpmn/x.ts"], "name before path");
    assert.ok(F.compareFileNames("file2", "file10") < 0, "numbers as numbers");
    assert.deepEqual(queue("file", ["file10.ts", "file2.ts", "file1.ts"]), ["file1.ts", "file2.ts", "file10.ts"]);
  },
  filter(F) {
    assert.equal(F.containsFuzzy("src/kiosk/prefix.ts", "skp"), true);
    assert.equal(F.containsFuzzy("abc", "cb"), false, "the order counts");
    assert.equal(F.containsFuzzy("abc", ""), false);
    assert.deepEqual(F.wordFilter("speich", "Datei: Speichern"), [{ start: 7, end: 13 }]);
    assert.deepEqual(F.wordFilter("gzd", "Gehe zu Definition"), [{ start: 0, end: 1 }, { start: 5, end: 6 }, { start: 8, end: 9 }], "word starts");
    assert.equal(F.wordFilter("xyz", "Datei: Speichern"), null);
    assert.ok(F.wordFilter("ÄNDERN", "Datei: andern") !== null, "without accent and case");
  },
  situation(Q) {
    assert.deepEqual(Q.quickInputSituation({ width: 1400, height: 900 }, { top: 40, left: 300, width: 1100 }), { top: 40, left: 550, width: 600, listMax: 360 });
    assert.deepEqual(Q.quickInputSituation({ width: 800, height: 1200 }, null), { top: 0, left: 152, width: 496, listMax: 440 }, "62 % of the window, list at most 440");
    assert.equal(Q.quickInputSituation({ width: 1400, height: 900 }, { top: 40, left: 1200, width: 200 }).left, 800, "never beyond the right edge");
    assert.deepEqual(Q.clipKeys("⇧⌘P"), [["⇧", "⌘", "P"]]);
    assert.deepEqual(Q.clipKeys("⌘K ⌘S"), [["⌘", "K"], ["⌘", "S"]], "one chord");
    assert.deepEqual(Q.clipKeys("⌃G"), [["⌃", "G"]]);
    assert.deepEqual(Q.clipKeys("F1"), [["F1"]]);
    assert.deepEqual(Q.clipKeys(""), []);
    assert.equal(Q.QI_PROGRESS_MS, 800, "progress only after 800 ms (VS Code `busyDelay`)");
  },
  keys(Q) {
    const b = (key, mods, mac = true) => Q.movementToKey(press(key, mods), mac);
    assert.equal(b("ArrowDown"), "next");
    assert.equal(b("ArrowUp"), "previous");
    assert.equal(b("ArrowDown", { metaKey: true }), "nextGroup", "Cmd+down on the Mac");
    assert.equal(b("ArrowUp", { metaKey: true }), "previousGroup");
    assert.equal(b("ArrowDown", { altKey: true }), "next", "Option+down on the Mac is no group jump");
    assert.equal(b("ArrowDown", { altKey: true }, false), "nextGroup", "Alt+down outside the Mac");
    assert.equal(b("n", { ctrlKey: true }), "next", "⌃N");
    assert.equal(b("p", { ctrlKey: true }), "previous", "⌃P");
    assert.equal(b("n", { ctrlKey: true }, false), null, "Ctrl+N outside the Mac belongs to the field");
    assert.equal(b("PageDown"), "pageBefore");
    assert.equal(b("PageUp"), "pageBack");
    assert.equal(b("Home"), null, "Home belongs to the input field");
    assert.equal(b("Home", { ctrlKey: true }), "first");
    assert.equal(b("End", { ctrlKey: true }), "last");
    assert.equal(b("a"), null);
    const g = [0, 3, 7];
    assert.equal(Q.moveChoice(4, 5, "next", 1), 0, "round-robin downwards");
    assert.equal(Q.moveChoice(0, 5, "previous", 1), 4, "round-robin upwards");
    assert.equal(Q.moveChoice(1, 10, "pageBefore", 3), 4);
    assert.equal(Q.moveChoice(8, 10, "pageBefore", 3), 9, "page-wise without wrap-around");
    assert.equal(Q.moveChoice(1, 10, "pageBack", 3), 0);
    assert.equal(Q.moveChoice(5, 10, "first", 3), 0);
    assert.equal(Q.moveChoice(5, 10, "last", 3), 9);
    assert.equal(Q.moveChoice(1, 10, "nextGroup", 1, g), 3);
    assert.equal(Q.moveChoice(8, 10, "nextGroup", 1, g), 0, "after the last group the first");
    assert.equal(Q.moveChoice(5, 10, "previousGroup", 1, g), 3, "within a group: to its start");
    assert.equal(Q.moveChoice(3, 10, "previousGroup", 1, g), 0);
    assert.equal(Q.moveChoice(0, 10, "previousGroup", 1, g), 7);
    assert.equal(Q.moveChoice(3, 0, "next", 1), 0, "without rows");
  },
  history(Q) {
    assert.equal(Q.HISTORY_FILES_MAX, 200);
    assert.equal(Q.HISTORY_COMMANDS_MAX, 50);
    assert.deepEqual(Q.rememberInHistory(["a", "b", "c"], "b", 3), ["b", "a", "c"], "first, without duplicates");
    assert.deepEqual(Q.rememberInHistory(["a", "b", "c"], "d", 3), ["d", "a", "b"], "capped");
    assert.deepEqual(Q.removeFromHistory(["a", "b"], "a"), ["b"]);
    assert.deepEqual(Q.readHistory(["a", 1, "a", "b", ""], 5), ["a", "b"], "only strings, no duplicates");
    assert.deepEqual(Q.readHistory(["a", "b", "c"], 2), ["a", "b"]);
    assert.deepEqual(Q.readHistory("x", 5), []);
  },
  input(Q) {
    const e = (x, selected = null) => Q.fileInput(x, selected);
    const D = (filter, row = null, column = null, symbol = null) => ({ filter, row, column, symbol });
    assert.deepEqual(e("app.ts"), D("app.ts"));
    assert.deepEqual(e("app.ts:12"), D("app.ts", 12));
    assert.deepEqual(e("app.ts:12:4"), D("app.ts", 12, 4));
    assert.deepEqual(e("app.ts:12,4"), D("app.ts", 12, 4));
    assert.deepEqual(e("app.ts#12"), D("app.ts", 12));
    assert.deepEqual(e("app.ts(12)"), D("app.ts", 12));
    // A suffix without number: row 1 (VS Code `extractRangeFromFilter`: `t[1] === ""`), the filter stays the name.
    assert.deepEqual([e("app.ts:"), e("app.ts("), e("app.ts#")], [D("app.ts", 1), D("app.ts", 1), D("app.ts", 1)], "\"app.ts:\" goes to row 1");
    // Symbols only with a chosen file, the LAST piece behind "@" is their filter.
    assert.deepEqual(e("app.ts@kiosk", "src/app.ts"), D("app.ts", null, null, "kiosk"));
    assert.deepEqual(e("@", "src/app.ts"), D("", null, null, ""));
    assert.deepEqual(e("a@b@kiosk", "src/app.ts"), D("a@b", null, null, "kiosk"), "the last piece");
    assert.deepEqual(e("app.ts@k:3", "src/app.ts"), D("app.ts", null, null, "k:3"), "in symbol mode no row applies");
    assert.deepEqual(e("app.ts@kiosk"), D("app.ts@kiosk"), "without a chosen file the @ is part of the filter");
    // An "@" in the path of the chosen file: only from the second "@" (VS Code: `label`/`description` with "@" => at least three pieces).
    assert.deepEqual(e("icon@2x", "img/icon@2x.png"), D("icon@2x"), "\"icon@2x\" keeps searching files");
    assert.deepEqual(e("src/@core/app", "src/@core/app.ts"), D("src/@core/app"), "\"src/@core/app\" keeps searching files");
    assert.deepEqual(e("icon@2x@laden", "img/icon@2x.png"), D("icon@2x", null, null, "laden"), "the second \"@\" means symbols");
    // Without symbol mode: "@" at the front forbids a row, further back only if the piece behind it does not end in a row.
    assert.deepEqual(e("@app:12"), D("@app:12"), "\"@\" at the front: no row");
    assert.deepEqual(e("icon@2x.png:12"), D("icon@2x.png", 12), "\"@\" in the name and a row");
    // Links (VS Code `_getLinkPick`).
    assert.deepEqual(Q.linkTarget("https://example.com/a?b=1"), { valid: true, url: "https://example.com/a?b=1" });
    assert.deepEqual(Q.linkTarget("vscode://file/x"), { valid: true, url: "vscode://file/x" });
    assert.equal(Q.linkTarget("src/app.ts"), null, "no link");
    assert.equal(Q.linkTarget("app.ts:12"), null, "a colon without \"//\" is no link");
    for (const x of ["https:// example.com", "https://a\\b", "javascript://x", "data://x", "command://x", "https:///path"]) assert.deepEqual(Q.linkTarget(x), { valid: false }, x);
  },
  files(Q) {
    const short = (rows) => rows.map((z) => `${z.group ? `[${z.group}] ` : ""}${z.path}${z.history ? " *" : ""}`);
    assert.deepEqual(short(Q.fileRows("", ["b/x.ts", "a.ts"], null)), ["[recently opened] b/x.ts *", "a.ts *"]);
    assert.deepEqual(short(Q.fileRows("x", ["b/x.ts", "a.ts"], ["c/xy.ts", "b/x.ts"])), ["[recently opened] b/x.ts *", "[file results] c/xy.ts"],
      "the matching history first, no result twice, non-matching drops");
    assert.deepEqual(short(Q.fileRows("b", [], ["z/b.ts", "a/b.ts"])), ["[file results] z/b.ts", "a/b.ts"], "the order of the server stays");
    assert.deepEqual(Q.fileRows("x", ["b/x.ts"], null)[0].hits.label, [{ start: 0, end: 1 }], "the highlighting in the name");
    assert.deepEqual(Q.fileRows("zz", ["a.ts"], []), []);
    // The history like VS Code `getEditorHistoryPicks`: contiguous, without path separator only on the name -- the file results fuzzy.
    assert.deepEqual(short(Q.fileRows("bfp", ["src/bufferpool.ts"], ["src/bufferpool.ts"])), ["[file results] src/bufferpool.ts"],
      "scattered characters do not hit the history (the file results do)");
    assert.deepEqual(short(Q.fileRows("kiosk", ["src/kiosk/prefix.ts"], [])), [], "a folder name does not hit the history");
    assert.deepEqual(short(Q.fileRows("kiosk/pre", ["src/kiosk/prefix.ts"], [])), ["[recently opened] src/kiosk/prefix.ts *"], "with \"/\" the path counts");
  },
  commands(Q) {
    const B = [
      { id: "workbench.action.files.save", label: "Datei: Speichern" },
      { id: "workbench.action.files.saveAll", label: "Datei: Alle speichern" },
      { id: "editor.action.toggleMinimap", label: "Ansicht: Minimap ein-/ausblenden" },
      { id: "x.zero", label: "Datei: Speichern" },
    ];
    const short = (rows) => rows.map((z) => `${z.group ? `[${z.group}] ` : ""}${z.e.id}${z.duplicate ? " (2)" : ""}`);
    assert.deepEqual(short(Q.commandRows(B, "", ["workbench.action.files.saveAll"])), [
      "[recently used] workbench.action.files.saveAll", "[other commands] editor.action.toggleMinimap", "workbench.action.files.save (2)", "x.zero (2)",
    ]);
    assert.deepEqual(short(Q.commandRows(B.slice(0, 3), "", [])), ["editor.action.toggleMinimap", "workbench.action.files.saveAll", "workbench.action.files.save"],
      "without history no separators, by name");
    assert.deepEqual(short(Q.commandRows(B.slice(0, 3), "speich", ["workbench.action.files.save", "workbench.action.files.saveAll"])),
      ["[recently used] workbench.action.files.save", "workbench.action.files.saveAll"], "the most recent first");
    assert.deepEqual(short(Q.commandRows(B, "editor.action.toggleMinimap", [])), ["editor.action.toggleMinimap"], "the id hits");
    assert.deepEqual(Q.commandRows(B, "minimap", [])[0].hits, [{ start: 9, end: 16 }]);
  },
  row(Q) {
    const d = doc(["ones", "\tzero", "tree"]);
    const z = (rest) => { const r = Q.rowsTarget(d, rest); return [r.row ?? null, r.column ?? null, r.offsetMode, r.notice.text, JSON.stringify(r.notice.values ?? {})]; };
    assert.deepEqual(Q.rowsTarget(null, "3").notice.text, Q.ROW_WITHOUT_EDITOR);
    assert.deepEqual(z(""), [null, null, false, Q.ROW_EMPTY, '{"n":3}']);
    assert.deepEqual(z("2"), [2, 1, false, Q.ROW_ENTER, '{"z":2}']);
    assert.deepEqual(z("2:"), [2, 1, false, Q.LINE_COLUMN_MISSING, '{"z":2,"s":9}'], "the row with a tab is 9 visible columns wide");
    assert.deepEqual(z("2:5"), [2, 2, false, Q.LINE_COLUMN, '{"z":2,"s":5}'], "visible column 5 is the \"z\" behind the tab");
    assert.deepEqual(z("2,3"), [2, 1, false, Q.LINE_COLUMN, '{"z":2,"s":3}'], "in the middle of the tab: the column before (VS Code columnFromVisibleColumn)");
    assert.deepEqual(z("99"), [3, 1, false, Q.ROW_ENTER, '{"z":3}'], "clamped");
    assert.deepEqual(z("-1"), [3, 1, false, Q.ROW_ENTER, '{"z":3}'], "negative from the end");
    assert.deepEqual(z("1:-1"), [1, 4, false, Q.LINE_COLUMN, '{"z":1,"s":4}'], "negative column from the end");
    assert.deepEqual(z(":5"), [1, 5, true, Q.LINE_COLUMN, '{"z":1,"s":5}'], "`::5` -- the fifth character");
    assert.deepEqual(z(":"), [null, null, true, Q.CHARACTER_EMPTY, '{"n":15}']);
    assert.equal(Q.viewColumn("\t\tx", 3, 4), 8);
    assert.equal(Q.columnFromView("\t\tx", 8, 4), 3);
  },
  symbols(Q) {
    const flat = Q.flatSymbols(LAYOUT);
    assert.deepEqual(flat.map((s) => `${s.name}<${s.container}>`), ["Laden<>", "kiosk<Laden>", "counts<kiosk>", "bon<Laden>", "helps<>"], "by location, container = parent");
    const all = Q.symbolRows(flat, "");
    assert.deepEqual(all.map((z) => z.s.name), ["Laden", "kiosk", "counts", "bon", "helps"]);
    assert.deepEqual(all[0].group, { text: Q.SYMBOLS_GROUP, values: { n: 5 } });
    assert.equal(all.filter((z) => z.group).length, 1, "one separator above all");
    assert.equal(Q.symbolRows(flat, "kio")[0].s.name, "kiosk");
    assert.deepEqual(Q.symbolRows(flat, "counts kiosk").map((z) => z.s.name), ["counts"], "the second word on the container");
    assert.deepEqual(Q.symbolRows(flat, "counts laden"), [], "the container does not fit");
    const kind = Q.symbolRows(flat, ":");
    assert.deepEqual(kind.map((z) => `${z.group ? `[${z.group.text}=${z.group.values.n}] ` : ""}${z.s.name}`),
      ["[classes ({n})=1] Laden", "[functions ({n})=1] helps", "[methods ({n})=3] kiosk", "counts", "bon"], "`@:` by category, sorted by name");
    assert.equal(Q.symbolAtLocation(all, { line: 7, character: 0 }), 2, "the innermost symbol at the cursor (counts)");
    assert.equal(Q.symbolAtLocation(all, { line: 41, character: 0 }), -1);
  },
  work(Q) {
    const L = [{ name: "laden2", kind: 12, container: "Kiosk", file: "src/k.ts" }, { name: "Laden", kind: 5, container: "", file: "src/laden.ts" }];
    assert.deepEqual(Q.workRows(L, "").map((z) => `${z.s.name}|${z.description}`), ["Laden|src/laden.ts", "laden2|Kiosk • src/k.ts"], "by name, container • path");
    assert.deepEqual(Q.workRows(L, "laden kiosk").map((z) => z.s.name), ["laden2"], "the second word on the description");
    assert.deepEqual(Q.workRows(L, "zzz"), []);
    assert.deepEqual(["laden kiosk", "  laden  ", "Laden", ""].map((x) => Q.symbolRequest(x)), ["laden", "laden", "Laden", ""], "the language server gets only the first word");
  },
  help(Q) {
    assert.deepEqual(Q.helpRows().map((h) => h.label), ["…", ":", "@", "@:", "#", ">"], "by prefix (localeCompare like VS Code), \"…\" for none");
    assert.equal(Q.helpSwitch(">"), ">");
    assert.equal(Q.helpSwitch(">abc"), ">", "the new input is the prefix");
    assert.equal(Q.helpSwitch("@:x"), "@:", "the longest provider");
    assert.equal(Q.helpSwitch("x"), null);
    assert.equal(Q.helpSwitch(""), null, "none does not switch");
    // A palette command in the open palette (VS Code `doShowOrPick`): the filter goes along, the same mode keeps the input.
    assert.deepEqual(Q.switchInput("kiosk", "", "#"), { input: "#kiosk", markFrom: 1 }, "\"kiosk\" -> Cmd+T");
    assert.deepEqual(Q.switchInput(">speich", ">", ":"), { input: ":speich", markFrom: 1 });
    assert.deepEqual(Q.switchInput("#", "#", ">"), { input: ">", markFrom: 1 }, "without filter only the prefix");
    assert.deepEqual(Q.switchInput("@:foo", "@", "@"), { input: "@:foo", markFrom: 1 }, "the same mode keeps the input");
    assert.deepEqual(Q.switchInput(":12", ":", ""), { input: "12", markFrom: 0 });
  },
  chunks(Q) {
    assert.deepEqual(Q.chunks("prefix.ts", [{ start: 0, end: 3 }]), [{ text: "pre", on: true }, { text: "fix.ts", on: false }]);
    assert.deepEqual(Q.chunks("abcdef", [{ start: 3, end: 5 }, { start: 1, end: 4 }]), [{ text: "a", on: false }, { text: "bcd", on: true }, { text: "e", on: true }, { text: "f", on: false }], "overlapping, unsorted");
    assert.deepEqual(Q.chunks("ab", []), [{ text: "ab", on: false }]);
    assert.deepEqual(Q.chunks("ab", [{ start: 1, end: 9 }]), [{ text: "a", on: false }, { text: "b", on: true }]);
  },
};
const FUZZY = ["matrix", "queue", "filter"];
const WINDOW = ["situation", "keys", "history", "input", "files", "commands", "row", "symbols", "work", "help", "chunks"];

test("(1) scoring like VS Code Quick Open: matrix, request, name before path, order, prefilter, word filter", () => {
  for (const k of FUZZY) {
    try { CHECKS[k](real.fuzzy); } catch (e) { throw new Error(`${k}: ${e.message}`); }
  }
});

test("(2) binding: same order of Cmd+P on the server (fast-open.js) and on the web (fuzzy-scorer.ts)", () => {
  const deviation = (srv) => {
    for (const q of INPUTS) {
      for (const n of [512, 3]) {
        const s = srv.fastOpen(PATHS, q, n), w = webQueue(real.fuzzy, PATHS, q, n);
        try { assert.deepEqual(s, w); } catch { return `"${q}" (cap ${n}): server ${JSON.stringify(s.results)} differs from web ${JSON.stringify(w.results)}`; }
      }
    }
    return null;
  };
  assert.equal(deviation(server), null);
  // The binding measures something: at least one input has several hits in a non-trivial order, and the cap truncates.
  assert.deepEqual(server.fastOpen(PATHS, "prefix", 512).results.slice(0, 2), ["src/kiosk/prefix.ts", "src/very/deep/folder/structure/prefix.ts"], "same name before longer name");
  assert.equal(server.fastOpen(PATHS, "ts", 3).truncated, true);
  // The order of the words does not count (VS Code: the first word searches, each word scores on its own).
  for (const [x, y] of [["prefix kiosk", "kiosk prefix"], ["notiz docs", "docs notiz"], ["index web", "web index"]]) {
    assert.deepEqual(server.fastOpen(PATHS, x, 512).results, server.fastOpen(PATHS, y, 512).results, `"${x}" and "${y}" find the same`);
  }
  assert.deepEqual(server.fastOpen(PATHS, "prefix kiosk", 512).results, ["src/kiosk/prefix.ts", "src/kiosk/PrefixList.ts"], "\"prefix kiosk\" finds the prices of the till");
  assert.deepEqual(server.fastOpen(PATHS, "prefix zzz", 512).results, [], "a word without a hit empties the list (score 0 drops)");
  // The prefilter of the pass: the first word, normalized and lowercase.
  assert.deepEqual(["Prefix Kiosk", "src\\Kiosk", " a*b ", "\"x\"", ""].map((q) => server.fastPattern(q)), ["prefix", "src/kiosk", "ab", "x", ""]);
  assert.deepEqual([server.fastMatches("src/kiosk/prefix.ts", "skp"), server.fastMatches("src/kiosk/prefix.ts", "pks"), server.fastMatches("ab", "")], [true, false, false]);
  // Counter-tests on the server: every sabotage stands exactly once and breaks the binding.
  for (const k of serverCopies) {
    assert.equal(k.places, 1, `server sabotage "${k.name}" stands ${k.places}x in the source`);
    assert.notEqual(deviation(k.mod), null, `server sabotage "${k.name}" is not noticed by the binding`);
  }
});

test("(3) window: situation, clip, keys, history, Cmd+P, commands, row, symbols, work area, help, highlighting", () => {
  for (const k of WINDOW) {
    try { CHECKS[k](real.qi); } catch (e) { throw new Error(`${k}: ${e.message}`); }
  }
});

test("counter-tests (1)/(3): every sabotage stands exactly once in the source and is caught by its check", () => {
  const stale = copies.filter((k) => k.places !== 1).map((k) => `${k.name} (${k.places}x)`);
  assert.deepEqual(stale, [], "sabotages whose place does not stand exactly once in the source");
  const notCaught = [];
  for (const s of sabotaged) {
    let caught = false;
    try { CHECKS[s.catches](s.mod); } catch { caught = true; }
    if (!caught) notCaught.push(`${s.name} (${s.catches})`);
  }
  assert.deepEqual(notCaught, [], "sabotages that no check catches");
  console.log(`  [quick-input] ${sabotaged.length} sabotages, each caught`);
});

// ── (4) Source ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const withoutComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const Q4 = {
  window: read("src", "components", "code", "CommandPalette.tsx"),
  host: read("src", "components", "code", "palette-host.ts"),
  modes: read("src", "components", "code", "palette-modes.ts"),
  code: read("src", "components", "CodePane.tsx"),
  i18n: read("src", "lib", "i18n-de.ts"),
  css: read("src", "app", "globals.css"),
};
function checkSource(q) {
  const f = withoutComments(q.window);
  assert.ok(!/fixed inset-0|cb-overlay/.test(f), "the window carries a veil or click catcher (VS Code: none)");
  assert.ok(f.includes("document.body.appendChild(host)") && f.includes("createRoot(host)"), "the palette does not hang on a root of its own on the body");
  assert.ok(f.includes('document.addEventListener("mousedown", onOutside, true);'), "a click outside does not close");
  assert.ok(f.includes("const compute = () => setSituation(quickInputSituation({ width: window.innerWidth, height: window.innerHeight }, anchorOf(job)));"), "the position does not come from quickInputSituation");
  assert.ok(f.includes("const b = movementToKey(e, mac);") && f.includes("setChoice(moveChoice(w, n, b, page(), groups));"), "the keys of the list do not come from lib/quick-input.ts");
  assert.ok(f.includes('className="cb-quick-input"') && f.includes('className="cb-qi-row"'), "the form of VS Code (globals.css) is missing at the window");
  assert.ok(f.includes("clipKeys(shortcut)") && f.includes("chunks(text, hits)"), "key caps or highlighting by hand");
  assert.ok(f.includes('{...(z.group && i > 0 ? { "data-group-edge": "" } : {})}'), "the separator draws no edge (or also above the first row)");
  assert.ok(f.includes('t("Search files by name (append : to go to line or @ to go to symbol), or paste a link")'), "the placeholder of Cmd+P is missing");
  // A switch by key takes the filter along; progress only after 800 ms; only what was opened counts as accepted (a waiting Enter does
  // not); every switch away from `:`/`@` restores the editor.
  assert.ok(f.includes("const fresh = switchInput(inputText, PREFIX[paletteMode(inputText).mode], pb.prefix);") && f.includes("else setInput(fresh.input);"), "a switch by key throws the filter away");
  assert.ok(f.includes("const h = setTimeout(() => setProgress(true), QI_PROGRESS_MS);") && f.includes('{...(progress ? { "data-running": "" } : {})}'), "the progress does not come only after 800 ms");
  assert.ok(f.includes("const enter = () => { if (s.enter) s.enter(); else if (!s.stale) void run(active); };"), "an Enter that waits for the answer already counts as accepted (Escape does not restore afterwards)");
  assert.ok(f.includes('if (before !== mode && (before === "row" || before === "symbols")) reinstate(viewStatus.current);'), "a switch away from `:`/`@` leaves the editor on the preview target");
  assert.ok(!f.includes("setTimeout(() => inputRef.current?.focus("), "right arrow takes the focus back after opening instead of not giving it away at all");
  // In the modes: `#` asks only the first word, Open to the Side in `@` in the coordinates of the host, right arrow with `preserveFocus`.
  const m = withoutComments(q.modes);
  assert.ok(m.includes("const q = symbolRequest(full);"), "`#` sends the whole rest to the language server");
  assert.ok(m.includes("const pathHere = here && !here.extern ? here.path : null;") && m.includes("source.openFileBeside?.(pathHere, "), "Open to the Side in `@` opens the canonical path instead of the path in the host");
  assert.ok(m.includes("inBackground: () => source?.openFile?.(p, e.row ?? undefined, e.column ?? undefined, { focus: false }),"), "right arrow opens with the focus");
  assert.ok(withoutComments(q.code).includes("true, o?.focus !== false),"), "CodePane does not pass `focus: false` on to the jump");
  // Seen in the browser: without a position on the FIRST draw no input field stood there at the focus effect -- the palette was open,
  // the focus stayed in the tree; a switch from the help in `onInput` lost against `onChange` (React calls onChange afterwards).
  assert.ok(f.includes("const [situation, setSituation] = useState(() => quickInputSituation("), "the position is not fixed at the first draw (the focus goes nowhere)");
  assert.ok(f.includes("const h = helpSwitch(rest);\n    if (h !== null) setInput(h);"), "`?` + prefix does not switch");
  assert.ok(!/\bonInput=/.test(f), "an onInput next to onChange loses against onChange");
  const w = withoutComments(q.host);
  assert.ok(w.includes('const word = id === "workbench.action.showAllSymbols" ? wordAtCursor(inFocus(source.view)) : "";'), "Cmd+T does not enter the word at the cursor (or takes it from an editor without focus)");
  assert.ok(w.includes("return view && (view.root as Document | ShadowRoot).activeElement === view.contentDOM ? view : null;"), "`imFocus` does not ask for the focus");
  assert.equal((w.match(/openWithPrefix\(b\.id, b\.prefix, /g) ?? []).length, 2, "not both ways (editor, host) open via openWithPrefix");
  assert.ok(w.includes("anchor: root"), "the palette does not stand above the area of the host");
  assert.ok(withoutComments(q.code).includes("useFileHistory(target, activePath);"), "CodePane does not remember the opened files for Cmd+P");
  // Every wording of lib/quick-input.ts is in the German dictionary.
  const keys = new Set([...q.i18n.matchAll(/^\s*"((?:[^"\\]|\\.)*)"\s*:/gm)].map((m) => JSON.parse(`"${m[1]}"`)));
  const qi = SOURCES.qi, texts = [];
  for (const m of qi.matchAll(/(?:GROUP_\w+|ROW_\w+|LINE_\w+|CHARACTER_\w+|CATEGORY_ELSE|SYMBOLS_GROUP) = "([^"]+)"/g)) texts.push(m[1]);
  for (const m of qi.matchAll(/\d+: "([^"]+\(\{n\}\))"/g)) texts.push(m[1]);
  for (const m of qi.matchAll(/text: "([^"]+)", command/g)) texts.push(m[1]);
  assert.ok(texts.length >= 40, `too few wordings found (${texts.length}) -- the search is stale`);
  assert.deepEqual(texts.filter((x) => !keys.has(x)), [], "wordings without a German entry in lib/i18n-de.ts");
  // The form: row 22 px, separator as edge, the colors per theme.
  const css = q.css;
  assert.match(css, /\.cb-qi-row \{[^}]*height: 22px;/, "the row is not 22 px high");
  assert.match(css, /\.cb-qi-row\[data-group-edge\] \{[^}]*border-top:/, "the separator draws no edge");
  assert.equal((css.match(/--qi-focus-background:/g) ?? []).length >= 2, true, "the color of the chosen row does not stand for both themes");
  // The name of a group in `descriptionForeground` (Dark/Light Modern), the content indented 9 px, the outer caps without margin.
  assert.deepEqual([...css.matchAll(/--qi-group-font: (#[0-9a-f]+);/g)].map((x) => x[1]), ["#9d9d9d", "#3b3b3b"], "the color of the group names is not descriptionForeground");
  assert.match(css, /\.cb-qi-row \{[^}]*padding: 0 4px 0 9px;/, "the content of a row does not stand at 9 px");
  assert.match(css, /\.cb-qi-chord:first-child > \.cb-qi-key:first-child \{ margin-left: 0; \}/, "the first cap carries a margin");
  assert.match(css, /\.cb-qi-chord:last-child > \.cb-qi-key:last-child \{ margin-right: 0; \}/, "the last cap carries a margin");
}
const SOURCE_SABOTAGES = {
  "click catcher": { file: "window", old: 'className="cb-quick-input"', fresh: 'className="cb-quick-input fixed inset-0"' },
  "click outside": { file: "window", old: 'document.addEventListener("mousedown", onOutside, true);', fresh: "" },
  "position by hand": { file: "window", old: "const compute = () => setSituation(quickInputSituation({ width: window.innerWidth, height: window.innerHeight }, anchorOf(job)));", fresh: "const compute = () => setSituation({ top: 0, left: 0, width: 600, listMax: 440 });" },
  // The error the guard catches: the position only in the effect after the first draw (the input field was missing at the focus effect).
  "position only after drawing": { file: "window", old: "const [situation, setSituation] = useState(() => quickInputSituation({ width: window.innerWidth, height: window.innerHeight }, anchorOf(job)));", fresh: "const [situation, setSituation] = useState<ReturnType<typeof quickInputSituation> | null>(null);" },
  "switch by key without filter": { file: "window", old: "else setInput(fresh.input);", fresh: "else setInput(pb.prefix);" },
  "progress at once": { file: "window", old: '{...(progress ? { "data-running": "" } : {})}', fresh: '{...(busy ? { "data-running": "" } : {})}' },
  "Enter accepts in advance": { file: "window", old: "const enter = () => { if (s.enter) s.enter(); else if (!s.stale) void run(active); };", fresh: "const enter = () => { if (s.enter) { accepted.current = true; s.enter(); } else if (!s.stale) void run(active); };" },
  "switch does not restore": { file: "window", old: 'if (before !== mode && (before === "row" || before === "symbols")) reinstate(viewStatus.current);', fresh: "" },
  "right arrow takes the focus back": { file: "window", old: "      if (z.inBackground) z.inBackground();\n", fresh: "      if (z.inBackground) { z.inBackground(); setTimeout(() => inputRef.current?.focus({ preventScroll: true }), 0); }\n" },
  "# asks everything": { file: "modes", old: "const q = symbolRequest(full);", fresh: "const q = full;" },
  "to the side canonical": { file: "modes", old: "source.openFileBeside?.(pathHere, ", fresh: "source.openFileBeside?.(file.buffer.path, " },
  "right arrow with focus": { file: "modes", old: "e.column ?? undefined, { focus: false }),", fresh: "e.column ?? undefined)," },
  "focus not passed on": { file: "code", old: "true, o?.focus !== false),", fresh: "true)," },
  "Cmd+T from an editor without focus": { file: "host", old: "wordAtCursor(inFocus(source.view))", fresh: "wordAtCursor(source.view)" },
  "group name blue": { file: "css", old: "  --qi-group-font: #9d9d9d;", fresh: "  --qi-group-font: #3794ff;" },
  "content at 4 px": { file: "css", old: "  padding: 0 4px 0 9px;", fresh: "  padding: 0 4px;" },
  "outer cap with margin": { file: "css", old: ".cb-qi-chord:first-child > .cb-qi-key:first-child { margin-left: 0; }", fresh: "" },
  "help does not switch": { file: "window", old: "    if (h !== null) setInput(h);\n", fresh: "" },
  "edge also at the top": { file: "window", old: '{...(z.group && i > 0 ? { "data-group-edge": "" } : {})}', fresh: '{...(z.group ? { "data-group-edge": "" } : {})}' },
  "Cmd+T without word": { file: "host", old: 'const word = id === "workbench.action.showAllSymbols" ? wordAtCursor(inFocus(source.view)) : "";', fresh: 'const word = "";' },
  "history not remembered": { file: "code", old: "useFileHistory(target, activePath);", fresh: "" },
  "wording missing": { file: "i18n", old: '  "file results": "Dateiergebnisse",\n', fresh: "" },
  "row not 22 px": { file: "css", old: ".cb-qi-row {\n  display: flex;\n  align-items: center;\n  box-sizing: border-box;\n  height: 22px;", fresh: ".cb-qi-row {\n  display: flex;\n  align-items: center;\n  box-sizing: border-box;\n  height: 24px;" },
};

test("(4) source: no veil, own root, position and keys from the computation, history, Cmd+T with word, wordings, form", () => {
  checkSource(Q4);
});

test("counter-tests (4): every source sabotage stands exactly once and is caught", () => {
  for (const [name, s] of Object.entries(SOURCE_SABOTAGES)) {
    const places = Q4[s.file].split(s.old).length - 1;
    assert.equal(places, 1, `sabotage "${name}" stands ${places}x in ${s.file}`);
    assert.throws(() => checkSource({ ...Q4, [s.file]: Q4[s.file].replace(s.old, s.fresh) }), undefined, `sabotage "${name}" is not caught`);
  }
});
