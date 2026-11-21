// The git overview: the routes to the server and the allowlist of its answers, nothing else. The time → x calculation lives in the
// leaf lib/git-view-time.ts, the small UI in components/GitSidebar.tsx ("Branches" section, data from `GET …/git` → `branchesRunning`/
// `counter` per repo, lib/api/git.ts) and the large one in components/projects/git/.
//
// The routes (the header comments of the server files under server/backend/electron/server/gitView/ are the contract):
//   GET  /api/projects/:pid/gitView?repo=<rel>&search=&fresh=1          the overview: 404 without a deployment mark, 409 when not converted
//   POST /api/projects/:pid/gitView/fetch { repo, instance, auto }      → { skipped, remoteState[, nextNotBefore] }; `auto: true` keeps
//                                                                       the throttle (FETCH_GAP_MS per repo and instance), the ⟳ button
//                                                                       sends `auto: false`; 409 with `code` (INSTANCE_NOT_READY …)
//   GET  …/gitView/branch?repo=&instance=&name=                         the detail { row, commits, files, mr, origin, clipped, failed }
//   GET  …/gitView/diff?repo=&instance=&name=&file=                     { file, diff, clipped }: `<main>...<branch> -- <file>`
//
// THE CONTRACT LISTS (`server/backend/electron/server/gitView/contract.js`, a leaf without imports; the binding test
// web/test/git-view-binding.test.mjs pins them here) appear below as constants of their own; the types are derived from them or bound
// to them via `SameKeys`: a field in the type but not in the list (or vice versa) is a type error. `instance`/`name` are called `main`
// or the copy's name (`k1`) at this seam, NOT `copy-k1` as in the instances tree.
//
// EMPTY IS NOT UNKNOWN: a missing field stays `null` ("not loaded"), never an empty list or 0. `rows: null` means "not read", `rows: []`
// means "no branches"; `mr` carries `no-access` ≠ `none`; the state of a cbase branch `unknown` ≠ `ended`. Leaf module: imports only
// from lib/api/ (README there).
import { api } from "./core.js";

/** Groups of the branch list, in display order. */
export const GIT_VIEW_GROUPS = ["checkedOut", "branches", "cbase", "remote"] as const;
export type GitGroup = (typeof GIT_VIEW_GROUPS)[number];
/** State of a cbase branch (group "cbase" only). */
export const GIT_VIEW_STATES = ["running", "ended", "copy-removed", "unknown"] as const;
export type GitState = (typeof GIT_VIEW_STATES)[number];
export const GIT_VIEW_USER_KINDS = ["subagent", "workflow-agent", "graph", "copy"] as const;
export type GitUserKind = (typeof GIT_VIEW_USER_KINDS)[number];
/** Why an instance is not read: the large view never wakes one. */
export const GIT_VIEW_REASONS = ["stopped", "starts", "frozen", "error", "time"] as const;
export type GitReason = (typeof GIT_VIEW_REASONS)[number];
/** Up to this many commits per row as dots; above it the server sends `points: null` and the row shows a bar. */
export const GIT_VIEW_POINTS_MAX = 15;
export const GIT_VIEW_ROWS_MAX = 400;
export const GIT_VIEW_DETAIL_COMMITS_MAX = 50;
/** Accent colors per copy (index 0..COLORS-1, kit variables `--kit-copy-0…5` in globals.css); the main has none. */
export const GIT_VIEW_COLORS = 6;
export const GIT_VIEW_WINDOW = ["7d", "30d", "everything"] as const;
export type GitWindow = (typeof GIT_VIEW_WINDOW)[number];
export const GIT_VIEW_WINDOW_DEFAULT: GitWindow = "30d";
export const GIT_VIEW_FETCH_GAP_MS = 5 * 60 * 1000;
export const GIT_VIEW_MAIN_BRANCH_SOURCES = ["origin/HEAD", "main", "master"] as const;
export type GitMainBranchSource = (typeof GIT_VIEW_MAIN_BRANCH_SOURCES)[number];
/** MR state without MR data. `error`: GitLab did not answer in a usable way; a state the UI must name instead of showing "none";
 *  also a contract value in contract.js MR_STATES. */
export const GIT_VIEW_MR_STATES = ["no-access", "none", "no-gitlab", "error"] as const;
export type GitMrState = (typeof GIT_VIEW_MR_STATES)[number];

