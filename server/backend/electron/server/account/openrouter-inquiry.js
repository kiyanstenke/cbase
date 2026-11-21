// The tick of the OpenRouter amounts. An OpenRouter response carries its amount (`usage.cost`,
// providers/connectors/consumption.js openRouterCost) — but not every one: a broken stream, a user stop, a response
// without a usage chunk leave the row without an amount (`cost_usd` NULL, "unknown"). Then:
//   1. INQUIRE (exact): every row carries the generation ids of its responses (`generation_id`, space-separated) —
//      `GET <base>/generation?id=<id>` returns the amount per response (`total_cost`, with BYOK also
//      `upstream_inference_cost` as in openRouterCost). All ids of a row or none: a half-inquired sum would look exact.
//   2. ESTIMATE (catalog price, account/prices.js estimatedCost): a row without an id older than 1 h, and one with an id
//      that could not be inquired for 24 h (OpenRouter does not keep generations retrievable forever). Cache without a
//      split counts as read (the query delivers it that way). A model without a catalog price stays unknown — null, never 0.
// At most INQUIRIES_PER_RUN retrievals per run, tick every INQUIRY_TICK_MS (10 min; `CBASE_OPENROUTER_TICK_MS`, 0 = off).
// Without a key or without network (CBASE_OPENROUTER_OFFLINE against the real base) only estimation happens. A set amount
// is never overwritten (store/account.js setRowsCost: only `cost_usd IS NULL`). Started and stopped in server.js.
// Guard: server/backend/test/usage-routes.test.js.

import * as store from "../store.js";
import { OPENROUTER_ID } from "./usage-contract.js";
import { catalogModel, openRouterBase, openRouterNetworkAllowed } from "../providers/openrouter-catalog.js";
import { estimatedCost } from "./prices.js";
import { openRouterCost } from "../providers/connectors/consumption.js";

export const INQUIRIES_PER_RUN = 50;
export const ESTIMATE_WITHOUT_ID_AFTER_MS = 60 * 60_000;
export const ESTIMATE_WITH_ID_AFTER_MS = 24 * 60 * 60_000;
const INQUIRY_DEADLINE_MS = 15_000;
export const INQUIRY_TICK_MS = () => {
  const n = Number(process.env.CBASE_OPENROUTER_TICK_MS);
  return Number.isFinite(n) && n >= 0 ? n : 10 * 60_000;
};

// The amount of ONE generation (USD) from the `/generation` response — with the SAME function as the amount in the
// stream (consumption.js openRouterCost), only the query's field names translated: `total_cost` is `cost`,
// `upstream_inference_cost` sits at the top level instead of in `cost_details`. Trap a separate rule fell into: with
// `is_byok` missing and an upstream amount > 0, `total_cost` is only the fee (≈ 5 %) — it would look exact and be about
// twenty times too small. openRouterCost says "unknown" (null) there.
export function generationAmount(d) {
  if (!d || typeof d !== "object") return null;
  return openRouterCost({ cost: d.total_cost, is_byok: d.is_byok, cost_details: { upstream_inference_cost: d.upstream_inference_cost } });
}

/**
 * One run of the tick (see header). Never throws. `retrieval`/`now` are seams for the tests.
 * @returns {Promise<{ inquired: number, estimated: number, retrievals: number }>}
 */
export async function catchUpAmounts({ now = Date.now(), retrieval = fetch } = {}) {
  const result = { inquired: 0, estimated: 0, retrievals: 0 };
  try {
    const key = String(store.openRouterAccess()?.apiKey || "");
    if (key && openRouterNetworkAllowed()) {
      const base = openRouterBase();
      const rows = store.rowsToInquire(OPENROUTER_ID, { sinceMs: now - ESTIMATE_WITH_ID_AFTER_MS, untilMs: now + 1, limit: INQUIRIES_PER_RUN });
      for (const z of rows) {
        const ids = String(z.generationId || "").split(/\s+/).filter(Boolean);
        if (!ids.length || ids.length > INQUIRIES_PER_RUN) continue; // more ids than one run asks for: it is estimated after 24 h
        if (result.retrievals + ids.length > INQUIRIES_PER_RUN) break;
        let sum = 0;
        for (const id of ids) {
          result.retrievals++;
          let b = null;
          try {
            const r = await retrieval(`${base}/generation?id=${encodeURIComponent(id)}`, {
              headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(INQUIRY_DEADLINE_MS),
            });
            if (r.ok) b = generationAmount((await r.json())?.data);
          } catch { b = null; }
          if (b === null) { sum = null; break; } // not retrievable yet or unknown: the next tick asks again
          sum += b;
        }
        if (sum !== null && store.setRowsCost(z.id, sum, "inquired")) result.inquired++;
      }
    }
    for (const z of store.rowsToEstimate(OPENROUTER_ID, { untilMs: now - ESTIMATE_WITHOUT_ID_AFTER_MS, abandonBeforeMs: now - ESTIMATE_WITH_ID_AFTER_MS, limit: 2000 })) {
      const amount = estimatedCost(z, catalogModel(z.model)?.prices || null);
      if (amount !== null && store.setRowsCost(z.id, amount, "estimated")) result.estimated++;
    }
  } catch (e) { console.error("[openrouter] catching up amounts:", e?.message || e); }
  if (result.inquired || result.estimated) {
    console.log(`[openrouter] amounts: ${result.inquired} inquired, ${result.estimated} estimated (${result.retrievals} retrievals)`);
  }
  return result;
}

/** Starts the tick — returns the function that stops it (server.js). Without a tick (0) a no-op. */
export function startAmountTick() {
  const ms = INQUIRY_TICK_MS();
  if (!ms) return () => {};
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    catchUpAmounts().finally(() => { running = false; });
  };
  const t = setInterval(run, ms);
  t.unref?.();
  return () => clearInterval(t);
}
