// The pure calculations of the git bar (components/GitSidebar.tsx), styled like the VS Code source control view: which primary button
// applies under the commit field (Commit · Publish Branch · Sync · off), what the sync button of a repo row runs in order, which repos the
// "Changes" section shows (selection in the "Repositories" section), which repo the graph shows, how far "Load more" reaches and how the
// collapsed sections are stored. Also the order of the sections (moving by dragging the header or "Move up/down") and their heights (drag at
// the gap between two open ones).
//
// A LEAF module without imports: web/test/git-bar.test.mjs transpiles the file alone with tsc and runs the calculations (including
// sabotage on a copy). That is why it carries its own narrow shape of a repo (`RepoSituation`) instead of `GitRepo` from lib/api/git.ts —
// structurally every `GitRepo` fits in, and a field that is not here decides nothing here.
//
// EMPTY IS NOT UNKNOWN: a repo with `statusError` (`git status` failed) has NO known changes, but not "none" either. So it never gets
// "Sync" or "Publish" (both presuppose "nothing to commit"), but the commit button — whether there is anything to commit is then up to
// git itself.

export type RepoSituation = {
  branch?: string;
  detached?: boolean;
  upstream?: string | null;
  ahead?: number;
  behind?: number;
  remote?: unknown;
  statusError?: string;
  counts?: { total: number } | null;
  changes?: unknown[];
};

/** The wide button under the commit field (VS Code: the "Action Button" of source control). */
export type Primary =
  | { kind: "commit"; unknown: boolean } // there is something to commit — or the state is unknown (statusError)
  | { kind: "publish" } // nothing to commit, branch without upstream, a remote exists ⇒ push sets the upstream
  | { kind: "synchronize"; ahead: number; behind: number } // nothing to commit, upstream exists, ↑/↓ not 0
  | { kind: "off" }; // nothing to do: the commit button stands there greyed out

const count = (n: number | undefined) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

/** Whether the repo carries known changes (staged, unstaged, untracked or conflict). */
export function hasChanges(r: RepoSituation): boolean {
  return (r.counts?.total ?? r.changes?.length ?? 0) > 0;
}

export function primaryButton(r: RepoSituation): Primary {
  if (r.statusError) return { kind: "commit", unknown: true };
  if (hasChanges(r)) return { kind: "commit", unknown: false };
  const remote = Boolean(r.remote);
  if (remote && r.upstream && (count(r.ahead) > 0 || count(r.behind) > 0)) return { kind: "synchronize", ahead: count(r.ahead), behind: count(r.behind) };
  // A detached HEAD is not a branch — there is nothing to publish.
  if (remote && !r.upstream && !r.detached && r.branch) return { kind: "publish" };
  return { kind: "off" };
}

/** Whether there is anything to do at this repo — the default for whether it starts expanded under "Changes". */
export const hasSomethingToDo = (r: RepoSituation): boolean => primaryButton(r).kind !== "off";

export type SyncStep = "fetch" | "pull" | "push";

/**
 * What the sync button of a repo row (circular arrows or cloud) runs in order — over the existing endpoints `…/git/<step>`, none of its
 * own on the server. Without a remote: nothing (no button). Without upstream: `push` (the server sets it — "Publish Branch"), with a
 * detached HEAD nothing. With upstream like VS Code "Sync": first pull, then push; if both are 0, only `fetch` (check whether there is
 * anything new).
 */
export function syncSteps(r: RepoSituation): SyncStep[] {
  if (!r.remote) return [];
  if (!r.upstream) return r.detached || !r.branch ? [] : ["push"];
  const s: SyncStep[] = [];
  if (count(r.behind) > 0) s.push("pull");
  if (count(r.ahead) > 0) s.push("push");
  return s.length ? s : ["fetch"];
}

// ── Selection in the "Repositories" section ────────────────────────────────────────────────────────────────────────────────────────
// `null` is the default: NO explicit choice — "Changes" shows all repos, no row is highlighted. A click selects exactly this repo (a
// second click on the sole selected one returns to the default), ⌘/Ctrl-click toggles it in or out; if the selection becomes empty, the
// default applies again.

