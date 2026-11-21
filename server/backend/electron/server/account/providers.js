// Providers and models: modelKnown, defaultModelFor (passed through from providers/index.js).
// There are no third-party providers from the database: OpenRouter is built in (providers/connectors/openrouter.js), and
// the catalog itself computes the context window per entry (providers/openrouter-catalog.js).

import { PROVIDERS, defaultModelFor, isProviderId, modelSelectable } from "../providers/index.js";
import { catalogKnows } from "../providers/openrouter-catalog.js";
import { OPENROUTER_ID } from "./usage-contract.js";


// Does the catalog know this model? The picker has no free text — what is not listed there cannot be chosen
// anywhere and would go as `--model` to a CLI that rejects it.
// OpenRouter asks its catalog (`modelSelectable`: only models with tools; an empty catalog is unknown, hence yes).
// WITHOUT a provider the OpenRouter catalog only counts when it provably lists the model — an empty catalog would
// otherwise let any string through, also for Claude/Codex, which then reject it as `--model`.
function modelKnown(provider, model) {
  const id = String(model || "").trim();
  if (!id) return true;
  if (provider === OPENROUTER_ID) return modelSelectable(OPENROUTER_ID, id);
  const inList = (c) => (c?.models || []).some((mo) => mo?.id === id);
  if (isProviderId(provider)) return inList(PROVIDERS[provider]);
  return Object.values(PROVIDERS).some((c) => c?.id === OPENROUTER_ID ? catalogKnows(id) === true : inList(c));
}
// `defaultModelFor` (with DEFAULT_MODEL_FALLBACK) lives in providers/index.js — the default effort level
// depends on the default model, and its resolution is there. Only passed through here.

export { defaultModelFor, modelKnown };
