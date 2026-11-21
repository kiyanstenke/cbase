// codeRoute: the code view of a root directory (files, git, search, language service) — stays a function with a
// true|false return. The ONLY implementation, with two callers: tailWorkspaceRoutes in workspaces/routes.js (root =
// workspace path) and devtools/routes.js:codeProjectRoutes (root = project path; turns true|false into the contract of
// the route function). What both levels share is measured by server/backend/test/code-scopes.test.js.

import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { gitApply, gitBlame, gitCheckout, gitCherryPick, gitCommit, gitDiff, gitDiscard, gitFetch, gitIgnored, gitLog, gitMerge, gitMergeAbort, gitPull, gitPush, gitRebase, gitShow, gitStage, gitStageBlock, gitStashList, gitStashOp, gitStashPush, gitStashShow, gitSubmoduleStatus, gitSubmoduleUpdate, gitUnstage, gitWorktreeAdd, gitWorktreeList, gitWorktreeRemove, gitTimeAxis, listBranches, readGitTree } from "../git.js";
import { copyEntry, createEntry, deleteEntry, listDir, quickOpenFiles, readFile as readProjectFile, renameEntry, resolveInside, searchFiles, uploadFiles, writeFile as writeProjectFile } from "../files.js";
import { abortOf, lspEditorResponse } from "../lsp/routes.js";
import { createTerminal } from "../terminal.js";
import { terminalFolder } from "./terminal-folder.js";
import { debugLaunch } from "../debug.js";
import * as store from "../store.js";
import { T } from "../i18n.js";
import { gitAuthCtx, gitErrPayload, wsForCode } from "../workspaces/git-auth.js";
import { BODY_MAX, dispositionHeader, readBody, readBodyOrEmpty, readRawBody, send, serveDownload } from "../runtime/http.js";
// The file routes of a COPY go through its container (files-in-copy.js), never through the backend (= main).
import * as filesCopy from "../files-in-copy.js";
import { baseDeviation, baseFromBody, imageMime, contentSha, readingOrMissing, withSha } from "../files.js";
import { instanceForProject, instanceIsCopy } from "../runs/instance.js";
import { startLock } from "../runs/project-lock.js";
import { CONTAINER_PAUSED, CONTAINER_STANDS } from "../runtime/git-run.js";
import { areaOfTheInstance } from "../runs/runtime-limit.js";
import { realPath, inArea } from "../runtime/real-path.js";

// ── What codeRoute answers ──────────────────────────────────────────────────────────────────────
// ONE list of the prefixes of all branches below: devtools/routes.js codeProjectRoutes computes the target instance
// (targetInstance — it reads the instance rows and can throw) only for these paths and passes every other `sub` on at
// once (NEXT). Otherwise a route of a later family (`/context/…`) would answer 409 while the instance is not readable.
// Guards: server/backend/test/code-scopes.test.js (every branch lies under a prefix), projectbox-git.test.js (the path).
export const CODE_ROUTE_PREFIXES = Object.freeze(["/git", "/files", "/upload", "/terminal", "/debug", "/lsp"]);
/** The hits of `POST …/files/find` (⌘P, code tabs in the chat) — the finder shows no more; `truncated` says there were
 *  more. The number is VS Code's (`AnythingQuickAccessProvider.MAX_RESULTS`). */
export const FIND_CAP = 512;
export const liesUnderCodeRoute = (sub) => typeof sub === "string" && CODE_ROUTE_PREFIXES.some((p) => sub === p || sub.startsWith(`${p}/`));
/** The fields of `POST …/files/search` — ONE reading for main and copy (including "whole word", include/exclude as
 *  globs). `exclusions` = "use exclude settings and ignore files" (VS Code default on); if it is missing the default
 *  applies — unless an old client (iOS) sends `includeHeavy: true` (which meant "search everything" there). `open`: at
 *  most 200 paths of unsaved buffers, strings only. */
export const searchFields = (b) => ({
  query: b.query, regex: !!b.regex, caseSensitive: !!b.caseSensitive, wholeWord: !!b.wholeWord,
  exclusions: typeof b.exclusions === "boolean" ? b.exclusions : !b.includeHeavy,
  include: typeof b.include === "string" ? b.include.slice(0, 2000) : "", exclude: typeof b.exclude === "string" ? b.exclude.slice(0, 2000) : "",
  open: Array.isArray(b.open) ? b.open.filter((x) => typeof x === "string" && x.length <= 4096).slice(0, 200) : [],
});

// ── A copy that is not ready ──────────────────────────────────────────────────────────────────────────────────────────
// What a COPY whose instance row is not `ready` (`opts.writeLock`, devtools/routes.js writeLockCopy) still answers —
// `<method> <sub>`: tree, read, download, search and the reading git paths. EVERY other path under /files, /upload and
// /git writes or can write and answers 409 COPY_NOT_READY — closed where not explicitly reading: a new path is locked
// until it is listed here. /git/creds is not part of it (the accesses lie in the backend, not in the copy). Guard:
// server/backend/test/files-in-copy.test.js runs every branch of this file under the three prefixes against a copy that
// is being cleared away.
export const COPY_READING = Object.freeze([
  "GET /files/tree", "GET /files/read", "GET /files/download", "POST /files/search", "POST /files/find",
  "GET /git", "GET /git/branches", "POST /git/diff", "GET /git/stashes", "POST /git/stash/show", "POST /git/blame", "POST /git/log",
  "POST /git/show", "GET /git/worktrees", "GET /git/submodules", "GET /git/ignored",
]);
const underPrefix = (sub, p) => sub === p || sub.startsWith(`${p}/`);
/** Is `<m> <sub>` a path that a copy that is not ready rejects? (See the header of this section.) */
export const copyWritePath = (m, sub) => typeof sub === "string"
  && (underPrefix(sub, "/files") || underPrefix(sub, "/upload") || (underPrefix(sub, "/git") && !underPrefix(sub, "/git/creds")))
  && !COPY_READING.includes(`${m} ${sub}`);
// Exported for the agents' language service (devtools/routes.js `/api/lsp` in a copy): the same response.
export function copyNotReady({ identifier, state }) {
  const name = String(identifier).slice(String(identifier).lastIndexOf("/") + 1).replace(/^copy-/, "");
  const text = state === "clearAway"
    ? T`The copy ${name} is being removed — nothing is written into it anymore (files, git): anything now would miss its backup. Reading still works.`
    : T`The copy ${name} is not ready right now (${state ?? "unknown"}) — nothing is written into it (files, git) until it is ready. Reading works.`;
  return { code: "COPY_NOT_READY", identifier, state, error: text };
}

