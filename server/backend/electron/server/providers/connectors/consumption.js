// The consumption of a one-time call. Every connector calls
// `opts.atConsumption({provider, model, input, output, cached, cacheWrite, billing})` as soon as it knows the numbers;
// the caller books (`store.addUsageEvent` with source/agent id), not the connector.
//
// The contract of the numbers is that of the engine's `complete` (openai-chat.js `usage`): `input` is the FULL input
// side INCLUDING cached tokens, `cached` the cache-read share of it, `cacheWrite` the written one (the CLIs report it;
// otherwise 0) — both are contained in `input`.
//
// The BILLING KIND (`billing`, allowlist 'metered' | 'subscription', otherwise '') is NOT set by the connector but by
// providers/index.js runOnce from the provider kind — the same distinction as runs/do-run.js: a CLI with its own loop
// (claude/codex, `ownsAgentLoop`) runs on the subscription, OpenRouter over HTTP is paid per token. A connector cannot
// see its account.
//
// BOOKED per kind in the shape of the other rows of the same kind (`bookingCounts`): a metered row in the engine
// contract (like do-run.js `res.usage`), a subscription row in the tally shape (usage-tally.js, Codex chat
// `input − cached`): `input` fresh only, `cached` = read + write. With the engine contract in a subscription row the
// subscription report would count the cache read twice and the cache write under input.
//
// A leaf without imports. Without a callback nothing happens; a callback that throws (synchronously or as a rejected
// promise) does not fail the call — booking is bookkeeping, the response is the purpose.
const count = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n) : 0; };

const BILLING = new Set(["metered", "subscription"]);

