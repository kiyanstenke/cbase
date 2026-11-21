// The German identifier guard in the gate (tools/check/identifiers.mjs carries the promise, the tokenizer and the vocabulary rules).
//
// RATCHET: identifiers-ratchet.json holds today's count of German identifier occurrences and of distinct identifiers. The first
// test fails when either EXCEEDS it, so German names can only shrink; the message names the top identifiers and files, never a
// wall. The ratchet MUST reach 0 before publication.
//
// COUNTER-TEST (built in, runs every time): a temp tree with German identifiers planted in js, mjs, ts, tsx, swift and sh must
// report each of them; the same tree with English names reports nothing; comments, prose strings, regex literals, template text and
// heredocs are not names; allowlisted files and names pass exactly what they list. The guard must also run in a tree without the private part
// (the public clone): it reads only its own vocabulary file.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scan, loadVocab, loadAllow, loadRatchet, partsOf, germanPart, tokensOf, summarize, render, VOCAB_FILE, ALLOW_FILE, RATCHET_FILE } from "./identifiers.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const vocab = loadVocab();
const names = (text, file) => tokensOf(text, file).map((t) => t.id);

test("the public tree has no more German identifiers than the ratchet allows", (t) => {
  const r = scan(); const s = summarize(r.findings); const ratchet = loadRatchet();
  t.diagnostic(`[identifiers] ${s.total} occurrences / ${s.identifiers} identifiers, ratchet ${ratchet.maxFindings} / ${ratchet.maxIdentifiers}, allowlisted ${r.allowed}`);
  assert.ok(s.total <= ratchet.maxFindings && s.identifiers <= ratchet.maxIdentifiers,
    `German identifiers exceed the ratchet (${s.total} / ${s.identifiers} against ${ratchet.maxFindings} / ${ratchet.maxIdentifiers}) — rename the new ones to English.\n${render(r, { top: 6 })}`);
  if (s.total < ratchet.maxFindings || s.identifiers < ratchet.maxIdentifiers) t.diagnostic(`[identifiers] below the ratchet: lower identifiers-ratchet.json to ${s.total} / ${s.identifiers}`);
});

test("vocabulary, allowlist and ratchet files are well-formed; the vocabulary holds no English homograph", () => {
  const raw = JSON.parse(fs.readFileSync(VOCAB_FILE, "utf8"));
  assert.ok(vocab.words.size >= 1000, "the vocabulary is a real list");
  for (const w of vocab.words) assert.match(w, /^[a-z]{2,}$/, w);
  // Words that are English too must never be on the list (a false alarm on `rest`, `last`, `name` would train people to dismiss the guard).
  const homographs = "rat rest art gift bad fast hat will was man die sein also name last mit stand rate hang kind wand rock bald boot brief fell gang hand hell lack mist pest rind rot sage tag tier tor war wine an da ab so es".split(" ");
  for (const w of homographs) assert.ok(!vocab.words.has(w), `"${w}" is also English and must not be in the vocabulary`);
  assert.ok(vocab.exact.has("stand") && !vocab.words.has("stand"), "stand counts only as a whole name");
  for (const w of ["war", "mit"]) assert.ok(vocab.exact.has(w), `${w} counts as a whole name`);
  assert.ok(vocab.notFirst.has("was") && !vocab.exact.has("hat"), "was counts after the first part; hat (English alone too) is not listed");
  // The short German function words are words: they glue German names together (occupancyAmProject, alsHtml, nextNr).
  for (const w of "am als um nr ja der das ist nicht im je wo zu beim vom zum ohne neu wer wie aus auf von nach bei fuer ueber und oder".split(" ")) assert.ok(vocab.words.has(w), `short German word "${w}" must be in the vocabulary`);
  assert.throws(() => { const f = path.join(os.tmpdir(), `cbase-vocab-${process.pid}.json`); fs.writeFileSync(f, JSON.stringify({ words: ["was"], notFirst: ["was"] })); try { loadVocab(f); } finally { fs.rmSync(f, { force: true }); } }, /homograph/, "a homograph listed as a word too is refused");
  assert.ok(Array.isArray(raw.words) && Array.isArray(raw.stems));
  assert.ok(Number.isInteger(loadRatchet().maxFindings) && Number.isInteger(JSON.parse(fs.readFileSync(RATCHET_FILE, "utf8")).maxIdentifiers));
  const allow = JSON.parse(fs.readFileSync(ALLOW_FILE, "utf8"));
  for (const e of [...allow.files, ...allow.identifiers]) assert.ok(typeof e.reason === "string" && e.reason.length >= 10, `entry without a reason: ${JSON.stringify(e)}`);
  loadAllow();   // throws on a malformed entry
});

