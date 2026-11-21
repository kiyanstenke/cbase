// The iOS effort computation, bound to the real Swift source.
//
// `web/test/effort.test.mjs` reads from `Models.swift` ONLY `static let preset` (one row, by regex). Everything iOS COMPUTES with the levels
// hung on nothing: turning `EffortLevels.fallback` from `carried.last` to `carried.first` — the promise inverted, the lowest instead of the
// highest level — left every other test green, and nobody would have seen it: the picker shows a level, just the wrong one.
//
// So the COMPUTATION is bound, not its spelling: the block `enum EffortLevels` is cut out of `Models.swift`, assembled with stubs
// (Provider, ProviderModel, L) into a program and REALLY EXECUTED with `xcrun swift` — against the same pairs `effort.test.mjs` runs for
// the web, and against the same source of truth: `effortFallback` from workflows.js and the two real clamps (`codexEffortFallback`,
// `mapClaudeEffort`).
//
// THE RULE that hangs here (workflows.js:effortFallback): the highest carried level that is NOT ABOVE the requested one; if none lies below,
// the lowest carried one. Clamping goes DOWN, never up — one level more costs thinking tokens against the subscription limit.
//
// Files are read BY PATH — whoever moves one of them updates the line here.
//
// Run:  node --test web/test/effort-ios.test.mjs
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { CODEX_MODELS, codexEffortFallback } from "../../server/backend/electron/server/providers/connectors/codex.js";
import { CLAUDE_MODELS, mapClaudeEffort } from "../../server/backend/electron/server/providers/connectors/claude.js";
import { EFFORT_LEVELS, effortFallback } from "../../server/backend/electron/server/workflows.js";
// The Codex model WITHOUT max: a test model entered into the server catalog for the whole file, BEFORE the cases below are built
// (gaps-model.mjs).
import { GAP, enterGapsModel } from "../../server/backend/test/gaps-model.mjs";
after(enterGapsModel());

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const SOURCE_IOS = path.join(repo, "mobile", "CbaseMobile", "Models", "Models.swift");
// The run settings of the workflow live in the settings sheet — provider/model/effort under "Execution", the review model under
// "Caps & review".
const SOURCE_WORKFLOW_EDITOR = path.join(repo, "mobile", "CbaseMobile", "Workflows", "WorkflowSettings.swift");
const SOURCE_CHAT_SHEETS = path.join(repo, "mobile", "CbaseMobile", "Chat", "ChatSheets.swift");
const SOURCE_WORKSPACE_VIEWS = path.join(repo, "mobile", "CbaseMobile", "Chat", "WorkspaceViews.swift");
// The "New chat" sheet does not create the chat itself: "Start" opens a draft with the choice, the first message creates it.
const SOURCE_CHAT_VM = path.join(repo, "mobile", "CbaseMobile", "Chat", "ChatViewModel.swift");
const SOURCE_CHAT_SERVER = path.join(repo, "mobile", "CbaseMobile", "Chat", "ChatViewModel+Server.swift");
// The building block of the pickers.
const SOURCE_KIT_EFFORT = path.join(repo, "mobile", "CbaseMobile", "Kit", "EffortSelection.swift");

// ── Cutting the block out of the source ──────────────────────────────────────────────────────────
// No re-implementation, no translation: what runs here are the lines that run on the iPhone too.
// Counting brackets would be effort without gain — the type is at top level, so its closing bracket is the first `}` in column 0.
function swiftBlock(source, header) {
  const rows = fs.readFileSync(source, "utf8").split("\n");
  const start = rows.findIndex((z) => z.startsWith(header));
  assert.ok(start >= 0, `"${header}" is no longer in ${path.basename(source)} — moved or renamed? Then update this line.`);
  const end = rows.findIndex((z, i) => i > start && z === "}");
  assert.ok(end > start, `the closing bracket of "${header}" is not in column 0`);
  return rows.slice(start, end + 1).join("\n");
}

// The stubs: exactly the touch points `EffortLevels` has to the outside. `L` replaces `{name}` by the parameter like the original
// (Kit/Localization.swift) — the key is at the same time the text.
const STUBS = `import Foundation

struct ProviderModel { let id: String; let efforts: [String]? }
struct ProviderCaps { let effort: Bool }
struct Provider { let id: String; let models: [ProviderModel]; let defaultModel: String?; var caps: ProviderCaps? = nil; var defaultEffort: String? = nil }
// In the app the building block is a SwiftUI view; here only its computation counts (the extension below) —
// SwiftUI itself does not run in \`swift\` script mode (measured: "Symbols not found" at JIT).
struct EffortSelection {}
func L(_ key: String) -> String { key }
func L(_ key: String, _ params: [String: CustomStringConvertible]) -> String {
    var s = key
    for (k, v) in params { s = s.replacingOccurrences(of: "{" + k + "}", with: v.description) }
    return s
}
`;

const swiftLit = (s) => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
// `null`/`undefined` = the field is missing (`nil`), `[]` = no levels.
const swiftList = (xs) => (xs == null ? "nil" : `[${xs.map(swiftLit).join(", ")}]`);

