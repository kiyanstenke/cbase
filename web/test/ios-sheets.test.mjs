// iPhone: EVERY bottom sheet in ONE form — guard for `.cbSheet(_:)` in `mobile/CbaseMobile/Kit/CbGlass.swift`.
//
// Every `.sheet` goes through the building block, which decides background (glass, or the opaque background below iOS 26) and
// height in ONE place. Without a guard the old variety would silently return with the next sheet: a `.sheet` without the block
// compiles, looks "almost right" in the simulator and is again the opaque sheet among glass ones.
//
// Five checks, text reading only (also runs on Linux — NOT under `onlyMacOS`):
//   1. The closure of EVERY `.sheet(…) { … }` carries `.cbSheet(` — at the place that presents (the same type is partly
//      embedded on a page). Exceptions only from `SHEET_EXCEPTIONS` (file + needle in the closure) and `FILE_EXCEPTIONS`
//      (whole file), each with a reason. An exception that hits nothing any more is red — otherwise it would stay as a free pass.
//   2. Every `.fullScreenCover(` is a named full-screen exception (`FULLSCREEN`, needle in the closure) — a full screen is not a
//      sheet; a new one must justify why it is not. Here too: a needle without a hit is red.
//   3. `.presentationDetents`, `.presentationBackground…`, `.presentationDragIndicator`, `.presentationCornerRadius` appear only in
//      `Kit/CbGlass.swift` (and the files from `FILE_EXCEPTIONS`) — height and background are decided by the block, not the sheet.
//   4. `.cbSheet(` appears only in the closure of a `.sheet` (and in its definition) — in the body of the presented type it would be
//      in the wrong place (doubled, or ineffective on an embedded view).
//   5. Every `.popover(` carries `.presentationCompactAdaptation(.popover)` in its closure — without it the iPhone turns it into a
//      sheet from below, which would slip past check 1.
//
// What is read is the CODE: comments and strings are dropped first (the explanatory texts name `.sheet` and `.cbSheet` on purpose),
// rows and columns stay so the message names the place. The reader is a copy of `onlyCode` from `tools/check/ios-font.test.mjs`
// (nested block comments, `"""`, `#"…"#`, interpolations), rebuilt length-preserving — deliberately a COPY: a `.test.mjs` never
// imports another (its tests would run twice). The price: a fix to the reader there must be carried over here.
//
// BUILT-IN SABOTAGE: per check a throwaway source that must be red, plus a clean one that must be green.
//
// Run:  node --test --test-reporter=tap web/test/ios-sheets.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const ROOT = path.join(repo, "mobile/CbaseMobile");

/** Whole files without checks 1 and 3. May only shrink. (Empty: the Git sheet carries the block.) */
export const FILE_EXCEPTIONS = {};

/** `.sheet` places without `cbSheet`: file + needle in the closure. */
export const SHEET_EXCEPTIONS = [
  {
    file: "Code/CodePane.swift",
    needle: "ShareSheet(",
    reason: "the system share sheet (UIActivityViewController): iOS decides shape, glass and height itself",
  },
];

/** `.fullScreenCover` places: not a sheet. Needle in the closure, in any file. */
export const FULLSCREEN = [
  { needle: "ImageViewerScreen(", reason: "image viewer in full screen on black (zoom, swipe) — not a sheet" },
  { needle: "VideoViewerScreen(", reason: "video player in full screen on black — not a sheet" },
];

const PRESENTATION = /\.presentation(Detents|Background\w*|DragIndicator|CornerRadius)\b/g;

// ── Reading Swift (length-preserving) ─────────────────────────────────────────────────────────────────────

/** Swift source with comments and strings as spaces — line breaks and lengths stay. */
export function onlyCode(src) {
  const out = src.split("");
  const empty = (a, b) => {
    for (let k = a; k < b && k < out.length; k++) if (out[k] !== "\n") out[k] = " ";
  };
  let i = 0;
  const n = src.length;
  while (i < n) {
    if (src.startsWith("//", i)) {
      const j = src.indexOf("\n", i);
      const until = j < 0 ? n : j;
      empty(i, until);
      i = until;
      continue;
    }
    if (src.startsWith("/*", i)) {
      const a = i;
      let depth = 0;
      while (i < n) {
        if (src.startsWith("/*", i)) { depth++; i += 2; continue; }
        if (src.startsWith("*/", i)) { depth--; i += 2; if (depth === 0) break; continue; }
        i++;
      }
      empty(a, i);
      continue;
    }
    const raw = /^#+"/.exec(src.slice(i, i + 8));
    if (src[i] === '"' || raw) {
      const a = i;
      i = stringEnd(src, i);
      // The quotes stay (an empty string), the content becomes whitespace.
      empty(a + 1, i - 1);
      continue;
    }
    i++;
  }
  return out.join("");
}

