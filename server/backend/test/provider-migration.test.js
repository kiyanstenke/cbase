// Only three providers remain — the one-time migration of the store (account/provider-migration.js). Only openrouter/claude/codex
// work; every stored reference to an id the registry no longer knows would run into nothing (`providerForChat` would silently
// fall back to the global provider, which would get a model it does not know). So the seed carries, at EVERY place that stores
// such a reference, one case that migrates and one that stays:
//   • three rows in `providers` — the FIRST OpenRouter row (base host, preset openai-chat, id "or-old") becomes `openrouter`, a
//     second OpenRouter row ("or-two", preset openrouter) and Nebius are removed; plus "fireworks", which only stands in
//     references (the case of a store without a row);
//   • chats (also one without its own provider that followed the global "nebius"), outer-loop agents, agent definitions
//     ("P::…"), run settings of the graph workflows (`provider`/`doneProvider` and the prefix in the model), app agents,
//     default model/effort/account kind, global provider, usage, pending resumes, subagent history;
//   • the price table by hand and Codex zero rows.
// Manager agents and schedules no longer migrate (store/provider.js): the seed creates them from the old-schema seed
// (managing-old-seed.mjs), and the main test holds that they stay.
// Target of a model: the same one at OpenRouter if the catalog lists it with tools (same id ignoring case, otherwise the same name
// part after the last "/") AND a key is set — otherwise Claude with its default model.
//
// Seeding and reading go through a connection of their own (like model-migration.test.js): what is measured is what stands in the
// file. The catalog comes from the test source (providers/openrouter-catalog.js `setCatalogSourceForTests`), in the server test
// from the fake endpoint via `CBASE_OPENROUTER_BASE`.
//
// COUNTER-TESTS: in server.js the dependent migrations pulled BEFORE the provider migration again (`migrateRetiredModels();
// migrateRoleLevelsLater(); migrateAutoChats();` before `migrateProviderAtStart()`, without `afterwards`) => the server test red
// at "the effort is the new provider's" ('high' instead of 'medium': Claude computed the effort of a chat that then migrated to
// OpenRouter). account/provider-migration.js renameJson without `renameModel` (only the fields `provider`/`doneProvider` renamed)
// => the main test red at "wf-or-old-prefix" (`or-old::…` stayed — the reference pointed to a provider that no longer exists).
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import * as store from "../electron/server/store.js";
import { seedOldSchema } from "./managing-old-seed.mjs";
import { startServer } from "../electron/server/server.js";
import { defaultModelFor } from "../electron/server/providers/index.js";
import { catalogReady, setCatalogSourceForTests } from "../electron/server/providers/openrouter-catalog.js";
import {
  PROVIDER_MIGRATION_MARKER, CODEX_ZERO_ROWS_UNTIL, providerPlan, migrateProvider, migrateProviderAtStart, targetFor,
} from "../electron/server/account/provider-migration.js";

const T0 = 1_700_000_000_000; // before CODEX_ZERO_ROWS_UNTIL
const CLAUDE = () => defaultModelFor("claude");
// The catalog (shape of the public API): three models with tools, one without.
const CATALOG = [
  { id: "z-ai/glm-5.2", name: "GLM 5.2", supported_parameters: ["tools", "reasoning"], context_length: 200000 },
  { id: "meta-llama/llama-3.3-70b-instruct", name: "Llama 3.3 70B", supported_parameters: ["tools"], context_length: 131072 },
  { id: "qwen/qwen3-235b-a22b", name: "Qwen3 235B", supported_parameters: ["tools"], context_length: 131072 },
  { id: "mistralai/without-tools", name: "Without tools", supported_parameters: ["temperature"], context_length: 32000 },
];

function cleanUp(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
  catch (e) { console.warn(`cleanup of ${dir} failed (${e.code || e.message}) — test unaffected.`); }
}
const withDb = (dataDir, fn) => {
  const db = new DatabaseSync(path.join(dataDir, "automater.db"));
  try { return fn(db); } finally { db.close(); }
};
// Capture the console.log of a section (the ONE log line of the migration).
function withLog(fn) {
  const rows = [];
  const orig = console.log;
  console.log = (...a) => { rows.push(a.map(String).join(" ")); };
  try { return { value: fn(), rows }; } finally { console.log = orig; }
}

