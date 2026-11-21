// The day separator in the history: before the first message of a new weekday a wavy hairline, as in Claude Code.
// The time after the figures carries ONLY the time of day (chat/RunDisplay.tsx) — the day is said by
// this separator: wavy hairline · "Today" / "Yesterday" / "Wednesday, 4 November" (year only if not the current one) ·
// wavy hairline, drawn in chat/DaySeparator.tsx.
//
// ONE pure computation per platform: `dayMarkers` here, the twin `DaySeparator.markers` in
// mobile/CbaseMobile/Chat/DaySeparator.swift — bound in web/test/day-separator-binding.test.mjs (the Swift file runs there
// through `xcrun swift`). A leaf without imports (the test transpiles the file alone with tsc).
//
// The rules:
//   • A calendar day is not 24 h: day = local year/month/day (`Date` fields), "yesterday" = `new Date(y, m, d - 1)`.
//   • A row without a known time (a bubble that came neither from the log nor from the stream — error row, /cost info)
//     NEVER sets a separator and does not change the current day: it belongs to its predecessor.
//   • The WINDOW (chat/chatCache.ts `windowOf`): if older rows are still on the server (`olderBeforehand`), nobody knows whether
//     the first loaded row is the first of its day — it gets no separator. So a shown separator never disappears
//     again: a separator between two rows hangs only on these two, and loading more pushes rows only BEFORE. Only when the
//     first row of the chat is loaded (`olderBeforehand` false) does the separator of its day stand above it.

export type DayKind = "today" | "yesterday" | "date";

export interface DayMarker {
  /** The calendar day, local: "2026-11-04". */
  day: string;
  kind: DayKind;
  /** Only for `date`: the year is included (not the current year). */
  withYear: boolean;
  /** The time of the row that opens the day (ms) — for formatting. */
  ms: number;
}

const two = (n: number) => String(n).padStart(2, "0");

/** The local calendar day of a point in time (ms) as "YYYY-MM-DD". */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

/** The time of a row in ms — seconds (old servers) are converted, anything else is unknown (`null`). */
export function timeMs(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n > 1e12 ? n : n * 1000;
}

/**
 * For each row of the history (same length, same order, oldest first): does a day separator stand BEFORE it, and which one?
 * `times[i]` is the time of the row (ms or s; missing/0 = unknown).
 */
export function dayMarkers(
  times: ReadonlyArray<number | null | undefined>,
  o: { olderBeforehand: boolean; now: number },
): Array<DayMarker | null> {
  const j = new Date(o.now);
  const today = dayKey(o.now);
  const yesterday = dayKey(new Date(j.getFullYear(), j.getMonth(), j.getDate() - 1).getTime());
  const year = j.getFullYear();
  let prior: string | null = null;
  return times.map((raw) => {
    const ms = timeMs(raw);
    if (ms === null) return null;
    const day = dayKey(ms);
    const first = prior === null;
    const fresh = first ? !o.olderBeforehand : day !== prior;
    prior = day;
    if (!fresh) return null;
    const kind: DayKind = day === today ? "today" : day === yesterday ? "yesterday" : "date";
    return { day, kind, withYear: kind === "date" && new Date(ms).getFullYear() !== year, ms };
  });
}

// ── The time of a bubble (web) ────────────────────────────────────────────────────────────────
// It does NOT hang as a field on the bubble: the bubbles are data of the reducer anchors (web/test/fixtures/bubbles) and are compared in
// live-as-history.test.mjs history against stream — there the log time would stand against the stream's clock. Like the
// row id (lib/bubbles-key.ts) it sits in a WeakMap on the object: `buildBubbles` reports the time of the log row,
// the reducer (chat/chatBubbles.ts `reduceChatEvent`) the stream's clock for every NEW bubble and passes it on to the copy
// that a mutation leaves at the same place.

const timeOf = new WeakMap<object, number>();

/** This bubble was created at time `ms` (the FIRST report wins). */
export function rememberTime(bubble: object, ms: unknown): void {
  const z = timeMs(ms);
  if (z === null || timeOf.has(bubble)) return;
  timeOf.set(bubble, z);
}

/** The remembered time of a bubble (ms) — `undefined` if nobody reported it. */
export const timeOfTheBubble = (bubble: object): number | undefined => timeOf.get(bubble);

/**
 * After a mutation `before → after`: new bubbles (behind the old end) get `now` (without `now` they stay without
 * time — the mutators outside the stream, chatBubbles.ts `withTime`: the reducer building block knows no clock), a replaced bubble
 * at the same place inherits the time of its predecessor. Returns `after` unchanged.
 */
export function passOnTimes<T extends object>(prior: readonly T[], after: T[], now?: number): T[] {
  if (after === prior) return after;
  for (let i = 0; i < after.length; i++) {
    const b = after[i];
    if (timeOf.has(b)) continue;
    // At an old place only inherit (a row without time stays without — it does not get "now" retroactively).
    if (i < prior.length) { const old = timeOf.get(prior[i]); if (old !== undefined) timeOf.set(b, old); continue; }
    if (now !== undefined) rememberTime(b, now);
  }
  return after;
}
