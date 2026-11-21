// The first sentence of a tool description (mcp/first-set.js): the ONE sentence boundary that the loop engine reads for its catalog
// row and the length guard (mcp-description-length.test.js) for its 160-character rule. Here are the traps of the boundary — each a
// period that is NOT a sentence end (abbreviation, number, version, path, file extension, ellipsis) — and the cases where it is one.
// The German abbreviation cases stay German on purpose (the boundary knows German abbreviations).
// Counter-test: a naive `text.split(". ")[0]` fails on "z. B.", "u. a.", "bzw." and "max."; a naive `/[.!?]/` additionally on
// "2.048", "2.1.296", "CLAUDE.md" and "src/app.ts" (both red here, measured).
// Runtime: the abbreviation check used to read the whole text before each period — quadratic, 40,000 × "x. " = 10.6 s synchronous in
// the engine. Counter-test: with the old `isAbbreviation(t.slice(0, m.index))` "linear" is red at the deadline.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { CATALOG_CAP, firstSentence, catalogRow } from "../electron/mcp/first-set.js";

const CASES = [
  // [input, expected first sentence, trap]
  ["Liest eine Datei. Danach mehr.", "Liest eine Datei.", "simple sentence"],
  ["Legt an, z. B. einen Dienst. Danach mehr.", "Legt an, z. B. einen Dienst.", "\"z. B.\""],
  ["Prüft u. a. die Ports. Danach mehr.", "Prüft u. a. die Ports.", "\"u. a.\""],
  ["Holt d. h. alles. Danach mehr.", "Holt d. h. alles.", "\"d. h.\""],
  ["Uses e.g. a port. Then more.", "Uses e.g. a port.", "\"e.g.\" written together"],
  ["Startet bzw. stoppt einen Dienst. Danach mehr.", "Startet bzw. stoppt einen Dienst.", "\"bzw.\""],
  ["Blättert seitenweise (max. 100 je Seite). Danach mehr.", "Blättert seitenweise (max. 100 je Seite).", "\"max.\" in parentheses"],
  ["Kürzt ggf. den Text, inkl. Anhängen. Danach mehr.", "Kürzt ggf. den Text, inkl. Anhängen.", "\"ggf.\" and \"inkl.\""],
  ["Gilt seit Claude Code 2.1.296 für 2.048 Zeichen. Danach mehr.", "Gilt seit Claude Code 2.1.296 für 2.048 Zeichen.", "version and thousands separator"],
  ["Liest CLAUDE.md und src/app.ts ein. Danach mehr.", "Liest CLAUDE.md und src/app.ts ein.", "file extension and path"],
  ["Nur .ts/.tsx/.js Dateien. Danach mehr.", "Nur .ts/.tsx/.js Dateien.", "extensions at the start of a word"],
  ["Wartet... und schreibt dann. Danach mehr.", "Wartet... und schreibt dann.", "ellipsis"],
  ["Prüft Stufe 3. von 5 Stufen. Danach mehr.", "Prüft Stufe 3. von 5 Stufen.", "number with period before lowercase"],
  ["Prüft Ports bis 9999. Danach mehr.", "Prüft Ports bis 9999.", "number at sentence end before uppercase"],
  ["Fragt „wirklich?“ und wartet. Danach mehr.", "Fragt „wirklich?“", "question mark with closing quotation mark"],
  ["Stopp! Danach mehr.", "Stopp!", "exclamation mark"],
  ["Erste Zeile ohne Punkt\n\nSecond Absatz.", "Erste Zeile ohne Punkt", "blank line as boundary"],
  ["Ein Satz\nüber zwei Zeilen. Danach mehr.", "Ein Satz über zwei Zeilen.", "a single line break folds"],
  ["  Leerraum   davor und\tdazwischen. Rest.", "Leerraum davor und dazwischen.", "whitespace folded"],
  ["Kein Satzende hier", "Kein Satzende hier", "without a boundary the whole text"],
  ["Endet am Schluss.", "Endet am Schluss.", "period at the end"],
  ["Liefert Werte (ca. 5 Stück) usw. Danach mehr.", "Liefert Werte (ca. 5 Stück) usw.", "\"usw.\" before uppercase ends the sentence"],
  ["Ports, Dienste etc. Danach mehr.", "Ports, Dienste etc.", "\"etc.\" before uppercase ends the sentence"],
  ["Ports, Dienste usw. und mehr. Danach.", "Ports, Dienste usw. und mehr.", "\"usw.\" in the middle of a sentence"],
  ["Startet bzw. Stoppt Dienste. Danach.", "Startet bzw. Stoppt Dienste.", "\"bzw.\" before uppercase stays an abbreviation"],
  [`Liest ${"a".repeat(45)}. dann weiter. Danach.`, `Liest ${"a".repeat(45)}.`, "a word beyond the window is no abbreviation"],
  ["", "", "empty"],
];

test("firstSentence: every trap of the sentence boundary", () => {
  for (const [one, out, trap] of CASES) assert.equal(firstSentence(one), out, trap);
  assert.equal(firstSentence(undefined), "", "undefined");
  assert.equal(firstSentence(null), "", "null");
});

test("catalogRow: the first sentence, capped at CATALOG_CAP characters with \"…\"", () => {
  assert.equal(CATALOG_CAP, 200);
  assert.equal(catalogRow("Kurz. Lang danach."), "Kurz.");
  const withoutEnd = "Word ".repeat(60).trim();
  const z = catalogRow(withoutEnd);
  assert.ok(z.endsWith("…"), z);
  assert.equal(z, `${withoutEnd.slice(0, 200).trimEnd()}…`);
  assert.ok(z.length <= 201, String(z.length));
  const exactly = "x".repeat(200);
  assert.equal(catalogRow(exactly), exactly, "exactly at the cap stays without \"…\"");
  assert.equal(catalogRow("Satz mit Deckel 5. Rest.", 5), "Satz…", "own cap");
});

// A deadline against HANGS, not a time measurement: linear it is milliseconds, quadratic minutes. In a child process, so a regression
// turns the test red instead of holding up the suite.
const DEADLINE_MS = 60_000;
test("firstSentence: linear — pathological inputs (about 400,000 characters each) run through, deadline against hangs", (t) => {
  const script = `
    import { firstSentence, catalogRow } from ${JSON.stringify(new URL("../electron/mcp/first-set.js", import.meta.url).href)};
    const n = 400000;
    const cases = ["x. ".repeat(n / 3), "z. B. ".repeat(n / 6), "1. ".repeat(n / 3), "usw. ".repeat(n / 5), ("a".repeat(39) + ". ").repeat(n / 41),
      ". ".repeat(n / 2), "... ".repeat(n / 4), "(x. ".repeat(n / 4), "Word ".repeat(n / 5)];
    let sum = 0;
    for (const f of cases) sum += firstSentence(f).length + catalogRow(f).length;
    console.log("done " + cases.length + " " + sum);
  `;
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: DEADLINE_MS, env });
  assert.equal(r.signal, null, `aborted after ${DEADLINE_MS} ms (${r.signal}) — firstSentence is no longer linear`);
  assert.equal(r.status, 0, r.stderr);
  const m = /^done (\d+) (\d+)/.exec(r.stdout);
  assert.ok(m, r.stdout);
  t.diagnostic(`firstSentence linear: ${m[1]} cases, deadline ${DEADLINE_MS} ms`);
});
