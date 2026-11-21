// The contract "providers and usage" between server, web and iOS — ONE leaf without imports. The server (account/,
// providers/) computes with these lists; the binding test web/test/usage-binding.test.mjs holds web (lib/api/usage.ts)
// and iOS (Models/UsageModels.swift) to it — changing a line here turns the suite red until both have followed.
// Pattern: preview/contract.js, server/gateway/administration-contract.js.

/** The ONLY providers. Order of the UI. */
export const PROVIDER = Object.freeze(["claude", "codex", "openrouter"]);
/** The subscription providers — their consumption counts against a quota, not against money. */
export const SUBSCRIPTION_PROVIDER = Object.freeze(["claude", "codex"]);
/** OpenRouter has a FIXED id and a fixed base; only the tests override the base (CBASE_OPENROUTER_BASE). */
export const OPENROUTER_ID = "openrouter";
export const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

/** The subpages of Settings → Usage, in list order. Jump from outside: `usage:<subpage>`. */
export const USAGE_PAGE = "usage";
export const USAGE_SUBPAGES = Object.freeze(["overview", "claude", "codex", "openrouter", "limit"]);
/** The settings page of dynamic workflows (group "Behavior"). */
export const WORKFLOWS_PAGE = "workflows";

/**
 * The time windows per provider. `session`/`week` are the windows the ring measures (Claude: fiveHour/sevenDay, Codex:
 * primary/secondary) — start = resetsAt − window length from the LAST snapshot (never a new fetch). Without a snapshot
 * the window falls back to a sliding one of the same length and the response says `windowKnown: false`. `30d` slides.
 */
export const SUBSCRIPTION_WINDOW = Object.freeze(["session", "week", "30d"]);
export const OPENROUTER_WINDOW = Object.freeze(["30d", "total"]);

/** Where an OpenRouter amount comes from; `null` = unknown (never 0). */
export const COST_ORIGIN = Object.freeze(["reported", "inquired", "estimated"]);

/**
 * The roles of the one-off calls (runOnce), booked with `source = 'once'` and `agent_id = <role>`; plus the two sources
 * that booked before (`retrieval`, `outer_loop`). Every runOnce call site of the server names exactly one of these roles
 * (guard server/backend/test/once-consumption.test.js). Web and iOS carry one label per role (bound). `categorization`,
 * `extraction` and `second_look` are historical: their call sites are gone, the roles remain for the old rows in
 * `usage_events`.
 */
export const ONCE_ROLES = Object.freeze([
  "categorization", "extraction", "second_look", "compaction", "title", "target", "workflow_verdict", "adjust",
  "context_categorize", "project_categorize", "project_merge", "project_assign", "context_maintain", "services",
  "retrieval", "outer_loop",
]);

// ── GET /api/usage/consumption?provider=<PROVIDER>&window=<SUBSCRIPTION_WINDOW|OPENROUTER_WINDOW> ─────────────────────────────────
// Unknown provider, or a window the provider does not know ⇒ 400. Reads ONLY the database and the stored
// snapshots (usage_cache_v1, Codex rollouts) — never /api/usage, never a network fetch.
export const CONSUMPTION_FIELDS = Object.freeze([
  "provider", "window", "from", "until", "windowKnown", "sums", "models", "chats", "chatsAdditional", "background", "subagentsShare",
]);
/**
 * The sums of a window. `cacheUnsplit`: cache of rows from before the split (only `cached` known) — the UI shows it
 * only when > 0. `equivalentUsd`: API list price estimate (subscription providers; null for OpenRouter),
 * `equivalentComplete` false as soon as a model has no price or cache is unsplit. `costUsd`/`costOrigin`: OpenRouter only (otherwise null).
 */
export const SUMS_FIELDS = Object.freeze([
  "input", "output", "cacheRead", "cacheWrite", "cacheUnsplit", "runs",
  "equivalentUsd", "equivalentComplete", "partsUsd", "costUsd", "costOrigin",
]);
/** `partsUsd`: the equivalent split up (USD or null per field). */
export const PARTS_FIELDS = Object.freeze(["input", "output", "cacheRead", "cacheWrite"]);
/** `costOrigin`: how many rows per origin; `unknown` = without an amount. */
export const ORIGIN_TALLY_FIELDS = Object.freeze(["reported", "inquired", "estimated", "unknown"]);
/** A row in `models` (sorted by equivalent or cost, then output). */
export const MODEL_FIELDS = Object.freeze([
  "model", "input", "output", "cacheRead", "cacheWrite", "cacheUnsplit", "runs", "equivalentUsd", "costUsd", "priceKnown",
]);
/** A row in `chats` (at most 25, `chatsAdditional` says how many are missing — never truncate silently). */
export const CHAT_FIELDS = Object.freeze([
  "chatId", "title", "deleted", "input", "output", "cacheRead", "cacheWrite", "runs", "equivalentUsd", "costUsd",
]);
/** A row in `background`: one-off calls per role (ONCE_ROLES). */
export const BACKGROUND_FIELDS = Object.freeze([
  "role", "input", "output", "cacheRead", "cacheWrite", "runs", "equivalentUsd", "costUsd",
]);

// ── GET /api/usage/history?provider=<PROVIDER>&days=<1..90>&offsetMin=<−840..840> ──────────────────────────────────────────
/** Per day (calendar day in the client's time zone, `offsetMin` = minutes east of UTC), gapless, oldest first. */
export const HISTORY_FIELDS = Object.freeze(["provider", "days", "offsetMin", "points"]);
export const POINT_FIELDS = Object.freeze(["day", "input", "output", "cacheRead", "cacheWrite", "equivalentUsd", "costUsd"]);

// ── GET /api/usage/claude-limits ───────────────────────────────────────────────────────────────────────────────────────
/**
 * All windows of the last Claude snapshot (not only the blocking one), plus `measuredAt` (ms) — the page says
 * "measured N min ago". Reads ONLY usage_cache_v1 (no fetch, no `claude doctor`).
 */
export const CLAUDE_LIMITS_FIELDS = Object.freeze(["measuredAt", "window"]);
/** A window: `id` as in limits.js (session, weekly_all, weekly_opus, …), `area` = model name or "" for all. */
export const LIMIT_WINDOW_FIELDS = Object.freeze(["id", "group", "area", "percent", "resetsAt"]);

// ── GET /api/usage/openrouter-credit ─────────────────────────────────────────────────────────────────────────────────
/** Live from OpenRouter (/credits and /key), cached for 60 s. `known: false` ⇒ all numbers null (never 0). */
export const CREDIT_FIELDS = Object.freeze(["known", "totalUsd", "consumedUsd", "restUsd", "keyLimitUsd", "keyRestUsd", "at"]);

// ── GET/PUT/DELETE /api/openrouter ───────────────────────────────────────────────────────────────────────────────────────
/** GET response. The key itself never leaves the server. */
export const OPENROUTER_ACCESS_FIELDS = Object.freeze(["keySet", "onlyWithoutSaving", "noDataUsage"]);
/**
 * PUT body: both switches REQUIRED (boolean; a missing key is a 400, not "unchanged"); `apiKey` optional —
 * if missing, the stored one stays; an empty string is a 400. DELETE removes the key (the card stays).
 */
export const OPENROUTER_PUT_REQUIRED = Object.freeze(["onlyWithoutSaving", "noDataUsage"]);