// All cases in ONE run: `swift` in script mode compiles afresh every time (≈ 3 s cold), and one call per pair would be over two minutes
// for a computation without state.
let tmp = null;
let measured = null;
function runIos(cases) {
  if (measured) return measured;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-effort-ios-"));
  const file = path.join(tmp, "effort.swift");
  const rows = cases.map((f) => `    (${swiftLit(f.name)}, ${swiftList(f.efforts)}, ${swiftLit(f.model)}, ${swiftLit(f.set)}),`);
  fs.writeFileSync(file, `${STUBS}
${swiftBlock(SOURCE_IOS, "enum EffortLevels {")}

${swiftBlock(SOURCE_KIT_EFFORT, "extension EffortSelection {")}

let cases: [(String, [String]?, String, String)] = [
${rows.join("\n")}
]

for (name, efforts, model, set) in cases {
    let providers = [Provider(id: "p", models: [ProviderModel(id: "m", efforts: efforts)], defaultModel: "m")]
    let fallback = EffortLevels.fallback(providers, provider: "p", model: model, set: set)
    let levels = EffortLevels.levels(providers, provider: "p", model: model).joined(separator: ",")
    let selection = EffortLevels.selection(providers, provider: "p", model: model, current: set)
        .map { "\\($0.id)|\\($0.label)" }.joined(separator: ";")
    let buildingBlock = EffortSelection.entries(providers, provider: "p", model: model, current: set, empty: "Empty-Word")
        .map { "\\($0.id)|\\($0.label)" }.joined(separator: ";")
    let no = EffortLevels.noLevels(providers, provider: "p", model: model) ? "yes" : "no"
    // "Default · <level>" — the case's set value as the provider's default level.
    let withDefault = [Provider(id: "p", models: [ProviderModel(id: "m", efforts: efforts)], defaultModel: "m", defaultEffort: set)]
    let standardLabel = EffortLevels.standardLabel(withDefault, provider: "p", model: model)
    // "Default (global)" — empty provider, computed with the globally active one.
    let standardGlobal = EffortLevels.standardLabel(withDefault, provider: "", model: model, active: "p")
    // The run level of a workflow — "As the chat · new: <level>", the same computation.
    let standardChat = EffortLevels.standardLabel(withDefault, provider: "", model: model, active: "p", asChat: true)
    print("F\\t\\(name)\\t\\(fallback)\\t\\(levels)\\t\\(selection)\\t\\(buildingBlock)\\t\\(no)\\t\\(standardLabel)\\t\\(standardGlobal)\\t\\(standardChat)")
}
// The picker decision ("withoutSelection"/"shows") and the resolved provider, case by case.
let pickerCases: [(String, Bool?, [String]?, String, String, String)] = [
${PICKER_CASES.map((f) => `    (${swiftLit(f.name)}, ${f.caps == null ? "nil" : String(f.caps)}, ${swiftList(f.efforts)}, ${swiftLit(f.model)}, ${swiftLit(f.provider)}, ${swiftLit(f.active)}),`).join("\n")}
]
for (name, caps, efforts, model, provider, active) in pickerCases {
    let providers = [
        Provider(id: "p", models: [ProviderModel(id: "m", efforts: efforts)], defaultModel: "m", caps: caps.map { ProviderCaps(effort: $0) }),
        Provider(id: "q", models: [ProviderModel(id: "m", efforts: ["low"])], defaultModel: "m"),
    ]
    let without = EffortLevels.withoutSelection(providers, provider: provider, model: model, active: active)
    let shows = EffortSelection.shows(providers, provider: provider, model: model, active: active) ? "yes" : "no"
    let entries = EffortSelection.entries(providers, provider: provider, model: model, current: "max", empty: "Empty-Word", active: active)
        .map { "\\($0.id)|\\($0.label)" }.joined(separator: ";")
    // Without an empty entry (empty: nil, the two chat places).
    let withoutEmpty = EffortSelection.entries(providers, provider: provider, model: model, current: "max", empty: nil, active: active)
        .map { "\\($0.id)|\\($0.label)" }.joined(separator: ";")
    print("P\\t\\(name)\\t\\(without)\\t\\(shows)\\t\\(entries)\\t\\(EffortLevels.withoutSelectionText(without))\\t\\(withoutEmpty)")
}
print("STAGES\\t" + EffortLevels.stages.joined(separator: ","))
print("PRESET\\t" + EffortLevels.preset.joined(separator: ","))
`);
  // `xcrun swift` instead of a fixed path: the toolchain may live under /Applications/Xcode.app on one Mac and with the Command Line
  // Tools on another. If it is missing, the test fails LOUDLY — a silent skip would count as passed for the gate.
  let output;
  try {
    output = execFileSync("xcrun", ["swift", file], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    assert.fail(`the Swift source could not be executed (xcrun swift): ${e.stderr || e.message}`);
  }
  const rowsFrom = output.split("\n").filter(Boolean);
  const result = { fallback: new Map(), levels: new Map(), selection: new Map(), buildingBlock: new Map(), no: new Map(), standardLabel: new Map(), standardGlobal: new Map(), standardChat: new Map(), picker: new Map(), stages: [], preset: [] };
  for (const z of rowsFrom) {
    const t = z.split("\t");
    if (t[0] === "F") {
      result.fallback.set(t[1], t[2] ?? "");
      result.levels.set(t[1], (t[3] ?? "").split(",").filter(Boolean));
      result.selection.set(t[1], (t[4] ?? "").split(";").filter(Boolean));
      result.buildingBlock.set(t[1], (t[5] ?? "").split(";").filter(Boolean));
      result.no.set(t[1], t[6] === "yes");
      result.standardLabel.set(t[1], t[7] ?? "");
      result.standardGlobal.set(t[1], t[8] ?? "");
      result.standardChat.set(t[1], t[9] ?? "");
    } else if (t[0] === "P") {
      result.picker.set(t[1], { without: t[2] ?? "", shows: t[3] === "yes", entries: (t[4] ?? "").split(";").filter(Boolean), text: t[5] ?? "", withoutEmpty: (t[6] ?? "").split(";").filter(Boolean) });
    } else if (t[0] === "STAGES") result.stages = t[1].split(",").filter(Boolean);
    else if (t[0] === "PRESET") result.preset = t[1].split(",").filter(Boolean);
  }
  assert.equal(result.fallback.size, cases.length, `the Swift side answered ${result.fallback.size} of ${cases.length} cases`);
  measured = result;
  return result;
}
after(() => { try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* cleaning up says nothing about the product */ } });

