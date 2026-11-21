// Only three providers: the one-time migration of the store.
//
// Third-party providers used to be created as presets with a freely chosen id (table `providers`); now the registry knows
// exactly `PROVIDER` (claude, codex, openrouter — providers/index.js), and every stored reference to another id would
// dangle: `providerForChat` would silently fall back to the global provider, which would get a model it does not know.
// So the store migrates ONCE, in every container and in the local server with the same code:
//
//   1. The OpenRouter row becomes `providers.openrouter`: a row with the id `openrouter` wins (otherwise the rename would
//      hit the primary key), otherwise the FIRST row with preset `openrouter` or base host `openrouter.ai` — under a
//      foreign id rewritten everywhere (`store.renameProviderEverywhere`, plus the JSON locations here). Every other row
//      in `providers` is a REMOVED provider, as is every foreign id that only remains in references
//      (`store.providerIdentifiers`).
//   2. Per removed provider P: chats → `openrouter::<m>` when the catalog lists a model with the same name part after the
//      last "/" (case-insensitive) AND tools, and a key is set; otherwise Claude with the Claude default model; a message
//      of role `hint` in the chat, the session dropped (it belongs to P). A chat without its own provider counts when the
//      GLOBAL provider is P (it followed it, and the global one becomes Claude). The same for outer-loop agents
//      (store/provider.js), agent definitions ("P::…"), run settings of graph workflows (`provider`/`doneProvider`) and
//      app agents (`agent_model_<key>`); global provider P ⇒ claude. Deleted: the row in `providers`,
//      `default_model_P`, `default_effort_P`, `account_kind_P`, the consumption and the waiting resumptions of P.
//      What stays: the history, the subagent history, content that merely mentions P.
//   3. The manual price table (`usage_prices`, `usage_currency`) goes — prices come from the catalog.
//   4. Codex rows with input 0 and cache 0 booked before CODEX_ZERO_ROWS_UNTIL (until then the connector did not report
//      the turn; a real Codex turn always has input).
//   5. ONE line in the server log with everything that migrated.
//
// When: at start, after loading the catalog — waiting at most 10 s and only when a removed provider has references AND a
// key is set (otherwise the catalog decides nothing: without a key everything migrates to Claude). Without a catalog
// after the deadline the chats migrate to Claude. If no waiting is needed, everything runs SYNCHRONOUSLY in the call (the
// start keeps its order); otherwise `startServer` waits for it before `listen` (server.js) — no run, no tick starts
// before. The migrations that build on this one (retired models, effort levels) are passed by server.js as
// `afterwards`: they run behind it in BOTH cases.
//
// Once: the marker `migration.provider_only_three` (app_settings) is set as soon as the migration changed something and
// keeps every later start away. A store without legacy data gets NO marker — otherwise every golden fixture would carry
// one more app_settings row (as in account/model-migration.js); there a second pass is a no-op anyway.
// Guard: server/backend/test/provider-migration.test.js.
import * as store from "../store.js";
import { T } from "../i18n.js";
import { PROVIDERS, defaultModelFor } from "../providers/index.js";
import { catalogReady, catalogList, catalogModel } from "../providers/openrouter-catalog.js";
import { PROVIDER, OPENROUTER_ID } from "./usage-contract.js";

export const PROVIDER_MIGRATION_MARKER = "migration.provider_only_three";
/** How long the start waits for the catalog at most. */
export const CATALOG_WAIT_MS = 10_000;
/** Codex zero rows before this fall; those booked later stay (a fake Codex in a test books 0). */
export const CODEX_ZERO_ROWS_UNTIL = Date.UTC(2026, 9, 15);

const hostOf = (url) => { try { return new URL(String(url || "")).hostname.toLowerCase(); } catch { return ""; } };
/** Is a row of the table `providers` an OpenRouter access (preset or base host)? */
export const isOpenRouterRow = (z) => z?.preset === "openrouter" || hostOf(z?.baseUrl) === "openrouter.ai" || hostOf(z?.baseUrl).endsWith(".openrouter.ai");

