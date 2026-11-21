// Effort levels: three lists, one truth - and ONE term for the replacement.
//
// Thirteen places in cbase know effort levels. The CODEX list is bound (`server/backend/test/codex-usage.test.js`: `efforts` per
// model == CODEX_EFFORTS, a subset of EFFORT_LEVELS) and so is the web fallback against the server (`composer-contract.test.mjs`). The
// CLAUDE list was bound by no test, although the same list stands three times:
//   1. `CLAUDE_EFFORTS`         - server/backend/electron/server/providers/connectors/claude.js
//   2. `EFFORT_DEFAULT`         - web/src/lib/effort.ts (the fallback when a model sends no `efforts`)
//   3. `EffortLevels.preset`    - mobile/CbaseMobile/Models/Models.swift (the same fallback on mobile)
// Without the binding the Claude CLI could gain a sixth level, be entered in `CLAUDE_EFFORTS`, the gate stays green - and the level is
// selectable nowhere in web and iOS, because the picker knows no free text. Conversely, if `max` drops out of the CLI, both clients keep
// offering it and every turn runs into the stderr warning nobody reads.
//
// Second half: the clamp at spawn does not drop an unsupported level but REPLACES it - by the highest supported one that is NOT ABOVE the
// requested one (a level more costs thinking tokens against the subscription limit; a model with a HOLE at `max` must not jump over the
// request). So there is a level the interface can NAME ("the run thinks with ...") - and an interface naming a different one than the
// one thinking would be worse than a silent one. Therefore the client computation (`effortFallback`) is not described here but computed
// pair by pair against BOTH backend versions: `codexEffortFallback` and `mapClaudeEffort`.
//
// Third half: the level choice in ALL three surfaces asks the UNFILTERED provider list (which levels a model carries depends on the model,
// not the login - `connected` belongs to the MODEL selection), every picker entry names the REPLACEMENT (not just the loss), and the text
// names the right rejecting party (for Codex the model, for Claude the CLI, otherwise the provider). All three are source or computation
// checks below: mostly not a computation but wiring, and wiring was wrong three times.
//
// Files are read BY PATH (model `web/test/credit.test.mjs`) - whoever moves one adjusts the line here.
//
// Run:  node --test web/test/effort.test.mjs
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { CODEX_EFFORTS, CODEX_MODELS, codexEffortFallback } from "../../server/backend/electron/server/providers/connectors/codex.js";
import { CLAUDE_MODELS, mapClaudeEffort } from "../../server/backend/electron/server/providers/connectors/claude.js";
// The Codex model WITHOUT max: a test model with the numbers of the former gpt-5.5 - entered into the server catalog for the whole
// file (gaps-model.mjs; every catalog below is built from CODEX_MODELS).
import { GAP, enterGapsModel } from "../../server/backend/test/gaps-model.mjs";
after(enterGapsModel());
import { EFFORT_LEVELS, effortFallback as effortFallbackServer } from "../../server/backend/electron/server/workflows.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const repo = path.resolve(here, "..", "..");
const SOURCE_WEB = path.join(webDir, "src", "lib", "effort.ts");
const SOURCE_CLAUDE = path.join(repo, "server", "backend", "electron", "server", "providers", "connectors", "claude.js");
const SOURCE_IOS = path.join(repo, "mobile", "CbaseMobile", "Models", "Models.swift");
const SOURCE_IOS_SLASH = path.join(repo, "mobile", "CbaseMobile", "Chat", "ChatViewModel+Slash.swift");
const SOURCE_WF_API = path.join(webDir, "src", "lib", "api", "workflows.ts");
// The HTTP wire (only openai-chat, over which the built-in OpenRouter runs): its table is the list of levels the wire knows at all
// (`WIRE_LEVELS = Object.keys(...)`) and at the same time the value with which the run really thinks. It is read by path instead of
// imported - the client should not depend on connector modules - and the declaration is one line (same form as `list()` below).
const PRESETS = [
  ["openai-chat", path.join(repo, "server", "backend", "electron", "server", "providers", "connectors", "openai-chat.js"), "REASONING_EFFORT"],
];

// `lib/effort.ts` is a leaf module (no imports) - it can be compiled on its own like graph-geometry.ts and then REALLY called. A text
// comparison would not do: a computation is checked, not a spelling.
let out = null;
let loaded = null;
function effortModule() {
  loaded ??= (async () => {
    out = fs.mkdtempSync(path.join(webDir, "node_modules", ".effort-test-"));
    execFileSync(process.execPath, [
      path.join(webDir, "node_modules", "typescript", "bin", "tsc"),
      SOURCE_WEB, "--module", "esnext", "--target", "es2022",
      "--moduleResolution", "bundler", "--skipLibCheck", "--outDir", out,
    ], { cwd: webDir, stdio: "pipe" });
    // The project has no `"type": "module"`; without this file the import fails with "Unexpected token export" (same trap as in
    // the geometry test).
    fs.writeFileSync(path.join(out, "package.json"), '{"type":"module"}');
    return import(pathToFileURL(path.join(out, "effort.js")).href);
  })();
  return loaded;
}
after(() => { if (out) fs.rmSync(out, { recursive: true, force: true }); });

// Pull a list of strings out of a declaration - the same form in JS, TS and Swift.
function list(file, pattern, location) {
  const m = fs.readFileSync(file, "utf8").match(pattern);
  assert.ok(m, `the declaration is missing in ${location} - moved or renamed? Then adjust this line.`);
  return m[1].split(",").map((x) => x.trim().replace(/^"|"$/g, "")).filter(Boolean);
}

test("Three lists, one truth: CLAUDE_EFFORTS == EFFORT_DEFAULT == EffortLevels.preset", async () => {
  const server = list(SOURCE_CLAUDE, /^const CLAUDE_EFFORTS = \[([^\]]*)\];$/m, "connectors/claude.js");
  const web = list(SOURCE_WEB, /^export const EFFORT_DEFAULT: readonly string\[\] = \[([^\]]*)\];$/m, "web/src/lib/effort.ts");
  const ios = list(SOURCE_IOS, /^\s*static let preset = \[([^\]]*)\]$/m, "mobile/.../Models/Models.swift");

  assert.ok(server.length >= 3, `CLAUDE_EFFORTS carries ${server.length} levels`);
  // Order included: it is meant ascending.
  assert.deepEqual(web, server, "the web fallback differs from the levels of the Claude CLI");
  assert.deepEqual(ios, server, "the iOS fallback differs from the levels of the Claude CLI");

  // And the module's computation really uses this list (not a second one beside it).
  const { EFFORT_DEFAULT, effortLevels } = await effortModule();
  assert.deepEqual([...EFFORT_DEFAULT], server);
  assert.deepEqual(effortLevels("claude", "claude-opus-5", []), server, "without `efforts` in the catalog the fallback applies");

  // What the CLI can do, a chat must be allowed to store - otherwise chats/routes.js would write "".
  for (const level of server) assert.ok(EFFORT_LEVELS.includes(level), `"${level}" is known to the Claude CLI, not to EFFORT_LEVELS`);
});

