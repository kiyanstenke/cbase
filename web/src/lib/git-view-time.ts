// The timeline of the git overview: window → range, time → x, clipping at the window edge and dots or bars of a row. "One calculation,
// two drawers": groups, pairing, numbers, branch point, dots/bars (whether `points` is a list or `null`), user and identity color are
// calculated by the SERVER — only what web and iOS each calculate for themselves is here: where in the chosen window a point in time
// lies. The drawer is components/projects/git/Timeline.tsx (SVG with x in percent, so no width measure is needed).
//
// Pure: no clock (`now` is a parameter), no DOM, no value imports — the window type comes from lib/api/gitView.ts (`import type`,
// dropped on transpile), and `WINDOW_DAYS` is bound to it: a new window in the contract without a row here is a type error. Tested
// executed in web/test/git-view-time.test.mjs.
import type { GitCommits, GitWindow } from "./api/gitView.js";

export const DAY_MS = 86_400_000;

/** The length of a window in days; `null` = "everything" (from the oldest branch point to now). */
export const WINDOW_DAYS: Record<GitWindow, number | null> = { "7d": 7, "30d": 30, everything: null };

/** The window keys before the rename ("t" for the German "Tage") — a choice remembered in this browser before it keeps applying. */
const WINDOW_BEFORE: Readonly<Record<string, GitWindow>> = { "7t": "7d", "30t": "30d" };

/** A remembered or foreign value → a window of the contract, otherwise `null` (the caller takes the default). An old remembered
 *  key ("7t"/"30t") is read as its new one; the caller writes only new keys. */
export function windowFrom(x: unknown): GitWindow | null {
  if (typeof x !== "string") return null;
  if (Object.prototype.hasOwnProperty.call(WINDOW_DAYS, x)) return x as GitWindow;
  return Object.prototype.hasOwnProperty.call(WINDOW_BEFORE, x) ? WINDOW_BEFORE[x] : null;
}

/** The earliest branch point of a list (for "everything") — `null` if no row carries one. */
export function oldestBranchPoint(branchPoints: ReadonlyArray<number | null | undefined>): number | null {
  let min: number | null = null;
  for (const a of branchPoints) if (typeof a === "number" && Number.isFinite(a) && (min === null || a < min)) min = a;
  return min;
}

/** Window → `[from, until]` in ms; `until` is always `now`. "everything" reaches from the oldest branch point to now, but at least a
 *  day — a range without width would have no x. An unknown window (a value that does not exist) counts as "30d". */
export function windowArea(window: GitWindow, now: number, oldest: number | null = null): [number, number] {
  const days = Object.prototype.hasOwnProperty.call(WINDOW_DAYS, window) ? WINDOW_DAYS[window] : 30;
  if (days !== null) return [now - days * DAY_MS, now];
  return [oldest !== null && Number.isFinite(oldest) ? Math.min(oldest, now - DAY_MS) : now - DAY_MS, now];
}

/** Time → x in [0, 1]; before it 0, after it 1 (a clock that runs slow pushes nothing over the edge). */
export function xOf(t: number, area: readonly [number, number]): number {
  const [from, until] = area;
  if (!(until > from)) return 1;
  return Math.min(1, Math.max(0, (t - from) / (until - from)));
}

/** The lane of a row: branches off at the branch point (`x0`) and reaches the last commit (`x1`). If the branch point lies before the
 *  window, it is clipped to the edge (`x0 = 0`, `clipped`) — the row then shows « with the date of the branch point. Without a branch
 *  point the lane begins at the last commit; with neither there is none. */
export type Lane = { x0: number; x1: number; clipped: boolean; branchPoint: number | null };
export function laneOf(branchPoint: number | null, last: number | null, area: readonly [number, number]): Lane | null {
  const beginning = branchPoint ?? last;
  if (beginning === null) return null;
  const end = Math.max(beginning, last ?? beginning);
  const x0 = xOf(beginning, area);
  return { x0, x1: Math.max(x0, xOf(end, area)), clipped: branchPoint !== null && branchPoint < area[0], branchPoint };
}

