// Retired models migrate to their successor (gpt-5.5 -> gpt-6-sol; `account/model-migration.js`).
//
// gpt-5.5 is struck from `CODEX_MODELS` (OpenAI retires it on 14.10.2026). A stored reference would otherwise lead nowhere:
// `resolveCodexModel` passes it to the CLI (which rejects it after the retirement), `codexEfforts` no longer clamps its `max`
// (HTTP 400 even before). The migration re-hangs it ONCE: chats (with a hint line, swept at EVERY start), default model, app
// agents, outer-loop agents, agent definitions, run settings of the workflows, and only where the name really means Codex.
// Manager agents and schedules NOT any more (store/model-migration.js): their rows in an old store stay byte-equal, and a fresh
// store has no such tables. So they are seeded from the old-schema seed (managing-old-seed.mjs).
//
// The migration runs without a server (`initStore` rebinds the module-wide `db` per store); the wiring into the start is
// tested at the real server. Seeding goes through a connection of its own: what is measured is what stands in the file.
//
// Counter-tests (each run once):
//   - the call in server.js removed => the server test red (the chat still stands on gpt-5.5 after the start);
//   - `sweepChats` moved behind the marker (once instead of at every start) => the test "written later" red;
//   - `newReference` without a look at the provider (every bare name migrates) => the main test red (third-party and Claude
//     rows migrate along).
//
// Runtime: after the migration nothing held; a client with an old state could save gpt-5.5 again, and until the next start it
// went raw to the CLI (with "max" HTTP 400). Since then `resolveCodexModel`, `defaultModelFor` and `resolveAgentModel` map an old
// name to the successor, from the SAME table (providers/retired.js). Counter-test: the test "runtime ..." is red without the leaf
// (with only the table there: `-m gpt-5.5`, default gpt-5.6-sol, "codex::gpt-5.5" throws).
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import * as store from "../electron/server/store.js";
import { startServer } from "../electron/server/server.js";
import { defaultModelFor, effortRunning } from "../electron/server/providers/index.js";
import { replaceOpenRouter } from "./openrouter-spy.mjs";
import { RETIRED_MODELS, modelGoneMarker, newReference, migrateRetiredModels } from "../electron/server/account/model-migration.js";
import * as retired from "../electron/server/providers/retired.js";
import { buildCodexChatArgs, buildCodexOnceArgs, resolveCodexModel } from "../electron/server/providers/connectors/codex.js";
import { resolveAgentModel } from "../electron/server/dynworkflows/model.js";
import { seedOldSchema } from "./managing-old-seed.mjs";

const G55 = RETIRED_MODELS.find((e) => e.old === "gpt-5.5");
const MARKER = modelGoneMarker(G55);
const T0 = 1_700_000_000_000;

function cleanUp(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
  catch (e) { console.warn(`Cleanup of ${dir} failed (${e.code || e.message}); test unaffected.`); }
}
const withDb = (dataDir, fn) => {
  const db = new DatabaseSync(path.join(dataDir, "automater.db"));
  try { return fn(db); } finally { db.close(); }
};
// Another provider that carries a "gpt-5.5" of its own in its catalog: OpenRouter; a spy replaces the built-in one with exactly
// this model (openrouter-spy.mjs).
function withForeignProvider() {
  return replaceOpenRouter({ models: [{ id: "gpt-5.5", label: "Foreign 5.5" }] });
}

