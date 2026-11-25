// Claude's and Codex's model lists come from the CLIs' own account catalogs (providers/native-catalog.js) and reach every
// reader through the connectors (`claudeModels`/`codexModels`) and the registry (`PROVIDERS.<id>.models`, the source of
// /api/providers). The promises: a model the catalog lists appears with its levels, default level and window; a disabled,
// hidden or too-new model never appears; Codex's level above max and unknown levels never become a level; without a catalog
// the static lists hold; the gate keeps a developer machine's real catalogs out of every test server.
//
// Counter-tests (which sabotage turns which test red):
//   - fromClaudeCatalog keeps `disabled` models                              => "Claude catalog" falls;
//   - tooNew always answers false                                            => "Claude catalog" and "Codex catalog" fall;
//   - levelsOf returns the raw list (no cut to EFFORT_LEVELS)                => "Codex catalog" falls ("ultra" stays);
//   - fromCodexCatalog drops the priority sort                               => "Codex catalog" falls (order);
//   - claudeModels() returns CLAUDE_MODELS unconditionally                   => "registry" falls;
//   - codexModels() leaves out the onlyApiKey extras                         => "registry" falls;
//   - the Codex connector's `models` stays the static array (index.js)       => "registry" falls;
//   - check.mjs no longer sets CBASE_NATIVE_CATALOG_OFF                      => "gate" falls;
//   - claudeCliVersion stops at the binary (no package.json walk)          => "CLI version" falls.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { claudeCliVersion, compareVersions, fromClaudeCatalog, fromCodexCatalog, setNativeCatalogsForTests, startNativeCatalogs, claudeCatalogModels } from "../electron/server/providers/native-catalog.js";
import { CLAUDE_MODELS, claudeEfforts } from "../electron/server/providers/connectors/claude.js";
import { CODEX_MODELS, codexContextWindow, codexEfforts, resolveCodexModel } from "../electron/server/providers/connectors/codex.js";
import { PROVIDERS } from "../electron/server/providers/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ALL = ["low", "medium", "high", "xhigh", "max"];

const claudeFile = (models) => ({ version: 2, fetchedAt: Date.now(), catalog: { surface: "cc", config: { id: "cc", models } } });
const CLAUDE = claudeFile([
  { id: "claude-new-9", name: "New 9", runtime: { max_input_tokens: 1000000, effort_levels: ALL, default_effort: "medium" }, thinking: { type: "effort" } },
  { id: "claude-locked", name: "Locked", disabled: true, runtime: { max_input_tokens: 1000000, effort_levels: ALL } },
  { id: "claude-future", name: "Future", min_claude_code_version: "9.0.0", runtime: { effort_levels: ALL } },
  { id: "claude-fits", name: "Fits", min_claude_code_version: "2.1.290", runtime: { max_input_tokens: 500000, effort_levels: ["low", "high", "max", "turbo"], default_effort: "turbo" } },
  { id: "claude-plain", name: "Plain", runtime: { max_input_tokens: 200000 }, thinking: { type: "none" } },
]);
const CODEX = {
  client_version: "0.172.0",
  models: [
    { slug: "gpt-b", display_name: "GPT-7-Beta", priority: 2, visibility: "list", context_window: 272000, max_context_window: 872000,
      default_reasoning_level: "low", supported_reasoning_levels: [{ effort: "low" }, { effort: "max" }, { effort: "ultra" }] },
    { slug: "gpt-a", display_name: "GPT-7.1-Alpha", priority: 1, visibility: "list", context_window: 500000,
      default_reasoning_level: "ultra", supported_reasoning_levels: [{ effort: "medium" }, { effort: "ultra" }] },
    { slug: "gpt-internal", display_name: "Internal", priority: 0, visibility: "hide", supported_reasoning_levels: [{ effort: "low" }] },
    { slug: "gpt-next", display_name: "GPT-8", priority: 0, visibility: "list", minimal_client_version: "0.200.0", supported_reasoning_levels: [] },
  ],
};

test("versions compare numerically", () => {
  assert.ok(compareVersions("2.1.332", "2.1.290") > 0);
  assert.ok(compareVersions("0.172.0", "0.200.0") < 0);
  assert.equal(compareVersions("1.2", "1.2.0"), 0);
});

test("Claude catalog: disabled and too-new models drop, levels are cut to cbase's five, `none` thinking means no levels", () => {
  const list = fromClaudeCatalog(CLAUDE, { cliVersion: "2.1.332" });
  assert.deepEqual(list.map((m) => m.id), ["claude-new-9", "claude-fits", "claude-plain"]);
  assert.deepEqual(list[0], { id: "claude-new-9", label: "New 9", context: 1000000, efforts: ALL, catalogLevel: "medium" });
  assert.deepEqual(list[1].efforts, ["low", "high", "max"], "an unknown level never becomes one");
  assert.ok(!("catalogLevel" in list[1]), "a default outside the model's levels is no catalog level");
  assert.deepEqual(list[2].efforts, [], "no levels — an empty list, not a missing one");
  // An unknown CLI version filters nothing; an older CLI drops the model that needs a newer one.
  assert.ok(fromClaudeCatalog(CLAUDE).some((m) => m.id === "claude-future"));
  assert.ok(!fromClaudeCatalog(CLAUDE, { cliVersion: "2.1.280" }).some((m) => m.id === "claude-fits"));
  assert.equal(fromClaudeCatalog({}), null);
  assert.equal(fromClaudeCatalog(claudeFile([{ id: "x", disabled: true }])), null, "nothing usable is no catalog");
});

