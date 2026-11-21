// The own worktree of a graph workflow run. A leaf: it knows neither rows nor runs — creating, checking and removing is
// driven by `graph-start.js`/`graph-background.js`.
//
// createGraphWorktree({ startId, project, root })   from EVERY repo of the project (git.js:projectRepos, the same
//                                  resolution as the git tree and a subagent's worktree) a worktree in ONE run folder
//                                  `<root>/graph-<startId>` — each repo under its usual relative path, the repo of
//                                  the project folder itself as the run folder. Branch per repo
//                                  `cbase/graph-<startId[0..8]>`, branched off the HEAD of the main folder. In addition
//                                  the ignored `.env*` files down to depth 2 are COPIED and `node_modules`/`.venv`
//                                  LINKED absolutely (each link anchored in `info/exclude`, otherwise `git add -A`
//                                  would commit it); both are listed in `info.own`. No repo ⇒ error `reason: "repo"`.
//                                  If creation fails halfway, the function removes what it created and then throws.
// graphWorktreeChanged(info)       true as soon as a repo carries something a removal would destroy: a line in
//                                  `status --porcelain` other than the own copies/links, or commits in `base..HEAD`.
// removeGraphWorktree(info, { force })  per repo `worktree remove --force` and `branch -D`, then the run folder.
//                                  Without `force` only if unchanged (a run's work is never removed silently); with
//                                  `force` always (chat deleted). Never throws: errors are in `error`.
//
// graphWorktreeRepos(project)      the repos it would be created from, or the error `reason: "repo"` (the start asks
//                                  this already at the tool call, so "no repo" comes back as a 400 instead of a
//                                  dismissed run).
//
// `info = { dir, branch, repos: [{ name, relPath, root, target, base }], own: [{ path, kind: "copy"|"link", source }] }`
// — plain JSON, stored in `graph_starts.worktree_info`; it must survive a restart. A repo without a committed file (empty
// HEAD tree) is listed in `skipped: [{ name, relPath, root }]` instead of `repos` (only if there is one — otherwise the
// field is missing); if none is left, error `reason: "repo"`.
//
// What is NOT copied: files outside the repos — they are unversioned and stay readable in the main folder (the path
// rule in the prompt is written by graph-start.js). `.env*` and `node_modules` deeper than two levels (monorepo
// packages) neither: the list would otherwise be a walk over the whole working tree.
//
// In a converted project EVERY git here runs in the project container. `info` carries `projectId` for that (once the
// project has an id), and each function asks for the instance NOW (runs/instance.js instanceForProject — null without
// an operating marker or without an instance row: the plain path). Creating, checking and searching go through
// `git(…, inst)` (runtime/git-run.js); removal with an instance is a teardown job (runs/git-post-work.js
// worktreeTeardown) — checked, never unchecked (contract: no cleanup removes a worktree with unsaved changes, not even
// with `force`), counted as open work (awaitable from the synchronous hook "chatClosed" too), and if the container is
// down, queued as post-work (`<runtime>/git-post-work.jsonl`, executed at the next start).
// FILE WORK WITH AN INSTANCE. Copies (`.env*`), links (`node_modules`/`.venv`) and `info/exclude` likewise run INSIDE
// the project container (ownInProject: ONE `node -e` via runtime/git-run.js commandRun), never in the backend. The
// container determines everything these paths are formed from — the root of a repo (`rev-parse --show-toplevel`), the
// location of `info/exclude` (`--git-path`) and the names (`ls-files`). In the backend they would lead to
// `appendFileSync` on an arbitrary file (say `~/.bashrc`, with a line from a name containing a line break) and to
// `copyFileSync` of arbitrary `.env*` files from the backend into a place the container reads. Inside the container
// they only harm the project itself. The backend passes only what it knows itself as arguments (the worktree folder
// from `info`, the checked names) and opens no path from a container output; a name with a line break, an absolute
// path or a `.`/`..`/empty segment is dropped already in the backend (with a warning). The removal (unlink links, run
// folder) is done by the teardown job in the container as well. WITHOUT an instance everything happens in the backend.
// WITH an instance each worktree fetches its LFS files after its own files (runs/git-post-work.js lfsInWorktree:
// `git lfs ls-files` first — a repo without LFS files asks nothing —, then `git lfs pull` with the per-host credentials
// in the container; never throws, on failure pointers stay as before). The image default `GIT_LFS_SKIP_SMUDGE=1` would
// otherwise leave pointers in place.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { projectRepos } from "../git.js";
import { T } from "../i18n.js";
import { commandRun, gitRun } from "../runtime/git-run.js";
import { instanceFromIdentifier, instanceForProject } from "../runs/instance.js";
import { lfsInWorktree, worktreeTeardown } from "../runs/git-post-work.js";
import { createWorktreeRoot } from "../runs/runtime-location.js";