export const GIT_VIEW_RESPONSE_FIELDS = ["repo", "repos", "mainBranch", "instances", "line", "rows", "clipped"] as const;
export const GIT_VIEW_INSTANCE_FIELDS = ["name", "color", "read", "reason", "remoteState"] as const;
export const GIT_VIEW_ROW_FIELDS = [
  "group", "name", "local", "remote", "detached", "instance", "toRemote", "toMain", "sinceCreation",
  "branchPoint", "last", "commits", "checkedOut", "user", "state",
] as const;
export const GIT_VIEW_CHECKED_OUT_FIELDS = ["instance", "worktree", "notBackedUp", "chats"] as const;
export const GIT_VIEW_USER_FIELDS = ["kind", "name", "chatId", "agentId", "childChatId", "instance"] as const;
export const GIT_VIEW_DETAIL_FIELDS = ["row", "commits", "files", "mr", "origin", "clipped", "failed"] as const;
/** Extra fields per repo in `GET …/git` for the small view: lib/api/git.ts `GitRepo`. */
export const GIT_REPO_FIELDS = ["branchesRunning", "counter"] as const;

export type GitViewRepo = { rel: string; name: string };
/** `at` = time of FETCH_HEAD in ms; `source: "unknown"` (without the file) ⇒ `at: null`. */
export type GitRemoteState = { at: number | null; source: "fetch-head" | "unknown" };
export type GitViewInstance = {
  name: string;
  /** Accent color 0..5 of a copy; `null` = the main (or none delivered). */
  color: number | null;
  read: boolean;
  /** Why not read: a word from GIT_VIEW_REASONS or, if the client does not know it, the server's text; `null` when `read`. */
  reason: string | null;
  /** `null` = not delivered (never "never fetched"; that is `source: "unknown"`). */
  remoteState: GitRemoteState | null;
};
export type GitCounts = { ahead: number; back: number };
export type GitToMain = GitCounts & { merged: boolean };
export type GitPoint = { t: number; pushed: boolean };
/** `points: null` ⇒ bar with `count` (more than POINTS_MAX); `notFetched` = commits the remote has and this state does not. */
export type GitCommits = { points: GitPoint[] | null; count: number | null; notFetched: number[] | null };
export type GitRunningChat = { chatId: string; title: string };
export type GitCheckedOut = {
  instance: string;
  /** Path of a worktree; `null` = the main or copy folder itself. */
  worktree: string | null;
  /** Unsaved changes; `null` = not read. */
  notBackedUp: number | null;
  /** The chats currently running in this instance; `null` for worktrees (or not delivered). */
  chats: GitRunningChat[] | null;
};
export type GitUser = {
  kind: GitUserKind;
  name: string | null;
  chatId: string | null;
  agentId: string | null;
  childChatId: string | null;
  /** For `copy`: the copy's name (`k1`). */
  instance: string | null;
};
export type GitLast = { t: number; author: string; subject: string };
export type GitViewRow = {
  group: GitGroup;
  /** Branch name; a detached HEAD is called "detached @ <short-sha>" (English on the wire: the detail route recognises it; the views translate it for display). */
  name: string;
  local: boolean;
  /** The upstream (`origin/x`); `null` = local only. */
  remote: string | null;
  detached: { sha: string } | null;
  /** Where the branch lives: `main` or the copy's name. */
  instance: string;
  toRemote: GitCounts | null;
  /** `null` = no main branch detected (or not delivered; in `branchesRunning` the server computes it only for running rows). */
  toMain: GitToMain | null;
  /** Copy rows only: against the snapshot ref. */
  sinceCreation: GitCounts | null;
  branchPoint: number | null;
  last: GitLast | null;
  commits: GitCommits | null;
  /** `[]` = checked out nowhere; `null` = not delivered. */
  checkedOut: GitCheckedOut[] | null;
  user: GitUser | null;
  /** Only group "cbase" carries a state; otherwise `null`. */
  state: GitState | null;
};
export type GitLine = { commits: number[] | null; count: number | null; from: number | null; until: number | null };
export type GitClipped = { shown: number; total: number };
export type GitView = {
  /** The repo that was read; `null` = none (the project has none or the answer did not carry it). */
  repo: GitViewRepo | null;
  repos: GitViewRepo[] | null;
  /** `null` = no main branch detected. */
  mainBranch: { name: string; source: GitMainBranchSource | null } | null;
  instances: GitViewInstance[] | null;
  line: GitLine | null;
  /** `null` = not read, `[]` = no branches. */
  rows: GitViewRow[] | null;
  /** The cap: more branches than shown; the search narrows on the server. */
  clipped: GitClipped | null;
};

