// The API equivalent of a subscription consumption. A subscription accounts for its quota itself — the number here says
// what THE SAME tokens would have cost at the API list price, as a measure of where the quota went. An ESTIMATE, not a
// price anyone pays; the UI says so next to it.
//
// A leaf without imports: the caller passes the prices in (account/usage-report.js from `providers/openrouter-catalog.js
// catalogModel` — OpenRouter's public catalog, USD per token). The rules:
//   · Claude model `claude-<family>-<a>-<b>` (also with a date `-YYYYMMDD` and suffix `[1m]`) ↔ `anthropic/claude-<family>-<a>.<b>`;
//     Codex model ↔ `openai/<id>`. Without a match the price is UNKNOWN (`priceKnown: false`) — never 0.
//   · Input = `prompt`, output = `completion`, cache read = the catalog's `input_cache_read`.
//   · Cache write: Claude = 2 × input price (the CLI writes with a 1 h TTL — the catalog value `input_cache_write`
//     applies to 5 min); Codex = 0 (OpenAI does not charge for writing).
//   · Cache without a split (older rows, only the sum known) gets NO price — it makes the equivalent
//     incomplete (`complete: false`) instead of shrinking it as cheap reading.

/** The id in the OpenRouter catalog under which the list price of a subscription model is found — "" = none. */
export function equivalentModelId(provider, model) {
  const m = String(model || "").trim().toLowerCase().replace(/\[[^\]]*\]$/, "");
  if (!m) return "";
  if (provider === "claude") {
    const t = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(m);
    return t ? `anthropic/claude-${t[1]}-${t[2]}${t[3] ? `.${t[3]}` : ""}` : "";
  }
  if (provider === "codex") return /^[a-z0-9][a-z0-9.\-]*$/.test(m) ? `openai/${m}` : "";
  return "";
}

const price = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

/**
 * The per-token prices of a subscription model from the catalog prices (`{ prompt, completion, cacheRead, cacheWrite }`, USD per
 * token, null = unknown) — `{ input, output, cacheRead, cacheWrite }`, or null when the input or output price is missing.
 */
export function equivalentPrices(provider, catalogPrices) {
  const p = catalogPrices && typeof catalogPrices === "object" ? catalogPrices : null;
  const input = price(p?.prompt), output = price(p?.completion);
  if (input === null || output === null) return null;
  return {
    input, output,
    cacheRead: price(p?.cacheRead),
    cacheWrite: provider === "claude" ? 2 * input : provider === "codex" ? 0 : price(p?.cacheWrite),
  };
}

const count = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };

/**
 * The equivalent of a consumption (`{ input, output, cacheRead, cacheWrite, cacheUnsplit }`, tokens) at prices from
 * `equivalentPrices` (null = price unknown). Returns `{ equivalentUsd, partsUsd, complete, priceKnown }` — without a price
 * `equivalentUsd` and all parts are null; a part without its own price (cache read) is null as soon as it has tokens.
 */
export function equivalent(v, prices) {
  const tok = { input: count(v?.input), output: count(v?.output), cacheRead: count(v?.cacheRead), cacheWrite: count(v?.cacheWrite) };
  const unsplit = count(v?.cacheUnsplit);
  if (!prices) {
    const empty = !tok.input && !tok.output && !tok.cacheRead && !tok.cacheWrite && !unsplit;
    return { equivalentUsd: null, partsUsd: { input: null, output: null, cacheRead: null, cacheWrite: null }, complete: empty, priceKnown: false };
  }
  const part = (k) => (tok[k] === 0 ? 0 : (prices[k] === null || prices[k] === undefined ? null : tok[k] * prices[k]));
  const partsUsd = { input: part("input"), output: part("output"), cacheRead: part("cacheRead"), cacheWrite: part("cacheWrite") };
  const values = Object.values(partsUsd);
  return {
    equivalentUsd: values.reduce((s, x) => s + (x ?? 0), 0),
    partsUsd,
    complete: values.every((x) => x !== null) && unsplit === 0,
    priceKnown: true,
  };
}

/** Two equivalents combined (per field; null + null = null, a number wins) — for sums across models. */
export function equivalentPlus(a, b) {
  const plus = (x, y) => (x === null || x === undefined ? (y ?? null) : (y === null || y === undefined ? x : x + y));
  if (!a) return b;
  if (!b) return a;
  return {
    equivalentUsd: plus(a.equivalentUsd, b.equivalentUsd),
    partsUsd: {
      input: plus(a.partsUsd?.input, b.partsUsd?.input), output: plus(a.partsUsd?.output, b.partsUsd?.output),
      cacheRead: plus(a.partsUsd?.cacheRead, b.partsUsd?.cacheRead), cacheWrite: plus(a.partsUsd?.cacheWrite, b.partsUsd?.cacheWrite),
    },
    complete: a.complete === true && b.complete === true,
    priceKnown: a.priceKnown === true || b.priceKnown === true,
  };
}