test("targetFor: same id ignoring case, otherwise same name part — only with a key and only models with tools; otherwise Claude with its default", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-provider-target-"));
  store.initStore(root); // the Claude default model reads the settings
  setCatalogSourceForTests(() => CATALOG);
  try {
    const { catalogList } = await import("../electron/server/providers/openrouter-catalog.js");
    await catalogReady();
    const catalog = catalogList();
    const including = { withKey: true, catalog };
    assert.deepEqual(targetFor("Meta-Llama/Llama-3.3-70B-Instruct", including), { provider: "openrouter", model: "meta-llama/llama-3.3-70b-instruct" });
    assert.deepEqual(targetFor("zai-org/GLM-5.2", including), { provider: "openrouter", model: "z-ai/glm-5.2" }, "name part after the last \"/\"");
    assert.deepEqual(targetFor("Qwen/Qwen3-235B-A22B", including), { provider: "openrouter", model: "qwen/qwen3-235b-a22b" });
    assert.deepEqual(targetFor("glm-5.2", including), { provider: "openrouter", model: "z-ai/glm-5.2" }, "without origin in the name");
    assert.deepEqual(targetFor("mistralai/without-tools", including), { provider: "claude", model: CLAUDE() }, "without tools never OpenRouter");
    assert.deepEqual(targetFor("deepseek-ai/DeepSeek-V9", including), { provider: "claude", model: CLAUDE() });
    assert.deepEqual(targetFor("", including), { provider: "claude", model: CLAUDE() });
    assert.deepEqual(targetFor("zai-org/GLM-5.2", { withKey: false, catalog }), { provider: "claude", model: CLAUDE() }, "without a key Claude");
    assert.deepEqual(targetFor("zai-org/GLM-5.2", { withKey: true, catalog: [] }), { provider: "claude", model: CLAUDE() }, "without a catalog Claude");
  } finally { setCatalogSourceForTests(null); cleanUp(root); }
});