const parseObject = (text) => {
  try { const o = JSON.parse(text); return o && typeof o === "object" && !Array.isArray(o) ? o : null; } catch { return null; }
};

/**
 * What would be done, without writing: which row becomes OpenRouter (`rename` = its old id, "" = no rename) and
 * which providers are removed.
 */
export function providerPlan() {
  const rows = store.providerRows();
  const fixed = rows.find((z) => z.id === OPENROUTER_ID) || rows.find(isOpenRouterRow) || null;
  const rename = fixed && fixed.id !== OPENROUTER_ID ? fixed.id : "";
  const removed = new Set(rows.filter((z) => z !== fixed).map((z) => z.id));
  for (const id of store.providerIdentifiers()) if (!PROVIDER.includes(id) && id !== rename) removed.add(id);
  removed.delete(OPENROUTER_ID);
  return { rename, removed: [...removed].sort(), withKey: Boolean(fixed?.hasKey) };
}

/** The name part of a model after the last "/", case-insensitive. */
const namePart = (m) => String(m || "").trim().split("/").pop().toLowerCase();

/**
 * The target of a model of a removed provider: the same model at OpenRouter when the catalog lists it with tools
 * (same id case-insensitively before same name part, otherwise the first in catalog order) and a key is set;
 * otherwise Claude with its default model.
 */
export function targetFor(model, { withKey, catalog }) {
  const raw = String(model || "").trim();
  if (withKey && raw && catalog.length) {
    const exactly = catalog.find((m) => m.id.toLowerCase() === raw.toLowerCase());
    const part = namePart(raw);
    const hits = exactly || catalog.find((m) => namePart(m.id) === part);
    if (hits) return { provider: OPENROUTER_ID, model: hits.id };
  }
  return { provider: "claude", model: defaultModelFor("claude") };
}

function targetText(z) {
  const provider = PROVIDERS[z.provider]?.label || z.provider;
  const model = z.provider === OPENROUTER_ID
    ? (catalogModel(z.model)?.name || z.model)
    : ((PROVIDERS[z.provider]?.models || []).find((m) => m?.id === z.model)?.label || z.model);
  return `${provider} (${model})`;
}

const hintText = (name, z) => T`Provider ${name} no longer exists — this chat now runs on ${targetText(z)}.`;

/**
 * Step 1: the JSON locations of the rename (the store writes the columns). The provider is in the field
 * (`provider`/`doneProvider`) — or as a prefix in the model ("old::model", the form `doneJudgeModel` passes on when the
 * provider field is empty; removeProvider handles the same form). The prefix must be rewritten too: otherwise the
 * reference points to a provider that does not exist, resolveModelRef silently falls back to the chat's provider, and
 * the completion verdict fails on every run. The prefix is rewritten in every model field that carries it.
 */
function renameJson(old) {
  let n = 0;
  const prefix = `${old}::`;
  const renameModel = (m) => (typeof m === "string" && m.trim().startsWith(prefix) ? `${OPENROUTER_ID}::${m.trim().slice(prefix.length)}` : m);
  for (const r of store.workflowsWithText(old)) {
    const o = parseObject(r.run_settings);
    if (!o) continue;
    const copy = { ...o };
    if (o.provider === old) copy.provider = OPENROUTER_ID;
    if (o.doneProvider === old) copy.doneProvider = OPENROUTER_ID;
    if ("model" in o) copy.model = renameModel(o.model);
    if ("doneModel" in o) copy.doneModel = renameModel(o.doneModel);
    if (["provider", "doneProvider", "model", "doneModel"].every((k) => copy[k] === o[k])) continue;
    n += store.setRunSettingsInstead(r.id, r.run_settings, JSON.stringify(copy));
  }
  for (const r of store.appAgentSettings()) {
    const o = parseObject(r.value);
    if (!o) continue;
    const copy = { ...o };
    if (o.provider === old) copy.provider = OPENROUTER_ID;
    if ("model" in o) copy.model = renameModel(o.model);
    if (copy.provider === o.provider && copy.model === o.model) continue;
    n += store.setSettingInstead(r.key, r.value, JSON.stringify(copy));
  }
  return n;
}