/** How the commits of a row are drawn. `points` — one dot per commit in the window (hollow = unpushed), `prior` = how many lie before
 *  the window and are not drawn, `notFetched` = x of the commits only the remote has (dashed). `progressBar` — the server sends no dots
 *  (more than POINTS_MAX, `points === null`): a bar over the lane with the count. Without a main branch it sends `points: null` AND
 *  `count: null` — then there is nothing to count and no bar (otherwise the row would look like "more than 15"). */
export type Display =
  | { kind: "points"; points: { x: number; pushed: boolean }[]; prior: number; notFetched: number[] }
  | { kind: "progressBar"; x0: number; x1: number; count: number };
export function displayOf(commits: GitCommits | null, lane: Lane | null, area: readonly [number, number]): Display | null {
  if (!commits) return null;
  const inWindow = (t: number) => t >= area[0];
  const notFetched = (commits.notFetched ?? []).filter(inWindow).map((t) => xOf(t, area));
  if (commits.points === null) {
    if (!lane || commits.count === null) return null;
    return { kind: "progressBar", x0: lane.x0, x1: lane.x1, count: commits.count };
  }
  const inside = commits.points.filter((p) => inWindow(p.t));
  return {
    kind: "points",
    points: inside.map((p) => ({ x: xOf(p.t, area), pushed: p.pushed })),
    prior: commits.points.length - inside.length,
    notFetched,
  };
}

/** The main line at the top: dots from `commits`, without them (too many, `null`) a bar over the whole window with `count`. Without a main
 *  branch there is no line (`null`): the server then sends `{ commits: null, count: 0 }`, and a bar over the whole width with "0" would
 *  be an invented main line — the timeline says "no main branch detected" instead. */
export function lineOf(mainBranch: boolean, commits: number[] | null, count: number | null, area: readonly [number, number]): Display | null {
  if (!mainBranch) return null;
  if (commits === null) return count !== null && count > 0 ? { kind: "progressBar", x0: 0, x1: 1, count } : null;
  const inside = commits.filter((t) => t >= area[0]);
  return { kind: "points", points: inside.map((t) => ({ x: xOf(t, area), pushed: true })), prior: commits.length - inside.length, notFetched: [] };
}

/** Markers of the axis: day starts (local time) at a spacing of 1, 2, 7 or 14 days, for long windows month starts at a spacing of
 *  1, 2, 3, 6 or 12 months — the smallest spacing at which at most `max` markers fall into the range. */
export type AxesMarker = { t: number; x: number };
const TAG_STEPS = [1, 2, 7, 14];
const MONTH_STEPS = [1, 2, 3, 6, 12];
export function axisMarkers(area: readonly [number, number], max = 6): AxesMarker[] {
  const [from, until] = area;
  if (!(until > from) || max < 1) return [];
  const days = (until - from) / DAY_MS;
  const markers = (first: Date, further: (d: Date) => void): AxesMarker[] => {
    const out: AxesMarker[] = [];
    for (const d = first; d.getTime() <= until && out.length <= max; further(d)) if (d.getTime() >= from) out.push({ t: d.getTime(), x: xOf(d.getTime(), area) });
    return out;
  };
  const start = new Date(from);
  for (const s of TAG_STEPS) {
    if (days / s > max) continue;
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
    const m = markers(d, (x) => x.setDate(x.getDate() + s));
    if (m.length <= max) return m;
  }
  for (const s of MONTH_STEPS) {
    const d = new Date(start.getFullYear(), start.getMonth() + 1, 1);
    const m = markers(d, (x) => x.setMonth(x.getMonth() + s));
    if (m.length <= max) return m;
  }
  return [];
}

/** The age of a point in time as a key for t() and the number for it ("2 h", "9 d") — under a minute "just now", a clock in the
 *  future likewise; `null` without a point in time. */
export function shortAge(t: number | null, now: number): { key: string; n: number } | null {
  if (t === null || !Number.isFinite(t)) return null;
  const min = Math.floor(Math.max(0, now - t) / 60_000);
  if (min < 1) return { key: "just now", n: 0 };
  if (min < 60) return { key: "{n} min", n: min };
  const std = Math.floor(min / 60);
  if (std < 24) return { key: "{n} h", n: std };
  return { key: "{n} d", n: Math.floor(std / 24) };
}
