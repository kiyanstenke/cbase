// Raw material and write paths of the model migration (`account/model-migration.js`: a retired model name moves to
// its successor). The store knows no catalogs and no provider resolution: it delivers the rows whose model field
// CONTAINS the old name (`instr` — a pre-filter, also for the form "provider::name" and for JSON), and writes only
// where exactly the value that was read still stands. Whether a row really migrates is decided by the migration
// (model: `chatsWithoutLevel`/`setLevelIfEmpty` in store/chats.js for chats/auto-gone.js).
//
// `updated_at` stays untouched everywhere: a migration is not a change by the user — the lists do not re-sort.
// Not a topic file with DDL, hence no registration in the schema registry.
import { db } from "./db.js";

// The tables with (provider, model) per row — fixed, never from an argument (the name goes into the SQL). The
// manager tables are deliberately absent: a fresh store does not have them, and in an old one the kind manager is
// read-only (runs/manager-lock.js).
const PROVIDER_MODEL_TABLES = Object.freeze(["outer_loop_agents"]);

/**
 * All rows whose model field contains `name` — raw, per place:
 *   chats        `{ id, provider, model }` (the provider is the STORED one; empty means "active provider")
 *   tables       `{ outer_loop_agents: [{ id, provider, model }] }`
 *   agents       `{ id, model }` (agent definitions: a reference "[provider::]model" without a provider column)
 *   workflows    `{ id, run_settings }` (JSON text, `provider`/`model` and `doneProvider`/`doneModel`)
 *   settings     `{ key, value }` from `app_settings`, only `default_model_*` and `agent_model_*`
 */
function modelMigrationCandidates(name) {
  const n = String(name || "");
  if (!n) return { chats: [], tables: {}, agents: [], workflows: [], settings: [] };
  const tables = {};
  for (const t of PROVIDER_MODEL_TABLES) {
    tables[t] = db.prepare(`SELECT id, provider, model FROM ${t} WHERE instr(model, ?) > 0 ORDER BY rowid`).all(n).map((r) => ({ ...r }));
  }
  return {
    // Without the kind manager (runs/manager-lock.js): it is read-only.
    chats: db.prepare("SELECT id, provider, model FROM chats WHERE instr(model, ?) > 0 AND kind <> 'manager' ORDER BY rowid").all(n).map((r) => ({ ...r })),
    tables,
    agents: db.prepare("SELECT id, model FROM agents WHERE instr(model, ?) > 0 ORDER BY rowid").all(n).map((r) => ({ ...r })),
    workflows: db.prepare("SELECT id, run_settings FROM workflows WHERE instr(run_settings, ?) > 0 ORDER BY rowid").all(n).map((r) => ({ ...r })),
    settings: db.prepare(
      "SELECT key, value FROM app_settings WHERE instr(value, ?) > 0 AND (key LIKE 'default\\_model\\_%' ESCAPE '\\' OR key LIKE 'agent\\_model\\_%' ESCAPE '\\') ORDER BY key",
    ).all(n).map((r) => ({ ...r })),
  };
}

/** Sets the model of a chat row ONLY if `alt` still stands there. Returns: 1 = set. */
const setChatModelInstead = (id, old, fresh) =>
  db.prepare("UPDATE chats SET model = ? WHERE id = ? AND model = ?").run(fresh, id, old).changes;

/** The same for a row of the tables with (provider, model) and for agent definitions. */
function setModelInstead(table, id, old, fresh) {
  if (!PROVIDER_MODEL_TABLES.includes(table) && table !== "agents") throw new Error(`setModelInstead: unknown table ${table}`);
  return db.prepare(`UPDATE ${table} SET model = ? WHERE id = ? AND model = ?`).run(fresh, id, old).changes;
}

/** The run settings of a workflow ONLY if the text that was read still stands there. */
const setRunSettingsInstead = (id, old, fresh) =>
  db.prepare("UPDATE workflows SET run_settings = ? WHERE id = ? AND run_settings = ?").run(fresh, id, old).changes;

/** A setting ONLY if the value that was read still stands there. */
const setSettingInstead = (key, old, fresh) =>
  db.prepare("UPDATE app_settings SET value = ? WHERE key = ? AND value = ?").run(fresh, key, old).changes;

export { modelMigrationCandidates, setChatModelInstead, setSettingInstead, setModelInstead, setRunSettingsInstead };
