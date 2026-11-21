// Retired models and their successor — ONE table for the migration and for the runtime.
//
// Two readers, one truth:
//   • the migration (account/model-migration.js) rewrites stored references to the successor ONCE — chats on every start,
//     everything else up to the mark;
//   • the runtime maps an old name to the successor on EVERY resolution: a client with stale state can store it again
//     after the migration (the chat route does not check the model against the catalog), and until the next start the
//     chat would run with the retired name. Mapped where a stored name becomes a run: `resolveCodexModel` (wire of chat,
//     oneshot and `effortRunning`), `defaultModelFor` (default model) and `dynworkflows/model.js:resolveAgentModel`
//     (`agent()` of a dynamic workflow).
//   • The journal key of a dynamic workflow carries the RESOLVED model; so that a run from before the retirement resumes
//     from its journal across the change instead of re-running every `agent()`, `predecessorOf` names the old names
//     together with the effort levels they carried (dynworkflows/run.js).
//
// `fresh` is a maintainer decision — NOT the `upgrade` of the account catalog.
// `oldEfforts` = the effort levels of the old catalog entry, for the key of an old journal.
//
// A leaf without imports: codex.js, providers/index.js, dynworkflows/ and account/ read it without closing a cycle.

/** The retired models. `until` = retirement date (shown in the notice row of the migration). */
export const RETIRED_MODELS = Object.freeze([
  Object.freeze({
    provider: "codex",
    old: "gpt-5.5",
    oldLabel: "GPT-5.5",
    fresh: "gpt-6-sol",
    until: "Oct 14, 2026", // shown through T(until): the German date stands in i18n-de.js
    oldEfforts: Object.freeze(["low", "medium", "high", "xhigh"]),
  }),
]);

/**
 * The successor of a retired model at THIS provider — or "" (not retired). Chains (a → b → c) are followed to the end.
 * Another provider with the same name (a third party with its own "gpt-5.5") is never meant.
 * @param {string} provider
 * @param {string} model
 */
export function successorOf(provider, model) {
  let m = String(model ?? "").trim();
  if (!m) return "";
  let target = "";
  for (let i = 0; i <= RETIRED_MODELS.length; i++) {
    const e = RETIRED_MODELS.find((x) => x.provider === provider && x.old === m);
    if (!e) break;
    target = m = e.fresh;
  }
  return target;
}

/** The model that really runs at this provider: the successor if it is retired, otherwise the model itself. */
export const runningModel = (provider, model) => successorOf(provider, model) || String(model ?? "");

/**
 * The retired predecessors of a model at this provider (direct and through chains) — `[{ old, oldEfforts }]`.
 * @param {string} provider
 * @param {string} model   the successor
 */
export function predecessorOf(provider, model) {
  const m = String(model ?? "").trim();
  if (!m) return [];
  return RETIRED_MODELS.filter((e) => e.provider === provider && successorOf(provider, e.old) === m)
    .map((e) => ({ old: e.old, oldEfforts: e.oldEfforts }));
}