// The picker decision, web ↔ iOS. The catalog has two providers: "p" (caps and efforts per case) and "q" (without caps, one model with
// only "low"). `provider: ""` + `active` is "Default (global)" or an old chat without a provider — computed with the globally active one.
const PICKER_CASES = [
  { name: "supported", caps: true, efforts: ["low", "high"], model: "m", provider: "p", active: "" },
  { name: "caps-missing", caps: null, efforts: ["low", "high"], model: "m", provider: "p", active: "" },
  { name: "caps-off", caps: false, efforts: ["low", "high"], model: "m", provider: "p", active: "" },
  { name: "caps-from-unknown-model", caps: false, efforts: null, model: "foreign", provider: "p", active: "" },
  { name: "no-levels", caps: true, efforts: [], model: "m", provider: "p", active: "" },
  { name: "no-levels-default-model", caps: true, efforts: [], model: "", provider: "p", active: "" },
  { name: "unknown-model", caps: true, efforts: ["low"], model: "foreign", provider: "p", active: "" },
  { name: "efforts-missing", caps: true, efforts: null, model: "m", provider: "p", active: "" },
  { name: "global:carried", caps: true, efforts: ["low", "high"], model: "", provider: "", active: "p" },
  { name: "global:caps-off", caps: false, efforts: ["low", "high"], model: "", provider: "", active: "p" },
  { name: "global:no-levels", caps: true, efforts: [], model: "", provider: "", active: "p" },
  { name: "global:unknown", caps: true, efforts: ["low", "high"], model: "", provider: "", active: "" },
  { name: "set-beats-global", caps: false, efforts: [], model: "", provider: "q", active: "p" },
];

// The cases: first the pairs the web guard runs too (every Codex model × every level, plus a Claude model WITHOUT `efforts` = unknown, and
// every Claude model of the catalog with ITS list, Haiku 4.5 empty), then the named corners of the rule.
const CLAUDE_WITHOUT_EFFORTS = null;
const cases = [];
for (const mo of CODEX_MODELS) for (const level of EFFORT_LEVELS) cases.push({ name: `codex:${mo.id}:${level}`, efforts: [...mo.efforts], model: "m", set: level });
for (const level of EFFORT_LEVELS) cases.push({ name: `claude:${level}`, efforts: CLAUDE_WITHOUT_EFFORTS, model: "m", set: level });
for (const mo of CLAUDE_MODELS) for (const level of EFFORT_LEVELS) cases.push({ name: `claude:${mo.id}:${level}`, efforts: mo.efforts, model: "m", set: level });
const CORNERS = [
  // By name: a HOLE in the middle of the list. The level above it would lie ABOVE the request and cost tokens nobody ordered. (With
  // only five levels the hole is at xhigh.)
  { name: "loch:xhigh", efforts: ["low", "medium", "high", "max"], model: "m", set: "xhigh" },
  // The second half of the rule: if nothing lies BELOW the request, the lowest carried one applies.
  { name: "nothing-below", efforts: ["xhigh", "max"], model: "m", set: "low" },
  // The catalog list is a SET — nobody promised it is written in ascending order.
  { name: "unsorted", efforts: ["high", "low", "xhigh"], model: "m", set: "max" },
  // The case above NAMES the promise but does not measure it: it gives "xhigh" with and without ordering. This one turns (without
  // `sorted()` it would give "medium") — and it is the realistic move: someone measures a level and appends it at the BACK of `efforts`.
  { name: "unsorted-transposition", efforts: ["low", "xhigh", "medium"], model: "m", set: "max" },
  { name: "capitalized", efforts: ["low", "medium", "high", "xhigh"], model: "m", set: "MAX" },
  // "Auto" and something that is no level at all: neither is a flag, the same everywhere.
  { name: "auto", efforts: ["low", "medium", "high", "xhigh"], model: "m", set: "" },
  { name: "no-level", efforts: ["low", "medium", "high", "xhigh"], model: "m", set: "turbo" },
  // The removed sixth level (as a stored old value a migration would have missed) and Codex' two lower steps that no selection offers:
  // NO level — the last two even if a catalog (wrongly) listed them.
  { name: "ultra-no-level", efforts: ["low", "medium", "high", "xhigh", "max"], model: "m", set: "ultra" },
  { name: "none-no-level", efforts: ["none", "minimal", "low", "medium", "high"], model: "m", set: "none" },
  { name: "minimal-no-level", efforts: ["none", "minimal", "low", "medium", "high"], model: "m", set: "minimal" },
  // An EMPTY model is the provider default, not "unknown" (`defaultModel` from /api/providers).
  { name: "empty-model", efforts: ["low", "medium", "high", "xhigh"], model: "", set: "max" },
  // Empty is not missing. Empty = no levels (no level, no picker), missing = unknown (pass through).
  { name: "empty:max", efforts: [], model: "m", set: "max" },
  { name: "empty:low", efforts: [], model: "m", set: "low" },
  { name: "empty:auto", efforts: [], model: "m", set: "" },
  { name: "missing:max", efforts: null, model: "m", set: "max" },
  { name: "missing:low", efforts: null, model: "m", set: "low" },
  { name: "empty:standard", efforts: [], model: "", set: "high" },
];
cases.push(...CORNERS);
const ios = () => runIos(cases);

test("the ORDER stands once: EffortLevels.stages == EFFORT_LEVELS (server)", () => {
  // Not by regex on the declaration, but what the computation really ran with.
  assert.deepEqual(ios().stages, [...EFFORT_LEVELS], "the iOS order differs from the server's — then the iPhone clamps differently from the spawn");
  // Order and fallback are identical character by character — and still stay two lists with two jobs (the order says what "higher"
  // means; the fallback, what a model without measurement carries).
  assert.deepEqual(ios().stages, ["low", "medium", "high", "xhigh", "max"], "the list of five");
  assert.deepEqual(ios().preset, ["low", "medium", "high", "xhigh", "max"], "the fallback");
  for (const gone of ["ultra", "none", "minimal"]) {
    assert.ok(!ios().stages.includes(gone) && !ios().preset.includes(gone), `"${gone}" is in no iOS list`);
  }
});