test("Codex catalog: priority order, hidden and too-new models drop, the level above max never appears, the largest window", () => {
  const list = fromCodexCatalog(CODEX);
  assert.deepEqual(list.map((m) => m.id), ["gpt-a", "gpt-b"]);
  assert.deepEqual(list[0], { id: "gpt-a", label: "GPT-7.1 Alpha", context: 500000, efforts: ["medium"] });
  assert.deepEqual(list[1], { id: "gpt-b", label: "GPT-7 Beta", context: 872000, efforts: ["low", "max"], catalogLevel: "low" });
  assert.ok(fromCodexCatalog({ ...CODEX, client_version: "0.200.0" }).some((m) => m.id === "gpt-next"));
  assert.equal(fromCodexCatalog({ models: "x" }), null);
});

test("registry: with catalogs on disk every reader sees them; without, the static lists (same reference)", (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "native-catalog-"));
  t.after(() => { setNativeCatalogsForTests({}); fs.rmSync(tmp, { recursive: true, force: true }); });
  const claudeDir = path.join(tmp, ".claude");
  const codexDir = path.join(tmp, ".codex");
  fs.mkdirSync(path.join(claudeDir, "cache", "model-catalog"), { recursive: true });
  fs.mkdirSync(codexDir, { recursive: true });
  // Two organisations: the NEWER fetch is the current login.
  fs.writeFileSync(path.join(claudeDir, "cache", "model-catalog", "old-org-cc.json"),
    JSON.stringify({ ...claudeFile([{ id: "claude-old-only", name: "Old", runtime: {} }]), fetchedAt: 1 }));
  fs.writeFileSync(path.join(claudeDir, "cache", "model-catalog", "new-org-cc.json"), JSON.stringify(CLAUDE));
  fs.writeFileSync(path.join(codexDir, "models_cache.json"), JSON.stringify(CODEX));

  setNativeCatalogsForTests({ claudeDir, codexDir, claudeVersion: "2.1.332" });
  assert.deepEqual(PROVIDERS.claude.models.map((m) => m.id), ["claude-new-9", "claude-fits", "claude-plain"]);
  assert.deepEqual(claudeEfforts("claude-fits"), ["low", "high", "max"], "the clamp reads the same list");
  assert.deepEqual(claudeEfforts("claude-plain"), []);
  const codexIds = PROVIDERS.codex.models.map((m) => m.id);
  assert.deepEqual(codexIds.slice(0, 2), ["gpt-a", "gpt-b"]);
  assert.deepEqual(codexIds.slice(2), CODEX_MODELS.filter((m) => m.onlyApiKey).map((m) => m.id), "the API-key-only models stay");
  assert.deepEqual(codexEfforts("gpt-b"), ["low", "max"]);
  assert.equal(codexContextWindow("gpt-b"), 872000, "the window cbase asks the CLI for");
  assert.equal(resolveCodexModel("gpt-a"), "gpt-a");

  setNativeCatalogsForTests({ claudeDir: path.join(tmp, "missing"), codexDir: path.join(tmp, "missing") });
  assert.equal(PROVIDERS.claude.models, CLAUDE_MODELS, "no catalog: the static list");
  assert.equal(PROVIDERS.codex.models, CODEX_MODELS);
});

test("gate: check.mjs keeps every test server off the real catalogs, and the start honours the switch", (t) => {
  const check = fs.readFileSync(path.join(HERE, "../../../tools/check/targets/check.mjs"), "utf8");
  assert.match(check, /testEnv\.CBASE_NATIVE_CATALOG_OFF = "1";/);
  const before = process.env.CBASE_NATIVE_CATALOG_OFF;
  t.after(() => { if (before === undefined) delete process.env.CBASE_NATIVE_CATALOG_OFF; else process.env.CBASE_NATIVE_CATALOG_OFF = before; setNativeCatalogsForTests({}); });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "native-catalog-off-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  fs.mkdirSync(path.join(tmp, "cache", "model-catalog"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "cache", "model-catalog", "a-cc.json"), JSON.stringify(CLAUDE));
  setNativeCatalogsForTests({});
  process.env.CBASE_NATIVE_CATALOG_OFF = "1";
  startNativeCatalogs({ claudeDir: tmp });
  assert.equal(claudeCatalogModels(), null, "switched off: the start reads nothing");
  delete process.env.CBASE_NATIVE_CATALOG_OFF;
  startNativeCatalogs({ claudeDir: tmp });
  assert.ok(claudeCatalogModels()?.some((m) => m.id === "claude-new-9"), "switched on: the same start reads the catalog");
});

test("CLI version: read from the install layout without starting the CLI (native installer and npm package)", (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "native-catalog-cli-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const native = path.join(tmp, "versions", "2.1.400");
  fs.mkdirSync(path.dirname(native), { recursive: true });
  fs.writeFileSync(native, "");
  fs.symlinkSync(native, path.join(tmp, "claude-native"));
  assert.equal(claudeCliVersion(path.join(tmp, "claude-native")), "2.1.400");
  const pkg = path.join(tmp, "lib", "node_modules", "@anthropic-ai", "claude-code");
  fs.mkdirSync(path.join(pkg, "bin"), { recursive: true });
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-code", version: "2.1.332" }));
  fs.writeFileSync(path.join(pkg, "bin", "claude.exe"), "");
  fs.mkdirSync(path.join(tmp, "bin"));
  fs.symlinkSync(path.join(pkg, "bin", "claude.exe"), path.join(tmp, "bin", "claude"));
  const before = process.env.PATH;
  t.after(() => { process.env.PATH = before; });
  process.env.PATH = path.join(tmp, "bin");
  assert.equal(claudeCliVersion("claude"), "2.1.332", "resolved via PATH, version from the package");
  assert.equal(claudeCliVersion(path.join(tmp, "missing")), "");
  assert.equal(claudeCliVersion(""), "");
});
