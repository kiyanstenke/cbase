// Tearing down worktrees of converted projects — in the project container, and with a stopped container as post-work.
// A leaf of the hub: imports only runtime/git-run.js, ./runtime-location.js and (for the accesses of lfsInWorktree)
// the data layer — the instance comes as an object from the caller (runs/instance.js, never projectbox/).
//
// WHY. Cleaning up a worktree is git: `status`, `rev-list`, `worktree remove`, `branch -D`. In a converted project
// the project container can write hooks, `core.fsmonitor` and filters of every code repo — a git of the backend
// would execute them in the backend ("everything in the container"). And the cleanup often comes from a
// SYNCHRONOUS path (the settle of a subagent, the delete path of a chat, the hook `chatClosed`) that cannot wait
// for a `docker exec`. So here it is a JOB: accepted at once, executed asynchronously, one after another per
// project (two jobs on the same repo do not collide at the `index.lock`, and a second job for the same folder sees
// what the first left behind), counted in the set `open` (pattern projectbox/cleanUp.js) — awaitable at server end
// (hook "serverEnd" in server.js) and in tests.
//
//   worktreeTeardown(inst, job) → Promise<{ removed, changed, postWork, error: [] }>   never throws
//     job = { who, worktrees: [{ repo, dir, branch?, base?, deleteBranch? }], allUnversioned?, own?: [path],
//             links?: [path], folder? }
//     1. CHECK (contract: "no cleanup removes a worktree with unsaved changes" — there is no `force` here): per
//        existing folder `status --porcelain -z` (with `allUnversioned` every unversioned file individually)
//        without the `own` paths, and with `base` commits in `base..HEAD`. If ONE carries something ⇒ nothing is
//        removed (`changed`). A git that does not answer does not mean "unchanged": then everything stays.
//     2. resolve the `links` — no teardown may reach into the `node_modules` of the main folder; IN the project
//        container (see below);
//     3. per worktree `worktree remove --force <dir>` (only if the folder exists), `worktree prune`, and with
//        `deleteBranch` `branch -D` — if the folder is already gone, the branch only falls if it is provably not
//        beyond `base` (without `base` it stays);
//     4. remove `folder` (the run folder of a graph worktree) — IN the project container (`rm -rf --`).
//     Steps 2 and 4 run in the container: their paths carry names from the container, and every folder on them
//     lies in a location it writes — a step in the backend would follow a symlink it placed. In the container they
//     only harm the project itself; the check of a post-work row (see below) stays before that, in the backend, and
//     only reads.
//     IF THE CONTAINER IS STOPPED (runtime/git-run.js containerStands — the docker CLI's answer, not a state of the
//     row; likewise a PAUSED one, containerPaused): no git in the backend, no waking. The job goes as a row into
//     the post-work (`postWork: true`, file see below), the folder stays. A job is idempotent — a half executed one
//     runs from the start next time.
//
//   gitPostWork(inst) → Promise<{ read, removed, changed, again, dismissed, error }>   never throws
//     A project's post-work: the rows of the file are taken over SYNCHRONOUSLY (the file becomes `.running`; what is
//     entered afterwards is in a new one), then worktreeTeardown in the container per row. If it is stopped again,
//     the job enters itself anew; a worktree with changes stays (and is done — checked is checked). The leftover of
//     an aborted post-work (`.running` from a crash) runs along. Attached to the transition to ready through the
//     restore (projectbox/restore.js atReady), wired in server.js.
//
//   THE FILE: `<data>/git-post-work/<projectId>.jsonl` (postWorkFile) — NOT in the runtime folder. The creation
//     mounts that writable into the project container, and the backend executes the rows: a row from the container
//     could delete arbitrary folders of the backend (DB, login). No rule mounts `<data>/` itself. And still EVERY
//     row is checked, on entering and on executing (jobError): `folder` only as a direct child of the project's
//     worktree root (runs/runtime-location.js), every worktree `dir` in such a child, every link really below it;
//     no symlink on the way (the root itself, the child, the real path of the parent folder against the real
//     runtime folder). A row that does not meet this does not run at all (`dismissed`, reported); before every
//     resolving of a link and before removing the folder the path is checked once more — between check and step
//     lie git calls in the container that could change it. A job that fails on entering is not entered
//     (`postWork: false` with an error) — it would not run at the start anyway. Direct jobs (worktreeTeardown) come
//     from the backend and stay unchecked.
//
//   gitInProject(inst) → { run(args, cwd) → Promise<{ ok, out, err, stands }>, teardown(job), lfs(dir) }
//     What a subagent core needs (providers/agent-runtime.js): a git in the project container (`out` trimmed), the
//     teardown job and the LFS files of a fresh worktree (lfsInWorktree, also for the graph worktree). runs/agents.js
//     passes it through per identifier.
//
//   PER IDENTIFIER: everything above applies to EVERY instance of a project, not just the main. The instance (main
//     or `copy-<name>`) determines (a) the chain and the count of open jobs — the main under the project id, a copy
//     under `<projectId>/copy-<name>`; (b) the post-work file — `<projectId>.jsonl`, a copy
//     `<projectId>.copy-<name>.jsonl`; (c) the boundary of a row: the worktree root of the instance
//     (runs/runtime-location.js worktreeRoot — for a copy `<runtime>/copy-worktrees/<name>`), never the main's and
//     never another copy's; (d) the repo: for a copy it lies in the CLONE, which the backend does not see — whether
//     it is there the teardown asks the container (`rev-parse --git-dir`), not the backend's file system. Every git
//     call goes to the instance's container; a teardown in the copy never touches the main (no `worktree prune` in
//     the main). The main's post-work runs after ready and also after thawing (stacks/freeze.js): a teardown that
//     hit a FROZEN container ("is paused") lies there.
//
//   openGitJobs() → Promise   until no job is open any more (tests).
//   openGitJobsUntil(deadline) → Promise<{ finished, open }>   the same with a cap — the hook "serverEnd" in
//     server.js: the hooks share ONE cap of 45 s (runs/server-end.js), and after it comes the stop chain of the
//     project containers. Default CBASE_GIT_END_MS = 10 s (0 = do not wait at all); if it strikes, the console says
//     so. What still runs afterwards hits a stopped container: a call that only starts then enters its job into
//     the post-work; one that the stop hits midway leaves its worktree in place (checked is only what was checked).
//   openGitJobsOf(projectId, instance = "main") → number   the accepted, unfinished jobs of an instance of a
//     project — projectbox/idle.js counts them: a recreation or delete does not stop the container under a running
//     `worktree remove`; clearing away a copy likewise.
//
// Guard: server/backend/test/projectbox-git-worktree.test.js.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { commandRun, containerPaused, containerStands, gitRun, lfsFetch, networkHosts, accessAsEnvironment } from "../runtime/git-run.js";
import * as store from "../store.js";
import { locationFor, worktreeRoot } from "./runtime-location.js";