// ── The setup of a new project ────────────────────────────────────────────────────────────────────────────────────────
// Three hooks, set ONLY in ops mode (devtools/routes.js for the project level, workspaces/routes.js for the workspace
// level) — without them every path here is unchanged. The rules are stated at the callers; this file stays domain-free.
//   opts.uploadBegins(operation) → end()   THE UPLOAD STAMP at the START of every `/upload` request, before the body (a
//                                          3 MB chunk over a slow line takes longer than the upload idle time) — on ALL
//                                          paths, also the copy and the Code tab; `end` in the finally. `operation` is
//                                          the one from the ADDRESS (`?operation=`), else "". If it throws (unknown,
//                                          foreign, closed operation), the throw is the response (`status`, `code`).
//                                          `end.clarified()` (if present) is called by this file as soon as the body is
//                                          read and the operation thus known (see chunks).
//   opts.chunks(operation, body, { fromBody, begin }) → { written }   the chunks of a request WITH an operation
//                                          (projectbox/setup/operation.js writeChunks): only into the staging, `offset`
//                                          per chunk. Only the project level sets it. The operation is in the ADDRESS or
//                                          in the BODY (web and iOS send `{ operation, files }` in the body). On the
//                                          project level the body of `POST /upload` is therefore read ONCE and made
//                                          readable again for the ordinary path; until then the request counts as
//                                          "unresolved" (runtime/upload-stamp.js — finishing an operation of this
//                                          project answers UPLOAD_RUNNING for that long). An operation ONLY in the body
//                                          is stamped with `fromBody: true` (the caller checks it like the one from the
//                                          address, `begin` is the start of the request). Address and body differ ⇒ 400
//                                          OPERATION_LOCATION. Without an operation `/upload` stays the ordinary path.
//                                          The workspace level does not set `chunks`: there an operation in address OR
//                                          body is 400 OPERATION_LOCATION (a chunk for the staging would otherwise land
//                                          at the target).
//   opts.setupLock(paths?) → { projectId, name } | null   THE WRITE LOCK `SETUP_RUNNING`: while a server step of the
//                                          setup runs, every write path (copyWritePath: /files/write|create|rename,
//                                          DELETE /files, /upload without an operation, writing /git; the editor's
//                                          language service writes nothing — `/lsp/rename` gives the edit to the client)
//                                          answers 409 — before any effect. Project level: without paths (everything
//                                          lies in the project). Workspace level (`opts.setupPerPath`): asked with the
//                                          absolute paths of the request (pathsTheRequest) — a path in the project OR a
//                                          parent folder of the project hits it.
//                                          TIMING: the body is read ONCE on BOTH levels BEFORE asking, and made readable
//                                          again for the branches — reading it then completes without I/O
//                                          (Readable.from: data and end before any I/O callback), the file paths write
//                                          synchronously afterwards: between question and effect no server step can
//                                          begin. Asking BEFORE reading would let a request whose body was still on its
//                                          way write into a step that began meanwhile. The git actions additionally ask
//                                          the lock in their situation (`g.situation`, ../git.js BEFORE the first docker
//                                          call) — they then answer 409 SETUP_RUNNING via `failed`.
//                                          PATHS: computed like the paths that write — files.js resolveInside (leading
//                                          "/" and "\" drop), `uploadFiles` (`\` → `/` in the file path), a worktree
//                                          path relative to the repo AND to every folder above it up to the root (git
//                                          interprets it relative to the repo root, which can lie above the given folder).
// The same lock for a running layout (`code: "LAYOUT_RUNNING"` from the lock — status.js layoutWriteLock), with its own
// wording: the folder is being rebuilt. Exported for the fetch of the Git overview (gitView/fetch.js): the same
// response, no copy.
export function setupRunningResponse({ projectId, name, code }) {
  if (code === "LAYOUT_RUNNING") {
    const g = T`The structure of the project${name ? T` "${name}"` : ""} is being rebuilt — nothing is written into it (files, git) until it has finished. Reading works.`;
    return { code: "LAYOUT_RUNNING", projectId, error: g };
  }
  const text = T`The project${name ? T` "${name}"` : ""} is being set up — nothing is written into it (files, git) until the step has finished. Reading works.`;
  return { code: "SETUP_RUNNING", projectId, error: text };
}
// The absolute paths a write path touches (workspace level). A body that cannot be read and a path-less route count as
// the root itself — a parent folder of every project below (rather locked than missed). Computed like the paths that
// write (see header); a path resolveInside rejects never writes — it counts as the root as well.
function pathsTheRequest(root, sub, url, raw) {
  const rootDir = path.resolve(root);
  let b = {};
  if (raw.length) { try { b = JSON.parse(raw.toString("utf8")); } catch { return [rootDir]; } }
  if (!b || typeof b !== "object") return [rootDir];
  const within = (r) => { try { return resolveInside(rootDir, typeof r === "string" ? r : ""); } catch { return rootDir; } };
  const out = [];
  if (sub === "/files/rename" || sub === "/files/copy") out.push(within(b.from), within(b.to));
  else if (sub === "/files") out.push(within(url.searchParams.get("path")));
  else if (sub.startsWith("/files/")) out.push(within(b.path));
  else if (sub === "/upload") {
    const target = within(typeof b.dir === "string" ? b.dir : "");
    const list = Array.isArray(b.files) ? b.files : [];
    if (!list.length) out.push(target);
    for (const f of list) {
      const rel = typeof f?.path === "string" ? f.path.replace(/\\/g, "/") : "";
      out.push(rel ? path.resolve(target, rel) : target);
    }
  } else if (sub.startsWith("/git")) {
    const repo = path.resolve(rootDir, typeof b.repo === "string" ? b.repo : url.searchParams.get("repo") || "");
    out.push(repo);
    const wt = typeof b.path === "string" && b.path ? b.path : url.searchParams.get("path");
    if (wt) {
      // Relative to the repo and to every folder above it up to the root (see header): git computes from the repo ROOT.
      for (let location = repo; ; location = path.dirname(location)) {
        out.push(path.resolve(location, wt));
        if (location === rootDir || location === path.dirname(location) || !location.startsWith(rootDir)) break;
      }
    }
  } else out.push(rootDir);
  return out;
}
// A body already read, readable once more for the branches (readBody/readRawBody read `data`/`end` and the headers).
const againReadable = (raw, req) => Object.assign(Readable.from(raw.length ? [raw] : []), { headers: req.headers, method: req.method, url: req.url });

// ── Management git in the project container ───────────────────────────────────────────────────
// Every git call of the code view carries the instance: fixed on the project level (`opts.instance`, devtools/routes.js),
// per repo on the workspace level (`opts.gitInstanceSource`, workspaces/routes.js: the factory
// projectbox/git-assignment.js gitInstanceForWorkspace — a repo under the folder of a converted project runs in its
// instance). The factory is asked ONLY for a /git route that calls git (it reads the instance rows) — not for
// /git/creds. Terminal and debugger of the workspace level stay in the backend: the source is NOT an `instance`. Without
// both `gitOptions` is empty and every call unchanged. With an instance it carries the situation
// (`situation: gitSituation`): every action asks it in ../git.js BEFORE its first docker call.
// With `?chat=<id>` the git view works in the instance of THIS chat (`opts.instanceForChat`, devtools/routes.js): if it
// is a copy, it reads and writes that copy's clone in the copy container — repos from the copy's snapshot (git.js
// projectRepos), the copy's situation, the copy's wakeup. Without a chat — and from a project network, where the token
// determines the instance — it stays the fixed instance of the project level. A copy that cannot be resolved throws:
// the caller reports it as `error` or 409, never as the repos of main.
function gitOptions(opts, chatId = "") {
  if (opts.instance) {
    const fromChat = chatId && typeof opts.instanceForChat === "function" ? opts.instanceForChat(String(chatId)) : null;
    return { instance: fromChat || opts.instance, situation: gitSituation };
  }
  const source = typeof opts.gitInstanceSource === "function" ? opts.gitInstanceSource() : null;
  return typeof source === "function" ? { instanceFor: source, situation: gitSituation } : {};
}