export type GitDetailCommit = { sha: string; t: number | null; author: string; subject: string };
export type GitDetailFile = { file: string; plus: number | null; minus: number | null; binary: boolean };
export type GitMr =
  | { state: GitMrState; error: string }
  | { state: null; iid: number | null; title: string; target: string; pipeline: { status: string; url: string | null } | null; url: string | null };
export type GitOrigin =
  | { source: "cbase"; user: GitUser | null; state: GitState | null }
  | { source: "reflog"; from: string; at: number | null }
  | { source: "unknown" };
export type GitBranchDetail = {
  /** The row as the server delivers it with the detail; `null` = not delivered (the UI then takes the row from the list). */
  row: GitViewRow | null;
  /** Commits ahead, newest first; `null` = cannot be computed without a main branch (never "none"). */
  commits: GitDetailCommit[] | null;
  files: GitDetailFile[] | null;
  mr: GitMr | null;
  origin: GitOrigin | null;
  /** The cap per part: `commits`/`files` with `{shown, total}`, else `null`. */
  clipped: { commits: GitClipped | null; files: GitClipped | null } | null;
  /** Per part the reason it is `null` although a main branch exists (git failed); `null` without an entry here still means
   *  "no main branch". */
  failed: { commits: string | null; files: string | null } | null;
};
export type GitBranchDiff = { file: string; diff: string; clipped: boolean };
export type GitFetchResult = { skipped: boolean; remoteState: GitRemoteState | null; nextNotBefore: number | null };
/** The counters per group on the repo of `GET …/git`; a missing entry stays `null`. */
export type GitCounter = Record<GitGroup, number | null>;

/** `true` if type `A` carries exactly the keys of list `L`; otherwise `false`, and the assignment below is a type error. */
type SameKeys<A, L extends readonly string[]> = [Exclude<keyof A, L[number]>, Exclude<L[number], keyof A>] extends [never, never] ? true : false;
/** Binds the types to the lists (exported so no "unused" check removes it). */
export const GIT_VIEW_TYPES_BOUND: [
  SameKeys<GitView, typeof GIT_VIEW_RESPONSE_FIELDS>,
  SameKeys<GitViewInstance, typeof GIT_VIEW_INSTANCE_FIELDS>,
  SameKeys<GitViewRow, typeof GIT_VIEW_ROW_FIELDS>,
  SameKeys<GitCheckedOut, typeof GIT_VIEW_CHECKED_OUT_FIELDS>,
  SameKeys<GitUser, typeof GIT_VIEW_USER_FIELDS>,
  SameKeys<GitBranchDetail, typeof GIT_VIEW_DETAIL_FIELDS>,
] = [true, true, true, true, true, true];

// ── Allowlist ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const obj = (x: unknown): Record<string, unknown> | null => (x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : null);
const str = (x: unknown): string => (typeof x === "string" ? x : "");
const strOrNull = (x: unknown): string | null => (typeof x === "string" && x !== "" ? x : null);
const count = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);
const one = <T extends string>(list: readonly T[], x: unknown): T | null => (list.includes(x as T) ? (x as T) : null);
const times = (x: unknown): number[] | null => (Array.isArray(x) ? x.filter((t): t is number => typeof t === "number" && Number.isFinite(t)) : null);
const clippedOf = (x: unknown): GitClipped | null => {
  const g = obj(x);
  const shown = count(g?.shown);
  const total = count(g?.total);
  return shown !== null && total !== null ? { shown, total } : null;
};
const countsOf = (x: unknown): GitCounts | null => {
  const z = obj(x);
  const ahead = count(z?.ahead);
  const back = count(z?.back);
  return ahead !== null && back !== null ? { ahead, back } : null;
};
const repoOf = (x: unknown): GitViewRepo | null => {
  const r = obj(x);
  return r && typeof r.rel === "string" ? { rel: r.rel, name: str(r.name) || r.rel || "." } : null;
};
const list = <T>(x: unknown, norm: (e: unknown) => T | null): T[] | null =>
  Array.isArray(x) ? x.map(norm).filter((e): e is T => e !== null) : null;

export function normRemoteState(raw: unknown): GitRemoteState | null {
  const r = obj(raw);
  if (!r) return null;
  const at = count(r.at);
  return at !== null && r.source !== "unknown" ? { at, source: "fetch-head" } : { at: null, source: "unknown" };
}