/** Step 2 for ONE removed provider. Returns the tally per location. */
function removeProvider(p, { withKey, catalog, label }) {
  const pStandard = store.getSetting(`default_model_${p}`, "");
  const target = (model) => targetFor(model || pStandard, { withKey, catalog });
  const global = store.getSetting("provider", "") === p;
  const b = { provider: p, chats: 0, toOpenRouter: 0, rows: 0, agents: 0, workflows: 0, appAgents: 0, global: false, deleted: null };

  for (const c of store.chatsOfProvider(p, global)) {
    const z = target(c.model);
    if (!store.setChatProvider(c.id, z.provider, z.model)) continue;
    store.addMessage(c.id, "hint", hintText(label, z));
    b.chats += 1;
    if (z.provider === OPENROUTER_ID) b.toOpenRouter += 1;
  }
  for (const [table, rows] of Object.entries(store.rowsOfProvider(p))) {
    for (const r of rows) {
      const z = target(r.model);
      b.rows += store.setProviderModel(table, r.id, z.provider, z.model);
    }
  }
  for (const r of store.agentsWithProvider(p)) {
    const z = target(r.model.slice(p.length + 2));
    b.agents += store.setModelInstead("agents", r.id, r.model, `${z.provider}::${z.model}`);
  }
  // Run settings: the provider is in the field (`provider`/`doneProvider`) — or, if the field is empty, as a prefix in
  // the model ("P::model", the form `doneJudgeModel` passes on without a provider; workflows/driver.js).
  const prefix = `${p}::`;
  const modelOfP = (o, providerField, modelField) => {
    if (o[providerField] === p) return { hit: true, model: o[modelField] };
    const m = typeof o[modelField] === "string" ? o[modelField].trim() : "";
    return !o[providerField] && m.startsWith(prefix) ? { hit: true, model: m.slice(prefix.length) } : { hit: false };
  };
  for (const r of store.workflowsWithText(p)) {
    const o = parseObject(r.run_settings);
    if (!o) continue;
    const copy = { ...o };
    const run = modelOfP(o, "provider", "model");
    const check = modelOfP(o, "doneProvider", "doneModel");
    if (!run.hit && !check.hit) continue;
    if (run.hit) { const z = target(run.model); copy.provider = z.provider; copy.model = z.model; }
    if (check.hit) { const z = target(check.model); copy.doneProvider = z.provider; copy.doneModel = z.model; }
    b.workflows += store.setRunSettingsInstead(r.id, r.run_settings, JSON.stringify(copy));
  }
  for (const r of store.appAgentSettings()) {
    const o = parseObject(r.value);
    if (o?.provider !== p) continue;
    const z = target(o.model);
    b.appAgents += store.setSettingInstead(r.key, r.value, JSON.stringify({ ...o, provider: z.provider, model: z.model }));
  }
  if (global) { store.setSetting("provider", "claude"); b.global = true; }
  b.deleted = store.deleteProvider(p);
  return b;
}

const counts = (b) => b.chats + b.rows + b.agents + b.workflows + b.appAgents + (b.global ? 1 : 0)
  + Object.values(b.deleted || {}).reduce((s, n) => s + (Number(n) || 0), 0);

/**
 * The migration itself — synchronous, against the catalog as it is NOW. Returns the tally, or null when the marker was already set.
 * The tally carries `changed` (number of rows written); only then are marker and log line written.
 */