// The seed. `withKey`: does the OpenRouter row "or-old" carry a key?
function seed(dataDir, wsPath, { withKey = true } = {}) {
  store.createWorkspace({ id: "ws-aw", name: "AW", path: wsPath, createdAt: T0 });
  const chat = (id, provider, model, effort = "high") => store.createChat({
    id, workspaceId: "ws-aw", title: `Chat ${id}`, provider, model, effort, permissionMode: "bypassPermissions", createdAt: T0, updatedAt: T0,
  });
  chat("c-neb-glm", "nebius", "zai-org/GLM-5.2");
  chat("c-neb-unknown", "nebius", "deepseek-ai/DeepSeek-V9");
  chat("c-neb-empty", "nebius", ""); // without a model: the default model of Nebius counts
  chat("c-or-old", "or-old", "z-ai/glm-5.2"); // the OpenRouter row under a foreign id: renamed, no notice
  chat("c-or-two", "or-two", "z-ai/glm-5.2"); // the SECOND OpenRouter row: removed, the catalog lists its model
  chat("c-fire", "fireworks", "accounts/fireworks/models/kimi-k3"); // without a row, only in references
  chat("c-global", "", ""); // followed the global provider "nebius"
  chat("c-claude", "claude", "claude-opus-5-5");
  store.addMessage("c-neb-glm", "user", "Please check what Nebius used to say.", T0);
  store.setSetting("default_model_nebius", "meta-llama/Llama-3.3-70B-Instruct");
  store.setSetting("default_effort_nebius", "high");
  store.setSetting("account_kind_nebius", "apikey");
  store.setSetting("account_kind_onlykind", "apikey"); // a provider that only its account kind still names
  store.setSetting("default_model_or-old", "z-ai/glm-5.2");
  store.setSetting("default_model_fireworks", "accounts/fireworks/models/kimi-k3");
  store.setSetting("provider", "nebius");
  store.setSetting("usage_prices", JSON.stringify({ "nebius::zai-org/GLM-5.2": { in: 1, out: 2 } }));
  store.setSetting("usage_currency", "€");
  store.setSetting("agent_model_title", JSON.stringify({ provider: "nebius", model: "zai-org/GLM-5.2", effort: "low" }));
  store.setSetting("agent_model_goal", JSON.stringify({ provider: "or-old", model: "z-ai/glm-5.2" }));
  store.setSetting("agent_model_compact", JSON.stringify({ provider: "", model: "or-old::z-ai/glm-5.2" })); // prefix of the renamed row
  store.setSetting("agent_model_classify", JSON.stringify({ provider: "claude", model: "claude-sonnet-5-5" }));
  store.setPendingResume("c-neb-glm", { provider: "nebius", prompt: "further" });
  store.setPendingResume("c-claude", { provider: "claude", prompt: "further" });
  withDb(dataDir, (db) => {
    const pv = db.prepare("INSERT INTO providers (id, label, preset, base_url, api_key, extra_body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    pv.run("or-old", "OpenRouter (old)", "openai-chat", "https://openrouter.ai/api/v1", withKey ? "sk-or-1" : "", JSON.stringify({ provider: { zdr: true } }), T0, T0);
    pv.run("or-two", "OpenRouter two", "openrouter", "https://openrouter.ai/api/v1", "sk-or-2", "{}", T0 + 1, T0 + 1);
    pv.run("nebius", "Nebius", "openai-chat", "https://api.studio.nebius.ai/v1", "sk-neb", "{}", T0 + 2, T0 + 2);
    db.prepare("UPDATE chats SET claude_session_id = 'old-session'").run();
    seedOldSchema(db); // a store from before the teardown: the Managing tables are still there (read-only)
    const ma = db.prepare("INSERT INTO manager_agents (id, workspace_id, name, provider, model, created_at, updated_at) VALUES (?, 'ws-aw', ?, ?, ?, ?, ?)");
    ma.run("ma-neb", "A", "nebius", "zai-org/GLM-5.2", T0, T0);
    ma.run("ma-or-old", "B", "or-old", "qwen/qwen3-235b-a22b", T0, T0);
    ma.run("ma-claude", "C", "claude", "claude-opus-5-5", T0, T0);
    db.prepare("INSERT INTO manager_schedules (id, workspace_id, agent_id, name, provider, model, created_at, updated_at) VALUES ('zp-neb', 'ws-aw', 'ma-neb', 'Z', 'nebius', 'deepseek-ai/DeepSeek-V9', ?, ?)").run(T0, T0);
    db.prepare("INSERT INTO outer_loop_agents (id, workspace_id, name, provider, model, created_at, updated_at) VALUES ('ol-neb', 'ws-aw', 'O', 'nebius', 'zai-org/GLM-5.2', ?, ?)").run(T0, T0);
    const ag = db.prepare("INSERT INTO agents (id, workspace_id, name, model, created_at, updated_at) VALUES (?, 'ws-aw', ?, ?, ?, ?)");
    ag.run("ag-neb", "N", "nebius::zai-org/GLM-5.2", T0, T0);
    ag.run("ag-or-old", "R", "or-old::qwen/qwen3-235b-a22b", T0, T0);
    ag.run("ag-sonnet", "S", "sonnet", T0, T0);
    const wf = db.prepare("INSERT INTO workflows (id, workspace_id, name, run_settings, created_at, updated_at) VALUES (?, 'ws-aw', ?, ?, ?, ?)");
    wf.run("wf-neb", "W1", JSON.stringify({ provider: "nebius", model: "zai-org/GLM-5.2", effort: "high", doneProvider: "nebius", doneModel: "deepseek-ai/DeepSeek-V9" }), T0, T0);
    wf.run("wf-prefix", "W2", JSON.stringify({ provider: "", model: "", doneProvider: "", doneModel: "nebius::Qwen/Qwen3-235B-A22B" }), T0, T0);
    wf.run("wf-or-old", "W3", JSON.stringify({ provider: "or-old", model: "z-ai/glm-5.2" }), T0, T0);
    // The prefix of the RENAMED row: "or-old::…" in the model with an empty provider field.
    wf.run("wf-or-old-prefix", "W5", JSON.stringify({ provider: "", model: "or-old::z-ai/glm-5.2", doneProvider: "", doneModel: "or-old::qwen/qwen3-235b-a22b" }), T0, T0);
    wf.run("wf-mentioned", "W4", JSON.stringify({ provider: "claude", model: "claude-sonnet-5-5", brief: "this used to run on nebius" }), T0, T0);
    const ue = db.prepare("INSERT INTO usage_events (provider, model, input, output, cached, at) VALUES (?, ?, ?, ?, ?, ?)");
    ue.run("nebius", "zai-org/GLM-5.2", 100, 10, 0, T0);
    ue.run("or-old", "z-ai/glm-5.2", 100, 10, 0, T0);
    ue.run("codex", "gpt-6-sol", 0, 0, 0, T0); // zero row before the repair: dropped
    ue.run("codex", "gpt-6-sol", 1200, 40, 0, T0); // real turn: stays
    ue.run("codex", "gpt-6-sol", 0, 0, 0, CODEX_ZERO_ROWS_UNTIL + 1); // booked after the repair (wrong Codex): stays
    ue.run("claude", "claude-opus-5-5", 0, 0, 0, T0); // Claude is not meant
    const sa = db.prepare("INSERT INTO subagents (chat_id, agent_id, provider, model, state, updated_at) VALUES (?, ?, ?, ?, 'finished', ?)");
    sa.run("c-neb-glm", "sub-1", "nebius", "zai-org/GLM-5.2", T0);
    sa.run("c-or-old", "sub-2", "or-old", "z-ai/glm-5.2", T0);
  });
}
function read(dataDir) {
  return withDb(dataDir, (db) => ({
    providers: db.prepare("SELECT id, api_key, extra_body FROM providers ORDER BY id").all().map((r) => ({ ...r })),
    chats: Object.fromEntries(db.prepare("SELECT id, provider, model, claude_session_id FROM chats").all().map((r) => [r.id, [r.provider, r.model, r.claude_session_id]])),
    messages: db.prepare("SELECT chat_id, role, text FROM messages ORDER BY id").all().map((r) => [r.chat_id, r.role, r.text]),
    settings: Object.fromEntries(db.prepare("SELECT key, value FROM app_settings").all().map((r) => [r.key, r.value])),
    rows: Object.fromEntries(["manager_agents", "manager_schedules", "outer_loop_agents"].flatMap((t) =>
      db.prepare(`SELECT id, provider, model FROM ${t}`).all().map((r) => [r.id, [r.provider, r.model]]))),
    agents: Object.fromEntries(db.prepare("SELECT id, model FROM agents").all().map((r) => [r.id, r.model])),
    workflows: Object.fromEntries(db.prepare("SELECT id, run_settings FROM workflows").all().map((r) => [r.id, JSON.parse(r.run_settings)])),
    consumption: db.prepare("SELECT provider, input, at FROM usage_events ORDER BY id").all().map((r) => [r.provider, r.input, r.at]),
    resumptions: db.prepare("SELECT chat_id, provider FROM pending_resumes ORDER BY chat_id").all().map((r) => [r.chat_id, r.provider]),
    subagents: db.prepare("SELECT agent_id, provider FROM subagents ORDER BY agent_id").all().map((r) => [r.agent_id, r.provider]),
  }));
}
const json = (v) => JSON.parse(v);

test("the migration at every place: OpenRouter row renamed, removed providers to OpenRouter (catalog + key) or Claude, notice in the chat, deletions, ONE log line; the second run is a no-op", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-provider-migration-"));
  const dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(root, "ws"), { recursive: true });
  try {
    store.initStore(dataDir);
    seed(dataDir, path.join(root, "ws"));
    setCatalogSourceForTests(() => CATALOG);
    await catalogReady();
    assert.deepEqual(providerPlan(), { rename: "or-old", removed: ["fireworks", "nebius", "onlykind", "or-two"], withKey: true });

    const { value: tally, rows } = withLog(() => migrateProvider());
    const d = read(dataDir);
    const GLM = "z-ai/glm-5.2";
    const LLAMA = "meta-llama/llama-3.3-70b-instruct";
    const QWEN = "qwen/qwen3-235b-a22b";

    // 1. The first OpenRouter row is `openrouter` (key and switch stay); the other rows are gone.
    assert.deepEqual(d.providers, [{ id: "openrouter", api_key: "sk-or-1", extra_body: JSON.stringify({ provider: { zdr: true } }) }]);
    // 2. Chats: target, session discarded (only for the removed), notice only for the removed.
    assert.deepEqual(d.chats, {
      "c-neb-glm": ["openrouter", GLM, null],
      "c-neb-unknown": ["claude", CLAUDE(), null],
      "c-neb-empty": ["openrouter", LLAMA, null],
      "c-or-old": ["openrouter", GLM, "old-session"],
      "c-or-two": ["openrouter", GLM, null],
      "c-fire": ["claude", CLAUDE(), null],
      "c-global": ["openrouter", LLAMA, null],
      "c-claude": ["claude", "claude-opus-5-5", "old-session"],
    });
    const hints = d.messages.filter(([, role]) => role === "hint");
    assert.deepEqual(hints.map(([c]) => c).sort(), ["c-fire", "c-global", "c-neb-empty", "c-neb-glm", "c-neb-unknown", "c-or-two"]);
    const hint = (c) => hints.find(([id]) => id === c)[2];
    assert.equal(hint("c-neb-glm"), "Anbieter Nebius gibt es nicht mehr — dieser Chat läuft jetzt über OpenRouter (GLM 5.2).");
    assert.match(hint("c-neb-unknown"), /^Anbieter Nebius gibt es nicht mehr — dieser Chat läuft jetzt über Claude Code \(/);
    assert.match(hint("c-or-two"), /^Anbieter OpenRouter two gibt es nicht mehr/);
    assert.match(hint("c-fire"), /^Anbieter fireworks gibt es nicht mehr/, "without a row: the id as name");
    assert.ok(d.messages.some(([c, role, text]) => c === "c-neb-glm" && role === "user" && /Nebius used to/.test(text)), "the history stays");
    // Outer loop and agent definitions; manager agents and schedules stay as seeded.
    assert.deepEqual(d.rows, {
      "ma-neb": ["nebius", "zai-org/GLM-5.2"], "ma-or-old": ["or-old", QWEN], "ma-claude": ["claude", "claude-opus-5-5"],
      "zp-neb": ["nebius", "deepseek-ai/DeepSeek-V9"], "ol-neb": ["openrouter", GLM],
    });
    assert.deepEqual(d.agents, { "ag-neb": `openrouter::${GLM}`, "ag-or-old": `openrouter::${QWEN}`, "ag-sonnet": "sonnet" });
    // Run settings: field and prefix; a text that merely mentions the provider stays.
    assert.deepEqual(d.workflows["wf-neb"], { provider: "openrouter", model: GLM, effort: "high", doneProvider: "claude", doneModel: CLAUDE() });
    assert.deepEqual(d.workflows["wf-prefix"], { provider: "", model: "", doneProvider: "openrouter", doneModel: QWEN });
    assert.deepEqual(d.workflows["wf-or-old"], { provider: "openrouter", model: GLM });
    assert.deepEqual(d.workflows["wf-or-old-prefix"], { provider: "", model: "openrouter::z-ai/glm-5.2", doneProvider: "", doneModel: "openrouter::qwen/qwen3-235b-a22b" },
      "the prefix of the renamed row migrates too");
    assert.deepEqual(d.workflows["wf-mentioned"], { provider: "claude", model: "claude-sonnet-5-5", brief: "this used to run on nebius" });
    // Settings: app agents, default model (renamed or deleted), global provider, price table.
    const s = d.settings;
    assert.deepEqual(json(s.agent_model_title), { provider: "openrouter", model: GLM, effort: "low" });
    assert.deepEqual(json(s.agent_model_goal), { provider: "openrouter", model: GLM });
    assert.deepEqual(json(s.agent_model_classify), { provider: "claude", model: "claude-sonnet-5-5" });
    assert.deepEqual(json(s.agent_model_compact), { provider: "", model: "openrouter::z-ai/glm-5.2" }, "the prefix in the app agent");
    assert.equal(s.default_model_openrouter, GLM, "the default model of the renamed row");
    for (const k of ["default_model_nebius", "default_effort_nebius", "account_kind_nebius", "account_kind_onlykind", "default_model_or-old", "default_model_fireworks", "usage_prices", "usage_currency"]) {
      assert.equal(k in s, false, `${k} is deleted`);
    }
    assert.equal(s.provider, "claude", "the global provider \"nebius\" is Claude");
    assert.match(s[PROVIDER_MIGRATION_MARKER] || "", /^\d{4}-/, "the marker is set");
    // Usage: Nebius gone, or-old renamed, Codex zero rows gone only from before the repair; resumes; subagent history.
    assert.deepEqual(d.consumption, [["openrouter", 100, T0], ["codex", 1200, T0], ["codex", 0, CODEX_ZERO_ROWS_UNTIL + 1], ["claude", 0, T0]]);
    assert.deepEqual(d.resumptions, [["c-claude", "claude"]]);
    assert.deepEqual(d.subagents, [["sub-1", "nebius"], ["sub-2", "openrouter"]], "the history stays (the renamed id migrates with it)");

    // ONE log line with everything.
    const log = rows.filter((z) => z.startsWith("[providers]"));
    assert.equal(log.length, 1, rows.join("\n"));
    for (const part of ["OpenRouter row \"or-old\" → \"openrouter\"", "nebius removed: 4 chats (3 → OpenRouter, 1 → Claude)", "or-two removed: 1 chats",
      "fireworks removed: 1 chats (0 → OpenRouter, 1 → Claude)", "global provider → claude", "price table deleted (2 settings)", "1 Codex zero rows deleted"]) {
      assert.ok(log[0].includes(part), `log line names "${part}": ${log[0]}`);
    }
    assert.ok(tally.changed > 0);

    // The second run: the marker holds — nothing changes, no line.
    const second = withLog(() => migrateProvider());
    assert.equal(second.value, null);
    assert.deepEqual(second.rows, []);
    assert.deepEqual(read(dataDir), d);
  } finally {
    setCatalogSourceForTests(null);
    cleanUp(root);
  }
});

