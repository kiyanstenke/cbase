// "Auto" is gone: the migration `chats/auto-gone.js:migrateAutoChats` gives every chat without a level, ONCE, the level
// it really runs with today: for Claude the `effortLevel` from `~/.claude/settings.json`, for Codex
// `model_reasoning_effort` from `~/.codex/config.toml` (TOML!), otherwise the catalog level of its model; OpenRouter gets
// the default level plus ONE hint line. Clamped to the model — Haiku 4.5 (no levels) keeps ''. Marker `migration.effort_auto_gone`.
//
// HOME is set (never a path): the migration reads from the home of the running server. The migration itself runs without a
// server (`initStore` rebinds the module-wide `db` per store); the wiring into server start and the chat route
// (`{effort: ""}` ⇒ 400, `{}` ⇒ unchanged) is tested on a real server.
//
// Counter-tests: the call `migrateAutoChats()` in server.js commented out ⇒ the server test turns red (empty chats stay
// empty); the 400 line in chats/routes.js removed ⇒ the same test turns red (empty is silently saved).
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import * as store from "../electron/server/store.js";
import { startServer } from "../electron/server/server.js";
import { defaultModelFor, effortCatalogLevel, effortStandard, getConnector } from "../electron/server/providers/index.js";
import { replaceOpenRouter } from "./openrouter-spy.mjs";
import { AUTO_GONE_MARKER, ROLES_AFTER_MARKER, codexReasoningEffort, levelFromConfig, migrateAutoChats, tomlValues } from "../electron/server/chats/auto-gone.js";
import { GAP, enterGapsModel } from "./gaps-model.mjs";

// A Codex chat on a non-default model with its own catalog level (xhigh): the test model from gaps-model.mjs, registered
// for the whole file (all tests run in the test process).
test.after(enterGapsModel());

const ID = {
  sonnet: "00000000-0000-4000-8000-0000000000a1",
  opus55: "00000000-0000-4000-8000-0000000000a2",
  haiku: "00000000-0000-4000-8000-0000000000a3",
  withoutModel: "00000000-0000-4000-8000-0000000000a4",
  sol: "00000000-0000-4000-8000-0000000000a5",
  gap: "00000000-0000-4000-8000-0000000000a6",
  set: "00000000-0000-4000-8000-0000000000a7",
  foreign: "00000000-0000-4000-8000-0000000000a8",
};
const NAME = Object.fromEntries(Object.entries(ID).map(([n, id]) => [id, n]));

function cleanUp(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
  catch (e) { console.warn(`Cleanup of ${dir} failed (${e.code || e.message}) — test unaffected.`); }
}
// Raw over its own connection: what is measured is what sits in the file.
function raw(dataDir) {
  const db = new DatabaseSync(path.join(dataDir, "automater.db"));
  try {
    return {
      effort: Object.fromEntries(db.prepare("SELECT id, effort FROM chats").all().map((r) => [NAME[r.id] || r.id, r.effort])),
      updated: Object.fromEntries(db.prepare("SELECT id, updated_at FROM chats").all().map((r) => [NAME[r.id] || r.id, r.updated_at])),
      hints: db.prepare("SELECT chat_id, text FROM messages WHERE role = 'hint' ORDER BY id").all().map((r) => [NAME[r.chat_id], r.text]),
    };
  } finally { db.close(); }
}

// Environment: HOME on a throwaway home, the two precedence variables of the CLIs deleted — otherwise the migration would
// read the developer's files.
function withHome(root, files) {
  const home = path.join(root, "home");
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
    fs.writeFileSync(path.join(home, rel), text);
  }
  fs.mkdirSync(home, { recursive: true });
  const prior = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME };
  process.env.HOME = home;
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CODEX_HOME;
  return () => { for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
}

const T0 = 1_700_000_000_000;
function seed(wsPath) {
  store.createWorkspace({ id: "ws-auto", name: "Auto", path: wsPath, createdAt: T0 });
  const chat = (id, provider, model, effort) => store.createChat({
    id, workspaceId: "ws-auto", title: `Chat ${NAME[id]}`, provider, model, effort, permissionMode: "bypassPermissions", createdAt: T0, updatedAt: T0,
  });
  chat(ID.sonnet, "claude", "claude-sonnet-5", "");
  chat(ID.opus55, "claude", "claude-opus-5-5", "");
  chat(ID.haiku, "claude", "claude-haiku-4-5-20251001", "");
  chat(ID.withoutModel, "claude", "", "");
  chat(ID.sol, "codex", "gpt-5.6-sol", "");
  chat(ID.gap, "codex", GAP, "");
  chat(ID.set, "claude", "claude-sonnet-5", "low");
  chat(ID.foreign, "openrouter", "m1", "");
  for (const id of Object.values(ID)) store.updateChat(id, { titled: 1 });
}
// The HTTP provider (only OpenRouter, built in): a spy from the same factory replaces it with a model m1 of its own
// (openrouter-spy.mjs) and restores it afterwards.
function withForeignProvider() {
  return replaceOpenRouter({ models: [{ id: "m1", label: "M1" }] });
}

