// Breadcrumbs and sticky scroll (editor navigation styled like VS Code) from the same outline of the language service
// (`outline`: hierarchical, positions 0-based) — pure, no DOM. The view fetches the outline ONCE (components/code/lsp-layout.ts),
// the path bar shows the chain at the cursor (components/code/Breadcrumbs.tsx), the editor pins the enclosing ranges at the top
// (components/code/sticky-scroll.ts).
//
// Tested by EXECUTION in web/test/editor-helpers.test.mjs, each computation with a sabotage its check must catch.
import type { LspPos, LspRange, LspSymbol } from "./api/lsp.js";

/** a is before b or at b. */
const notAfter = (a: LspPos, b: LspPos) => a.line < b.line || (a.line === b.line && a.character <= b.character);
const contains = (r: LspRange, p: LspPos) => notAfter(r.start, p) && notAfter(p, r.end);

export type ChainsSegment = { symbol: LspSymbol; siblings: readonly LspSymbol[] };
/** The symbols `pos` lies in — outermost first (class › method), each segment with its siblings (the list a click on the segment
 *  shows). If siblings overlap (should not happen), the one starting later, i.e. the narrower, wins. If `pos` lies in none: empty. */
export function symbolChain(symbols: readonly LspSymbol[] | null | undefined, pos: LspPos): ChainsSegment[] {
  const out: ChainsSegment[] = [];
  let level: readonly LspSymbol[] = symbols ?? [];
  while (level.length) {
    let best: LspSymbol | null = null;
    for (const s of level) if (s?.range && contains(s.range, pos) && (!best || notAfter(best.range.start, s.range.start))) best = s;
    if (!best) break;
    out.push({ symbol: best, siblings: level });
    level = best.children ?? [];
  }
  return out;
}

/** At most this many rows sticky scroll pins at the top (VS Code `editor.stickyScroll.maxLineCount`). */
export const STICKY_CAP = 5;
/**
 * The ranges pinned at the top. Row i of the strip covers line `rowUnder(i)` (0-based); a symbol pins in row i
 * if its header line lies above it (scrolled out of view) and its end below it (the range is still visible). Outermost first,
 * at most `cap` rows; a child that starts on the same line as its parent symbol gets no second row for that line.
 */
export function stickyChain(symbols: readonly LspSymbol[] | null | undefined, rowUnder: (queue: number) => number, cap = STICKY_CAP): LspSymbol[] {
  const out: LspSymbol[] = [];
  const max = Math.max(0, Math.floor(cap));
  let level: readonly LspSymbol[] = symbols ?? [];
  while (out.length < max && level.length) {
    const z = rowUnder(out.length);
    let hits: LspSymbol | null = null;
    for (const s of level) {
      const header = s?.range?.start?.line, end = s?.range?.end?.line;
      if (typeof header !== "number" || typeof end !== "number") continue;
      if (header < z && end > z && (!hits || header > hits.range.start.line)) hits = s;
    }
    if (!hits) break;
    if (!out.length || out[out.length - 1].range.start.line !== hits.range.start.line) out.push(hits);
    level = hits.children ?? [];
  }
  return out;
}
