// Port of: microsoft/vscode src/vs/editor/common/model/guidesTextModelPart.ts (MIT)
// Indentation in the code editor — pure, without DOM: how deeply a line is indented (`insetColumns`, a tab up to the next tab stop), which
// unit a file uses (`detectUnit`, like VS Code `editor.detectIndentation` — otherwise a file with four spaces would show twice as many
// lines with the default 2), how many guide lines each line carries (`guideCalculator`/`guides`, after VS Code `getLinesIndentGuides`: a
// blank line takes those of its neighbors), which line is the active block's (`activeGuide`, drawn brighter) and how a line is drawn
// (`linesStyle`: per guide a 1 px wide gradient at column·`ch`). Calculation goes through per-line accessors, not arrays: the active
// block may reach far beyond the visible range (the cursor stands 500 lines further down, its block reaches into the view). Drawn in
// components/code/indentation-lines.ts.
//
// Tested EXECUTED in web/test/editor-look.test.mjs, each calculation with a sabotage that its check must catch.

/** The indentation of a line in columns (a tab jumps to the next tab stop) — -1: empty or only whitespace. */
export function insetColumns(row: string, tab = 4): number {
  let s = 0;
  for (const c of String(row ?? "")) {
    if (c === " ") s += 1;
    else if (c === "\t") s += tab - (s % tab);
    else return s;
  }
  return -1;
}

/** The indentation unit of a file (columns per level): the most frequent step between consecutive lines that go deeper; if tabs at the
 *  line start prevail, the tab width. Without a hint (nothing indented) the default. At most `max` lines are read. As in VS Code once
 *  on opening (and when tab width or default change) — not on every keystroke, otherwise it flips while typing. */
export function detectUnit(rows: readonly string[], preset: number, tab = 4, max = 2000): number {
  const count = new Map<number, number>();
  let tabs = 0, empty = 0, prior = 0;
  for (let i = 0; i < Math.min(rows.length, max); i++) {
    const z = rows[i];
    const e = insetColumns(z, tab);
    if (e < 0) continue;
    if (z[0] === "\t") tabs += 1;
    else if (z[0] === " ") empty += 1;
    const d = e - prior;
    if (d > 0 && d <= 8) count.set(d, (count.get(d) ?? 0) + 1);
    prior = e;
  }
  if (tabs > empty) return tab;
  let best = 0, bestCount = 0;
  for (const [d, n] of count) if (n > bestCount || (n === bestCount && d < best)) { best = d; bestCount = n; }
  return best > 0 ? best : Math.max(1, preset);
}

/** Per line (0-based, read via `text(i)`, memoized) the number of guide lines (line k stands at column k·unit). A line with text has as
 *  many as its indentation has levels (rounded up); a blank line follows the previous and the next line with text (VS Code): if it goes
 *  deeper afterwards, one level above the previous; equally deep, its levels; shallower, one level above the next (with `aside` —
 *  Python — its levels). At the start or end of the file: none. */
export function guideCalculator(n: number, text: (i: number) => string, unit: number, tab = 4, aside = false): (i: number) => number {
  const one = Math.max(1, unit);
  const inset = new Map<number, number>(), memo = new Map<number, number>();
  const e = (i: number) => { let v = inset.get(i); if (v === undefined) { v = insetColumns(text(i), tab); inset.set(i, v); } return v; };
  const neighbor = (i: number, s: 1 | -1) => { for (let j = i + s; j >= 0 && j < n; j += s) { const v = e(j); if (v >= 0) return v; } return -1; };
  const compute = (i: number): number => {
    const x = e(i);
    if (x >= 0) return Math.ceil(x / one);
    const a = neighbor(i, -1), b = neighbor(i, 1);
    if (a < 0 || b < 0) return 0;
    if (a < b) return 1 + Math.floor(a / one);
    if (a === b) return Math.ceil(b / one);
    return aside ? Math.ceil(b / one) : 1 + Math.floor(b / one);
  };
  return (i) => {
    if (i < 0 || i >= n) return 0;
    let v = memo.get(i);
    if (v === undefined) { v = compute(i); memo.set(i, v); }
    return v;
  };
}
/** The same for an array of lines. */
export function guides(rows: readonly string[], unit: number, tab = 4, aside = false): number[] {
  const f = guideCalculator(rows.length, (i) => rows[i], unit, tab, aside);
  return rows.map((_, i) => f(i));
}

export type ActiveGuide = { level: number; from: number; until: number };
/** The guide of the active block at line `row` (0-based): its level and the lines it runs over. If the line is the head of a block (the
 *  next line with text is deeper), it is the line of its body; if it closes a block (the previous one is deeper), the line of the closed
 *  body; otherwise the innermost line of the row. null: none (row at the very outside). Searched only in [limitOf, limitUntil] — whoever
 *  draws only a section passes it along with the cursor line. */
export function activeGuide(n: number, f: (i: number) => number, hasText: (i: number) => boolean, row: number, limitOf = 0, limitUntil = n - 1): ActiveGuide | null {
  if (row < 0 || row >= n) return null;
  const next = (i: number, s: 1 | -1) => { for (let j = i + s; j >= 0 && j < n; j += s) if (hasText(j)) return j; return -1; };
  let level: number, start: number;
  if (hasText(row) && next(row, 1) >= 0 && f(next(row, 1)) > f(row)) { level = f(row); start = row + 1; }
  else if (hasText(row) && next(row, -1) >= 0 && f(next(row, -1)) > f(row)) { level = f(row); start = row - 1; }
  else { level = f(row) - 1; start = row; }
  if (level < 0 || start < 0 || start >= n || f(start) <= level) return null;
  let from = start, until = start;
  while (from > Math.max(0, limitOf) && f(from - 1) > level) from -= 1;
  while (until < Math.min(n - 1, limitUntil) && f(until + 1) > level) until += 1;
  return { level, from, until };
}
/** The same for an array of lines and their guides. */
export function activeGuideIn(rows: readonly string[], f: readonly number[], row: number, tab = 4): ActiveGuide | null {
  return activeGuide(f.length, (i) => f[i] ?? 0, (i) => insetColumns(rows[i] ?? "", tab) >= 0, row);
}

/** How a line draws its guides: per guide a 1 px wide gradient at `left + j·unit ch`, the guide `active` in the bright color. */
export function linesStyle(stages: number, unit: number, active: number, left = "6px"): string {
  const images: string[] = [], positions: string[] = [];
  for (let j = 0; j < stages; j++) {
    const color = j === active ? "var(--cb-guide-active)" : "var(--cb-guide)";
    images.push(`linear-gradient(${color},${color})`);
    positions.push(`calc(${left} + ${j * unit}ch) 0`);
  }
  return `background-image:${images.join(",")};background-position:${positions.join(",")};background-size:1px 100%;background-repeat:no-repeat`;
}
