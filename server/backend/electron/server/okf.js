// OKF verification: knowledge entries (project_context) are anchored to the code via code_paths + last_verified_commit.
// This module computes on the server whether an entry is "possibly stale" (commits on its paths since the last
// verification) — agents and UI get the result delivered, instead of doing git archaeology themselves.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { isProjectRepo } from "./git.js";
import { gitRun, CONTAINER_STANDS, CONTAINER_PAUSED } from "./runtime/git-run.js";

const pexec = promisify(execFile);
const GIT_TIMEOUT_MS = 8000;
const MAX_STALE_COMMITS = 8; // nobody needs more as a hint — it is about "check!", not history

// With an instance (the routes pass `instanceForProject(pid)` through) every git of this file runs via runtime/git-run.js in
// the project container; without an instance the plain starter `gitInB`, unchanged. The search for the repo root
// (findRepoRoot) reads only the file system and stays in B.
// If the project container is standing (answer of the docker CLI, runtime/git-run.js CONTAINER_STANDS), the error carries
// `containerStands` and `projectId` — verifyAnchors reports that as `containerStands` (the verify route answers 409
// "project starting" and wakes it, instead of "no git repo"), staleInfo as "not assessable" (null) instead of "rebased".
const git = async (repoRoot, args, instance = null) => {
  if (!instance) return gitRun(null, repoRoot, args, { fallback: () => gitInB(repoRoot, args) });
  const r = await gitRun(instance, repoRoot, args, { timeout: GIT_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
  if (r.code !== 0) {
    // A paused container is just as "not assessable"; whether it is woken is decided by gitStandsSituation on the wording
    // (devtools/code-route.js — a pause never wakes).
    const stands = CONTAINER_STANDS.test(String(r.stderr || "")) || CONTAINER_PAUSED.test(String(r.stderr || ""));
    throw Object.assign(new Error(String(r.stderr || "").trim() || `git ${args[0]}: Exit ${r.code}`), { code: r.code, ...(stands ? { containerStands: true, projectId: instance.projectId } : {}) });
  }
  return r.stdout.trim();
};
// The plain starter: now only the fallback without an instance.
const gitInB = async (repoRoot, args) => {
  const { stdout } = await pexec("git", args, { cwd: repoRoot, timeout: GIT_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
  return stdout.trim();
};

// Repo root for an absolute path: search upward from there up to (including) projectPath for .git. Projects can
// contain SEVERAL repos (e.g. frontend/ + backend/ separate).
// The project repo counts as "no repo": it sits at the project folder and would enclose every path next to the code repos —
// every knowledge entry there would be "possibly stale" after every commit of cbase.
// `safe`: the project is converted (the caller has an instance) — `.git/config` is then written by the project container,
// and B reads it only without a reference (git.js isProjectRepo `safe`, anchor the project folder): a FIFO there would
// otherwise stop B's event loop, a reference would read a file of B. Without `safe` the plain call.
function findRepoRoot(absPath, projectPath, { safe = false } = {}) {
  let dir = fs.existsSync(absPath) && fs.statSync(absPath).isDirectory() ? absPath : path.dirname(absPath);
  const stop = path.resolve(projectPath);
  while (true) {
    if (fs.existsSync(path.join(dir, ".git")) && !isProjectRepo(dir, safe ? { safe: true, anchor: projectPath } : undefined)) return dir;
    if (path.resolve(dir) === stop) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Group code_paths (project-relative) by repo. Returns:
//   groups: Map<repoRelDir, { repoRoot, paths: string[] /* repo-relative */ }>
//   missing: paths that do not (any longer) exist — itself a stale signal
// `{ safe }`: see findRepoRoot — the exported functions below set it from `opts.instance`.
export function groupPathsByRepo(projectPath, codePaths, { safe = false } = {}) {
  const groups = new Map();
  const missing = [];
  for (const p of codePaths || []) {
    // Encapsulated per path: a broken symlink, a permission problem or an unreadable directory must not drag down the
    // assessment of the other paths.
    try {
      const rel = String(p).replace(/^\.\//, "");
      const abs = path.join(projectPath, rel);
      if (!fs.existsSync(abs)) { missing.push(rel); continue; }
      const repoRoot = findRepoRoot(abs, projectPath, { safe });
      if (!repoRoot) continue; // no repo — the path exists but is not git-anchored
      const repoRel = path.relative(projectPath, repoRoot) || ".";
      if (!groups.has(repoRel)) groups.set(repoRel, { repoRoot, paths: [] });
      groups.get(repoRel).paths.push(path.relative(repoRoot, abs) || ".");
    } catch { /* path not assessable — counts neither as repo nor as missing */ }
  }
  return { groups, missing };
}

// Verification: record the current HEADs of all touched repos. The CALLER is responsible for the content really having been
// checked against the code — here only the anchor is set.
// NEVER throws. A git problem may at most lead to an anchor missing — never to the whole call failing with a raw git
// message. That is exactly what happened: in three cases the agent got "fatal: not a git repository" on a cbase_context_list
// instead of its knowledge list.
// `opts.instance`: the project's instance — then the git calls run in the project container. If it stands, the answer carries
// `containerStands: { projectId, error }` — without an instance the field is absent.
export async function verifyAnchors(projectPath, codePaths, opts = {}) {
  let groups = new Map(); let missing = [];
  try { ({ groups, missing } = groupPathsByRepo(projectPath, codePaths, { safe: Boolean(opts.instance) })); } catch { /* nothing anchorable */ }
  const commits = {};
  let stands = null;
  for (const [repoRel, g] of groups) {
    try { commits[repoRel] = await git(g.repoRoot, ["rev-parse", "--short", "HEAD"], opts.instance || null); }
    catch (e) { if (e?.containerStands && !stands) stands = { projectId: e.projectId, error: String(e.message || e) }; /* otherwise: empty repo or the like */ }
  }
  return stands ? { commits, at: Date.now(), missing, containerStands: stands } : { commits, at: Date.now(), missing };
}

// Stale assessment of an entry. Result shapes:
//   null                                  → no code_paths → not assessable (no badge)
//   { neverVerified: true }               → anchored but never verified
//   { stale: false, verifiedAt }          → no commits on the paths since verification
//   { stale: true, verifiedAt, commits: [{repo, sha, subject}], missingPaths?, rebased? }
// NEVER throws — for the same reason as verifyAnchors. If the situation is not assessable, the answer is "not assessable"
// (null), not an error.
export async function staleInfo(projectPath, entry, opts = {}) {
  const codePaths = entry.codePaths || [];
  if (!codePaths.length) return null;
  const lv = entry.lastVerified;
  let groups = new Map(); let missing = [];
  try { ({ groups, missing } = groupPathsByRepo(projectPath, codePaths, { safe: Boolean(opts.instance) })); } catch { return null; }
  if (!lv || !lv.commits || !Object.keys(lv.commits).length) {
    return { neverVerified: true, ...(missing.length ? { missingPaths: missing } : {}) };
  }
  const commits = [];
  let rebased = false;
  for (const [repoRel, g] of groups) {
    const since = lv.commits[repoRel];
    if (!since) { rebased = true; continue; } // repo was added after verification → have it checked
    try {
      const out = await git(g.repoRoot, [
        "log", `--max-count=${MAX_STALE_COMMITS}`, "--format=%h%x1f%s", `${since}..HEAD`, "--", ...g.paths,
      ], opts.instance || null);
      for (const line of out ? out.split("\n") : []) {
        const [sha, subject] = line.split("\x1f");
        commits.push({ repo: repoRel, sha, subject: (subject || "").slice(0, 120) });
      }
    } catch (e) {
      // A standing project container is not a rewritten history — not assessable (null), no badge.
      if (e?.containerStands) return null;
      // Verification commit no longer in the history — after a rebase/history rewrite. Conservative: have it checked.
      rebased = true;
    }
  }
  const stale = commits.length > 0 || rebased || missing.length > 0;
  const info = { stale, verifiedAt: lv.at || null };
  if (commits.length) info.commits = commits;
  if (missing.length) info.missingPaths = missing;
  if (rebased) info.rebased = true;
  return info;
}

// Stale infos for a list — sequential per entry (project lists are small, git calls take milliseconds); entries without
// code_paths cost nothing.
export async function staleInfoForList(projectPath, entries, opts = {}) {
  const out = new Map();
  for (const e of entries) {
    if (!e.codePaths || !e.codePaths.length) continue;
    try { out.set(e.id, await staleInfo(projectPath, e, opts)); } catch { /* best effort */ }
  }
  return out;
}

// Deterministic path check for the validator: do the (newly set) code_paths exist?
export function missingCodePaths(projectPath, codePaths) {
  return (codePaths || []).map((p) => String(p).replace(/^\.\//, "")).filter((p) => !fs.existsSync(path.join(projectPath, p)));
}
