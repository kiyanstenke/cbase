// ── Git / GitLab (a project's local working area) ───────────────────────────
export interface GitChange {
  x: string;   // Index-Status (staged)
  y: string;   // working-tree status
  path: string;
  code: string; // display letter (M, A, D, R, ?)
  label: string;
  kind: "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflict";
}
export interface GitRemote {
  url: string;
  host: string;
  projectPath: string; // e.g. "group/proj"
  webUrl: string;      // https://host/group/proj
  isGitlab: boolean;
}
// A single repo (the project folder itself or one nested in it).
export interface GitRepo {
  name: string;        // display name: relPath or basename of the repo root
  relPath: string;     // path relative to the project folder ("" = the project folder itself)
  root?: string;
  branch?: string;
  detached?: boolean;
  upstream?: string | null;
  ahead?: number;
  behind?: number;
  changes?: GitChange[];
  counts?: { staged: number; unstaged: number; untracked: number; total: number };
  clean?: boolean;
  // `git status` failed (unreadable index, output cap): the reason, translated by the server. Then `clean` is false and `counts`
  // null: unknown, never "clean".
  statusError?: string;
  truncated?: boolean;
  lastCommit?: { hash: string; subject: string; author: string; relative: string };
  remote?: GitRemote | null;
  // Git overview, small view (contract `GIT_REPO_FIELDS` in lib/api/gitView.ts): the running branches of the instance this route
  // reads anyway (checked-out branch with running chats, worktrees, live cbase branches) and the counters per group. RAW as sent;
  // read only via `branchesRunningOf`/`counterOf` (allowlist). If both are missing (old server) the "Branches" section is absent.
  // Deliberately no type import from gitView.ts: this file is a leaf that tests compile individually (chat-bar.test.mjs via
  // lib/chat-instance.ts); an import would pull in core.ts with `process` and break there without @types in the work folder.
  branchesRunning?: unknown[] | null;
  counter?: Record<string, number | null> | null;
}
export interface GitTree {
  repos: GitRepo[]; // all relevant repos; empty = no git repo in the project
  // Project container: if the container of a converted project is not ready, the server says so here instead of silently
  // returning an empty list; project level on top, workspace level per project under `projects`.
  starts?: boolean;
  notice?: string;
  error?: string;
  projects?: { projectId: string; starts?: boolean; notice?: string; error?: string }[];
  // If git ran in a COPY (`?chat=` of a copy chat), the project level names it here ("copy-k1", devtools/code-route.js
  // gitResponse); the main never carries the field. Reading: lib/chat-instance.ts.
  instance?: string;
  // Only on the error tree of an instance choice (`?instance=`, lib/chat-instance.ts gitErrorTree): `UNKNOWN_INSTANCE` |
  // `INSTANCE_INVALID` and the chosen identifier; the chat bar falls back to the chat on it (lib/bar-instance.ts afterErrorBar).
  code?: string;
  identifier?: string;
}
// Explorer styled like VS Code: `GET …/git/ignored` returns per repo the paths git ignores (folders with a trailing "/", capped
// with `clipped`), relative to `relPath` (the repo within the project; if the project lies UNDER its repo's root, relative to the
// project). `ignored: null`: this repo could not be asked (nothing dimmed; unknown is not "nothing ignored"). Computed in
// lib/explorer-decoration.ts `ignoredChecker`; server: server/backend/electron/server/git.js `gitIgnored`.
export interface GitIgnoredRepo { relPath: string; ignored: string[] | null; clipped: boolean }
export interface GitIgnored { repos: GitIgnoredRepo[]; projects?: GitTree["projects"] }
/** The messages of the project containers of a git view (empty = nothing to say). */
export function gitHints(tree: GitTree | null): string[] {
  if (!tree) return [];
  const top = tree.notice || tree.error || "";
  return [top, ...(tree.projects || []).map((p) => p.notice || p.error || "")].filter((x): x is string => !!x);
}
export interface GitBranches {
  current: string;
  locals: string[];
  remotes: string[];
}
export interface GitDiff {
  path: string;
  staged: boolean;
  diff: string; // unified diff (git diff)
}
export interface GitStashEntry { ref: string; message: string; relative: string; }
export interface GitStashList { stashes: GitStashEntry[]; }
export interface GitLogEntry { hash: string; short: string; subject: string; author: string; relative: string; }
export interface GitLog { commits: GitLogEntry[]; }