export function normGitInstance(raw: unknown): GitViewInstance | null {
  const r = obj(raw);
  if (!r || typeof r.name !== "string" || !r.name) return null;
  const color = count(r.color);
  const read = r.read === true;
  return {
    name: r.name,
    color: color !== null && Number.isInteger(color) && color >= 0 && color < GIT_VIEW_COLORS ? color : null,
    read,
    // Not read without a reason stays "without reason", never silently "read" (empty is not unknown).
    reason: read ? null : strOrNull(r.reason),
    remoteState: normRemoteState(r.remoteState),
  };
}

export function normGitUser(raw: unknown): GitUser | null {
  const r = obj(raw);
  const kind = one(GIT_VIEW_USER_KINDS, r?.kind);
  if (!r || !kind) return null;
  return {
    kind, name: strOrNull(r.name), chatId: strOrNull(r.chatId), agentId: strOrNull(r.agentId),
    childChatId: strOrNull(r.childChatId), instance: strOrNull(r.instance),
  };
}

function normCheckedOut(raw: unknown): GitCheckedOut | null {
  const r = obj(raw);
  if (!r || typeof r.instance !== "string") return null;
  return {
    instance: r.instance || "main",
    worktree: strOrNull(r.worktree),
    notBackedUp: count(r.notBackedUp),
    chats: list(r.chats, (c) => {
      const x = obj(c);
      return x && typeof x.chatId === "string" && x.chatId ? { chatId: x.chatId, title: str(x.title) } : null;
    }),
  };
}

function normCommits(raw: unknown): GitCommits | null {
  const r = obj(raw);
  if (!r) return null;
  return {
    points: list(r.points, (p) => {
      const x = obj(p);
      const t = count(x?.t);
      return t !== null ? { t, pushed: x?.pushed !== false } : null;
    }),
    count: count(r.count),
    notFetched: times(r.notFetched),
  };
}

/** A row of the overview (and of `branchesRunning` of the small view); `null` without a name or with an unknown group. */
export function normGitViewRow(raw: unknown): GitViewRow | null {
  const r = obj(raw);
  const group = one(GIT_VIEW_GROUPS, r?.group);
  if (!r || !group || typeof r.name !== "string" || !r.name) return null;
  const loose = obj(r.detached);
  const zh = obj(r.toMain);
  const toMain = countsOf(zh);
  const last = obj(r.last);
  const lt = count(last?.t);
  return {
    group,
    name: r.name,
    local: r.local === true,
    remote: strOrNull(r.remote),
    detached: loose && typeof loose.sha === "string" ? { sha: loose.sha } : null,
    instance: str(r.instance) || "main",
    toRemote: countsOf(r.toRemote),
    toMain: toMain ? { ...toMain, merged: zh?.merged === true } : null,
    sinceCreation: countsOf(r.sinceCreation),
    branchPoint: count(r.branchPoint),
    last: lt !== null ? { t: lt, author: str(last?.author), subject: str(last?.subject) } : null,
    commits: normCommits(r.commits),
    checkedOut: list(r.checkedOut, normCheckedOut),
    user: normGitUser(r.user),
    state: one(GIT_VIEW_STATES, r.state),
  };
}

export function normGitView(raw: unknown): GitView {
  const r = obj(raw) ?? {};
  const hb = obj(r.mainBranch);
  const line = obj(r.line);
  return {
    repo: repoOf(r.repo),
    repos: list(r.repos, repoOf),
    mainBranch: hb && typeof hb.name === "string" && hb.name ? { name: hb.name, source: one(GIT_VIEW_MAIN_BRANCH_SOURCES, hb.source) } : null,
    instances: list(r.instances, normGitInstance),
    line: line ? { commits: times(line.commits), count: count(line.count), from: count(line.from), until: count(line.until) } : null,
    rows: list(r.rows, normGitViewRow),
    clipped: clippedOf(r.clipped),
  };
}

export function normGitMr(raw: unknown): GitMr | null {
  const r = obj(raw);
  if (!r) return null;
  const state = one(GIT_VIEW_MR_STATES, r.state);
  if (state) return { state, error: str(r.error) };
  if (r.iid === undefined && r.title === undefined) return null;
  const p = obj(r.pipeline);
  return {
    state: null, iid: count(r.iid), title: str(r.title), target: str(r.target),
    pipeline: p && typeof p.status === "string" ? { status: p.status, url: strOrNull(p.url) } : null,
    url: strOrNull(r.url),
  };
}

export function normGitOrigin(raw: unknown): GitOrigin | null {
  const r = obj(raw);
  if (!r) return null;
  if (r.source === "cbase") return { source: "cbase", user: normGitUser(r.user), state: one(GIT_VIEW_STATES, r.state) };
  if (r.source === "reflog" && typeof r.from === "string") return { source: "reflog", from: r.from, at: count(r.at) };
  if (r.source === "unknown") return { source: "unknown" };
  return null;
}