test("the substitute is ONE notion: iOS computes the same pair by pair as the Codex clamp", () => {
  const r = ios();
  let pairs = 0;
  for (const mo of CODEX_MODELS) {
    for (const level of EFFORT_LEVELS) {
      const measured = r.fallback.get(`codex:${mo.id}:${level}`);
      assert.equal(measured, codexEffortFallback(level, mo.id), `${mo.id} + ${level}: iPhone and spawn name different levels`);
      // And the rule itself, independent of the second version: never ABOVE the request.
      assert.ok(EFFORT_LEVELS.indexOf(measured) <= EFFORT_LEVELS.indexOf(level),
        `${mo.id} + ${level}: the substitute "${measured}" lies ABOVE the request — one level more costs thinking tokens against the limit`);
      assert.ok([...mo.efforts].includes(measured), `${mo.id} + ${level}: this model does not carry "${measured}" at all`);
      pairs++;
    }
  }
  assert.ok(pairs >= 30, `${pairs} pairs checked`);
  // By name — otherwise the next rework optimises it away.
  assert.equal(r.fallback.get(`codex:${GAP}:max`), "xhigh", "model without max + max ⇒ xhigh (the substitute never lies above the request)");
});

test("the substitute is ONE notion: against the Claude clamp too, level by level — per model", () => {
  const r = ios();
  // A Claude model WITHOUT `efforts` (outside the catalog): iOS falls back to `EffortLevels.preset`, which is byte-identical to
  // `CLAUDE_EFFORTS` (effort.test.mjs holds it); the spawn passes it through — the same answer.
  for (const level of EFFORT_LEVELS) {
    assert.equal(r.fallback.get(`claude:${level}`), mapClaudeEffort(level), `claude + ${level}: iPhone and spawn name different levels`);
  }
  assert.equal(r.fallback.get("claude:max"), "max", "an unknown Claude model keeps max");
  // Every Claude model carries ITS list — iOS computes model by model like the clamp at the spawn.
  let pairs = 0;
  for (const mo of CLAUDE_MODELS) {
    for (const level of EFFORT_LEVELS) {
      assert.equal(r.fallback.get(`claude:${mo.id}:${level}`), mapClaudeEffort(level, mo.id), `${mo.id} + ${level}: iPhone and spawn name different levels`);
      pairs++;
    }
  }
  assert.ok(pairs >= 30, `${pairs} pairs checked`);
  assert.equal(r.fallback.get("claude:claude-haiku-4-5-20251001:max"), "", "Haiku 4.5 carries no levels ⇒ no level");
  assert.equal(r.no.get("claude:claude-haiku-4-5-20251001:max"), true, "Haiku: noLevels");
  assert.equal(r.no.get("claude:claude-opus-5:max"), false);
});