// The graph of the git bar: `POST …/git/log` with `graph: "all" | "current"` (server git.js gitGraphLog) adds parents, badges
// (refs), time and HEAD per commit, and `clipped` and `extent` on the answer. Read ONLY via `normGitGraphLog` (allowlist): a missing
// field is no statement. `parents: null` (an old server does not know `graph`) draws the graph linear, `clipped: null` means
// "unknown" (then the length decides on "Load more", lib/git-graph.ts loadMore), an unknown ref kind drops out.
export type GitGraphExtent = "all" | "current";
export type GitRefKind = "head" | "local" | "remote" | "tag";
export interface GitRef { name: string; kind: GitRefKind }
export interface GitGraphEntry extends GitLogEntry { parents: string[] | null; refs: GitRef[]; head: boolean; time: number | null }
export interface GitGraphLog { commits: GitGraphEntry[]; clipped: boolean | null; extent: GitGraphExtent | null }
const REF_KINDS: readonly string[] = ["head", "local", "remote", "tag"];
const EXTENTS: readonly string[] = ["all", "current"];
const text = (x: unknown): string => (typeof x === "string" ? x : "");
export function normGitGraphLog(raw: unknown): GitGraphLog {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const commits: GitGraphEntry[] = [];
  for (const e of Array.isArray(o.commits) ? o.commits : []) {
    if (!e || typeof e !== "object") continue;
    const c = e as Record<string, unknown>;
    const hash = text(c.hash);
    if (!hash) continue;
    const parents = Array.isArray(c.parents) && c.parents.every((p) => typeof p === "string" && p !== "") ? (c.parents as string[]).slice() : null;
    const refs = (Array.isArray(c.refs) ? c.refs : [])
      .filter((r): r is GitRef => !!r && typeof r === "object" && typeof (r as GitRef).name === "string" && (r as GitRef).name !== "" && REF_KINDS.includes((r as GitRef).kind))
      .map((r) => ({ name: r.name, kind: r.kind }));
    const time = typeof c.time === "number" && Number.isFinite(c.time) && c.time > 0 ? c.time : null;
    commits.push({ hash, short: text(c.short) || hash.slice(0, 8), subject: text(c.subject), author: text(c.author), relative: text(c.relative), parents, refs, head: c.head === true, time });
  }
  return {
    commits,
    clipped: typeof o.clipped === "boolean" ? o.clipped : null,
    extent: typeof o.extent === "string" && EXTENTS.includes(o.extent) ? (o.extent as GitGraphExtent) : null,
  };
}
// The expanded commit in the graph: `POST …/git/show` with `files: true` or `file` (+ `old`), server git.js. Read ONLY via the
// allowlists below. A MISSING FIELD IS NO STATEMENT: an old server does not know the options and answers with the WHOLE commit
// (`{ hash, diff }`); `normGitCommitFiles` then returns `null` ("unavailable", never an empty list meaning "no changes"), and
// `normGitCommitFileDiff` accepts only an answer that returns the requested path (else the whole commit would stand as the file's diff).
export type GitCommitStatus = "M" | "A" | "D" | "R" | "C" | "T" | "U";
export interface GitCommitFile { path: string; old: string | null; status: GitCommitStatus }
export interface GitCommitFiles {
  hash: string;
  /** The parents (full hash), first first; empty = root commit; null = the server does not say. */
  parent: string[] | null;
  files: GitCommitFile[];
  /** All changed files; null = unknown (the output cap applied, or the server does not say). */
  total: number | null;
  clipped: boolean | null;
  /** Entries the allowlist could not read (unknown letter, no path); they are missing from `files`, counted instead of silent. */
  unreadable: number;
}
const COMMIT_STATUS: readonly string[] = ["M", "A", "D", "R", "C", "T", "U"];
const object = (x: unknown): Record<string, unknown> => (x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : {});
export function normGitCommitFiles(raw: unknown): GitCommitFiles | null {
  const o = object(raw);
  if (!Array.isArray(o.files)) return null;
  const files: GitCommitFile[] = [];
  let unreadable = 0;
  for (const e of o.files) {
    const d = object(e);
    const path = text(d.path);
    if (!path || typeof d.status !== "string" || !COMMIT_STATUS.includes(d.status)) { unreadable += 1; continue; }
    files.push({ path, old: text(d.old) || null, status: d.status as GitCommitStatus });
  }
  const parent = Array.isArray(o.parent) && o.parent.every((p) => typeof p === "string" && p !== "") ? (o.parent as string[]).slice() : null;
  const total = typeof o.total === "number" && Number.isInteger(o.total) && o.total >= 0 ? o.total : null;
  return { hash: text(o.hash), parent, files, total, clipped: typeof o.clipped === "boolean" ? o.clipped : null, unreadable };
}
export interface GitCommitFileDiff { hash: string; path: string; diff: string; clipped: boolean | null }
/** `path` = the path as requested (lib/git-files.ts diffPath). Null: the answer does not belong to this request. */
export function normGitCommitFileDiff(raw: unknown, path: string): GitCommitFileDiff | null {
  const o = object(raw);
  if (!path || o.path !== path || typeof o.diff !== "string") return null;
  return { hash: text(o.hash), path, diff: o.diff, clipped: typeof o.clipped === "boolean" ? o.clipped : null };
}