test("without a key every chat migrates to Claude even if the catalog lists the model; a store without old data gets no marker", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-provider-without-"));
  const dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(root, "ws"), { recursive: true });
  try {
    store.initStore(dataDir);
    seed(dataDir, path.join(root, "ws"), { withKey: false });
    setCatalogSourceForTests(() => CATALOG);
    await catalogReady();
    withLog(() => migrateProvider());
    const d = read(dataDir);
    for (const c of ["c-neb-glm", "c-neb-empty", "c-or-two", "c-global"]) assert.deepEqual(d.chats[c].slice(0, 2), ["claude", CLAUDE()], c);
    assert.deepEqual(d.chats["c-or-old"].slice(0, 2), ["openrouter", "z-ai/glm-5.2"], "the renamed row stays OpenRouter");

    // A fresh store: nothing to do — no marker, no log.
    const fresh = path.join(root, "fresh");
    fs.mkdirSync(fresh, { recursive: true });
    store.initStore(fresh);
    const empty = withLog(() => migrateProvider());
    assert.equal(empty.value.changed, 0);
    assert.deepEqual(empty.rows, []);
    assert.equal(store.getSetting(PROVIDER_MIGRATION_MARKER, ""), "");
  } finally {
    setCatalogSourceForTests(null);
    cleanUp(root);
  }
});