test("The ORDER stands once: EFFORT_LEVELS (server) == EFFORT_LEVELS (web) == EFFORT_LABEL == the union of the run settings", async () => {
  // The order is a COMPUTATION, not a writing habit: the replacement is the highest supported level not above the requested one, and
  // "highest" is read from `EFFORT_LEVELS`. So it may exist only once; it used to stand FOUR times, with no spelling bound:
  //   1. `EFFORT_LEVELS`   - server/backend/electron/server/workflows.js (the source, imported here)
  //   2. `EFFORT_LEVELS`   - web/src/lib/effort.ts (the web half; a leaf module cannot import the server)
  //   3. `EFFORT_LABEL`    - the same file, as the key order of a label table
  //   4. the union `effort` in web/src/lib/api/workflows.ts - and the workflow editor CASTS to it
  //      (`as WorkflowRunSettings["effort"]`), so it stays silent exactly when the union ages.
  const { EFFORT_LEVELS: web, EFFORT_LABEL, EFFORT_DEFAULT } = await effortModule();
  assert.deepEqual([...web], [...EFFORT_LEVELS], "the web order differs from the server's (workflows.js)");
  assert.deepEqual(Object.keys(EFFORT_LABEL), [...EFFORT_LEVELS], "the label table carries other levels or another order");
  for (const level of EFFORT_DEFAULT) assert.ok(EFFORT_LEVELS.includes(level), `the default level "${level}" is not in EFFORT_LEVELS`);

  // The union: "" plus the levels, in the same order. `""` comes first and means "Automatic".
  const source = fs.readFileSync(SOURCE_WF_API, "utf8");
  const m = source.match(/^ {2}effort: ((?:"[^"]*" \| )*"[^"]*");$/m);
  assert.ok(m, "the union `effort` stands in web/src/lib/api/workflows.ts - moved or renamed? Then adjust this line.");
  const union = [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]);
  assert.deepEqual(union, ["", ...EFFORT_LEVELS], "the union of the run settings differs from EFFORT_LEVELS");
});

test("The replacement is ONE term: the client computes pair by pair the same as the Codex clamp", async () => {
  const { effortFallback } = await effortModule();
  // The catalog as /api/providers delivers it: per model its measured levels.
  const catalog = [{ id: "codex", defaultModel: "gpt-5.6-sol", models: CODEX_MODELS.map((m) => ({ id: m.id, efforts: [...m.efforts] })) }];

  const rank = (g) => EFFORT_LEVELS.indexOf(g);
  let pairs = 0;
  for (const mo of CODEX_MODELS) {
    for (const level of EFFORT_LEVELS) {
      const fallback = effortFallback("codex", mo.id, catalog, level);
      assert.equal(fallback, codexEffortFallback(level, mo.id),
        `${mo.id} + ${level}: interface and spawn name different levels`);
      // And the RULE itself, not just equality with the server: the replacement is a supported level and NEVER above the request. If
      // both sides were wrong together, the comparison above would stay green.
      assert.ok(mo.efforts.includes(fallback), `${mo.id} + ${level}: the replacement "${fallback}" is itself not carried`);
      assert.ok(rank(fallback) <= rank(level), `${mo.id} + ${level}: the replacement "${fallback}" is ABOVE the request - a level more costs thinking tokens`);
      pairs++;
    }
  }
  assert.ok(pairs >= 30, `${pairs} pairs checked`);

  // The case that makes the replacement necessary in the first place - named, so a refactoring does not optimize it away: a model
  // without max. The highest supported one BELOW the request. The RULE for a hole in the MIDDLE of the list is measured at "loch" below.
  assert.equal(effortFallback("codex", GAP, catalog, "max"), "xhigh");
  assert.equal(codexEffortFallback("max", GAP), "xhigh");
  // The sixth level (removed) is NO level any more - both sides say the same: no replacement, no flag (a stored old value migrates to
  // max at startup, ultra-gone.test.js).
  assert.equal(effortFallback("codex", "gpt-5.4", catalog, "ultra"), "");
  assert.equal(codexEffortFallback("ultra", "gpt-5.4"), "");

  // Ordering is by EFFORT_LEVELS, NOT by the catalog's writing order: that the `efforts` lists are written ascending is a habit, not a
  // promise. An unsorted entry (the server sorts, see workflows.js) must give no other replacement here than there - otherwise the
  // interface would name a level the run does not use.
  const jumbled = [{ id: "codex", defaultModel: "x", models: [{ id: "x", efforts: ["high", "low", "xhigh"] }] }];
  assert.equal(effortFallback("codex", "x", jumbled, "max"), "xhigh", "the list is ordered by EFFORT_LEVELS, not as written");
  assert.equal(effortFallback("codex", "x", jumbled, "low"), "low");
  // The list above NAMES the promise but does not measure it: it gives "xhigh" with and without sorting. This one flips (without order
  // it would give "medium") - and it is the realistic one: someone measures a level later and appends it at the END of `efforts`.
  // Both sides must then compute the same as the spawn.
  const transposition = [{ id: "codex", defaultModel: "x", models: [{ id: "x", efforts: ["low", "xhigh", "medium"] }] }];
  assert.equal(effortFallback("codex", "x", transposition, "max"), "xhigh", "the catalog's writing order must not tip the replacement");
  assert.equal(effortFallback("codex", "x", transposition, "max"), effortFallbackServer("max", ["low", "xhigh", "medium"]), "... and exactly the same as the ONE clamp at spawn");
  // And if there is nothing below the request, it is the LOWEST supported one - not the highest.
  assert.equal(effortFallback("codex", "x", [{ id: "codex", models: [{ id: "x", efforts: ["xhigh", "max"] }] }], "low"), "xhigh",
    "without a carried level below the request the lowest carried one applies");
  // A hole in the MIDDLE of the list: the highest supported one BELOW the request, not the next one above.
  const hole = [{ id: "codex", models: [{ id: "x", efforts: ["low", "medium", "high", "max"] }] }];
  assert.equal(effortFallback("codex", "x", hole, "xhigh"), "high", "a hole is closed DOWNWARDS");
  assert.equal(effortFallback("codex", "x", hole, "xhigh"), effortFallbackServer("xhigh", ["low", "medium", "high", "max"]), "... as at the clamp at spawn");
  // "Auto" is no level and gets no replacement.
  assert.equal(effortFallback("codex", GAP, catalog, ""), "");
  assert.equal(codexEffortFallback("", GAP), "");
  // An empty model is the provider default, not "unknown" - otherwise the interface would compute with the five fallback levels
  // while the server runs gpt-5.6-sol.
  assert.equal(effortFallback("codex", "", catalog, "max"), codexEffortFallback("max", "gpt-5.6-sol"));
  // Every level that any model carries must also be storable (otherwise it would never get here).
  for (const level of CODEX_EFFORTS) assert.ok(EFFORT_LEVELS.includes(level), `"${level}" is in CODEX_EFFORTS but not in EFFORT_LEVELS`);
});

test("The replacement is ONE term: also against the Claude clamp, level by level", async () => {
  const { effortFallback } = await effortModule();
  // This is how /api/providers really delivers the Claude models: WITHOUT `efforts` (only Codex measures them).
  const catalog = [{ id: "claude", defaultModel: "claude-sonnet-5", models: [{ id: "claude-opus-5" }, { id: "claude-sonnet-5" }] }];
  for (const level of EFFORT_LEVELS) {
    assert.equal(effortFallback("claude", "claude-opus-5", catalog, level), mapClaudeEffort(level),
      `claude + ${level}: interface and spawn name different levels`);
  }
  // The sixth level (removed) is NO level here either: both sides give "" (no `--effort`). A stored old value moves to max through the
  // migration at startup (store/chats.js: `migrateUltraToMax`), not through the clamp.
  assert.equal(effortFallback("claude", "claude-opus-5", catalog, "ultra"), "");
  assert.equal(mapClaudeEffort("ultra"), "");
  assert.equal(effortFallback("claude", "claude-opus-5", catalog, ""), mapClaudeEffort(""));
});

