// The access to OpenRouter and the raw material of the provider migration.
//
// There are exactly three providers (claude, codex, openrouter). The table `providers` stays — it carries the ACCESS
// to OpenRouter in exactly one row with the identifier `openrouter` (key in `api_key`, the two privacy switches in
// `extra_body.provider`); nobody reads its other columns (models, mapping, headers, capabilities, base) any more,
// the base is in the contract, the models in the catalog. The key never leaves the server: `openRouterAccess` only
// goes to the connector.
//
// The migration (`account/provider-migration.js`) gets its rows here and writes via these paths. The store knows no
// catalogs and no resolution — it delivers the rows that carry a provider identifier and writes what the migration
// decided (model: store/model-migration.js). `updated_at` stays untouched everywhere: a migration is not a change by
// the user. No DDL, hence no registration in the schema registry. All exports are in the wrapper at the end
// (store-facade.test.js).
import { db, inOneTransaction } from "./db.js";
import { parseJson } from "./_util.js";

const OR = "openrouter";

// The tables with (provider, model) per row — fixed, never from an argument (the name goes into the SQL). Without
// the manager tables — same reason as in store/model-migration.js: a fresh store does not have them, in an old one
// they are read-only.
const PROVIDER_MODEL_TABLES = Object.freeze(["outer_loop_agents"]);
// Tables whose provider column is only history (renamed, never rewritten) — [table, column].
const HISTORY = Object.freeze([["outer_loop_runs", "provider"], ["subagents", "provider"], ["pending_resumes", "provider"], ["usage_events", "provider"]]);

// ── The access to OpenRouter ───────────────────────────────────────────────────────────────────────────────────────────────
/** `{ existing, apiKey, extraBody }` from the row `providers.openrouter` (if missing: not existing, empty). */
function openRouterAccess() {
  const r = db.prepare("SELECT api_key, extra_body FROM providers WHERE id = ?").get(OR);
  if (!r) return { existing: false, apiKey: "", extraBody: {} };
  const extra = parseJson(r.extra_body, {});
  return { existing: true, apiKey: String(r.api_key || ""), extraBody: extra && typeof extra === "object" && !Array.isArray(extra) ? extra : {} };
}

/**
 * Set the access — the row is created if it does not exist. `apiKey` undefined = the stored one stays; `extraBody`
 * is always the whole new value (the route computes it from the old one).
 */
function setOpenRouterAccess({ apiKey, extraBody }) {
  const now = Date.now();
  const extra = JSON.stringify(extraBody && typeof extraBody === "object" && !Array.isArray(extraBody) ? extraBody : {});
  inOneTransaction(() => {
    const found = db.prepare("SELECT 1 FROM providers WHERE id = ?").get(OR);
    if (!found) {
      db.prepare(`INSERT INTO providers (id, label, preset, base_url, api_key, extra_body, enabled, created_at, updated_at)
                  VALUES (?, 'OpenRouter', 'openrouter', '', ?, ?, 1, ?, ?)`).run(OR, String(apiKey ?? ""), extra, now, now);
      return;
    }
    if (apiKey === undefined) db.prepare("UPDATE providers SET extra_body = ?, updated_at = ? WHERE id = ?").run(extra, now, OR);
    else db.prepare("UPDATE providers SET api_key = ?, extra_body = ?, updated_at = ? WHERE id = ?").run(String(apiKey), extra, now, OR);
  });
  return openRouterAccess();
}

/** Remove the key — the row (and with it the two switches) stays. Returns whether one was set. */
const removeOpenRouterKey = () =>
  db.prepare("UPDATE providers SET api_key = '', updated_at = ? WHERE id = ? AND api_key <> ''").run(Date.now(), OR).changes > 0;

/**
 * The models a provider has run since `sinceMs` (from usage_events), ordered by their NAME — not by the time of
 * last use: the list is in the system prompt of EVERY chat (the shortlist, providers/index.js openRouterShortlist),
 * and a change of order as soon as another model ran somewhere would rewrite the prompt cache of all chats.
 */
const usedModelsSince = (provider, sinceMs) =>
  db.prepare(`SELECT DISTINCT model FROM usage_events WHERE provider = ? AND at >= ? AND model <> ''
              ORDER BY model ASC`).all(String(provider || ""), Math.max(0, Number(sinceMs) || 0)).map((r) => r.model);

// ── Raw material of the migration ──────────────────────────────────────────────────────────────────────────────────────────
/** All rows of the table `providers`, oldest first — `{ id, label, preset, baseUrl, hasKey }`. */
const providerRows = () =>
  db.prepare("SELECT id, label, preset, base_url, api_key <> '' AS key FROM providers ORDER BY created_at ASC, rowid ASC").all()
    .map((r) => ({ id: r.id, label: r.label || "", preset: r.preset || "", baseUrl: r.base_url || "", hasKey: !!r.key }));

