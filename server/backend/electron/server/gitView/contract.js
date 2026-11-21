// The contract of the Git overview between backend, web and iOS, as ONE leaf without imports. The backend (gitView/*,
// devtools/code-route.js for the small view) computes with these lists, and the binding test
// web/test/git-view-binding.test.mjs holds web (lib/api/gitView.ts) and iOS (Models/GitViewModels.swift) to them —
// changing a line here turns the suite red until both clients have followed. Pattern: preview/contract.js.

/** Groups of the branch list, in display order. */
export const GROUPS = Object.freeze(["checkedOut", "branches", "cbase", "remote"]);
/** State of a cbase branch (group "cbase" only). `unknown` ≠ `ended`: without a row in subagents/graph_starts there is
 *  no telling whether the agent finished or its chat was deleted. */
export const STATES = Object.freeze(["running", "ended", "copy-removed", "unknown"]);
/** Kinds of a user on a row. */
export const USER_KINDS = Object.freeze(["subagent", "workflow-agent", "graph", "copy"]);
/** Why an instance is not read — the large view never wakes one. */
export const REASONS = Object.freeze(["stopped", "starts", "frozen", "error", "time"]);
/** Up to this many commits per row as dots, above that a bar with a number. */
export const POINTS_MAX = 15;
/** Rows per repo and reading; above that `clipped: {shown, total}` — the search runs before the cap. */
export const ROWS_MAX = 400;
/** Commits ahead in the detail; above that `clipped`. */
export const DETAIL_COMMITS_MAX = 50;
/** Key colors per copy (index 0..COLORS-1); main has none. */
export const COLORS = 6;
/** Window of the time axis. */
export const WINDOW = Object.freeze(["7d", "30d", "everything"]);
export const WINDOW_DEFAULT = "30d";
/** Auto-fetch on opening at most this often per (repo, instance). */
export const FETCH_GAP_MS = 5 * 60 * 1000;
/** Origin of the detected main branch; `null` = none detected. */
export const MAIN_BRANCH_SOURCES = Object.freeze(["origin/HEAD", "main", "master"]);
/** MR state without MR data: no access with the GitLab account of the remote's host ≠ no open MR; `no-gitlab`: no account for
 *  that host or no such project. `error`: GitLab could not be read (unreachable, 5xx) — neither "no access" nor "none"; an
 *  error text stands next to it (gitView/merge-request.js). */
export const MR_STATES = Object.freeze(["no-access", "none", "no-gitlab", "error"]);

/** GET /api/projects/:pid/gitView — the fields of the response, exactly these. */
export const RESPONSE_FIELDS = Object.freeze(["repo", "repos", "mainBranch", "instances", "line", "rows", "clipped"]);
/** An instance in the response. */
export const INSTANCE_FIELDS = Object.freeze(["name", "color", "read", "reason", "remoteState"]);
/** A row (a branch) — the same shape in the large view and in `branchesRunning` of the small one. */
export const ROW_FIELDS = Object.freeze([
  "group", "name", "local", "remote", "detached", "instance", "toRemote", "toMain", "sinceCreation",
  "branchPoint", "last", "commits", "checkedOut", "user", "state",
]);
/** An entry in `row.checkedOut`; `chats` = the chats currently running in this instance, `null` for worktrees. */
export const CHECKED_OUT_FIELDS = Object.freeze(["instance", "worktree", "notBackedUp", "chats"]);
/** `row.user` (or `null`). */
export const USER_FIELDS = Object.freeze(["kind", "name", "chatId", "agentId", "childChatId", "instance"]);
/** GET …/gitView/branch — the detail. `failed`: `null` or `{ commits, files }`, per part the reason why it is `null`
 *  although there is a main branch — `null` without an entry there still means "no main branch". */
export const DETAIL_FIELDS = Object.freeze(["row", "commits", "files", "mr", "origin", "clipped", "failed"]);
/** Extra fields per repo in GET …/git for the small view. */
export const GIT_REPO_FIELDS = Object.freeze(["branchesRunning", "counter"]);
