// An HTTP provider for tests without a server. Exactly three providers exist (claude, codex, openrouter) and
// `registerConnector` throws for any other id (guard only-three-provider.test.js). A test therefore REPLACES the built-in
// OpenRouter with a connector from the same factory (connectors/openai-chat.js) that has its own models, base URL and
// capabilities, and restores the real one afterwards.
//
// Not a test (no .test.js suffix): a harness like agent-harness.mjs. A test that needs a server uses the test seam of the
// real connector (`CBASE_OPENROUTER_BASE` + `logInOpenRouter`, agent-harness.mjs) instead of this spy.
import { getConnector, registerConnector } from "../electron/server/providers/index.js";
import { makeOpenAiChatConnector } from "../electron/server/providers/connectors/openai-chat.js";

/**
 * A connector of the openai-chat wire under the id `openrouter`. `cfg` as for `makeOpenAiChatConnector` (baseUrl, models,
 * caps, apiKey, extraBody, reportsCost …); defaults: wire "openrouter", key "sk-test", base 127.0.0.1:9 (never reachable).
 */
export function openRouterSpy(cfg = {}) {
  return makeOpenAiChatConnector({
    label: "OpenRouter (Test)",
    baseUrl: "http://127.0.0.1:9",
    apiKey: "sk-test",
    wire: "openrouter",
    ...cfg,
    id: "openrouter",
  });
}

/**
 * Replace OpenRouter in the registry with a ready connector or with `openRouterSpy(cfg)`. Returns the function that puts the
 * real one back (for `finally`/`t.after`); restoring more than once is harmless.
 */
export function replaceOpenRouter(connectorOrCfg = {}) {
  const real = getConnector("openrouter");
  // A ready connector (has `resolveModel`) goes in unchanged if it is already called `openrouter`; a copy would evaluate its
  // getters (`models`, `reportsCost`) once and freeze them.
  const isConnector = typeof connectorOrCfg?.resolveModel === "function";
  const fresh = !isConnector ? openRouterSpy(connectorOrCfg)
    : (connectorOrCfg.id === "openrouter" ? connectorOrCfg : { ...connectorOrCfg, id: "openrouter" });
  registerConnector(fresh);
  return () => { registerConnector(real); };
}