/** The post-work folder under `<data>/` — outside every runtime folder (see header). */
export const POST_WORK_FOLDER = "git-post-work";
// Deadline of a call in the container (the cap of gitRun reports that it is one). A `worktree remove` on a large
// tree is slow, but never two minutes.
const TEARDOWN_DEADLINE_MS = 120_000;
// The cap of the hook "serverEnd" (see header): read at call time, an integer ≥ 0, otherwise the default.
const GIT_END_DEFAULT_MS = 10_000;
const gitEndMs = () => {
  const n = Number(process.env.CBASE_GIT_END_MS);
  return process.env.CBASE_GIT_END_MS !== undefined && process.env.CBASE_GIT_END_MS !== "" && Number.isInteger(n) && n >= 0 ? n : GIT_END_DEFAULT_MS;
};

const MAIN = "main";
const instanceOf = (inst) => String(inst?.instance || MAIN);
// The key of the chain and the count (see header, "per identifier"): the main under the project id, a copy below it.
// A project id never contains a slash (runtime-location.js VALID_ID) — the two forms do not collide.
const keyOf = (projectId, instance = MAIN) => (instance === MAIN ? String(projectId) : `${projectId}/${instance}`);

/** The post-work file of an instance: `<data>/git-post-work/<projectId>.jsonl` for the main, for a copy
 *  `<projectId>.<instance>.jsonl` (see header). Id and name are checked by the location (runs/runtime-location.js —
 *  never something that leads out of the folder). */
