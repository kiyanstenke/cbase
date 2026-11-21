// The search over models. Since OpenRouter is a fixed provider, it carries the WHOLE catalog with tools — several hundred models. A
// `<select>` with option groups is unusable for that, and the two composers had a search of their own each (the same idea built twice).
// Every model choice now goes through ONE component (`components/ModelChoice.tsx`: `ModelSearchList` in the composers' popover,
// `ModelChoice` instead of `<select>` everywhere else), and it asks this one calculation. A leaf module without imports —
// `web/test/model-search.test.mjs` transpiles it alone.
//
// Searched by WORDS, case-insensitive: every word of the query must occur in label, value or group name ("sonnet 5", "openrouter glm",
// "deepseek/"). An empty query leaves everything; a group without hits drops.

/** A selectable row. `value` is what the caller stores (`model`, `provider::model`, `provider|model` …). */
export type ModelOption = {
  value: string;
  label: string;
  /** Small additions in parentheses behind the row ("Default", "not available"). */
  markers?: string[];
  /** Warning color — a set value that the list does not carry. */
  warn?: boolean;
  title?: string;
};
export type ModelGroup = { key: string; label: string; options: ModelOption[] };

/** The words of a query (lower case, without empty ones). */
export function searchWords(question: string): string[] {
  return question.toLowerCase().split(/\s+/).map((w) => w.trim()).filter(Boolean);
}

/** The groups with the rows that carry EVERY word; without a query unchanged. */
export function modelHits(groups: readonly ModelGroup[], question: string): ModelGroup[] {
  const words = searchWords(question);
  if (!words.length) return groups.map((g) => ({ ...g, options: [...g.options] }));
  return groups
    .map((g) => ({
      ...g,
      options: g.options.filter((o) => {
        const text = `${o.label} ${o.value} ${g.label}`.toLowerCase();
        return words.every((w) => text.includes(w));
      }),
    }))
    .filter((g) => g.options.length > 0);
}

/** The first hit — Enter in the search selects it. */
export function firstHit(groups: readonly ModelGroup[]): { group: ModelGroup; option: ModelOption } | null {
  for (const g of groups) if (g.options.length) return { group: g, option: g.options[0] };
  return null;
}

/** The group a value stands in (`null` if none carries it). */
export function groupOf(groups: readonly ModelGroup[], value: string): ModelGroup | null {
  return groups.find((g) => g.options.some((o) => o.value === value)) ?? null;
}

/** The label of a value — `null` if no group carries it (the caller then shows the value itself, never "nothing"). */
export function labelOf(groups: readonly ModelGroup[], value: string): string | null {
  for (const g of groups) for (const o of g.options) if (o.value === value) return o.label;
  return null;
}

/** Dimensions of the list at the button (`ModelChoice`): width between min and max, at most `height` tall, `margin` to the window edge, `gap` to the button. */
export const POP = { widthMin: 260, widthMax: 380, height: 340, margin: 8, gap: 4 } as const;

/** Where the list stands: left, width, height and either `top` (opens downward) or `bottom` (opens upward, distance from the window bottom). */
export type PopSituation = { left: number; width: number; height: number; top?: number; bottom?: number };

/**
 * The position of the list relative to the button `r` in the window: downward if the full height fits there or at least as much as
 * above, otherwise upward — and the height NEVER larger than the free space in that direction. A fixed 340 px would let the search
 * field stick out over the window edge when opened upward, and the last rows would be unreachable when opened downward.
 */
export function popSituation(r: { left: number; top: number; bottom: number; width: number }, window: { width: number; height: number }): PopSituation {
  const width = Math.min(POP.widthMax, Math.max(POP.widthMin, r.width));
  const left = Math.max(POP.margin, Math.min(r.left, window.width - width - POP.margin));
  const bottomFree = Math.max(0, window.height - r.bottom - POP.gap - POP.margin);
  const topFree = Math.max(0, r.top - POP.gap - POP.margin);
  const downward = bottomFree >= POP.height || bottomFree >= topFree;
  const height = Math.min(POP.height, downward ? bottomFree : topFree);
  return downward
    ? { left, width, height, top: r.bottom + POP.gap }
    : { left, width, height, bottom: window.height - r.top + POP.gap };
}

