// Guard for text size on iOS: no new FIXED text size in the app.
//
// The text size from the settings should apply "in the whole app, but relative". It is built on Dynamic Type
// (`mobile/CbaseMobile/Kit/TextSize.swift`): a step is an offset in categories as a trait on the window, and every fixed size
// goes through `.cbFont(N)` and thus through `FixedFont` (the curve of its text style, no further beyond AX2, below L that of
// Body). A single new line `.font(.system(size: 13))` would stay put while everything around it grows: no type error, no
// crash, just a line that is suddenly smaller than its footnote at "Extra large".
//
// So `.system(size:` stands in `mobile/CbaseMobile` only on the named list below, per file with exact count and reason.
// Whoever means a text size writes `.cbFont(N)`; whoever means an SF symbol writes `.font(.symbol(N))` (fixed, like the SVG
// symbols on the web); whoever needs the scaled number itself (text + text, character grid) uses `@CbMetric` and
// `.font(.scaled(_name))`. The list is exact: one line more OR fewer in a file is red; whoever dissolves an exception
// removes it here, else it would be a silent free pass for the next.
//
// Counting happens in CODE: comments and strings drop out first (the explanatory texts name `.system(size:)` on purpose).
//
// The first version had two loopholes, both closed since:
//  - `Font.symbol(N)` is a FIXED size and compiles on any `Text`, so `Text("x").font(.symbol(13))` would stay green. Hence
//    `.symbol(` stands only in a modifier chain whose root is an `Image(`;
//  - fixed UIKit sizes (`UIFont.systemFont(ofSize:)`, `monospacedSystemFont(ofSize:)`, …) were not seen at all. They now
//    likewise stand file by file on a named list (`UIKIT_EXCEPTIONS`).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ROOT = path.join(REPO, "mobile/CbaseMobile");

export const EXCEPTIONS = {
  "Kit/TextSize.swift": {
    count: 3,
    reason: "the building blocks themselves: cbFont (with the scaled size), Font.symbol, Font.skaliert",
  },
  "Shell/AppShell.swift": {
    count: 2,
    reason: "TopBar title line (42 pt; workspace and project): a bar of fixed height does not grow, like Apple's tab bar",
  },
  "Shell/ServicesButton.swift": {
    count: 2,
    reason: "numbers on the ports and performance buttons in the TopBar status line (fixed like the bar)",
  },
  "Models/UsageStore.swift": {
    count: 1,
    reason: "percentage next to the limit ring in the TopBar (fixed like the bar)",
  },
  "Settings/SettingsKit.swift": {
    count: 1,
    reason: "number INSIDE a ring of fixed size (CbRing), computed from its diameter",
  },
  "Workflows/WorkflowCanvasEditor.swift": {
    count: 6,
    reason: "texts of the workflow card: geometry of the web builder (WorkflowGeometry), like cb-text-fixed on the web; the surface zoom enlarges them",
  },
};