// The HOVERED commit in the graph: `POST …/git/show` with `info: true`, server git.js. Read ONLY via `normGitCommitInfo`. An old
// server does not know `info` and answers with the WHOLE commit (`{ hash, diff }`): then `null` ("unknown"); the card shows what the
// graph already knows (author, time, subject, hash) and NO count line, never "0 files changed". The four numbers are ONE block: if
// one is missing or nonsense, the whole block is unknown (`counts: null`), never a silent 0.
export interface GitCommitCounts { files: number; plus: number; minus: number; binary: number }
export interface GitCommitInfo {
  hash: string;
  /** The parents (full hash), first first; empty = root commit; null = the server does not say. */
  parent: string[] | null;
  author: string;
  email: string | null;
  /** The AUTHOR time in ms (as VS Code); null = unknown. */
  time: number | null;
  /** The whole message (subject and body, line breaks kept). */
  message: string;
  messageClipped: boolean | null;
  /** Against the first parent; null = unknown (output cap, or the server does not say). */
  counts: GitCommitCounts | null;
  countsClipped: boolean | null;
}
const count = (x: unknown): number | null => (typeof x === "number" && Number.isInteger(x) && x >= 0 ? x : null);
/** `hash` = the hash that was asked for. Null: the answer is no info (old server) or belongs to another commit. */
export function normGitCommitInfo(raw: unknown, hash: string): GitCommitInfo | null {
  const o = object(raw);
  if (typeof o.message !== "string" || typeof o.author !== "string") return null;
  const h = text(o.hash);
  if (!hash || !h.startsWith(hash)) return null;
  const [files, plus, minus, binary] = [count(o.files), count(o.plus), count(o.minus), count(o.binary)];
  const counts = files !== null && plus !== null && minus !== null && binary !== null && binary <= files ? { files, plus, minus, binary } : null;
  const parent = Array.isArray(o.parent) && o.parent.every((p) => typeof p === "string" && p !== "") ? (o.parent as string[]).slice() : null;
  const time = typeof o.time === "number" && Number.isFinite(o.time) && o.time > 0 ? o.time : null;
  return {
    hash: h, parent, author: o.author, email: text(o.email) || null, time, message: o.message,
    messageClipped: typeof o.messageClipped === "boolean" ? o.messageClipped : null,
    counts, countsClipped: typeof o.countsClipped === "boolean" ? o.countsClipped : null,
  };
}

export interface GitBlameLine { sha: string; author: string; relative: string; summary: string; }
export interface GitBlame { file: string; lines: GitBlameLine[]; }

