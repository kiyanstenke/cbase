// providers/openrouter-endpoints.js — the endpoints (providers) of a model behind a router.
//
// OpenRouter lists per model `GET <base>/models/<id>/endpoints`: `data.endpoints[]` with `provider_name`,
// `context_length` and `status` (0 = fine, negative = degraded). Two questions depend on it, and this leaf answers both:
//   • `providers/openrouter-catalog.js:catalogUse` (on first use of a model): which number does cbase compute with
//     when `top_provider` and `context_length` disagree — the median of the active endpoints (`endpointsMedian`);
//   • the connector (`connectors/openai-chat.js:providerWindow`), i.e. the RUN PATH: how large is the window of the
//     provider that delivered the last response (`windowOf`) — display only, computation uses the catalog number.
// `runs/` must not import a domain folder (server/backend/test/import-direction.test.js), `providers/` is none; that is
// why this lives here and not under `account/`. A LEAF without imports.
//
// Measured at the public API (no key): the same `provider_name` can appear twice. An ALIAS (id with "~" and
// `alias_target.slug`) answers with ZERO endpoints — so the alias's target is asked instead.
//
// The median is a HEURISTIC, not a promise about the provider that gets a call: OpenRouter picks anew per request,
// weighted by the inverse square of the price (plus load and outages). That is why the UI shows the provider of the
// last response together with ITS window next to it.
//
// Only SUCCESSFUL fetches are cached, 1 h per process (per base URL and model); a failed one is retried next time.
// Deadline per fetch 8 s, combined with the caller's signal.
//
// Every endpoint also carries its PRICE (prices vary by provider for the same model): `pricing.prompt` /
// `pricing.completion` are strings in USD PER TOKEN; here per 1M tokens (`priceIn`, `priceOut`). A negative number
// ("-1", e.g. openrouter/auto — the price depends on the routed model) or a missing field is UNKNOWN (null), never 0;
// "0" is a price (`:free`). Asked by the usage tab (account/routes.js, `GET /api/usage/openrouter-prices` via
// `connectors/openai-chat.js:modelPrices`): the span over the active endpoints and the price of the provider of the
// last response (`priceSpan`). DISPLAY ONLY — billing follows the report per response
// (`connectors/consumption.js:openRouterCost`), not this list.

const ENDPOINT_DEADLINE_MS = 8_000;
const TTL_MS = 60 * 60 * 1000;

// `${base}\n${target}` → { until, endpoints }
const endpointsCache = new Map();
// base → { until, targets: Map(alias → target) } — only for aliases the caller cannot resolve (run path).
const aliasCache = new Map();

const count = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0; };
// USD per token (string or number) → USD per 1M tokens, rounded to six places (0.00000043 × 1e6 is
// 0.43000000000000005 in floating point); negative, empty or not a number ⇒ null (unknown).
const perMillion = (v) => {
  const n = typeof v === "number" ? v : (typeof v === "string" && v.trim() ? Number(v) : NaN);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1e12) / 1e6 : null;
};
const signalWith = (signal) => {
  const deadline = AbortSignal.timeout(ENDPOINT_DEADLINE_MS);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
};
const header = (key) => (key ? { Authorization: `Bearer ${key}` } : {});

