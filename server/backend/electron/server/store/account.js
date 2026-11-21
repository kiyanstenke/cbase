// Account: token/cost recording (`usage_events`) — booking, the aggregates of the "Usage" page, the inquiry of the
// OpenRouter amounts.
// Answers: what did a run consume and cost, and where did the quota of a provider go within a window.
//
// The table `providers` is read and written only by store/provider.js (the OpenRouter access). The aggregates of the
// usage routes (`usageGroups`, `usagePerDay`) are here — the computing happens in account/usage-report.js, the
// prices of the equivalent value in account/equivalent.js.

import { db } from "./db.js";

// ── Token/cost recording ─────────────────────────────────────────────────────
// One record per finished run, kind (main stream/subagent) and model. History data survives the deletion of a chat
// (the usage page then calls it "deleted").
//
// Two SHAPES per billing kind (providers/connectors/consumption.js bookingCounts): `metered` (OpenRouter) in the
// contract of the engine — `input` is the FULL input side including cache, `cached` the cache share of it —,
// `subscription` (Claude/Codex) in the shape of the tally — `input` only fresh, `cached` beside it. The fresh input
// is therefore `input − cached` (metered) or `input` (subscription); the aggregates compute that in SQL (`FRESH`),
// no reader sees the two shapes.
//
// `cache_read` / `cache_write` (schema "usage-breakdown"): the cache SPLIT. NULL = the row is from before the split,
// only the sum `cached` is known (the usage page shows it as "unsplit"). With the split `cached` is always
// `cache_read + cache_write` — the sum stays so that every old reader (usageByRun, the golden runs) computes
// unchanged.
//
// `source`: the origin of a one-off call — 'retrieval' (summary on demand), 'outer_loop', 'once' (every other
// runOnce place, the role from `ONCE_ROLES` of the contract in `agent_id`); everything else (a typo too) is '' = a
// run. `agentId`: the causing agent (subagent, outer loop agent, app agent of the retrieval) or the role, ''
// without. store/ is domain-free (server/backend/test/import-direction.test.js) and does not read the contract
// (account/usage-contract.js) — the two lists here therefore stand a second time;
// server/backend/test/usage-routes.test.js holds them against the contract.
const USAGE_SOURCES = new Set(["", "retrieval", "outer_loop", "once"]);
// `cost_origin` (COST_ORIGIN of the contract): where the amount of a metered row comes from — 'reported' (the
// response carried it), 'inquired' (GET /generation?id= in the tick, account/openrouter-inquiry.js), 'estimated'
// (catalog price for a row without an id). '' = no amount (`cost_usd` NULL — unknown, never 0).
const COST_ORIGIN_COLUMN = new Set(["reported", "inquired", "estimated"]);
// `costUsd`: the amount of this row in USD — only for `metered` and only a finite number ≥ 0, otherwise NULL. A
// subscription has no cost per token, even if a caller passed something. `upstream`: the provider behind the router
// that served the last round ('' = none named) — display ("price last"), never computation. `generationId`: the
// generation ids of the OpenRouter responses of this row, separated by spaces — so that the tick can inquire a
// missing amount.
const usdAmount = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
const tokenCount = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n) : 0; };
const tokenOrNull = (v) => (v === null || v === undefined || v === "" ? null : (Number.isFinite(Number(v)) ? Math.max(0, Math.round(Number(v))) : null));
// At most this many characters of generation ids per row (≈ 200 responses). What exceeds it is NOT stored
// truncated — an inquiry over a part of the responses would give too small an amount that looked like an exact
// one — but not at all: the row is then estimated.
const GENERATION_MAX = 8000;

/**
 * Book a consumption row. `cacheRead` (number) makes the row SPLIT — `cacheWrite` is then 0 if missing, and `cached`
 * is their sum (a passed `cached` does not count). Without `cacheRead` it stays unsplit with `cached` (the old
 * shape). `at` (ms): only the late booking after a crash (runs/lateBooking.js) books at the time of the session
 * rows — otherwise now. Returns the id of the row (0 without a provider).
 */
