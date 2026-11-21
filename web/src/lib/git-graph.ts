// The lane calculation of the git bar graph (shows all branches as in VS Code) — pure, a leaf module without imports
// (web/test/git-graph.test.mjs transpiles it alone). Drawn in components/git-bar/GitGraph.tsx; the data come from `POST …/git/log` with
// `graph` (server: git.js gitGraphLog, topologically sorted — children before parents, a line in one piece).
//
// MODEL is the swimlane approach of VS Code (src/vs/workbench/contrib/scm/browser/scmHistory.ts,
// `toISCMHistoryItemViewModelArray`): per row the INCOMING lanes (= the outgoing ones of the row above) and the OUTGOING ones. A lane is
// "I am waiting for commit X" together with a color. The commit of a row sits in the first lane waiting for it (otherwise it is a tip and
// gets a new one on the right); that lane then waits for its FIRST parent, every further parent gets a lane of its own at the right
// edge. Further lanes that waited for the same commit (two children of one parent) end in its dot; the lanes to the right of it move
// left. A parent outside the loaded window stays a lane down to the bottom edge.
//
// DEVIATIONS from VS Code (DECIDED):
// - A further parent that a lane already waits for gets NO second one — the merge curve runs into the existing one (VS Code always
//   creates a new one; two parallel lines to the same commit cost a column in a 272 px bar).
// - Colors: the lane of the HEAD branch is ALWAYS the accent (cobalt) — from the HEAD commit downward, like VS Code its ref color, and
//   also where another lane to its left runs into the same commit (VS Code continued from there in the color of the left one); above,
//   the line carries the color of whatever lies above it (e.g. a remote branch that is ahead). Every other lane gets its color at birth
//   from a fixed palette (LANE_COLORS, variables `--git-lane-0…4` in globals.css), chosen by a hash of its name (branch of the tip,
//   otherwise hash of the commit) — NOT in turn like VS Code: so a new commit on another branch does not change the colors of the
//   others. Equally colored neighbors are avoided (the next palette color). The accent never belongs to the palette: cobalt means
//   "HEAD" (and otherwise "selected").
// - If the parents are missing (old server without `graph`, `parents: null`), the graph is LINEAR: every commit hangs on the next.
//   Never wrong, only poorer — a missing field is not a statement.

/** The color of a lane: the accent (HEAD branch) or an index into the palette (0 … LANE_COLORS − 1). */
export type LaneColor = "accent" | number;
export const LANE_COLORS = 5;

/** What the calculation needs of a commit (lib/api/git.ts GitGraphEntry fits in). */
export interface GraphCommit {
  hash: string;
  parents?: readonly string[] | null;
  head?: boolean;
  refs?: readonly { name: string; kind: string }[];
}
export interface Lane { id: string; color: LaneColor }
/** A row: position of the dot and all lines between top edge (y = 0), dot (middle) and bottom edge. */
export interface GraphRow {
  column: number;
  color: LaneColor;
  kind: "head" | "merge" | "node";
  one: Lane[];
  outgoing: Lane[];
  /** A lane comes into the dot from above (a child stands above); its color is that of the incoming lane. */
  top: LaneColor | null;
  /** The dot continues downward (first parent) — in its column. */
  bottom: boolean;
  /** Lanes passing the dot: from column `from` at the top to column `to` at the bottom. */
  through: { from: number; to: number; color: LaneColor }[];
  /** Further incoming lanes that end in the dot (column ≠ `column`). */
  incoming: { from: number; color: LaneColor }[];
  /** Further parents: from the dot to column `to` at the bottom (column ≠ `column`). */
  branching: { to: number; color: LaneColor }[];
}
export interface GraphComputation { rows: GraphRow[]; width: number; linear: boolean }

// FNV-1a, 32 bit — small, stable, dependency-free.
function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
/** The birth color of a lane: from the name, without the colors in `avoid` (if the palette suffices). */
export function laneColorFor(name: string, avoid: readonly LaneColor[] = []): number {
  const start = fnv(name) % LANE_COLORS;
  for (let i = 0; i < LANE_COLORS; i++) {
    const f = (start + i) % LANE_COLORS;
    if (!avoid.includes(f)) return f;
  }
  return start;
}
const KIND_RANK: Record<string, number> = { head: 0, local: 1, remote: 2, tag: 3 };
// The name of a new lane at a tip: its branch (local before remote before tag), otherwise the commit.
function tipsName(c: GraphCommit): string {
  const r = [...(c.refs ?? [])].filter((x) => x && typeof x.name === "string" && KIND_RANK[x.kind] !== undefined)
    .sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind])[0];
  return r ? `${r.kind === "remote" ? r.name.slice(r.name.indexOf("/") + 1) : r.name}` : c.hash;
}