export function postWorkFile(projectId, instance = MAIN) {
  const location = locationFor({ projectId: String(projectId), converted: true });
  const i = String(instance || MAIN);
  if (i !== MAIN) worktreeRoot(location, i); // throws for an instance outside the form
  return path.join(locationFor({}).root, POST_WORK_FOLDER, i === MAIN ? `${location.projectId}.jsonl` : `${location.projectId}.${i}.jsonl`);
}

// ── The check of a row (see header) ────────────────────────────────────────────────────────────────────────────────
const lstatOrNull = (p) => {
  try { return fs.lstatSync(p); } catch (e) { if (e?.code === "ENOENT") return null; throw e; }
};
// The boundary of an instance: its worktree root (lexical) and the project's runtime folder.
function limitFor(projectId, instance = MAIN) {
  const location = locationFor({ projectId: String(projectId), converted: true });
  return { wt: worktreeRoot(location, instance), root: location.root };
}
// Why a path of the row must not be touched — null if it may. `kindName`: "folder" (exactly a direct child of the
// worktree root), "dir" (the child or inside it — a graph worktree puts repos under their relative path), "link"
// (really inside a child). What does not exist (yet) no step in the backend can touch: then only the form counts.
function pathError(g, p, kindName) {
  try {
    if (typeof p !== "string" || !p) return `${kindName}: not a path`;
    if (!path.isAbsolute(p) || path.resolve(p) !== p) return `${kindName} ${p}: not absolute and normalised`;
    const rel = path.relative(g.wt, p);
    const parts = rel ? rel.split(path.sep) : [];
    if (!parts.length || parts[0] === ".." || path.isAbsolute(rel)) return `${kindName} ${p}: not below ${g.wt}`;
    if (kindName === "folder" && parts.length !== 1) return `${kindName} ${p}: not a direct child of ${g.wt}`;
    if (kindName === "link" && parts.length < 2) return `${kindName} ${p}: not inside a worktree folder`;
    const w = lstatOrNull(g.wt);
    if (!w) return null;
    if (w.isSymbolicLink() || !w.isDirectory()) return `${g.wt} is not a regular folder`;
    // The root's real location: the real runtime folder and the rest of the root behind it (one folder for the
    // main, two for a copy: the copies' folder and its name) — a link on the way there changes the real path and
    // shows.
    const realWt = path.join(fs.realpathSync(g.root), path.relative(g.root, g.wt));
    if (fs.realpathSync(g.wt) !== realWt) return `${g.wt} does not lie in the runtime folder (${fs.realpathSync(g.wt)})`;
    const kindPath = path.join(g.wt, parts[0]);
    const kind = lstatOrNull(kindPath);
    if (kind && kind.isSymbolicLink()) return `${kindPath} is a symlink`;
    if (kindName === "link") {
      let parent;
      try { parent = fs.realpathSync(path.dirname(p)); } catch (e) { if (e?.code === "ENOENT") return null; throw e; }
      const r = path.relative(path.join(realWt, parts[0]), parent);
      if (r.split(path.sep)[0] === ".." || path.isAbsolute(r)) return `${kindName} ${p}: the parent folder lies outside (${parent})`;
    }
    return null;
  } catch (e) {
    return `${kindName} ${p}: cannot be checked (${e?.message || e})`;
  }
}
/** Why a post-work row must not run — null if it may (see header). Never throws. */
export function jobError(projectId, a, instance = MAIN) {
  if (!a || typeof a !== "object" || Array.isArray(a)) return "not a job";
  let g;
  try { g = limitFor(projectId, instance); } catch (e) { return String(e?.message || e); }
  // The job's fields (not a path — hence not as a string literal, see the path guard in runtime-location.test.js).
  const listen = { worktrees: a.worktrees, links: a.links, own: a.own };
  for (const [k, v] of Object.entries(listen)) if (v !== undefined && !Array.isArray(v)) return `${k} is not a list`;
  for (const w of a.worktrees || []) {
    if (!w || typeof w !== "object") return "worktrees: not an entry";
    const f = pathError(g, w.dir, "dir");
    if (f) return f;
  }
  for (const l of a.links || []) {
    const f = pathError(g, l, "link");
    if (f) return f;
  }
  if (a.folder !== undefined && a.folder !== null && a.folder !== "") return pathError(g, a.folder, "folder");
  return null;
}