// The seed: for every place a case that migrates and one that stays.
function seed(dataDir, wsPath) {
  store.createWorkspace({ id: "ws-mw", name: "MW", path: wsPath, createdAt: T0 });
  const chat = (id, provider, model, effort = "high") => store.createChat({
    id, workspaceId: "ws-mw", title: `Chat ${id}`, provider, model, effort, permissionMode: "bypassPermissions", createdAt: T0, updatedAt: T0,
  });
  chat("c-g55", "codex", "gpt-5.5", "max");
  chat("c-sol", "codex", "gpt-5.6-sol");
  chat("c-claude", "claude", "gpt-5.5"); // Nonsense, but not ours: an explicitly other provider stays
  chat("c-foreign", "openrouter", "gpt-5.5");
  chat("c-similar", "codex", "gpt-5.5-mini");
  store.setSetting("default_model_codex", "gpt-5.5");
  store.setSetting("default_model_openrouter", "gpt-5.5");
  store.setSetting("agent_model_title", JSON.stringify({ provider: "codex", model: "gpt-5.5", effort: "low" }));
  store.setSetting("agent_model_classify", JSON.stringify({ provider: "openrouter", model: "gpt-5.5" }));
  store.setSetting("agent_model_goal", JSON.stringify({ provider: "claude", model: "claude-sonnet-5" }));
  store.setSetting("note_gpt-5.5", "gpt-5.5"); // no model key: stays
  withDb(dataDir, (db) => {
    seedOldSchema(db); // a store from before the removal of Managing: the manager tables still stand
    const ma = db.prepare("INSERT INTO manager_agents (id, workspace_id, name, provider, model, created_at, updated_at) VALUES (?, 'ws-mw', ?, ?, ?, ?, ?)");
    ma.run("ma-codex", "A", "codex", "gpt-5.5", T0, T0);
    ma.run("ma-empty", "B", "", "gpt-5.5", T0, T0); // without a provider, only Codex knows the name (in the test without a foreign provider)
    ma.run("ma-claude", "C", "claude", "claude-opus-5-5", T0, T0);
    const zp = db.prepare("INSERT INTO manager_schedules (id, workspace_id, agent_id, name, provider, model, created_at, updated_at) VALUES (?, 'ws-mw', 'ma-codex', ?, ?, ?, ?, ?)");
    zp.run("zp-1", "Z", "codex", "gpt-5.5", T0, T0);
    db.prepare("INSERT INTO outer_loop_agents (id, workspace_id, name, provider, model, created_at, updated_at) VALUES ('ol-1', 'ws-mw', 'O', 'codex', 'gpt-5.5', ?, ?)").run(T0, T0);
    const ag = db.prepare("INSERT INTO agents (id, workspace_id, name, model, created_at, updated_at) VALUES (?, 'ws-mw', ?, ?, ?, ?)");
    ag.run("ag-prefix", "P", "codex::gpt-5.5", T0, T0);
    ag.run("ag-bare", "N", "gpt-5.5", T0, T0);
    ag.run("ag-sonnet", "S", "sonnet", T0, T0);
    const wf = db.prepare("INSERT INTO workflows (id, workspace_id, name, run_settings, created_at, updated_at) VALUES (?, 'ws-mw', ?, ?, ?, ?)");
    wf.run("wf-both", "W1", JSON.stringify({ provider: "codex", model: "gpt-5.5", effort: "xhigh", doneProvider: "", doneModel: "codex::gpt-5.5" }), T0, T0);
    wf.run("wf-brief", "W2", JSON.stringify({ provider: "claude", model: "claude-sonnet-5", brief: "this used to run on gpt-5.5" }), T0, T0);
  });
}
function read2(dataDir) {
  return withDb(dataDir, (db) => read(db));
}
function read(db) {
  // The manager tables only where they stand (the seed creates them; without a seed, like every fresh store, they are missing).
  const stands = (t) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t));
  const withRows = ["manager_agents", "manager_schedules", "outer_loop_agents", "agents"].filter(stands);
  const withClock = ["manager_agents", "agents", "workflows"].filter(stands);
  return {
    chats: Object.fromEntries(db.prepare("SELECT id, model, effort, updated_at FROM chats").all().map((r) => [r.id, { model: r.model, effort: r.effort, updated: r.updated_at }])),
    hints: db.prepare("SELECT chat_id, text FROM messages WHERE role = 'hint' ORDER BY id").all().map((r) => [r.chat_id, r.text]),
    settings: Object.fromEntries(db.prepare("SELECT key, value FROM app_settings").all().map((r) => [r.key, r.value])),
    rows: Object.fromEntries(withRows.flatMap((t) =>
      db.prepare(`SELECT id, model, updated_at FROM ${t}`).all().map((r) => [r.id, r.model]))),
    updatedRows: db.prepare(withClock.map((t) => `SELECT updated_at FROM ${t}`).join(" UNION ALL ")).all().map((r) => r.updated_at),
    workflows: Object.fromEntries(db.prepare("SELECT id, run_settings FROM workflows").all().map((r) => [r.id, JSON.parse(r.run_settings)])),
  };
}

