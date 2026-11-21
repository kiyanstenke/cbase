// Retired models migrate to their successor.
//
// A model removed from a provider's catalog (e.g. `CODEX_MODELS`, `providers/connectors/codex.js`) would leave a STORED
// value dangling, and not loudly:
//   • `resolveCodexModel` passes any `gpt-…` through ⇒ the run goes to the CLI with the old `-m` and dies there once the
//     provider has switched it off — every turn, every schedule, every oneshot;
//   • the effort clamp no longer knows it ⇒ a stored `max` is no longer clamped;
//   • the UI shows the raw id and the picker does not offer it — it can only be chosen away, not back.
// Only the default model (`defaultModelFor`) heals itself. So every stored reference migrates ONCE to the successor named
// in the table: chats, default model per provider (`default_model_<id>`), app agents (`agent_model_<key>`, JSON),
// outer-loop agents (store/model-migration.js), agent definitions (`agents.model`, "[provider::]model") and the run
// settings of graph workflows (`run_settings`: `model` and `doneModel`, JSON — parsed, never by text pattern).
//
// Which value migrates (`newReference`): "<provider>::<old>" always; the bare "<old>" only when its provider is the
// entry's — for chats the resolved one (`providerForChat`), otherwise the provider column or the field next to it; WITHOUT
// a provider only when no other registered catalog lists the name. An explicitly different provider stays untouched.
// A write happens only where the value read is still there (store/model-migration.js), `updated_at` stays. The effort
// level stays as stored — it is the user's choice, not part of the migration.
//
// Every migrated chat gets ONE hint row (role `hint`, as in chats/auto-gone.js): the model changes under a running
// conversation, and that should be visible.
//
// Once, and still catching: the CHATS are swept at EVERY start — the chat route does not check the model against the
// catalog, so a client with an old state can still write it after the migration; after the first time the sweep hits
// nothing (an `instr` prefilter). Everything else runs until it has rewritten something once; then the marker
// `migration.model_gone.<provider>.<old>` (app_settings) keeps every later start from it. A store without old values
// gets NO marker — otherwise every golden fixture (`fixtures/golden/*/db.json`) would carry one more app_settings row.
// Called from server.js AFTER the provider migration (account/provider-migration.js; the check "does another provider
// know the name?" asks the registry's catalogs) and BEFORE the effort migrations (which then already compute with the
// successor).
//
// NOT migrated: scripts of dynamic workflows (text — an old model reference there is mapped at run time,
// `dynworkflows/model.js`), consumption (`usage_events`, history), orphaned subagents (history).
//
// Afterwards the RUNTIME holds: `resolveCodexModel`, `defaultModelFor` and `resolveAgentModel` map an old name to the
// successor on every resolution — the same entry of the same table (providers/retired.js). So what a client with an old
// state stores again after the migration already runs as the successor before the next sweep. A running dynamic
// workflow resumes from its journal across the change (the old model's key counts as an alias, dynworkflows/run.js).
// Guard: server/backend/test/model-migration.test.js.
import * as store from "../store.js";
import { T } from "../i18n.js";
import { PROVIDERS, providerForChat } from "../providers/index.js";
// The table lives ONCE in the leaf providers/retired.js — the runtime reads the same one.
import { RETIRED_MODELS } from "../providers/retired.js";

export { RETIRED_MODELS };

export const modelGoneMarker = (e) => `migration.model_gone.${e.provider}.${e.old}`;

/** Does ANOTHER registered provider list the old name in its catalog? Then a bare name without a provider is not unambiguously ours. */
function foreignKnows(e) {
  return Object.entries(PROVIDERS).some(([id, p]) => id !== e.provider && (p?.models || []).some((m) => m?.id === e.old));
}

/**
 * The new reference for a stored one — or null when this value does not migrate.
 * @param {object} e        entry from RETIRED_MODELS
 * @param {string} model    stored value ("model" or "provider::model")
 * @param {string} provider the provider next to it ("" = none given)
 */
export function newReference(e, model, provider = "") {
  const m = String(model ?? "");
  if (m === `${e.provider}::${e.old}`) return `${e.provider}::${e.fresh}`;
  if (m !== e.old) return null;
  const a = String(provider ?? "").trim();
  if (a) return a === e.provider ? e.fresh : null;
  return foreignKnows(e) ? null : e.fresh;
}