const PATTERN = /\.system\(size:/g;

/** Fixed UIKit fonts: each stands here with a reason; it is displayed only through a scaling. */
export const UIKIT_EXCEPTIONS = {
  "Chat/ChatTextMarker.swift": {
    count: 1,
    reason: "marker text (UIKit): code in the monospace font, through `ChatInlineScaling.scale`, the same computation as cbFont or the curve of Body (the other fonts come from Kit/ChatTypeface.swift)",
  },
  "Kit/ChatTypeface.swift": {
    count: 1,
    reason: "the chat typeface: `uiFont(size:weight:)` receives the ALREADY scaled size (marker text, input field, chatFont)",
  },
  "Code/TerminalPane.swift": {
    count: 1,
    reason: "terminal: the size IS the scaled number (`@CbMetric outputSize`), the same the PTY character grid computes",
  },
  "Chat/ChatRunStatus.swift": {
    count: 1,
    reason: "measuring font (100 pt) for the ratio of ascender to descender; never displayed",
  },
};

const UIKIT_PATTERN = /\b(?:systemFont|boldSystemFont|italicSystemFont|monospacedSystemFont|monospacedDigitSystemFont)\(ofSize:/g;

export function fixedUIKitFonts(src) {
  return (onlyCode(src).match(UIKIT_PATTERN) || []).length;
}

/** Every `.symbol(` spot whose modifier chain is NOT attached to an `Image(`: the root is the first line going backwards
 *  that does not begin with `.` (or its own line, if `.symbol(` stands there behind the root). */
export function symbolWithoutImage(src) {
  const rows = onlyCode(src).split("\n");
  const findings = [];
  rows.forEach((row, i) => {
    if (!/\.symbol\(/.test(row)) return;
    const beforehand = row.slice(0, row.indexOf(".symbol("));
    let root = beforehand;
    if (/^\s*\./.test(row)) {
      let j = i;
      while (j > 0 && /^\s*\./.test(rows[j])) j--;
      root = rows[j];
    }
    if (!/\bImage\(/.test(root)) findings.push(root.trim() || row.trim());
  });
  return findings;
}

/** Swift source without comments and strings (nested block comments, `"""`, `#"…"#`). */
export function onlyCode(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    if (src.startsWith("//", i)) {
      const j = src.indexOf("\n", i);
      i = j < 0 ? n : j;
      continue;
    }
    if (src.startsWith("/*", i)) {
      let depth = 0;
      while (i < n) {
        if (src.startsWith("/*", i)) { depth++; i += 2; continue; }
        if (src.startsWith("*/", i)) { depth--; i += 2; if (depth === 0) break; continue; }
        i++;
      }
      continue;
    }
    const raw = /^#+"/.exec(src.slice(i, i + 8));
    if (src[i] === '"' || raw) {
      i = stringEnd(src, i);
      out += '""';
      continue;
    }
    out += src[i];
    i++;
  }
  return out;
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
      // Interpolation: up to the matching parenthesis, strings may appear inside again.
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

export function fixedFonts(src) {
  return (onlyCode(src).match(PATTERN) || []).length;
}

function swiftFiles(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...swiftFiles(p, base));
    else if (e.name.endsWith(".swift")) out.push(path.relative(base, p).split(path.sep).join("/"));
  }
  return out.sort();
}

test("counter: finds the fixed size in code, not in comments and strings", () => {
  // The built-in counter-test: without it a counter that never finds anything would be just as green.
  assert.equal(fixedFonts('Text("a").font(.system(size: 13))'), 1);
  assert.equal(fixedFonts("Text(x)\n    .font(.system(size: 12, weight: .bold))\n    .font(Font.system(size: 9))"), 2);
  assert.equal(fixedFonts("// .font(.system(size: 13))\n/* .system(size: 1) /* verschachtelt */ .system(size: 2) */"), 0);
  assert.equal(fixedFonts('let s = "nimm .system(size: 13)"; let u = "https://x" + ".system(size:"'), 0);
  assert.equal(fixedFonts('Text("\\(a ? "x" : ".system(size:")").font(.system(size: 13))'), 1);
  assert.equal(fixedFonts('let r = #"roh \\.system(size: 1)"#\n.cbFont(13)'), 0);
  assert.equal(fixedFonts('let m = """\n.system(size: 3)\n"""\n.font(.symbol(9))'), 0);
});

test("no new fixed text size in mobile/CbaseMobile: only the named exceptions, file by file exactly", () => {
  const found = {};
  for (const rel of swiftFiles(ROOT)) {
    const count = fixedFonts(fs.readFileSync(path.join(ROOT, rel), "utf8"));
    if (count > 0) found[rel] = count;
  }
  const error = [];
  for (const [rel, count] of Object.entries(found)) {
    const allowed = EXCEPTIONS[rel]?.count ?? 0;
    if (count > allowed) {
      error.push(`${rel}: ${count}x .system(size:, allowed ${allowed} — text: .cbFont(N), SF symbol: .font(.symbol(N))`);
    }
  }
  for (const [rel, { count }] of Object.entries(EXCEPTIONS)) {
    const actual = found[rel] ?? 0;
    if (actual < count) error.push(`${rel}: exception names ${count}, the code has ${actual} — adjust or remove the line here`);
  }
  const sum = Object.values(found).reduce((a, b) => a + b, 0);
  console.log(`# ios-font: ${sum} fixed sizes in ${Object.keys(found).length} files, all named`);
  assert.deepEqual(error, []);
});

test("counter: `.symbol(` only on an image, fixed UIKit fonts in code, with built-in counter-test", () => {
  assert.deepEqual(symbolWithoutImage('Text("x").font(.symbol(13))'), ['Text("").font(']);
  assert.deepEqual(symbolWithoutImage('Label("x", systemImage: "y")\n    .font(.symbol(12))'), ['Label("", systemImage: "")']);
  assert.deepEqual(symbolWithoutImage('HStack { Text(a) }\n    .font(.symbol(12))'), ["HStack { Text(a) }"]);
  assert.deepEqual(symbolWithoutImage('Image(systemName: "a").font(.symbol(13))'), []);
  assert.deepEqual(symbolWithoutImage('Image(systemName: x ? "a" : "b")\n    .foregroundStyle(.tint)\n    .font(.symbol(13, weight: .bold))'), []);
  assert.deepEqual(symbolWithoutImage("// Text(x).font(.symbol(13))\nstatic func symbol(_ pt: CGFloat) -> Font { x }"), []);
  assert.equal(fixedUIKitFonts("let f = UIFont.systemFont(ofSize: 13)\nlet g = UIFont.monospacedSystemFont(ofSize: 11, weight: .regular)"), 2);
  assert.equal(fixedUIKitFonts("let f = scale(.systemFont(ofSize: size, weight: w))\n// UIFont.boldSystemFont(ofSize: 3)"), 1);
});

test("SF symbol sizes (`.symbol`) stand only on images; on a text it would be a fixed text size", () => {
  const error = [];
  let total = 0;
  for (const rel of swiftFiles(ROOT)) {
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    total += (onlyCode(src).match(/\.symbol\(/g) || []).length;
    for (const root of symbolWithoutImage(src)) error.push(`${rel}: .symbol( on "${root}" — text: .cbFont(N)`);
  }
  console.log(`# ios-font: ${total} symbol sizes, all on an Image(`);
  assert.ok(total > 100, `only ${total} .symbol( spots seen — does the counter still measure?`);
  assert.deepEqual(error, []);
});

test("no new fixed UIKit font: only the named exceptions, file by file exactly", () => {
  const found = {};
  for (const rel of swiftFiles(ROOT)) {
    const count = fixedUIKitFonts(fs.readFileSync(path.join(ROOT, rel), "utf8"));
    if (count > 0) found[rel] = count;
  }
  const error = [];
  for (const [rel, count] of Object.entries(found)) {
    const allowed = UIKIT_EXCEPTIONS[rel]?.count ?? 0;
    if (count !== allowed) {
      error.push(`${rel}: ${count}x fixed UIKit font, allowed ${allowed} — scale via UIFontMetrics or FixedFont.groesse and name it here`);
    }
  }
  for (const [rel, { count }] of Object.entries(UIKIT_EXCEPTIONS)) {
    if (!found[rel]) error.push(`${rel}: exception names ${count}, the code has none — remove the line here`);
  }
  console.log(`# ios-font: ${Object.values(found).reduce((a, b) => a + b, 0)} fixed UIKit fonts in ${Object.keys(found).length} files, all named`);
  assert.deepEqual(error, []);
});

test("every exception names an existing file and a reason", () => {
  for (const [rel, { count, reason }] of [...Object.entries(EXCEPTIONS), ...Object.entries(UIKIT_EXCEPTIONS)]) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `${rel} does not exist`);
    assert.ok(Number.isInteger(count) && count > 0, `${rel}: count ${count}`);
    assert.ok(typeof reason === "string" && reason.length > 20, `${rel}: without reason`);
  }
});

test("the building blocks stand and the window trait is attached", () => {
  const kit = fs.readFileSync(path.join(ROOT, "Kit/TextSize.swift"), "utf8");
  assert.match(kit, /func cbFont\(/, "cbFont missing");
  assert.match(kit, /static func symbol\(/, "Font.symbol missing");
  assert.match(kit, /_size = CbMetric\(wrappedValue: pt\)/, "cbFont does not scale through @CbMetric");
  assert.match(kit, /enum FixedFont \{/, "FixedFont (cap AX2, Body curve below L) missing");
  // The read trap: a READING access to an unset override throws. Only contains/remove and the assignment are allowed.
  const code = onlyCode(kit);
  const reading = code.match(/traitOverrides\.preferredContentSizeCategory(?!\s*=[^=])/g) || [];
  assert.deepEqual(reading, [], "traitOverrides.preferredContentSizeCategory is read");
  const app = fs.readFileSync(path.join(ROOT, "Shell/CbaseMobileApp.swift"), "utf8");
  assert.match(onlyCode(app), /\.background\(WindowFont\(\)\)/, "WindowFont is not attached to the window");
});
