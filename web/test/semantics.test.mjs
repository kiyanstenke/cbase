// Semantic highlighting like VS Code.
//
// (1) The computation lib/semantics.ts, EXECUTED (compiled with tsc): the default rules in the order of their registration in VS
//     Code (tokenClassificationRegistry.ts -- a tie goes to the later one) and their colors in Dark/Light Modern at the places one
//     sees in the editor (`const` #4fc1ff, functions #dcdcaa, types #4ec9b0, ...); a rule without color is one in BOTH themes; the
//     scoring (kind, supertype, modifiers, tie, rules without color do not count); the color per mode; decoding LSP `data`
//     (relative, modifier bits, incomplete rest, kind outside the legend); the class at the text; the spans in the text
//     (`semanticsSpans`) against CodeMirror's REAL `Text` and `RangeSetBuilder` -- column, clipping at the line end, a row beyond
//     the text, overlap --, and the quiet period after a change (`semanticsDelay`: moving average of the last six request
//     durations, 300-2,000 ms, 450 without measurement).
// (2) The bindings (source text): the highlighting sits in every editor with a language service (lsp-extension.ts), asks only with
//     the capability, aborts on every change (signal) and asks again after the quiet period, never two at once, once more after 409,
//     at once when the server becomes ready or asks for new tokens (language event), never again after `destroy`; discards an
//     outdated answer, lets the marks move with the text and colors per mode more specifically than the syntax coloring.
//
// Every sabotage is a copy of the source with ONE changed place (the place stands exactly once, otherwise the sabotage is stale);
// the assigned check must fail on it.
//
// Run:  node --test --test-reporter=tap web/test/semantics.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RangeSetBuilder, RangeValue, Text } from "@codemirror/state";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");
const read = (...p) => fs.readFileSync(path.join(webDir, ...p), "utf8");