test("names split into parts: camel, Pascal, snake, kebab, acronyms; only whole parts match", () => {
  assert.deepEqual(partsOf("loadOrdnerListe"), ["load", "ordner", "liste"]);
  assert.deepEqual(partsOf("HTTPServerName"), ["http", "server", "name"]);
  assert.deepEqual(partsOf("a_b-c.d"), ["a", "b", "c", "d"]);
  assert.equal(germanPart("loadOrdnerListe", vocab), "ordner");
  assert.equal(germanPart("folderList", vocab), null);
  assert.equal(germanPart("orderedFolders", vocab), null, "a German word is not a prefix match on short parts");
  assert.equal(germanPart("prüfung", vocab), "(umlaut)");
  assert.equal(germanPart("stand", vocab), "stand");
  assert.equal(germanPart("Stand", vocab), "stand");
  assert.equal(germanPart("standAlone", vocab), null, "stand is English inside a compound");
  assert.equal(germanPart("werkzeugfooName", vocab), "werkzeug", "a stem of >= 7 letters matches a compound part");
  assert.equal(germanPart("projectbox", vocab), null);
  // Short German words inside a name; their English look-alikes pass.
  assert.equal(germanPart("occupancyAmProject", vocab), "am");
  assert.equal(germanPart("alsHtml", vocab), "als");
  assert.equal(germanPart("nextNr", vocab), "nr");
  assert.equal(germanPart("LFS_JA_AGENT", vocab), "ja");
  assert.equal(germanPart("amdGpu", vocab), null, "am is a whole part, not a prefix");
  assert.equal(germanPart("camera", vocab), null);
  // notFirst: `was` alone or after a noun is German; leading, it is the English auxiliary.
  assert.equal(germanPart("was", vocab), "was");
  assert.equal(germanPart("gateWas", vocab), "was");
  assert.equal(germanPart("wasReady", vocab), null, "wasReady is English");
  assert.equal(germanPart("was_open", vocab), null);
  // exactOnly: mit/war alone are German, inside a compound English (MIT licence).
  assert.equal(germanPart("mit", vocab), "mit");
  assert.equal(germanPart("MIT_LICENSE", vocab), null);
  assert.equal(germanPart("hat", vocab), null, "hat alone is English too");
  assert.equal(germanPart("redHat", vocab), null);
});

test("tokenizer: code names yes; comments, prose strings, regex, template text, heredocs no", () => {
  assert.deepEqual(names("// ordner\n/* ordner */ const a = 1; /* nested /* x */ */", "a.js"), ["const", "a"]);
  assert.deepEqual(names('const s = "Der Ordner fehlt"; const t = `ordner ${kasse} text`;', "a.js"), ["const", "s", "const", "t", "kasse"]);
  assert.deepEqual(names("const r = /ordner[/]x/g; const q = a / b / c;", "a.js"), ["const", "r", "const", "q", "a", "b", "c"]);
  assert.deepEqual(tokensOf('x("ordner_pfad"); y("Hello world");', "a.js").filter((t) => t.kind === "key").map((t) => t.id), ["ordner_pfad"], "only a name-shaped quoted token is a key");
  assert.deepEqual(tokensOf('f("Danach"); f("Fertig.");', "a.js").filter((t) => t.kind === "key"), [], "a capitalised word is text, not a key");
  assert.deepEqual(names('let a = "x \\(ordner) y"; // ordner\nlet b = """\n  text ordner \\(kasse)\n  """', "a.swift"), ["let", "a", "ordner", "let", "b", "kasse"]);
  const sh = "# ordner\nordner_pfad=1\necho \"$ordner_pfad\" 'ordner_x=1'\ncat <<'EOF'\nkasse_x=1 $kasse\nEOF\nfunction pruefe_datei { :; }\nfor datei in a b; do :; done\nlocal_x=\"ordner=2\"\n";
  assert.deepEqual(names(sh, "a.sh").filter((n) => /ordner|kasse|datei/.test(n)).sort(), ["datei", "ordner_pfad", "ordner_pfad", "pruefe_datei"].sort());
});