// ── Levels per Claude model: "no levels" is not "unknown" ─────────────────────────────
// The rule at three places (server `effortFallback`, web here, iOS `EffortLevels` - effort-ios.test.mjs): an EMPTY list means "no levels"
// (no flag, no picker), a MISSING one "unknown" (pass through, default levels).
test("Levels per Claude model: web and spawn name the same level model by model - Haiku none", async () => {
  const { effortFallback, effortNoLevels, effortLevels } = await effortModule();
  const catalog = [{ id: "claude", defaultModel: "claude-sonnet-5", models: CLAUDE_MODELS.map((m) => ({ id: m.id, efforts: m.efforts })) }];
  let pairs = 0;
  for (const mo of CLAUDE_MODELS) {
    assert.ok(Array.isArray(mo.efforts), `${mo.id} carries \`efforts\` in the server catalog`);
    for (const level of EFFORT_LEVELS) {
      assert.equal(effortFallback("claude", mo.id, catalog, level), mapClaudeEffort(level, mo.id), `${mo.id} + ${level}: interface and spawn name different levels`);
      pairs++;
    }
  }
  assert.ok(pairs >= 30, `${pairs} pairs checked`);
  const haiku = "claude-haiku-4-5-20251001";
  assert.deepEqual(effortLevels("claude", haiku, catalog), [], "Haiku: no levels");
  assert.equal(effortNoLevels("claude", haiku, catalog), true);
  for (const level of EFFORT_LEVELS) assert.equal(effortFallback("claude", haiku, catalog, level), "", `Haiku + ${level}: no level`);
  assert.equal(effortNoLevels("claude", "claude-opus-5", catalog), false);
  // A model OUTSIDE the catalog still shows the default levels (unknown != none).
  assert.equal(effortNoLevels("claude", "claude-never-in-catalog", catalog), false);
  const { EFFORT_DEFAULT } = await effortModule();
  assert.deepEqual(effortLevels("claude", "claude-never-in-catalog", catalog), [...EFFORT_DEFAULT]);
  // The default model decides when the chat carries none.
  const catalogHaikuDefault = [{ ...catalog[0], defaultModel: haiku }];
  assert.equal(effortNoLevels("claude", "", catalogHaikuDefault), true, "empty model = default (Haiku) => no levels");
});

test("Without levels no slider: the effort sheet shows only the Ultracode switch, /effort says \"no thinking levels\" and sets no level", () => {
  const composer = fs.readFileSync(path.join(webDir, "src", "components", "chat", "ChatComposer.tsx"), "utf8");
  const slash = fs.readFileSync(path.join(webDir, "src", "components", "chat", "chatSlash.ts"), "utf8");
  // The composer asks the building block (`effortPicker` - no levels OR `caps.effort` off).
  assert.match(composer, /const effortNone = !effortPicker\(currentProvider, effectiveModel, effortCatalog\);/, "the composer asks the same computation");
  // The button is ALWAYS there (the Ultracode switch lives in its sheet, even without levels); without levels the sheet carries no
  // slider (`effortChoice` empty) - see the test "Ultracode is a switch" below.
  assert.match(composer, /\(effortNone \? \[\] : effortEntries\(currentProvider, effectiveModel, effortCatalog, currentEffort, null, t\)\)/, "without levels no steps");
  assert.match(composer, /effortChoice\.length > 0\n\s+\? <EffortSlider/, "the slider stands only with steps");
  const branch = slash.slice(slash.indexOf('if (cmd === "effort")'), slash.indexOf('if (cmd === "mode")'));
  // Via the building block: `effortWithoutSelection` (reason) and `effortWithoutSelectionText` (the sentence per reason).
  const turnout = branch.indexOf("const without = effortWithoutSelection(currentProvider, effectiveModel, allProviders);");
  assert.ok(turnout > 0, "/effort asks the building block (effortWithoutSelection)");
  const body = branch.slice(turnout, branch.indexOf("return true;", turnout));
  assert.ok(body.includes("t(effortWithoutSelectionText(without))"), "/effort names the reason from the building block");
  assert.ok(!body.includes("pickEffort"), "/effort sets no level without levels");
  assert.ok(turnout < branch.indexOf("pickEffort("), "the switch stands BEFORE every setting");
  const en = fs.readFileSync(path.join(webDir, "src", "lib", "i18n-de.ts"), "utf8");
  assert.equal(en.split("\n").filter((z) => z.trimStart().startsWith('"This model has no thinking levels — /effort sets nothing here.":')).length, 1, "exactly one German row");
});

// ── Other selections, `caps.effort`, "Default (global)" ───────────────────────────────────
// The decision "picker yes/no" stands ONCE in the building block (`effortWithoutSelection`/`effortPicker`), and each of the selections
// asks it: composer (also the new chat), workflow run and `/effort`. The web <-> iOS binding is held by effort-ios.test.mjs; here the
// web computation and its call sites.
test("Other selections: caps.effort off => no picker anywhere; \"Default (global)\" computes with the GLOBALLY active provider", async () => {
  const { effortWithoutSelection, effortPicker, effortEntries, effortWithoutSelectionText, EFFORT_DEFAULT } = await effortModule();
  const t = (text, params = {}) => text.replace(/\{(\w+)\}/g, (_, k) => String(params[k] ?? `{${k}}`));
  // A global provider whose default model carries OTHER levels than the default (low, high).
  const catalog = [
    { id: "claude", defaultModel: "c", models: [{ id: "c" }] },
    { id: "global", defaultModel: "g", models: [{ id: "g", efforts: ["low", "high"] }] },
    { id: "without", defaultModel: "o", caps: { effort: false }, models: [{ id: "o" }] },
  ];
  const standard = effortEntries("", "", catalog, "", "Automatic", t, "global").map((e) => e.id);
  assert.deepEqual(standard, ["", "low", "high"], "\"Default (global)\" offers the levels of the global default model");
  assert.notDeepEqual(standard.slice(1), [...EFFORT_DEFAULT], "... and not the five default levels");
  assert.equal(effortPicker("", "", catalog, "without"), false, "global provider with caps.effort off => no picker");
  assert.equal(effortWithoutSelection("without", "o", catalog), "provider");
  assert.equal(effortWithoutSelection("without", "foreign", catalog), "provider", "the switch also applies to a foreign model");
  assert.equal(effortWithoutSelection("claude", "c", catalog), "", "no caps => unknown => the selection stands");
  assert.equal(effortWithoutSelection("claude", "foreign", catalog), "", "model outside the catalog => the default levels");
  assert.equal(effortWithoutSelection("", "", catalog, ""), "", "nothing loaded yet => fallback, no invented lock");
  assert.equal(effortWithoutSelectionText("provider"), "This provider has no thinking level — /effort sets nothing here.");
  assert.equal(effortWithoutSelectionText("model"), "This model has no thinking levels — /effort sets nothing here.");
  const en = SOURCES.i18n.split("\n");
  for (const set of [effortWithoutSelectionText("provider"), effortWithoutSelectionText("model")]) {
    assert.equal(en.filter((z) => z.trimStart().startsWith(`"${set}":`)).length, 1, `exactly one German row for "${set}"`);
  }

  // The call sites ask the building block and pass it the globally active provider. The agents' level choice:
  assert.match(SOURCES.providerModel, /if \(!catalog\.length \|\| !effortPicker\(provider, model, catalog, active\)\) return null;/, "LevelChoice: no selection without levels");
  assert.match(SOURCES.providerModel, /effortEntries\(provider, model, catalog, effort, effortStandardLabel\(provider, model, catalog, t, active\), t, active\)/, "LevelChoice: \"Default (global)\" = global provider");
  assert.match(SOURCES.workflow, /effortPicker\(run\.provider, run\.model, providers, activeProvider\) && \(/, "workflow run: no selection without levels");
  assert.match(SOURCES.workflow, /effortEntries\(run\.provider, run\.model, providers, run\.effort, effortStandardLabel\(run\.provider, run\.model, providers, t, activeProvider, true\), t, activeProvider\)/, "workflow run: \"Default (global)\" = global provider, label \"As the chat\"");
  assert.match(SOURCES.workflowEditor, /setActiveProvider\(d\.active \|\| ""\)/, "the editor fills it from /api/providers");
  assert.match(SOURCES.workflowEditor, /activeProvider=\{activeProvider\}/, "... and hands it to the modal");

  // `caps` arrives: every web shape through which the catalog goes on its way to a selection carries the field (a whitelist swallowed
  // it without tsc reporting anything).
  const CAPS = "caps?: { effort?: boolean }";
  for (const [location, file] of [
    ["ChatCatalog ProviderMeta", "src/components/chat/ChatCatalog.tsx"],
    ["chatModelChoice allProviders", "src/components/chat/chatModelChoice.ts"],
    // LevelChoice (ProviderModel.tsx) takes `EffortCatalog`.
    ["WorkflowSettings WfeProvider", "src/components/workflow/WorkflowSettings.tsx"],
    ["lib/effort EffortCatalog", "src/lib/effort.ts"],
  ]) assert.ok(read(file).includes(CAPS), `${location} does not carry \`caps\` along`);
});

test("no levels != unknown: empty, missing and carried give the same answer in web and server pair by pair", async () => {
  const { effortFallback, effortNoLevels } = await effortModule();
  const listen = [["empty", []], ["missing", undefined], ["all", [...EFFORT_LEVELS]], ["loch", ["low", "medium", "high", "max"]], ["top", ["xhigh", "max"]]];
  for (const [name, list] of listen) {
    const model = list === undefined ? { id: "m" } : { id: "m", efforts: list };
    const cat = [{ id: "p", defaultModel: "m", models: [model] }];
    for (const level of ["", ...EFFORT_LEVELS, "turbo"]) {
      assert.equal(effortFallback("p", "m", cat, level), effortFallbackServer(level, list), `${name} + "${level}"`);
    }
    assert.equal(effortNoLevels("p", "m", cat), name === "empty", `${name}: noLevels`);
  }
  assert.equal(effortFallbackServer("max", []), "", "empty => no level");
  assert.equal(effortFallbackServer("max", undefined), "max", "missing => pass through");
});

// ── The surfaces: who rejects the level, and from which list the levels come ───────────────
// Both by source text (like composer-contract.test.mjs): what is checked is not a computation but that the three selections ask the
// right source and name the right rejecting party.
const read = (rel) => fs.readFileSync(path.join(webDir, rel), "utf8");
const SOURCES = {
  effort: read("src/lib/effort.ts"),
  i18n: read("src/lib/i18n-de.ts"),
  // The composer draws the entries as a slider in chat/EffortSlider.tsx: the source of the composer is both together.
  composer: read("src/components/chat/ChatComposer.tsx") + read("src/components/chat/EffortSlider.tsx"),
  providerModel: read("src/components/ProviderModel.tsx"),
  // The run settings of the workflow stand in the modal WorkflowSettings.tsx; the editor only loads the providers. The positive anchors
  // read the modal, the NEGATIVE ones both files - a negation that reads only the old file would stay green after the move and prove nothing.
  workflow: read("src/components/workflow/WorkflowSettings.tsx"),
  workflowEditor: read("src/components/workflow/WorkflowEditor.tsx"),
  slash: read("src/components/chat/chatSlash.ts"),
};

// A `t` like in lib/i18n.ts: English returns the key, German the row from i18n-de.ts, and {name} placeholders are replaced. So the
// label is REALLY built - a missing German entry would show English otherwise, and no type error sees that.
const fmt = (text, params) => (params ? text.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m)) : text);
function enRow(key) {
  const header = `"${key}":`;
  const rows = SOURCES.i18n.split("\n").filter((z) => z.trimStart().startsWith(header));
  // Exactly one: a missing key shows English in German, a duplicate breaks the web build (TS1117) - and a test bench afterwards
  // silently measures the old bundle.
  assert.equal(rows.length, 1, `"${key}" has exactly one row in i18n-de.ts`);
  return rows[0].slice(rows[0].indexOf(header) + header.length).trim().replace(/^"/, "").replace(/",?$/, "");
}
const tEn = (key, params) => fmt(key, params);
const tDe = (key, params) => fmt(enRow(key), params);

