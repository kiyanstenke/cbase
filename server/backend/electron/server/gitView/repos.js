// The code repos of a project for the Git overview — the repo choice of the large view and the field `repos` (the
// COUNT) of the project lists.
//
// reposInContainer(proj, inst)  → [{ rel, name, root }] of a CONVERTED project, WITHOUT git: git.js projectReposWithRoot
//   with `selfRoot` null (findRepos over the file system, read without following links). The same result as projectRepos
//   in the container: the project container mounts only the project folder, so the question "is the folder inside a
//   repo?" is answered there by a `.git` in the folder itself alone — exactly the first step of findRepos (the instances
//   tree, projectbox/instances-tree.js, computes the same way). Without `docker exec`: the large view knows its repos even
//   when main is not ready, and never wakes it.
//
// repoCount(proj)  → number | null — the number of code repos (the sub-item "Git" only with ≥ 1), `null` = not read yet.
//   Over the file system this costs about a millisecond per project, projectRepos WITH git in the backend 11–13 ms (one
//   process per question). Hence: converted ⇒ the file system, at once, cached per project for COUNT_MS; not converted ⇒
//   projectRepos in the backend (the path of GET …/git) IN THE BACKGROUND — the list never waits for git and says `null`
//   until the first answer. Dropped at turn end together with the readings (cache.js).
// withRepoCount(projects)  → the projects with `repos` — only in server operation; without the ops marker the same list.
//
// repoChoice(proj, raw, { required })  → { rel, name, root } | null — the ONE check of the parameter `repo` for ALL four
//   routes (large view, fetch, detail, diff): a path with `..`, absolute or with NUL ⇒ 400 REPO_INVALID, a path that is
//   not a code repo of the project (reposInContainer of main) ⇒ 404 UNKNOWN_REPO — never silently another repo and never
//   an arbitrary folder in the project. If `raw` is missing (null/undefined): with `required` 400 (a missing field is no
//   statement), otherwise the first repo (large view) or null without a repo. `repos` = the list already read (the large
//   view names it in the response). Throws with `status`/`code`.
//
// Guards: server/backend/test/gitView.test.js (choice, count), git-view-detail.test.js (detail, diff, fetch with a
// foreign folder).
import path from "node:path";
import { T } from "../i18n.js";
import { projectRepos, projectReposWithRoot } from "../git.js";
import { projectboxOps } from "../projectbox/ops.js";
import { runInstance } from "../projectbox/run-instance.js";

const error = (status, code, text) => Object.assign(new Error(text), { status, code });

/** The repo of a request (see header). */
export function repoChoice(proj, raw, { required = false, repos = null } = {}) {
  if (raw === null || raw === undefined) {
    if (required) throw error(400, "REPO_INVALID", T("repo is missing or not a path inside the project (\"\" = the project folder)"));
  } else if (typeof raw !== "string" || raw.includes("..") || raw.startsWith("/") || path.isAbsolute(raw) || raw.includes("\0")) {
    throw error(400, "REPO_INVALID", T("repo is not a path inside the project (\"\" = the project folder)"));
  }
  const list = repos || reposInContainer(proj, runInstance(String(proj.id), "main"));
  if (raw === null || raw === undefined) return list[0] || null;
  const r = list.find((x) => x.rel === raw);
  if (!r) throw error(404, "UNKNOWN_REPO", T`No code repository "${raw}" in this project.`);
  return r;
}

/** How long a count is valid (see header). */
export const COUNT_MS = 30_000;

/** The repos of a converted project without git (see header). */
export function reposInContainer(proj, inst) {
  return projectReposWithRoot(proj.path, null, { instance: inst }).map((r) => ({ rel: r.relPath || "", name: r.name, root: r.root }));
}

// Project id → { time, path, count }; the questions running in the backend → promise.
const counts = new Map();
const running = new Map();
/** Drop this project's cache (called from cache.js). */
export function forgetRepoCount(projectId) { counts.delete(String(projectId)); }
/** For tests: waits until every question in the backend is answered. */
export const repoCountsFinished = () => Promise.all([...running.values()]).then(() => undefined);

/** The number of code repos of a project or `null` (see header). Does not throw. */
export function repoCount(proj) {
  const pid = String(proj?.id ?? "");
  if (!pid || !proj.path) return null;
  const old = counts.get(pid);
  const known = old && old.path === proj.path ? old.count : null;
  if (old && old.path === proj.path && Date.now() - old.time < COUNT_MS) return old.count;
  let inst;
  try { inst = runInstance(pid, "main"); } catch { return known; } // instance not readable: do not guess
  if (inst) {
    try {
      const count = reposInContainer(proj, inst).length;
      counts.set(pid, { time: Date.now(), path: proj.path, count });
      return count;
    } catch { return known; }
  }
  if (!running.has(pid)) {
    const filePath = proj.path;
    const z = projectRepos(filePath)
      .then((r) => { counts.set(pid, { time: Date.now(), path: filePath, count: r.length }); }, () => {})
      .finally(() => { if (running.get(pid) === z) running.delete(pid); });
    running.set(pid, z);
  }
  return known;
}

/** The projects of a list with `repos` (see header). */
export function withRepoCount(projects) {
  if (!projectboxOps() || !Array.isArray(projects)) return projects;
  return projects.map((p) => (p && typeof p === "object" ? { ...p, repos: repoCount(p) } : p));
}