test("newReference: \"codex::gpt-5.5\" always, the bare gpt-5.5 only with Codex or without a provider (and only if no other catalog carries it); similar names never", () => {
  assert.equal(newReference(G55, "codex::gpt-5.5", ""), "codex::gpt-6-sol");
  assert.equal(newReference(G55, "codex::gpt-5.5", "claude"), "codex::gpt-6-sol", "the prefix names the provider itself");
  assert.equal(newReference(G55, "gpt-5.5", "codex"), "gpt-6-sol");
  assert.equal(newReference(G55, "gpt-5.5", ""), "gpt-6-sol", "without a provider: only Codex knows the name");
  assert.equal(newReference(G55, "gpt-5.5", "claude"), null);
  assert.equal(newReference(G55, "gpt-5.5-mini", "codex"), null);
  assert.equal(newReference(G55, "openai/gpt-5.5", ""), null);
  assert.equal(newReference(G55, "openrouter::gpt-5.5", ""), null);
  assert.equal(newReference(G55, "", "codex"), null);
  const way = withForeignProvider();
  try {
    assert.equal(newReference(G55, "gpt-5.5", ""), null, "a third-party provider carries the name too => without a provider not unambiguously ours");
    assert.equal(newReference(G55, "gpt-5.5", "codex"), "gpt-6-sol", "with the provider Codex nevertheless");
    assert.equal(newReference(G55, "gpt-5.5", "openrouter"), null);
  } finally { way(); }
});