test("no levels ≠ unknown: iOS, server and web give the same answer for empty, missing and carried", async () => {
  const r = ios();
  // Web (lib/effort.ts) is transpiled separately as in effort.test.mjs and REALLY called.
  const webDir = path.join(repo, "web");
  const out = fs.mkdtempSync(path.join(webDir, "node_modules", ".effort-ios-test-"));
  try {
    execFileSync(process.execPath, [path.join(webDir, "node_modules", "typescript", "bin", "tsc"), path.join(webDir, "src", "lib", "effort.ts"),
      "--module", "esnext", "--target", "es2022", "--moduleResolution", "bundler", "--skipLibCheck", "--outDir", out], { cwd: webDir, stdio: "pipe" });
    fs.writeFileSync(path.join(out, "package.json"), '{"type":"module"}');
    const web = await import(pathToFileURL(path.join(out, "effort.js")).href);
    for (const f of cases) {
      const model = f.efforts == null ? { id: "m" } : { id: "m", efforts: f.efforts };
      const cat = [{ id: "p", defaultModel: "m", models: [model] }];
      const server = effortFallback(f.set, f.efforts);
      assert.equal(r.fallback.get(f.name), server, `${f.name}: iPhone "${r.fallback.get(f.name)}", server "${server}"`);
      assert.equal(web.effortFallback("p", f.model, cat, f.set), server, `${f.name}: web against server`);
      assert.equal(r.no.get(f.name), web.effortNoLevels("p", f.model, cat), `${f.name}: noLevels iPhone against web`);
      assert.deepEqual(r.levels.get(f.name), web.effortLevels("p", f.model, cat), `${f.name}: levels iPhone against web`);
    }
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
  assert.equal(r.fallback.get("empty:max"), "", "empty ⇒ no level");
  assert.equal(r.fallback.get("missing:max"), "max", "missing ⇒ pass through");
  assert.deepEqual(r.levels.get("empty:max"), [], "empty ⇒ no levels, not the preset");
  assert.deepEqual(r.levels.get("missing:max"), r.preset, "missing ⇒ the preset levels");
  assert.equal(r.no.get("empty:max"), true);
  assert.equal(r.no.get("missing:max"), false);
  assert.equal(r.no.get("empty:standard"), true, "an empty model is the default — if it carries no levels, there are none");
});

// ── The picker decision, web ↔ iOS ─────────────────────────────────────────────────
// "Picker yes/no" stands ONCE per client in the building block — web `effortWithoutSelection`/`effortPicker`/`effortEntries`
// (lib/effort.ts), iOS `EffortLevels.withoutSelection`/`EffortSelection.shows`/`.entries`. Both give the same answer for the same
// cases: no levels, `caps.effort` off, unknown model, carried levels — and "Default (global)" computes with the globally active
// provider, not with "".
test("picker yes/no is ONE answer: web and iOS equal for no levels, caps.effort off, unknown, carried, global", async () => {
  const r = ios();
  const webDir = path.join(repo, "web");
  const out = fs.mkdtempSync(path.join(webDir, "node_modules", ".effort-ios-picker-"));
  try {
    execFileSync(process.execPath, [path.join(webDir, "node_modules", "typescript", "bin", "tsc"), path.join(webDir, "src", "lib", "effort.ts"),
      "--module", "esnext", "--target", "es2022", "--moduleResolution", "bundler", "--skipLibCheck", "--outDir", out], { cwd: webDir, stdio: "pipe" });
    fs.writeFileSync(path.join(out, "package.json"), '{"type":"module"}');
    const web = await import(pathToFileURL(path.join(out, "effort.js")).href);
    const t = (text, params = {}) => text.replace(/\{(\w+)\}/g, (_, k) => String(params[k] ?? `{${k}}`));
    assert.equal(r.picker.size, PICKER_CASES.length, `iOS answered ${r.picker.size} of ${PICKER_CASES.length} picker cases`);
    for (const f of PICKER_CASES) {
      const p = { id: "p", defaultModel: "m", models: [f.efforts == null ? { id: "m" } : { id: "m", efforts: f.efforts }] };
      if (f.caps != null) p.caps = { effort: f.caps };
      const cat = [p, { id: "q", defaultModel: "m", models: [{ id: "m", efforts: ["low"] }] }];
      const i = r.picker.get(f.name);
      const without = web.effortWithoutSelection(f.provider, f.model, cat, f.active);
      assert.equal(i.without, without, `${f.name}: withoutSelection iPhone "${i.without}", web "${without}"`);
      assert.equal(i.shows, web.effortPicker(f.provider, f.model, cat, f.active), `${f.name}: picker yes/no`);
      const webEntries = web.effortEntries(f.provider, f.model, cat, "max", "Empty-Word", t, f.active).map((e) => `${e.id}|${e.label}`);
      // Compared only where a selection EXISTS: without a picker nobody sees the entries (and for a set level on a model without
      // levels the two sides label the substitute differently today — invisible).
      if (i.shows) assert.deepEqual(i.entries, webEntries, `${f.name}: entries iPhone against web`);
      // Without an empty entry (`null` on the web, `nil` on iOS) the same list, only without the first entry.
      const webWithoutEmpty = web.effortEntries(f.provider, f.model, cat, "max", null, t, f.active).map((e) => `${e.id}|${e.label}`);
      if (i.shows) {
        assert.deepEqual(i.withoutEmpty, webWithoutEmpty, `${f.name}: entries without empty entry iPhone against web`);
        assert.deepEqual(webWithoutEmpty, webEntries.slice(1), `${f.name}: without empty entry means: only the first is missing`);
      }
      assert.equal(i.text, web.effortWithoutSelectionText(without === "provider" ? "provider" : "model"), `${f.name}: /effort set`);
    }
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
  // The named answers — so that "both equally wrong" does not turn green.
  const without = (n) => r.picker.get(n).without;
  assert.equal(without("supported"), "");
  assert.equal(without("caps-missing"), "", "missing caps is unknown — the selection stands");
  assert.equal(without("caps-off"), "provider");
  assert.equal(without("caps-from-unknown-model"), "provider", "the provider switch applies to foreign models too");
  assert.equal(without("no-levels"), "model");
  assert.equal(without("no-levels-default-model"), "model");
  assert.equal(without("unknown-model"), "", "a model outside the catalog shows the preset levels");
  assert.equal(without("efforts-missing"), "");
  assert.equal(without("global:caps-off"), "provider", "\"Default (global)\" asks the globally active provider");
  assert.equal(without("global:no-levels"), "model");
  assert.equal(without("set-beats-global"), "", "a set provider takes precedence over the global one");
  // "Default (global)": the levels of the default model of the GLOBALLY active provider (low, high), not the five preset levels.
  assert.deepEqual(r.picker.get("global:carried").entries, ["|Empty-Word", "low|Low", "high|High", "max|Max · runs as High"]);
  assert.deepEqual(r.picker.get("global:unknown").entries, ["|Empty-Word", "low|Low", "medium|Medium", "high|High", "xhigh|X-High", "max|Max"],
    "if the global provider is still unknown, the fallback stays");
  assert.equal(r.picker.get("caps-off").text, "This provider has no thinking level — /effort sets nothing here.");
});

test("the corners of the rule: below, nothing below, unsorted, no level", () => {
  const r = ios();
  for (const f of CORNERS) {
    // Every corner additionally against the ONE computation of the server — with the same carried list.
    const expected = effortFallback(f.set, f.efforts);
    assert.equal(r.fallback.get(f.name), expected, `${f.name}: iPhone "${r.fallback.get(f.name)}", server "${expected}"`);
  }
  assert.equal(r.fallback.get("loch:xhigh"), "high", "the highest carried one BELOW the request — not the next one above");
  assert.equal(r.fallback.get("nothing-below"), "xhigh", "if nothing lies below, the lowest carried one applies");
  assert.equal(r.fallback.get("unsorted"), "xhigh", "ordering follows EFFORT_LEVELS, not the writing order of the catalog");
  assert.equal(r.fallback.get("unsorted-transposition"), "xhigh", "… on a list whose writing order WOULD really turn the result");
  assert.equal(r.fallback.get("capitalized"), "xhigh", "\"MAX\" is the same level as \"max\"");
  assert.equal(r.fallback.get("auto"), "", "\"Auto\" is no level and gets no substitute");
  assert.equal(r.fallback.get("no-level"), "", "what is not in EFFORT_LEVELS is no level — no flag, as at the spawn");
  for (const gone of ["ultra", "none", "minimal"]) {
    assert.equal(r.fallback.get(`${gone}-no-level`), "", `"${gone}" is no level — no flag, even if a catalog listed it`);
  }
  assert.equal(r.fallback.get("empty-model"), "xhigh", "an empty model is the PROVIDER DEFAULT, not \"unknown\"");
  assert.deepEqual(r.levels.get("empty-model"), ["low", "medium", "high", "xhigh"], "… and its levels are those of the default model");

  // A model without a catalog entry: the server passes the level through character by character (its maximum is unknown), iOS
  // computes with the fallback — it knows only what /api/providers sent along; the answer is the same because the fallback carries all
  // levels of the order. An EMPTY list is something else: no levels, "" on both sides (see "no levels ≠ unknown").
  assert.deepEqual(r.levels.get("claude:max"), ios().preset, "without `efforts` the fallback applies");
  assert.equal(effortFallback("max", null), "max", "the server passes through without a carried list");
  assert.equal(effortFallback("max", []), "", "… and gives no level for an EMPTY carried list");
});

test("the picker NAMES the substitute — the one that really thinks", () => {
  const r = ios();
  // The entry of the set, non-carried level is appended at the back and carries the mark; it names the highest carried one BELOW the
  // request.
  const entries = r.selection.get(`codex:${GAP}:max`);
  assert.deepEqual(entries.slice(0, 4), ["low|Low", "medium|Medium", "high|High", "xhigh|X-High"], "first the carried levels, in catalog order");
  assert.equal(entries.length, 5, "four carried plus the set one");
  assert.equal(entries.at(-1), "max|Max · runs as X-High", "the set level stays visible and says what thinks instead");
  // A carried level gets no suffix — otherwise the picker would claim a clamp that does not exist.
  assert.equal(r.selection.get(`codex:${GAP}:xhigh`).length, 4);
  // A set value that is no level at all runs as "Automatic" (no flag) — this is how a stored `ultra` would look had the migration at
  // startup not turned it into max.
  assert.equal(r.selection.get("ultra-no-level").at(-1), "ultra|ultra · runs as Automatic");
  // No selection OFFERS one of the removed or never offered levels: for every Codex model of the server catalog and for the fallback
  // the list contains only levels of the list of five.
  for (const [name, list] of r.levels) {
    if (name.endsWith("-no-level")) continue; // there the catalog lists them on purpose (wrongly)
    for (const gone of ["ultra", "none", "minimal"]) assert.ok(!list.includes(gone), `${name}: the selection offers "${gone}"`);
  }
});

// ── Which levels a model carries depends on the model, not on the login ─────────────────
// Not a computation but wiring — and exactly that was wrong on both clients: with `codex connected:false`, the filtered list made the
// workflow run offer the five preset levels permanently — "Max" even for a model without it (HTTP 400). `effort.test.mjs` runs the same
// check for the three web selections.
const readIos = (p) => fs.readFileSync(p, "utf8");

// The effort selections of the app and how they call the building block `EffortSelection`: binding, the word of the empty entry (per
// place; the chat places `nil`) and the UNFILTERED provider list.
const CALLER = () => [
  // The two inheriting fields label empty as "Default · <level>" — with the SAME arguments as the selection, i.e. the level the run
  // thinks with for these inputs.
  ["WorkflowSettings", readIos(SOURCE_WORKFLOW_EDITOR),
    /EffortSelection\(effort: \$run\.effort, empty: EffortLevels\.standardLabel\(providers, provider: run\.provider, model: run\.model, active: activeProvider, asChat: true\), providers: providers, provider: run\.provider, model: run\.model, active: activeProvider\)/],
  // Via the binding `levelChoice` (writes `effort` and remembers the explicit choice) — like the one in WorkspaceViews.
  ["ChatSheets", readIos(SOURCE_CHAT_SHEETS),
    /EffortSelection\(effort: levelChoice, empty: nil, providers: model\.providers, provider: provider, model: selectedModel, active: model\.activeProvider\)/],
  ["WorkspaceViews", readIos(SOURCE_WORKSPACE_VIEWS),
    /EffortSelection\(effort: \$draft\.effort, empty: nil, providers: providers, provider: draft\.provider, model: draft\.model\)/],
  // "New job" under Coding → Scheduled — preset like a new chat, so with the SAME binding as `NewChatSheet` (the level alone, ultracode as
  // its own toggle).
  ["ScheduledDetail", readIos(path.join(repo, "mobile", "CbaseMobile", "Code", "ScheduledDetail.swift")),
    /EffortSelection\(effort: \$draft\.effort, empty: nil, providers: providers, provider: draft\.provider, model: draft\.model\)/],
  // The level per app agent — empty entry "Default · <level>" on the EFFECTIVE model of the row. For compaction without a choice "like
  // the chat": no model, no provider (`active` empty), the empty entry without a level.
  ["AgentModelSettings", readIos(path.join(repo, "mobile", "CbaseMobile", "Settings", "AgentModelSettings.swift")),
    /let active = asChat \? "" : activeProvider\s*EffortSelection\(\s*effort: Binding\([\s\S]{0,200}?\),\s*empty: asChat \? L\("Default"\) : EffortLevels\.standardLabel\(effortCatalog, provider: run\.provider, model: run\.model, active: active\),\s*providers: effortCatalog, provider: run\.provider, model: run\.model, active: active\s*\)/],
  // Outer loop: the level per outer-loop agent — "Default · <level>"; there is no empty provider there (without provider and model it does
  // not run), the building block stands only with both.
  ["OuterLoopEditor", readIos(path.join(repo, "mobile", "CbaseMobile", "Code", "OuterLoopEditor.swift")),
    /EffortSelection\(\s*effort: \$effort,\s*empty: EffortLevels\.standardLabel\(providers, provider: provider, model: model, active: activeProvider\),\s*providers: providers, provider: provider, model: model, active: activeProvider\s*\)/],
];

test("the LEVELS come from the unfiltered provider list, the MODELS from the connected one (iOS)", () => {
  const editor = readIos(SOURCE_WORKFLOW_EDITOR);

  // 1. No cut at the LOADING path any more — there it hits both questions at once.
  assert.ok(!/providers = r\?\.providers\.filter\(\\\.connected\)/.test(editor), "WorkflowSettings no longer filters on load");
  assert.match(editor, /providers = r\?\.providers \?\? \[\]/, "… but keeps all");

  // 2. The cut sits at the CHOICE.
  assert.match(editor, /private var connected: \[Provider\] \{ providers\.filter\(\\\.connected\) \}/, "the editor keeps both lists");
  for (const [location, source] of [["WorkflowSettings", editor]]) {
    assert.match(source, /ForEach\(connected\) \{ p in/, `${location}: the provider selection takes the filtered list`);
    assert.match(source, /ForEach\(connected\.first \{ \$0\.id == /, `${location}: … and so does the model selection`);
  }

  // 3. The effort selections ask the UNFILTERED list — the ones that always did it right are included: they are the model and must not
  //    tip over unnoticed. Every place hands it to the building block `EffortSelection` (Kit/) as `providers:` — the block itself passes
  //    it unchanged to `EffortLevels.selection` (see "One building block" below).
  const caller = CALLER();
  for (const [location, source, pattern] of caller) {
    assert.match(source, pattern, `${location} asks for the levels with the whole provider list`);
    for (const name of ["EffortLevels\\.selection\\(", "EffortSelection\\("]) {
      assert.ok(!new RegExp(`${name}[^)]*providers: verbundene`).test(source) && !new RegExp(`${name}connected`).test(source), `${location} does NOT ask with the filtered one`);
      assert.ok(!new RegExp(`${name}[^)]*\\.filter\\(`).test(source), `${location} does not filter in the call either`);
    }
  }
  // `/effort` in the composer computes with the same list — otherwise the command would reject a level that the picker next to it offers.
  const slash = readIos(path.join(repo, "mobile", "CbaseMobile", "Chat", "ChatViewModel+Slash.swift"));
  assert.ok(!/EffortLevels\.levels\(connectedProviders/.test(slash), "/effort does not ask the filtered list");
  assert.equal((slash.match(/EffortLevels\.levels\(providers, /g) || []).length, 2, "both branches of /effort ask the whole list");
});

// ── One building block ─────────────────────────────
// Without ONE building block every picker would build its entries itself (empty entry, then `ForEach(EffortLevels.selection(…))`) and
// every change would be made several times. The selection lives in `Kit/EffortSelection.swift` (web counterpart: `effortEntries` in
// lib/effort.ts), and two things hold it: the computation of the block (executed here with `xcrun swift`) and the search that no picker
// iterates over the levels itself any more. What the places SHOW is held by the XCUITests (`testEffortSelectionInTheChatSettings`,
// `…InNewChat`, `…InTheWorkflowSettings`).
test("one building block: EffortSelection.entries is the empty entry and then exactly EffortLevels.selection", () => {
  const r = ios();
  let n = 0;
  for (const [name, selection] of r.selection) {
    assert.deepEqual(r.buildingBlock.get(name), ["|Empty-Word", ...selection], `${name}: the building block shows something other than the selection the pickers built themselves`);
    n++;
  }
  assert.equal(n, cases.length, "every case went through the building block");
  // The marked entry goes through too — the block filters and reorders nothing.
  assert.equal(r.buildingBlock.get(`codex:${GAP}:max`).at(-1), "max|Max · runs as X-High");
});

test("one building block: no picker of the app iterates over the level selection itself", () => {
  const root = path.join(repo, "mobile", "CbaseMobile");
  // The parts of the list — whoever calls one of them builds a selection next to the block. `EffortLevels.label`/`fallback` name a SINGLE
  // level and stay free.
  const COMPONENT = /EffortLevels\s*\.\s*(selection|levels|stages|preset)\b/g;
  // Where they may stand, with reason: the block, and `/effort` without an argument (TEXT, no selection). The definition in Models.swift
  // calls itself unqualified.
  const ALLOWED = new Map([
    ["Kit/EffortSelection.swift", "the building block"],
    ["Chat/ChatViewModel+Slash.swift", "/effort answers with text, not with a selection"],
  ]);
  const withoutComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"])\/\/.*$/gm, "$1");
  const files = [];
  const run = (rel) => {
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) run(r);
      else if (e.name.endsWith(".swift")) files.push(r);
    }
  };
  run("");
  assert.ok(files.length > 100, `only ${files.length} Swift files found — does the search still work?`);
  const findings = [];
  for (const rel of files) {
    if (ALLOWED.has(rel)) continue;
    for (const m of withoutComments(readIos(path.join(root, rel))).matchAll(COMPONENT)) findings.push(`${rel}: EffortLevels.${m[1]}`);
  }
  assert.deepEqual(findings, [], "a view builds its effort selection next to the EffortSelection building block (Kit/EffortSelection.swift)");
  for (const [rel, reason] of ALLOWED) {
    assert.ok(COMPONENT.test(withoutComments(readIos(path.join(root, rel)))), `${rel} (${reason}) no longer calls a part — remove the exception`);
    COMPONENT.lastIndex = 0;
  }
  // Every place calls the block, with ITS word for the empty entry — and none iterates itself any more.
  for (const [location, source, pattern] of CALLER()) {
    assert.match(source, pattern, `${location} does not call the building block (or with another empty word, another list)`);
    assert.ok(!/ForEach\(EffortLevels/.test(source), `${location} iterates over the level selection itself`);
  }
  // Complete: every call of the block in the app is in CALLER (measured, not copied). A list that only searches for known names finds
  // the names it knows.
  const calls = [];
  for (const rel of files) {
    if (rel === "Kit/EffortSelection.swift") continue;
    const n = (withoutComments(readIos(path.join(root, rel))).match(/\bEffortSelection\(/g) || []).length;
    for (let i = 0; i < n; i++) calls.push(path.basename(rel, ".swift"));
  }
  assert.deepEqual(calls.sort(), CALLER().map(([location]) => location).sort(),
    "a call of EffortSelection is not in CALLER (or CALLER names one that no longer exists)");
  console.log(`  [effort-ios] building block: ${files.length} Swift files searched, ${ALLOWED.size} named places, ${CALLER().length} callers`);
});

// ── "Default · <level>": ONE computation per client, web ↔ iOS bound ─────────────────────────────────
// The empty entry of an inheriting field names the level it thinks with: the provider's default level, clamped to the model. Web
// `effortStandardLabel` (lib/effort.ts), iOS `EffortLevels.standardLabel` — case by case the same label (the case's set value plays the
// default level). Also for "Default (global)" and against the server's clamp — the table (provider, model, default level → label).
// Counter-test: `standardLabel` on iOS without the clamp (the default level raw) ⇒ red.
test("\"Default · <level>\": web and iOS label the empty entry the same case by case — \"Default (global)\" too, clamped like the server", async () => {
  const r = ios();
  const webDir = path.join(repo, "web");
  const out = fs.mkdtempSync(path.join(webDir, "node_modules", ".effort-ios-std-"));
  try {
    execFileSync(process.execPath, [path.join(webDir, "node_modules", "typescript", "bin", "tsc"), path.join(webDir, "src", "lib", "effort.ts"),
      "--module", "esnext", "--target", "es2022", "--moduleResolution", "bundler", "--skipLibCheck", "--outDir", out], { cwd: webDir, stdio: "pipe" });
    fs.writeFileSync(path.join(out, "package.json"), '{"type":"module"}');
    const web = await import(pathToFileURL(path.join(out, "effort.js")).href);
    const t = (s, v = {}) => s.replace(/\{(\w+)\}/g, (_, k) => String(v[k] ?? ""));
    let withLevel = 0;
    let clamp2 = 0;
    for (const f of cases) {
      const model = f.efforts == null ? { id: "m" } : { id: "m", efforts: f.efforts };
      const cat = [{ id: "p", defaultModel: "m", defaultEffort: f.set, models: [model] }];
      const w = web.effortStandardLabel("p", f.model, cat, t);
      assert.equal(r.standardLabel.get(f.name), w, `${f.name}: iPhone "${r.standardLabel.get(f.name)}", web "${w}"`);
      // "Default (global)" (empty provider, the active one is p) — the same label on both sides, and the level in it is that of the
      // server clamp (the case's default level, clamped to ITS list).
      const g = web.effortStandardLabel("", f.model, cat, t, "p");
      assert.equal(r.standardGlobal.get(f.name), g, `${f.name} (global): iPhone "${r.standardGlobal.get(f.name)}", web "${g}"`);
      // The run level of a workflow ("As the chat · new: <level>") — the same variant on both sides.
      const c = web.effortStandardLabel("", f.model, cat, t, "p", true);
      assert.equal(r.standardChat.get(f.name), c, `${f.name} (workflow run): iPhone "${r.standardChat.get(f.name)}", web "${c}"`);
      // (Only for real levels: a default level is always one on the server — `effortStandard`.)
      if (EFFORT_LEVELS.includes(f.set)) {
        const clamp = effortFallback(f.set, f.efforts);
        assert.equal(g, clamp ? `Default · ${web.EFFORT_LABEL[clamp]}` : "Default", `${f.name} (global): the label names the clamp of the server`);
        clamp2++;
      }
      if (w !== "Default") withLevel++;
    }
    assert.ok(withLevel > 0 && withLevel < cases.length, `both forms occur (${withLevel} with level of ${cases.length})`);
    assert.ok(clamp2 > 50, `held against the server clamp: ${clamp2} cases`);
    // Named so that "both equally wrong" does not turn green: default max on the model without max thinks with X-High.
    assert.equal(r.standardGlobal.get(`codex:${GAP}:max`), "Default · X-High");
    assert.equal(r.standardChat.get(`codex:${GAP}:max`), "As the chat · new: X-High");
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});

// ── Ultracode on iOS: a toggle next to the effort selection (as on the web) ─────────────────────────────
// The selection has no ultracode entry any more; at the three chat places (chat sheet, new chat, scheduled) `UltracodeToggle` stands below
// it, bound to the field of its own. The chat sheet sends level and toggle separately, `updateSettings` leaves the level next to the
// toggle, and `/effort ultracode` flips the toggle, BEFORE the "without levels" branch.
// Counter-test: `let level: String? = effort.isEmpty || ultracode == true ? nil : effort` (the old state) ⇒ red.
test("ultracode: iOS carries it as a toggle of its own at the chat places, never in the effort selection", () => {
  const kit = readIos(SOURCE_KIT_EFFORT);
  const selection = kit.slice(kit.indexOf("struct EffortSelection"), kit.indexOf("struct UltracodeToggle"));
  assert.ok(selection.length > 100, "anchor: EffortSelection before UltracodeToggle");
  assert.ok(!/ultracode|modeAn/.test(selection), "the effort selection no longer knows ultracode");
  assert.match(kit, /struct UltracodeToggle: View \{\s*@Binding var on: Bool[\s\S]{0,120}?Toggle\(isOn: \$on\)/, "the toggle is a Toggle on the field of its own");
  const sheet = readIos(SOURCE_CHAT_SHEETS);
  assert.match(sheet, /UltracodeToggle\(on: \$ultracode\)/, "the chat sheet shows the toggle");
  assert.match(sheet, /effort: effort,[\s\S]{0,600}?ultracode: ultracode,/, "the chat sheet sends level and toggle separately");
  const fresh = readIos(SOURCE_WORKSPACE_VIEWS);
  assert.match(fresh, /UltracodeToggle\(on: \$draft\.ultracode\)/, "new chat shows the toggle");
  assert.ok(!/EffortLevels\.ultracode/.test(fresh), "new chat no longer translates a selection into the mode");
  assert.match(readIos(path.join(repo, "mobile", "CbaseMobile", "Code", "ScheduledDetail.swift")), /UltracodeToggle\(on: \$draft\.ultracode\)/, "scheduled shows the toggle");
  // The creation itself: the draft takes over the preselection, the first message sends it.
  assert.match(readIos(SOURCE_CHAT_VM), /ultracode: preset\.ultracode,/, "the draft takes over the preselection of the sheet");
  const creation = readIos(SOURCE_CHAT_SERVER);
  assert.match(creation, /let ultracode: Bool\?/, "the creation carries the toggle as a field of its own, omittable");
  assert.match(creation, /effort: draft\.effort\.isEmpty[\s\S]{0,600}?ultracode: draft\.ultracode \? true : nil/, "the creation sends level and toggle like `effortForCreation` on the web");
  const actions = readIos(path.join(repo, "mobile", "CbaseMobile", "Chat", "ChatViewModel+Actions.swift"));
  assert.ok(actions.includes("let level: String? = effort.isEmpty ? nil : effort"), "updateSettings leaves the level next to the toggle");
  const slash = readIos(path.join(repo, "mobile", "CbaseMobile", "Chat", "ChatViewModel+Slash.swift"));
  const branch = slash.slice(slash.indexOf('case "effort":'), slash.indexOf('case "mode":'));
  const switchOver = branch.indexOf("if value == EffortLevels.ultracode {");
  assert.ok(switchOver > 0 && switchOver < branch.indexOf("EffortLevels.withoutSelection("), "/effort ultracode comes BEFORE the without-levels branch");
  assert.match(branch, /let enabled = !chat\.ultracode[\s\S]{0,300}?ultracode: enabled,/, "/effort ultracode flips the toggle");
  assert.ok(!/ultracode: false/.test(branch), "a level no longer switches ultracode off");
});