const parentOf = (c: GraphCommit): string[] | null =>
  Array.isArray(c.parents) && c.parents.every((p) => typeof p === "string") ? [...c.parents] : null;

/** The lanes per row. `commits` in the server's order (topological: children before parents). */
export function computeLanes(commits: readonly GraphCommit[]): GraphComputation {
  const linear = commits.some((c) => parentOf(c) === null);
  const rows: GraphRow[] = [];
  let one: Lane[] = [];
  let width = 0;
  commits.forEach((c, i) => {
    const parent = linear ? (i + 1 < commits.length ? [commits[i + 1].hash] : []) : parentOf(c)!;
    const hits = one.findIndex((s) => s.id === c.hash);
    const column = hits >= 0 ? hits : one.length;
    const top = hits >= 0 ? one[hits].color : null;
    // If several lanes merge in this commit and the cobalt lane is among them, it continues in cobalt: the cobalt lane follows only
    // first parents from HEAD — whoever reaches it lies on the line of the HEAD branch, even if it has another lane to its left.
    const cobaltIncluded = one.some((s) => s.id === c.hash && s.color === "accent");
    // A new lane avoids the color of its left neighbor and that of the lane that stood in its column in the row above (it ended
    // there — in the same color the new one would look like its continuation).
    const prior = rows.length ? rows[rows.length - 1].one[column]?.color : undefined;
    const color: LaneColor = c.head || cobaltIncluded ? "accent"
      : top !== null ? top
      : laneColorFor(tipsName(c), [...(one.length ? [one[one.length - 1].color] : []), ...(prior !== undefined ? [prior] : [])]);
    const outgoing: Lane[] = [];
    const through: GraphRow["through"] = [];
    const incoming: GraphRow["incoming"] = [];
    one.forEach((s, k) => {
      if (s.id === c.hash) {
        if (k === column) { if (parent.length > 0) outgoing.push({ id: parent[0], color }); }
        else incoming.push({ from: k, color: s.color });
        return;
      }
      through.push({ from: k, to: outgoing.length, color: s.color });
      outgoing.push(s);
    });
    if (hits < 0 && parent.length > 0) outgoing.push({ id: parent[0], color });
    const branching: GraphRow["branching"] = [];
    for (const p of parent.slice(1)) {
      const present = outgoing.findIndex((s) => s.id === p);
      if (present >= 0) { if (present !== column) branching.push({ to: present, color: outgoing[present].color }); continue; }
      // Avoids the dot, the left neighbor, the lanes ending in this dot, and the one that stood in this column above — otherwise a merge
      // into which a child runs from the right would read as ONE line passing the dot.
      const f = laneColorFor(p, [color, ...(outgoing.length ? [outgoing[outgoing.length - 1].color] : []), ...incoming.map((x) => x.color), ...(one[outgoing.length] ? [one[outgoing.length].color] : [])]);
      branching.push({ to: outgoing.length, color: f });
      outgoing.push({ id: p, color: f });
    }
    const kind: GraphRow["kind"] = c.head ? "head" : parent.length > 1 ? "merge" : "node";
    rows.push({ column, color, kind, one, outgoing, top, bottom: parent.length > 0, through, incoming, branching });
    width = Math.max(width, one.length, outgoing.length, column + 1);
    one = outgoing;
  });
  return { rows, width, linear };
}

// ── An expanded commit: the lanes beside its file rows ──────────────────────────────────────────────────────────────────────────────
// A click expands a commit in place; below it stands one row per changed file. The graph does not break off there: every file row
// carries EXACTLY the lanes running through between the commit row and the next — the outgoing ones of the commit row (`outgoing`, column =
// index; the next commit row receives them as `one` and continues seamlessly). The commit's OWN lane (`own`) is the bar running from
// the dot to the end of the list (like VS Code `renderSCMHistoryGraphPlaceholder` with `highlightIndex`): for a commit with parents the
// lane of its first parent in its column (it carries its color). A root commit has no outgoing lane — its bar then stands in its
// column as long as it is free; if another lane already continues there (a lane from the right moved left), there is no bar
// (DEVIATION from VS Code: there the foreign lane would carry the highlight, as if it belonged to the commit).
export interface ThroughLane { column: number; color: LaneColor; own: boolean }
export function continuousLanes(z: GraphRow): ThroughLane[] {
  const outgoing: ThroughLane[] = z.outgoing.map((s, k) => ({ column: k, color: s.color, own: z.bottom && k === z.column }));
  if (!z.bottom && z.column >= z.outgoing.length) outgoing.push({ column: z.column, color: z.color, own: true });
  return outgoing;
}