function stringEnd(src, i) {
  const n = src.length;
  let hashes = 0;
  while (src[i] === "#") { hashes++; i++; }
  const multiline = src.startsWith('"""', i);
  const quote = multiline ? '"""' : '"';
  i += quote.length;
  const end = quote + "#".repeat(hashes);
  const esc = "\\" + "#".repeat(hashes);
  while (i < n) {
    if (src.startsWith(esc + "(", i)) {
      i += esc.length + 1;
      let depth = 1;
      while (i < n && depth > 0) {
        if (src[i] === '"' || /^#+"/.test(src.slice(i, i + 8))) { i = stringEnd(src, i); continue; }
        if (src[i] === "(") depth++;
        else if (src[i] === ")") depth--;
        i++;
      }
      continue;
    }
    if (hashes === 0 && src[i] === "\\") { i += 2; continue; }
    if (src.startsWith(end, i)) return i + end.length;
    if (!multiline && src[i] === "\n") return i;
    i++;
  }
  return n;
}

/** Index of the matching closing bracket (in the CODE — strings are already whitespace). */
function matching(code, i, on, to) {
  let t = 0;
  for (let k = i; k < code.length; k++) {
    if (code[k] === on) t++;
    else if (code[k] === to) {
      t--;
      if (t === 0) return k;
    }
  }
  return -1;
}

const rowOf = (code, i) => code.slice(0, i).split("\n").length;

/**
 * Every presentation `.sheet(`/`.fullScreenCover(`/`.popover(` with its closure: `{ kind, row, from, until, content }`. The
 * closure is the trailing `{ … }` behind the argument list; if it is missing (content as argument), `content` is the
 * argument list itself.
 */
export function presentations(code) {
  const findings = [];
  const re = /\.(sheet|fullScreenCover|popover)\(/g;
  let m;
  while ((m = re.exec(code))) {
    const pa = m.index + m[0].length - 1;
    const pz = matching(code, pa, "(", ")");
    if (pz < 0) continue;
    let k = pz + 1;
    while (k < code.length && /\s/.test(code[k])) k++;
    let from = pa;
    let until = pz;
    if (code[k] === "{") {
      from = k;
      until = matching(code, k, "{", "}");
      if (until < 0) continue;
    }
    findings.push({ kind: m[1], row: rowOf(code, m.index), from, until, content: code.slice(from, until + 1) });
  }
  return findings;
}

/**
 * The five checks over `{ rel: source }`. Returns `{ error: [..], hits: Set }` — `hits` are the keys of the exceptions that
 * hit something (without a hit: red, see header).
 */
export function check(files, { file = FILE_EXCEPTIONS, sheet = SHEET_EXCEPTIONS, fullscreen = FULLSCREEN } = {}) {
  const error = [];
  const hits = new Set();
  for (const [rel, src] of Object.entries(files).sort()) {
    const code = onlyCode(src);
    const wholeExempt = Object.hasOwn(file, rel);
    if (wholeExempt) hits.add(`datei:${rel}`);
    const pres = presentations(code);
    const inSheet = (i) => pres.some((p) => p.kind === "sheet" && i > p.from && i < p.until);
    for (const p of pres) {
      if (p.kind === "sheet") {
        if (wholeExempt) continue;
        if (p.content.includes(".cbSheet(")) continue;
        const a = sheet.find((x) => x.file === rel && p.content.includes(x.needle));
        if (a) { hits.add(`blatt:${a.file}:${a.needle}`); continue; }
        error.push(`(1) ${rel}:${p.row} — .sheet without .cbSheet(…)`);
      } else if (p.kind === "fullScreenCover") {
        const v = fullscreen.find((x) => p.content.includes(x.needle));
        if (v) { hits.add(`vollbild:${v.needle}`); continue; }
        error.push(`(2) ${rel}:${p.row} — .fullScreenCover without full-screen exception (a full screen is not a sheet; otherwise .sheet + .cbSheet)`);
      } else if (p.kind === "popover") {
        if (!p.content.includes(".presentationCompactAdaptation(.popover)")) {
          error.push(`(5) ${rel}:${p.row} — .popover without .presentationCompactAdaptation(.popover): on the iPhone a sheet without the block`);
        }
      }
    }
    if (rel !== "Kit/CbGlass.swift" && !wholeExempt) {
      for (const m of code.matchAll(PRESENTATION)) {
        error.push(`(3) ${rel}:${rowOf(code, m.index)} — ${m[0]} outside Kit/CbGlass.swift (height and background are decided by .cbSheet)`);
      }
      for (const m of code.matchAll(/\.cbSheet\(/g)) {
        if (!inSheet(m.index)) error.push(`(4) ${rel}:${rowOf(code, m.index)} — .cbSheet outside the closure of a .sheet`);
      }
    }
  }
  for (const rel of Object.keys(file)) {
    if (!hits.has(`datei:${rel}`)) error.push(`Exception without file: ${rel} — strike`);
  }
  for (const a of sheet) {
    if (!hits.has(`blatt:${a.file}:${a.needle}`)) error.push(`Sheet exception without hit: ${a.file} "${a.needle}" — strike`);
  }
  for (const v of fullscreen) {
    if (!hits.has(`vollbild:${v.needle}`)) error.push(`Full-screen exception without hit: "${v.needle}" — strike`);
  }
  return { error, hits };
}

function swiftFiles(dir, base = dir) {
  const out = {};
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) Object.assign(out, swiftFiles(p, base));
    else if (e.name.endsWith(".swift")) out[path.relative(base, p).split(path.sep).join("/")] = fs.readFileSync(p, "utf8");
  }
  return out;
}

// ── The real tree ───────────────────────────────────────────────────────────────────────────────

test("every bottom sheet goes through .cbSheet — height and background only in the block", () => {
  const files = swiftFiles(ROOT);
  assert.ok(Object.keys(files).length > 150, "hardly any Swift files under mobile/CbaseMobile/ — wrong root?");
  assert.ok(files["Kit/CbGlass.swift"]?.includes("func cbSheet("), "the block .cbSheet is missing in Kit/CbGlass.swift");
  const { error } = check(files);
  const sheets = Object.values(files).reduce((n, s) => n + presentations(onlyCode(s)).filter((p) => p.kind === "sheet").length, 0);
  // The measurement line: how many sheets the guard saw (a number in the title would age silently).
  console.log(`# ios-sheets: ${sheets} .sheet places, ${Object.keys(FILE_EXCEPTIONS).length} files and ${SHEET_EXCEPTIONS.length} places excepted, ${FULLSCREEN.length} full-screen kinds`);
  assert.ok(sheets > 60, `only ${sheets} .sheet places found — does the guard still read?`);
  assert.deepEqual(error, [], "Sheets outside the one form:\n" + error.join("\n"));
});

// ── Built-in sabotage ──────────────────────────────────────────────────────────────────────────

const BUILDING_BLOCK = `extension View { func cbSheet(_ h: CbSheetHeight) -> some View { self.presentationDetents([.large]) } }`;
const CLEAN = {
  "Kit/CbGlass.swift": BUILDING_BLOCK,
  "Chat/A.swift": `
struct A: View {
    @State var open = false
    var body: some View {
        Text("x")
            // .sheet(isPresented: $open) { B() } — nothing counts in a comment
            .sheet(isPresented: $open) {
                if true {
                    B(title: "{ .sheet( }")
                        .cbSheet(.half)
                }
            }
            .sheet(item: $share) { f in ShareSheet(items: [f]) }
            .fullScreenCover(item: $image) { b in ImageViewerScreen(image: b) { image = nil } }
            .popover(isPresented: $open) { C().presentationCompactAdaptation(.popover) }
    }
}`,
};
const CLEAN_EXCEPTIONS = {
  file: {},
  sheet: [{ file: "Chat/A.swift", needle: "ShareSheet(", reason: "System" }],
  fullscreen: [{ needle: "ImageViewerScreen(", reason: "Fullscreen" }],
};
const including = (rel, src) => ({ ...CLEAN, [rel]: src });

test("sabotage: the clean throwaway tree is green (otherwise a red case would prove nothing)", () => {
  assert.deepEqual(check(CLEAN, CLEAN_EXCEPTIONS).error, []);
});

test("sabotage (1): a .sheet without the block is red — even if .cbSheet appears only in a comment or a string", () => {
  for (const body of ["B()", "B() // .cbSheet(.half)", 'B(t: ".cbSheet(.half)")']) {
    const { error } = check(including("Chat/D.swift", `x.sheet(isPresented: $o) {\n    ${body}\n}`), CLEAN_EXCEPTIONS);
    assert.equal(error.length, 1, `not red: ${body}`);
    assert.match(error[0], /^\(1\) Chat\/D\.swift:1/);
  }
});

test("sabotage (1): an exception applies only in its file, and an exception without a hit is red", () => {
  const foreign = check(including("Chat/D.swift", "x.sheet(item: $f) { f in ShareSheet(items: [f]) }"), CLEAN_EXCEPTIONS).error;
  assert.deepEqual(foreign.map((f) => f.slice(0, 3)), ["(1)"]);
  const orphaned = check(CLEAN, { ...CLEAN_EXCEPTIONS, sheet: [...CLEAN_EXCEPTIONS.sheet, { file: "Chat/A.swift", needle: "Gone(", reason: "x" }] }).error;
  assert.equal(orphaned.length, 1);
  assert.match(orphaned[0], /without hit/);
  const withoutFile = check(CLEAN, { ...CLEAN_EXCEPTIONS, file: { "Code/Gone.swift": "x" } }).error;
  assert.deepEqual(withoutFile, ["Exception without file: Code/Gone.swift — strike"]);
});

test("sabotage (2): a new full screen is red, and so is a full-screen needle without a hit", () => {
  const fresh = check(including("Chat/D.swift", "x.fullScreenCover(isPresented: $o) { Settings().cbSheet(.full) }"), CLEAN_EXCEPTIONS).error;
  assert.equal(fresh.length, 2, fresh.join("\n"));
  assert.match(fresh[0], /^\(2\)/);
  assert.match(fresh[1], /^\(4\)/, "a .cbSheet on the full screen is also outside a .sheet");
  const orphaned = check(CLEAN, { ...CLEAN_EXCEPTIONS, fullscreen: [...CLEAN_EXCEPTIONS.fullscreen, { needle: "Gone(", reason: "x" }] }).error;
  assert.deepEqual(orphaned, ["Full-screen exception without hit: \"Gone(\" — strike"]);
});

test("sabotage (3): detents, background and handle in the sheet itself are red — in the block and in an excepted file they are not", () => {
  for (const z of [".presentationDetents([.medium])", ".presentationBackground(.clear)", ".presentationDragIndicator(.visible)", ".presentationCornerRadius(20)", ".presentationBackgroundInteraction(.enabled)"]) {
    const { error } = check(including("Code/E.swift", `struct E: View { var body: some View { Text("") ${z} } }`), CLEAN_EXCEPTIONS);
    assert.equal(error.length, 1, `not red: ${z}`);
    assert.match(error[0], /^\(3\) Code\/E\.swift:1/);
  }
  const exempt = check(including("Code/E.swift", "x.presentationDetents([.medium]).sheet(isPresented: $o) { B() }"), { ...CLEAN_EXCEPTIONS, file: { "Code/E.swift": "x" } });
  assert.deepEqual(exempt.error, []);
  const inComment = check(including("Code/E.swift", "// .presentationDetents([.medium])\nlet a = 1"), CLEAN_EXCEPTIONS);
  assert.deepEqual(inComment.error, []);
});

test("sabotage (4): .cbSheet in the body of the presented type is red", () => {
  const { error } = check(including("Chat/F.swift", "struct F: View {\n  var body: some View { NavigationStack { Text(\"\") }.cbSheet(.half) }\n}"), CLEAN_EXCEPTIONS);
  assert.deepEqual(error.map((f) => f.slice(0, 18)), ["(4) Chat/F.swift:2"]);
});

test("sabotage (5): a popover without compact adaptation is red", () => {
  const { error } = check(including("Shell/G.swift", "x.popover(isPresented: $o) { List() }"), CLEAN_EXCEPTIONS);
  assert.equal(error.length, 1);
  assert.match(error[0], /^\(5\) Shell\/G\.swift:1/);
});

test("reader: strings with brackets, interpolation and raw strings do not shift a closure", () => {
  const src = 'x.sheet(isPresented: $o) {\n  B(a: "}", b: "\\(L("{"))", c: #"}"#)\n    .cbSheet(.half)\n}\n.sheet(isPresented: $p) { C() }';
  const p = presentations(onlyCode(src));
  assert.equal(p.length, 2);
  assert.ok(p[0].content.includes(".cbSheet("));
  assert.equal(p[1].row, 5);
  assert.ok(!p[1].content.includes(".cbSheet("));
});