// ── The limit of the file paths ───────────────────────────────────────────────────────────────
// The file routes (/files/*, /upload) run in the backend; for a path of a converted project they get the real roots of
// its instance (project folder and runtime folder — the trusted anchors, runs/runtime-limit.js), and files.js then goes
// through runtime/real-path.js (see the header of files.js). Project level: `opts.instance` applies to every path.
// Workspace level: the factory `opts.gitInstanceSource` (projectbox/git-assignment.js gitInstanceForWorkspace), asked
// per path part FROM THE ROOT DOWNWARDS — the first part whose real location lies in the area of an instance is the
// project's folder (a mount point); the parts above belong to the backend, and nothing the project container creates
// below decides the assignment (asking the realpath of the WHOLE path would make `shop/note → ~/.bashrc` belong to no
// project). A hit only via the shared git directory (a worktree outside) does not count: the ordinary path applies there.
// → `limit(abs)` | null (without instance and without source: files.js unchanged). If the source throws ⇒ the caller
// answers with the error instead of working unchecked in the backend. The area of an instance is that of
// runs/runtime-limit.js (ONE computation; for a copy strict and locked — its project folder goes through
// files-in-copy.js anyway).
// The language service route asks the same assignment from the backend (devtools/routes.js lspTarget, `root` = "/"); the
// editor's language service (`/lsp/*` below) computes its target via lspTargetFor.
export function fileLimit(root, opts) {
  if (opts.instance) { const b = areaOfTheInstance(opts.instance); return () => b; }
  const source = typeof opts.gitInstanceSource === "function" ? opts.gitInstanceSource() : null;
  if (typeof source !== "function") return null;
  const base = path.resolve(root);
  const memo = new Map();
  const areaOf = (part) => {
    if (!memo.has(part)) {
      const inst = source(part);
      let b = inst ? areaOfTheInstance(inst) : null;
      if (b) { let e = null; try { e = realPath(part); } catch { e = null; } if (!inArea(e, b)) b = null; }
      memo.set(part, b);
    }
    return memo.get(part);
  };
  return (abs) => {
    const parts = path.relative(base, path.resolve(abs)).split(path.sep).filter(Boolean);
    if (parts[0] === "..") return null;
    let part = base;
    for (let i = 0; ; i++) {
      const b = areaOf(part);
      if (b) return b;
      if (i >= parts.length) return null;
      part = path.join(part, parts[i]);
    }
  };
}

// The situation of an instance for the git view — via the path of a turn: the same lock (runs/project-lock.js
// `startLock`, verdict of the domain side projectbox/idle.js), asked for the project of the instance. While a turn would
// have to wait there (start, create, recreate, relocation, server end, unreadable), the view reports "project is
// starting" instead of silently `{ repos: [] }`; a project container in `error` reports its error.
// The wording is the view's, not the turn's; `reason` is the state of the lock.
// Asked with the purpose "view" — the view never starts a STOPPED instance (it reports an error with
// `reason: "stopped"`); if a start is already waiting for memory, it says that instead of "project is starting".
const projectStarts = () => T("Project is starting — the Git view loads once the project container is ready.");
const waitingForStorage = () => T("Instance stopped, its start is waiting for free memory — the Git view loads once it runs.");
// Exported for the fetch of the Git overview (gitView/fetch.js): the same situation as every git action here.
export function gitSituation(inst) {
  // The lock of a COPY judges by its identifier (runs/project-lock.js); main asks only the project.
  const copy = inst.instance && inst.instance !== "main";
  const u = startLock(`git-view:${inst.projectId}`, "view", { projectId: inst.projectId, ...(copy ? { identifier: inst.identifier || `${inst.projectId}/${inst.instance}` } : {}) });
  if (!u) return null;
  if (u.kind === "error") return { error: String(u.text || ""), ...(u.reason === "stopped" ? { reason: "stopped" } : {}) };
  if (u.reason === "stopped-storage") return { starts: true, reason: "stopped-storage", notice: waitingForStorage() };
  return { starts: true, reason: String(u.reason || u.state || ""), notice: projectStarts() };
}

// Whoever can start a stopped project container (the restore) registers here — `fn(inst)`, set in server.js. Unset, the
// view reports the error of the docker CLI (visible, not empty).
let gitWakeup = null;
export function setGitWakeup(fn) { gitWakeup = typeof fn === "function" ? fn : null; }
const NOT_RUNNING = CONTAINER_STANDS; // ONE pattern (runtime/git-run.js) — the post-work of the worktrees asks the same

// A PAUSED project container ("is paused", runtime/git-run.js CONTAINER_PAUSED) is frozen, not stopped — "waits
// briefly", and NEVER woken: the wakeup would send the restore a container `docker start` does not start. A pause cbase
// holds never reaches this place (it waits at the barrier, projectbox/docker.js); what arrives here is one someone else
// holds, or a cap.
const projectFrozen = () => T("Project briefly frozen — the Git view loads once it resumes.");
const gitPausedSituation = () => ({ starts: true, reason: "frozen", notice: projectFrozen() });

// A stopped project container hit by the git view, a git action or the OKF verification: wake it and "project is
// starting" — without a wakeup or if it throws, the error of the docker CLI (visible, not empty).
// → `{ starts, reason, notice }` | `{ error }`. ONE place for all three paths. If `error` reports a pause, nothing is
// woken (see above) — the OKF verification passes a pause here as a stopped container with its wording.
export function gitStandsSituation(projectId, error, instance = "main") {
  if (CONTAINER_PAUSED.test(String(error || ""))) return gitPausedSituation();
  if (!gitWakeup) return { error };
  // A copy wakes its own restore, not main's; main calls the wakeup with the project id alone.
  try { if (instance && instance !== "main") gitWakeup(projectId, instance); else gitWakeup(projectId); } catch (e) { return { error: T`${error} — start failed: ${e?.message || e}` }; }
  return { starts: true, reason: "stopped", notice: projectStarts() };
}

// The response of a git ACTION whose instance is not ready (`err.situation` from ../git.js) or whose container is stopped
// (`err.containerStands`) — 409 with the situation of the view and `error` for the clients that only read that. Else null.
function notReady(e) {
  const situation = e?.situation || (e?.containerStands ? gitStandsSituation(e.projectId, String(e.message || e), e.instance) : e?.containerPaused ? gitPausedSituation() : null);
  if (!situation) return null;
  const { projectId, ...rest } = situation;
  return { error: String(rest.error || rest.notice || ""), ...rest };
}

// Git overview, small view: per repo `branchesRunning` and `counter` (gitView/small.js smallView) — wired in server.js,
// this file stays domain-free. Asked at EVERY place that answers a tree (GET /git and every action after it), with
// `{ root, g, projectId, workspaceId, freshRepo }` (`freshRepo` = the repo of an action that moves refs — its reading
// starts anew; stage/unstage/discard/apply/stash ask without). It never waits for a reading (see the header of
// small.js). Unset, without repos or if it throws: the tree unchanged.
let gitOverview = null;
export function setGitOverview(fn) { gitOverview = typeof fn === "function" ? fn : null; }
async function withOverview(tree, ctx) {
  if (!gitOverview || !Array.isArray(tree?.repos) || !tree.repos.length) return tree;
  try { return await gitOverview(tree, ctx); } catch (e) { console.error("[git] small view:", e?.message || e); return tree; }
}

