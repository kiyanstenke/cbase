// The rules of the workflow settings stand THREE times: in the server (server/backend/electron/server/workflows.js — the
// execution), in the web (src/lib/workflow-node-form.ts — node dialog, card chips) and on iOS (WorkflowRules.swift, bound in
// wfe-ios-binding.test.mjs). Here server ↔ web is bound through a MATRIX:
//
//   · rule 1 "checks effectively"      checksEffective(node, wf)      ↔ wantsDoneCheck(node, run)
//   · rule 2 "check cap continues"     checkCapContinue(node, wf)     ↔ doneCapAuto(node, run)
//   · rule 3 "round cap"               effectiveCaps(graph, 5, wf)    ↔ effectiveCap(graph, node, 5, run)
//                                       — cap AND auto AND from
//   · legacy data                      nodeModes(n) (web)             ↔ nodeModes(n) (server) ↔ normalizeGraph
//
// Why a matrix and not a handful of examples: the description side (chip "5×→", the checkmark on the card, "Like workflow
// (Continue)" in the dialog) and the execution side (driver, gates) must give the same answer — an example only checks the corner
// one thought of. The graphs: a chain, a cycle without a cap, a cycle with a cap, one with two equal givers, two connected
// cycles; the modes: every three-valued value, missing, legacy data (`doneCheck`/`capAuto`) and nonsense; plus every position of
// the workflow's three defaults.
//
// Also the data shape: the fields of `WorkflowRunSettings` (lib/api/workflows.ts) and of `EMPTY_RUN` in the editor == the keys of
// `normalizeRunSettings(null)` with defaults, the lock ranges of the modal == `LOCK_SCOPES`, the mode lists and the check-rounds
// limit.
//
// Both sides are REALLY executed: the server module directly (pure ESM, no imports), the web sheets compiled with the local tsc
// (built like workflow-node-form.test.mjs).
//
// Run:  node --test web/test/workflow-settings-binding.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as server from "../../server/backend/electron/server/workflows.js";
import * as autocompact from "../../server/backend/electron/server/autocompact.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");
const read = (rel) => fs.readFileSync(path.join(webDir, rel), "utf8");

const out = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-wfe-binding-"));
execFileSync(process.execPath, [
  tsc, path.join(webDir, "src", "lib", "workflow-node-form.ts"), path.join(webDir, "src", "lib", "workflow-settings.ts"),
  "--outDir", out, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler",
], { stdio: "pipe" });
const web = await import(pathToFileURL(path.join(out, "workflow-node-form.js")).href);
const wfe = await import(pathToFileURL(path.join(out, "workflow-settings.js")).href);
try { fs.rmSync(out, { recursive: true, force: true }); }
catch (e) { console.warn("[test] temp directory was left behind:", String(e?.message || e).slice(0, 120)); }

// If an export is missing this is a clear red sentence, not a link error that lets the whole file die without a word.
function need(...names) {
  for (const n of names) assert.ok(n in server, `workflows.js does not export "${n}" — part of the contract`);
}

// ── The matrix ──────────────────────────────────────────────────────────────────────────────

// The workflow's defaults: every position, plus "doneAll missing" (means on).
const WF = [];
for (const doneAll of [true, false, undefined]) {
  for (const doneCapAuto of [false, true]) {
    for (const loopCapAuto of [false, true]) {
      const wf = { doneCapAuto, loopCapAuto };
      if (doneAll !== undefined) wf.doneAll = doneAll;
      WF.push(wf);
    }
  }
}
// A node mode as a raw field bundle: new, missing, legacy data, nonsense.
const DONE_VARIANTS = [{}, { doneMode: "inherit" }, { doneMode: "on" }, { doneMode: "off" }, { doneMode: "bogus" },
  { doneCheck: true }, { doneCheck: false }, { doneCheck: true, doneMode: "off" }];
const CAP_VARIANTS = (field) => [{}, { [field]: "inherit" }, { [field]: "ask" }, { [field]: "continue" }, { [field]: 7 }, { capAuto: true }, { capAuto: false }];
const TYPES = ["instruction", "parallel", "condition", "ask", "review", "loop", "start", "end"];

const normNode = (raw) => server.normalizeGraph({ nodes: [raw], edges: [] }).nodes[0];
const runItem = (wf) => server.normalizeRunSettings(wf);
const short = (o) => JSON.stringify(o);