test("rule for values outside the order: ultra ⇒ max, Codex minimal/none ⇒ low, anything else ⇒ no value", () => {
  for (const g of ["low", "medium", "high", "xhigh", "max"]) {
    assert.equal(levelFromConfig(g, "claude"), g);
    assert.equal(levelFromConfig(` ${g.toUpperCase()} `, "codex"), g, "case and surrounding whitespace do not matter");
  }
  assert.equal(levelFromConfig("ultra", "claude"), "max", "ultra ⇒ max");
  assert.equal(levelFromConfig("ultra", "codex"), "max");
  assert.equal(levelFromConfig("minimal", "codex"), "low", "Codex: below low ⇒ the smallest offered step");
  assert.equal(levelFromConfig("none", "codex"), "low");
  assert.equal(levelFromConfig("minimal", "claude"), "", "Claude ignores the word — the default applies");
  for (const w of ["auto", "turbo", "", null, undefined, 3]) assert.equal(levelFromConfig(w, "codex"), "", `no level: ${String(w)}`);
});

test("Codex configuration is TOML: top level, profile takes precedence, tables and comments do not interfere", () => {
  const toml = [
    "# comment",
    'model = "gpt-5.6-sol"',
    'model_reasoning_effort = "low" # a comment behind it',
    "",
    "[mcp_servers.cbase]",
    'command = "node"',
    'model_reasoning_effort = "max"',
    "[profiles.\"fast\"]",
    "model_reasoning_effort = 'minimal'",
  ].join("\n");
  const w = tomlValues(toml);
  assert.equal(w.get("model_reasoning_effort"), "low");
  assert.equal(w.get("mcp_servers.cbase.model_reasoning_effort"), "max", "a key in a table is not the top-level one");
  assert.equal(w.get("profiles.fast.model_reasoning_effort"), "minimal");
  assert.throws(() => JSON.parse(toml), "precondition: a JSON parser would fail here");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-t14-toml-"));
  const back = withHome(root, { ".codex/config.toml": `profile = "fast"\n${toml}` });
  try {
    assert.equal(codexReasoningEffort(), "minimal", "the chosen profile takes precedence over the top level — like `codex` without --profile");
  } finally { back(); cleanUp(root); }
});

test("migration: Claude chats get effortLevel, Codex chats model_reasoning_effort, clamped; third-party gets the default level with exactly one hint line; marker", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-t14-migration-"));
  const dataDir = path.join(root, "data");
  const back = withHome(root, {
    ".claude/settings.json": JSON.stringify({ effortLevel: "high", model: "sonnet" }),
    ".codex/config.toml": 'model = "gpt-5.6-sol"\nmodel_reasoning_effort = "low"\n[mcp_servers.x]\ncommand = "node"\n',
  });
  const way = withForeignProvider();
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    store.initStore(dataDir);
    seed(path.join(root, "ws"));
    const prior = raw(dataDir);

    const tally = migrateAutoChats();
    const after = raw(dataDir);
    assert.deepEqual(after.effort, {
      sonnet: "high", opus55: "high", withoutModel: "high", // Claude: effortLevel from the user settings
      haiku: "", // no levels: the clamp yields none
      sol: "low", gap: "low", // Codex: model_reasoning_effort from the TOML file
      set: "low", // a set level stays
      foreign: "medium", // third party: default level (medium without catalog)
    });
    assert.deepEqual(after.hints, [["foreign", "Denkgrad jetzt medium (vorher: keiner)"]], "exactly ONE hint line, only on the third-party chat");
    assert.deepEqual(tally, { chats: 6, hints: 1 });
    assert.deepEqual(after.updated, prior.updated, "the migration is no user change — the chat list does not re-sort");
    const marker = store.getSetting(AUTO_GONE_MARKER, "");
    assert.match(marker, /^\d{4}-\d\d-\d\dT/, "the marker is set");

    // A second start changes nothing; a level set afterwards survives it, and a chat created EMPTY afterwards
    // (it thinks with the default level) does not get the CLI configuration's value.
    store.updateChat(ID.sonnet, { effort: "max" });
    store.updateChat(ID.sol, { effort: "" });
    assert.equal(migrateAutoChats(), null, "marker ⇒ no-op");
    const second = raw(dataDir);
    assert.equal(second.effort.sonnet, "max", "set after the migration ⇒ survives");
    assert.equal(second.effort.sol, "", "empty after the migration ⇒ stays empty (runtime: default level)");
    assert.deepEqual(second.hints, after.hints, "no second hint line");
    assert.equal(store.getSetting(AUTO_GONE_MARKER, ""), marker);
  } finally { way(); back(); cleanUp(root); }
});

