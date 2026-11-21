// The delete preview of a copy. What the delete dialog shows BEFORE the clearing away: per repo, what would land as
// `copy/<name>/…` in the main instance, and which chats work in the copy. The clearing away always backs up everything —
// the preview is pure information.
//
// copyStatus(copy) → `{ loaded: true, repos, chats }` | `{ loaded: false, error }`   (GET …/stack-copies/:name/stand)
//   repos  per code repo of the copy (the snapshot, without the project repo — the clearing away merges that itself)
//          and per NEW repo of the copy a row `{ rel, name, branch, detached, commits, open, openCount, fresh }`:
//            branch     the checked-out branch in the copy (detached: the short id, `detached: true`)
//            commits    the commits the fetch would bring to `copy/<name>/…` — reachable from the fetch jobs (fetch.js
//                       jobsFor: new and moved branches, detached HEAD, stashes, reflog tips, tags, notes), not from
//                       what the main instance already had at the freeze (`git rev-list --count … --not …` IN the
//                       copy); a new repo brings all its commits (`--all`)
//            open       the open files (`git status`, like the repo row of the instance actions; cap OPEN_CAP, the
//                       number in `openCount`) — they land as a backup of the open work (WIP) in the main instance
//            fresh      a repo the main instance does not have (the search IN the copy and the embedded ones from
//                       `ls-files --others`, like fetch.js newRepos — WITHOUT the upper layer of the return-path helper:
//                       a repo only it shows is missing here; the clearing away finds it anyway)
//   chats  `[{ id, title, running }]` — the chats that work in the copy (`chats.instance`, store.chatsInInstance), plus
//          every chat whose work runs there (projectbox/idle.js instanceWork — a pinned turn after a switch);
//          `running` from the same work lock as the DELETE.
// Reading happens IN the running copy (fetch.js copyContext `run`: runtime/git-run.js commandRun with its instance row,
// as agent — never git in the user container), read-only and without occupancy (a fetch next to it only writes refs
// under refs/cbase/ and WIP commits). If any part fails, the whole answer is `loaded: false` with the reason — never
// an empty list that would look like "nothing to back up" (empty is not unknown).
//
// Guard: server/backend/test/stacks-status.test.js.
import path from "node:path";
import * as store from "../store.js";
import { T } from "../i18n.js";
import { copyInstance } from "../projectbox/creation.js";
import { OPEN_CAP, openFrom } from "../projectbox/instance-actions.js";
import { instanceWork } from "../projectbox/idle.js";
import { searchProject } from "../projectbox/projectRepo.js";
import { jobsFor, copyContext, statusOfTheCopy } from "./fetch.js";

const HEX = /^([0-9a-f]{40}|[0-9a-f]{64})$/;
const last = (s) => String(s || "").trim().split("\n").slice(-2).join(" | ").slice(0, 400);
const full = (partRel, x) => (partRel === "." ? x : `${partRel}/${x}`);

// A git call IN the copy that throws on exit ≠ 0.
async function git(k, rel, args, what) {
  const r = await k.run(k.pathOf(rel), "git", args, { what });
  if (r.code !== 0) throw new Error(T`${rel}: ${what} not readable in the copy (exit ${r.code ?? r.signal}): ${last(r.stderr)}`);
  return String(r.stdout || "");
}

async function openOf(k, rel) {
  const all = openFrom(await git(k, rel, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], T("the status")));
  return { open: all.slice(0, OPEN_CAP).map((o) => o.path), openCount: all.length };
}

const nameOf = (k, rel) => (rel === "." ? path.basename(k.projectPath) : path.basename(rel));

// The row of a code repo of the snapshot.
async function knownRepo(k, repo, state) {
  const jobs = jobsFor(k, repo, state);
  const oids = [...new Set(jobs.map((a) => a.oid).filter((o) => HEX.test(String(o))))];
  let commits = 0;
  if (oids.length) {
    // What the main instance already had at the freeze: its refs and the copy's start point — only ids, never a name.
    const already = [...new Set([...(repo.refs || []).map((r) => r.oid), k.start.get(repo.part)].filter((o) => HEX.test(String(o || ""))))];
    const out = await git(k, repo.rel, ["rev-list", "--count", "--ignore-missing", ...oids, "--not", ...already], T("the number of commits"));
    commits = Number(out.trim()) || 0;
  }
  const detached = !state.symref;
  const branch = state.symref ? state.symref.replace(/^refs\/heads\//, "") : (state.head || "").slice(0, 12);
  return { rel: repo.rel, name: nameOf(k, repo.rel), branch, detached, commits, ...(await openOf(k, repo.rel)), fresh: false };
}

// The row of a NEW repo of the copy (the main instance does not have it): it comes along whole — all commits, everything open.
async function newRepo(k, rel) {
  const branchValue = await k.run(k.pathOf(rel), "git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { what: T("the branch") });
  const detached = branchValue.code !== 0;
  let branch = detached ? "" : String(branchValue.stdout || "").trim();
  if (detached) {
    const short = await k.run(k.pathOf(rel), "git", ["rev-parse", "--short", "HEAD"], { what: T("the head") });
    branch = short.code === 0 ? String(short.stdout || "").trim() : "";
  }
  const commits = Number((await git(k, rel, ["rev-list", "--count", "--all"], T("the number of commits"))).trim()) || 0;
  return { rel, name: nameOf(k, rel), branch, detached, commits, ...(await openOf(k, rel)), fresh: true };
}

// The new repos (head: like fetch.js newRepos, without the upper layer of the return-path helper).
async function newReposTheCopy(k, statuses) {
  const known = new Set(k.snapshot.repos.map((r) => r.rel));
  const named = new Set((k.snapshot.notLinked || []).map((n) => n.rel));
  const fresh = new Set();
  const search = await searchProject(k.projectPath, { instance: k.inst() });
  for (const rel of search.repos || []) if (rel !== "." && !known.has(rel) && !named.has(rel)) fresh.add(rel);
  for (const repo of k.snapshot.repos) {
    for (const x of statuses.get(repo.part)?.embedded || []) {
      const rel = full(repo.rel, x);
      if (!known.has(rel) && !named.has(rel)) fresh.add(rel);
    }
  }
  return [...fresh].sort();
}

// The chats of the copy (head).
function chatsTheCopy(copy) {
  const instance = copyInstance(copy.name);
  const work = instanceWork(copy.projectId, instance);
  const running = new Set(work.chats.map((c) => c.id));
  const ids = [...new Set([...store.chatsInInstance(copy.projectId, instance), ...running])];
  return ids.map((id) => ({ id, title: String(store.getChat(id)?.title || ""), running: running.has(id) }));
}

/** The delete preview (head). Never throws for read errors — they are in the answer. */
export async function copyStatus(copy) {
  let chats;
  try { chats = chatsTheCopy(copy); }
  catch (e) { return { loaded: false, error: String(e?.message || e) }; }
  try {
    const k = copyContext(copy);
    const code = k.snapshot.repos.filter((r) => !r.projectRepo);
    const statuses = new Map();
    const repos = [];
    for (const repo of code) {
      const state = await statusOfTheCopy(k, repo);
      statuses.set(repo.part, state);
      repos.push(await knownRepo(k, repo, state));
    }
    for (const rel of await newReposTheCopy(k, statuses)) repos.push(await newRepo(k, rel));
    return { loaded: true, repos, chats };
  } catch (e) {
    return { loaded: false, error: String(e?.message || e), chats };
  }
}