test("the mode lists and the check-rounds limit are the same", () => {
  need("DONE_MODES", "CAP_MODES", "DONE_ROUNDS_DEFAULT", "DONE_ROUNDS_MAX", "LOCK_SCOPES");
  assert.deepEqual([...web.DONE_MODES], [...server.DONE_MODES], "DONE_MODES web ≠ server");
  assert.deepEqual([...web.CAP_MODES], [...server.CAP_MODES], "CAP_MODES web ≠ server");
  assert.equal(server.DONE_ROUNDS_DEFAULT, 3);
  assert.deepEqual(wfe.checkRoundsChoice(server.DONE_ROUNDS_MAX), Array.from({ length: server.DONE_ROUNDS_MAX }, (_, i) => i + 1), "the check-rounds choice does not reach exactly up to DONE_ROUNDS_MAX");
  assert.deepEqual([...wfe.LOCK_AREAS], [...server.LOCK_SCOPES], "the modal's lock ranges ≠ the server's LOCK_SCOPES");
  // The fallback stages of the compaction slider (Autocompact.tsx, until the server answers) == the server's stages — else the
  // "Context" tab would briefly offer a number the PUT rejects.
  const source = read("src/components/Autocompact.tsx");
  const stages = source.match(/^export const STAGES_FALLBACK = \[([^\]]*)\];$/m);
  assert.ok(stages, "STAGES_FALLBACK in Autocompact.tsx not in the known form — update the anchor");
  assert.deepEqual(stages[1].split(",").map((x) => Number(x.trim())), [...autocompact.STAGES], "STAGES_FALLBACK ≠ autocompact.STAGES");
  assert.match(source, /^export const MAX_FALLBACK = Array\.from\(\{ length: 20 \}, \(_, i\) => \(i \+ 1\) \* 50_000\);$/m, "MAX_FALLBACK not in the known form");
  assert.deepEqual(Array.from({ length: 20 }, (_, i) => (i + 1) * 50_000), [...autocompact.MAX_STAGES], "MAX_FALLBACK ≠ autocompact.MAX_STAGES");
});

test("run settings: WorkflowRunSettings, EMPTY_RUN and normalizeRunSettings(null) carry the same fields with the same defaults", () => {
  need("normalizeRunSettings");
  const preset = server.normalizeRunSettings(null);
  // The type (lib/api/workflows.ts): every line `name: …;` in the interface block.
  const api = read("src/lib/api/workflows.ts");
  const block = api.match(/export interface WorkflowRunSettings \{([\s\S]*?)\n\}/);
  assert.ok(block, "`export interface WorkflowRunSettings { … }` not found — update the anchor");
  const typeFields = [...block[1].matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]);
  assert.deepEqual([...typeFields].sort(), Object.keys(preset).sort(), "WorkflowRunSettings (web type) ≠ fields of normalizeRunSettings — a field the server drops would come back with 200 and without effect");
  // EMPTY_RUN in the editor: the state before the server answers, and the template of every loaded `run`.
  const editor = read("src/components/workflow/WorkflowEditor.tsx");
  const empty = editor.match(/^const EMPTY_RUN: WorkflowRunSettings = (\{[\s\S]*?\});$/m);
  assert.ok(empty, "EMPTY_RUN in WorkflowEditor.tsx not found — update the anchor");
  const emptyRun = new Function(`return (${empty[1]});`)();
  assert.deepEqual(emptyRun, preset, "EMPTY_RUN ≠ normalizeRunSettings(null): the editor would show other values for a fresh workflow than the server stores");
  console.log(`  [run] ${Object.keys(preset).length} fields · doneAll ${preset.doneAll} · doneRounds ${preset.doneRounds} · autocompact ${preset.autocompact}/${preset.autocompactMax}`);
});