// ── The chain per project and the set `open` ───────────────────────────────────────────────────────────────────────
const chains = new Map(); // key (keyOf) → the end of the chain
const open = new Set();
const perProject = new Map(); // key → number of accepted, unfinished jobs
function queued(id, fn) {
  perProject.set(id, (perProject.get(id) || 0) + 1);
  const prior = chains.get(id) || Promise.resolve();
  const p = prior.then(fn, fn);
  const end = p.then(() => {}, () => {});
  chains.set(id, end);
  open.add(end);
  end.finally(() => {
    open.delete(end);
    if (chains.get(id) === end) chains.delete(id);
    const n = (perProject.get(id) || 1) - 1;
    if (n > 0) perProject.set(id, n); else perProject.delete(id);
  });
  return p;
}

/** Until no job is open any more — including one that arrived while waiting. */
export async function openGitJobs() {
  while (open.size) await Promise.all([...open]);
}
/** The same with a cap (see header) — the hook "serverEnd". `deadline` in ms (default CBASE_GIT_END_MS). Never throws. */
export async function openGitJobsUntil(deadline = gitEndMs()) {
  if (!open.size) return { finished: true, open: 0 };
  let finished = false;
  if (deadline > 0) {
    let clock = null;
    const cap = new Promise((resolve) => { clock = setTimeout(() => resolve(false), deadline); clock.unref?.(); });
    finished = await Promise.race([openGitJobs().then(() => true, () => true), cap]);
    clearTimeout(clock);
  }
  if (finished) return { finished: true, open: 0 };
  const n = open.size;
  console.warn(`[git-post-work] server end: cap of ${deadline} ms hit (CBASE_GIT_END_MS) — ${n} git job(s) still running; the stop chain stops the project containers anyway (a call after that goes into the post-work, one midway leaves its worktree in place)`);
  return { finished: false, open: n };
}
/** The accepted, unfinished jobs of an instance of a project (see header; without `instance` the main).
 *  `instance === null`: those of the WHOLE project — main and every copy (a lock of the whole project waits for all). */
export function openGitJobsOf(projectId, instance = MAIN) {
  const pid = String(projectId ?? "");
  if (instance === null) {
    let n = 0;
    for (const [k, v] of perProject) if (k === pid || k.startsWith(`${pid}/`)) n += v;
    return n;
  }
  return perProject.get(keyOf(pid, String(instance || MAIN))) || 0;
}
/** A follow-up step of a job (e.g. removing a leftover in the backend) counts until it is finished. → the same value. */
export function withOpen(p) {
  const end = Promise.resolve(p).then(() => {}, () => {});
  open.add(end);
  end.finally(() => open.delete(end));
  return p;
}
/** How many jobs are open right now (test seam). */
export const openGitJobsCount = () => open.size;

// ── git in the container ───────────────────────────────────────────────────────────────────────────────────────────
async function gitIn(inst, cwd, args) {
  let r;
  try { r = await gitRun(inst, cwd, args, { timeout: TEARDOWN_DEADLINE_MS }); } catch (e) {
    return { ok: false, out: "", err: String(e?.message || e), stands: false };
  }
  // A pause (not held by cbase itself, otherwise the barrier would have waited) waits like a stopped container.
  return { ok: r.code === 0, out: String(r.stdout || ""), err: String(r.stderr || "").trim(), stands: containerStands(r) || containerPaused(r) };
}

// Another command in the container (steps 2 and 4, see header) — without a working folder, the same result form.
async function commandIn(inst, cmd, args) {
  let r;
  try { r = await commandRun(inst, undefined, cmd, args, { timeout: TEARDOWN_DEADLINE_MS }); } catch (e) {
    return { ok: false, err: String(e?.message || e), stands: false };
  }
  return { ok: r.code === 0, err: String(r.stderr || "").trim(), stands: containerStands(r) || containerPaused(r) };
}
// Step 2 in the container: only what is a symlink there falls (`rm -f` removes the link, never its target).
export const LINKS_RESOLVE = 'rc=0; for p in "$@"; do if [ -L "$p" ]; then rm -f -- "$p" || rc=1; fi; done; exit $rc';