test("migration without configuration values: default level — or the catalog level of the own model, which is what the CLI runs without any value; a broken file is no value", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-t14-without-"));
  const dataDir = path.join(root, "data");
  // Claude: broken JSON; Codex: a word that is no level.
  const back = withHome(root, { ".claude/settings.json": "{ broken", ".codex/config.toml": 'model_reasoning_effort = "turbo"\n' });
  const way = withForeignProvider();
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    store.initStore(dataDir);
    seed(path.join(root, "ws"));
    migrateAutoChats();
    const e = raw(dataDir).effort;
    // Sonnet 5 is no longer the default model (Sonnet 5.5): a chat on it gets ITS catalog level. The case "own level vs
    // default" is separated by Opus 5.5 (medium against the fallback level high, DEFAULT_EFFORT_FALLBACK) — Sonnet 5 carries
    // the same level as the default. The chat without a model stands for the default model.
    assert.equal(e.sonnet, "high", "Claude, Sonnet 5 (no longer default): ITS catalog level high");
    // The chat without a model ran without --effort until the migration, i.e. with the catalog level of the default MODEL
    // (Sonnet 5.5: medium) — it gets that, not the fallback level high with which a new chat without a level thinks
    // (DEFAULT_EFFORT_FALLBACK).
    assert.equal(e.withoutModel, effortCatalogLevel("claude", defaultModelFor("claude")), "Claude, default model: the catalog level of the default model");
    assert.equal(e.withoutModel, "medium");
    assert.equal(e.sol, effortStandard("codex"), "Codex, default model: the default level");
    assert.equal(e.gap, "xhigh", "Codex on another model: ITS catalog level");
    assert.equal(e.opus55, "medium", "Opus 5.5 ran without --effort with ITS catalog level medium — not with the default high");
    assert.notEqual(e.opus55, effortStandard("claude"), "precondition: the case distinguishes own level and default");
    assert.equal(e.haiku, "");
    assert.equal(e.foreign, "medium");
    assert.deepEqual(raw(dataDir).hints, [["foreign", "Denkgrad jetzt medium (vorher: keiner)"]]);
  } finally { way(); back(); cleanUp(root); }
});

// ── On the real server: the migration is part of the start, and the chat route no longer knows "empty" ─────────────
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