// The response of the git view: on the project level the situation of the ONE instance is at the top of the response
// (`starts`, `notice` or `error`), on the workspace level it stays per project under `projects`. Without an instance:
// the tree unchanged.
// If git ran in a COPY (`g.instance`, the instance of the request — `?chat=` of a copy chat), the response names it at
// the top as `instance: "copy-<name>"`, in every situation (tree, starts, error). The chat rail shows "copy k1" from it
// and knows that this chat's browser runs in the copy; the name comes from the instance git just ran in — not from a
// second question. Main and the workspace level carry no such field.
const copyTheRequest = (g) => (instanceIsCopy(g?.instance) ? { instance: String(g.instance.instance) } : null);
function gitResponse(tree, opts, g = {}) {
  const copy = copyTheRequest(g);
  if (!tree.projects) return copy ? { ...tree, ...copy } : tree;
  const list = tree.projects.map((p) => {
    if (p.error && CONTAINER_PAUSED.test(p.error)) return { projectId: p.projectId, ...gitPausedSituation() };
    if (!p.error || !NOT_RUNNING.test(p.error)) return p;
    return { projectId: p.projectId, ...(p.instance ? { instance: p.instance } : {}), ...gitStandsSituation(p.projectId, p.error, p.instance) };
  });
  if (!opts.instance) return { ...tree, projects: list };
  const [p] = list;
  const { projects, ...rest } = tree;
  return p.starts ? { ...rest, starts: true, reason: p.reason, notice: p.notice, ...copy } : { ...rest, error: p.error, ...copy };
}


// ── Shared code/git/terminal/debug routes (project AND workspace) ───────────
// `root` is the folder (project or workspace path). All paths are relative to it and are
// strictly limited to `root` in files.js/git.js. Returns true if the route was handled (and
// answered) here — the caller then ends its chain.
// `opts.notFound` is the wording for a missing root (/files/tree, /terminal, /debug/launch): the project level says
// "project path not found", the workspace level "path not found". The difference is intended and therefore a
// parameter.
// `opts.workspaceId`: the workspace of the git accesses (/git/creds, askpass of push/pull/fetch/commit) — the project
// level passes `proj.workspaceId`, the workspace level `ws.id`; without it via the path (wsForCode).
// `opts.instance`: the instance of a converted project (runs/instance.js) — terminal and debugger then start in the
// project container (runtime/inProject.js); the workspace level passes none, everything stays in the backend there.
// `opts.sessionLock(inst)` / `opts.sessionTag(inst)` (project level only, devtools/routes.js): the reason why no
// terminal and no debugger may open in THIS instance right now (or null), and the tag under which idle and lock count
// and end the session of this instance (projectbox/idle.js projectTerminalTag).
// `opts.writeLock(inst)` (project level only, devtools/routes.js writeLockCopy): `{ identifier, state }` if nothing may
// be written into this COPY right now (its instance row is not `ready` — from step 0 of clearing away), else null. Then
// every path of the copy under /files, /upload and /git except the reading ones (COPY_READING, copyWritePath) answers
// 409 COPY_NOT_READY like the start of a service (projects/routes.js); reading (tree, read, download, search, diff, log,
// blame, show, the GET lists) stays open. Otherwise a copy being cleared away would accept every write (200), and what
// came after the backup of its repo would be silently deleted with the container. Main never asks the lock.
//
// The target of a file of the language service (see the header of lsp/limit.js). Project level (`opts.projectId`): the
// project of the route in its instance (`opts.instance` — main, copy or null). Workspace level: the project of the
// workspace under whose folder the file lies (the longest path), in its main — else `{ reason: "no_project" }`. `file`
// is relative to the root as with /files/*; a path that leads outside is 400. Only an instance that is not a copy gets
// the area (runs/runtime-limit.js) — in a copy the backend reads nothing from disk (lsp/limit.js readDisk).
export function lspTargetFor(root, opts, file) {
  const base = path.resolve(root);
  let abs = null;
  if (file !== null && file !== undefined) {
    abs = path.resolve(base, String(file).replace(/^[/\\]+/, ""));
    if (abs !== base && !abs.startsWith(`${base}${path.sep}`)) throw Object.assign(new Error(T("Path outside the root")), { status: 400 });
  }
  let projectId, rootDir, inst;
  if (opts.projectId) { projectId = String(opts.projectId); rootDir = base; inst = opts.instance || null; }
  else {
    const under = (p) => abs !== null && p?.path && (abs === path.resolve(p.path) || abs.startsWith(`${path.resolve(p.path)}${path.sep}`));
    const proj = (opts.workspaceId ? store.listProjects(opts.workspaceId) : []).filter(under).sort((a, b) => b.path.length - a.path.length)[0];
    if (!proj) return { reason: "no_project", base };
    projectId = String(proj.id); rootDir = path.resolve(proj.path); inst = instanceForProject(proj.id);
  }
  let area = null;
  if (inst && !instanceIsCopy(inst)) {
    try { area = areaOfTheInstance(inst); }
    catch (e) { throw Object.assign(new Error(T`The instance's area cannot be determined (${e?.message || e})`), { status: 409 }); }
  }
  return { projectId, instance: inst, root: rootDir, base, ...(area ? { area } : {}), ...(abs !== null ? { abs } : {}) };
}

async function codeRoute(root, sub, m, req, res, url, opts = {}) {
  // The upload stamp at the START of the request (header "The setup of a new project").
  if (sub === "/upload" && m === "POST" && typeof opts.uploadBegins === "function") {
    const begin = Date.now();
    let end;
    try { end = opts.uploadBegins(url.searchParams.get("operation") || ""); }
    catch (e) { const text = String(e?.message || e); send(res, Number(e?.status) || 409, { ...(e?.code ? { code: e.code } : {}), error: text }); return true; }
    try { return await codeRouteInBody(root, sub, m, req, res, url, opts, { end, begin }); } finally { end(); }
  }
  return codeRouteInBody(root, sub, m, req, res, url, opts);
}