/** The connection of a subagent core (providers/agent-runtime.js) — see header. */
export function gitInProject(inst) {
  return {
    run: async (args, cwd) => {
      const r = await gitIn(inst, cwd, args);
      return { ...r, out: r.out.trim() };
    },
    teardown: (job) => worktreeTeardown(inst, job),
    lfs: (dir) => lfsInWorktree(inst, dir), // see lfsInWorktree
  };
}

/**
 * The LFS files of a freshly created worktree in the project container — `git worktree add` leaves pointers there
 * (image default GIT_LFS_SKIP_SMUDGE=1) although the objects mostly lie locally (the worktrees share
 * `.git/lfs/objects`). runtime/git-run.js lfsFetch asks `ls-files` first (a repo without an LFS file: nothing
 * happens); if an object is missing, the pull fetches it with the accesses of the repo's hosts (networkHosts, per
 * host — store.gitAccessesFor from the project's workspace). Callers: a subagent's worktree
 * (providers/agent-runtime.js) and a graph workflow's (workflows/worktree.js). NEVER THROWS: a worktree with
 * pointers is the previous state — the reason is in the log and in the result `{ ok, fetched, error? }`; a container
 * without git-lfs is only an error if the repo carries LFS files (lfsFetch `withoutLfs`).
 */
export async function lfsInWorktree(inst, dir) {
  try {
    // Without a project row (or without the data layer) without access — fetched anyway (the objects mostly lie locally).
    let ws = null;
    try { ws = store.getProject(inst.projectId)?.workspaceId || null; } catch { ws = null; }
    const hosts = await networkHosts(inst, dir, { lfs: true });
    let accesses = [];
    try { accesses = ws ? store.gitAccessesFor(ws, hosts) : []; } catch { accesses = []; }
    const env = accessAsEnvironment(accesses);
    const r = await lfsFetch(inst, dir, { env });
    if (r.ok) return { ok: true, fetched: Boolean(r.fetched) };
    const row = r.withoutLfs ? "git-lfs is missing in the project container" : String(r.stderr || "").trim().split("\n").filter(Boolean).pop() || `Exit ${r.code}`;
    console.warn(`[git] LFS in the worktree ${dir}: ${row.slice(0, 300)} — the LFS files stay pointers`);
    return { ok: false, fetched: false, error: row.slice(0, 300) };
  } catch (e) {
    console.warn(`[git] LFS in the worktree ${dir}: ${String(e?.message || e).slice(0, 300)} — the LFS files stay pointers`);
    return { ok: false, fetched: false, error: String(e?.message || e).slice(0, 300) };
  }
}

// The rows of `status --porcelain -z` as paths (relative to the worktree root); for renames both count.
function porcelainPaths(out) {
  const parts = String(out || "").split("\0");
  const paths = [];
  for (let i = 0; i < parts.length; i++) {
    const z = parts[i];
    if (!z) continue;
    paths.push(z.slice(3));
    if (z[0] === "R" || z[0] === "C") { paths.push(parts[i + 1] || ""); i++; }
  }
  return paths.filter(Boolean);
}

const list = (a) => (Array.isArray(a) ? a : []);
const result = (x) => ({ removed: false, changed: false, postWork: false, error: [], ...x });

// ── The post-work ──────────────────────────────────────────────────────────────────────────────────────────────────
// → null if entered; otherwise the reason (the worktree stays until someone clears it away).
function postWorkEnter(inst, job) {
  const projectId = inst.projectId;
  const instance = instanceOf(inst);
  let file = "(unknown)";
  try {
    file = postWorkFile(projectId, instance);
    // What would be dismissed on execution is not entered in the first place (see header).
    const f = jobError(projectId, job, instance);
    if (f) throw new Error(`job outside the instance's worktree root: ${f}`);
    const row = { v: 1, id: job.id || crypto.randomUUID(), time: Date.now(), ...job };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
    console.warn(`[git-post-work] project container of ${keyOf(projectId, instance)} is stopped — ${job.who || "worktree"} ${list(job.worktrees).map((w) => w.dir).join(", ")} stays until the next start (${file})`);
    return null;
  } catch (e) {
    const reason = `${file} not written (${e?.message || e}) — the worktree stays until someone clears it away`;
    console.error(`[git-post-work] ${reason}`);
    return reason;
  }
}