test("counter-test: German names planted per language are reported; English, prose and allowlisted names are not", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-ident-"));
  try {
    const plant = {
      "a.js": "const ordnerPfad = 1;\nfunction pruefeDatei() { return obj.abgeloest; }\nclass Kasse {}\n",
      "b.mjs": "export const loadWerkzeugsatz = () => ({ fehler: 1 });\nconst k = row['kasse_id'];\n",
      "c.cjs": "module.exports = { zeitplan: 1 };\n",
      "d.ts": "interface Foo { stand: string }\nexport function parseNachricht(): void {}\n",
      "e.tsx": "export const Ansicht = () => { const [zu, setZu] = useState(0); return null; };\n",
      "f.swift": "struct Ordner { let abgeloest: Bool }\nfunc pruefen() { print(\"\\(ordner)\") }\n",
      "g.sh": "ordner_pfad=1\necho \"$ordner_pfad\"\nfunction pruefe_datei { :; }\n",
      "h.js": "const prüfung = 1;\n",
      "i.js": "const occupancyAmProject = 1;\nconst alsHtml = (t) => t;\nlog.push({ step, was: 1, at });\nconst gateWas = 2;\nconst m = { mit: 1 };\n",
      "j.swift": "let nextNr = 0\nfunc lfsAm(_ ja: Bool) {}\n",
    };
    const clean = {
      "a.js": "const folderPath = 1;\nfunction checkFile() { return obj.superseded; }\nclass Checkout {}\n// ordner fehlt: Der Ordner ist nicht da\nconst msg = \"Der Ordner fehlt\";\nconst re = /ordner/;\nconst tpl = `ordner ${folderPath}`;\n",
      "b.mjs": "export const loadToolset = () => ({ error: 1 });\nconst k = row['checkout_id'];\nconst last = 1, rest = 2, name = 3, art = 4, gift = 5, standAlone = 6, hat = 7, will = 8;\n",
      "c.cjs": "module.exports = { schedule: 1 };\n",
      "d.ts": "interface Foo { state: string }\nexport function parseMessage(): void {}\n",
      "e.tsx": "export const View = () => { const [closed, setClosed] = useState(0); return null; };\n",
      "f.swift": "struct Folder { let superseded: Bool }\nfunc check() { print(\"\\(folder)\") }\n// Ordner\nlet text = \"\"\"\nOrdner \\(x)\n\"\"\"\n",
      "g.sh": "folder_path=1\necho \"$folder_path\"\nfunction check_file { :; }\n# ordner\ncat <<'EOF'\nordner_x=1\nEOF\n",
      "h.js": "const check = 1;\n",
      "i.js": "const occupancyOfProject = 1;\nconst asHtml = (t) => t;\nlog.push({ step, what: 1, at });\nconst wasReady = 2, wasOpen = 3, hat = 4, redHat = 5, MIT_LICENSE = 6, amdGpu = 7;\n// was am als um: comments are not names\nconst s = \"it was an example\";\n",
      "j.swift": "let nextSeq = 0\nfunc lfsAt(_ yes: Bool) {}\nlet wasVisible = true\n",
    };
    const files = Object.keys(plant); const none = { files: [], identifiers: [] }; const noLang = { files: [], lines: [] };
    const run = (allow = none) => scan({ root, files, vocab, allow, languageAllow: noLang });
    for (const [n, c] of Object.entries(plant)) fs.writeFileSync(path.join(root, n), c);
    const got = run().findings.map((f) => `${f.file}:${f.line}:${f.id}`).sort();
    assert.deepEqual(got, [
      "a.js:1:ordnerPfad", "a.js:2:abgeloest", "a.js:2:pruefeDatei", "a.js:3:Kasse",
      "b.mjs:1:fehler", "b.mjs:1:loadWerkzeugsatz", "b.mjs:2:kasse_id",
      "c.cjs:1:zeitplan", "d.ts:1:stand", "d.ts:2:parseNachricht", "e.tsx:1:Ansicht", "e.tsx:1:setZu", "e.tsx:1:zu",
      "f.swift:1:Ordner", "f.swift:1:abgeloest", "f.swift:2:ordner", "f.swift:2:pruefen",
      "g.sh:1:ordner_pfad", "g.sh:2:ordner_pfad", "g.sh:3:pruefe_datei", "h.js:1:prüfung",
      "i.js:1:occupancyAmProject", "i.js:2:alsHtml", "i.js:3:was", "i.js:4:gateWas", "i.js:5:mit",
      "j.swift:1:nextNr", "j.swift:2:ja", "j.swift:2:lfsAm",
    ].sort());
    for (const [n, c] of Object.entries(clean)) fs.writeFileSync(path.join(root, n), c);
    assert.deepEqual(run().findings, [], "English names, comments, prose, regex, template text and heredocs must pass");
    // Allowlist: a whole file, and one name pattern restricted by file and kind.
    for (const [n, c] of Object.entries(plant)) fs.writeFileSync(path.join(root, n), c);
    const allow = loadAllowFrom([{ path: "a.js", reason: "German on purpose (test)" }], [{ pattern: "^kasse_id$", file: "^b\\.mjs$", kind: "key", reason: "wire name that stays (test)" }]);
    const r = run(allow);
    assert.ok(!r.findings.some((f) => f.file === "a.js"), "an allowlisted file passes");
    assert.ok(!r.findings.some((f) => f.id === "kasse_id"), "an allowlisted key passes");
    assert.ok(r.findings.some((f) => f.id === "fehler" && f.file === "b.mjs"), "the rest of that file is still reported");
    assert.equal(r.allowed, 1);
    const wrongKind = loadAllowFrom([], [{ pattern: "^kasse_id$", kind: "code", reason: "wrong kind (test)" }]);
    assert.ok(run(wrongKind).findings.some((f) => f.id === "kasse_id"), "a kind-restricted entry does not pass the other kind");
    // Other file types, binary, large and absent files are tolerated; JSON and Markdown are out of scope.
    fs.writeFileSync(path.join(root, "x.json"), '{ "ordner": 1 }\n'); fs.writeFileSync(path.join(root, "x.md"), "ordner = 1\n");
    assert.deepEqual(scan({ root, files: ["x.json", "x.md", "absent.js"], vocab, allow: none, languageAllow: noLang }).findings, []);
    // The failure message names counts, top identifiers and files — a short report, not a list.
    const text = render(run(), { top: 3 });
    assert.match(text, /German identifier occurrences/); assert.match(text, /top identifiers:/); assert.match(text, /top files:/);
    assert.ok(text.split("\n").length < 25, "a report is never a wall");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

function loadAllowFrom(files, identifiers) {
  return { files, identifiers: identifiers.map((e) => ({ ...e, re: new RegExp(e.pattern), fre: e.file ? new RegExp(e.file) : null })) };
}

test("a tree without the private part scans: the guard reads only its own vocabulary and imports nothing private", () => {
  const src = fs.readFileSync(path.join(HERE, "identifiers.mjs"), "utf8");
  assert.ok(!/["'`]ops\/|ops\/deploy|woerterbuch/.test(src.replace(/^\/\/.*$/gm, "")), "the guard must not depend on the private part of the tree");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-ident-"));
  try {
    fs.writeFileSync(path.join(root, "x.js"), "const fine = 1;\n");
    const r = scan({ root, files: ["x.js"], vocab: loadVocab(path.join(root, "absent.json")), allow: loadAllow(path.join(root, "absent.json")), languageAllow: { files: [], lines: [] } });
    assert.deepEqual(r.findings, []);
    assert.equal(loadRatchet(path.join(root, "absent.json")).maxFindings, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
