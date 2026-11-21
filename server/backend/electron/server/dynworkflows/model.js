// Which model an `agent()` runs — a resolver of its OWN, because the existing one (providers/index.js resolveModelRef)
// has two flaws for this purpose: it never throws (a typo would silently run as some model), and the Codex connector
// maps Claude aliases — `opus` from a Codex chat would silently run as a GPT model.
//
//   ""                  provider and model of the chat (empty model ⇒ the provider's default model)
//   opus|sonnet|…       the Claude aliases ALWAYS mean Claude, also in a Codex chat (same table as `/model` in the web)
//   provider::model     exactly this provider; the model must be in ITS catalog (for Claude an alias works too) — for
//                       OpenRouter in the WHOLE catalog with tools, not only the picker's short list (a still empty
//                       catalog is unknown, hence yes)
//   <catalog-id>        an id that is in exactly ONE catalog lands at that provider; in several ⇒ throw (OpenRouter
//                       only counts here when its catalog provably carries the id)
//
// Unknown ⇒ a throw with the selection, before anything starts. The result is the RESOLVED pair — it goes into the
// journal key as such (`provider::model`): an alias and the full id of the same model give the same key, a provider
// switch of the chat a different one.
//
// A RETIRED model (providers/retired.js) runs as its successor — from the chat, from "provider::old" and as a bare id
// when no catalog carries it. That an old journal still hits across the switch is handled in run.js (alias keys through
// `predecessorOf`).
import { agentHosts, defaultModelFor, providerForChat } from "../providers/index.js";
import { catalogKnows } from "../providers/openrouter-catalog.js";
import { RETIRED_MODELS, runningModel } from "../providers/retired.js";

// `sonnet`/`haiku` point where `/model` (ChatCatalog.tsx MODEL_ALIAS) and the CLI's own aliases point — bound in
// web/test/list-binding.test.mjs. Consequence for a run resumed across such a change: an agent() with `sonnet`/`haiku`
// has a different journal key (different model) and runs anew.
export const CLAUDE_ALIASES = Object.freeze({
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
  haiku: "claude-haiku-5-5",
  fable: "claude-fable-5-2", // since the pin 2.1.322 like the CLI; consequence as above: a different journal key
});

export class ModelError extends Error {}

// The selection in the error text: the short list per provider; a provider with a catalog (`catalog: true`) adds that
// every model of its catalog with tools works — the same shape as the system prompt (runs/system-prompt.js
// subagentChoicePrompt).
function selection(hosts) {
  const ids = hosts.flatMap((h) => h.models.map((m) => `${h.id}::${m.id}`));
  const catalog = hosts.filter((h) => h.catalog).map((h) => `, any catalog model with tools via ${h.id}::<id>`).join("");
  return `Selectable: ${Object.keys(CLAUDE_ALIASES).join(", ")} (Claude aliases), ${ids.join(", ")}${catalog} — or omit model (provider and model of the chat).`;
}

/**
 * @param {string|undefined} raw   `opts.model` from the script
 * @param {Object} chat            the chat row (provider, model)
 * @param {{hosts?: Array<{id:string, models:Array<{id:string}>, catalog?: boolean}>}} [o]  the selectable providers (default: agentHosts())
 * @returns {{ provider: string, model: string, ref: string }}  `ref` = `provider::model` (for core and key)
 */
export function resolveAgentModel(raw, chat, { hosts = agentHosts() } = {}) {
  const paar = (provider, model) => ({ provider, model, ref: `${provider}::${model}` });
  if (raw !== undefined && raw !== null && typeof raw !== "string") throw new ModelError(`agent(): model must be a string. ${selection(hosts)}`);
  const value = String(raw ?? "").trim();
  if (!value) {
    const provider = providerForChat(chat);
    return paar(provider, runningModel(provider, String(chat?.model || defaultModelFor(provider) || "")));
  }
  // Named explicitly (`provider::model`): for a catalog provider the whole catalog (unknown = yes); bare: only what it
  // provably carries — otherwise every unknown id would silently fall to OpenRouter.
  const inCatalog = (h, id, { bare = false } = {}) => (h.catalog
    ? (bare ? catalogKnows(id) === true : catalogKnows(id) !== false)
    : h.models.some((m) => m.id === id));
  const alias = CLAUDE_ALIASES[value.toLowerCase()];
  if (alias) return paar("claude", alias);
  const i = value.indexOf("::");
  if (i >= 0) {
    const provider = value.slice(0, i).trim();
    const model = value.slice(i + 2).trim();
    const h = hosts.find((x) => x.id === provider);
    if (!h) throw new ModelError(`agent(): unknown provider “${provider}” in model “${value}”. ${selection(hosts)}`);
    const target = provider === "claude" && CLAUDE_ALIASES[model.toLowerCase()] ? CLAUDE_ALIASES[model.toLowerCase()] : runningModel(provider, model);
    if (!inCatalog(h, target)) throw new ModelError(`agent(): unknown model “${model}” at ${provider}. ${selection(hosts)}`);
    return paar(provider, target);
  }
  const hits = hosts.filter((h) => inCatalog(h, value, { bare: true }));
  if (hits.length === 1) return paar(hits[0].id, value);
  if (hits.length > 1) {
    throw new ModelError(`agent(): model “${value}” is ambiguous (${hits.map((h) => `${h.id}::${value}`).join(", ")}) — name the provider.`);
  }
  // No catalog carries the id — if it is retired at exactly one selectable provider, its successor runs there.
  const gone = RETIRED_MODELS.filter((e) => e.old === value && hosts.some((h) => h.id === e.provider && inCatalog(h, runningModel(e.provider, value), { bare: true })));
  if (gone.length === 1) return paar(gone[0].provider, runningModel(gone[0].provider, value));
  throw new ModelError(`agent(): unknown model “${value}”. ${selection(hosts)}`);
}
