// The language guard in the gate (tools/check/language.mjs carries the promise and the heuristic).
//
// RATCHET: language-ratchet.json holds today's count of real German lines in the public tree. The first test fails when the
// count EXCEEDS it, so German can only shrink. The ratchet MUST reach 0 before publication (then the test also asserts that
// the ratchet file says 0).
//
// COUNTER-TEST (built in, runs every time): a tree with German planted in a comment, a md doc, a test title, a string
// literal and an identifier-like name must report each kind; the same tree in English reports nothing; a planted file that is
// allowlisted passes; a line allowlist entry passes exactly its line.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scan, loadAllow, loadRatchet, isGerman, germanWords, germanIdentifier, kindOf, fileAllowed, RATCHET_FILE, ALLOW_FILE } from "./language.mjs";

test("the public tree has no more German lines than the ratchet allows", (t) => {
  const r = scan(); const ratchet = loadRatchet();
  t.diagnostic(`[language] ${r.findings.length} German lines, ratchet ${ratchet}, allowlisted ${[...r.allowedLines.values()].reduce((a, b) => a + b, 0)}`);
  assert.ok(r.findings.length <= ratchet, `${r.findings.length} German lines exceed the ratchet ${ratchet} — translate the new text (list: node tools/check/language.mjs --list), or if lines were translated lower language-ratchet.json`);
  if (r.findings.length < ratchet) t.diagnostic(`[language] below the ratchet: lower language-ratchet.json to ${r.findings.length}`);
});

test("the ratchet file and the allowlist are well-formed; every allowlist entry has a reason", () => {
  assert.ok(Number.isInteger(JSON.parse(fs.readFileSync(RATCHET_FILE, "utf8")).maxFindings));
  const raw = JSON.parse(fs.readFileSync(ALLOW_FILE, "utf8"));
  for (const e of [...raw.files, ...raw.lines]) assert.ok(typeof e.reason === "string" && e.reason.length >= 10, `entry without a reason: ${JSON.stringify(e)}`);
  loadAllow();   // throws on a malformed entry
});

test("heuristic: umlaut/ß or three distinct German-only stop words; English twins do not count", () => {
  assert.equal(isGerman("Der Lauf ist nicht fertig"), true);
  assert.equal(isGerman("// schließt den Strom"), true);
  assert.equal(isGerman("the die was cast; the man will go and the den is here"), false, "English words that are German too");
  assert.equal(isGerman("const x = a ? b : c; // for each item in the list"), false);
  assert.equal(isGerman("und oder"), false, "two words are not enough");
  assert.deepEqual([...germanWords("Der der DER und nicht")].sort(), ["der", "nicht", "und"]);
  assert.equal(germanIdentifier("const istNichtFertig = 1;"), "istNichtFertig");
  assert.equal(germanIdentifier("const isNotReady = 1; const maxLength = 2;"), null);
  assert.equal(kindOf("a.js", `test("x ist y", () => {`), "testname");
  assert.equal(kindOf("a.md", "plain"), "doc");
  assert.equal(kindOf("a.js", "  // hello"), "comment");
  assert.equal(kindOf("a.js", `const s = "hello";`), "string");
});

test("allowlist paths: exact file, directory prefix, one-segment glob", () => {
  const allow = { files: [{ path: "a/", reason: "x" }, { path: "b/c.js", reason: "x" }, { path: "d/Loc*.swift", reason: "x" }], lines: [] };
  for (const p of ["a/x/y.js", "b/c.js", "d/LocDEBase.swift"]) assert.ok(fileAllowed(p, allow), p);
  for (const p of ["ab/x.js", "b/c.jsx", "d/x/LocDE.swift", "d/Other.swift"]) assert.equal(fileAllowed(p, allow), null, p);
});

test("counter-test: German planted per kind is reported per kind; English and allowlisted files are not", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-lang-"));
  try {
    const plant = {
      "comment.js": "const a = 1;\n// Der Lauf wird nicht gestartet, wenn die Liste leer ist\n",
      "doc.md": "# Title\n\nDie Datei wird nicht geschrieben, wenn der Ordner fehlt.\n",
      "title.test.mjs": 'import test from "node:test";\ntest("der Lauf ist nicht fertig", () => {});\n',
      "string.js": 'const msg = "Die Datei konnte nicht gelesen werden, weil sie fehlt";\n',
      "ident.js": "const istNichtFertig = true;\n",
      "umlaut.js": "// closes the stream: Schließen\n",
    };
    const clean = {
      "comment.js": "const a = 1;\n// The run is not started when the list is empty\n",
      "doc.md": "# Title\n\nThe file is not written when the folder is missing.\n",
      "title.test.mjs": 'import test from "node:test";\ntest("the run is not done", () => {});\n',
      "string.js": 'const msg = "The file could not be read because it is missing";\n',
      "ident.js": "const isNotReady = true;\n",
      "umlaut.js": "// closes the stream\n",
    };
    for (const [n, c] of Object.entries(plant)) fs.writeFileSync(path.join(root, n), c);
    const files = Object.keys(plant); const none = { files: [], lines: [] };
    const got = scan({ root, files, allow: none }).findings.map((f) => `${f.kind}:${f.file}:${f.line}`).sort();
    assert.deepEqual(got, ["comment:comment.js:2", "comment:umlaut.js:1", "doc:doc.md:3", "identifier:ident.js:1", "string:string.js:1", "testname:title.test.mjs:2"]);
    // The same tree in English reports nothing.
    for (const [n, c] of Object.entries(clean)) fs.writeFileSync(path.join(root, n), c);
    assert.deepEqual(scan({ root, files, allow: none }).findings, [], "English must pass");
    // Allowlisted planted file passes; a line entry passes exactly its pattern; the rest stays reported.
    for (const [n, c] of Object.entries(plant)) fs.writeFileSync(path.join(root, n), c);
    fs.writeFileSync(path.join(root, "two.js"), "// Schließen ist hier gewollt\n// Der Lauf wird nicht gestartet, wenn die Liste leer ist\n");
    const allow = { files: [{ path: "comment.js", reason: "German on purpose (test)" }], lines: [{ file: "^two\\.js$", pattern: "Schließen", re: /Schließen/, fre: /^two\.js$/, reason: "r" }] };
    const r = scan({ root, files: [...files, "two.js"], allow });
    assert.ok(!r.findings.some((f) => f.file === "comment.js"), "an allowlisted file passes");
    assert.deepEqual(r.findings.filter((f) => f.file === "two.js").map((f) => f.line), [2], "a line entry passes only the matching line");
    assert.equal(r.findings.length, 6);
    // Binary, large and absent files are tolerated.
    fs.writeFileSync(path.join(root, "bin.dat"), Buffer.from([0, 1, 2, 0xc3, 0xa4, 0]));
    assert.deepEqual(scan({ root, files: ["bin.dat", "absent.js"], allow: none }).findings, []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a tree without the private part scans (the public clone)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-lang-"));
  try { fs.writeFileSync(path.join(root, "x.js"), "// fine\n"); assert.deepEqual(scan({ root, files: ["x.js"], allow: loadAllow(path.join(root, "absent.json")) }).findings, []); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
});