/** Chats with this provider; `withWithout` adds the chats WITHOUT their own provider (they follow the global one). */
const chatsOfProvider = (provider, withWithout = false) =>
  db.prepare(`SELECT id, provider, model FROM chats WHERE provider = ?${withWithout ? " OR provider IS NULL OR provider = ''" : ""} ORDER BY rowid`)
    .all(String(provider)).map((r) => ({ ...r }));

/** Set provider and model of a chat and discard its session (it belongs to the old provider). Returns: 1 = set. */
const setChatProvider = (id, provider, model) =>
  db.prepare(`UPDATE chats SET provider = ?, model = ?, claude_session_id = NULL, context_tokens = 0, upstream_provider = '', upstream_window = 0
              WHERE id = ?`).run(provider, model, id).changes;

/** Rows of a table with (provider, model) for this provider — `{ table: [{ id, model }] }`. */
function rowsOfProvider(provider) {
  const out = {};
  for (const t of PROVIDER_MODEL_TABLES) out[t] = db.prepare(`SELECT id, model FROM ${t} WHERE provider = ? ORDER BY rowid`).all(String(provider)).map((r) => ({ ...r }));
  return out;
}

/** Set provider and model of a row (only the fixed tables). Returns: 1 = set. */
function setProviderModel(table, id, provider, model) {
  if (!PROVIDER_MODEL_TABLES.includes(table)) throw new Error(`setProviderModel: unknown table ${table}`);
  return db.prepare(`UPDATE ${table} SET provider = ?, model = ? WHERE id = ?`).run(provider, model, id).changes;
}

/** Agent definitions whose model reference starts with "<provider>::" — `[{ id, model }]`. */
const agentsWithProvider = (provider) =>
  db.prepare("SELECT id, model FROM agents WHERE substr(model, 1, ?) = ? ORDER BY rowid").all(String(provider).length + 2, `${provider}::`).map((r) => ({ ...r }));

/** Workflows whose run settings contain the identifier (pre-filter; the verdict is made on the parsed JSON). */
const workflowsWithText = (text) =>
  db.prepare("SELECT id, run_settings FROM workflows WHERE instr(run_settings, ?) > 0 ORDER BY rowid").all(String(text)).map((r) => ({ ...r }));

/** All settings `agent_model_<key>` (JSON `{provider, model, effort}`). */
const appAgentSettings = () =>
  db.prepare("SELECT key, value FROM app_settings WHERE key LIKE 'agent\\_model\\_%' ESCAPE '\\' ORDER BY key").all().map((r) => ({ ...r }));

/**
 * Delete what remains of a REMOVED provider: its row in `providers`, default model, default effort level and account
 * kind, its consumption rows and its waiting resumptions. History and subagent history stay. Returns the counts.
 */
function deleteProvider(provider) {
  const p = String(provider);
  return inOneTransaction(() => ({
    row: db.prepare("DELETE FROM providers WHERE id = ?").run(p).changes,
    settings: db.prepare("DELETE FROM app_settings WHERE key IN (?, ?, ?)").run(`default_model_${p}`, `default_effort_${p}`, `account_kind_${p}`).changes,
    consumption: db.prepare("DELETE FROM usage_events WHERE provider = ?").run(p).changes,
    resumptions: db.prepare("DELETE FROM pending_resumes WHERE provider = ?").run(p).changes,
  }));
}

/** The hand-written price table: `usage_prices` and `usage_currency`. Returns how many settings fell. */
const deletePriceTable = () => db.prepare("DELETE FROM app_settings WHERE key IN ('usage_prices', 'usage_currency')").run().changes;

/**
 * Codex rows without input and without cache, booked BEFORE `untilMs` (the connector once did not report the turn;
 * a real Codex turn always has input). The boundary keeps a later row (a fake Codex in a test) out.
 */
const deleteCodexZeroRows = (untilMs) =>
  db.prepare("DELETE FROM usage_events WHERE provider = 'codex' AND input = 0 AND cached = 0 AND at < ?").run(Math.max(0, Number(untilMs) || 0)).changes;

/**
 * Every provider identifier that stands anywhere in the store: chats, the tables with (provider, model),
 * consumption, waiting resumptions, prefixes "<id>::" in agent definitions, the settings `default_model_<id>`/
 * `default_effort_<id>`/`account_kind_<id>`/`provider` and — as JSON — the run settings of the workflows (`provider`,
 * `doneProvider`, with an empty field the prefix "<id>::" in the model) and the app agents (`agent_model_<key>`).
 * The history (outer loop runs, subagents) does not count: nothing is migrated there. Empty values fall.
 */