const pexec = promisify(execFile);

// Creating on a large repo checks out the whole tree — the deadline is that of a hanging git, not of a slow one.
const GIT_DEADLINE_MS = 120_000;
// How deep the search for ignored entries goes (`.env`, `frontend/.env`, `node_modules/`, `app/.venv/`).
const OWN_DEPTH = 2;
// These ignored folders are linked, not copied: they are large and only read.
const LINK_FOLDER = new Set(["node_modules", ".venv"]);

// A git of this file: without an instance the plain starter (gitInB), with an instance in the project container — the
// same shape `{ ok, out, err }` on both paths.
async function git(cwd, args, inst = null) {
  if (!inst) return gitRun(null, cwd, args, { fallback: () => gitInB(cwd, args) });
  const r = await gitRun(inst, cwd, args, { timeout: GIT_DEADLINE_MS, maxBuffer: 64 * 1024 * 1024 });
  return r.code === 0 ? { ok: true, out: r.stdout } : { ok: false, out: String(r.stdout || ""), err: String(r.stderr || "").trim() };
}

// The instance of a project NOW (see header) — null without a project id.
const instanceOf = (projectId) => (projectId ? instanceForProject(String(projectId)) : null);

// A worktree in the COPY of a chat. `createGraphWorktree({ …, instance })` gets the instance of the run chat
// (runs/instance.js instanceOfChat — for a child the pinned one); if it is a copy, `info` carries its identifier
// (`info.identifier`), and every later function (check, remove) asks THIS instance, never the main one. Without a copy
// `info` carries no such field. The root of a copy's worktrees (`copy-worktrees/<name>/`) is determined by the caller
// from the same instance (workflows/graph-start.js, runs/runtime-location.js) — `info.dir` lies below it, and the
// post-work (runs/git-post-work.js) checks every row of the copy against EXACTLY this root, never against `worktrees/`.
// An identifier that cannot be resolved throws (no fallback to the main instance).
function instanceOfThe(info) {
  if (!info?.identifier) return instanceOf(info?.projectId);
  const inst = instanceFromIdentifier(info.identifier);
  if (!inst) throw new Error(T`The instance ${info.identifier} of this worktree cannot be resolved — no git in the main instance`);
  return inst;
}