// A one-line table (`const NAME = { a: 1, b: "x" };`) as an object of strings.
function tableFrom(file, name, location) {
  const m = fs.readFileSync(file, "utf8").match(new RegExp(`^const ${name} = \\{([^}]*)\\};$`, "m"));
  assert.ok(m, `the declaration of ${name} is missing in ${location} - moved, renamed or wrapped? Then adjust this line.`);
  return Object.fromEntries(m[1].split(",").map((pair) => {
    const cut = pair.indexOf(":");
    assert.ok(cut > 0, `${location}: "${pair.trim()}" is not a pair`);
    return [pair.slice(0, cut).trim(), pair.slice(cut + 1).trim().replace(/^"|"$/g, "").replace(/_/g, "")];
  }));
}

test("Who rejects the level stands in the text - and EVERY place names the replacement", async () => {
  const { effortSelection, effortEntryLabel, effortHint, effortMarker } = await effortModule();

  // ── 1. Three rejecting parties, three sentences ────────────────────────────────────────
  // With CODEX the level goes out as `-c model_reasoning_effort` and OpenAI answers HTTP 400 (measured: `max` on gpt-5.5) - there the
  // model really rejects. With CLAUDE the CLI checks the value of `--effort` itself and discards it with a stderr warning (exit 0); the
  // model never sees it. EVERYWHERE ELSE nobody rejects anything: the preset connectors carry all levels in their table (see the guard
  // below) - a level would be marked there only because cbase's own default list does not CARRY it.
  assert.equal(effortMarker("codex"), "not supported by the model");
  // With per-model levels for Claude the MODEL - not the CLI - carries a level or not.
  assert.equal(effortMarker("claude"), "not supported by the model");
  for (const prov of ["openai", "anthropic", "my-company", ""]) {
    assert.equal(effortMarker(prov), "not listed by this provider", `"${prov}" is neither Codex nor the Claude CLI - there the provider rejects, not the model`);
  }
  const sets = new Set(["codex", "claude", "openai"].map((p) => effortHint(p)));
  assert.equal(sets.size, 3, "three rejecting parties, three sentences - one of them is a duplicate");
  for (const prov of ["codex", "claude", "openai"]) {
    assert.ok(effortHint(prov).includes("{effort}"), `the sentence for ${prov} names the chosen level`);
    assert.ok(effortHint(prov).includes("{fallback}"), `the sentence for ${prov} names the replacement - without it it would again be only the loss`);
  }

  // ── 2. Every key stands in lib/effort.ts and has EXACTLY ONE German row ──────────────────
  for (const key of [
    "not supported by the model",
    "not listed by this provider",
    "runs as {fallback}",
    ...["codex", "claude", "openai"].map((p) => effortHint(p)),
  ]) {
    assert.ok(SOURCES.effort.includes(`"${key}"`), `the key "${key}" stands in lib/effort.ts`);
    enRow(key); // checks "exactly one row in i18n-de.ts" and throws otherwise
  }

  // ── 3. The label NAMES the replacement, in both languages ────────────────────────────────
  // Two clients, two statements about the same state would be the failure: the replacement is named in the entry everywhere.
  const catalog = [{ id: "codex", defaultModel: "gpt-5.6-sol", models: CODEX_MODELS.map((m) => ({ id: m.id, efforts: [...m.efforts] })) }];
  const choice = effortSelection("codex", GAP, catalog, "max");
  const uncarried = choice.find((w) => !w.supported);
  assert.ok(uncarried, "the set, uncarried level stays in the selection (otherwise it would jump to a foreign value)");
  assert.equal(uncarried.id, "max");
  assert.equal(uncarried.fallback, codexEffortFallback("max", GAP), "the entry carries the clamp's replacement, not an own one");
  assert.equal(effortEntryLabel(uncarried, tDe), "Max · läuft als X-High");
  assert.equal(effortEntryLabel(uncarried, tEn), "Max · runs as X-High");
  // Carried entries stay bare - "Low · runs as Low" would be noise.
  for (const w of choice.filter((x) => x.supported)) assert.equal(effortEntryLabel(w, tEn), tEn(w.id === "xhigh" ? "X-High" : w.id[0].toUpperCase() + w.id.slice(1)));

  // ── 4. The wiring: all THREE selections label through the same helper ────────────────────
  // Only the ONE building block `effortEntries` (lib/effort.ts) calls it, and every selection takes its entries from there - label
  // (`o.label`/`ef.label`) AND marker (`o.marker`/`ef.marker`). The test "One building block" below holds that no component calls
  // the two helpers itself; here it is held that the building block does.
  const buildingBlock = SOURCES.effort.slice(SOURCES.effort.indexOf("export function effortEntries("));
  assert.ok(buildingBlock.includes("label: effortEntryLabel(w, t)"), "the building block labels through effortEntryLabel - otherwise the replacement stands at only one of the four places");
  // With the RESOLVED provider (`providerName` - "Default (global)" is the globally active one).
  assert.ok(buildingBlock.includes("marker: w.supported ? undefined : t(effortMarker(providerName))"), "the building block also names WHO rejects (tooltip)");
  for (const [location, source] of [["ChatComposer", SOURCES.composer], ["WorkflowSettings", SOURCES.workflow]]) {
    assert.ok(source.includes("effortEntries("), `${location} takes its entries from the building block effortEntries`);
    // The wording (the KEY with placeholder) stands in lib/effort.ts, not three times here. The example "Max · runs as X-High" in the
    // comment beside it is intentional and carries none.
    assert.ok(!source.includes("runs as {fallback}"), `${location} does not write the wording itself - written three times it ages three times`);
    assert.ok(/title=\{(o|ef)\.marker\}/.test(source), `${location} shows WHO rejects (tooltip from the building block)`);
    assert.ok(/>\{(o|ef)\.label\}</.test(source), `${location} shows the building block's label, no own one`);
    assert.ok(!source.includes('"not supported by the model"'), `${location} does not write the marker itself`);
    assert.ok(!source.includes("EFFORT_NOT_SUPPORTED"), `${location} no longer hangs on the fixed marker`);
    // And no inline version beside it: each of the three used to assemble its label itself
    // (`${t(effortLabel(o.id))} (${t(effortMarker(...))})`).
    assert.ok(!/effortLabel\(\w+\.id\)/.test(source), `${location} no longer builds a label from parts`);
  }
  assert.ok(!SOURCES.composer.includes("is not supported by this model —"), "the whole sentence does not stand in the component either");
  // The editor has NO effort selection any more - not even a second, half-forgotten version beside the modal.
  for (const forbidden of ["runs as {fallback}", '"not supported by the model"', "EFFORT_NOT_SUPPORTED", "effortSelection(", "effortEntryLabel(", "effortEntries("]) {
    assert.ok(!SOURCES.workflowEditor.includes(forbidden), `WorkflowEditor.tsx contains "${forbidden}" - the effort selection belongs in the modal WorkflowSettings.tsx`);
  }
  assert.ok(!/effortLabel\(\w+\.id\)/.test(SOURCES.workflowEditor), "WorkflowEditor.tsx builds no effort label from parts");

  // ── 5. The FIFTH place per client: /effort without argument ───────────────────────────────
  // The pickers were not alone. `/effort` reported the STORED level - "Current: **Max**" above a list that does not contain "max",
  // without a word about it, and without saying that X-High thinks. Reachable normally: `/effort max` on Sol, then `/model gpt-5.5`.
  // Both clients now compute through the same helper as their pickers; web showed the label "Max", the iPhone the raw lowercase "max".
  assert.ok(SOURCES.slash.includes("effortEntryLabel("), "/effort labels the current state through the same helper as the pickers");
  assert.ok(SOURCES.slash.includes("effortSelection("), "... and takes the entry from the same selection");
  assert.ok(!SOURCES.slash.includes('.replace("Effort: ", "")'), "/effort no longer dissects a finished button label - that does not know the replacement");
  const iosSlash = fs.readFileSync(SOURCE_IOS_SLASH, "utf8");
  // With the RESOLVED provider (`provider` = set, otherwise the globally active one - old chat). The current state is `current`: the
  // stored level, without one the running default level.
  assert.match(iosSlash, /let current = chat\.effort\.isEmpty \? EffortLevels\.standard\(providers, provider: provider, model: chat\.model\) : chat\.effort/, "mobile: without a stored level the running one (default, clamped)");
  assert.match(iosSlash, /EffortLevels\s*\n?\s*\.selection\(providers, provider: provider, model: chat\.model, current: current\)/, "mobile likewise: the current state comes from EffortLevels.selection, not from the raw value");
  assert.match(iosSlash, /let provider = EffortLevels\.effectiveProvider\(chat\.provider, active: activeProvider\)/, "... with the resolved provider");
  assert.ok(!/"effort": chat\.effort\.isEmpty \? L\("Auto"\) : chat\.effort/.test(iosSlash), "... and no longer as a raw lowercase");
});

