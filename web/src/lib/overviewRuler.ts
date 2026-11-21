// The overview ruler at the right edge of the code editor, styled like VS Code: the pure computations; drawing happens in
// components/code/overviewRuler.ts.
//
// Following VS Code's `DecorationsOverviewRuler` (lanes `OverviewRulerLane`, per color rectangles with a minimum height of 6 px, merged
// where two are at most 1 px apart; the cursor marks across all lanes; the border on the left and top), the `editorOverviewRuler.*` colors
// of Dark/Light Modern and `ScrollbarState` (the slider over the ruler, click into the lane, dragging). Computation is in DEVICE PIXELS as
// there; `top`/`bottom` of an entry are positions in the scroll surface (CSS pixels), `total` is its height.
//
// Guard: web/test/overviewRuler.test.mjs (executed, every check with sabotage).

/** The lanes as a bitmask like VS Code `OverviewRulerLane`. */
export const LANE = { left: 1, middle: 2, right: 4, full: 7 } as const;
export type Lane = (typeof LANE)[keyof typeof LANE];

/** Width of the ruler in CSS pixels (VS Code `editor.scrollbar.verticalScrollbarSize`). */
export const RULER_WIDTH = 14;
/** Height of the horizontal scrollbar (VS Code `editor.scrollbar.horizontalScrollbarSize`). */
export const HORIZONTAL_HEIGHT = 12;
/** Minimum height of an entry and height of a cursor mark in CSS pixels (VS Code `MIN_DECORATION_HEIGHT`, the cursor `2 * pixelRatio`). */
export const MIN_HEIGHT = 6;
export const CURSOR_HEIGHT = 2;
/** Smallest length of the slider (VS Code `MINIMUM_SLIDER_SIZE`). */
export const SLIDER_MIN = 20;

/** x and width per lane mask (index 0–7) in a ruler of width `width` (device pixels): 1 px on the left for the border, the rest in thirds
 *  (the middle gets what is left over when dividing); VS Code `Settings._initLanes(1, canvasWidth, overviewRulerLanes)`. */
export function lanePositions(width: number, lanes: 1 | 2 | 3): { x: number[]; w: number[] } {
  const start = 1, rest = width - start;
  if (lanes === 3) {
    const l = Math.floor(rest / 3), r = Math.floor(rest / 3), m = rest - l - r;
    const lx = start, mx = lx + l, rx = lx + l + m;
    return { x: [0, lx, mx, lx, rx, lx, mx, lx], w: [0, l, m, l + m, r, l + m + r, m + r, l + m + r] };
  }
  if (lanes === 2) {
    const l = Math.floor(rest / 2), r = rest - l;
    const lx = start, rx = lx + l;
    return { x: [0, lx, lx, lx, rx, lx, lx, lx], w: [0, l, l, l, r, l + r, l + r, l + r] };
  }
  return { x: [0, start, start, start, start, start, start, start], w: [0, rest, rest, rest, rest, rest, rest, rest] };
}

export type RulerKind = "error" | "warning" | "info" | "add" | "changed" | "deleted" | "hits" | "word" | "selection";
/** Per kind the lane and the stack height. VS Code: markers on the right (zIndex error 30, warning 20, info 10; hints not), git on the left
 *  (`quickDiff`), search hits in the middle (zIndex 10), occurrences of the word and of the selection in the middle. */
export const RULER_KIND: Record<RulerKind, { lane: Lane; z: number }> = {
  error: { lane: LANE.right, z: 30 }, warning: { lane: LANE.right, z: 20 }, info: { lane: LANE.right, z: 10 },
  add: { lane: LANE.left, z: 0 }, changed: { lane: LANE.left, z: 0 }, deleted: { lane: LANE.left, z: 0 },
  hits: { lane: LANE.middle, z: 10 }, word: { lane: LANE.middle, z: 0 }, selection: { lane: LANE.middle, z: 0 },
};

export type RulerRole = RulerKind | "cursor" | "edge";
/** The colors of VS Code Dark/Light Modern: `editorOverviewRuler.errorForeground` (rgba(255, 18, 18, 0.7)), `.warningForeground` and
 *  `.infoForeground` (= `editorWarning`/`editorInfo.foreground`), `.added/modified/deletedForeground` (= `editorGutter.*Background` at 60 %),
 *  `.findMatchForeground`, `.wordHighlightForeground` (the occurrence at the insertion mark; without a server `.wordHighlightTextForeground`,
 *  both #a0a0a0cc), `.selectionHighlightForeground`, the cursor (`editorCursor.foreground` at 70 %) and `.border`. */