test("migration: every place that means Codex goes to gpt-6-sol; level, neighbouring fields and updated_at stay; one hint line per chat; marker; a second run changes nothing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-model-migration-"));
  const dataDir = path.join(root, "data");
  const way = withForeignProvider();
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    store.initStore(dataDir);
    seed(dataDir, path.join(root, "ws"));
    const prior = read2(dataDir);

    const [b] = migrateRetiredModels();
    const n = read2(dataDir);
    assert.deepEqual(b, { old: "gpt-5.5", fresh: "gpt-6-sol", chats: 1, rest: { rows: 1, agents: 1, workflows: 1, settings: 2 } });

    // Chats
    assert.equal(n.chats["c-g55"].model, "gpt-6-sol");
    assert.equal(n.chats["c-g55"].effort, "max", "the level stays the choice of the user");
    assert.equal(n.chats["c-g55"].updated, T0, "no user change; the chat list does not reorder");
    assert.equal(n.chats["c-sol"].model, "gpt-5.6-sol");
    assert.equal(n.chats["c-claude"].model, "gpt-5.5", "explicitly another provider");
    assert.equal(n.chats["c-foreign"].model, "gpt-5.5", "the third-party provider with its own gpt-5.5");
    assert.equal(n.chats["c-similar"].model, "gpt-5.5-mini");
    assert.deepEqual(n.hints, [["c-g55", "Modell jetzt GPT-6 Sol (vorher: GPT-5.5 — wird am 14.10.2026 abgeschaltet)"]]);

    // Settings
    assert.equal(n.settings.default_model_codex, "gpt-6-sol");
    assert.equal(n.settings["default_model_openrouter"], "gpt-5.5");
    assert.deepEqual(JSON.parse(n.settings.agent_model_title), { provider: "codex", model: "gpt-6-sol", effort: "low" }, "only the model, the level stays");
    assert.deepEqual(JSON.parse(n.settings.agent_model_classify), { provider: "openrouter", model: "gpt-5.5" });
    assert.equal(n.settings.agent_model_goal, prior.settings.agent_model_goal);
    assert.equal(n.settings["note_gpt-5.5"], "gpt-5.5");
    assert.match(n.settings[MARKER], /^\d{4}-\d\d-\d\dT.* · 1 chat\(s\), 1 agent row\(s\), 1 definition\(s\), 1 workflow\(s\), 2 setting\(s\)$/);

    // Tables with (provider, model) and agent definitions. The manager rows stay as they are: the kind manager is only readable,
    // and a migration into it would change the fingerprint of the extract.
    assert.deepEqual([n.rows["ma-codex"], n.rows["ma-empty"], n.rows["ma-claude"], n.rows["zp-1"]], ["gpt-5.5", "gpt-5.5", "claude-opus-5-5", "gpt-5.5"],
      "manager agents and schedules no longer migrate");
    assert.equal(n.rows["ol-1"], "gpt-6-sol");
    assert.equal(n.rows["ag-prefix"], "codex::gpt-6-sol");
    assert.equal(n.rows["ag-bare"], "gpt-5.5", "bare without a provider, not unambiguous => stays");
    assert.equal(n.rows["ag-sonnet"], "sonnet");
    assert.deepEqual(n.updatedRows, prior.updatedRows, "updated_at stays everywhere");

    // Workflows: parsed, exactly the model fields
    assert.deepEqual(n.workflows["wf-both"], { provider: "codex", model: "gpt-6-sol", effort: "xhigh", doneProvider: "", doneModel: "codex::gpt-6-sol" });
    assert.deepEqual(n.workflows["wf-brief"], prior.workflows["wf-brief"], "the word in the text never migrates");

    // Second run: marker => only the sweep of the chats, and that hits nothing any more.
    const [b2] = migrateRetiredModels();
    assert.deepEqual(b2, { old: "gpt-5.5", fresh: "gpt-6-sol", chats: 0, rest: null });
    const z = read2(dataDir);
    assert.deepEqual(z.hints, n.hints, "no second hint line");
    assert.equal(z.settings[MARKER], n.settings[MARKER]);
  } finally { way(); cleanUp(root); }
});

test("without a third-party provider: a bare name without a provider migrates (only Codex knows it)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-model-migration-bare-"));
  const dataDir = path.join(root, "data");
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    store.initStore(dataDir);
    store.createWorkspace({ id: "ws-mw", name: "MW", path: path.join(root, "ws"), createdAt: T0 });
    withDb(dataDir, (db) => {
      db.prepare("INSERT INTO outer_loop_agents (id, workspace_id, name, provider, model, created_at, updated_at) VALUES ('ol-empty', 'ws-mw', 'B', '', 'gpt-5.5', ?, ?)").run(T0, T0);
      db.prepare("INSERT INTO agents (id, workspace_id, name, model, created_at, updated_at) VALUES ('ag-bare', 'ws-mw', 'N', 'gpt-5.5', ?, ?)").run(T0, T0);
    });
    const [b] = migrateRetiredModels();
    assert.deepEqual(b.rest, { rows: 1, agents: 1, workflows: 0, settings: 0 });
    const n = read2(dataDir);
    assert.equal(n.rows["ol-empty"], "gpt-6-sol");
    assert.equal(n.rows["ag-bare"], "gpt-6-sol");
  } finally { cleanUp(root); }
});

