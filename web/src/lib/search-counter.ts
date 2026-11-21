// The counter of the search/replace widget, styled like VS Code; pure, without DOM. As in VS Code (`FindWidget._updateMatchesCount`,
// `FindDecorations.getCurrentMatchesPosition`, `MATCHES_LIMIT` = 19,999): counting stops at the cap, and if the number reaches it, "19999+"
// is shown. The CURRENT hit is the first that touches the selection; a caret inside (or at the edge of) a hit counts too; if the selection
// touches none, "?" is shown. Nothing stands beside the field without search text, "No results" without hits (also for an invalid regular
// expression), otherwise "n of m". The positions of the hits (for the marks in the scrollbar) are collected by `countHits` up to the same
// cap. Drawn in components/code/search-widget.ts.
//
// Tested EXECUTED in web/test/editor-look.test.mjs (with sabotages).

export const SEARCH_CAP = 19999;
export type SearchStatus = { count: number; current: number; capped: boolean };
export type CounterDisplay = { kind: "empty" } | { kind: "no" } | { kind: "counted"; n: string; m: string };

/** Counts the hits (an iterator like `SearchQuery.getCursor`) up to the cap; `current` (1-based, 0 = none) is the first hit that touches
 *  the selection. `lagen` receives the start of every counted hit. */
export function countHits(hits: Iterable<{ from: number; to: number }>, selection: { from: number; to: number }, cap = SEARCH_CAP, positions?: number[]): SearchStatus {
  let count = 0, current = 0;
  for (const t of hits) {
    count += 1;
    positions?.push(t.from);
    if (!current && t.from <= selection.to && t.to >= selection.from) current = count;
    if (count >= cap) return { count, current, capped: true };
  }
  return { count, current, capped: false };
}

export function counterDisplay(search: string, valid: boolean, s: SearchStatus): CounterDisplay {
  if (!search) return { kind: "empty" };
  if (!valid || s.count === 0) return { kind: "no" };
  return { kind: "counted", n: s.current > 0 ? String(s.current) : "?", m: s.capped ? `${s.count}+` : String(s.count) };
}