async function codeRouteInBody(root, sub, m, req, res, url, opts, stamp = null) {
  let handled = false;
  const done = (code, obj) => { handled = true; send(res, code, obj); return true; };
  // The instance of git (see above) and the fresh tree after an action — with an instance including the situation. The
  // factory is asked only by a route that calls git (not /git/creds), and its throw (instances not readable) is a
  // response, not a 500: the view names it as `error`, an action answers 409 with it.
  let g = {};
  let gError = null;
  if (sub.startsWith("/git") && !sub.startsWith("/git/creds")) { try { g = gitOptions(opts, url.searchParams.get("chat")); } catch (e) { gError = String(e?.message || e); } }
  const withSource = gError !== null || Object.keys(g).length > 0;
  // `actionRepo` = the repo of an action that just ran and moves refs (`b.repo`) — the small view starts its reading
  // anew (withOverview); stage/unstage/discard/apply/stash call `tree()`.
  const tree = async (actionRepo = null) => withOverview(gitResponse(await readGitTree(root, { ...g, situation: gitSituation }), opts, g),
    { root, g, projectId: opts.projectId ?? null, workspaceId: opts.workspaceId ?? null, freshRepo: actionRepo === null ? null : String(actionRepo || "") });
  const notFound = () => opts.notFound || T("Path not found");
  // The error path of every git action: not ready or stopped ⇒ 409 (see notReady), else the ordinary 400.
  const failed = (e, otherwise) => {
    // The write lock of the setup, asked in the situation of the action (see below) — the same response as before the body.
    if (e?.situation?.setupLock) return done(409, setupRunningResponse(e.situation.setupLock));
    const nb = notReady(e); return nb ? done(409, nb) : done(400, otherwise ?? { error: String(e.message || e) });
  };
  // The response under a lock (terminal, debugger) — `what` is "a terminal" or "a debugger".
  const locked = (reason, what) => ({ code: "LOCKED", reason, error: T`The project is locked right now (${reason}) — ${what} can be opened afterwards.` });

  // Git tree + branches (reading, fail-safe). With an instance source a throw is NOT "no repo" (empty is not unknown):
  // `{ repos: [], error }` — web and iOS show `error`. Without a source `{ repos: [] }`.
  if (sub === "/git" && m === "GET") {
    if (gError !== null) return done(200, { repos: [], error: gError });
    try { return done(200, await tree()); } catch (e) { return done(200, withSource ? { repos: [], error: String(e?.message || e), ...copyTheRequest(g) } : { repos: [] }); }
  }
  if (gError !== null && sub.startsWith("/git/") && !sub.startsWith("/git/creds")) return done(409, { error: gError });
  // A copy that is not ready accepts no write path (header of COPY_READING) — before reading the body and before any
  // access. The instance is the one the path would work in: git that of its chat (gitOptions), files that of the route.
  if (typeof opts.writeLock === "function" && copyWritePath(m, sub)) {
    const inst = underPrefix(sub, "/git") ? g.instance : opts.instance;
    const s = instanceIsCopy(inst) ? opts.writeLock(inst) : null;
    if (s) return done(409, copyNotReady(s));
  }
  // Chunks WITH an operation go only into the staging (opts.chunks) — before the write lock of the setup, and an
  // operation that is not in the upload state answers itself (OPERATION_CLOSED). The operation is in the address OR in
  // the body (see header): the body is read ONCE here; without an operation it goes on, readable again, to the ordinary
  // path. A body that is not JSON carries no operation — the ordinary path answers it (400 "invalid json").
  if (sub === "/upload" && m === "POST" && typeof opts.chunks === "function") {
    const raw = await readRawBody(req);
    let b = null; try { b = JSON.parse(raw.toString("utf8")); } catch { b = null; }
    const fromAddress = url.searchParams.get("operation") || "";
    const inBody = b && typeof b === "object" && !Array.isArray(b) && Object.hasOwn(b, "operation") ? b.operation : undefined;
    let success;
    try {
      if (fromAddress && inBody !== undefined && inBody !== fromAddress) {
        const text = T("“operation” differs between the address and the body — nothing written.");
        return done(400, { code: "OPERATION_LOCATION", error: text });
      }
      const operation = fromAddress || (inBody !== undefined ? (typeof inBody === "string" ? inBody : "") : null);
      if (operation !== null) {
        const fromBody = !fromAddress;
        success = opts.chunks(operation, { dir: typeof b?.dir === "string" ? b.dir : "", files: b?.files }, { fromBody, begin: stamp?.begin ?? Date.now() });
      }
    } catch (e) {
      const fields = Object.fromEntries(["path", "size", "written"].filter((k) => e?.[k] !== undefined).map((k) => [k, e[k]]));
      return done(Number(e?.status) || 400, { ...(typeof e?.code === "string" ? { code: e.code } : {}), error: String(e?.message || e), ...fields });
    } finally { stamp?.end?.clarified?.(); }
    if (success !== undefined) return done(200, success);
    req = againReadable(raw, req);
  }
  // The write lock of the setup (see header). FIRST the body, THEN the question — on both levels, whether one runs or
  // not; from here to the effect of a file path no more I/O (header "TIMING"). The git actions ask it once more in
  // their situation, before their first docker call.
  if (typeof opts.setupLock === "function" && copyWritePath(m, sub)) {
    let raw;
    try { raw = await readRawBody(req, sub === "/upload" ? undefined : BODY_MAX); }
    catch (e) { return done(Number(e?.status) || 400, { error: String(e?.message || e) }); }
    req = againReadable(raw, req);
    const paths = opts.setupPerPath ? pathsTheRequest(root, sub, url, raw) : undefined;
    const lockNow = () => (paths === undefined ? opts.setupLock() : opts.setupLock(paths));
    const running = lockNow();
    if (running) return done(409, setupRunningResponse(running));
    if (underPrefix(sub, "/git") && typeof g.situation === "function") {
      const situationPrior = g.situation;
      g = { ...g, situation: (inst, ...rest) => { const s = lockNow(); return s ? { setupLock: s, error: setupRunningResponse(s).error } : situationPrior(inst, ...rest); } };
    }
  }
  if (sub === "/git/branches" && m === "GET") { try { return done(200, await listBranches(root, url.searchParams.get("repo") || "", g)); } catch (e) { return failed(e); } }
  // What git ignores (explorer like VS Code): per repo `{ relPath, ignored, clipped }` (git.js gitIgnored) — reading,
  // asked only on occasion (the explorer dims the entries), never on the tick of the git view. The situation of an
  // instance as with `GET /git`.
  if (sub === "/git/ignored" && m === "GET") { try { return done(200, gitResponse(await gitIgnored(root, { ...g, situation: gitSituation }), opts, g)); } catch (e) { return failed(e); } }
  // Git actions — return the fresh tree after success.
  // The workspace of the accesses is the caller's (`opts.workspaceId` — project: `proj.workspaceId`, workspace:
  // `ws.id`), not the first one whose folder contains the path (wsForCode, workspaces/git-auth.js).
  const wsTheView = () => wsForCode(root, opts.workspaceId);
  const accessOf = { workspaceId: opts.workspaceId || null };
  // The accesses of the hosts a repo connects to (submodules, `.lfsconfig`), from the workspace of the view — for
  // submodule update, pull (including LFS) and fetch; git.js asks them only WITH an instance (without: askpass).
  const accessesFor = (hosts) => { const ws = wsTheView(); return ws ? store.gitAccessesFor(ws.id, hosts) : []; };
  if (sub === "/git/creds" && m === "GET") { const ws = wsTheView(); return done(200, { creds: ws ? store.listGitCreds(ws.id) : [] }); }
  if (sub === "/git/creds" && m === "PUT") {
    const b = await readBody(req); const ws = wsTheView();
    if (!ws) return done(404, { error: T("workspace not found") });
    const host = String(b.host || "").trim().toLowerCase(); const username = String(b.username || "").trim(); const secret = String(b.secret || "");
    if (!host || !username || !secret) return done(400, { error: T("host, username and token required") });
    store.setGitCred(ws.id, host, username, secret); return done(200, { ok: true });
  }
  if (sub === "/git/creds" && m === "DELETE") { const ws = wsTheView(); const host = String(url.searchParams.get("host") || ""); if (ws && host) store.deleteGitCred(ws.id, host); return done(200, { ok: true }); }
  if (sub === "/git/commit" && m === "POST") { const b = await readBody(req); const ctx = b.push ? await gitAuthCtx(root, b.repo || "", g, accessOf) : { auth: null, host: "" }; try { await gitCommit(root, b.repo || "", b.message, { push: !!b.push, all: !!b.all, amend: !!b.amend, auth: ctx.auth, ...g }); return done(200, await tree(b.repo)); } catch (e) { return failed(e, gitErrPayload(e, ctx.host)); } }
  if (sub === "/git/stage" && m === "POST") { const b = await readBody(req); try { await gitStage(root, b.repo || "", b.all ? "all" : b.files, g); return done(200, await tree()); } catch (e) { return failed(e); } }
  if (sub === "/git/unstage" && m === "POST") { const b = await readBody(req); try { await gitUnstage(root, b.repo || "", b.all ? "all" : b.files, g); return done(200, await tree()); } catch (e) { return failed(e); } }
  if (sub === "/git/discard" && m === "POST") { const b = await readBody(req); try { await gitDiscard(root, b.repo || "", b.file, { untracked: !!b.untracked, all: !!b.all, ...g }); return done(200, await tree()); } catch (e) { return failed(e); } }
  // `content: true` (the diff tab of the code tabs in the chat): additionally both sides as text; without the field the
  // ordinary response.
  if (sub === "/git/diff" && m === "POST") { const b = await readBody(req); try { return done(200, await gitDiff(root, b.repo || "", b.file, { staged: !!b.staged, content: b.content, ...g })); } catch (e) { return failed(e); } }
  if (sub === "/git/pull" && m === "POST") { const b = await readBody(req); const ctx = await gitAuthCtx(root, b.repo || "", g, accessOf); try { await gitPull(root, b.repo || "", ctx.auth, { ...g, accessesFor }); return done(200, await tree(b.repo)); } catch (e) { return failed(e, gitErrPayload(e, ctx.host)); } }
  if (sub === "/git/fetch" && m === "POST") { const b = await readBody(req); const ctx = await gitAuthCtx(root, b.repo || "", g, accessOf); try { await gitFetch(root, b.repo || "", ctx.auth, { ...g, accessesFor }); return done(200, await tree(b.repo)); } catch (e) { return failed(e, gitErrPayload(e, ctx.host)); } }
  // `workingTree: true` ("discard block" in the diff tab): against the working tree instead of the index (git.js gitApply).
  if (sub === "/git/apply" && m === "POST") { const b = await readBody(req); try { await gitApply(root, b.repo || "", b.patch, { reverse: !!b.reverse, workingTree: b.workingTree, ...g }); return done(200, await tree()); } catch (e) { return failed(e); } }
  // "Stage change" in the editor's quick diff peek: ONE block of the buffer into the index (git.js gitStageBlock) — its
  // own throws carry status and code (400 BLOCK_INVALID/BLOCK_TOO_LARGE/NO_TEXT_FILE/FILTER, 409 INDEX_CHANGED/CONFLICT/…).
  if (sub === "/git/stage-block" && m === "POST") {
    const b = await readBody(req);
    try { await gitStageBlock(root, b.repo || "", b.file, b, g); return done(200, await tree()); }
    catch (e) { return e?.stageBlock ? done(e.status, { code: e.code, error: String(e.message) }) : failed(e); }
  }
  if (sub === "/git/stashes" && m === "GET") { try { return done(200, await gitStashList(root, url.searchParams.get("repo") || "", g)); } catch (e) { return failed(e); } }
  if (sub === "/git/stash" && m === "POST") { const b = await readBody(req); try { await gitStashPush(root, b.repo || "", { includeUntracked: !!b.includeUntracked, message: b.message, ...g }); return done(200, await tree()); } catch (e) { return failed(e); } }
  if (sub === "/git/stash/op" && m === "POST") { const b = await readBody(req); try { await gitStashOp(root, b.repo || "", String(b.op || ""), b.ref, g); return done(200, await tree()); } catch (e) { return failed(e); } }
  if (sub === "/git/stash/show" && m === "POST") { const b = await readBody(req); try { return done(200, await gitStashShow(root, b.repo || "", b.ref, g)); } catch (e) { return failed(e); } }
  if (sub === "/git/merge" && m === "POST") { const b = await readBody(req); try { const r = await gitMerge(root, b.repo || "", b.branch, g); const t = await tree(b.repo); return done(200, { ...t, conflicts: !!r.conflicts }); } catch (e) { return failed(e); } }
  if (sub === "/git/rebase" && m === "POST") { const b = await readBody(req); try { const r = await gitRebase(root, b.repo || "", b.branch, g); const t = await tree(b.repo); return done(200, { ...t, conflicts: !!r.conflicts }); } catch (e) { return failed(e); } }
  if (sub === "/git/merge-abort" && m === "POST") { const b = await readBody(req); try { await gitMergeAbort(root, b.repo || "", g); return done(200, await tree(b.repo)); } catch (e) { return failed(e); } }
  if (sub === "/git/blame" && m === "POST") { const b = await readBody(req); try { return done(200, await gitBlame(root, b.repo || "", b.file, g)); } catch (e) { return failed(e); } }
  // `graph` (git bar): the graph including parents, refs and `clipped` (git.js); an unknown value is a 400. Without the
  // field the ordinary response.
  // `timeAxis: true`: the time axis of ONE file (`file` relative to the repo) across renames — commits with path, old
  // path, author, time and `clipped` (git.js gitTimeAxis); `after` (hash of the last entry) pages on ("load more").
  // Reading like every log (COPY_READING).
  if (sub === "/git/log" && m === "POST") {
    const b = await readBody(req);
    try {
      if (b.timeAxis === true) return done(200, await gitTimeAxis(root, b.repo || "", b.file, { limit: b.limit, after: b.after, ...g }));
      return done(200, await gitLog(root, b.repo || "", { file: b.file, limit: b.limit, graph: b.graph, ...g }));
    } catch (e) { return failed(e); }
  }
  // `files: true` or `file` (+ `old`): the files of a commit or the diff of ONE file in it (the expanded commit in the
  // graph of the git bar) — reading like the whole commit, hence included under COPY_READING. `info: true`: author, time,
  // whole message and the numbers of a commit (the hover card in the graph). Without the three fields the ordinary
  // response. `content: true` (only with `file`): additionally both sides of the file as text (the diff tab).
  if (sub === "/git/show" && m === "POST") { const b = await readBody(req); try { return done(200, await gitShow(root, b.repo || "", b.hash, { ...g, files: b.files, file: b.file, old: b.old, info: b.info, content: b.content })); } catch (e) { return failed(e); } }
  if (sub === "/git/cherry-pick" && m === "POST") { const b = await readBody(req); try { const r = await gitCherryPick(root, b.repo || "", b.hash, g); const t = await tree(b.repo); return done(200, { ...t, conflicts: !!r.conflicts }); } catch (e) { return failed(e); } }
  if (sub === "/git/worktrees" && m === "GET") { try { return done(200, await gitWorktreeList(root, url.searchParams.get("repo") || "", g)); } catch (e) { return failed(e); } }
  if (sub === "/git/worktree" && m === "POST") { const b = await readBody(req); try { await gitWorktreeAdd(root, b.repo || "", b.path, b.branch, { newBranch: b.newBranch, ...g }); return done(200, await gitWorktreeList(root, b.repo || "", g)); } catch (e) { return failed(e); } }
  if (sub === "/git/worktree" && m === "DELETE") { const b = await readBodyOrEmpty(req); try { await gitWorktreeRemove(root, b.repo || url.searchParams.get("repo") || "", b.path || url.searchParams.get("path") || "", g); return done(200, await gitWorktreeList(root, b.repo || url.searchParams.get("repo") || "", g)); } catch (e) { return failed(e); } }
  if (sub === "/git/submodules" && m === "GET") { try { return done(200, await gitSubmoduleStatus(root, url.searchParams.get("repo") || "", g)); } catch (e) { return failed(e); } }
  // With an instance git fetches the submodules with the accesses of their hosts (git.js gitSubmoduleUpdate) — from the
  // workspace of the view; without an instance git.js never asks them.
  if (sub === "/git/submodule/update" && m === "POST") { const b = await readBody(req); try { await gitSubmoduleUpdate(root, b.repo || "", { ...g, accessesFor }); return done(200, await gitSubmoduleStatus(root, b.repo || "", g)); } catch (e) { return failed(e); } }
  if (sub === "/git/push" && m === "POST") { const b = await readBody(req); const ctx = await gitAuthCtx(root, b.repo || "", g, accessOf); try { await gitPush(root, b.repo || "", ctx.auth, g); return done(200, await tree(b.repo)); } catch (e) { return failed(e, gitErrPayload(e, ctx.host)); } }
  if (sub === "/git/checkout" && m === "POST") { const b = await readBody(req); try { await gitCheckout(root, b.repo || "", b.branch, { create: !!b.create, ...g }); return done(200, await tree(b.repo)); } catch (e) { return failed(e); } }

  // File editor: tree, read, write, create, rename, delete, search (limited to `root`). The limit of a converted project
  // (see fileLimit) — asked only for the file routes; if the source throws, the route answers 409.
  // If the instance of the route is a COPY (project level: the token of a copy or `?chat=<chat of the copy>`, routes.js
  // targetInstance), the project folder lies only in its container (overlay view): the same routes, the same responses,
  // but every access through the file access. No fallback: if the container is stopped, the route answers 409 — it never
  // reads or writes in the backend.
  if (instanceIsCopy(opts.instance) && (sub === "/files" || sub.startsWith("/files/") || sub === "/upload")) {
    const inst = opts.instance;
    // An existing target when copying is 409 with `code` (as in the backend) — otherwise the ordinary responses.
    const copyError = (e) => (e?.code === "TARGET_EXISTS" || e?.code === "COPY_TOO_LARGE"
      ? done(e.code === "TARGET_EXISTS" ? 409 : 400, { code: e.code, error: String(e?.message || e) })
      : done(e?.code === "PROGRAM" || e?.code === "CAP" ? 409 : 400, { error: String(e?.message || e) }));
    try {
      if (sub === "/files/tree" && m === "GET") { if (!fs.existsSync(root)) return done(400, { error: notFound() }); return done(200, await filesCopy.listDir(inst, root, url.searchParams.get("path") || "")); }
      if (sub === "/files/read" && m === "GET") return done(200, withSha(await filesCopy.readFile(inst, root, url.searchParams.get("path") || "")));
      if (sub === "/files/download" && m === "GET") {
        const z = await filesCopy.downloadCopy(inst, root, url.searchParams.get("path") || "");
        if (z.dir) return done(400, { error: T("A folder cannot be downloaded as ZIP from a copy — pack it in the copy's terminal or fetch the copy.") });
        handled = true;
        res.writeHead(200, {
          "Content-Type": imageMime(z.name) || "application/octet-stream", "Content-Length": z.size,
          "Content-Disposition": dispositionHeader(z.name, url.searchParams.get("inline") === "1"),
          "Cache-Control": url.searchParams.get("inline") === "1" ? "private, max-age=0, must-revalidate" : "no-store", "X-Content-Type-Options": "nosniff",
        });
        res.end(z.data);
        return true;
      }
      if (sub === "/files/write" && m === "PUT") {
        // The precondition `base` (see files.js) — read in the copy through the same file access.
        const b = await readBody(req);
        const base = baseFromBody(b);
        const deviation = base ? baseDeviation(base, await readingOrMissing(() => filesCopy.readFile(inst, root, String(b.path || "")))) : null;
        if (deviation) return done(409, deviation);
        return done(200, { ...(await filesCopy.writeFile(inst, root, String(b.path || ""), b.content)), sha: contentSha(b.content) });
      }
      if (sub === "/files/create" && m === "POST") { const b = await readBody(req); return done(201, await filesCopy.createEntry(inst, root, String(b.path || ""), b.type === "dir" ? "dir" : "file")); }
      if (sub === "/files/rename" && m === "POST") { const b = await readBody(req); return done(200, await filesCopy.renameEntry(inst, root, String(b.from || ""), String(b.to || ""))); }
      if (sub === "/files/copy" && m === "POST") { const b = await readBody(req); return done(201, await filesCopy.copyEntry(inst, root, String(b.from || ""), String(b.to || ""))); }
      if (sub === "/files" && m === "DELETE") return done(200, await filesCopy.deleteEntry(inst, root, url.searchParams.get("path") || ""));
      if (sub === "/files/search" && m === "POST") { const b = await readBody(req); return done(200, await filesCopy.searchFiles(inst, root, searchFields(b))); }
      if (sub === "/files/find" && m === "POST") { const b = await readBody(req); return done(200, { ...(await filesCopy.quickOpenFiles(inst, root, String(b.query ?? ""), FIND_CAP)), cap: FIND_CAP }); }
      if (sub === "/upload" && m === "POST") {
        const raw = await readRawBody(req);
        let b; try { b = JSON.parse(raw.toString("utf8")); } catch { return done(400, { error: "invalid json" }); }
        return done(200, await filesCopy.uploadFiles(inst, root, { dir: String(b.dir || ""), files: Array.isArray(b.files) ? b.files : [] }));
      }
    } catch (e) { return copyError(e); }
  }
  let dg = {};
  if ((sub === "/files" || sub.startsWith("/files/") || sub === "/upload") && (opts.instance || opts.gitInstanceSource)) {
    try { const limit = fileLimit(root, opts); if (limit) dg = { limit }; } catch (e) { const f = String(e?.message || e); return done(409, { error: f }); }
  }
  if (sub === "/files/tree" && m === "GET") { if (!fs.existsSync(root)) return done(400, { error: notFound() }); try { return done(200, listDir(root, url.searchParams.get("path") || "", dg)); } catch (e) { return done(400, { error: String(e.message || e) }); } }
  if (sub === "/files/read" && m === "GET") { try { return done(200, withSha(readProjectFile(root, url.searchParams.get("path") || "", dg))); } catch (e) { return done(400, { error: String(e.message || e) }); } }
  // Download (file raw, folder as ZIP) — answers binary, hence not via done(). With a limit via ONE checked descriptor
  // (runtime/http.js serveDownload `limit`) — a pre-check here with a download via the path afterwards would leave a window.
  if (sub === "/files/download" && m === "GET") {
    handled = true;
    await serveDownload(root, url.searchParams.get("path") || "", res, { inline: url.searchParams.get("inline") === "1", ...(dg.limit ? { limit: dg.limit } : {}) });
    return true;
  }
  if (sub === "/files/write" && m === "PUT") {
    // The precondition `base` (see files.js): read the same way as /files/read (with the limit).
    const b = await readBody(req);
    try {
      const base = baseFromBody(b);
      const deviation = base ? baseDeviation(base, await readingOrMissing(() => readProjectFile(root, String(b.path || ""), dg))) : null;
      if (deviation) return done(409, deviation);
      return done(200, { ...writeProjectFile(root, String(b.path || ""), b.content, dg), sha: contentSha(b.content) });
    } catch (e) { return done(400, { error: String(e.message || e) }); }
  }
  if (sub === "/files/create" && m === "POST") { const b = await readBody(req); try { return done(201, createEntry(root, String(b.path || ""), b.type === "dir" ? "dir" : "file", dg)); } catch (e) { return done(400, { error: String(e.message || e) }); } }
  if (sub === "/files/rename" && m === "POST") { const b = await readBody(req); try { return done(200, renameEntry(root, String(b.from || ""), String(b.to || ""), dg)); } catch (e) { return done(400, { error: String(e.message || e) }); } }
  // Copy/paste/duplicate (explorer like VS Code; files.js copyEntry): 201 with `{ ok, path, copied, omitted }`; an
  // existing target 409 `TARGET_EXISTS` (nothing overwritten), above the cap 400 `COPY_TOO_LARGE`, else 400 with the reason.
  if (sub === "/files/copy" && m === "POST") {
    const b = await readBody(req);
    try { return done(201, await copyEntry(root, String(b.from || ""), String(b.to || ""), dg)); }
    catch (e) { return done(e?.code === "TARGET_EXISTS" ? 409 : 400, { ...(e?.code === "TARGET_EXISTS" || e?.code === "COPY_TOO_LARGE" ? { code: e.code } : {}), error: String(e.message || e) }); }
  }
  if (sub === "/files" && m === "DELETE") { try { return done(200, deleteEntry(root, url.searchParams.get("path") || "", dg)); } catch (e) { return done(400, { error: String(e.message || e) }); } }
  if (sub === "/files/search" && m === "POST") { const b = await readBody(req); try { return done(200, searchFiles(root, searchFields(b), dg)); } catch (e) { return done(400, { error: String(e.message || e) }); } }
  // ⌘P (quick open, like VS Code): files by NAME in the scope of the search (the same exclusions as `/files/search`: VS
  // Code defaults and ignore files), filtered and sorted like quick open (files.js quickOpenFiles), the same limit; at
  // most FIND_CAP hits, `truncated` says when there were more or the walk stopped at the file cap.
  if (sub === "/files/find" && m === "POST") { const b = await readBody(req); try { return done(200, { ...quickOpenFiles(root, String(b.query ?? ""), FIND_CAP, dg), cap: FIND_CAP }); } catch (e) { return done(400, { error: String(e.message || e) }); } }
  // Upload (file batch as base64) into a folder — `dir` chooses the target, empty = root.
  // Its own raw body reader instead of readBody: the chunks are large (~3 MB per request).
  if (sub === "/upload" && m === "POST") {
    const raw = await readRawBody(req);
    let b; try { b = JSON.parse(raw.toString("utf8")); } catch { return done(400, { error: "invalid json" }); }
    // An operation without `chunks` (workspace level in ops mode) — this path would write the chunk to the target instead
    // of the staging. The project level never reaches this line with an operation (the branch above takes it).
    if (typeof opts.uploadBegins === "function" && b && typeof b === "object" && b.operation !== undefined) {
      const text = T("An upload id belongs to the project level (POST /api/projects/:id/upload) — nothing written.");
      return done(400, { code: "OPERATION_LOCATION", error: text });
    }
    try { return done(200, uploadFiles(root, { dir: String(b.dir || ""), files: Array.isArray(b.files) ? b.files : [] }, dg)); }
    catch (e) { return done(400, { error: String(e.message || e) }); }
  }

  // Start a debugger in the folder. Like the terminal, not under the lock of its instance (`opts.sessionLock`), and with
  // the tag of its instance (`opts.sessionTag`) — idle and lock then count and end it.
  if (sub === "/debug/launch" && m === "POST") {
    const b = await readBody(req);
    const inst = opts.instance || null;
    const lock = typeof opts.sessionLock === "function" ? opts.sessionLock(inst) : null;
    if (lock) return done(409, locked(lock, T("a debugger")));
    if (!fs.existsSync(root)) return done(400, { error: notFound() });
    try { return done(201, { ...debugLaunch({ cwd: root, file: String(b.file || ""), breakpoints: b.breakpoints || [], instance: inst, tag: typeof opts.sessionTag === "function" ? opts.sessionTag(inst) : "" }), available: true }); } catch (e) { return done(200, { available: false, error: String(e.message || e) }); }
  }

  // Start a terminal session in the folder. A shell with the tag of an ARCHIVED chat (`chat:<id>`) does not exist — an
  // old client could otherwise reopen it, and it would run until the restore; archiving ends exactly these shells
  // (chats/routes.js). Without a tag unchanged.
  // The instance of the terminal ONCE, BEFORE the lock — the tag `chat:<id>` of the chat rail takes the instance of its
  // chat (`opts.instanceForChat`), otherwise the route's applies. The lock (`opts.sessionLock`) asks THIS instance (asking
  // the route's would give a copy chat a terminal IN its copy while that copy is being recreated). If the resolution
  // throws (copy cannot be resolved, fence, a tag against the chosen ?instance), that is the response — never a terminal
  // elsewhere.
  // Every session without a chat tag gets the tag of its instance (`opts.sessionTag`, project level) — otherwise the
  // terminal of the Code tab would count in no idle and no lock. On the workspace level the caller's tag stays.
  if (sub === "/terminal" && m === "POST") {
    const b = await readBodyOrEmpty(req);
    const tag = typeof b.tag === "string" ? b.tag.slice(0, 120) : "";
    const chatFromTag = /^chat:([0-9a-f-]+)$/.exec(tag)?.[1] || "";
    let inst;
    try { inst = (chatFromTag && opts.instanceForChat ? opts.instanceForChat(chatFromTag) : opts.instance) || null; }
    catch (e) { const text = String(e?.message || e); return done(Number(e?.status) || 409, { error: text, ...(e?.code ? { code: e.code } : {}) }); }
    const lock = typeof opts.sessionLock === "function" ? opts.sessionLock(inst) : null;
    if (lock) return done(409, locked(lock, T("a terminal")));
    if (!fs.existsSync(root)) return done(400, { error: notFound() });
    if (chatFromTag && store.getChat(chatFromTag)?.archivedAt) return done(409, { error: T("The chat is archived — restore it before opening a terminal."), archived: true });
    const session = !chatFromTag && typeof opts.sessionTag === "function" ? opts.sessionTag(inst) : tag;
    // "Open in integrated terminal": `cwd` relative to the root — checked where the shell runs
    // (devtools/terminal-folder.js); without `cwd` the root.
    let cwd;
    try { cwd = await terminalFolder(root, b.cwd, inst); }
    catch (e) { const text = String(e?.message || e); return done(Number(e?.status) || 400, { error: text, ...(e?.code ? { code: e.code } : {}) }); }
    try { return done(201, { ...createTerminal({ cwd, cols: b.cols, rows: b.rows, tag: session, instance: inst }), available: true }); } catch (e) { return done(200, { available: false, error: String(e.message || e) }); }
  }

  // The editor's language service: `POST /lsp/<action>` — the computation in lsp/actions.js, the target of the file here
  // (lspTargetFor). The server runs in the instance (main or copy) and the backend writes nothing: no setup lock.
  // If the client leaves before the response (the editor aborts the token request on every change, like VS Code),
  // `signal` ends.
  if (sub.startsWith("/lsp/") && m === "POST") {
    const b = await readBody(req);
    const signal = abortOf(res);
    const r = await lspEditorResponse(sub.slice("/lsp/".length), b, (file) => lspTargetFor(root, opts, file), { signal });
    if (signal.aborted) return true; // answered: nobody is reading any more
    return done(r.status, r.body);
  }

  return handled;
}

export { codeRoute };