test("at start: no wait without a reason (everything in the call, `afterwards` behind it); with a removed provider, a key and an empty catalog it waits for the catalog — `afterwards` only after it", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-provider-start-"));
  fs.mkdirSync(path.join(root, "ws"), { recursive: true });
  let sourceRelease = null;
  try {
    // Synchronous: a store without a removed provider.
    fs.mkdirSync(path.join(root, "a"), { recursive: true });
    store.initStore(path.join(root, "a"));
    const followUp = [];
    const p = withLog(() => migrateProviderAtStart({ afterwards: () => followUp.push("afterwards") })).value;
    assert.deepEqual(followUp, ["afterwards"], "in the call, without waiting");
    assert.equal((await p).changed, 0);

    // Waiting: the catalog arrives only when the test releases the source.
    const dataDir = path.join(root, "b");
    fs.mkdirSync(dataDir, { recursive: true });
    store.initStore(dataDir);
    seed(dataDir, path.join(root, "ws"));
    setCatalogSourceForTests(() => new Promise((r) => { sourceRelease = () => r(CATALOG); }));
    const seen = [];
    const start = migrateProviderAtStart({
      waitMs: 2_147_483_647, // no practical deadline: the wait is for the catalog, never for a duration
      afterwards: () => seen.push(store.getChat("c-neb-glm").provider),
    });
    // The catalog was kicked off (the source stands open), nothing has migrated yet, `afterwards` did not run.
    await new Promise((r) => setImmediate(r));
    assert.equal(typeof sourceRelease, "function", "the migration kicked off the catalog");
    assert.equal(store.getChat("c-neb-glm").provider, "nebius");
    assert.deepEqual(seen, []);
    sourceRelease();
    const tally = await withLog(() => start).value;
    assert.equal(tally.removed.find((e) => e.provider === "nebius").toOpenRouter, 3, "with the catalog: three Nebius chats to OpenRouter (one followed the global one)");
    assert.deepEqual(seen, ["openrouter"], "`afterwards` saw the chat already migrated");
  } finally {
    sourceRelease?.();
    setCatalogSourceForTests(null);
    cleanUp(root);
  }
});

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