export const RULER_COLORS: Record<"dark" | "light", Record<RulerRole, string>> = {
  dark: {
    error: "#ff1212b3", warning: "#cca700", info: "#3794ff",
    add: "#2ea04399", changed: "#0078d499", deleted: "#f8514999",
    hits: "#d186167e", word: "#a0a0a0cc", selection: "#a0a0a0cc",
    cursor: "#aeafadb3", edge: "#010409",
  },
  light: {
    error: "#ff1212b3", warning: "#bf8803", info: "#1a85ff",
    add: "#2ea04399", changed: "#005fb899", deleted: "#f8514999",
    hits: "#d186167e", word: "#a0a0a0cc", selection: "#a0a0a0cc",
    cursor: "#000000b3", edge: "#e5e5e5",
  },
};
/** The slider over the ruler: `scrollbarSlider.background`, `.hoverBackground`, `.activeBackground`. */
export const SLIDER_COLORS: Record<"dark" | "light", { quiet: string; hover: string; active: string }> = {
  dark: { quiet: "#79797966", hover: "#646464b3", active: "#bfbfbf66" },
  light: { quiet: "#64646466", hover: "#646464b3", active: "#00000099" },
};

/** An entry: its kind and the position of its lines in the scroll surface (`top` of the first, `bottom` of the last line, CSS pixels). */
export type RulerEntry = { kind: RulerKind; top: number; bottom: number };
/** The ruler: width and height in CSS pixels, `total` the height of the scroll surface, `pixel` the device's pixel ratio. */
export type RulerMeasure = { width: number; height: number; total: number; pixel: number; lanes: 1 | 2 | 3 };
/** A rectangle in device pixels. */
export type Rectangle = { color: string; x: number; y: number; w: number; h: number };

const device = (m: RulerMeasure) => {
  const cw = Math.round(m.width * m.pixel), ch = Math.round(m.height * m.pixel);
  return { cw, ch, scale: ch / Math.max(m.total, 1), laneBoxes: lanePositions(cw, m.lanes) };
};
/** A middle such that a piece of height 2·`half` lies entirely inside the ruler. */
const clampMiddle = (middle: number, half: number, ch: number) => (middle < half ? half : middle + half > ch ? ch - half : middle);

/**
 * The rectangles of the entries in painting order: one group per color (same color = one group, across kinds), the groups by stack height,
 * then by color; within a group by position. Every entry is at least 6 px high (around its middle, entirely inside the ruler); if one in
 * the same lane follows at most 1 px below the previous, it becomes ONE rectangle with it, the per-pixel merging of VS Code
 * (`if (y1 > prevY2 + 1 || lane !== prevLane)`).
 */
export function rulerRectangles(entries: readonly RulerEntry[], m: RulerMeasure, colors: Record<RulerRole, string>): Rectangle[] {
  const { ch, scale, laneBoxes } = device(m);
  const min = (MIN_HEIGHT * m.pixel) | 0, half = (min / 2) | 0;
  const groups = new Map<string, { color: string; z: number; parts: { lane: Lane; y1: number; y2: number }[] }>();
  for (const e of entries) {
    const a = RULER_KIND[e.kind], color = colors[e.kind];
    let y1 = (e.top * scale) | 0, y2 = (e.bottom * scale) | 0;
    if (y2 - y1 < min) {
      const middle = clampMiddle(((y1 + y2) / 2) | 0, half, ch);
      y1 = middle - half;
      y2 = middle + half;
    }
    const k = `${a.z}\u0000${color}`;
    let g = groups.get(k);
    if (!g) groups.set(k, (g = { color, z: a.z, parts: [] }));
    g.parts.push({ lane: a.lane, y1, y2 });
  }
  const out: Rectangle[] = [];
  const queue = [...groups.values()].sort((a, b) => a.z - b.z || (a.color < b.color ? -1 : a.color > b.color ? 1 : 0));
  for (const g of queue) {
    g.parts.sort((a, b) => a.y1 - b.y1);
    let p: { lane: Lane; y1: number; y2: number } | null = null;
    const male = (t: { lane: Lane; y1: number; y2: number }) => out.push({ color: g.color, x: laneBoxes.x[t.lane], y: t.y1, w: laneBoxes.w[t.lane], h: t.y2 - t.y1 });
    for (const t of g.parts) {
      if (p && t.lane === p.lane && t.y1 <= p.y2 + 1) { if (t.y2 > p.y2) p.y2 = t.y2; continue; }
      if (p) male(p);
      p = { ...t };
    }
    if (p) male(p);
  }
  return out;
}

/** The cursor marks: per caret 2 px at the top edge of its line across all lanes, entirely inside the ruler, merged when close together. */
export function cursorRectangles(top: readonly number[], m: RulerMeasure, color: string): Rectangle[] {
  const { ch, scale, laneBoxes } = device(m);
  const h = (CURSOR_HEIGHT * m.pixel) | 0, half = (h / 2) | 0;
  const ys = top.map((o) => clampMiddle((o * scale) | 0, half, ch) - half).sort((a, b) => a - b);
  const out: Rectangle[] = [];
  let y1 = 0, y2 = -2;
  for (const y of ys) {
    if (y > y2 + 1) {
      if (y2 >= 0) out.push({ color, x: laneBoxes.x[LANE.full], y: y1, w: laneBoxes.w[LANE.full], h: y2 - y1 });
      y1 = y;
      y2 = y + h;
    } else if (y + h > y2) y2 = y + h;
  }
  if (y2 >= 0) out.push({ color, x: laneBoxes.x[LANE.full], y: y1, w: laneBoxes.w[LANE.full], h: y2 - y1 });
  return out;
}