// The teardown itself (only within a project's chain). `enter`: if the container is stopped, the job goes into the
// file. `limit` (only for post-work rows): before every step the path is checked once more (see header).
async function teardownNow(inst, a, { enter = true, limit = null } = {}) {
  const error = [];
  const g = (cwd, args) => gitIn(inst, cwd, args);
  const stands = () => {
    if (!enter) return result({ postWork: true, error });
    const reason = postWorkEnter(inst, a);
    return result({ postWork: !reason, error: reason ? [...error, reason] : error });
  };
  const copy = instanceOf(inst) !== MAIN;
  const worktrees = list(a.worktrees).filter((w) => w && typeof w.dir === "string" && w.dir);
  const own = new Set(list(a.own).map((p) => path.resolve(String(p))));
  // 1. Check — never remove unchecked.
  for (const w of worktrees) {
    if (!fs.existsSync(w.dir)) continue;
    const st = await g(w.dir, ["status", "--porcelain", "-z", ...(a.allUnversioned ? ["--untracked-files=all"] : [])]);
    if (st.stands) return stands();
    if (!st.ok) return result({ changed: true, error: [`status ${w.dir}: ${st.err}`] });
    if (porcelainPaths(st.out).some((p) => !own.has(path.resolve(w.dir, p.replace(/\/$/, ""))))) return result({ changed: true });
    if (w.base) {
      const ahead = await g(w.dir, ["rev-list", "--count", `${w.base}..HEAD`]);
      if (ahead.stands) return stands();
      if (!ahead.ok || Number(ahead.out.trim()) > 0) return result({ changed: true, error: ahead.ok ? [] : [`rev-list ${w.dir}: ${ahead.err}`] });
    }
  }
  // 2. Resolve the own links — in the project container (see header); the check of a post-work row before that, in the backend.
  const resolve = [];
  for (const p of list(a.links)) {
    const f = limit ? pathError(limit, p, "link") : null;
    if (f) { error.push(`link not resolved — ${f}`); continue; }
    if (typeof p === "string" && p) resolve.push(p);
  }
  if (resolve.length) {
    const r = await commandIn(inst, "sh", ["-c", LINKS_RESOLVE, "sh", ...resolve]);
    if (r.stands) return stands();
    if (!r.ok) error.push(`links not resolved (${resolve.join(", ")}): ${r.err}`);
  }
  // 3. Unregister, remove, branch.
  for (const w of worktrees) {
    // A copy's repo lies in the clone, which the backend does not see: whether it is there the container says. The main via the file system.
    if (w.repo && copy) {
      const existing = await g(w.repo, ["rev-parse", "--git-dir"]);
      if (existing.stands) return stands();
      if (!existing.ok) { error.push(`repo ${w.repo} is missing in ${instanceOf(inst)}`); continue; }
    } else if (!w.repo || !fs.existsSync(w.repo)) { error.push(`repo ${w.repo || "(unknown)"} is missing`); continue; }
    const wasPresent = fs.existsSync(w.dir);
    if (wasPresent) {
      const rm = await g(w.repo, ["worktree", "remove", "--force", w.dir]);
      if (rm.stands) return stands();
      if (!rm.ok) error.push(`worktree remove ${w.dir}: ${rm.err}`);
    }
    const pr = await g(w.repo, ["worktree", "prune"]);
    if (pr.stands) return stands();
    if (!w.branch || !w.deleteBranch) continue;
    if (!wasPresent) {
      // The folder was already gone: whether the branch carries work only it can say. Without a base it stays.
      if (!w.base) continue;
      const existing = await g(w.repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${w.branch}`]);
      if (existing.stands) return stands();
      if (!existing.ok) continue; // no branch any more
      const ahead = await g(w.repo, ["rev-list", "--count", `${w.base}..refs/heads/${w.branch}`]);
      if (ahead.stands) return stands();
      if (!ahead.ok || Number(ahead.out.trim()) > 0) continue;
    }
    const br = await g(w.repo, ["branch", "-D", w.branch]);
    if (br.stands) return stands();
    if (!br.ok) error.push(`branch -D ${w.branch} in ${w.repo}: ${br.err}`);
  }
  // 4. The run folder.
  if (a.folder) {
    const f = limit ? pathError(limit, a.folder, "folder") : null;
    if (f) error.push(`folder not removed — ${f}`);
    else {
      const r = await commandIn(inst, "rm", ["-rf", "--", a.folder]); // in the project container (see header)
      if (r.stands) return stands();
      if (!r.ok) error.push(`${a.folder}: ${r.err}`);
    }
  }
  const removed = worktrees.every((w) => !fs.existsSync(w.dir)) && (!a.folder || !fs.existsSync(a.folder));
  return result({ removed, error });
}

/** A teardown job in the instance's project container — see header. Never throws. */
export function worktreeTeardown(inst, job = {}) {
  if (!inst?.projectId) return Promise.resolve(result({ error: ["worktreeTeardown: no instance — no git in the backend"] }));
  return queued(keyOf(inst.projectId, instanceOf(inst)), () => teardownNow(inst, job))
    .catch((e) => result({ error: [String(e?.message || e)] }));
}

/** A project's post-work in the container — see header. Never throws. */
export function gitPostWork(inst) {
  const empty = { read: 0, removed: 0, changed: 0, again: 0, dismissed: 0, error: [] };
  if (!inst?.projectId) return Promise.resolve(empty);
  const instance = instanceOf(inst);
  return queued(keyOf(inst.projectId, instance), async () => {
    const out = { ...empty, error: [] };
    let file;
    let limit;
    try { file = postWorkFile(inst.projectId, instance); limit = limitFor(inst.projectId, instance); } catch (e) { out.error.push(String(e?.message || e)); return out; }
    const running = `${file}.running`;
    // Takeover, synchronous: what is entered from here on is in a new file.
    try {
      if (fs.existsSync(file)) {
        if (fs.existsSync(running)) { fs.appendFileSync(running, fs.readFileSync(file)); fs.rmSync(file, { force: true }); }
        else fs.renameSync(file, running);
      }
    } catch (e) { out.error.push(`${file}: ${e?.message || e}`); return out; }
    let text = "";
    try { text = fs.readFileSync(running, "utf8"); } catch (e) { if (e?.code !== "ENOENT") out.error.push(`${running}: ${e?.message || e}`); return out; }
    for (const raw of text.split("\n")) {
      if (!raw.trim()) continue;
      let job;
      try { job = JSON.parse(raw); } catch { out.error.push(`unreadable row in ${file}: ${raw.slice(0, 80)}`); continue; }
      out.read += 1;
      // A row that reaches outside the project's worktree root does not run at all — no git, no step in the backend.
      const f = jobError(inst.projectId, job, instance);
      if (f) { out.dismissed += 1; out.error.push(`row dismissed (${job?.who || "?"}): ${f}`); continue; }
      const r = await teardownNow(inst, job, { limit }).catch((e) => result({ error: [String(e?.message || e)] }));
      if (r.removed) out.removed += 1;
      if (r.changed) {
        out.changed += 1;
        console.warn(`[git-post-work] ${job.who || "worktree"} with changes stays: ${list(job.worktrees).map((w) => w.dir).join(", ")}`);
      }
      if (r.postWork) out.again += 1;
      out.error.push(...r.error);
    }
    try { fs.rmSync(running, { force: true }); } catch (e) { out.error.push(`${running}: ${e?.message || e}`); }
    if (out.error.length) console.error(`[git-post-work] ${keyOf(inst.projectId, instance)}: ${out.error.join(" · ")}`);
    return out;
  }).catch((e) => ({ ...empty, error: [String(e?.message || e)] }));
}