export function normGitBranchDetail(raw: unknown): GitBranchDetail {
  const r = obj(raw) ?? {};
  const g = obj(r.clipped);
  // The cap is per part (server detail.js: the file list is capped too); a flat `{shown, total}` (commits only) is read as the
  // commits' cap.
  const clipped = g ? (clippedOf(g) ? { commits: clippedOf(g), files: null } : { commits: clippedOf(g.commits), files: clippedOf(g.files) }) : null;
  return {
    row: normGitViewRow(r.row),
    commits: list(r.commits, (c) => {
      const x = obj(c);
      return x && typeof x.sha === "string" && x.sha ? { sha: x.sha, t: count(x.t), author: str(x.author), subject: str(x.subject) } : null;
    }),
    files: list(r.files, (d) => {
      const x = obj(d);
      if (!x || typeof x.file !== "string" || !x.file) return null;
      return { file: x.file, plus: count(x.plus), minus: count(x.minus), binary: x.binary === true };
    }),
    mr: normGitMr(r.mr),
    origin: normGitOrigin(r.origin),
    clipped: clipped && (clipped.commits || clipped.files) ? clipped : null,
    failed: failedOf(obj(r.failed)),
  };
}

const failedOf = (x: Record<string, unknown> | null): GitBranchDetail["failed"] => {
  const commits = typeof x?.commits === "string" && x.commits ? x.commits : null;
  const files = typeof x?.files === "string" && x.files ? x.files : null;
  return commits || files ? { commits, files } : null;
};

/** `branchesRunning` of a repo from `GET …/git`; `null` if the server does not carry the field (old server: the small view is missing). */
export function branchesRunningOf(repo: { branchesRunning?: unknown } | null | undefined): GitViewRow[] | null {
  return list(repo?.branchesRunning, normGitViewRow);
}

/** `counter` of a repo from `GET …/git`; `null` without the field; a missing group stays `null`, never 0. */
export function counterOf(repo: { counter?: unknown } | null | undefined): GitCounter | null {
  const z = obj(repo?.counter);
  if (!z) return null;
  return Object.fromEntries(GIT_VIEW_GROUPS.map((g) => [g, count(z[g])])) as GitCounter;
}

// ── Routes to the server ───────────────────────────────────────────────────────────────────────────────────────────────

const viewPath = (pid: string) => `/api/projects/${encodeURIComponent(pid)}/gitView`;
const query = (fields: Record<string, string | null | undefined>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) if (v !== null && v !== undefined) q.set(k, v);
  const s = q.toString();
  return s ? `?${s}` : "";
};

/** The overview. `repo` = `rel` of the repo (`""` = the project folder; `null` = the server's choice), `search` runs on the server BEFORE
 *  the cap, `fresh` reads every ready instance anew instead of from the cache (after the events `project/instance`, `project/copy`
 *  and after a fetch). */
export async function fetchGitView(pid: string, o: { repo?: string | null; search?: string; fresh?: boolean } = {}): Promise<GitView> {
  const raw = await api<unknown>(`${viewPath(pid)}${query({ repo: o.repo ?? null, search: o.search?.trim() || null, fresh: o.fresh ? "1" : null })}`);
  return normGitView(raw);
}

/** fetch in ONE instance. `auto: true` on opening (throttle per repo and instance), `auto: false` for the ⟳ button. */
export async function gitViewFetch(pid: string, body: { repo: string; instance: string; auto: boolean }): Promise<GitFetchResult> {
  const r = obj(await api<unknown>(`${viewPath(pid)}/fetch`, { method: "POST", body: JSON.stringify(body) }));
  return { skipped: r?.skipped === true, remoteState: normRemoteState(r?.remoteState), nextNotBefore: count(r?.nextNotBefore) };
}

export async function fetchGitBranchDetail(pid: string, o: { repo: string; instance: string; name: string }): Promise<GitBranchDetail> {
  return normGitBranchDetail(await api<unknown>(`${viewPath(pid)}/branch${query({ repo: o.repo, instance: o.instance, name: o.name })}`));
}

export async function fetchGitBranchDiff(pid: string, o: { repo: string; instance: string; name: string; file: string }): Promise<GitBranchDiff> {
  const r = obj(await api<unknown>(`${viewPath(pid)}/diff${query({ repo: o.repo, instance: o.instance, name: o.name, file: o.file })}`));
  return { file: str(r?.file) || o.file, diff: str(r?.diff), clipped: r?.clipped === true };
}