export function selectRepo(selection: readonly string[] | null, key: string, addition: boolean): string[] | null {
  if (!addition) return selection && selection.length === 1 && selection[0] === key ? null : [key];
  const base = selection ?? [];
  const fresh = base.includes(key) ? base.filter((k) => k !== key) : [...base, key];
  return fresh.length ? fresh : null;
}

/** The selection, cleaned of repos that no longer exist — if nothing remains, the default applies (never "no repo"). */
export function tidySelection(selection: readonly string[] | null, existing: readonly string[]): string[] | null {
  if (!selection) return null;
  const rest = selection.filter((k) => existing.includes(k));
  return rest.length ? rest : null;
}

/** The repos "Changes" shows — in the order of the tree, not of the selection. */
export function shownRepos<T>(repos: readonly T[], key: (r: T) => string, selection: readonly string[] | null): T[] {
  const choice = tidySelection(selection, repos.map(key));
  return choice ? repos.filter((r) => choice.includes(key(r))) : [...repos];
}

/** The repo of the graph: the explicit choice (graph header or a click under "Repositories", as in VS Code: the graph follows the last
 *  selected repo), otherwise the first shown one WITH a remote, otherwise the first shown, otherwise the first at all.
 *  The remote counts because in a multi-repo project the root repo of the project folder can be a purely local one with only `main`,
 *  which would otherwise come first before the repos whose branches the graph should show. */
export function graphRepo(existing: readonly string[], choice: string | null, shown: readonly string[], withRemote: readonly string[] = []): string | null {
  if (choice && existing.includes(choice)) return choice;
  const present = shown.filter((k) => existing.includes(k));
  return present.find((k) => withRemote.includes(k)) ?? present[0] ?? existing[0] ?? null;
}

/** The choice of the graph repo per scope (localStorage, key `GRAPH_REPO_KEY` + `:` + scope): an object scope → repo key.
 *  Nonsense in storage means "no choice", never a throw. */
export const GRAPH_REPO_KEY = "cbase-git-graph-repo";
export function readGraphChoice(raw: string | null): string | null {
  return typeof raw === "string" && raw.length > 0 && raw.length < 2048 ? raw : null;
}

// ── Graph: "Load more" ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
// `POST …/git/log` only knows `limit` (server: at most 500, no offset) — "Load more" therefore asks for the same list, longer. The
// calculation of the next limit is lib/git-graph.ts `loadMore` (it believes the server's `clipped`; without that flag the length decides).
export const GRAPH_STEP = 50;
export const GRAPH_MAX = 500;

// ── Collapsed sections ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
// One key for all sections (localStorage, per user, the same in chat bar and code tab): a JSON object `{ id: true }` per COLLAPSED
// section. Nobody has validated what is stored there — nonsense means "all open" (the default), never a throw in render.
// A stored `{"branches":true}` or a "branches" in the order is an unknown entry (that section no longer exists) and silently drops out.
export const SECTIONS_KEY = "cbase-git-sections-closed";
export const GIT_SECTIONS = ["repos", "changes", "graph"] as const;
export type GitSection = (typeof GIT_SECTIONS)[number];

export function readCollapsed(raw: string | null | undefined): Partial<Record<GitSection, true>> {
  if (!raw) return {};
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return {}; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Partial<Record<GitSection, true>> = {};
  for (const id of GIT_SECTIONS) if ((value as Record<string, unknown>)[id] === true) out[id] = true;
  return out;
}

export function toggleCollapsed(closed: Partial<Record<GitSection, true>>, id: GitSection): Partial<Record<GitSection, true>> {
  const fresh = { ...closed };
  if (fresh[id]) delete fresh[id];
  else fresh[id] = true;
  return fresh;
}

// ── Order of the sections (moving like the views in VS Code) ────────────────────────────────────────────────────────────────────────
// Stored as a JSON list of ids (localStorage, per user, the same in chat bar and code tab). Nobody has validated what is stored there:
// unknown and duplicate entries drop out, missing sections are appended in the default order, nonsense is the default — never a throw
// in render and never a section that disappears. "Repositories" is absent with ONE repo; the order of the others then stays the same,
// because it is filtered from the same list (`visible`), not rebuilt.
export const ORDER_KEY = "cbase-git-sections-order";