// The plain starter: only the fallback without an instance.
async function gitInB(cwd, args) {
  try {
    const { stdout } = await pexec("git", args, {
      cwd, timeout: GIT_DEADLINE_MS, maxBuffer: 64 * 1024 * 1024, windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return { ok: true, out: stdout };
  } catch (e) {
    return { ok: false, out: typeof e.stdout === "string" ? e.stdout : "", err: String(e.stderr || e.message || e).trim() };
  }
}

const branchFor = (startId) => `cbase/graph-${String(startId).slice(0, 8)}`;

// Does HEAD carry not a single entry? Only a yes that was actually read counts — if the question fails, creation
// proceeds as usual (the error then shows up there).
export async function emptyTree(root, inst = null) {
  const r = await git(root, ["ls-tree", "--name-only", "HEAD"], inst);
  return Boolean(r.ok) && !String(r.out || "").trim();
}

// The ignored entries of a repo, relative to its root: `--directory` collapses an entirely ignored folder into ONE
// line with a slash — exactly the form in which `node_modules/` is linked.
async function ownEntries(root, inst = null) {
  const r = await git(root, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"], inst);
  if (!r.ok) throw new Error(`git ls-files in ${root}: ${r.err}`);
  const out = [];
  for (const raw of r.out.split("\0")) {
    if (!raw) continue;
    const folder = raw.endsWith("/");
    const rel = folder ? raw.slice(0, -1) : raw;
    const parts = rel.split("/");
    if (parts.length > OWN_DEPTH) continue;
    const name = parts[parts.length - 1];
    // With an instance the name comes from the container (see header "FILE WORK WITH AN INSTANCE"): never with a line
    // break into a line, never out of the worktree. Without an instance unchanged.
    if (inst && !nameSafe(rel)) {
      console.warn(`[graph-worktree] entry ${JSON.stringify(rel).slice(0, 200)} from ls-files in the project container skipped — not a permitted name`);
      continue;
    }
    if (folder && LINK_FOLDER.has(name)) out.push({ rel, kind: "link" });
    // Files only: an ignored FOLDER `.env/` is usually a virtual environment, not configuration.
    else if (!folder && name.startsWith(".env")) out.push({ rel, kind: "copy" });
  }
  return out;
}

// A name from the container (see header): relative, without line break, without an empty, `.` or `..` segment.
const nameSafe = (rel) => typeof rel === "string" && rel !== "" && !/[\r\n\0]/.test(rel) && !path.isAbsolute(rel)
  && rel.split("/").every((t) => t !== "" && t !== "." && t !== "..");
// The anchored line of a link in `info/exclude` (see closeLinksFrom) — glob characters of a parent folder literally.
const excludeRow = (rel) => `/${rel.replace(/[\\*?[]/g, "\\$&")}`;

// The program for the file work in the project container (see header "FILE WORK WITH AN INSTANCE"): the same steps as
// without an instance in the backend (createGraphWorktree, closeLinksFrom), only there. argv:
// `target root header (kind rel row)…`. Output: ONE line of JSON `{ fresh: [index…], error? }` — the indices of the
// created entries (an existing one stays untouched); with `error` exit 1, after what was created so far has been
// reported (the cleanup needs it). Node exists in the project container (the same base as the backend).
export const OWN_PROGRAM = `"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const [target, root, header, ...rest] = process.argv.slice(1);
const fresh = [];
const rows = [];
try {
  for (let i = 0; i + 2 < rest.length; i += 3) {
    const [kind, rel, row] = rest.slice(i, i + 3);
    const filePath = path.join(target, rel);
    if (fs.existsSync(filePath)) continue;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (kind === "copy") fs.copyFileSync(path.join(root, rel), filePath);
    else { fs.symlinkSync(path.join(root, rel), filePath, "dir"); rows.push(row); }
    fresh.push(i / 3);
  }
  if (rows.length) {
    const file = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], { cwd: target, encoding: "utf8" }).trim();
    const old = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    const present = new Set(old.split(/\\r?\\n/).map((z) => z.trim()));
    const alongside = rows.filter((z) => !present.has(z));
    if (alongside.length) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const k = present.has(header) ? "" : header + "\\n";
      fs.appendFileSync(file, (old && !old.endsWith("\\n") ? "\\n" : "") + k + alongside.join("\\n") + "\\n");
    }
  }
  process.stdout.write(JSON.stringify({ fresh }) + "\\n");
} catch (e) {
  process.stdout.write(JSON.stringify({ fresh, error: String((e && e.message) || e) }) + "\\n");
  process.exitCode = 1;
}
`;

// The file work of a repo WITH an instance (see header): in the project container; the created entries land in
// `info.own` (from data the backend knows: `target` from `info`, names the backend has already checked — the response
// only supplies indices). Throws if the program fails (createGraphWorktree then removes what was created).
async function ownInProject(inst, { target, root, entries, info }) {
  if (!entries.length) return;
  const args = ["-e", OWN_PROGRAM, "--", target, root, EXCLUDE_HEADER];
  for (const e of entries) args.push(e.kind, e.rel, e.kind === "link" ? excludeRow(e.rel) : "");
  const r = await commandRun(inst, target, process.execPath, args, { timeout: GIT_DEADLINE_MS });
  let response = null;
  try { response = JSON.parse(String(r.stdout || "").trim().split("\n").pop() || "null"); } catch { response = null; }
  const fresh = Array.isArray(response?.fresh) ? response.fresh : [];
  const seen = new Set();
  for (const i of fresh) {
    if (!Number.isInteger(i) || i < 0 || i >= entries.length || seen.has(i)) continue;
    seen.add(i);
    const e = entries[i];
    info.own.push({ path: path.join(target, e.rel), kind: e.kind, source: path.join(root, e.rel) });
  }
  if (r.code !== 0 || !response || response.error) {
    throw new Error(T`Copies and links in ${target} (in the project container): ${response?.error || String(r.stderr || "").trim() || `Exit ${r.code}`}`);
  }
}

// To git a link is a FILE, and the usual pattern `node_modules/` (with a slash) only matches folders: without an
// exclusion a `git add -A` in the worktree would pick up the link, and the branch would carry an absolute link to the
// main folder. Hence per link the anchored line `/<rel>` (without a slash: file AND folder) in `info/exclude` — for a
// worktree it lies in the SHARED git folder of the repo, so it applies in the main folder too. There the same path is
// already ignored (only ignored entries are linked), so the line changes nothing there. It stays after removal: a
// second run on the same repo needs it as well, and it is never written twice.
async function closeLinksFrom(target, rels, inst = null) {
  if (!rels.length) return;
  const r = await git(target, ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], inst);
  if (!r.ok) throw new Error(`git rev-parse --git-path info/exclude in ${target}: ${r.err}`);
  const file = r.out.trim();
  const old = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const existing = new Set(old.split(/\r?\n/).map((z) => z.trim()));
  // Take glob characters of a parent folder literally.
  const fresh = rels.map((rel) => `/${rel.replace(/[\\*?[]/g, "\\$&")}`).filter((z) => !existing.has(z));
  if (!fresh.length) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const header = existing.has(EXCLUDE_HEADER) ? "" : `${EXCLUDE_HEADER}\n`;
  fs.appendFileSync(file, `${old && !old.endsWith("\n") ? "\n" : ""}${header}${fresh.join("\n")}\n`);
}
const EXCLUDE_HEADER = "# cbase: linked dependencies of the graph worktrees (workflows/worktree.js)";

/**
 * The repos a worktree would be created from (git.js:projectRepos) — or the error `reason: "repo"` when the project
 * has none. The start asks the same check already at the tool call (400 `repo`), with THE SAME text. The project repo
 * is never among them: projectRepos skips it and returns the code repos below it — a graph run never branches off the
 * repo cbase keeps in the project folder (guard: graph-worktree.test.js).
 */
export async function graphWorktreeRepos(project, inst = instanceOf(project?.id)) {
  const candidates = project?.path ? await projectRepos(project.path, { instance: inst }) : [];
  if (!candidates.length) {
    const name = String(project?.name || project?.path || "");
    const err = new Error(T`The project “${name}” has no Git repository — a separate worktree needs a repository.`);
    err.reason = "repo";
    throw err;
  }
  return candidates;
}

/**
 * Creates the worktree of a run. `project` = `{ name, path }` (focusedProject), `root` = the location of the run
 * folders (required; the caller takes the worktree root of the runtime folder, runs/runtime-location.js — the same as
 * for the subagents' worktrees).
 */
export async function createGraphWorktree({ startId, project, root, instance = undefined } = {}) {
  if (!startId) throw new Error("createGraphWorktree: startId missing");
  const baseValue = root || "";
  if (!baseValue) throw new Error("createGraphWorktree: no root for worktrees");
  const inst = instance !== undefined ? instance : instanceOf(project?.id); // asked once, for the whole build-up
  const candidates = await graphWorktreeRepos(project, inst);
  const dir = path.join(baseValue, `graph-${startId}`);
  // An existing folder does not belong to this call — it is neither used nor (on failure) removed.
  if (fs.existsSync(dir)) throw new Error(T`The worktree folder ${dir} already exists.`);
  // Inside the runtime folder without a link leading out (runs/runtime-location.js createWorktreeRoot).
  createWorktreeRoot(baseValue);
  const info = { dir, branch: branchFor(startId), repos: [], own: [], ...(project?.id ? { projectId: String(project.id) } : {}) };
  if (inst && inst.instance && inst.instance !== "main") info.identifier = inst.identifier || `${inst.projectId}/${inst.instance}`; // the copy
  try {
    for (const k of candidates) {
      const target = k.relPath ? path.join(dir, k.relPath) : dir;
      const base = await git(k.root, ["rev-parse", "HEAD"], inst);
      if (!base.ok) throw new Error(T`The repo "${k.name}" has no commit (${k.root}): ${base.err}`);
      // A code repo without a committed file (the init of a new project only creates an EMPTY commit) gets no checkout
      // of its own — it would be an empty folder, and the untracked files of the main folder would be missing in it.
      // The folder stays readable in the main folder; the prompt names it (runs/system-prompt.js worktreePrompt). An
      // empty root tree means an empty tree (git stores no empty subtree), hence without `-r`.
      if (await emptyTree(k.root, inst)) {
        info.skipped = [...(info.skipped || []), { name: k.name, relPath: k.relPath, root: k.root }];
        continue;
      }
      // An existing branch belongs to another (or a crashed) run — never adopt it, never delete it.
      const already = await git(k.root, ["rev-parse", "--verify", "--quiet", `refs/heads/${info.branch}`], inst);
      if (already.ok) throw new Error(T`In the repo "${k.name}" the branch ${info.branch} already exists.`);
      const add = await git(k.root, ["worktree", "add", "-b", info.branch, target, "HEAD"], inst);
      if (!add.ok) {
        // `-b` creates the branch before the checkout — if the checkout fails, it would otherwise be left behind.
        await git(k.root, ["branch", "-D", info.branch], inst);
        throw new Error(T`Worktree for "${k.name}" could not be created: ${add.err || add.out}`);
      }
      info.repos.push({ name: k.name, relPath: k.relPath, root: k.root, target, base: base.out.trim() });
      if (inst) { // see header "FILE WORK WITH AN INSTANCE": none of this in the backend
        await ownInProject(inst, { target, root: k.root, entries: await ownEntries(k.root, inst), info });
        // The LFS files of the worktree, only in a repo with LFS files, with the per-host credentials
        // (runs/git-post-work.js lfsInWorktree — never throws; on failure pointers stay as before).
        await lfsInWorktree(inst, target);
        continue;
      }
      const links = [];
      for (const e of await ownEntries(k.root, inst)) {
        const source = path.join(k.root, e.rel);
        const filePath = path.join(target, e.rel);
        if (fs.existsSync(filePath)) continue; // versioned in the tree (should never happen for ignored ones) — do not overwrite
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        if (e.kind === "copy") fs.copyFileSync(source, filePath);
        else { fs.symlinkSync(source, filePath, "dir"); links.push(e.rel); }
        info.own.push({ path: filePath, kind: e.kind, source });
      }
      await closeLinksFrom(target, links, inst);
    }
    if (!info.repos.length) { // every repo without a committed file — a worktree out of nothing would not be a place of its own
      const name = String(project?.name || project?.path || "");
      const err = new Error(T`The project “${name}” has no Git repository with a committed file — a separate worktree would be empty.`);
      err.reason = "repo";
      throw err;
    }
  } catch (e) {
    const r = await removeGraphWorktree(info, { force: true });
    if (r.error.length) console.error("[graph-worktree] cleanup after half a creation:", r.error.join(" · "));
    throw e;
  }
  return info;
}

// The lines of `status --porcelain -z` as paths (relative to the worktree root). For renames the new path is followed
// by the old one as a separate entry — both count.
function porcelainPaths(out) {
  const parts = out.split("\0");
  const paths = [];
  for (let i = 0; i < parts.length; i++) {
    const z = parts[i];
    if (!z) continue;
    const xy = z.slice(0, 2);
    paths.push(z.slice(3));
    if (xy[0] === "R" || xy[0] === "C") { paths.push(parts[i + 1] || ""); i++; }
  }
  return paths.filter(Boolean);
}

/** Does a repo of the worktree carry work a removal would destroy? The own copies and links do not count. */
export async function graphWorktreeChanged(info) {
  const inst = instanceOfThe(info); // the instance of the copy if `info` carries one
  const own = new Set((info?.own || []).map((e) => path.resolve(e.path)));
  for (const r of info?.repos || []) {
    if (!fs.existsSync(r.target)) continue; // deleted by hand: nothing left to save here
    // `-uall`: every unversioned file individually — otherwise a link in a newly created folder would show up as
    // that folder and fall through the comparison with `own`.
    const st = await git(r.target, ["status", "--porcelain", "-z", "--untracked-files=all"], inst);
    // A git that does not answer does not mean "unchanged" — when in doubt the worktree stays.
    if (!st.ok) return true;
    if (porcelainPaths(st.out).some((p) => !own.has(path.resolve(r.target, p.replace(/\/$/, ""))))) return true;
    if (r.base) {
      const ahead = await git(r.target, ["rev-list", "--count", `${r.base}..HEAD`], inst);
      if (!ahead.ok || Number(ahead.out.trim()) > 0) return true;
    }
  }
  return false;
}

/**
 * Removes the worktree. Without `force` only if unchanged (`{ removed: false, changed: true }` otherwise). Never throws.
 * Returns `{ removed, changed, error: [] }`. With an instance it is a teardown job in the project container — ALWAYS
 * checked (`force` has no effect there: no cleanup removes a worktree with unsaved changes), and if the container is
 * down, `postWork: true` (the folder stays until the next start).
 */
export async function removeGraphWorktree(info, { force = false } = {}) {
  const error = [];
  if (!info?.dir) return { removed: false, changed: false, error };
  let inst = null;
  try { inst = instanceOfThe(info); } catch (e) {
    return { removed: false, changed: false, error: [`instance of ${info.identifier || info.projectId} not readable (${e?.message || e}) — the worktree stays, no git in the backend`] };
  }
  if (inst) {
    const r = await worktreeTeardown(inst, {
      who: "Graph-Worktree",
      worktrees: (info.repos || []).map((x) => ({ repo: x.root, dir: x.target, branch: info.branch, base: x.base, deleteBranch: true })),
      allUnversioned: true,
      own: (info.own || []).map((e) => e.path),
      links: (info.own || []).filter((e) => e.kind === "link").map((e) => e.path),
      folder: info.dir,
    });
    return { removed: r.removed, changed: r.changed, error: r.error, ...(r.postWork ? { postWork: true } : {}) };
  }
  try {
    if (!force && await graphWorktreeChanged(info)) return { removed: false, changed: true, error };
  } catch (e) { return { removed: false, changed: true, error: [String(e?.message || e)] }; }
  // Unlink the own links first: no cleanup may ever end up in the `node_modules` of the main folder.
  for (const e of info.own || []) {
    if (e.kind !== "link") continue;
    try { if (fs.lstatSync(e.path).isSymbolicLink()) fs.unlinkSync(e.path); }
    catch (err) { if (err?.code !== "ENOENT") error.push(`${e.path}: ${err?.message || err}`); }
  }
  for (const r of info.repos || []) {
    if (!fs.existsSync(r.root)) { error.push(`repo ${r.root} missing`); continue; }
    const rm = await git(r.root, ["worktree", "remove", "--force", r.target]);
    if (!rm.ok) {
      // Folder already gone (deleted by hand): `prune` clears the bookkeeping in the repo.
      if (!fs.existsSync(r.target)) await git(r.root, ["worktree", "prune"]);
      else error.push(`worktree remove ${r.target}: ${rm.err}`);
    }
    const br = await git(r.root, ["branch", "-D", info.branch]);
    if (!br.ok) error.push(`branch -D ${info.branch} in ${r.root}: ${br.err}`);
  }
  try { fs.rmSync(info.dir, { recursive: true, force: true }); }
  catch (e) { error.push(`${info.dir}: ${e?.message || e}`); }
  return { removed: !fs.existsSync(info.dir), changed: false, error };
}