test("Presets: what the interface NAMES as replacement, the connector computes too", async () => {
  const { effortFallback } = await effortModule();
  // Every preset connector sends `efforts` per model in /api/providers (the levels THEIR wire sends for this model) - the generic
  // openai-chat ends at high. The interface names its replacement from this list; the binding below checks that the wire sends the
  // same value for the named level as for the requested one that clamps to it.
  // The removed sixth level is none here either: no replacement, no flag.
  assert.equal(effortFallback("openai", "gpt-5", [], "ultra"), "");
  for (const [location, file, name] of PRESETS) {
    const table = tableFrom(file, name, location);
    // The table IS the carrier list there (`WIRE_LEVELS = Object.keys(...)`): if it carries all levels of the order, the clamp hits no
    // real level. If one were missing it would silently fall to another value (budget 0 = no thinking at all). And it carries NOTHING
    // beyond that: a key for the removed sixth level would be a mapping for a value no chat can store any more.
    assert.deepEqual(Object.keys(table), [...EFFORT_LEVELS], `${location}: ${name} does not carry exactly the levels in the order of EFFORT_LEVELS`);
    // Level and value are named alike (no silent mapping xhigh/max => high): what goes out is the clamped level itself - the clamp
    // stands before it, not in the table.
    if (name === "REASONING_EFFORT") for (const level of EFFORT_LEVELS) assert.equal(table[level], level, `${location}: "${level}" goes out as "${table[level]}"`);
  }
  // The GENERIC openai-chat with its clamp to low/medium/high is gone: OpenRouter gets all five (it maps to the step the model carries
  // itself) - so the interface names no replacement and the wire sends the level itself (preset-wire.test.js measures the body). A model
  // entry with `efforts` still takes precedence.
  assert.ok(!/GENERISCHE_LEVELS/.test(fs.readFileSync(PRESETS[0][1], "utf8")), "the generic clamp is back - then its binding here too");
  const catalog = [{ id: "openrouter", models: [{ id: "z-ai/glm-5.3-flash", efforts: [...EFFORT_LEVELS] }] }];
  for (const level of EFFORT_LEVELS) {
    assert.equal(effortFallback("openrouter", "z-ai/glm-5.3-flash", catalog, level), level, `OpenRouter: "${level}" runs as "${level}"`);
  }
});