// ── Geometry: how wide a lane is, and when to clip ──────────────────────────────────────────────────────────────────────────────────
// DECIDED: 11 px per lane like VS Code; if the room does not suffice (at most `maxPx`, see graphMaxPx), every lane gets narrower, down
// to LANE_MIN_PX. Below that it is clipped: the columns from `kappe` on fall into ONE collective column (dashed), and the bar says so.
export const LANE_PX = 11;
export const LANE_MIN_PX = 6;
export interface LaneGeometry { w: number; clipFrom: number | null; columns: number }
export function laneGeometry(width: number, maxPx: number): LaneGeometry {
  const n = Math.max(1, Math.floor(width) || 1);
  const slot = Math.max(LANE_MIN_PX * 2, Math.floor(maxPx) || 0);
  if (n * LANE_MIN_PX <= slot) return { w: Math.max(LANE_MIN_PX, Math.min(LANE_PX, Math.floor(slot / n))), clipFrom: null, columns: n };
  const clipFrom = Math.max(1, Math.floor(slot / LANE_MIN_PX) - 1);
  return { w: LANE_MIN_PX, clipFrom, columns: clipFrom + 1 };
}
/** The most width the graph takes: just under a quarter of the bar, at least 56 px, at most 132 px. */
export function graphMaxPx(barPx: number): number {
  const b = Number(barPx) || 0;
  return Math.max(56, Math.min(132, Math.round(b * 0.24)));
}

// ── Badges: what stands at the commit ───────────────────────────────────────────────────────────────────────────────────────────────
// HEAD branch first, then local branches, remote branches, tags (each by name). A remote branch whose local branch stands on the SAME
// commit (`origin/main` next to `main`) gets no badge of its own: the local one carries the cloud (`remote`).
export interface Badge { name: string; kind: "head" | "local" | "remote" | "tag"; remote?: string }
export function badges(refs: readonly { name: string; kind: string }[] | null | undefined): Badge[] {
  const valid = (refs ?? []).filter((r): r is Badge => !!r && typeof r.name === "string" && r.name !== "" && KIND_RANK[r.kind] !== undefined);
  const local = new Map(valid.filter((r) => r.kind === "head" || r.kind === "local").map((r) => [r.name, { ...r }]));
  const outgoing: Badge[] = [...local.values()];
  for (const r of valid) {
    if (r.kind === "head" || r.kind === "local") continue;
    if (r.kind === "remote") {
      const cut = r.name.indexOf("/");
      const target = cut > 0 ? local.get(r.name.slice(cut + 1)) : undefined;
      if (target && !target.remote) { target.remote = r.name; continue; }
    }
    outgoing.push({ name: r.name, kind: r.kind });
  }
  return outgoing.sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.name.localeCompare(b.name));
}

// ── "Load more" ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** The next limit or null. The server says with `clipped` whether there are older ones (the cap says that it is one); if it says nothing
 *  (`null`, old server), the length decides: if the answer filled the limit, there may be more. At the cap `max` it ends — then the bar
 *  says there are older ones (GitGraph.tsx, `clipped` without a next limit). */
export function loadMore(limit: number, loaded: number, clipped: boolean | null, step: number, max: number): number | null {
  if (limit >= max) return null;
  const maybe = clipped === null ? loaded >= limit : clipped;
  return maybe ? Math.min(max, limit + step) : null;
}

// ── When to reload, and the choice in the header ──────────────────────────────────────────────────────────────────────────────
/** The state of a repo from the tree (`GET …/git`) on which the graph reloads — no clock of its own: last commit, branch,
 *  upstream, ahead/behind (a fetch moves remote branches without changing the last commit). */
export function graphState(r: { lastCommit?: { hash?: string } | null; branch?: string | null; detached?: boolean | null; upstream?: string | null; ahead?: number | null; behind?: number | null }): string {
  return [r.lastCommit?.hash ?? "", r.branch ?? "", r.detached ? "1" : "0", r.upstream ?? "", Number(r.ahead) || 0, Number(r.behind) || 0].join("\u0000");
}
export type GraphExtent = "all" | "current";
export const GRAPH_EXTENT_KEY = "cbase-git-graph-extent";
/** The stored choice: only "current" is "current", everything else (nothing, nonsense) the default "all". */
export function readExtent(raw: string | null | undefined): GraphExtent {
  return raw === "current" ? "current" : "all";
}