export function normalizeOrder(value: unknown): GitSection[] {
  const out: GitSection[] = [];
  if (Array.isArray(value)) {
    for (const v of value) if ((GIT_SECTIONS as readonly unknown[]).includes(v) && !out.includes(v as GitSection)) out.push(v as GitSection);
  }
  for (const id of GIT_SECTIONS) if (!out.includes(id)) out.push(id);
  return out;
}

export function readOrder(raw: string | null | undefined): GitSection[] {
  if (!raw) return [...GIT_SECTIONS];
  try { return normalizeOrder(JSON.parse(raw)); } catch { return [...GIT_SECTIONS]; }
}

/** Where a section moves: directly BEFORE `before` (in the whole order), `null` = to the end. */
export type Target = { before: GitSection | null };

/** The insertion place when dragging the header: how many sections (their centers, top to bottom) lie above the pointer — 0 … n. */
export function insertPlace(middles: readonly number[], y: number): number {
  let n = 0;
  for (const m of middles) if (m < y) n++;
  return n;
}

/** The target for the insertion place `place` (0 … n in `visible`, the dragged section counted); `null` if it already stands there. */
export function targetFromPlace(visible: readonly GitSection[], id: GitSection, place: number): Target | null {
  const i = visible.indexOf(id);
  if (i < 0 || !Number.isInteger(place) || place < 0 || place > visible.length) return null;
  if (place === i || place === i + 1) return null;
  return { before: place < visible.length ? visible[place] : null };
}

/** "Move up" (−1) or "Move down" (+1) among the VISIBLE sections; `null` at the edge. */
export function targetStep(visible: readonly GitSection[], id: GitSection, direction: -1 | 1): Target | null {
  const i = visible.indexOf(id);
  if (i < 0) return null;
  return targetFromPlace(visible, id, direction < 0 ? i - 1 : i + 2);
}

/** The new order: `id` out, back in before `target.before` (if `before` is missing, at the end). An invisible section keeps its place
 *  relative to the others. The old list stays untouched (React state). */
export function move(order: readonly GitSection[], id: GitSection, target: Target): GitSection[] {
  const rest = order.filter((x) => x !== id);
  const k = target.before ? rest.indexOf(target.before) : -1;
  const on = k < 0 ? rest.length : k;
  return [...rest.slice(0, on), id, ...rest.slice(on)];
}

// ── Heights of the sections (dragging the gap as in VS Code) ────────────────────────────────────────────────────────────────────────
// What is distributed is the height of the BODIES of the open sections: the bar height minus per section header (22 px) and hairline
// (1 px, not at the first). Stored as shares (`{ id: weight }`, localStorage, global like the bar widths) so that with another panel
// height — chat bar next to code tab, a smaller window — they give the same ratio. Weights, not a sum of 1: a collapsed section keeps its
// own, and the open ones share the height in proportion to their weights; a section without a stored weight (it was closed at the last
// drag or missing) gets `DEFAULT_SHARE`.
// `null` means DEFAULT: no drag is stored, the bar divides by roles (Repositories short and capped, "Changes" as tall as its content up
// to 65 %, the graph fills the rest; GitSidebar.tsx `ROLE`) — a double-click on a gap leads back exactly there. Nonsense in storage is
// the default.
export const HEIGHTS_KEY = "cbase-git-sections-heights";
export const HEADER_HEIGHT = 22;
/** Smallest body of an open section: two rows of 22 px and the padding at the bottom (6 px) — with the header 72 px. */
export const MIN_BODY = 2 * 22 + 6;
/** Step of the arrow keys at the gap — like the width of the chat list (ChatListPane.tsx). */
export const SPLIT_STEP = 16;
export const DEFAULT_SHARE: Record<GitSection, number> = { repos: 0.2, changes: 0.45, graph: 0.35 };

export type Shares = Partial<Record<GitSection, number>>;
export type Heights = Partial<Record<GitSection, number>>;

const weight = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

export function readShares(raw: string | null | undefined): Shares | null {
  if (!raw) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Shares = {};
  for (const id of GIT_SECTIONS) { const v = (value as Record<string, unknown>)[id]; if (weight(v)) out[id] = v; }
  return Object.keys(out).length ? out : null;
}