test("The LEVELS come from the unfiltered provider list, the MODELS from the connected one", () => {
  // Which levels a model carries depends on the model, not the login - the `connected` filtering belongs to the model selection (a
  // model of a signed-out provider would not be startable), not to the level selection. Otherwise the workflow run would stay on the
  // five default levels permanently - "Max" also for gpt-5.5 (HTTP 400). In the workflow the editor LOADS (unfiltered) and the modal
  // filters - the load check therefore applies to the editor, the filter check to the modal.
  for (const [location, loading, filters] of [["WorkflowEditor/-Settings", SOURCES.workflowEditor, SOURCES.workflow]]) {
    assert.ok(!/setProviders\(\(?d\.providers[^\n]*\.filter\(\(p\) => p\.connected\)\)/.test(loading),
      `${location} no longer filters on LOADING - otherwise the level selection also knows only connected ones`);
    assert.ok(/setProviders\(/.test(loading), `${location}: the load spot can no longer be found - adjust the anchor`);
    assert.ok(/\.filter\(\(p\) => p\.connected\)/.test(filters), `${location} still filters - only at the right place`);
  }

  // Workflow modal: levels from `providers` (all), provider/model from `connected`. The negations apply to modal AND editor.
  assert.match(SOURCES.workflow, /const connected = useMemo\(\(\) => providers\.filter\(\(p\) => p\.connected\), \[providers\]\);/, "the modal holds both lists");
  // Via the building block `effortEntries` - the same four first arguments.
  assert.match(SOURCES.workflow, /effortEntries\(run\.provider, run\.model, providers, run\.effort, /, "the levels ask the whole list");
  assert.match(SOURCES.workflowEditor, /providers=\{providers\}/, "the editor hands the modal the UNFILTERED list");
  for (const [location, source] of [["WorkflowSettings", SOURCES.workflow], ["WorkflowEditor", SOURCES.workflowEditor]]) {
    for (const name of ["effortSelection", "effortEntries"]) assert.ok(!source.includes(`${name}(run.provider, run.model, connected`), `${location}: and not the filtered one (${name})`);
    assert.ok(!source.includes("{providers.map((p) => <option"), `${location}: the provider selection takes the filtered list`);
    assert.ok(!/\{providers\.map\(\(p\) => \(\n/.test(source), `${location}: ... likewise the model selection of the closing verdict`);
    assert.ok(!/providers=\{connected\}/.test(source), `${location}: the modal is not handed the filtered list`);
  }

  // (Proposal item and hub - the same separation one level deeper - are gone with the managing surface.)
});

// ── The five-level list ───────────────────────────────────────────────────────────────────
// The sixth level was called something different per provider (for Claude it ran as max, for Codex it switched on its own delegation,
// invisible to cbase) and is removed; Codex' lower steps `none`/`minimal` never offered a choice and should not. The bindings above hold
// the lists AGAINST each other - a removal on all sides at once (or a revival on all sides at once) would stay green there. So here the
// list itself, at every place that carries levels, also where only a source text can be read (iOS, fixture): a Linux runner does not
// run the Swift computation (`macOnly`), it should still see the removal.
test("The five-level list: no place carries ultra, none or minimal as a level - and no selection offers them", async () => {
  const FIVE = ["low", "medium", "high", "xhigh", "max"];
  const GONE = ["ultra", "none", "minimal"];
  const { EFFORT_LEVELS: web, EFFORT_DEFAULT, EFFORT_LABEL, effortEntries } = await effortModule();

  // Order, fallback, label, union - server and web.
  assert.deepEqual([...EFFORT_LEVELS], FIVE, "EFFORT_LEVELS (Server, workflows.js)");
  assert.deepEqual([...web], FIVE, "EFFORT_LEVELS (Web, lib/effort.ts)");
  assert.deepEqual([...EFFORT_DEFAULT], FIVE, "EFFORT_DEFAULT (web fallback)");
  assert.deepEqual(Object.keys(EFFORT_LABEL), FIVE, "EFFORT_LABEL");
  const union = [...fs.readFileSync(SOURCE_WF_API, "utf8").match(/^ {2}effort: ((?:"[^"]*" \| )*"[^"]*");$/m)[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]);
  assert.deepEqual(union, ["", ...FIVE], "the union of the run settings");

  // iOS: order, fallback and label as source text.
  assert.deepEqual(list(SOURCE_IOS, /^\s*static let stages = \[([^\]]*)\]$/m, "Models.swift (stages)"), FIVE, "EffortLevels.stages");
  assert.deepEqual(list(SOURCE_IOS, /^\s*static let preset = \[([^\]]*)\]$/m, "Models.swift (preset)"), FIVE, "EffortLevels.default");
  assert.ok(!/case "(ultra|none|minimal)":/.test(fs.readFileSync(SOURCE_IOS, "utf8")), "EffortLevels.label labels none of the three");

  // The Codex levels: server catalog, web fallback, iOS fixture of the UI tests.
  for (const mo of CODEX_MODELS) for (const g of mo.efforts) assert.ok(FIVE.includes(g), `CODEX_MODELS ${mo.id} carries "${g}"`);
  for (const g of CODEX_EFFORTS) assert.ok(FIVE.includes(g), `CODEX_EFFORTS carries "${g}"`);
  const effortListen = (text) => [...text.matchAll(/efforts: \[([^\]]*)\]/g)].map((m) => m[1].split(",").map((x) => x.trim().replace(/^"|"$/g, "")).filter(Boolean));
  for (const [location, file] of [
    ["ChatCatalog.tsx (Web-Fallback)", path.join(webDir, "src", "components", "chat", "ChatCatalog.tsx")],
    ["routes-chat.mjs (iOS-Fixture)", path.join(repo, "mobile", "test-fixtures", "chat-gateway", "routes-chat.mjs")],
  ]) {
    const listen = effortListen(fs.readFileSync(file, "utf8"));
    assert.ok(listen.length > 0, `${location}: no efforts list found - moved? Then adjust this line.`);
    for (const l of listen) for (const g of l) assert.ok(FIVE.includes(g), `${location} carries "${g}"`);
  }

  // Label keys: none for the removed level, neither in web nor in the iOS tables.
  assert.ok(!/^\s*"Ultra":/m.test(SOURCES.i18n), "i18n-de.ts still carries the key \"Ultra\"");
  const kit = path.join(repo, "mobile", "CbaseMobile", "Kit");
  for (const f of fs.readdirSync(kit).filter((n) => /^LocDE.*\.swift$/.test(n))) {
    assert.ok(!/^\s*"Ultra":/m.test(fs.readFileSync(path.join(kit, f), "utf8")), `${f} carries the key "Ultra"`);
  }

  // No SELECTION offers it: every selection in the web takes its entries from the building block `effortEntries` (ChatComposer,
  // ProviderModel, WorkflowSettings - the wiring is held by "Who rejects the level" and "One building block"), so the computation over
  // every catalog entry and over the fallback is enough - at the building block itself, including the empty entry.
  const catalog = [{ id: "codex", defaultModel: "gpt-5.6-sol", models: CODEX_MODELS.map((m) => ({ id: m.id, efforts: [...m.efforts] })) }];
  const cases = [
    ...CODEX_MODELS.map((m) => ["codex", m.id, catalog]),
    ["codex", "", catalog],
    ["claude", "claude-opus-5", []],
    ["openai", "gpt-5", []],
    ["", "", undefined],
  ];
  for (const [prov, model, cat] of cases) {
    const ids = effortEntries(prov, model, cat, "", "Auto", tEn).map((w) => w.id).filter(Boolean);
    assert.ok(ids.length >= 3, `${prov}/${model}: the selection is empty`);
    for (const gone of GONE) assert.ok(!ids.includes(gone), `${prov}/${model || "(default)"}: the selection offers "${gone}"`);
  }
});

// ── One building block ─────────────────────────────────────────────────────────────────
// Each of the effort selections in the web used to assemble its entries itself: empty entry in front, `effortSelection`,
// `effortEntryLabel`, `effortMarker` - the same wiring three times. Since then `effortEntries` builds the list, and two things hold it:
//
//   1. The ANCHOR: what the three places SHOW, entry by entry (id, label, warning marker, tooltip), in both languages, against rows
//      that were produced with the OLD assembly and are entered here literally - not a comparison of two versions that dies with the
//      second one. "Visibly unchanged" is thereby measured. Later changes (no selection without levels, "Default - <level>",
//      Ultracode) change these rows ON PURPOSE - adjust them here then.
//   2. The SEARCH: no file under web/src except lib/effort.ts calls the components of the list itself. The only named exception is
//      `/effort` without argument (chatSlash.ts): a text, not a selection.
//
// The empty entry carries its own word per place: "Auto" in the composer (untranslated), "Automatisch" in the other two (translated);
// until the later changes a swap is a visible error, and the anchor catches it.
const tDeAsI18n = (key, params) => {
  // Like lib/i18n.ts: a missing German key shows the English one (a non-level like "turbo" has none).
  const header = `"${key}":`;
  return SOURCES.i18n.split("\n").some((z) => z.trimStart().startsWith(header)) ? tDe(key, params) : fmt(key, params);
};
const FIVE_ROWS = ["low|Low||", "medium|Medium||", "high|High||", "xhigh|X-High||", "max|Max||"];
// [provider, model, set] -> the rows AFTER the empty entry, German and English ("id|label|!|marker", "!" = warning-colored/unsupported).
// Produced with the old assembly, then entered literally.
const ANCHOR = [
  [["codex", GAP, "max"],
    [...FIVE_ROWS.slice(0, 4), "max|Max · läuft als X-High|!|vom Modell nicht getragen"],
    [...FIVE_ROWS.slice(0, 4), "max|Max · runs as X-High|!|not supported by the model"]],
  [["codex", GAP, "xhigh"], FIVE_ROWS.slice(0, 4), FIVE_ROWS.slice(0, 4)],
  // An empty model is the provider default (gpt-5.6-sol), not "unknown".
  [["codex", "", ""], FIVE_ROWS, FIVE_ROWS],
  [["codex", "gpt-5.6-sol", "high"], FIVE_ROWS, FIVE_ROWS],
  // Claude without `efforts` in the catalog: the fallback.
  [["claude", "claude-opus-5", "high"], FIVE_ROWS, FIVE_ROWS],
  // A stored non-level stays visible, marked, with the provider's marker - and without replacement in the label.
  [["openai", "gpt-5", "turbo"],
    [...FIVE_ROWS, "turbo|turbo|!|von diesem Anbieter nicht geführt"],
    [...FIVE_ROWS, "turbo|turbo|!|not listed by this provider"]],
  // No provider list yet, no provider: the fallback, nothing invented.
  [["", "", ""], FIVE_ROWS, FIVE_ROWS],
];
// The three places with the word of their empty entry (German, English) and the pattern with which they hand it to the building block.
// `STANDARD`: at the inheriting fields the word is no fixed one any more but "Default - <level>" from `effortStandardLabel` - with the
// same arguments as the list, i.e. the level that thinks for these inputs.
const STANDARD = Symbol("Default · <level>");
// `AS_CHAT`: the run level of a workflow - empty transfers nothing, the chat keeps its level, only a fresh run chat gets the default level:
// "As the chat - new: <level>" (variant `asChat`, same computation).
const AS_CHAT = Symbol("As the chat · new: <level>");
const LOCATIONS = [
  // The composer has NO empty entry any more (`null`) - a chat always carries a level.
  ["ChatComposer", null, null, "composer", /effortEntries\(currentProvider, effectiveModel, effortCatalog, currentEffort, null, t\)/],
  // ProviderModel carries the same form (the proposal item of the managing surface is gone).
  ["ProviderModel", STANDARD, STANDARD, "providerModel", /effortEntries\(provider, model, catalog, effort, effortStandardLabel\(provider, model, catalog, t, active\), t, active\)/],
  ["WorkflowSettings", AS_CHAT, AS_CHAT, "workflow", /effortEntries\(run\.provider, run\.model, providers, run\.effort, effortStandardLabel\(run\.provider, run\.model, providers, t, activeProvider, true\), t, activeProvider\)/],
];

test("One building block: the three selections show what they showed before - entry by entry, in both languages", async () => {
  const { effortEntries, effortStandardLabel } = await effortModule();
  // With default level (max): on the model without max the empty entry names the clamp ("Default · X-High"), on Sol the level.
  const catalog = [{ id: "codex", defaultModel: "gpt-5.6-sol", defaultEffort: "max", models: CODEX_MODELS.map((m) => ({ id: m.id, efforts: [...m.efforts] })) }];
  const row = (e) => `${e.id}|${e.label}|${e.supported ? "" : "!"}|${e.marker ?? ""}`;
  let checked = 0;
  for (const [location, emptyDe, emptyEn, source, pattern] of LOCATIONS) {
    // The word of the empty entry comes from the place - and exactly this word goes into the building block.
    assert.match(SOURCES[source], pattern, `${location} gives the building block its word for the empty entry ("${typeof emptyDe === "symbol" ? emptyDe.description : emptyDe ?? "none"}") and the list it asked before`);
    for (const [[prov, model, set], de, en] of ANCHOR) {
      for (const [language, t, emptyLocation, expected] of [["de", tDeAsI18n, emptyDe, de], ["en", tEn, emptyEn, en]]) {
        const empty = emptyLocation === STANDARD ? effortStandardLabel(prov, model, catalog, t)
          : emptyLocation === AS_CHAT ? effortStandardLabel(prov, model, catalog, t, "", true) : emptyLocation;
        if (emptyLocation === STANDARD && prov === "codex") assert.match(empty, language === "de" ? /^Standard · / : /^Default · /, `${location}: "Default · <level>" (${language}) for ${model || "Default"}`);
        if (emptyLocation === AS_CHAT && prov === "codex") assert.match(empty, language === "de" ? /^Wie der Chat · neu: / : /^As the chat · new: /, `${location}: "As the chat · new: <level>" (${language}) for ${model || "Default"}`);
        const word = language === "en" || emptyDe === null || emptyDe === STANDARD || emptyDe === AS_CHAT ? empty : t(emptyDe);
        assert.equal(word, empty, `${location}: the word of the empty entry (${language})`);
        const holds = effortEntries(prov, model, catalog, set, word, t).map(row);
        const front = empty === null ? [] : [`|${empty}||`];
        assert.deepEqual(holds, [...front, ...expected], `${location} (${language}) for ${prov || "—"}/${model || "Default"}/${set || "empty"}: the selection shows something other than before`);
        checked++;
      }
    }
  }
  // The clamp stands in the label: default max on the model without max thinks with X-High.
  assert.equal(effortStandardLabel("codex", GAP, catalog, tDeAsI18n), "Standard · X-High");
  assert.equal(effortStandardLabel("codex", "", catalog, tDeAsI18n), "Standard · Max", "empty model = default model (Sol)");
  // The run level of a workflow names the same level - as that of a FRESH run chat.
  assert.equal(effortStandardLabel("codex", GAP, catalog, tDeAsI18n, "", true), "Wie der Chat · neu: X-High");
  assert.equal(effortStandardLabel("codex", GAP, catalog, tEn, "", true), "As the chat · new: X-High");
  console.log(`  [effort] building-block anchor: ${checked} selections (${LOCATIONS.length} places x ${ANCHOR.length} cases x 2 languages) as before`);
});

test("One building block: no file under web/src assembles the level list itself", () => {
  // The components of the list - whoever calls one builds a selection beside the building block.
  const COMPONENTS = ["effortSelection(", "effortEntryLabel(", "effortLevels(", "EFFORT_LEVELS", "EFFORT_DEFAULT", "EFFORT_LABEL"];
  // Named exception, with reason: `/effort` without argument answers with TEXT ("Current: ... Choose: ..."), not with a selection.
  const EXCEPTIONS = new Map([["src/components/chat/chatSlash.ts", ["effortSelection(", "effortEntryLabel(", "effortLevels("]]]);
  const withoutComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  const files = [];
  const run = (rel) => {
    for (const e of fs.readdirSync(path.join(webDir, rel), { withFileTypes: true })) {
      const r = path.join(rel, e.name);
      if (e.isDirectory()) run(r);
      else if (/\.(ts|tsx)$/.test(e.name) && r !== path.join("src", "lib", "effort.ts")) files.push(r);
    }
  };
  run("src");
  assert.ok(files.length > 100, `only ${files.length} files found under web/src - does the search still hit?`);
  const findings = [];
  const user = [];
  for (const rel of files) {
    const code = withoutComments(fs.readFileSync(path.join(webDir, rel), "utf8"));
    const allowed = EXCEPTIONS.get(rel.split(path.sep).join("/")) || [];
    for (const b of COMPONENTS) if (code.includes(b) && !allowed.includes(b)) findings.push(`${rel}: ${b}`);
    if (code.includes("effortEntries(")) user.push(path.basename(rel));
  }
  assert.deepEqual(findings, [], "a file builds its effort selection beside the building block effortEntries (lib/effort.ts)");
  // And the exception is one: if nothing of it stands there any more, it should be deleted.
  const slash = withoutComments(SOURCES.slash);
  for (const b of EXCEPTIONS.get("src/components/chat/chatSlash.ts")) assert.ok(slash.includes(b), `chatSlash.ts no longer calls ${b} - delete the exception`);
  for (const [location] of LOCATIONS) assert.ok(user.includes(`${location}.tsx`), `${location} does not take its entries from the building block`);
  console.log(`  [effort] building-block users: ${user.sort().join(", ")} · ${files.length} files searched, ${EXCEPTIONS.size} named exception`);
});

// ── Ultracode: a switch beside the level, not a level (independent of the level) ─────────────────
// The slider carries only the levels; the switch stands below it (kit `Toggle`), also on a model without levels. The bodies are
// separate: a level choice sends only `effort`, the switch only `ultracode` - neither touches the other axis.
// Counter-test: the level body with `ultracode: false` beside it (the old body) turns this test red.
test("Ultracode is a switch: no level of the order, no entry in the slider, separate bodies", async () => {
  const { ULTRACODE, EFFORT_LEVELS: web, effortChoiceBody, ultracodeBody } = await effortModule();
  assert.ok(!web.includes(ULTRACODE) && !EFFORT_LEVELS.includes(ULTRACODE), "the switch stands in no level order");
  assert.deepEqual(effortChoiceBody("high"), { effort: "high", effortChoice: true }, "a level choice leaves the switch alone");
  assert.deepEqual(ultracodeBody(true), { ultracode: true }, "the switch leaves the level alone");
  assert.deepEqual(ultracodeBody(false), { ultracode: false });
  const composer = fs.readFileSync(path.join(webDir, "src", "components", "chat", "ChatComposer.tsx"), "utf8");
  assert.ok(!/ultracodeEntry|ultracodeAbschalter|ULTRACODE\b/.test(composer), "the slider knows no Ultracode entry any more");
  const sheet = composer.slice(composer.indexOf("{effortPickerOpen && ("), composer.indexOf("<CbSendButton"));
  assert.match(sheet, /<Toggle on=\{ultracode\} onClick=\{\(\) => \{ void setUltracode\(!ultracode\); \}\}/, "the sheet carries the switch from the form system");
  assert.ok(sheet.indexOf("<Toggle") > sheet.indexOf("effortChoice.length > 0"), "... below the slider, outside its condition");
  const choice = fs.readFileSync(path.join(webDir, "src", "components", "chat", "chatModelChoice.ts"), "utf8");
  assert.match(choice, /JSON\.stringify\(effortChoiceBody\(id\)\)/, "the coding chat sends the level choice's body");
  assert.match(choice, /JSON\.stringify\(ultracodeBody\(on\)\)/, "... and that of the switch");
  const en = fs.readFileSync(path.join(webDir, "src", "lib", "i18n-de.ts"), "utf8");
  for (const k of ["Ultracode on.", "Ultracode off.", "Multi-agent orchestration without asking — independent of the effort level."]) {
    assert.equal(en.split("\n").filter((z) => z.trimStart().startsWith(`"${k}":`)).length, 1, `exactly one German row for "${k}"`);
  }
});

test("\"Default · <level>\": the empty entry names exactly the level with which runOnce thinks for the same inputs", async () => {
  const { effortDefaultLevel, effortStandardLabel, EFFORT_LABEL } = await effortModule();
  const { effortRunning, effortStandard } = await import("../../server/backend/electron/server/providers/index.js");
  const catalog = [
    { id: "claude", defaultModel: "claude-sonnet-5", defaultEffort: effortStandard("claude"), models: CLAUDE_MODELS.map((m) => ({ id: m.id, efforts: m.efforts })) },
    { id: "codex", defaultModel: "gpt-5.6-sol", defaultEffort: effortStandard("codex"), models: CODEX_MODELS.map((m) => ({ id: m.id, efforts: m.efforts })) },
  ];
  let pairs = 0;
  for (const p of catalog) {
    for (const mo of p.models) {
      assert.equal(effortDefaultLevel(p.id, mo.id, catalog), effortRunning(p.id, mo.id, ""), `${p.id}/${mo.id}: label and run name different levels`);
      pairs++;
    }
  }
  assert.ok(pairs >= 10, `${pairs} pairs checked`);
  const t = (s, v = {}) => s.replace(/\{(\w+)\}/g, (_, k) => String(v[k] ?? ""));
  assert.equal(effortStandardLabel("claude", "claude-sonnet-5", catalog, t), `Default · ${EFFORT_LABEL[effortRunning("claude", "claude-sonnet-5", "")]}`);
  assert.equal(effortStandardLabel("claude", "claude-haiku-4-5-20251001", catalog, t), "Default", "Haiku: no level to name");
  assert.equal(effortStandardLabel("", "", catalog, t, "codex"), `Default · ${EFFORT_LABEL[effortRunning("codex", "gpt-5.6-sol", "")]}`, "an empty provider computes with the active one");
  assert.match(fs.readFileSync(path.join(webDir, "src", "lib", "i18n-de.ts"), "utf8"), /^ {2}"Default · \{level\}": "/m);
});

// Settings -> Providers hides the default-level row when the default model carries no levels (Haiku 4.5) - like the iPhone
// (`EffortSelection.shows`). Before, the row asked only `defaultEffort` and `caps.effort` and showed on Haiku a selection with exactly
// one unchangeable "Medium". Counter-test: deleting the condition `!effortPicker(...)` in `defaultLevelEntries` turns the Haiku case
// red (one entry "Medium").
test("default-level row: none on a default model without levels, none without thinking level, otherwise the model's levels", async () => {
  const { defaultLevelEntries } = await effortModule();
  const t = (s, v = {}) => s.replace(/\{(\w+)\}/g, (_, k) => String(v[k] ?? ""));
  const models = CLAUDE_MODELS.map((m) => ({ id: m.id, efforts: m.efforts }));
  const haiku = CLAUDE_MODELS.find((m) => Array.isArray(m.efforts) && m.efforts.length === 0);
  const withLevels = CLAUDE_MODELS.find((m) => Array.isArray(m.efforts) && m.efforts.includes("medium"));
  assert.ok(haiku && withLevels, "precondition: the catalog knows a model without and one with levels");
  const catalog = [
    { id: "claude", defaultModel: haiku.id, defaultEffort: "medium", models: models },
    { id: "second", defaultModel: withLevels.id, defaultEffort: "medium", models: models },
    { id: "without", defaultModel: "m1", defaultEffort: "medium", caps: { effort: false }, models: [{ id: "m1" }] },
    { id: "empty", defaultModel: "m1", defaultEffort: "", models: [{ id: "m1" }] },
  ];
  assert.deepEqual(defaultLevelEntries(catalog[0], catalog, t), [], "Haiku as default model => no row");
  assert.deepEqual(defaultLevelEntries(catalog[2], catalog, t), [], "caps.effort:false => no row");
  assert.deepEqual(defaultLevelEntries(catalog[3], catalog, t), [], "no default level from the server => no row");
  const second = defaultLevelEntries(catalog[1], catalog, t);
  assert.ok(second.length > 1 && second.every((e) => e.id), "model with levels: a selection, without empty entry");
  assert.ok(second.some((e) => e.id === "medium"));
  // The page asks this function and no condition of its own.
  const source = fs.readFileSync(path.join(webDir, "src", "components", "settings", "ProviderSettings.tsx"), "utf8");
  assert.match(source, /const levels = defaultLevelEntries\(p, catalog, t\);/);
  assert.doesNotMatch(source, /p\.defaultEffort && p\.caps\?\.effort !== false/);
});