export function migrateProvider() {
  if (store.getSetting(PROVIDER_MIGRATION_MARKER, "")) return null;
  const plan = providerPlan();
  const labels = new Map(store.providerRows().map((z) => [z.id, z.label || z.id]));
  const tally = { renamed: null, removed: [], priceTable: 0, codexZeroRows: 0, changed: 0 };

  if (plan.rename) {
    const n = store.renameProviderEverywhere(plan.rename);
    const json = renameJson(plan.rename);
    tally.renamed = { from: plan.rename, rows: Object.values(n).reduce((s, x) => s + (Number(x) || 0), 0) + json };
    tally.changed += tally.renamed.rows;
  }
  const catalog = catalogList();
  const withKey = Boolean(store.openRouterAccess().apiKey);
  for (const p of plan.removed) {
    const b = removeProvider(p, { withKey, catalog, label: labels.get(p) || p });
    tally.removed.push(b);
    tally.changed += counts(b);
  }
  tally.priceTable = store.deletePriceTable();
  tally.codexZeroRows = store.deleteCodexZeroRows(CODEX_ZERO_ROWS_UNTIL);
  tally.changed += tally.priceTable + tally.codexZeroRows;

  if (tally.changed) {
    store.setSetting(PROVIDER_MIGRATION_MARKER, new Date().toISOString());
    console.log(`[providers] only Claude, Codex, OpenRouter remain: ${logRow(tally, catalog.length)}`);
  }
  return tally;
}

function logRow(b, catalogModels) {
  const parts = [];
  if (b.renamed) parts.push(`OpenRouter row "${b.renamed.from}" → "${OPENROUTER_ID}" (${b.renamed.rows} rows)`);
  for (const e of b.removed) {
    const g = e.deleted || {};
    parts.push(`${e.provider} removed: ${e.chats} chats (${e.toOpenRouter} → OpenRouter, ${e.chats - e.toOpenRouter} → Claude), `
      + `${e.rows} agent rows, ${e.agents} agent definitions, ${e.workflows} workflows, ${e.appAgents} app agents`
      + `${e.global ? ", global provider → claude" : ""}; deleted ${g.row || 0} row, ${g.settings || 0} settings, `
      + `${g.consumption || 0} consumption rows, ${g.resumptions || 0} resumptions`);
  }
  if (b.priceTable) parts.push(`price table deleted (${b.priceTable} settings)`);
  if (b.codexZeroRows) parts.push(`${b.codexZeroRows} Codex zero rows deleted`);
  parts.push(`catalog ${catalogModels} models with tools`);
  return parts.join(" · ");
}

/**
 * At start (server.js, before `listen`): waits at most `waitMs` for the catalog — but only when it decides something
 * (removed provider AND key, catalog still empty); otherwise everything runs SYNCHRONOUSLY in the call. `afterwards` are
 * the migrations that build on this one (retired models, effort levels — they ask for the chats' providers): they ALWAYS
 * run after it, in the synchronous case still within the call, in the waiting case after the wait. Without the callback
 * they would run BEFORE the provider migration on a first start that has to wait — against chats whose provider no
 * longer exists. Returns a promise of the tally (null with the marker set or on error). Never throws, not even from `afterwards`.
 * @param {{ waitMs?: number, afterwards?: () => void }} [o]
 */
export function migrateProviderAtStart({ waitMs = CATALOG_WAIT_MS, afterwards = null } = {}) {
  const safe = (fn) => { try { return fn(); } catch (e) { console.error("[providers] migration failed:", e?.message || e); return null; } };
  const followUp = () => { if (typeof afterwards === "function") { try { afterwards(); } catch (e) { console.error("[providers] follow-up migration failed:", e?.message || e); } } };
  const mustWait = safe(() => {
    if (store.getSetting(PROVIDER_MIGRATION_MARKER, "")) return false;
    const plan = providerPlan();
    return Boolean(plan.removed.length && plan.withKey && !catalogList().length);
  });
  if (!mustWait) {
    const tally = safe(() => migrateProvider());
    followUp();
    return Promise.resolve(tally);
  }
  let clock = null;
  const deadline = new Promise((r) => { clock = setTimeout(r, Math.max(0, waitMs)); clock.unref?.(); });
  return Promise.race([Promise.resolve(catalogReady()).catch(() => {}), deadline]).then(() => {
    if (clock) clearTimeout(clock);
    const tally = safe(() => migrateProvider());
    followUp();
    return tally;
  });
}