/** The available body height: bar height minus header per visible section and the hairlines between. Never negative. */
export function availableHeight(bar: number, visible: number): number {
  if (!(bar > 0) || visible <= 0) return 0;
  return Math.max(0, Math.floor(bar) - visible * HEADER_HEIGHT - (visible - 1));
}

/**
 * The body heights of the OPEN sections (whole pixels, sum = `available`) from their shares. None falls below `min`: one that would
 * gets `min`, the rest shares what is left, again proportionally. If the height does not even suffice for all minimum heights (the window
 * is smaller than n × 72 px), they share equally — there the minimum height yields, not a header.
 */
export function distribute(open: readonly GitSection[], shares: Shares | null, available: number, min = MIN_BODY): Heights {
  const n = open.length;
  const out: Heights = {};
  if (n === 0) return out;
  const H = Math.max(0, Math.floor(available));
  const w = open.map((id) => (weight(shares?.[id]) ? (shares![id] as number) : DEFAULT_SHARE[id]));
  const raw = new Array<number>(n).fill(0);
  if (H < n * min) {
    raw.fill(H / n);
  } else {
    let free = open.map((_, i) => i);
    let rest = H;
    for (;;) {
      const sum = free.reduce((s, i) => s + w[i], 0);
      for (const i of free) raw[i] = (rest * w[i]) / sum;
      const under = free.filter((i) => raw[i] < min);
      if (under.length === 0) break;
      for (const i of under) { raw[i] = min; rest -= min; }
      free = free.filter((i) => !under.includes(i));
      if (free.length === 0) break;
    }
  }
  // To whole pixels: round down, the remainder to the largest fractions (on a tie the upper one) — the sum stays H.
  const whole = raw.map((v) => Math.floor(v + 1e-9));
  let missing = H - whole.reduce((s, v) => s + v, 0);
  const byRemainder = raw.map((v, i) => ({ i, r: v - whole[i] })).sort((a, b) => b.r - a.r || a.i - b.i);
  for (let k = 0; missing > 0 && n > 0; k = (k + 1) % n, missing--) whole[byRemainder[k].i]++;
  open.forEach((id, i) => { out[id] = whole[i]; });
  return out;
}

/**
 * A drag at the gap between `top` and `bottom` by `delta` px (positive = down): `top` grows, `bottom` shrinks — only these two, the sum
 * stays. None becomes smaller than `min`; one already below it (very small window) does not shrink further.
 */
export function pull(px: Heights, top: GitSection, bottom: GitSection, delta: number, min = MIN_BODY): Heights {
  const a = px[top] ?? 0;
  const b = px[bottom] ?? 0;
  const lo = Math.min(0, min - a);
  const hi = Math.max(0, b - min);
  const d = Math.max(lo, Math.min(hi, Math.round(Number.isFinite(delta) ? delta : 0)));
  return { ...px, [top]: a + d, [bottom]: b - d };
}

/** The pixels of the open sections as shares (fraction of their sum); collapsed ones keep their old weight from `prior`. */
export function asShares(px: Heights, open: readonly GitSection[], prior: Shares | null): Shares {
  const out: Shares = { ...(prior ?? {}) };
  const sum = open.reduce((s, id) => s + (px[id] ?? 0), 0);
  if (!(sum > 0)) return out;
  for (const id of open) { const v = (px[id] ?? 0) / sum; if (v > 0) out[id] = v; else delete out[id]; }
  return out;
}

/** The gaps: one BELOW every open section that is followed by another open one — it divides between this one and the next open one
 *  (a collapsed one in between is only a header and moves along). A collapsed section has no gap of its own. */
export function column(visible: readonly GitSection[], isOpen: (id: GitSection) => boolean): { after: number; top: GitSection; bottom: GitSection }[] {
  const out: { after: number; top: GitSection; bottom: GitSection }[] = [];
  visible.forEach((id, i) => {
    if (!isOpen(id)) return;
    const bottom = visible.slice(i + 1).find(isOpen);
    if (bottom) out.push({ after: i, top: id, bottom });
  });
  return out;
}

/** `git status` shows an untracked folder (often an embedded repository) as ONE entry with a trailing "/" — it has no diff to open
 *  (the server answers it with a "is a folder" message, git.js `commitPath`). */
export function isFolderEntry(path: string): boolean {
  return path.length > 1 && path.endsWith("/");
}