// iOS (Models/WorkflowModels.swift) and the UI-test fixture (mobile/test-fixtures/chat-gateway/state.mjs) carry the same fields.
// The SOURCE is read, not executed — there is no Swift on Linux, and the field list is a list, not a computation. iOS threefold:
// stored property, CodingKey and `encode` (there is no synthesized Encodable any more — a field without an `encode` line would
// never reach the server from the iPhone, and without a CodingKey it does not even build).
test("run settings: iOS (property, CodingKey, encode) and the UI-test fixture carry the same fields as the server", () => {
  const fields = Object.keys(server.normalizeRunSettings(null)).sort();
  const swift = fs.readFileSync(path.resolve(webDir, "..", "mobile", "CbaseMobile", "Models", "WorkflowModels.swift"), "utf8");
  const block = swift.match(/struct WorkflowRunSettings: Codable[^{]*\{([\s\S]*?)\n\}/);
  assert.ok(block, "`struct WorkflowRunSettings` in WorkflowModels.swift not found — update the anchor");
  // Stored properties carry a default (`= …`); `var rule: … {` is computed and does not count.
  const properties = [...block[1].matchAll(/^ {4}var (\w+): [^\n{]*=/gm)].map((m) => m[1]).sort();
  assert.deepEqual(properties, fields, "iOS WorkflowRunSettings (properties) ≠ normalizeRunSettings — a field is missing on one side");
  const keys = block[1].match(/enum CodingKeys: String, CodingKey \{([\s\S]*?)\n {4}\}/);
  assert.ok(keys, "CodingKeys of WorkflowRunSettings not found");
  const key = [...keys[1].matchAll(/case ([^\n]+)/g)].flatMap((m) => m[1].split(",").map((x) => x.trim())).filter(Boolean).sort();
  assert.deepEqual(key, fields, "iOS CodingKeys ≠ normalizeRunSettings");
  const encode = block[1].match(/func encode\(to encoder: Encoder\) throws \{([\s\S]*?)\n {4}\}/);
  assert.ok(encode, "encode(to:) of WorkflowRunSettings not found");
  const written = [...new Set([...encode[1].matchAll(/forKey: \.(\w+)\)/g)].map((m) => m[1]))].sort();
  assert.deepEqual(written, fields, "iOS encode(to:) does not write exactly the server's fields");
  // The fixture: `emptyRun()` is the default, `runOf` the normalization — both must carry all fields.
  const fixture = fs.readFileSync(path.resolve(webDir, "..", "mobile", "test-fixtures", "chat-gateway", "state.mjs"), "utf8");
  const empty = fixture.match(/^const emptyRun = \(\) => (\(\{[\s\S]*?\}\));$/m);
  assert.ok(empty, "`const emptyRun = () => ({ … });` not found in the fixture — update the anchor");
  const emptyRun = new Function(`return ${empty[1]};`)();
  assert.deepEqual(emptyRun, server.normalizeRunSettings(null), "emptyRun() in the fixture ≠ normalizeRunSettings(null)");
  const runOf = fixture.match(/^const runOf = \(raw\) => \{([\s\S]*?)\n\};$/m);
  assert.ok(runOf, "`const runOf = (raw) => { … };` not found in the fixture");
  for (const f of fields.filter((f) => !["provider", "model", "permissionMode", "effort", "doneProvider", "doneModel"].includes(f))) {
    assert.match(runOf[1], new RegExp(`^\\s+${f}:`, "m"), `runOf in the fixture does not normalize "${f}" — the PUT would lose it`);
  }
  console.log(`  [run iOS/fixture] ${fields.length} fields`);
});

test("legacy data: nodeModes (web) == nodeModes (server) == the fields from normalizeGraph — and doneCheck/capAuto do not leave the server", () => {
  need("nodeModes", "normalizeGraph");
  let n = 0;
  for (const d of DONE_VARIANTS) {
    for (const c of CAP_VARIANTS("doneCapMode")) {
      for (const l of CAP_VARIANTS("loopCapMode")) {
        const raw = { id: "a", type: "instruction", title: "A", ...d, ...c, ...l };
        const w = web.nodeModes(raw);
        assert.deepEqual(w, server.nodeModes(raw), `nodeModes web ≠ server for ${short(raw)}`);
        const norm = normNode(raw);
        assert.deepEqual({ doneMode: norm.doneMode, doneCapMode: norm.doneCapMode, loopCapMode: norm.loopCapMode }, w, `normalizeGraph writes other modes than nodeModes for ${short(raw)}`);
        assert.ok(!("doneCheck" in norm) && !("capAuto" in norm), `normalizeGraph still outputs the legacy fields (${short(raw)})`);
        assert.deepEqual(web.nodeModes(norm), w, "the normalized node reads the same in the web");
        n++;
      }
    }
  }
  console.log(`  [nodeModes] ${n} raw nodes`);
});

test("rules 1 and 2: checksEffective ↔ wantsDoneCheck, checkCapContinue ↔ doneCapAuto — type × mode × workflow", () => {
  need("wantsDoneCheck", "doneCapAuto", "normalizeGraph", "normalizeRunSettings");
  let n = 0;
  for (const type of TYPES) {
    for (const d of DONE_VARIANTS) {
      for (const c of CAP_VARIANTS("doneCapMode")) {
        const raw = { id: "a", type, title: "A", ...d, ...c };
        const norm = normNode(raw);
        for (const wf of WF) {
          const run = runItem(wf);
          const s1 = server.wantsDoneCheck(norm, run);
          assert.equal(web.checksEffective(raw, wf), s1, `rule 1 raw: web ≠ server for ${short(raw)} with ${short(wf)}`);
          assert.equal(web.checksEffective(norm, wf), s1, `rule 1 normalized: web ≠ server for ${short(raw)} with ${short(wf)}`);
          const s2 = server.doneCapAuto(norm, run);
          assert.equal(web.checkCapContinue(raw, wf), s2, `rule 2 raw: web ≠ server for ${short(raw)} with ${short(wf)}`);
          assert.equal(web.checkCapContinue(norm, wf), s2, `rule 2 normalized: web ≠ server for ${short(raw)} with ${short(wf)}`);
          n++;
        }
      }
    }
  }
  // The statement itself, not just equality: without a default (run_settings = {}) an untouched instruction checks, and a node
  // "off" beats the workflow.
  assert.equal(server.wantsDoneCheck(normNode({ id: "a", type: "instruction" }), runItem({})), true, "run_settings = {} checks every working step");
  assert.equal(server.wantsDoneCheck(normNode({ id: "a", type: "instruction", doneMode: "off" }), runItem({})), false);
  console.log(`  [rule 1/2] ${n} cases`);
});

// Graphs: edges as "a>b". Cycles with an entry and an exit, so that the group is not the whole graph.
const G = (nodes, edges) => ({ nodes, edges: edges.map((s) => { const [from, to] = s.split(">"); return { from, to }; }) });
const K = (id, extra = {}) => ({ id, type: "instruction", title: id.toUpperCase(), ...extra });
const GRAPHS = [
  ["Chain", G([K("s", { type: "start" }), K("a"), K("b"), K("e", { type: "end" })], ["s>a", "a>b", "b>e"]), ["a", "b"]],
  ["cycle without cap", G([K("x", { type: "start" }), K("a"), K("b"), K("c"), K("e", { type: "end" })], ["x>a", "a>b", "b>c", "c>a", "c>e"]), ["a", "b", "c"]],
  ["cycle with cap", G([K("x", { type: "start" }), K("a"), K("b", { maxVisits: 7, title: "Check" }), K("c"), K("e", { type: "end" })], ["x>a", "a>b", "b>c", "c>a", "c>e"]), ["a", "b", "c"]],
  ["cycle with two givers", G([K("a", { maxVisits: 6 }), K("b", { maxVisits: 6 }), K("c"), K("e", { type: "end" })], ["a>b", "b>c", "c>a", "b>e"]), ["a", "b", "c"]],
  ["two cycles", G([K("a"), K("b"), K("c"), K("d", { maxVisits: 4 }), K("e", { type: "end" })], ["a>b", "b>a", "b>c", "c>d", "d>c", "d>e"]), ["a", "b", "c", "d"]],
];
const LOOP_VARIANTS = [{}, { loopCapMode: "inherit" }, { loopCapMode: "ask" }, { loopCapMode: "continue" }, { capAuto: true }];

test("rule 3: effectiveCaps (web) ↔ effectiveCap (server) — cap, auto and from over graphs × modes × workflow", () => {
  need("effectiveCap", "normalizeGraph", "normalizeRunSettings");
  let n = 0;
  for (const [name, base, variable] of GRAPHS) {
    // Every occupancy of the variable nodes with every mode (5^k, k ≤ 4).
    const occupancies = variable.reduce((acc) => acc.flatMap((b) => LOOP_VARIANTS.map((v) => [...b, v])), [[]]);
    for (const occupancy of occupancies) {
      const raw = { nodes: base.nodes.map((k) => { const i = variable.indexOf(k.id); return i < 0 ? k : { ...k, ...occupancy[i] }; }), edges: base.edges };
      const norm = server.normalizeGraph(raw);
      for (const loopCapAuto of [false, true]) {
        const wf = { loopCapAuto };
        const run = runItem(wf);
        const w = web.effectiveCaps(raw, 5, wf);
        for (const k of norm.nodes) {
          const s = server.effectiveCap(norm, k, 5, run);
          const desired = { cap: s.cap, auto: s.auto, from: s.from ? (s.from.title || s.from.id) : "" };
          assert.deepEqual(w.get(k.id), desired, `${name} · node ${k.id} · ${short(occupancy)} · loopCapAuto ${loopCapAuto}: web ≠ server`);
          n++;
        }
        // The client sees the NORMALIZED graph (after loading) — the same answer.
        const wn = web.effectiveCaps(norm, 5, wf);
        for (const k of norm.nodes) assert.deepEqual(wn.get(k.id), w.get(k.id), `${name} · ${k.id}: the web reads the normalized graph differently from the raw one`);
      }
    }
  }
  console.log(`  [rule 3] ${n} comparisons over ${GRAPHS.length} graphs`);
});

test("visibility: the rows \"At the check cap\" and \"Scale\" appear exactly where the server checks", () => {
  need("wantsDoneCheck", "normalizeGraph", "normalizeRunSettings");
  for (const type of TYPES) {
    for (const d of DONE_VARIANTS) {
      for (const wf of WF) {
        const raw = { id: "a", type, title: "A", ...d };
        const z = web.rowsFor(new Set(), raw, wf);
        const checks = server.wantsDoneCheck(normNode(raw), runItem(wf));
        assert.equal(z.doneCap, checks, `check-cap row ≠ server for ${short(raw)} with ${short(wf)}`);
        assert.equal(z.scale, checks, `scale row ≠ server for ${short(raw)} with ${short(wf)}`);
      }
    }
  }
});