// A reported AMOUNT (cost in USD): a finite number ≥ 0 — otherwise null = "not reported". Never 0 for a missing field:
// a zero is a price ("free", e.g. a `:free` model), a missing field says nothing.
export function amount(v) {
  const n = typeof v === "number" ? v : (typeof v === "string" && v.trim() ? Number(v) : NaN);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// `cost` (USD) and `upstream` (the provider behind the router) only go along if the connector knows them — a missing
// field means "unknown", and the report of a connector without both stays byte-identical.
// `generationId`: the id of the OpenRouter response (`gen-…`) — with it the periodic inquiry asks for a missing amount
// (account/openrouter-inquiry.js). Only if the connector knows it.
export function reportConsumption(callback, { provider = "", model = "", input = 0, output = 0, cached = 0, cacheWrite = 0, billing = "", cost = null, upstream = "", generationId = "" } = {}) {
  if (typeof callback !== "function") return;
  const warn = (e) => console.warn(`[consumption] callback of a one-time call failed: ${e?.message || e}`);
  const k = amount(cost);
  const a = String(upstream || "").trim();
  const g = String(generationId || "").trim();
  try {
    const r = callback({ provider: String(provider || ""), model: String(model || ""), input: count(input), output: count(output), cached: count(cached),
      cacheWrite: count(cacheWrite), billing: BILLING.has(billing) ? billing : "", ...(k !== null ? { cost: k } : {}), ...(a ? { upstream: a } : {}),
      ...(g ? { generationId: g } : {}) });
    if (r && typeof r.then === "function") r.then(undefined, warn);
  } catch (e) { warn(e); }
}

// ── The cost OpenRouter REPORTS per response ───────────────────────────────────────────────────────────────────────────
// Docs (https://openrouter.ai/docs/use-cases/usage-accounting): every response carries `usage` by itself (when
// streaming, in the last chunk), in it `cost` — "The total amount charged to your account", in credits; the base
// currency of the credits is the US dollar — and `cost_details.upstream_inference_cost` — "The actual cost charged by
// the upstream AI provider". The API reference adds `is_byok` ("Whether request used Bring Your Own Key").
//
// BYOK (own key at the provider, routed through OpenRouter): OpenRouter only deducts a FEE from the credits ("5% of
// what the same model/provider would cost normally on OpenRouter"; 0 within the free allowance) — that is `cost` then.
// The inference itself the user pays at THEIR provider: `upstream_inference_cost`. What they pay in total is the SUM.
// Without BYOK `cost` is already everything (the generation query calls `upstream_inference_cost` "0 or null" there) —
// adding it would be double when in doubt, hence ONLY with `is_byok === true`. If the upstream amount is missing with
// BYOK, the sum is unknown (null), not the fee alone: 5 % as the cost of the run would be a number twenty times too
// small that still looks like a report.
// `is_byok` is OPTIONAL in the API reference, and the BYOK example of the docs shows `cost` next to
// `upstream_inference_cost` WITHOUT the field. If it is missing (not a boolean) and an upstream amount > 0 stands next
// to it, it cannot be decided whether `cost` is already everything or only the fee ⇒ null (unknown). An explicit
// `is_byok: false` is a statement: then `cost` is everything.
//
// Only for a connector whose base URL points at openrouter.ai (`../openrouter-endpoints.js:isOpenRouterBase`): another
// gateway that happens to send a `cost` field has a unit cbase does not know.
export function openRouterCost(u) {
  if (!u || typeof u !== "object") return null;
  const cost = amount(u.cost);
  if (cost === null) return null;
  const upstream = amount(u.cost_details?.upstream_inference_cost);
  if (u.is_byok === false) return cost;
  if (u.is_byok !== true) return upstream !== null && upstream > 0 ? null : cost;
  return upstream === null ? null : cost + upstream;
}

// The reported cost of two consumption states TOGETHER (`{ input, output, cost }`, each one round or already a sum) —
// ALL OR NOTHING: if one part carries tokens but no amount, the sum is unknown (null), forever. Half reported and half
// computed does not exist: the reported rounds cost the price of the provider that delivered them, the others a table
// price that stands for some provider — the sum would look like a bill and be none. A run without a complete report
// therefore counts as "without report", and the table price (account/prices.js) applies to it, entirely.
// A part without tokens and without an amount does not count; both empty ⇒ null.
//
// `costMissing: true` means: this part DID cost something, but the amount is unknown — even with 0 tokens. That is how
// the connector marks an OpenRouter round whose stream broke off AFTER the response head (user stop, network) or that
// ended without a usage chunk, and the engine a round whose `complete` threw afterwards (engine.js `tallyUsage`,
// `completeWithRetry`). Otherwise such a round would count as "costs nothing", and a run whose paid round was lost
// would look completely reported. The mark sticks: whoever carries it passes it on to every sum (`consumptionPlus`,
// `tallyUsage`).
const missing = (x) => x?.costMissing === true;
export function combinedCost(a, b) {
  const part = (x) => {
    if (missing(x)) return null;
    const k = amount(x?.cost);
    if (k !== null) return k;
    return count(x?.input) || count(x?.output) ? null : 0;
  };
  const empty = (x) => !missing(x) && !count(x?.input) && !count(x?.output) && amount(x?.cost) === null;
  if (empty(a) && empty(b)) return null;
  const ka = part(a), kb = part(b);
  return ka === null || kb === null ? null : ka + kb;
}

// Two consumption states TOGETHER (`{ input, output, cached, cost?, upstream?, costMissing? }`; null/undefined =
// nothing): tokens added, cost all or nothing (`combinedCost`), the provider behind the router the most recent one, the
// mark `costMissing` sticks. For sums over ATTEMPTS of a turn (a restart by stall watchdog or human — every attempt
// cost something) and over the turns of a subagent until the next booking (providers/agent-runtime.js).
// Plus `cacheWrite` (the cache write, where the provider reports it) and `generations` (the generation ids of the
// OpenRouter responses — `generationsPlus`).
export function consumptionPlus(a, b) {
  const gen = generationsPlus(a?.generations, b?.generations);
  return {
    input: count(a?.input) + count(b?.input), output: count(a?.output) + count(b?.output), cached: count(a?.cached) + count(b?.cached),
    ...(count(a?.cacheWrite) + count(b?.cacheWrite) ? { cacheWrite: count(a?.cacheWrite) + count(b?.cacheWrite) } : {}),
    cost: combinedCost(a, b), upstream: String(b?.upstream || a?.upstream || ""),
    ...(gen !== undefined ? { generations: gen } : {}),
    ...(missing(a) || missing(b) ? { costMissing: true } : {}),
  };
}

// ── The generation ids of a consumption ────────────────────────────────────────────────────────────────────────────────
// One id per OpenRouter response (`gen-…`, the `id` field of every chunk). A booking carries the ids of ALL its
// responses: if its amount is missing (a round without a usage chunk, a break-off), the periodic inquiry asks for each
// (`GET /generation?id=`) and sums — exactly. At most GENERATIONS_MAX: above that the list becomes `null` (unusable,
// not truncated — an inquiry over a part would give an amount too small that looks exact), and the row is estimated
// with the catalog price.
export const GENERATIONS_MAX = 200;
/** Two lists together: `undefined` = not stated, `null` = overflowed (sticks), otherwise the ids without duplicates, in order. */
export function generationsPlus(a, b) {
  if (a === null || b === null) return null;
  if (a === undefined && b === undefined) return undefined;
  const out = [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])].filter((x, i, l) => typeof x === "string" && x && l.indexOf(x) === i);
  return out.length > GENERATIONS_MAX ? null : out;
}
/** The list as text of the column `usage_events.generation_id` ('' = none or unusable). */
export const generationsText = (gen) => (Array.isArray(gen) ? gen.join(" ") : "");

// The tokens a running counter (usage-tally.js, subscription subagent) has added since `prior` — never negative. Cache
// read and write are separate (`cacheRead` + `cacheWrite` = `cached`), for the breakdown in the display.
export function tokenIncrease(prior, now) {
  const plus = (k) => Math.max(0, count(now?.[k]) - count(prior?.[k]));
  return { input: plus("input"), output: plus("output"), cached: plus("cached"), cacheRead: plus("cacheRead"), cacheWrite: plus("cacheWrite") };
}