/** The border of the ruler (`editorOverviewRuler.border`): 1 px on the left over the full height and 1 px on top. */
export function edge(m: RulerMeasure, color: string): Rectangle[] {
  const { cw, ch } = device(m);
  return [{ color, x: 0, y: 0, w: 1, h: ch }, { color, x: 0, y: 0, w: cw, h: 1 }];
}

// ── The slider (VS Code `ScrollbarState`) ──────────────────────────────────────────────────────────────────────────────────────────
export type Slider = { needed: boolean; size: number; situation: number; ratio: number };
/** Size and position of the slider in a lane of length `lane` when `view` of `total` pixels are visible and `top` is scrolled.
 *  Not needed if everything is visible. */
export function slider(lane: number, view: number, total: number, top: number): Slider {
  if (!(total > 0 && total > view)) return { needed: false, size: Math.round(lane), situation: 0, ratio: 0 };
  const size = Math.round(Math.max(SLIDER_MIN, Math.floor((view * lane) / total)));
  const ratio = (lane - size) / (total - view);
  return { needed: true, size, situation: Math.round(top * ratio), ratio };
}
/** Click into the lane at `y`: the slider jumps there with its middle (VS Code `getDesiredScrollPositionFromOffset`). */
export const scrollTargetFromClick = (y: number, s: Slider): number => (s.needed && s.ratio > 0 ? Math.round((y - s.size / 2) / s.ratio) : 0);
/** Drag by `delta` pixels from the state `s` at press (VS Code `getDesiredScrollPositionFromDelta`). */
export const scrollTargetFromDrag = (s: Slider, delta: number): number => (s.needed && s.ratio > 0 ? Math.round((s.situation + delta) / s.ratio) : 0);
/** A scroll target clamped into the possible range. */
export const clampScroll = (target: number, view: number, total: number): number => Math.max(0, Math.min(Math.max(0, total - view), target));

// ── What goes into the ruler ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** The kind of a diagnostic in the ruler (CodeMirror severity); hints do not appear there (VS Code: only errors, warnings, infos). */
export const kindOfSeverity = (severity: string): RulerKind | null =>
  severity === "error" ? "error" : severity === "warning" ? "warning" : severity === "info" ? "info" : null;

/** A block of the git gutter (lib/dirty-diff.ts `DiffBlock`) in the ruler: kind and lines (1-based). Deleted sits at the line below which
 *  it was deleted (before the first line: at it), as in the gutter. Nothing for a block outside the text. */
export function gitInRuler(b: { kind: "fresh" | "changed" | "deleted"; from: number; until: number }, rows: number): { kind: RulerKind; from: number; until: number } | null {
  if (rows < 1) return null;
  if (b.kind === "deleted") {
    const z = Math.max(1, Math.min(b.from, rows));
    return { kind: "deleted", from: z, until: z };
  }
  const from = Math.max(1, b.from), until = Math.min(b.until, rows);
  return until >= from ? { kind: b.kind === "fresh" ? "add" : "changed", from, until } : null;
}

/** The text whose occurrences the ruler shows (VS Code `SelectionHighlighter`): exactly one selection, non-empty, in ONE line, at most
 *  200 characters, not only blanks and tabs; otherwise null. */
export function selectionSearchText(selection: readonly { from: number; to: number }[], text: (from: number, to: number) => string): string | null {
  if (selection.length !== 1) return null;
  const { from, to } = selection[0];
  if (to <= from || to - from > 200) return null;
  const s = text(from, to);
  return s.includes("\n") || /^[ \t]+$/.test(s) ? null : s;
}
/** If the open search widget already searches the same text, its hits appear in the ruler and the occurrences of the selection do not appear
 *  a second time (VS Code `SelectionHighlighter`: `hasFindOccurrences` ⇒ highlight without ruler). Same means: no regular expression, the
 *  same text, ignoring case unless "match case" is on. */
export function selectionAsSearch(search: string, searchPanel: { open: boolean; text: string; regexp: boolean; caseSensitive: boolean }): boolean {
  if (!searchPanel.open || searchPanel.regexp || !searchPanel.text) return false;
  return searchPanel.caseSensitive ? searchPanel.text === search : searchPanel.text.toLowerCase() === search.toLowerCase();
}
/** The starts of the occurrences of `search` in `text` (literal, non-overlapping), without the one at `except` (the selection itself); at most `cap`. */
export function occurrencesIn(text: string, search: string, except: number, cap = 2000): number[] {
  const out: number[] = [];
  if (!search) return out;
  for (let i = text.indexOf(search); i >= 0 && out.length < cap; i = text.indexOf(search, i + search.length)) if (i !== except) out.push(i);
  return out;
}
