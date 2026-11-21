// The small view: per repo of GET …/git (devtools/code-route.js) the fields `branchesRunning` and `counter` (contract.js
// GIT_REPO_FIELDS) — NO route of its own, NO second poller: the git status hook (web) and the Git sheet (iOS) stay the
// only tick of the bar.
//
//   smallView(tree, { root, g, projectId, workspaceId, freshRepo })  → the tree, per repo with the fields (or without, see below)
//     Wired via code-route.js setGitOverview (set in server.js — code-route.js stays domain-free). `root` = the root of the
//     code view, `g` = its git options (gitOptions: `instance` on the project level, `instanceFor(path)` on the workspace
//     level), `projectId` only on the project level, `workspaceId` on both; `freshRepo` = the `relPath` of a git action
//     that just ran and moves refs (commit, checkout, pull, fetch, push, merge, rebase, cherry-pick, merge-abort) — its
//     reading starts anew. stage, unstage, discard, apply and stash move no branch and ask without it (`notBackedUp`
//     comes fresh from the tree anyway).
//
// WHAT AND WHERE: per repo the instance the route has chosen anyway (`?chat=`, `?instance=`; without a project container
// the backend). ONLY a repo that is in the tree is read — i.e. an instance that GET …/git has just read (the route wakes
// a not-ready one as before, the reading afterwards may; one the route does not wake is not read either). On the
// workspace level a repo belongs to the project whose folder contains it (the deepest); a repo without a project gets no
// fields (without a project no running chats).
//   branchesRunning  the rows (groups.js allRows, the same shape as the large view) of the group "checkedOut" (the
//                    instance's folder, worktrees cbase did not create, a detached HEAD) and those of the group "cbase"
//                    with state `running` — user/state from user.js withUsers, `checkedOut[].chats` FRESH (withChats),
//                    and `notBackedUp` of the instance's folder fresh from the tree (`counts.total`, null if the status
//                    was not readable)
//   counter          `{ checkedOut, branches, cbase, remote }` over ALL rows of this one reading (groups.js counterFrom)
//
// NOT re-read every time and NOT folded into the argv bundle of git.js — the reading is the large view's from the cache
// (cache.js: ≤ 30 s, dropped at the end of every turn). So the 6 s tick costs nothing extra, and the argv
// anchor server/backend/test/fixtures/projectbox-git/argv-without-instance.json stays untouched. So that the checked-out
// branch never lags behind the tree next to it, an entry is valid only while its checked-out state (branch, head commit)
// matches the fresh tree — otherwise it is read anew.
//
// THE PRICE: GET …/git NEVER WAITS for a reading (cache.js readingWithoutWait). Waiting would hold the response
// on every cold or dropped entry — after every turn end, every change of the checked-out state, every git action — up to
// the reading's deadline (20 s), on the workspace level for the slowest of all repos. Instead: a valid entry comes at
// once; if it is missing, both fields are missing in THIS response ("unknown", the clients show nothing or "not read"),
// and the reading starts in the background (at most one per project, repo and instance) — the next round of the tick
// (≤ 6 s) carries the fields. From half its validity on, an entry triggers its successor so the tick never answers
// without fields in continuous operation.
//
// EMPTY IS NOT UNKNOWN: if the data is missing (not read yet, reading failed, no project, instance not readable), BOTH
// fields are missing — never an empty list and never 0. Without the ops marker the tree stays byte-identical (the anchor
// of server/backend/test/code-scopes.test.js holds that). Does not throw.
//
// Guard: server/backend/test/gitView.test.js.
import path from "node:path";
import * as store from "../store.js";
import { projectboxOps } from "../projectbox/ops.js";
import { allRows, counterFrom } from "./groups.js";
import { withUsers, withChats } from "./user.js";
import { instanceDisplay } from "./instance-choice.js";
import { readingWithoutWait } from "./cache.js";

// Is `abs` inside `folder` (or the folder itself)?
const under = (abs, folder) => abs === folder || abs.startsWith(folder.endsWith(path.sep) ? folder : `${folder}${path.sep}`);

// Does the checked-out state of the reading match the fresh tree (see header)? The worktree of this repo (its path), else
// the main worktree; detached: the same tip; otherwise the same branch and — if the tree knows it — the same head commit.
function matchesToTree(l, repo) {
  const wts = Array.isArray(l?.worktrees) ? l.worktrees : [];
  const w = wts.find((x) => x.path === repo.root) || wts.find((x) => x.main);
  if (!w) return false;
  const oid = String(w.oid || "");
  if (repo.detached) return Boolean(w.detached) && typeof repo.branch === "string" && repo.branch !== "" && oid.startsWith(repo.branch);
  if (w.branch !== `refs/heads/${repo.branch}`) return false;
  const header = repo.lastCommit?.hash;
  return !header || oid.startsWith(String(header));
}

function fieldsFor(repo, { root, g, projects, freshRepo }) {
  const abs = path.resolve(root, String(repo.relPath || ""));
  const proj = projects.filter((p) => p?.path && under(abs, path.resolve(p.path))).sort((a, b) => b.path.length - a.path.length)[0];
  if (!proj) return null;
  const rel = path.relative(path.resolve(proj.path), abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  const inst = g?.instance || (typeof g?.instanceFor === "function" ? g.instanceFor(repo.root) : null) || null;
  const seam = instanceDisplay(inst?.instance || "main");
  const l = readingWithoutWait(proj, rel.split(path.sep).join("/"), inst, {
    fresh: freshRepo !== null && freshRepo !== undefined && String(freshRepo) === String(repo.relPath || ""),
    valid: (x) => !x?.read || matchesToTree(x, repo),
  });
  if (!l?.read) return null;
  const pid = String(proj.id);
  const all = allRows({ main: l, mainName: seam });
  const counter = counterFrom(all);
  const candidates = withUsers(pid, all.filter((z) => z.group === "checkedOut" || z.group === "cbase"));
  const branchesRunning = candidates.filter((z) => z.group === "checkedOut" || z.state === "running");
  // The not-backed-up count of this instance's folder fresh from the tree (the status just ran); a worktree's from the reading.
  const freshCount = repo.counts && Number.isFinite(repo.counts.total) ? repo.counts.total : null;
  for (const z of branchesRunning) for (const e of z.checkedOut) if (e.instance === seam && e.worktree === null) e.notBackedUp = freshCount;
  withChats(pid, branchesRunning);
  return { branchesRunning, counter };
}

/** The tree of GET …/git with the fields of the small view (see header). */
export async function smallView(tree, { root, g = {}, projectId = null, workspaceId = null, freshRepo = null } = {}) {
  if (!projectboxOps() || !Array.isArray(tree?.repos) || !tree.repos.length || !root) return tree;
  let projects;
  try {
    projects = projectId != null
      ? [store.getProject(String(projectId))].filter(Boolean)
      : workspaceId != null ? store.listAllProjects().filter((p) => String(p.workspaceId) === String(workspaceId)) : [];
  } catch (e) {
    console.error("[gitView] small view: projects not readable:", e?.message || e);
    return tree;
  }
  if (!projects.length) return tree;
  const repos = tree.repos.map((repo) => {
    try {
      const f = fieldsFor(repo, { root, g, projects, freshRepo });
      return f ? { ...repo, ...f } : repo;
    } catch (e) {
    console.error(`[gitView] small view ${repo?.relPath ?? "?"}:`, e?.message || e);
      return repo;
    }
  });
  return { ...tree, repos };
}