test("written later: a chat that still gets gpt-5.5 AFTER the migration (the chat route does not check against the catalog) migrates at the next start; the marker holds back only the rest", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-model-migration-late-"));
  const dataDir = path.join(root, "data");
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    store.initStore(dataDir);
    store.createWorkspace({ id: "ws-mw", name: "MW", path: path.join(root, "ws"), createdAt: T0 });
    store.createChat({ id: "c-1", workspaceId: "ws-mw", title: "One", provider: "codex", model: "gpt-5.5", effort: "high", createdAt: T0, updatedAt: T0 });
    assert.equal(migrateRetiredModels()[0].chats, 1);
    assert.ok(store.getSetting(MARKER, ""), "the marker stands");
    store.createChat({ id: "c-2", workspaceId: "ws-mw", title: "Two", provider: "codex", model: "gpt-5.6-sol", effort: "high", createdAt: T0, updatedAt: T0 });
    store.updateChat("c-2", { model: "gpt-5.5" }); // a client with an old state
    store.setSetting("default_model_codex", "gpt-5.5"); // this way checks (400); here by hand, to show the marker
    const [b] = migrateRetiredModels();
    assert.deepEqual(b, { old: "gpt-5.5", fresh: "gpt-6-sol", chats: 1, rest: null });
    const n = read2(dataDir);
    assert.equal(n.chats["c-2"].model, "gpt-6-sol");
    assert.deepEqual(n.hints.map(([id]) => id), ["c-1", "c-2"], "exactly one line per chat");
    assert.equal(n.settings.default_model_codex, "gpt-5.5", "the rest did not run again");
  } finally { cleanUp(root); }
});

test("fresh store without old values: no marker (otherwise every golden fixture would carry one more app_settings row)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-model-migration-fresh-"));
  const dataDir = path.join(root, "data");
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    store.initStore(dataDir);
    store.createWorkspace({ id: "ws-mw", name: "MW", path: path.join(root, "ws"), createdAt: T0 });
    store.createChat({ id: "c-1", workspaceId: "ws-mw", title: "One", provider: "codex", model: "gpt-5.6-sol", effort: "high", createdAt: T0, updatedAt: T0 });
    assert.deepEqual(migrateRetiredModels(), [{ old: "gpt-5.5", fresh: "gpt-6-sol", chats: 0, rest: { rows: 0, agents: 0, workflows: 0, settings: 0 } }]);
    assert.equal(store.getSetting(MARKER, ""), "");
  } finally { cleanUp(root); }
});

// ── Runtime: what is still called gpt-5.5 after the migration runs as gpt-6-sol ─────────────────────────────────────────
test("runtime: a retired model runs as its successor, on the wire (chat and oneshot, with \"max\"), in the level, in the default model and in agent(); ONE table", () => {
  assert.equal(RETIRED_MODELS, retired.RETIRED_MODELS, "migration and runtime read the same table");
  assert.equal(retired.successorOf("codex", "gpt-5.5"), "gpt-6-sol");
  assert.equal(retired.successorOf("openrouter", "gpt-5.5"), "", "another provider with the same name is never meant");
  assert.deepEqual(retired.predecessorOf("codex", "gpt-6-sol"), [{ old: "gpt-5.5", oldEfforts: ["low", "medium", "high", "xhigh"] }]);
  assert.deepEqual(retired.predecessorOf("codex", "gpt-6.1-sol"), []);

  // Wire: chat and oneshot, with "max", which gpt-5.5 did not carry (measured HTTP 400) and gpt-6-sol carries.
  assert.equal(resolveCodexModel("gpt-5.5"), "gpt-6-sol");
  assert.equal(resolveCodexModel("gpt-5.5-mini"), "gpt-5.5-mini", "only the name itself, no prefix");
  const after = (args, flag) => args[args.indexOf(flag) + 1];
  const chat = buildCodexChatArgs({ cwd: "/tmp/x", model: "gpt-5.5", effort: "max", permissionMode: "bypassPermissions" });
  assert.equal(after(chat, "-m"), "gpt-6-sol");
  assert.ok(chat.includes('model_reasoning_effort="max"'), chat.join(" "));
  const once = buildCodexOnceArgs({ prompt: "x", outFile: "/tmp/o", model: "gpt-5.5", effort: "max" });
  assert.equal(after(once, "-m"), "gpt-6-sol");
  assert.ok(once.includes('model_reasoning_effort="max"'), once.join(" "));
  assert.equal(effortRunning("codex", "gpt-5.5", "max"), "max", "the level runs as the successor carries it");

  // Default model: a gpt-5.5 saved again is the successor, not the general fallback (gpt-5.6-sol).
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-model-migration-runtime-"));
  try {
    fs.mkdirSync(path.join(root, "data"), { recursive: true });
    store.initStore(path.join(root, "data"));
    store.setSetting("default_model_codex", "gpt-5.5");
    assert.equal(defaultModelFor("codex"), "gpt-6-sol");
  } finally { cleanUp(root); }

  // agent() of a dynamic workflow: from the chat, with a provider prefix, as a bare id; a catalog that carries the name takes precedence.
  const hosts = [{ id: "codex", models: [{ id: "gpt-6-sol" }, { id: "gpt-5.6-sol" }] }, { id: "claude", models: [{ id: "claude-opus-5-5" }] }];
  assert.equal(resolveAgentModel("", { provider: "codex", model: "gpt-5.5" }, { hosts }).ref, "codex::gpt-6-sol");
  assert.equal(resolveAgentModel("codex::gpt-5.5", { provider: "claude", model: "claude-opus-5-5" }, { hosts }).ref, "codex::gpt-6-sol");
  assert.equal(resolveAgentModel("gpt-5.5", { provider: "claude", model: "claude-opus-5-5" }, { hosts }).ref, "codex::gpt-6-sol");
  assert.equal(resolveAgentModel("gpt-5.5", { provider: "claude" }, { hosts: [...hosts, { id: "openrouter", models: [{ id: "gpt-5.5" }] }] }).ref, "openrouter::gpt-5.5");
  assert.throws(() => resolveAgentModel("openrouter::gpt-5.5", { provider: "claude" }, { hosts: [...hosts, { id: "openrouter", models: [] }] }), /unknown model/);
});

