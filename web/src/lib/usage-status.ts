// What the usage pages say when no number is there. A leaf module without imports — web/test/usage-status.test.mjs compiles and RUNS it;
// settings/UsageOverview.tsx and settings/UsageSubscription.tsx call it.
//
// "Empty is not unknown": a source that is still loading or whose fetch failed says nothing about the stock. A 500 from
// /api/usage/claude-limits used to show "No measurement saved yet." and a timeout of /api/usage/codex "Not connected."
// (UsageSubscription even swallowed the errors and showed the same while loading) — whoever read that might have logged in again
// needlessly. And an incomplete equivalent value named a reason the contract does not give: `equivalentComplete` is also false
// when cache from rows before the split is unsplit (usage-contract.js).

/** A source of the usage pages: `null` still loading, `"error"` not retrievable, otherwise the value. */
export type State<T> = T | null | "error";

/** The value if there is one — otherwise `null` (loading or not retrievable; which of the two, the sentences below say). */
export function statusValue<T>(s: State<T>): T | null {
  return s === null || s === "error" ? null : s;
}

/** The sentence under Claude's limits when no window is there. Only a loaded state says something about the stock. */
export function claudeEmptySentence(s: State<unknown>): string {
  if (s === null) return "Loading…";
  if (s === "error") return "Unavailable";
  return "No measurement saved yet.";
}

/** The same for Codex: logged in without a snapshot is something other than not connected — and both only if the answer came. */
export function codexEmptySentence(s: State<{ connected?: boolean }>): string {
  if (s === null) return "Loading…";
  if (s === "error") return "Unavailable";
  return s.connected ? "Logged in — no usage snapshot yet." : "Not connected.";
}

/** What `incompleteSet` reads from a response under /api/usage/consumption. */
export interface ConsumptionReasons {
  sums?: { equivalentComplete?: boolean; cacheUnsplit?: number | null } | null;
  models?: ReadonlyArray<{ priceKnown?: boolean }> | null;
}

/**
 * The note for an equivalent value the server does not state completely — with the reason the response carries (a model without a price:
 * `models[].priceKnown`; cache before the split: `sums.cacheUnsplit > 0`), otherwise without a reason. Complete ⇒ `null`.
 */
export function incompleteSet(v: ConsumptionReasons | null | undefined): string | null {
  const s = v?.sums;
  if (!s || s.equivalentComplete === true) return null;
  const withoutPrice = (v?.models ?? []).some((m) => m.priceKnown === false);
  const unsplit = (s.cacheUnsplit ?? 0) > 0;
  if (withoutPrice && unsplit) return "incomplete — not every model has a price, and cache from older runs is not split";
  if (withoutPrice) return "incomplete — not every model has a price";
  if (unsplit) return "incomplete — cache from older runs is not split into reads and writes";
  return "incomplete";
}