function providerIdentifiers() {
  const ids = new Set();
  const take = (v) => { const t = typeof v === "string" ? v.trim() : ""; if (t) ids.add(t); };
  const json = (text) => { const o = parseJson(text, null); return o && typeof o === "object" && !Array.isArray(o) ? o : null; };
  for (const r of db.prepare("SELECT DISTINCT provider FROM chats").all()) take(r.provider);
  for (const t of PROVIDER_MODEL_TABLES) for (const r of db.prepare(`SELECT DISTINCT provider FROM ${t}`).all()) take(r.provider);
  for (const r of db.prepare("SELECT DISTINCT provider FROM usage_events").all()) take(r.provider);
  for (const r of db.prepare("SELECT DISTINCT provider FROM pending_resumes").all()) take(r.provider);
  for (const r of db.prepare("SELECT DISTINCT substr(model, 1, instr(model, '::') - 1) AS p FROM agents WHERE instr(model, '::') > 1").all()) take(r.p);
  for (const r of db.prepare(`SELECT key, value FROM app_settings WHERE key = 'provider' OR key LIKE 'default\\_model\\_%' ESCAPE '\\'
                              OR key LIKE 'default\\_effort\\_%' ESCAPE '\\' OR key LIKE 'account\\_kind\\_%' ESCAPE '\\'`).all()) {
    if (r.key === "provider") take(r.value);
    else take(r.key.replace(/^(default_model_|default_effort_|account_kind_)/, ""));
  }
  for (const r of appAgentSettings()) take(json(r.value)?.provider);
  // A prefix "<id>::" in the model only counts where the provider field is empty (that is how workflows/driver.js:doneJudgeModel passes it on).
  const prefix = (provider, model) => { const m = typeof model === "string" ? model.trim() : ""; return !provider && m.indexOf("::") > 0 ? m.slice(0, m.indexOf("::")) : ""; };
  for (const r of db.prepare("SELECT run_settings FROM workflows WHERE instr(lower(run_settings), 'provider') > 0 OR instr(run_settings, '::') > 0").all()) {
    const o = json(r.run_settings);
    take(o?.provider);
    take(o?.doneProvider);
    take(prefix(o?.provider, o?.model));
    take(prefix(o?.doneProvider, o?.doneModel));
  }
  return [...ids].sort();
}

/**
 * An OpenRouter row under a foreign identifier becomes `openrouter` — EVERYWHERE the identifier stands: the row
 * itself, chats, the tables with (provider, model), the history (runs of the outer loop, subagents, resumptions,
 * consumption), references "<alt>::…" in agent definitions and the settings (default model, default effort level,
 * global provider; the account kind falls). Run settings and app agents (JSON) are written by the migration itself.
 * Returns: changed rows per place.
 */
function renameProviderEverywhere(old) {
  const a = String(old);
  if (!a || a === OR) return {};
  return inOneTransaction(() => {
    const n = {};
    n.row = db.prepare("UPDATE providers SET id = ? WHERE id = ?").run(OR, a).changes;
    n.chats = db.prepare("UPDATE chats SET provider = ? WHERE provider = ?").run(OR, a).changes;
    for (const t of PROVIDER_MODEL_TABLES) n[t] = db.prepare(`UPDATE ${t} SET provider = ? WHERE provider = ?`).run(OR, a).changes;
    for (const [t, sp] of HISTORY) n[t] = db.prepare(`UPDATE ${t} SET ${sp} = ? WHERE ${sp} = ?`).run(OR, a).changes;
    n.agents = db.prepare("UPDATE agents SET model = ? || substr(model, ?) WHERE substr(model, 1, ?) = ?")
      .run(`${OR}::`, a.length + 3, a.length + 2, `${a}::`).changes;
    n.settings = 0;
    for (const kind of ["default_model", "default_effort"]) {
      const r = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(`${kind}_${a}`);
      if (!r) continue;
      db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(`${kind}_${OR}`, r.value);
      db.prepare("DELETE FROM app_settings WHERE key = ?").run(`${kind}_${a}`);
      n.settings += 1;
    }
    n.settings += db.prepare("DELETE FROM app_settings WHERE key = ?").run(`account_kind_${a}`).changes;
    n.settings += db.prepare("UPDATE app_settings SET value = ? WHERE key = 'provider' AND value = ?").run(OR, a).changes;
    return n;
  });
}

export {
  agentsWithProvider, providerIdentifiers, providerRows, appAgentSettings, renameProviderEverywhere, usedModelsSince, chatsOfProvider,
  removeOpenRouterKey, deleteProvider, deleteCodexZeroRows, deletePriceTable, openRouterAccess,
  setProviderModel, setChatProvider, setOpenRouterAccess, workflowsWithText, rowsOfProvider,
};
