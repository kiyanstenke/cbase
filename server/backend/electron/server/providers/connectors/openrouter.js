// connectors/openrouter.js — OpenRouter as a BUILT-IN provider: only openrouter/claude/codex exist, no free third parties.
//
// Fixed id `openrouter` (registered in providers/index.js like claude/codex, not removable), wire openai-chat, base
// from the contract (only `CBASE_OPENROUTER_BASE` overrides it — the test seam), models from the catalog
// (`../openrouter-catalog.js`: only models with tools, vision and context per model), `reportsCost` always true. The
// ACCESS stays in the row `providers.openrouter` (key and `extra_body.provider` with the two privacy toggles,
// PUT /api/openrouter) — it comes in as a callback and is read per call: a new key takes effect without
// re-registration. Without the key the provider is "not connected" (authStatus without a fetch).
//
// X-Title is the app attribution OpenRouter asks for. All five effort levels go out: OpenRouter itself maps onto the
// nearest level the model supports (connectors/openai-chat.js, REASONING_EFFORT).
import { OPENROUTER_ID } from "../../account/usage-contract.js";
import { catalogUse, catalogList, catalogModel, catalogStatus, openRouterBase } from "../openrouter-catalog.js";
import { makeOpenAiChatConnector } from "./openai-chat.js";

/**
 * @param {{ access: () => { apiKey: string, extraBody: Object }, defaultModel?: () => string }} deps
 *   access        the access from the row providers.openrouter (the key stays in the server)
 *   defaultModel  the ONE default model of the provider (`defaultModelFor`)
 */
export function makeOpenRouterConnector({ access, defaultModel } = {}) {
  const read = () => { try { return access?.() || {}; } catch { return {}; } };
  // The connector's model entries — mapped ONCE per catalog state (hundreds of entries, asked often).
  let projectionStatus = -1;
  let projection = [];
  const models = () => {
    const s = catalogStatus();
    if (s !== projectionStatus) {
      projectionStatus = s;
      projection = catalogList().map((m) => ({ id: m.id, label: m.name, context: m.context, vision: m.vision }));
    }
    return projection;
  };
  return makeOpenAiChatConnector({
    id: OPENROUTER_ID,
    label: "OpenRouter",
    baseUrl: () => openRouterBase(),
    getApiKey: () => String(read().apiKey || ""),
    models: models,
    headers: { "X-Title": "cbase" },
    extraBody: () => read().extraBody || {},
    defaultModel,
    wire: OPENROUTER_ID,
    reportsCost: true,
    // A model the catalog does not know (or an empty catalog) accepts images — unknown is not "no".
    canImages: (id) => catalogModel(id)?.vision !== false,
    // Anthropic models only cache at OpenRouter with `cache_control` (connectors/openai-chat.js withCacheMarkers) — all others on their own.
    cacheMarkers: (id) => /^anthropic\//.test(String(id || "")),
    atUse: (id) => catalogUse(id),
    authPath: "/key",
  });
}