// Two states in the tally shape together (subscription subagent: sum over its turns).
export function subscriptionPlus(a, b) {
  const plus = (k) => count(a?.[k]) + count(b?.[k]);
  return { input: plus("input"), output: plus("output"), cached: plus("cached"), cacheRead: plus("cacheRead"), cacheWrite: plus("cacheWrite") };
}

// The parts of a consumption state for display: `input` (input WITHOUT any cache share), `cacheWrite`, `cacheRead`,
// `output`. Two shapes arrive (see header): metered in the engine contract (`input` FULL, `cached` = read, `cacheWrite`
// inside it — the engine does not report it, then the write is contained in `input`), otherwise the tally shape
// (`input` fresh, `cacheRead`/`cacheWrite` separate). An old state only knows `cached` (= both): whatever of it is not
// assigned to a part counts as read — also in a state that a resumed agent keeps counting afterwards.
export function tokenParts(u, billing = "") {
  const cached = count(u?.cached), write = count(u?.cacheWrite);
  if (billing === "metered") {
    return { input: Math.max(0, count(u?.input) - cached - write), cacheWrite: write, cacheRead: cached, output: count(u?.output) };
  }
  return { input: count(u?.input), cacheWrite: write, cacheRead: Math.max(count(u?.cacheRead), cached - write), output: count(u?.output) };
}

// The ONE number cbase shows per agent and per workflow: everything except cache hits — input, cache write, output.
// The cache write counts (with Claude the largest part of the new input). The cache read stays out — it only repeats
// what is already counted and would otherwise be almost the whole number; it is in the breakdown.
export function tokenSum(parts) {
  return count(parts?.input) + count(parts?.cacheWrite) + count(parts?.output);
}

// An error of a call that came AFTER the response head (see `costMissing` above): marked and returned, to be rethrown.
export function withCostMissing(e) {
  if (e && typeof e === "object") { try { e.costMissing = true; } catch { /* frozen — then without the mark */ } }
  return e;
}

// The usage of the Anthropic shape (Claude CLI `result.usage`, Messages API `usage`) into the contract above.
export function anthropicConsumption(u) {
  if (!u || typeof u !== "object") return null;
  const cacheRead = count(u.cache_read_input_tokens);
  const cacheWrite = count(u.cache_creation_input_tokens);
  return { input: count(u.input_tokens) + cacheRead + cacheWrite, output: count(u.output_tokens), cached: cacheRead, cacheWrite };
}

// ── The fields of a usage_events row (store/account.js addUsageEvent) ───────────────────────────────────────────────────────
// With the cache SEPARATE (`cacheRead`/`cacheWrite` — otherwise the expensive write hides invisibly in the cheap read)
// and with the generation ids. Three shapes arrive, one function each:

/** metered (engine contract): `input` FULL, `cached` = read, `cacheWrite` = written (both in `input`), `cost`, `generations`. */
export function meteredBooking(u = {}) {
  const k = amount(u?.cost);
  const gen = generationsText(u?.generations);
  return { billing: "metered", input: count(u?.input), output: count(u?.output), cacheRead: count(u?.cached), cacheWrite: count(u?.cacheWrite),
    ...(k !== null ? { costUsd: k } : {}), ...(gen ? { generationId: gen } : {}) };
}

/**
 * Subscription in the tally shape (usage-tally.js, subscription subagent): `input` fresh, `cached` = read + write,
 * separated into `cacheRead`/`cacheWrite`. A state without separation (an old image, a sum with one) stays UNSPLIT
 * (only `cached`) — the parts must add up to exactly the sum, otherwise it is not a separation.
 */
export function subscriptionBooking(t = {}) {
  const read = t?.cacheRead, write = count(t?.cacheWrite);
  const separated = typeof read === "number" && Number.isFinite(read) && count(read) + write === count(t?.cached);
  return { billing: "subscription", input: count(t?.input), output: count(t?.output), cached: count(t?.cached),
    ...(separated ? { cacheRead: count(read), cacheWrite: write } : {}) };
}

// The numbers of a usage_events row from the report of a ONE-TIME call (see header): metered ⇒ engine contract
// (`meteredBooking`); otherwise (subscription, also a report without a kind — that was the booking's default) ⇒ tally
// shape, `input` fresh only, `cached` = read + write, both separate. Reported cost (`cost`, USD) and the generation id
// only go into a metered row — a subscription has no cost per token.
export function bookingCounts(v = {}) {
  if (v.billing === "metered") {
    const g = String(v.generationId || "").trim();
    return meteredBooking({ ...v, generations: g ? [g] : undefined });
  }
  const input = count(v.input), cached = count(v.cached), cacheWrite = count(v.cacheWrite);
  return subscriptionBooking({ input: Math.max(0, input - cached - cacheWrite), output: v.output, cached: cached + cacheWrite, cacheRead: cached, cacheWrite });
}
