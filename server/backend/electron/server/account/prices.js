// The cost of an OpenRouter consumption — without a price table: everything is automatic. What remains here is what
// the outer loop (outerloop/run.js → outer_loop_runs cost) and the amount tick (account/openrouter-inquiry.js) need.
//
// The origin of an amount (COST_ORIGIN of the contract): reported — OpenRouter's response carried it (`usage.cost`, USD,
// providers/connectors/consumption.js openRouterCost); inquired — fetched later via `GET /generation?id=` (exact);
// estimated — computed with the catalog's list price (`estimatedCost`). A subscription has no cost per token (null),
// nor does a model without a catalog price — null means "unknown", never "free".

import { catalogModel } from "../providers/openrouter-catalog.js";

const count = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };
const price = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
// A reported amount: finite number ≥ 0, otherwise null (missing/broken = not reported, never 0).
const usd = (v) => (v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : null);

/**
 * The estimated cost of a consumption at the catalog's list price (USD per token): fresh input × `prompt`, output ×
 * `completion`, cache read × `cacheRead` (if missing: `prompt`), cache write × `cacheWrite` (if missing: `prompt`). The
 * caller passes cache without a split as read. Null without an input or output price.
 * @param {{ input?: number, output?: number, cacheRead?: number, cacheWrite?: number }} v  `input` = fresh (without cache)
 * @param {{ prompt?: number|null, completion?: number|null, cacheRead?: number|null, cacheWrite?: number|null } | null} prices
 */
export function estimatedCost(v, prices) {
  const p = prices && typeof prices === "object" ? prices : null;
  const one = price(p?.prompt), out = price(p?.completion);
  if (one === null || out === null) return null;
  return count(v?.input) * one + count(v?.output) * out + count(v?.cacheRead) * (price(p?.cacheRead) ?? one)
    + count(v?.cacheWrite) * (price(p?.cacheWrite) ?? one);
}

/**
 * The cost of ONE run in US dollars (the outer loop writes ONE number per run): subscription ⇒ null; a reported
 * amount (`reported`, USD, only when every round carried one) wins; otherwise estimated at the model's catalog price;
 * otherwise null. `input` in the form of the engine contract (FULL, including the cache `cached`).
 * @param {{ model: string, input?: number, output?: number, cached?: number, billing?: string, reported?: number|null, prices?: object|null }} o
 *        `prices`: catalog prices (otherwise from the catalog — seam for tests)
 * @returns {number|null}
 */
export function costFor({ model, input = 0, output = 0, cached = 0, billing = "metered", reported = null, prices }) {
  if (billing === "subscription") return null;
  const g = usd(reported);
  if (g !== null) return g;
  const p = prices === undefined ? (catalogModel(model)?.prices || null) : prices;
  const c = count(cached);
  return estimatedCost({ input: Math.max(0, count(input) - c), output, cacheRead: c }, p);
}