// ── At the real server: the migration is part of the start ─────────────────────────────────────────────────────
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

test("server start migrates: a Codex chat on gpt-5.5 stands on gpt-6-sol after the start, with a hint line in the history", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-model-migration-server-"));
  const dataRoot = path.join(root, "data-root");
  const prior = { CBASE_EMBED_OFFLINE: process.env.CBASE_EMBED_OFFLINE, CBASE_TRIGGER_POLL: process.env.CBASE_TRIGGER_POLL, CBASE_RESTART_GRACE_MS: process.env.CBASE_RESTART_GRACE_MS };
  process.env.CBASE_EMBED_OFFLINE = "1";
  process.env.CBASE_TRIGGER_POLL = "0";
  process.env.CBASE_RESTART_GRACE_MS = "3600000"; // no restart-grace tick in this test
  let server;
  try {
    const wsPath = path.join(root, "ws");
    fs.mkdirSync(wsPath, { recursive: true });
    fs.mkdirSync(path.join(dataRoot, "data"), { recursive: true });
    store.initStore(path.join(dataRoot, "data"));
    store.createWorkspace({ id: "ws-mw", name: "MW", path: wsPath, createdAt: T0 });
    store.createChat({ id: "c-1", workspaceId: "ws-mw", title: "One", provider: "codex", model: "gpt-5.5", effort: "high", createdAt: T0, updatedAt: T0 });
    const port = await freePort();
    server = await startServer({ port, dataRoot, webDir: path.join(root, "web"), pickDirectory: null, notify: null });
    const r = await fetch(`http://127.0.0.1:${port}/api/chats/c-1`);
    assert.equal(r.status, 200);
    const chat = await r.json();
    assert.equal(chat.model, "gpt-6-sol", JSON.stringify(chat).slice(0, 300));
    assert.deepEqual(read2(path.join(dataRoot, "data")).hints, [["c-1", "Modell jetzt GPT-6 Sol (vorher: GPT-5.5 — wird am 14.10.2026 abgeschaltet)"]]);
  } finally {
    if (server) { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
    for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    cleanUp(root);
  }
});