// The target of an alias from the catalog (`alias_target.slug`). Only asked when the caller does not pass it and the id
// looks like an alias ("~"). If the fetch fails, the id itself stays (the endpoint fetch then simply returns nothing).
async function aliasTargetFromCatalog(base, key, id, signal) {
  const hits = aliasCache.get(base);
  if (hits && hits.until > Date.now()) return hits.targets.get(id) || id;
  const r = await fetch(`${base}/models`, { headers: header(key), signal: signalWith(signal) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  const targets = new Map();
  for (const x of Array.isArray(j?.data) ? j.data : []) {
    const slug = x?.alias_target?.slug;
    if (typeof x?.id === "string" && typeof slug === "string" && slug) targets.set(x.id, slug);
  }
  aliasCache.set(base, { until: Date.now() + TTL_MS, targets });
  return targets.get(id) || id;
}

/** Does this base URL point at OpenRouter? (`openrouter.ai` itself or a subdomain — never a name that merely ends that way.) */
export function isOpenRouterBase(url) {
  try {
    const h = new URL(String(url || "")).hostname.toLowerCase().replace(/\.$/, "");
    return h === "openrouter.ai" || h.endsWith(".openrouter.ai");
  } catch { return false; }
}

/**
 * The endpoints of a model, normalized: [{ name, context, status, priceIn, priceOut }] (`status` missing ⇒ 0; prices
 * per 1M tokens in USD, null = unknown). Throws on HTTP error, deadline or abort — the caller decides what holds then.
 * @param {string} base  without a trailing slash (…/api/v1)
 * @param {string} key   API key or "" (the public OpenRouter API needs none)
 * @param {string} id    model id; an alias ("~…") asks its target
 * @param {{ signal?: AbortSignal, aliasTarget?: string }} [opts]  aliasTarget: `alias_target.slug`, if the catalog is already there
 */
export async function fetchEndpoints(base, key, id, { signal, aliasTarget = "" } = {}) {
  let target = String(aliasTarget || "") || String(id || "");
  if (!aliasTarget && target.startsWith("~")) {
    try { target = await aliasTargetFromCatalog(base, key, target, signal); } catch { /* then the id itself */ }
  }
  const keyName = `${base}\n${target}`;
  const hits = endpointsCache.get(keyName);
  if (hits && hits.until > Date.now()) return hits.endpoints;
  const path = target.split("/").map(encodeURIComponent).join("/");
  const r = await fetch(`${base}/models/${path}/endpoints`, { headers: header(key), signal: signalWith(signal) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  const endpoints = (Array.isArray(j?.data?.endpoints) ? j.data.endpoints : [])
    .filter((e) => e && typeof e === "object")
    .map((e) => ({ name: String(e.provider_name || ""), context: count(e.context_length), status: Number(e.status) || 0,
      priceIn: perMillion(e.pricing?.prompt), priceOut: perMillion(e.pricing?.completion) }));
  endpointsCache.set(keyName, { until: Date.now() + TTL_MS, endpoints });
  return endpoints;
}

/** The median of the ACTIVE endpoints (status not negative), with an even count the lower of the two middle ones; 0 = none. */
export function endpointsMedian(endpoints) {
  const values = (Array.isArray(endpoints) ? endpoints : [])
    .filter((e) => e && !(Number(e.status) < 0))
    .map((e) => count(e.context))
    .filter(Boolean)
    .sort((a, z) => a - z);
  return values.length ? values[Math.floor((values.length - 1) / 2)] : 0;
}

// OpenRouter itself does not compare names case-sensitively; neither do we (a precaution against a differing spelling).
const nameNorm = (s) => String(s || "").trim().toLowerCase();

/**
 * The window of ONE provider (name as in the response, field `provider`): its active endpoints, otherwise all with
 * that name; if several numbers stand there, the SMALLEST (when in doubt the smaller window). 0 = unknown.
 */
export function windowOf(endpoints, name) {
  const n = nameNorm(name);
  if (!n) return 0;
  const all = (Array.isArray(endpoints) ? endpoints : []).filter((e) => e && nameNorm(e.name) === n && count(e.context));
  const active = all.filter((e) => !(Number(e.status) < 0));
  const values = (active.length ? active : all).map((e) => count(e.context));
  return values.length ? Math.min(...values) : 0;
}

/**
 * The price span per 1M tokens (USD): without `name` over the ACTIVE endpoints of the model (status not negative), with
 * `name` over the endpoints of THIS provider (active before degraded, like `windowOf` — a provider can carry several,
 * e.g. two quantizations with two prices; the response does not say which one delivered it). Only endpoints with BOTH
 * prices count. Result `{ inMin, inMax, outMin, outMax, endpoints }` or null (no endpoint with a price — unknown, never 0).
 */
export function priceSpan(endpoints, name = "") {
  let list = (Array.isArray(endpoints) ? endpoints : []).filter((e) => e && e.priceIn != null && e.priceOut != null);
  if (name) {
    const n = nameNorm(name);
    if (!n) return null;
    const all = list.filter((e) => nameNorm(e.name) === n);
    const active = all.filter((e) => !(Number(e.status) < 0));
    list = active.length ? active : all;
  } else {
    list = list.filter((e) => !(Number(e.status) < 0));
  }
  if (!list.length) return null;
  const one = list.map((e) => e.priceIn), out = list.map((e) => e.priceOut);
  return { inMin: Math.min(...one), inMax: Math.max(...one), outMin: Math.min(...out), outMax: Math.max(...out), endpoints: list.length };
}