// ── (1) The computation ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
const SOURCE = read("src", "lib", "semantics.ts");
const SABOTAGES = [
  { name: "readonly light like dark", old: "[\"variable.readonly\", \"#4fc1ff\", \"#0070c1\"]", fresh: "[\"variable.readonly\", \"#4fc1ff\", \"#4fc1ff\"]", catches: "rules" },
  { name: "function like variable", old: "[\"function\", \"#dcdcaa\", \"#795e26\"]", fresh: "[\"function\", \"#9cdcfe\", \"#795e26\"]", catches: "rules" },
  { name: "only one theme without color", old: "[\"property.defaultLibrary.readonly\", null, null]", fresh: "[\"property.defaultLibrary.readonly\", null, \"#0070c1\"]", catches: "rules" },
  { name: "order swapped", old: "  [\"variable\", \"#9cdcfe\", \"#001080\"],\n  [\"parameter\", \"#9cdcfe\", \"#001080\"],", fresh: "  [\"parameter\", \"#9cdcfe\", \"#001080\"],\n  [\"variable\", \"#9cdcfe\", \"#001080\"],", catches: "rules" },
  { name: "library constant with color", old: "[\"variable.defaultLibrary.readonly\", null, null]", fresh: "[\"variable.defaultLibrary.readonly\", \"#4fc1ff\", \"#0070c1\"]", catches: "score" },
  { name: "tie: the earlier one", old: "if (w >= score)", fresh: "if (w > score)", catches: "score" },
  { name: "modifiers ignored", old: "!r.mods.every((m) => modifiers.includes(m))", fresh: "!r.mods.every(() => true)", catches: "score" },
  { name: "without supertype member", old: "{ member: \"method\", ", fresh: "{ ", catches: "score" },
  { name: "without supertype selfParameter", old: "selfParameter: \"parameter\", ", fresh: "", catches: "score" },
  { name: "rule without color counts", old: "    if (!r.dark) continue;\n", fresh: "", catches: "score" },
  { name: "always dark", old: "return r ? (dark ? r.dark : r.light) : null;", fresh: "return r ? r.dark : null;", catches: "color" },
  { name: "column absolute", old: "column = dz === 0 ? column + ds : ds;", fresh: "column = ds;", catches: "decode" },
  { name: "column always relative", old: "column = dz === 0 ? column + ds : ds;", fresh: "column = column + ds;", catches: "decode" },
  { name: "rest as token", old: "i + 4 < data.length", fresh: "i < data.length", catches: "decode" },
  { name: "bits as number", old: "if (bits & (1 << b))", fresh: "if (bits & b)", catches: "decode" },
  { name: "foreign kind as variable", old: "legend.types[data[i + 3]] ?? \"\"", fresh: "legend.types[data[i + 3]] ?? \"variable\"", catches: "decode" },
  { name: "only the first dot", old: "rule.replace(/\\./g, \"-\")", fresh: "rule.replace(\".\", \"-\")", catches: "kind" },
  { name: "column +1", old: "Math.min(z.to, z.from + t.column)", fresh: "Math.min(z.to, z.from + t.column + 1)", catches: "spans" },
  { name: "overlap guard gone", old: "if (until <= from || from < last) continue;", fresh: "if (until <= from) continue;", catches: "spans" },
  { name: "line end not clipped", old: "until = Math.min(z.to, from + t.length);", fresh: "until = from + t.length;", catches: "spans" },
  { name: "row beyond the text", old: "if (t.row >= doc.lines || t.length <= 0) continue;", fresh: "if (t.length <= 0) continue;", catches: "spans" },
  { name: "without measurement 300", old: "without: 450", fresh: "without: 300", catches: "delay" },
  { name: "all measurements", old: "durations.slice(-SEMANTICS_TICK.window)", fresh: "durations.slice(0)", catches: "delay" },
  { name: "without upper bound", old: "Math.min(SEMANTICS_TICK.max, Math.max(SEMANTICS_TICK.min, cut))", fresh: "Math.max(SEMANTICS_TICK.min, cut)", catches: "delay" },
];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-semantics-"));
const src = path.join(tmp, "src"), out = path.join(tmp, "out");
fs.mkdirSync(src, { recursive: true });
fs.writeFileSync(path.join(src, "semantics.ts"), SOURCE);
const copies = SABOTAGES.map((s, i) => {
  const file = `semantics-sabotage-${i}.ts`;
  fs.writeFileSync(path.join(src, file), SOURCE.replace(s.old, () => s.fresh));
  return { ...s, file, places: SOURCE.split(s.old).length - 1 };
});
try {
  execFileSync(process.execPath, [tsc, ...fs.readdirSync(src).map((d) => path.join(src, d)), "--outDir", out, "--rootDir", src, "--module", "es2022", "--target", "es2022", "--strict", "--skipLibCheck"], { stdio: "pipe" });
} catch (e) {
  const text = `${String(e.stdout || "")}${String(e.stderr || "")}`;
  const realError = text.split("\n").filter((z) => /error TS\d+/.test(z) && !/-sabotage-\d+\.ts\(/.test(z));
  if (realError.length || !fs.existsSync(path.join(out, "semantics.js"))) throw new Error(`tsc: ${text}`.slice(0, 4000));
}
const load = (file) => import(pathToFileURL(path.join(out, file.replace(/\.ts$/, ".js"))).href);
const real = await load("semantics.ts");
const sabotaged = await Promise.all(copies.map(async (k) => ({ ...k, mod: await load(k.file) })));
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { console.warn("[test] temp directory was left behind:", String(e?.message || e).slice(0, 120)); }

/** The default rules in the order of their registration (tokenClassificationRegistry.ts, `registerTokenStyleDefault`). */
const REGISTRATION = [
  "comment", "string", "keyword", "number", "regexp", "operator", "namespace", "type", "struct", "class", "interface", "enum", "typeParameter",
  "function", "method", "macro", "variable", "parameter", "property", "enumMember", "event", "decorator", "variable.readonly", "property.readonly",
  "type.defaultLibrary", "class.defaultLibrary", "interface.defaultLibrary", "variable.defaultLibrary", "variable.defaultLibrary.readonly",
  "property.defaultLibrary", "property.defaultLibrary.readonly", "function.defaultLibrary", "member.defaultLibrary",
];
/** What one sees in VS Code (Dark Modern, Light Modern) -- samples, one per group. */
const SEEN = {
  "variable.readonly": ["#4fc1ff", "#0070c1"], "property.readonly": ["#4fc1ff", "#0070c1"], enumMember: ["#4fc1ff", "#0070c1"],
  function: ["#dcdcaa", "#795e26"], method: ["#dcdcaa", "#795e26"], "member.defaultLibrary": ["#dcdcaa", "#795e26"],
  class: ["#4ec9b0", "#267f99"], namespace: ["#4ec9b0", "#267f99"], typeParameter: ["#4ec9b0", "#267f99"], interface: ["#4ec9b0", "#267f99"],
  variable: ["#9cdcfe", "#001080"], parameter: ["#9cdcfe", "#001080"], property: ["#9cdcfe", "#001080"],
  macro: ["#569cd6", "#0000ff"], keyword: ["#c586c0", "#af00db"],
  "variable.defaultLibrary.readonly": [null, null], "property.defaultLibrary.readonly": [null, null],
};

const CHECKS = {
  rules(S) {
    assert.deepEqual(S.SEMANTICS_RULES.map(([sel]) => sel), REGISTRATION, "order of registration (tie: the later one)");
    const bySelector = Object.fromEntries(S.SEMANTICS_RULES.map(([sel, d, h]) => [sel, [d, h]]));
    for (const [sel, desired] of Object.entries(SEEN)) assert.deepEqual(bySelector[sel], desired, sel);
    // Without color means: in both themes (the class per rule builds on this; it does not depend on the mode).
    for (const [sel, d, h] of S.SEMANTICS_RULES) assert.equal(d === null, h === null, `${sel}: without color in one theme only`);
    for (const [sel, d, h] of S.SEMANTICS_RULES) for (const f of [d, h]) if (f !== null) assert.match(f, /^#[0-9a-f]{6}$/, `${sel}: ${f}`);
  },
  score(S) {
    const R = S.semanticsRule;
    assert.equal(R("variable", []), "variable");
    assert.equal(R("variable", ["declaration"]), "variable", "a modifier without a rule changes nothing");
    assert.equal(R("variable", ["readonly"]), "variable.readonly", "`const` like VS Code");
    assert.equal(R("variable", ["readonly", "declaration", "local"]), "variable.readonly");
    assert.equal(R("property", ["readonly"]), "property.readonly");
    assert.equal(R("variable", ["readonly", "defaultLibrary"]), "variable.defaultLibrary", "the rule without color does not count, tie: the later one");
    assert.equal(R("class", ["defaultLibrary"]), "class.defaultLibrary");
    assert.equal(R("member", []), "method", "supertype");
    assert.equal(R("member", ["defaultLibrary"]), "member.defaultLibrary");
    assert.equal(R("selfParameter", []), "parameter", "Python `self`");
    assert.equal(R("clsParameter", ["declaration"]), "parameter", "Python `cls`");
    assert.equal(R("unknown", ["readonly"]), null);
    assert.equal(R("", []), null);
  },
  color(S) {
    assert.equal(S.semanticsColor("variable", ["readonly"], true), "#4fc1ff");
    assert.equal(S.semanticsColor("variable", ["readonly"], false), "#0070c1");
    assert.equal(S.semanticsColor("function", [], false), "#795e26");
    assert.equal(S.semanticsColor("unknown", [], true), null);
  },
  decode(S) {
    const L = { types: ["variable", "function"], modifiers: ["declaration", "readonly"] };
    assert.deepEqual(S.decodeSemantics([0, 6, 4, 0, 3, 0, 5, 3, 1, 0, 2, 4, 1, 1, 2, 0, 3], L), [
      { row: 0, column: 6, length: 4, kind: "variable", modifiers: ["declaration", "readonly"] },
      { row: 0, column: 11, length: 3, kind: "function", modifiers: [] },
      { row: 2, column: 4, length: 1, kind: "function", modifiers: ["readonly"] },
    ], "column relative in the same row, absolute in a new one; the incomplete rest drops out");
    assert.deepEqual(S.decodeSemantics([0, 0, 2, 7, 8], L), [{ row: 0, column: 0, length: 2, kind: "", modifiers: [] }], "outside the legend: no kind, no modifier");
    assert.deepEqual(S.decodeSemantics([], L), []);
  },
  spans(S) {
    const L = { types: ["variable", "function"], modifiers: ["declaration", "readonly"] };
    // Against CodeMirror's Text, and every sequence must fit into a RangeSetBuilder (ascending -- otherwise it throws).
    const spans = (rows, data) => {
      const output = S.semanticsSpans(Text.of(rows), data, L);
      const b = new RangeSetBuilder();
      const value = new (class extends RangeValue {})();
      for (const x of output) b.add(x.from, x.until, value);
      b.finish();
      return output;
    };
    assert.deepEqual(spans(["const item = 1;", "f(item)", "x"], [0, 6, 4, 0, 2, 1, 0, 1, 1, 0, 0, 2, 4, 0, 0, 4, 0, 1, 0, 0]), [
      { from: 6, until: 10, rule: "variable.readonly" }, { from: 16, until: 17, rule: "function" }, { from: 18, until: 22, rule: "variable" },
    ], "row and column in offsets; a row beyond the text drops out");
    assert.deepEqual(spans(["ab", "cd"], [0, 1, 10, 0, 0, 0, 1, 1, 0, 0]), [{ from: 1, until: 2, rule: "variable" }], "clipped at the line end; what starts there is empty");
    assert.deepEqual(spans(["abcd"], [0, 0, 3, 0, 0, 0, 1, 1, 1, 0]), [{ from: 0, until: 3, rule: "variable" }], "starts in the previous one: drops out");
    assert.deepEqual(spans(["abcd"], [0, 0, 2, 5, 0, 0, 0, 0, 0, 0]), [], "without rule or without length: no span");
  },
  delay(S) {
    assert.deepEqual({ ...S.SEMANTICS_TICK }, { min: 300, max: 2000, window: 6, without: 450 });
    assert.equal(S.semanticsDelay([]), 450, "without measurement min * 1.5");
    assert.equal(S.semanticsDelay([100]), 300, "lower bound");
    assert.equal(S.semanticsDelay([5000]), 2000, "upper bound");
    assert.equal(S.semanticsDelay([400, 600]), 500, "average");
    assert.equal(S.semanticsDelay([10000, 10000, 400, 400, 400, 400, 400, 400]), 400, "only the last six");
  },
  kind(S) {
    assert.equal(S.semanticsClass("variable"), "cm-sem-variable");
    assert.equal(S.semanticsClass("variable.defaultLibrary.readonly"), "cm-sem-variable-defaultLibrary-readonly");
  },
};

test("(1) rules in the order of VS Code, colors from Dark/Light Modern", () => { CHECKS.rules(real); });
test("(1) score: kind, supertype, modifiers, tie, rules without color; color per mode", () => { CHECKS.score(real); CHECKS.color(real); });
test("(1) decode LSP tokens; class at the text", () => { CHECKS.decode(real); CHECKS.kind(real); });
test("(1) spans against CodeMirror's Text and RangeSetBuilder; the quiet period after a change like VS Code", () => { CHECKS.spans(real); CHECKS.delay(real); });
test("(1) counter-tests: every sabotage stands exactly once in the source and is caught by its check", () => {
  assert.deepEqual(copies.filter((k) => k.places !== 1).map((k) => `${k.name} (${k.places}x)`), [], "sabotages whose place does not stand exactly once in the source");
  const notCaught = sabotaged.filter((s) => { try { CHECKS[s.catches](s.mod); return true; } catch { return false; } }).map((s) => `${s.name} (${s.catches})`);
  assert.deepEqual(notCaught, [], "sabotages that no check catches");
  assert.deepEqual(Object.keys(CHECKS).filter((k) => !copies.some((s) => s.catches === k)), [], "checks without sabotage");
  console.log(`  [semantics] computation: ${Object.keys(CHECKS).length} checks, ${sabotaged.length} sabotages, each caught`);
});

// ── (2) The bindings ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
const B = {
  sem: read("src", "components", "code", "lsp-semantics.ts"),
  extension: read("src", "components", "code", "lsp-extension.ts"),
  status: read("src", "lib", "lsp-status.ts"),
};
const has = (text, place, what) => assert.ok(text.includes(place), `${what}: "${place.slice(0, 90)}" is missing`);

const BINDINGS = {
  install(s) {
    has(s.extension, "import { lspSemantics } from \"@/components/code/lsp-semantics\";", "Import");
    assert.match(s.extension, /lspDiagnostics, lspSemantics, lspSignature/, "lspSemantics in the list of language-service parts");
  },
  fetch(s) {
    has(s.sem, "if (!can(d, \"semantic_tokens\")) {", "only with the capability");
    has(s.sem, "r = await questions(d, \"semantic_tokens\", {}, ac.signal);", "the whole file, abortable");
    has(s.sem, "this.running?.abort(); // outdated", "every change aborts the running request");
    has(s.sem, "    this.plane(semanticsDelay(this.durations));\n  }\n  plane(", "... and asks again after the quiet period like VS Code");
    has(s.sem, "if (this.running) { this.again = true; return; }", "never two at once");
    has(s.sem, "if (!ac.signal.aborted && httpStatus(e) === 409) this.again = true;", "409 (also ServerCancelled): once more");
    has(s.sem, "this.durations = [...this.durations, performance.now() - begin].slice(-6);", "the duration of the requests counts");
    has(s.sem, "subscribeLspStatus(d.buffer.target, d.buffer.path, () => this.plane(0))", "at once when the server becomes ready");
    has(s.sem, "subscribeSemanticsRefresh(d.buffer.target, d.language, () => this.plane(0))", "at once when the server asks for new tokens");
    has(s.status, "if (evt?.language === language && lspEventAffects(evt, target, LSP_SEMANTICS_EVENT)) fn();", "only the request of this language and this target");
    has(s.sem, "if (v.state.doc !== doc) { this.plane(semanticsDelay(this.durations)); return; }", "an outdated answer is discarded");
    has(s.sem, "  plane(ms: number) {\n    if (this.destroyed) return;\n", "after destroy nothing is planned any more");
    has(s.sem, "if (this.destroyed || !v.dom.isConnected) return;", "... and asks nothing any more");
    has(s.sem, "return tr.docChanged ? d.map(tr.changes) : d;", "the marks move with the text");
    has(s.sem, "for (const s of semanticsSpans(doc, data, legend)) b.add(s.from, s.until, marker(s.rule));", "the spans from lib/semantics.ts");
  },
  colors(s) {
    has(s.sem, "[`&dark .cm-content .${k}, &dark .cm-content .${k} *`, { color: dark }],", "dark, more specific than the syntax coloring");
    has(s.sem, "[`&light .cm-content .${k}, &light .cm-content .${k} *`, { color: light }],", "light");
    has(s.sem, "if (!dark || !light) return [];", "a rule without color does not color");
  },
};
const B_SABOTAGES = [
  { name: "not built in", file: "extension", old: "lspDiagnostics, lspSemantics, lspSignature", fresh: "lspDiagnostics, lspSignature", catches: "install" },
  { name: "asked without capability", file: "sem", old: "if (!can(d, \"semantic_tokens\")) {", fresh: "if (!d) {", catches: "fetch" },
  { name: "every key asks", file: "sem", old: "    this.plane(semanticsDelay(this.durations));\n  }\n  plane(", fresh: "    this.plane(0);\n  }\n  plane(", catches: "fetch" },
  { name: "server ready, nobody asks", file: "sem", old: "subscribeLspStatus(d.buffer.target, d.buffer.path, () => this.plane(0))", fresh: "subscribeLspStatus(d.buffer.target, d.buffer.path, () => {})", catches: "fetch" },
  { name: "request for tokens without effect", file: "sem", old: "subscribeSemanticsRefresh(d.buffer.target, d.language, () => this.plane(0))", fresh: "subscribeSemanticsRefresh(d.buffer.target, d.language, () => {})", catches: "fetch" },
  { name: "request of any language", file: "status", old: "evt?.language === language && ", fresh: "", catches: "fetch" },
  { name: "outdated answer counts", file: "sem", old: "if (v.state.doc !== doc) { this.plane(semanticsDelay(this.durations)); return; }", fresh: "", catches: "fetch" },
  { name: "no abort", file: "sem", old: "this.running?.abort(); // outdated", fresh: "// outdated", catches: "fetch" },
  { name: "without signal", file: "sem", old: "questions(d, \"semantic_tokens\", {}, ac.signal)", fresh: "questions(d, \"semantic_tokens\", {})", catches: "fetch" },
  { name: "two at once", file: "sem", old: "if (this.running) { this.again = true; return; }", fresh: "", catches: "fetch" },
  { name: "409 forgotten", file: "sem", old: "if (!ac.signal.aborted && httpStatus(e) === 409) this.again = true;", fresh: "", catches: "fetch" },
  { name: "plans after destroy", file: "sem", old: "  plane(ms: number) {\n    if (this.destroyed) return;\n", fresh: "  plane(ms: number) {\n", catches: "fetch" },
  { name: "spans computed by itself", file: "sem", old: "for (const s of semanticsSpans(doc, data, legend))", fresh: "for (const s of [] as { from: number; until: number; rule: string }[])", catches: "fetch" },
  { name: "marks stay put", file: "sem", old: "return tr.docChanged ? d.map(tr.changes) : d;", fresh: "return d;", catches: "fetch" },
  { name: "light with dark colors", file: "sem", old: "&light .cm-content .${k} *`, { color: light }", fresh: "&light .cm-content .${k} *`, { color: dark }", catches: "colors" },
  { name: "weaker than the syntax coloring", file: "sem", old: "[`&dark .cm-content .${k}, &dark .cm-content .${k} *`,", fresh: "[`&dark .${k}`,", catches: "colors" },
];

test("(2) bindings: built in, asks only when able, colors per mode", () => {
  for (const [k, f] of Object.entries(BINDINGS)) { try { f(B); } catch (e) { throw new Error(`${k}: ${e.message}`); } }
});
test("(2) counter-tests of the bindings: every sabotage stands exactly once and is caught", () => {
  const stale = B_SABOTAGES.filter((x) => B[x.file].split(x.old).length - 1 !== 1).map((x) => `${x.name} (${B[x.file].split(x.old).length - 1}×)`);
  assert.deepEqual(stale, [], "sabotages whose place does not stand exactly once in the source");
  const notCaught = B_SABOTAGES.filter((x) => {
    const s = { ...B, [x.file]: B[x.file].replace(x.old, () => x.fresh) };
    try { BINDINGS[x.catches](s); return true; } catch { return false; }
  }).map((x) => `${x.name} (${x.catches})`);
  assert.deepEqual(notCaught, [], "sabotages that no check catches");
  assert.deepEqual(Object.keys(BINDINGS).filter((k) => !B_SABOTAGES.some((x) => x.catches === k)), [], "bindings without sabotage");
  console.log(`  [semantics] bindings: ${Object.keys(BINDINGS).length} checks, ${B_SABOTAGES.length} sabotages, each caught`);
});