export function addUsageEvent({
  provider, model = "", input = 0, output = 0, cached = 0, cacheRead = null, cacheWrite = null,
  billing = "metered", kind = "main", chatId = "", runId = "", step = 0, secs = 0, source = "", agentId = "",
  costUsd = null, upstream = "", generationId = "", costOrigin = "", at = null,
}) {
  if (!provider) return 0;
  const q = USAGE_SOURCES.has(String(source ?? "")) ? String(source ?? "") : "";
  const kindName = billing === "subscription" ? "subscription" : "metered";
  const read = tokenOrNull(cacheRead);
  const write = read === null ? null : (tokenOrNull(cacheWrite) ?? 0);
  const sum = read === null ? tokenCount(cached) : read + write;
  const amount = kindName === "metered" ? usdAmount(costUsd) : null;
  const origin = amount === null ? "" : (COST_ORIGIN_COLUMN.has(String(costOrigin || "")) ? String(costOrigin) : "reported");
  const time = Number.isFinite(Number(at)) && Number(at) > 0 ? Math.round(Number(at)) : Date.now();
  const genRaw = kindName === "metered" ? String(generationId || "").trim() : "";
  const gen = genRaw.length > GENERATION_MAX ? "" : genRaw;
  return Number(db.prepare(`INSERT INTO usage_events (provider, model, input, output, cached, at, billing, kind, chat_id, run_id, step, secs, source,
                agent_id, cost_usd, upstream_provider, cache_read, cache_write, generation_id, cost_origin)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      provider, model || "",
      tokenCount(input), tokenCount(output), sum,
      time,
      kindName,
      kind === "sub" ? "sub" : "main",
      chatId || "", runId || "", Math.max(0, Math.round(Number(step) || 0)), Math.max(0, Math.round(Number(secs) || 0)),
      q, agentId == null ? "" : String(agentId),
      amount, String(upstream || "").slice(0, 200),
      read, write, gen, origin,
    ).lastInsertRowid);
}

// Consumption of a workflow run, broken down per step — answers "which step used up the quota". Main stream and
// subagents listed separately. Without compute time.
export const usageByRun = (runId) =>
  db.prepare(`SELECT step, kind, provider, model,
                SUM(input) AS input, SUM(output) AS output, SUM(cached) AS cached,
                COUNT(*) AS runs, MIN(at) AS firstAt, MAX(at) AS lastAt
              FROM usage_events WHERE run_id = ?
              GROUP BY step, kind ORDER BY step ASC, kind ASC`).all(String(runId || ""));

// ── The aggregates of the "Usage" page ───────────────────────────────────────────────────────────────────────────────────────
// The fresh input per shape (see head) and the parts of the cache — the same expressions in every query.
const FRESH = "CASE WHEN billing = 'metered' THEN MAX(0, input - cached) ELSE input END";
const SUMS_SQL = `SUM(${FRESH}) AS input, SUM(output) AS output,
    SUM(COALESCE(cache_read, 0)) AS cacheRead, SUM(COALESCE(cache_write, 0)) AS cacheWrite,
    SUM(CASE WHEN cache_read IS NULL THEN cached ELSE 0 END) AS cacheUnsplit,
    COUNT(*) AS runs, SUM(cost_usd) AS costUsd,
    SUM(CASE WHEN cost_usd IS NOT NULL AND cost_origin = 'reported' THEN 1 ELSE 0 END) AS reported,
    SUM(CASE WHEN cost_usd IS NOT NULL AND cost_origin = 'inquired' THEN 1 ELSE 0 END) AS inquired,
    SUM(CASE WHEN cost_usd IS NOT NULL AND cost_origin = 'estimated' THEN 1 ELSE 0 END) AS estimated,
    SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS unknown`;
// The role of a background row: for 'once' the role in agent_id, for 'retrieval'/'outer_loop' the source itself, otherwise ''.
const ROLE_SQL = "CASE source WHEN 'once' THEN agent_id WHEN '' THEN '' ELSE source END";
const limitValue = (v, preset) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : preset);

/**
 * The rows of a provider in `[from, until)`, grouped by chat, role, kind and model — enough for every list of the
 * page (sums, models, chats, background, subagent share): the computing happens in account/usage-report.js, because
 * the equivalent value holds per MODEL. `chatId` '' = without a chat; `role` '' = a run (main turn or subagent),
 * otherwise a role of the one-off calls.
 */
const usageGroups = (provider, from = 0, until = Number.MAX_SAFE_INTEGER) =>
  db.prepare(`SELECT chat_id AS chatId, ${ROLE_SQL} AS role, kind, model, ${SUMS_SQL}, MAX(at) AS last
              FROM usage_events WHERE provider = ? AND at >= ? AND at < ?
              GROUP BY chat_id, role, kind, model`)
    .all(String(provider || ""), limitValue(from, 0), limitValue(until, Number.MAX_SAFE_INTEGER));

/**
 * The same sums per calendar day (`offsetMs` = offset of the client's time zone) and model, from the start of the
 * first day `ofMs`. `dayNumber` = days since 1970 in the client's time zone; account/usage-report.js fills the gaps.
 */
const usagePerDay = (provider, ofMs, offsetMs = 0) =>
  db.prepare(`SELECT CAST((at + ?) / 86400000 AS INTEGER) AS dayNumber, model, ${SUMS_SQL}
              FROM usage_events WHERE provider = ? AND at >= ?
              GROUP BY dayNumber, model ORDER BY dayNumber ASC`)
    .all(limitValue(offsetMs, 0), String(provider || ""), limitValue(ofMs, 0));

/** Titles of the chats (if one is missing, it is deleted) — `Map<id, title>`. */
function chatTitle(ids) {
  const out = new Map();
  const list = [...new Set((ids || []).map(String).filter(Boolean))];
  for (let i = 0; i < list.length; i += 200) {
    const part = list.slice(i, i + 200);
    for (const r of db.prepare(`SELECT id, title FROM chats WHERE id IN (${part.map(() => "?").join(", ")})`).all(...part)) out.set(r.id, r.title || "");
  }
  return out;
}

/**
 * The models of a cost-reporting provider with the provider behind the router of the MOST RECENT row that names
 * one — for the OpenRouter price route (price "last"). In ONE grouped pass (`last`: the highest id per model among
 * the rows with a name) — a subquery per group ran over all rows for every model.
 */
const meteredModels = (provider) =>
  db.prepare(`WITH last AS (
                SELECT v.model AS model, v.upstream_provider AS upstream FROM usage_events v
                JOIN (SELECT MAX(id) AS id FROM usage_events WHERE provider = ? AND billing = 'metered' AND upstream_provider <> ''
                      GROUP BY model) j ON j.id = v.id
              )
              SELECT u.model AS model, COALESCE(MAX(l.upstream), '') AS upstream, MAX(u.at) AS last
              FROM usage_events u LEFT JOIN last l ON l.model = u.model
              WHERE u.provider = ? AND u.billing = 'metered'
              GROUP BY u.model ORDER BY u.model ASC`).all(String(provider || ""), String(provider || ""));

// ── Inquire and estimate amounts (OpenRouter, generation id) ─────────────────────────────────────────────────────────────────
/** metered rows without an amount WITH generation ids, booked in `[sinceMs, untilMs)`, oldest first. */
const rowsToInquire = (provider, { sinceMs = 0, untilMs = Number.MAX_SAFE_INTEGER, limit = 50 } = {}) =>
  db.prepare(`SELECT id, model, generation_id AS generationId, at FROM usage_events
              WHERE provider = ? AND billing = 'metered' AND cost_usd IS NULL AND generation_id <> '' AND at >= ? AND at < ?
              ORDER BY id ASC LIMIT ?`).all(String(provider || ""), limitValue(sinceMs, 0), limitValue(untilMs, Number.MAX_SAFE_INTEGER), Math.max(1, Math.min(500, limitValue(limit, 50))));

/**
 * metered rows without an amount to ESTIMATE, booked before `untilMs`: without a generation id — and with an id if
 * they were booked before `abandonBeforeMs` (the inquiry had its time). Oldest first. With the tokens in the shape
 * of the page.
 */
const rowsToEstimate = (provider, { untilMs, abandonBeforeMs = 0, limit = 500 } = {}) =>
  db.prepare(`SELECT id, model, ${FRESH} AS input, output, COALESCE(cache_read, cached) AS cacheRead, COALESCE(cache_write, 0) AS cacheWrite
              FROM usage_events
              WHERE provider = ? AND billing = 'metered' AND cost_usd IS NULL AND at < ? AND (generation_id = '' OR at < ?)
              ORDER BY id ASC LIMIT ?`).all(String(provider || ""), limitValue(untilMs, 0), limitValue(abandonBeforeMs, 0), Math.max(1, Math.min(5000, limitValue(limit, 500))));

/** Set the amount of a row — only if it has none yet (a second tick overwrites nothing). Returns whether set. */
function setRowsCost(id, usd, origin) {
  const b = usdAmount(usd);
  if (b === null || !COST_ORIGIN_COLUMN.has(String(origin || ""))) return false;
  return db.prepare("UPDATE usage_events SET cost_usd = ?, cost_origin = ? WHERE id = ? AND cost_usd IS NULL AND billing = 'metered'")
    .run(b, String(origin), Number(id)).changes > 0;
}

/** One row (for tests and information). */
const usageRow = (id) => db.prepare("SELECT * FROM usage_events WHERE id = ?").get(Number(id)) || null;

// The reported cost and the provider behind the router per consumption row (registration "usage-cost" in store.js):
// `cost_usd` NULLABLE — NULL means "not reported", never "free" — and `upstream_provider`. The table is created by
// store/db.js; here only the alignment via PRAGMA, idempotent (a fresh DB gets the columns on the first start, an
// existing one catches up, a second start is a no-op). Without this every booking would fail (no such column,
// silently caught) — no run would show up in the usage any more.
function initUsageCostSchema() {
  const have = new Set(db.prepare("PRAGMA table_info(usage_events)").all().map((c) => c.name));
  if (!have.has("cost_usd")) db.exec("ALTER TABLE usage_events ADD COLUMN cost_usd REAL");
  if (!have.has("upstream_provider")) db.exec("ALTER TABLE usage_events ADD COLUMN upstream_provider TEXT NOT NULL DEFAULT ''");
}

// The split of the cache, the generation ids and the origin of an amount (registration "usage-breakdown" in
// store.js, AFTER "usage-cost"): PRAGMA-checked `ADD COLUMN` as there. Plus two catch-ups, idempotent (they only
// touch rows that are still empty — a second start is a no-op):
//   · an amount already REPORTED carries the origin 'reported' — it can only have been that (until then only the
//     report per response wrote `cost_usd`);
//   · Codex writes no cache (the CLI only reports `cached_input_tokens`): the old sum of a Codex row IS read cache,
//     the split can be filled in exactly. Claude and OpenRouter rows stay unsplit (the sum mixed reading and writing
//     or did not know the writing).
// Without this registration every booking would fail (no such column, silently caught) — the usage would stay empty.
function initUsageBreakdownSchema() {
  const have = new Set(db.prepare("PRAGMA table_info(usage_events)").all().map((c) => c.name));
  if (!have.has("cache_read")) db.exec("ALTER TABLE usage_events ADD COLUMN cache_read INTEGER");
  if (!have.has("cache_write")) db.exec("ALTER TABLE usage_events ADD COLUMN cache_write INTEGER");
  if (!have.has("generation_id")) db.exec("ALTER TABLE usage_events ADD COLUMN generation_id TEXT NOT NULL DEFAULT ''");
  if (!have.has("cost_origin")) db.exec("ALTER TABLE usage_events ADD COLUMN cost_origin TEXT NOT NULL DEFAULT ''");
  db.exec("UPDATE usage_events SET cost_origin = 'reported' WHERE cost_usd IS NOT NULL AND cost_origin = ''");
  db.exec("UPDATE usage_events SET cache_read = cached, cache_write = 0 WHERE provider = 'codex' AND cache_read IS NULL");
  // The windows of the usage query per provider from a point in time.
  db.exec("CREATE INDEX IF NOT EXISTS idx_usage_provider_at ON usage_events(provider, at)");
}

export {
  initUsageCostSchema, initUsageBreakdownSchema, usageGroups, usagePerDay, chatTitle, meteredModels,
  rowsToInquire, rowsToEstimate, setRowsCost, usageRow,
};