test("at the server: the first start (Nebius with references, key, no catalog file yet) waits for the catalog, migrates, and the effort migration then computes with the NEW provider", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-provider-server-"));
  const dataRoot = path.join(root, "data-root");
  const dataDir = path.join(dataRoot, "data");
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(root, "ws"), { recursive: true });
  const prior = Object.fromEntries(["CBASE_EMBED_OFFLINE", "CBASE_TRIGGER_POLL", "CBASE_RESTART_GRACE_MS", "CBASE_OPENROUTER_BASE", "HOME"].map((k) => [k, process.env[k]]));
  let modelRetrievals = 0;
  const endpoint = http.createServer((req, res) => {
    if (req.url === "/v1/models") { modelRetrievals++; res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ data: CATALOG })); return; }
    res.writeHead(404); res.end();
  });
  let server;
  try {
    await new Promise((r) => endpoint.listen(0, "127.0.0.1", r));
    process.env.CBASE_EMBED_OFFLINE = "1";
    process.env.CBASE_TRIGGER_POLL = "0";
    process.env.CBASE_RESTART_GRACE_MS = "3600000";
    process.env.CBASE_OPENROUTER_BASE = `http://127.0.0.1:${endpoint.address().port}/v1`;
    process.env.HOME = home; // the effort value of the developer's CLI configuration does not count here
    setCatalogSourceForTests(null);
    fs.mkdirSync(dataDir, { recursive: true });
    store.initStore(dataDir);
    store.createWorkspace({ id: "ws-aw", name: "AW", path: path.join(root, "ws"), createdAt: T0 });
    store.createChat({ id: "c-0a", workspaceId: "ws-aw", title: "K", provider: "nebius", model: "zai-org/GLM-5.2", effort: "", createdAt: T0, updatedAt: T0 });
    withDb(dataDir, (db) => {
      const pv = db.prepare("INSERT INTO providers (id, label, preset, base_url, api_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
      pv.run("openrouter", "OpenRouter", "openrouter", "https://openrouter.ai/api/v1", "sk-or-k", T0, T0);
      pv.run("nebius", "Nebius", "openai-chat", "https://api.studio.nebius.ai/v1", "sk-neb", T0 + 1, T0 + 1);
    });
    assert.equal(fs.existsSync(path.join(dataDir, "openrouter-catalog.json")), false, "no catalog file yet");
    const port = await freePort();
    server = await startServer({ port, dataRoot, webDir: path.join(root, "web"), pickDirectory: null, notify: null });
    assert.equal(modelRetrievals, 1, "the start fetched the catalog");
    const response = await fetch(`http://127.0.0.1:${port}/api/chats/c-0a`);
    const chat = await response.json();
    assert.equal(response.status, 200, JSON.stringify(chat).slice(0, 300));
    assert.deepEqual([chat.provider, chat.model], ["openrouter", "z-ai/glm-5.2"], "migrated BEFORE the server listens");
    assert.equal(chat.effort, "medium", "the effort is the new provider's (OpenRouter without a catalog effort: medium)");
    const hints = withDb(dataDir, (db) => db.prepare("SELECT text FROM messages WHERE chat_id = 'c-0a' AND role = 'hint' ORDER BY id").all().map((r) => r.text));
    assert.match(hints[0], /^Anbieter Nebius gibt es nicht mehr — dieser Chat läuft jetzt über OpenRouter \(GLM 5\.2\)/, "the provider first …");
    assert.equal(hints.length, 2, `… then the effort: ${JSON.stringify(hints)}`);
    assert.match(store.getSetting(PROVIDER_MIGRATION_MARKER, ""), /^\d{4}-/);
  } finally {
    if (server) { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
    endpoint.closeAllConnections?.(); await new Promise((r) => endpoint.close(r));
    for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    cleanUp(root);
  }
});