function hintText(e) {
  const newLabel = (PROVIDERS[e.provider]?.models || []).find((m) => m?.id === e.fresh)?.label || e.fresh;
  return T`Model now ${newLabel} (before: ${e.oldLabel} — retired on ${T(e.until)})`;
}

const parseObject = (text) => {
  try { const o = JSON.parse(text); return o && typeof o === "object" && !Array.isArray(o) ? o : null; } catch { return null; }
};

/** The chats — at EVERY start (see header). Returns the number of migrated chats. */
function sweepChats(e) {
  let n = 0;
  for (const c of store.modelMigrationCandidates(e.old).chats) {
    const fresh = newReference(e, c.model, providerForChat(c));
    if (fresh === null || !store.setChatModelInstead(c.id, c.model, fresh)) continue;
    store.addMessage(c.id, "hint", hintText(e));
    n++;
  }
  return n;
}

/** Everything except the chats — until it has rewritten something once (marker). */
function migrateRest(e) {
  const k = store.modelMigrationCandidates(e.old);
  const tally = { rows: 0, agents: 0, workflows: 0, settings: 0 };
  for (const [table, rows] of Object.entries(k.tables)) {
    for (const r of rows) {
      const fresh = newReference(e, r.model, r.provider);
      if (fresh !== null) tally.rows += store.setModelInstead(table, r.id, r.model, fresh);
    }
  }
  for (const r of k.agents) {
    const fresh = newReference(e, r.model, "");
    if (fresh !== null) tally.agents += store.setModelInstead("agents", r.id, r.model, fresh);
  }
  for (const r of k.workflows) {
    const o = parseObject(r.run_settings);
    if (!o) continue;
    const copy = { ...o };
    const model = typeof o.model === "string" ? newReference(e, o.model, o.provider) : null;
    if (model !== null) copy.model = model;
    const check = typeof o.doneModel === "string" ? newReference(e, o.doneModel, o.doneProvider) : null;
    if (check !== null) copy.doneModel = check;
    if (model === null && check === null) continue;
    tally.workflows += store.setRunSettingsInstead(r.id, r.run_settings, JSON.stringify(copy));
  }
  for (const r of k.settings) {
    let fresh = null;
    if (r.key.startsWith("default_model_")) {
      const n = newReference(e, r.value, r.key.slice("default_model_".length));
      if (n !== null) fresh = n;
    } else {
      const o = parseObject(r.value);
      const n = o && typeof o.model === "string" ? newReference(e, o.model, o.provider) : null;
      if (n !== null) fresh = JSON.stringify({ ...o, model: n });
    }
    if (fresh !== null) tally.settings += store.setSettingInstead(r.key, r.value, fresh);
  }
  return tally;
}

/**
 * The migration of all retired models. Returns per entry `{ old, fresh, chats, rest }` — `rest` null when the
 * marker was already set (then only the chats were swept).
 */
export function migrateRetiredModels() {
  const out = [];
  for (const e of RETIRED_MODELS) {
    const chats = sweepChats(e);
    let rest = null;
    if (!store.getSetting(modelGoneMarker(e), "")) {
      rest = migrateRest(e);
      const sum = chats + rest.rows + rest.agents + rest.workflows + rest.settings;
      if (sum) {
        store.setSetting(modelGoneMarker(e), `${new Date().toISOString()} · ${chats} chat(s), ${rest.rows} agent row(s), ${rest.agents} definition(s), ${rest.workflows} workflow(s), ${rest.settings} setting(s)`);
      }
    }
    if (chats || (rest && (rest.rows || rest.agents || rest.workflows || rest.settings))) {
      console.log(`[providers] ${e.provider}::${e.old} → ${e.fresh}: ${chats} chat(s)${rest ? `, ${rest.rows} agent row(s), ${rest.agents} definition(s), ${rest.workflows} workflow(s), ${rest.settings} setting(s)` : ""}`);
    }
    out.push({ old: e.old, fresh: e.fresh, chats, rest });
  }
  return out;
}