test("server start migrates the empty chats (home of the server); chat PATCH {effort: \"\"} ⇒ 400, {} ⇒ unchanged", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-t14-server-"));
  const dataRoot = path.join(root, "data-root");
  const back = withHome(root, {
    ".claude/settings.json": JSON.stringify({ effortLevel: "xhigh" }),
    ".codex/config.toml": 'model_reasoning_effort = "high"\n',
  });
  const prior = { CBASE_EMBED_OFFLINE: process.env.CBASE_EMBED_OFFLINE, CBASE_TRIGGER_POLL: process.env.CBASE_TRIGGER_POLL, CBASE_RESTART_GRACE_MS: process.env.CBASE_RESTART_GRACE_MS };
  process.env.CBASE_EMBED_OFFLINE = "1";
  process.env.CBASE_TRIGGER_POLL = "0";
  process.env.CBASE_RESTART_GRACE_MS = "3600000"; // no restart tick in this test
  let server;
  try {
    const wsPath = path.join(root, "ws");
    fs.mkdirSync(wsPath, { recursive: true });
    fs.mkdirSync(path.join(dataRoot, "data"), { recursive: true });
    store.initStore(path.join(dataRoot, "data"));
    seed(wsPath);
    const port = await freePort();
    server = await startServer({ port, dataRoot, webDir: path.join(root, "web"), pickDirectory: null, notify: null });
    const base = `http://127.0.0.1:${port}`;
    const patch = (id, body) => fetch(`${base}/api/chats/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

    const e = raw(path.join(dataRoot, "data")).effort;
    assert.equal(e.sonnet, "xhigh", "Claude: effortLevel from the home of the server");
    assert.equal(e.sol, "high", "Codex: model_reasoning_effort from the home of the server");
    assert.equal(e.gap, "high");
    assert.equal(e.haiku, "");
    assert.match(store.getSetting(AUTO_GONE_MARKER, ""), /^\d{4}-/, "the marker is set after the start");
    assert.equal(store.getSetting(ROLES_AFTER_MARKER, ""), "", "fresh store: no follow-up migration, no marker (otherwise one more app_settings row in every golden)");

    const empty = await patch(ID.sonnet, { effort: "" });
    assert.equal(empty.status, 400, "empty is no longer a choice");
    assert.match((await empty.json()).error, /Denkgrad/);
    assert.equal(store.getChat(ID.sonnet).effort, "xhigh", "… and nothing was saved");
    const without = await patch(ID.sonnet, { title: "Renamed" });
    assert.equal(without.status, 200);
    assert.equal(store.getChat(ID.sonnet).effort, "xhigh", "missing field ⇒ unchanged");
    assert.equal((await patch(ID.sonnet, { effort: "low" })).status, 200);
    assert.equal(store.getChat(ID.sonnet).effort, "low");
  } finally {
    if (server) { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
    for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    back();
    cleanUp(root);
  }
});

// ── No "Thinking level now …" where no level goes onto the wire ───────────────────────────────────────────────
// A connector with `caps.effort: false` sends no level (`mergedCaps.effort` in the openai-chat wire). The migration may
// store the level for it — but the hint line would claim a change that does not happen; and /api/providers names no
// default level there. None of the three providers carries `caps.effort: false` today (the contract still allows it): the
// spy replaces OpenRouter once WITH and once WITHOUT a level.
// Counter-tests: `levelOnWire(provider) &&` dropped in migrateAutoChats ⇒ test 1 red (two hint lines);
// `levelOnWire(pv.id) ? … : ""` in account/routes.js replaced by `effortStandard(pv.id)` ⇒ test 2 red ("medium").
const F18_CHAT = "00000000-0000-4000-8000-0000000000c1";
function withProviderWithoutLevel() {
  return replaceOpenRouter({ models: [{ id: "m1", label: "M1" }], caps: { effort: false } });
}

test("migration: a provider with caps.effort:false gets the level stored but NO hint line", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-f18-migration-"));
  const dataDir = path.join(root, "data");
  const back = withHome(root, {});
  const way = withProviderWithoutLevel();
  try {
    assert.equal(getConnector("openrouter").caps.effort, false, "precondition: the provider switches caps.effort off");
    fs.mkdirSync(dataDir, { recursive: true });
    store.initStore(dataDir);
    seed(path.join(root, "ws"));
    store.createChat({ id: F18_CHAT, workspaceId: "ws-auto", title: "No level on the wire", provider: "openrouter", model: "m1", effort: "", permissionMode: "bypassPermissions", createdAt: T0, updatedAt: T0 });
    const tally = migrateAutoChats();
    const after = raw(dataDir);
    assert.equal(after.effort[F18_CHAT], "medium", "the level may stay stored");
    assert.equal(after.effort.foreign, "medium", "also on the second chat of the same provider");
    assert.deepEqual(after.hints, [], "no level on the wire ⇒ no line (with a level it is there — see the \"migration\" test above)");
    assert.equal(tally.hints, 0);
  } finally { way(); back(); cleanUp(root); }
});

test("/api/providers reports defaultEffort \"\" for caps.effort:false — and the default level otherwise", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-f18-providers-"));
  const dataRoot = path.join(root, "data-root");
  const back = withHome(root, {});
  const names = ["CBASE_EMBED_OFFLINE", "CBASE_TRIGGER_POLL", "CBASE_RESTART_GRACE_MS", "CLAUDE_BIN", "CODEX_BIN"];
  const prior = Object.fromEntries(names.map((k) => [k, process.env[k]]));
  process.env.CBASE_EMBED_OFFLINE = "1";
  process.env.CBASE_TRIGGER_POLL = "0";
  process.env.CBASE_RESTART_GRACE_MS = "3600000";
  process.env.CLAUDE_BIN = path.join(root, "claude-exists-not");
  process.env.CODEX_BIN = path.join(root, "codex-exists-not");
  let way = withProviderWithoutLevel();
  let server;
  try {
    const port = await freePort();
    server = await startServer({ port, dataRoot, webDir: path.join(root, "web"), pickDirectory: null, notify: null });
    const providers = async () => (await (await fetch(`http://127.0.0.1:${port}/api/providers`)).json()).providers;
    const from = (list, id) => list.find((p) => p.id === id);
    const without = await providers();
    assert.equal(from(without, "openrouter")?.defaultEffort, "", "no level on the wire ⇒ no default level");
    assert.equal(from(without, "claude")?.defaultEffort, effortStandard("claude"));
    way();
    way = withForeignProvider();
    assert.equal(from(await providers(), "openrouter")?.defaultEffort, "medium", "with level: the default (medium without catalog)");
  } finally {
    if (server) { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
    way();
    for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    back();
    cleanUp(root);
  }
});
