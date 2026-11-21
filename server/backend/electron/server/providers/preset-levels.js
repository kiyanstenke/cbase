// preset-levels.js — which effort levels an HTTP wire sends for ONE model, and the one clamp in front of it.
//
// The completion connectors send the level as the value of ONE field, and which values an endpoint accepts depends on
// the MODEL, not on the provider. There is only ONE wire: openai-chat, which OpenRouter runs over. Measured at a single
// endpoint: `reasoning_effort: "max"` is an HTTP 400 for one model (and costs the whole turn) and longer thinking for
// another.
//
// Two sources therefore say what a model supports, in this order:
//   1. the model entry of the connector (`models[].efforts`) — explicit (the OpenRouter catalog names none, the tests
//      set them);
//   2. otherwise the default of the wire (OpenRouter: all five — OpenRouter itself maps onto the level the model supports).
// Empty is not unknown: `efforts: []` on the entry means "this model supports NO level" — then no field goes out at
// all. An entry without the field says nothing, and the default applies.
//
// The clamp computes as everywhere else: `effortFallback` in workflows.js (the highest supported level that is NOT above
// the requested one). This module is a leaf with exactly this one import; it does not judge against the level order
// itself (guard effort-core.test.js).
import { EFFORT_LEVELS, effortFallback } from "../workflows.js";

/**
 * The levels a provider supports EXPLICITLY for a model, or `null` if its entry says nothing about it (no entry, or no
 * array under `efforts`).
 * @param {Array<{id?: string, efforts?: unknown}>} models  the model entries of the connector
 * @param {string} id        the RESOLVED model id (after the connector's model mapping)
 * @param {string[]} known   the levels the wire can map at all, in level order — filtering and sorting run against
 *   THEM, so that a configuration cannot invent a value the wire does not know
 * @returns {string[] | null}
 */
export function explicitLevels(models, id, known) {
  const entry = (Array.isArray(models) ? models : []).find((m) => m && m.id === id);
  if (!entry || !Array.isArray(entry.efforts)) return null;
  const named = new Set(entry.efforts.map((g) => String(g ?? "").trim().toLowerCase()));
  return known.filter((g) => named.has(g));
}

/**
 * The level an HTTP wire sends for `effort` — or "" (then NO field goes out). Pure except for the warning line: a clamp
 * that deviates silently cannot be told from one that hits.
 * @param {string} wire      name in the line (`openrouter`; `openai-chat` for a factory connector without its own name)
 * @param {unknown} effort   the level that arrives (already clamped after `effortRunning` — then a no-op)
 * @param {string[]} supported what this model supports on this wire (`[]` = explicitly no levels)
 * @param {string} model     the resolved id, for the line
 * @param {string} [reason]  one sentence on WHY the wire ends there — the generic clamp passes it along
 * @returns {string}
 */
export function wireLevel(wire, effort, supported, model, reason = "") {
  const e = String(effort || "").toLowerCase();
  if (!e) return "";
  // Validity first, then "no levels": `effortFallback` also answers "" for an EMPTY list — from its return value alone
  // the two lines could not be told apart. Without a list ("unknown") the same rule passes a valid level through and
  // returns "" for an invalid one.
  if (!effortFallback(e)) {
    console.warn(`[${wire}] "${e}" is not an effort level at all (valid: ${EFFORT_LEVELS.join(", ")}) — no level goes out.`);
    return "";
  }
  if (!supported.length) {
    console.warn(`[${wire}] ${model || "(default)"} supports no effort level according to its model entry — "${e}" does not go out.`);
    return "";
  }
  const level = effortFallback(e, supported);
  if (level !== e) {
    console.warn(`[${wire}] Effort "${e}" clamped: ${model || "(default)"} supports ${supported.join(", ")} on this wire${reason ? ` (${reason})` : ""} — sending "${level}".`);
  }
  return level;
}
