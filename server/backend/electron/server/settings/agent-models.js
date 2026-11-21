// App agents and their models: env defaults (CURATOR_*, TITLE, GOAL), AGENT_MODEL_KEYS/DEFAULTS,
// agentModelSetting, agentModelFor. Trap: AGENT_MODEL_KEYS and the catalog in AgentModelSettings.tsx are TWO lists.

import { DEFAULT_MODEL_FALLBACK, getActiveProviderId, isProviderId } from "../providers/index.js";
import * as store from "../store.js";
import { defaultModelFor } from "../account/providers.js";
import { effortSavable } from "../workflows.js";

// Model for the post-run curator — without env the Claude fallback of the default model (providers/index.js, ONE place).
const CURATOR_MODEL = process.env.CURATOR_MODEL || DEFAULT_MODEL_FALLBACK.claude;
// Post-run curator is OFF for now (re-enable via env CURATOR_ENABLED=1). The primary path is that the main LLM
// maintains the context itself, with a server-side dedup check instead of the curator as backup.
const CURATOR_ENABLED = process.env.CURATOR_ENABLED === "1";
// Model for the service scan at project creation (stack inventory in the project folder) — fallback as CURATOR_MODEL.
const SERVICES_SCAN_MODEL = process.env.SERVICES_SCAN_MODEL || DEFAULT_MODEL_FALLBACK.claude;
// Model for the automatic chat title (cheap side task).
const TITLE_MODEL = process.env.CBASE_TITLE_MODEL || "claude-haiku-4-5-20251001";
// Model for the goal check after every run with a /goal set (cheap judge).
const GOAL_CHECK_MODEL = process.env.CBASE_GOAL_MODEL || "claude-haiku-4-5-20251001";

// ── App agent models (Settings → Models) ─────────────────────────────────────
// The user can choose provider+model per internal LLM task (app_settings
// `agent_model_<key>`, value JSON {provider, model}; empty = auto = the defaults).
// agentModelFor returns the model string for runOnce — for a user choice in the form
// "provider::model", which the runOnce dispatch understands (no provider parameter needed).
const AGENT_MODEL_KEYS = ["title", "goal", "workflow", "compact", "curator", "classify", "services", "channel_status", "adjust"];
// Auto defaults per task ("" = dynamic: compact takes the chat model, classification the provider default).
const AGENT_MODEL_DEFAULTS = {
  title: TITLE_MODEL, goal: GOAL_CHECK_MODEL, workflow: GOAL_CHECK_MODEL, compact: "", curator: CURATOR_MODEL, classify: "", services: SERVICES_SCAN_MODEL,
  // Summary on demand, for ANY reader of a chat — a reading task over a few thousand characters,
  // the cheap model is enough.
  channel_status: TITLE_MODEL,
  // Adjust: rephrase selected text following a user instruction
  // (approval card → select text → "Adjust") — a short text, one call per adjustment.
  adjust: TITLE_MODEL,
};
// The settings row `agent_model_<key>` as an object — `{}` when nothing (readable) is in it. Besides provider+model
// it carries the effort LEVEL (`effort`), and each half may stand alone: a level with an "auto" model is a choice,
// a model without a level means "default".
function agentRow(key) {
  try {
    const raw = store.getSetting(`agent_model_${key}`, "");
    if (!raw) return {};
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}
function agentModelSetting(key) {
  const v = agentRow(key);
  if (!v.model || !isProviderId(v.provider)) return null; // removed providers → back to auto
  return { provider: v.provider, model: String(v.model) };
}
/**
 * The chosen effort level of an app agent — "" means "default": the provider's default level, resolved and clamped
 * to the model only in the run (`runOnce` → `effortRunning`), as for any chat. Anything that is not a known level
 * is "" here as well (a legacy value is not guessed).
 * @param {string} key
 * @returns {string}
 */
function agentEffortSetting(key) {
  const u = effortSavable(agentRow(key).effort);
  return u.kind === "level" ? u.level : "";
}
/**
 * The run description of an app agent: model AND effort level. This is how the level travels through the wrappers
 * around `runOnce` (claude.js) — as its own field next to `model`, never inside the model reference: the model string
 * is read as a NAME in several places (the 502 response of adjust, the start gate …), and each of those readers would
 * have to strip a level again. A forgotten field instead falls back to the default level — visible and covered
 * (server/backend/test/oneshot-level.test.js).
 * @param {string} key
 * @param {string} [fallback]
 * @returns {{model: string, effort: string}}
 */
function agentRunFor(key, fallback = AGENT_MODEL_DEFAULTS[key] ?? "") {
  return { model: agentModelFor(key, fallback), effort: agentEffortSetting(key) };
}
function agentModelFor(key, fallback = AGENT_MODEL_DEFAULTS[key] ?? "") {
  const s = agentModelSetting(key);
  if (s) return `${s.provider}::${s.model}`;
  // An empty entry means "default model of the active provider" per the table above — and that is what must come
  // out here. An empty string would make runOnceClaude set NO --model at all: the CLI's default would decide,
  // not the provider default chosen in the settings.
  return fallback || defaultModelFor(getActiveProviderId());
}

export { AGENT_MODEL_DEFAULTS, AGENT_MODEL_KEYS, CURATOR_ENABLED, agentEffortSetting, agentRunFor, agentModelFor, agentModelSetting, agentRow };
