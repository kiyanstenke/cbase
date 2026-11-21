// Local Git/GitLab info of a project folder plus actions (commit/push/checkout).
// Reading is fail-safe: no git installed or no repo → { repos: [] }.
//
// EVERY exported function takes an instance: fixed (`opts.instance`, the project level: devtools/code-route.js passes
// `instanceForProject(proj.id)`) or per path (`opts.instanceFor(path)`, the workspace level: a repo under the folder of a
// relocated project belongs to it, projectbox/git-assignment.js). With an instance every git call runs through
// runtime/git-run.js inside the project container, otherwise through the plain starter `gitInB`/`gitStdinInB` unchanged
// (argv, environment, cap byte-equal). With an instance `readGitTree` bundles the read commands of ALL repos of that
// instance into ONE call (`readBundle`, parsed by the same `readRepoInfo`). Network commands (pull, fetch, push) get the
// git access as environment in the container (runtime/git-run.js accessAsEnvironment), in B via GIT_ASKPASS as before.
// The repo search only reads the file system and stays in B — the paths are the same in B and in the project container.
// The `rm` of an untracked file runs IN the container when there is an instance: the container checks the path (a folder
// swapped for a symlink between status and click would otherwise make an `rmSync` in B delete outside the project).
// NOT READY: `opts.situation(inst)` (the git view's situation, devtools/code-route.js gitSituation) is asked before every
// action's first docker call — it throws with `err.situation` instead of an exec against a container that is not ready.
// A stopped container (docker CLI answer, runtime/git-run.js CONTAINER_STANDS) throws with `err.containerStands` and
// `err.projectId` — never "no git repository at this path". The route answers 409 and wakes it.
// The instance can be a COPY (`inst.instance` = `copy-<name>`, the git view of a copy chat — devtools/code-route.js
// gitOptions with `?chat=`). Its repos are those of the snapshot (`setCopyRepoSource`, set in server.js): searching B's
// file system (`findRepos`) would see the main, not the clone, and a new repo of the copy appears only after cleanup.
// Unreadable THROWS (never the main's repos in their place). A container error carries `err.instance` (the copy) so the
// route wakes the RIGHT instance.
// Guards: server/backend/test/projectbox-git.test.js, server/backend/test/copy-worktrees.test.js; the start places are
// held by server/backend/test/in-project-start-places.test.js (E).
import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import { writeStdin } from "./providers/kind-stdin.js";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { gitRun, commandRun, lfsFetch, networkHosts, accessAsEnvironment, readingArgs, READ_TOGGLE, GIT_RUN_CAP_MS, CONTAINER_STANDS, CONTAINER_PAUSED, HOST_WITH_PORT } from "./runtime/git-run.js";
import { realRoots, openFileWithoutReference } from "./runtime/real-path.js";
import { T } from "./i18n.js";

const pexec = promisify(execFile);
const MAX_CHANGES = 300; // Cap the file list — the sidebar is an overview, not a diff viewer.
const US = "\u001f"; // Unit separator as a robust field separator in the git-log format.
// Output cap of a git call (in B and per command in the project container), 8 MiB — except for `git status`: 85,000
// untracked files are 13 MB of output, and at the old cap the status silently failed as "clean". ESTIMATED, NOT MEASURED:
// 64 MiB carry well over 400,000 lines; beyond that the cap shows up as `statusError` in the repo.
const GIT_OUTPUT = 8 * 1024 * 1024;
export const STATUS_OUTPUT = 64 * 1024 * 1024;

// ── Values from the request body are never an option ─────────────────────────────────────────────────────────────────
// A value a route writes from the body into git's argv WITHOUT a `--` before it (ref, branch, stash, worktree path) must not
// look like an option: `stash show -p --output=<file>` wrote an arbitrary file, `rebase --exec=<command>` ran a command,
// `checkout --orphan=…` and `worktree add --lock …` changed what the button does. Checked BEFORE every git call — no value
// starts with "-", none carries NUL or a line break (git itself rejects such ref names anyway: `git check-ref-format`).
// The argv of valid values stays byte-equal (anchor server/backend/test/fixtures/projectbox-git/argv-without-instance.json);
// a path that really starts with "-" goes as `./-name`. Values BEHIND a `--` (files of stage/diff/blame/log) and values of an
// option with an argument (`-m <message>`, `-b <branch>`) are not options and stay free. Guard: server/backend/test/projectbox-git.test.js "(W1)".
function noOption(value, what) {
  const s = String(value ?? "");
  if (s.startsWith("-") || /[\0\r\n]/.test(s)) {
    throw new Error(T`Invalid ${what}: "${s.slice(0, 80)}" — it must not start with "-" (git would read it as an option) or contain a line break.`);
  }
  return s;
}

// ── The instance of a call ───────────────────────────────────────────────────────────────────
// Fixed (project level) or per path (workspace level); without either, null — the plain path.
const instanceFrom = (opts, filePath) => (typeof opts?.instanceFor === "function" ? opts.instanceFor(filePath) : opts?.instance) || null;
// Does `filePath` belong to a relocated project? Then B reads there only without following links (isProjectRepo `safe`). An
// unreadable instance (instanceFor throws) counts as yes — the safe reader gives the same answer for an ordinary file.
// Without `instance`/`instanceFor` always no: the plain call.
const safeOn = (opts, filePath) => { try { return Boolean(instanceFrom(opts, filePath)); } catch { return true; } };

// A result inside the container that only says "the container did not run" becomes an error with a flag (see header).
// A PAUSED container carries `containerPaused` instead of `containerStands` — wait, do not wake (runtime/git-run.js).
function withStatus(err, inst, r) {
  if (CONTAINER_STANDS.test(String(r?.stderr || ""))) { err.containerStands = true; err.projectId = inst.projectId; }
  else if (CONTAINER_PAUSED.test(String(r?.stderr || ""))) { err.containerPaused = true; err.projectId = inst.projectId; }
  if ((err.containerStands || err.containerPaused) && copyNameOf(inst)) err.instance = inst.instance; // only a copy
  return err;
}

// ── The repos of a copy ───────────────────────────────────────────────────────────────────────
// `source(inst)` → `[{ rel, projectRepo }]` from the copy's snapshot (stacks/ readSnapshot, server.js) — git.js does not
// import stacks/. `rel` "." = the project folder; `projectRepo` = the project repo (not a code repo, see projectRepos).
let copyRepoSource = null;
export function setCopyRepoSource(fn) { copyRepoSource = typeof fn === "function" ? fn : null; }
const copyNameOf = (inst) => (inst && inst.instance && inst.instance !== "main" ? String(inst.instance) : null);

function copyRepos(projectPath, inst) {
  if (!copyRepoSource) throw new Error(`The repos of copy ${inst.identifier || inst.instance} cannot be read — no source (never the main's)`);
  const out = [];
  for (const r of copyRepoSource(inst) || []) {
    if (!r || r.projectRepo) continue; // cbase manages the project repo itself
    const rel = r.rel === "." ? "" : String(r.rel ?? "");
    if (rel.split("/").includes("..") || path.isAbsolute(rel)) throw new Error(`The snapshot of copy ${inst.identifier || inst.instance} names a repo path outside the project: "${rel}"`);
    const root = rel ? path.join(projectPath, rel) : projectPath;
    out.push({ name: rel === "" ? (path.basename(root) || root) : rel, relPath: rel, root });
  }
  return out.sort((a, b) => (a.relPath || "").localeCompare(b.relPath || "") || a.name.localeCompare(b.name));
}
// An instance that is not ready (`opts.situation`) throws BEFORE any docker call — `err.situation` carries the situation.
function checkSituation(inst, opts) {
  if (!inst || typeof opts?.situation !== "function") return;
  const situation = opts.situation(inst);
  if (!situation) return;
  const err = new Error(situation.error || situation.notice || T("Project container not ready"));
  err.situation = { projectId: inst.projectId, ...situation };
  throw err;
}

// Run git: with an instance inside the project container (runtime/git-run.js), otherwise the plain starter. The same error
// shape on both paths: an Error with cleaned stderr, `code`, `stdout`.
// A READING subcommand (status, diff, show, log, blame, ls-files, check-attr, check-ignore) runs on both paths without
// programs from the repo's configuration (`readingArgs`, runtime/git-run.js); a writing one stays as it is.
// Guard: server/backend/test/git-read-paths.test.js.
async function git(cwd, args, opts = {}) {
  args = readingArgs(args);
  const inst = opts.instance || null;
  if (!inst) return gitRun(null, cwd, args, { fallback: () => gitInB(cwd, args, opts) });
  // `withoutDeadline` (submodules, LFS content) only with an instance; without one every call stays the plain one.
  const r = await gitRun(inst, cwd, args, { timeout: opts.timeout || 6000, env: opts.env, maxBuffer: opts.maxBuffer || GIT_OUTPUT, ...(opts.withoutDeadline ? { withoutDeadline: true } : {}) });
  if (r.code === 0) return r.stdout;
  const err = new Error(String(r.stderr || "").trim() || "git command failed");
  err.code = r.code;
  err.stdout = r.stdout;
  if (r.cap) err.cap = r.cap;
  throw withStatus(err, inst, r);
}

const gitModule = (...a) => git(...a);

// The plain starter (only the fallback without an instance, unchanged).
// Run git. GIT_TERMINAL_PROMPT=0 keeps missing credentials (e.g. on push) from blocking on a prompt — git then fails fast
// instead of hanging. On failure an Error with cleaned stderr is thrown (for meaningful messages in the UI).
async function gitInB(cwd, args, opts = {}) {
  try {
    const { stdout } = await pexec("git", args, {
      cwd,
      timeout: opts.timeout || 6000,
      maxBuffer: opts.maxBuffer || GIT_OUTPUT,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...(opts.env || {}) },
    });
    return stdout;
  } catch (e) {
    const msg = String(e.stderr || e.message || e).trim();
    const err = new Error(msg || "git command failed");
    err.code = e.code;
    err.stdout = e.stdout; // some commands (git diff) deliver stdout even on exit≠0
    if (e?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") err.cap = "output"; // the cap, not git, ended the call
    throw err;
  }
}

// Return stdout even on exit≠0 (git diff → exit 1 when differences exist). A stopped or paused project container and an
// instance that is not ready are NOT an exit≠0 of git: they pass on, so the route via code-route.js answers 409 "project is
// starting" (and wakes) — otherwise an empty diff would show.
async function raw(root, args, opts = {}) {
  try { return await git(root, args, opts); }
  catch (e) {
    if (e?.containerStands || e?.containerPaused || e?.situation) throw e;
    return typeof e.stdout === "string" ? e.stdout : "";
  }
}

// Unix seconds → short relative time (deterministic, no ICU dependency), localized via T.
function relativeDe(unixSec) {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - unixSec));
  if (s < 60) return T("just now");
  const m = Math.floor(s / 60);
  if (m < 60) return T`${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return T`${h} h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return T`${d} d ago`;
  const w = Math.floor(d / 7);
  if (w < 5) return T`${w} wk ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return T`${mo} mo ago`;
  return T`${Math.floor(d / 365)} y ago`;
}

// Porcelain status codes (X = index/staged, Y = work tree) → display category.
// A CONFLICT is any of the seven pairs git writes for "unmerged" (git status, "Short Format": DD AU UD UA DU AA UU) — not
// just a "U" on the work-tree side: "UA" and "AA" used to read "added", "DD" and "UD" "deleted", and the bar offered "stage
// block" for a file in the middle of a conflict. Guard: test/git-diff-content.test.js (l).
const UNMERGED = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);
export function classify(x, y) {
  if (x === "?" && y === "?") return { code: "?", label: "new (untracked)", kind: "untracked" };
  if (UNMERGED.has(`${x}${y}`)) return { code: "U", label: "conflict", kind: "conflict" };
  const c = y !== " " ? y : x; // the concrete change (work tree preferred)
  switch (c) {
    case "M": return { code: "M", label: "modified", kind: "modified" };
    case "A": return { code: "A", label: "added", kind: "added" };
    case "D": return { code: "D", label: "deleted", kind: "deleted" };
    case "R": return { code: "R", label: "renamed", kind: "renamed" };
    case "C": return { code: "C", label: "copied", kind: "renamed" };
    case "U": return { code: "U", label: "conflict", kind: "conflict" };
    case "T": return { code: "T", label: "type changed", kind: "modified" };
    default: return { code: c || "•", label: "modified", kind: "modified" };
  }
}

// Remote URL (ssh/scp/https) → { url, host, projectPath, webUrl, isGitlab, hostWithPort }.
// `hostWithPort`: the host, LOWERCASE, with the port of an http(s) address — the key of the helper
// `credential.https://<host[:port]>.helper` (git compares the port when matching). Without a port, or for ssh/scp, the
// same as the lowercase host.
// Exported: the check of a clone address (projectbox/setup/clone.js checkCloneDetail) compares `URL.hostname` with `host`
// (different ⇒ HOST_UNCLEAR). `host` is LOWERCASE (that is how the credentials are stored, store/workspaces.js getGitCred
// looks up exactly — a `Git.Example.com` in the remote never found its credentials), and `url` carries NO user info outward
// (`https://oauth2:<token>@host/…` would show in `info.remote.url` of the git view, in the web client's tooltip): for an
// address with a scheme everything between `//` and the last `@` of the authority is dropped; scp-like (`git@host:path`)
// stays — the user of the ssh address is no credential, and without it the address would be a different one.
export function parseRemote(url) {
  if (!url) return null;
  let host = "", projectPath = "", port = "";
  let m = url.match(/^git@([^:]+):(.+?)(?:\.git)?\/?$/); // scp-like: git@host:group/proj.git
  if (m) { host = m[1]; projectPath = m[2]; }
  else if ((m = url.match(/^ssh:\/\/git@([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/))) { host = m[1]; projectPath = m[2]; }
  else if ((m = url.match(/^https?:\/\/(?:[^@/]+@)?([^/:]+)(?::(\d+))?\/(.+?)(?:\.git)?\/?$/))) { host = m[1]; port = m[2] || ""; projectPath = m[3]; }
  host = host.toLowerCase();
  const isGitlab = !!host && (/gitlab/i.test(host) || /(^|\.)git\./i.test(host));
  const webUrl = host && projectPath ? `https://${host}/${projectPath}` : "";
  const hostWithPort = host ? `${host}${port ? `:${port}` : ""}` : "";
  return { url: withoutUser(url), host, projectPath, webUrl, isGitlab, hostWithPort };
}
// An address with a scheme without user info (see parseRemote); without a scheme unchanged.
function withoutUser(url) {
  const m = String(url).match(/^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)(.*)$/is);
  if (!m) return url;
  const at = m[2].lastIndexOf("@");
  return at < 0 ? url : `${m[1]}${m[2].slice(at + 1)}${m[3]}`;
}

// ── The project repo ─────────────────────────────────────────────────────────────────────────
// On relocation cbase puts a local git into a project folder that is not itself a repo (projectbox/projectrepo.js). It
// versions what lies NEXT to the code repos and is itself NOT a code repo: no place that searches repos may mistake it for
// one — otherwise the git view, the worktree sheet and `chooseRepo` would see only this one (it encloses all others), and a
// subagent would branch it off. Recognized by its mark: `.git` is a DIRECTORY (no worktree pointer, no link), and
// `.git/config` carries `cbase.projectRepo = true`. A leaf over the file system (only node:*) so the synchronous places can
// ask too (okf.js findRepoRoot; providers/agent-runtime.js chooseRepo only without an instance — with an instance git asks
// inside the project container). Without the mark every place behaves as before.
export const PROJECT_REPO_SECTION = "cbase";
export const PROJECT_REPO_KEY = "projectRepo";

// A truth value by git's rules (`git config --bool`): a key without "=" is true, otherwise true/yes/on or a number ≠ 0
// (case-insensitive); everything else — also empty — is false.
function gitTrue(value) {
  if (value === null) return true;
  const v = value.trim().toLowerCase();
  if (v === "true" || v === "yes" || v === "on") return true;
  return /^[+-]?\d+$/.test(v) && Number(v) !== 0;
}

// The value of a key `<section>.<key>` (no subsection) from the text of a git config: `undefined` if missing; otherwise the
// LAST value (the last wins in git), `null` for a key without "=". Section and key names case-insensitive;
// `[section] key = value` on one line works too.
function configValue(text, section, key) {
  let inside = false;
  let found = undefined;
  for (const rawText of String(text).split(/\r?\n/)) {
    let z = rawText.trim();
    if (!z || z[0] === "#" || z[0] === ";") continue;
    const header = /^\[\s*([A-Za-z0-9.-]+)\s*("(?:[^"\\]|\\.)*")?\s*\](.*)$/.exec(z);
    if (header) {
      inside = header[1].toLowerCase() === section && !header[2];
      z = header[3].trim();
      if (!z || z[0] === "#" || z[0] === ";") continue;
    }
    if (!inside) continue;
    const row = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=(.*))?$/.exec(z);
    if (!row || row[1].toLowerCase() !== key.toLowerCase()) continue;
    if (row[2] === undefined) { found = null; continue; }
    // Drop a comment behind the value and quotes (enough for a truth value).
    found = row[2].replace(/[#;].*$/, "").replace(/"/g, "").trim();
  }
  return found;
}

/** Is `dir` the root of a project repo? Never throws: unreadable or without a `.git` directory ⇒ false.
 *  `{ safe: true, anchor }` for a repo a project container can write to (relocated project, worktree in the runtime
 *  folder): a FIFO at `.git/config` would stop B's event loop (readFileSync waits for a writer), a link there would read a
 *  file of B. Read then via runtime/real-path.js openFileWithoutReference — `.git` opened and checked within the range of
 *  `dir` (via `anchor`, the folder the search started from: a link between it and `dir` does not count), `config` with
 *  O_NOFOLLOW|O_NONBLOCK and only as a regular file; anything else means "no project repo". A `config` above CONFIG_CAP bytes
 *  is not read (fstat BEFORE reading: a 1.9 GB file stopped B's event loop) — "no project repo", with a log line naming the cap.
 *  Without `safe` the plain call. With an instance okf.js (findRepoRoot) and projectbox/projectrepo.js ask with `safe`;
 *  providers/agent-runtime.js (chooseRepo) does not read in B at all with an instance, there git asks the mark inside the
 *  project container. */
export const CONFIG_CAP = 4 * 1024 * 1024; // ESTIMATED, NOT MEASURED: a `.git/config` has a few KB
export function isProjectRepo(dir, { safe = false, anchor = null } = {}) {
  if (!dir) return false;
  try {
    const gitDir = path.join(dir, ".git");
    if (!fs.lstatSync(gitDir).isDirectory()) return false;
    const config = path.join(gitDir, "config");
    const text = safe ? readWithoutReference(config, realRoots([dir], anchor ? [anchor] : [])) : fs.readFileSync(config, "utf8");
    const value = configValue(text, PROJECT_REPO_SECTION, PROJECT_REPO_KEY);
    return value !== undefined && gitTrue(value);
  } catch { return false; }
}
function readWithoutReference(file, realW) {
  const fd = openFileWithoutReference(file, realW);
  try {
    const size = fs.fstatSync(fd).size;
    if (size > CONFIG_CAP) {
      console.warn(`[git] ${file}: ${size} bytes — cap ${CONFIG_CAP} (estimated, not measured) reached, not read; counts as no project repo`);
      throw Object.assign(new Error(`${file}: larger than ${CONFIG_CAP} bytes`), { code: "ECAP" });
    }
    const buffer = Buffer.allocUnsafe(size + 1);
    let n = 0;
    for (let k; n < buffer.length && (k = fs.readSync(fd, buffer, n, buffer.length - n, n)) > 0;) n += k;
    if (n > size) throw new Error(`${file}: grew while reading`); // never a half-read config
    return buffer.toString("utf8", 0, n);
  } finally { fs.closeSync(fd); }
}

/** Read a file under `<dir>/.git/` — through the same reading WITHOUT links as isProjectRepo `safe` (FIFO, link, cap
 *  CONFIG_CAP). For the timeline links (timeline/links.js: `config` for the remote, `packed-refs`/`refs/…` for a branch),
 *  without git and without waking. `rel` is relative to `.git` (no `..`, not absolute). → text or null (no `.git` directory,
 *  no such path, unreadable). Never throws. */
export function readGitFile(dir, rel, { anchor = null } = {}) {
  const r = String(rel ?? "");
  if (!dir || !r || path.isAbsolute(r) || r.split(/[\\/]/).some((t) => !t || t === "." || t === "..") || r.includes("\0")) return null;
  try {
    const gitDir = path.join(dir, ".git");
    if (!fs.lstatSync(gitDir).isDirectory()) return null;
    return readWithoutReference(path.join(gitDir, r), realRoots([dir], anchor ? [anchor] : []));
  } catch { return null; }
}

// Directories the repo scan does not descend into (ballast/foreign code). Exported: the rules of setup and outline
// (projectbox/setup/rules.js) use the SAME limits as findRepos — a code repo in a place the search does not see would
// silently be missing from the git tab, worktree choice and graph worktrees.
export const SCAN_SKIP = new Set([
  "node_modules", ".git", "dist", "build", ".next", "out", "target", "vendor",
  ".venv", "venv", "__pycache__", ".cache", "coverage", ".turbo", ".idea", ".vscode", ".svn", ".hg",
]);
export const SCAN_MAX_DEPTH = 4; // how deep below the project folder repos are searched
export const SCAN_MAX_REPOS = 25; // upper limit so huge trees do not blow up the sidebar

// PURE: would findRepos see a repo at `rel` (relative to the root, `/` as separator)? The same computation as the walk below:
// every path part without a leading dot and not in SCAN_SKIP, at most SCAN_MAX_DEPTH parts; the root itself ("") yes. The
// SCAN_MAX_REPOS limit and "no repo above" (the search does not descend into a repo) are checked by the caller — they depend
// on the whole tree, not on one place.
export function repoLocationVisible(rel, { maxDepth = SCAN_MAX_DEPTH } = {}) {
  const r = String(rel ?? "").replace(/^\/+|\/+$/g, "");
  if (!r) return true;
  const parts = r.split("/");
  if (parts.length > maxDepth) return false;
  return parts.every((t) => Boolean(t) && !t.startsWith(".") && !SCAN_SKIP.has(t));
}

// Find nested git repos under rootPath. As soon as a directory contains a `.git` (directory OR file — worktrees/submodules)
// it counts as a repo root and is NOT descended into (nested submodules stay out). Exception: the project repo is no code
// repo — the walk continues below its root. Exported for the relocation plan (projectbox/relocation/collect.js): "beyond the
// findRepos limits" is a question to EXACTLY this search, not to a rebuild of its limits. `safe(dir)`: true for a folder of
// a relocated project — there isProjectRepo asks without following links, with `rootPath` as anchor (the search never
// descends through a link, so a folder found has none below it). Without `safe` the plain question.
export function findRepos(rootPath, { maxDepth = SCAN_MAX_DEPTH, maxRepos = SCAN_MAX_REPOS, safe = null } = {}) {
  const found = [];
  const walk = (dir, depth) => {
    if (found.length >= maxRepos) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    if (entries.some((e) => e.name === ".git") && !isProjectRepo(dir, safe?.(dir) ? { safe: true, anchor: rootPath } : undefined)) {
      found.push(dir);
      return;
    }
    if (depth >= maxDepth) return;
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".") || SCAN_SKIP.has(e.name)) continue;
      walk(path.join(dir, e.name), depth + 1);
      if (found.length >= maxRepos) return;
    }
  };
  walk(rootPath, 0);
  return found;
}

// The read commands of the git view per repo: ONE list for both paths — `readRepoInfo` asks them one by one (in B via the
// plain starter, with an instance through `readBundle` from the result of ONE call in the project container). A command
// missing here cannot be answered in the bundle: `readBundle` throws "not bundled" for it.
export const READ_COMMANDS = Object.freeze({
  branch: Object.freeze(["symbolic-ref", "--quiet", "--short", "HEAD"]),
  short: Object.freeze(["rev-parse", "--short", "HEAD"]),
  upstream: Object.freeze(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]),
  gap: Object.freeze(["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]),
  // `-z`: without it git quoted every path with spaces, quotes, backslash, tab or — via `core.quotePath` — non-ASCII ("ü.txt"
  // read `"\303\274.txt"`); stripping the quotes left the escapes, and every way with that path (diff, stage, files/read)
  // asked for a file that does not exist. A path with " -> " also broke at the rename separator. With `-z` every path
  // stands raw (parseStatusZ).
  status: Object.freeze(["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
  last: Object.freeze(["log", "-1", `--pretty=format:%h${US}%s${US}%an${US}%ct`]),
  remote: Object.freeze(["remote", "get-url", "origin"]),
});

/** `git status --porcelain=v1 -z` → `[{ x, y, path }]` (pure, exported for the guard). Every entry is "XY <path>",
 *  NUL-separated, without quoting; a rename or copy (R/C on either side) carries its OLD path as a separate field behind it —
 *  it is skipped, `path` is the new one. A remainder without "XY " (the trailing NUL) is no entry. */
export function parseStatusZ(out) {
  const parts = String(out ?? "").split("\0");
  const result = [];
  for (let i = 0; i < parts.length; i++) {
    const z = parts[i];
    if (z.length < 4 || z[2] !== " ") continue;
    const x = z[0], y = z[1];
    result.push({ x, y, path: z.slice(3) });
    if (x === "R" || x === "C" || y === "R" || y === "C") i += 1;
  }
  return result;
}

// Git info of an already known repo root directory (branch, status, last commit, remote). Does not throw — single queries
// fail silently, EXCEPT the status ("empty is not unknown"): a failed `git status` (unreadable or broken index, output cap)
// used to be `clean: true` with zero changes — the view showed "clean". Now `clean: false`, `counts: null` (unknown, not zero)
// and `statusError` with the reason; web (GitSidebar) and iOS (GitPane) show it instead of "clean". Guard:
// server/backend/test/projectbox-git.test.js "(W2)".
// `run(args)`: where the answer of a read command comes from — by default the plain way (`git` in B), the status there with
// the cap STATUS_OUTPUT.
async function readRepoInfo(root, run = (args) => git(root, [...args], args === READ_COMMANDS.status ? { maxBuffer: STATUS_OUTPUT } : {})) {
  const info = { root };

  // Branch (or short SHA on a detached HEAD)
  try {
    info.branch = (await run(READ_COMMANDS.branch)).trim();
    info.detached = false;
  } catch {
    info.detached = true;
    try { info.branch = (await run(READ_COMMANDS.short)).trim(); }
    catch { info.branch = ""; }
  }

  // Upstream + ahead/behind
  info.upstream = null; info.ahead = 0; info.behind = 0;
  try {
    info.upstream = (await run(READ_COMMANDS.upstream)).trim();
    const lr = (await run(READ_COMMANDS.gap)).trim();
    const [behind, ahead] = lr.split(/\s+/).map((n) => parseInt(n, 10) || 0);
    info.behind = behind; info.ahead = ahead;
  } catch { /* no upstream set */ }

  // Work-tree status — "clean" only once the status is READ (see header).
  info.changes = []; info.counts = null; info.clean = false; info.truncated = false;
  try {
    const out = await run(READ_COMMANDS.status);
    const lines = parseStatusZ(out); // a rename is ONE entry (its target path)
    let staged = 0, unstaged = 0, untracked = 0;
    for (const { x, y, path: p } of lines) {
      if (x === "?" && y === "?") untracked++;
      else { if (x !== " ") staged++; if (y !== " ") unstaged++; }
      if (info.changes.length < MAX_CHANGES) info.changes.push({ x, y, path: p, ...classify(x, y) });
    }
    info.counts = { staged, unstaged, untracked, total: lines.length };
    info.clean = lines.length === 0;
    info.truncated = lines.length > info.changes.length;
  } catch (e) {
    // Status not readable: unknown, not "clean". A stopped container is no status error of a repo — it does not get this far
    // in the bundle (readBundle throws earlier, readGitTree names the instance under `projects`).
    info.changes = [];
    info.statusError = e?.cap === "output"
      ? T`Status not read: the output of git status exceeds the cap of ${STATUS_OUTPUT / 1048576} MiB (estimated, not measured).`
      : T`Status not readable: ${String(e?.message || e).split("\n")[0].slice(0, 300)}`;
  }

  // Last commit
  try {
    const out = (await run(READ_COMMANDS.last)).trim();
    if (out) {
      const [hash, subject, author, ct] = out.split(US);
      info.lastCommit = { hash, subject, author, relative: relativeDe(parseInt(ct, 10) || 0) };
    }
  } catch { /* e.g. repo without commits */ }

  // Remote (origin)
  info.remote = null;
  try {
    const url = (await run(READ_COMMANDS.remote)).trim();
    info.remote = parseRemote(url);
  } catch { /* no origin remote */ }

  return info;
}

// The repos of a project: the repo of the project folder itself, OR — if the folder is no repo — the repos nested in it (e.g.
// frontend/, backend/). Returns: [{ name, relPath, root }] in git-tree order; no repo/git → []. ONE resolution for the git
// tree (readGitTree) and a subagent's worktree (runs/agents.js repoCandidates, also for the worktree in a workflow).
export async function projectRepos(projectPath, opts = {}) {
  if (!projectPath || !fs.existsSync(projectPath)) return [];
  let selfRoot = null;
  // The question "is the folder inside a repo?" runs in the project container when there is an instance. The instance BEFORE the
  // try: an unreadable one (it throws) is not "no repo" — it fails visibly.
  const itself = instanceFrom(opts, projectPath);
  if (copyNameOf(itself)) return copyRepos(projectPath, itself); // the repos of the snapshot, never the search in B
  try { selfRoot = (await git(projectPath, ["rev-parse", "--show-toplevel"], { instance: itself })).trim(); } catch { /* no repo */ }
  return projectReposWithRoot(projectPath, selfRoot, opts);
}

/**
 * The part of projectRepos AFTER the question "is the project folder inside a repo?" — `selfRoot` is its answer
 * (`git rev-parse --show-toplevel` in the project folder, null = no repo). Synchronous, without git: only the file system
 * (findRepos, isProjectRepo). The tree (projectbox/instances-tree.js) asks the question in the SAME `docker exec` as
 * `docker ps` and the status lines — a call of its own cost ≈ 85 ms CPU in B per instance. Does not apply to a copy (its
 * repos come from the snapshot, see projectRepos).
 */
export function projectReposWithRoot(projectPath, selfRoot, opts = {}) {
  // Only the question "relocated?" — nothing starts here (no git, only the file system), hence no start place
  // (server/backend/test/in-project-start-places.test.js counts the one in projectRepos).
  const converted = Boolean(instanceFrom(opts, projectPath));
  // The project repo counts as "no repo": the search goes below it, after the code repos. For a relocated project it is read
  // without following links, the project folder as anchor.
  const safe = (d) => converted || safeOn(opts, d);
  if (selfRoot && isProjectRepo(selfRoot, safe(selfRoot) ? { safe: true, anchor: projectPath } : undefined)) selfRoot = null;
  // Project folder is (part of) a repo → this one; otherwise search for nested repos.
  const roots = selfRoot ? [selfRoot] : findRepos(projectPath, { safe });
  return roots.map((root) => {
    let rel = path.relative(projectPath, root);
    if (rel === "" || rel.startsWith("..")) rel = ""; // repo = the project folder itself (or above it)
    const name = rel === "" ? (path.basename(root) || root) : rel;
    return { name, relPath: rel, root };
  }).sort((a, b) => (a.relPath || "").localeCompare(b.relPath || "") || a.name.localeCompare(b.name));
}

// ── The read bundle ───────────────────────────────────────────────────────────────────────────
// The read commands of ALL repos of an instance in ONE call in the project container (otherwise a view cost up to 25 × 7
// `docker exec`, measured 83 ms per call): a fixed `sh -c` script, the repos as arguments, after the output of each command
// a separator line `\n<marker> <repo> <command> <exit>\n` with a marker random per call. The output of a command is exactly
// the text before its separator line (the script adds the `\n` before it itself). stderr is dropped — `readRepoInfo` needs
// only output and success. Parsed by the SAME `readRepoInfo` as in B.
const BUNDLE_NAMES = Object.keys(READ_COMMANDS);
const shWord = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
export const BUNDLE_SCRIPT = [
  "m=$1; shift; i=0",
  "for r in \"$@\"; do",
  ...BUNDLE_NAMES.map((n, j) => `  (cd "$r" && exec git ${readingArgs(READ_COMMANDS[n]).map(shWord).join(" ")}) 2>/dev/null; printf '\\n%s %s %s %s\\n' "$m" "$i" ${j} "$?"`),
  "  i=$((i+1))",
  "done",
].join("\n");

// → Map root → `run(args)` for readRepoInfo. Throws if the call itself fails (container stopped, cap): `err.instance`,
// `err.stderr`.
async function readBundle(inst, roots) {
  const marker = `cbase-${crypto.randomBytes(8).toString("hex")}`;
  const commands = BUNDLE_NAMES.length * roots.length;
  // `-w /`: the script changes per repo itself (`cd "$r"`). The working folder used to be `roots[0]` — on the workspace level
  // that can be a linked worktree OUTSIDE the project (it belongs via its shared git directory and sorts first) that the
  // container has not mounted: then the whole call failed.
  const r = await commandRun(inst, "/", "sh", ["-c", BUNDLE_SCRIPT, "sh", marker, ...roots], {
    env: { GIT_TERMINAL_PROMPT: "0" },
    timeout: Math.min(GIT_RUN_CAP_MS, 6000 * commands),
    // Per repo the cap as before, plus ONCE the room for a large status — no multiple, because the project container writes the
    // output and B holds it entirely in memory. If the cap hits, the bundle throws (visible under `projects`).
    maxBuffer: GIT_OUTPUT * roots.length + (STATUS_OUTPUT - GIT_OUTPUT),
  });
  if (r.code !== 0) {
    const e = new Error(String(r.stderr || "").trim() || `Read bundle in the project container: exit ${r.code}`);
    e.instance = inst;
    e.stderr = r.stderr;
    throw e;
  }
  const values = roots.map(() => new Map());
  const re = new RegExp(`\\n${marker} (\\d+) (\\d+) (\\d+)\\n`, "g");
  let fromIdx = 0;
  for (const t of r.stdout.matchAll(re)) {
    const target = values[Number(t[1])];
    const name = BUNDLE_NAMES[Number(t[2])];
    if (target && name) target.set(READ_COMMANDS[name], { code: Number(t[3]), stdout: r.stdout.slice(fromIdx, t.index) });
    fromIdx = t.index + t[0].length;
  }
  const out = new Map();
  roots.forEach((root, i) => {
    out.set(root, async (args) => {
      const x = values[i].get(args);
      if (!x) throw new Error(`Read bundle: "git ${args.join(" ")}" is not bundled (git.js READ_COMMANDS)`);
      if (x.code !== 0) { const e = new Error(`git ${args[0]}: exit ${x.code}`); e.code = x.code; e.stdout = x.stdout; throw e; }
      return x.stdout;
    });
  });
  return out;
}

// The entry under `projects` names the instance when it is a copy (the waker wakes THAT one) — otherwise it stays as it was.
const copyField = (inst) => (copyNameOf(inst) ? { instance: copyNameOf(inst) } : {});

// All repos relevant for a project (projectRepos) with their git info.
// Returns: { repos: [{ name, relPath, ...info }] }. No repo/git → { repos: [] }.
// With an instance ONE read bundle per instance. An instance that `opts.situation(inst)` reports as not ready (a turn's lock:
// "project is starting") or whose bundle fails appears with its reason under `projects` instead of silently missing; its
// repos are then missing from `repos`. Without an instance the field is absent, the answer is the plain one.
export async function readGitTree(projectPath, opts = {}) {
  // A FIXED instance (project level) that is not ready: no call in the container, not even the question for the repo.
  if (opts.instance && typeof opts.situation === "function") {
    const situation = opts.situation(opts.instance);
    if (situation) return { repos: [], projects: [{ projectId: opts.instance.projectId, ...copyField(opts.instance), ...situation }] };
  }
  const list = await projectRepos(projectPath, opts);
  const inB = [];
  const groups = new Map(); // identifier → { inst, entries }
  for (const e of list) {
    const inst = instanceFrom(opts, e.root);
    if (!inst) { inB.push(e); continue; }
    const k = inst.identifier || `${inst.projectId}/${inst.instance || "main"}`;
    if (!groups.has(k)) groups.set(k, { inst, entries: [] });
    groups.get(k).entries.push(e);
  }
  const read = (entries, runOf) => Promise.all(entries.map(async ({ name, relPath, root }) => {
    try {
      const info = runOf ? await readRepoInfo(root, runOf(root)) : await readRepoInfo(root);
      return { name, relPath, ...info };
    } catch { return null; }
  }));
  const projects = [];
  const parts = [read(inB, null)];
  for (const { inst, entries } of groups.values()) {
    const situation = typeof opts.situation === "function" ? opts.situation(inst) : null;
    if (situation) { projects.push({ projectId: inst.projectId, ...copyField(inst), ...situation }); continue; }
    parts.push(readBundle(inst, entries.map((e) => e.root)).then(
      (runs) => read(entries, (root) => runs.get(root)),
      (e) => { projects.push({ projectId: inst.projectId, ...copyField(inst), error: String(e?.message || e) }); return []; }));
  }
  const repos = (await Promise.all(parts)).flat().filter(Boolean);

  repos.sort((a, b) => (a.relPath || "").localeCompare(b.relPath || "") || a.name.localeCompare(b.name));
  return projects.length ? { repos, projects } : { repos };
}

// ── Ignored by git ─────────────────────────────────────────────────────────────────────────────
// The explorer dims what git ignores (VS Code `gitDecoration.ignoredResourceForeground`). A `--ignored` on the git view's status
// (READ_COMMANDS.status, `--untracked-files=all`) would name EVERY file under `node_modules` — hence a SEPARATE call only the
// explorer makes (`GET …/git/ignored`, devtools/code-route.js) and only on occasion (load, refresh, after a file action), never
// on the git view's beat: `ls-files --others --ignored --exclude-standard --directory` names a fully ignored folder ONCE, with
// a trailing "/". Capped at IGNORED_CAP entries per repo, `clipped` says there were more (a cap that says so). Run in the
// project folder when it is itself the repo (`relPath` ""), otherwise in the root of the nested repo — the paths then stand
// relative to the folder the tree shows, even when the repo root lies ABOVE the project. With an instance git runs in the
// project container like every call of this file (`git` → runtime/git-run.js); an instance that is not ready appears under
// `projects` as in readGitTree. A repo whose call fails carries `ignored: null` (unknown — never "nothing ignored").
// `--directory` also names a folder that holds only IGNORED files (`logs/` for `*.log`) although the folder itself is not
// ignored (then `logs/` AND `logs/a.log` are in the list) — so every folder entry is confirmed with `git check-ignore` (ONE
// call per repo, only if there are folder entries; exit 1 means "none"); an unconfirmed one is dropped (its files stand
// individually), and if the confirmation fails all folder entries are dropped (never a folder dimmed that is not ignored).
// Guard: server/backend/test/git-ignored.test.js.
export const IGNORED_COMMAND = Object.freeze(["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"]);
export const IGNORED_CAP = 2000;
/** The NUL-separated output of IGNORED_COMMAND → `{ ignored, clipped }` (pure, exported for the guard). */
export function parseIgnored(out, cap = IGNORED_CAP) {
  const all = String(out ?? "").split("\0").filter((x) => x !== "");
  return { ignored: all.slice(0, cap), clipped: all.length > cap };
}
export async function gitIgnored(projectPath, opts = {}) {
  if (opts.instance && typeof opts.situation === "function") {
    const situation = opts.situation(opts.instance);
    if (situation) return { repos: [], projects: [{ projectId: opts.instance.projectId, ...copyField(opts.instance), ...situation }] };
  }
  const list = await projectRepos(projectPath, opts);
  const projects = [];
  const repos = (await Promise.all(list.map(async ({ relPath, root }) => {
    const ignoredInstance = instanceFrom(opts, root);
    const situation = ignoredInstance && typeof opts.situation === "function" ? opts.situation(ignoredInstance) : null;
    if (situation) { projects.push({ projectId: ignoredInstance.projectId, ...copyField(ignoredInstance), ...situation }); return null; }
    try {
      const location = relPath ? root : projectPath;
      const out = await git(location, [...IGNORED_COMMAND], { instance: ignoredInstance, maxBuffer: GIT_OUTPUT });
      const list = parseIgnored(out);
      const folder = list.ignored.filter((x) => x.endsWith("/"));
      if (folder.length) {
        let confirmed = new Set();
        try { confirmed = new Set((await git(location, ["check-ignore", "--", ...folder], { instance: ignoredInstance, maxBuffer: GIT_OUTPUT })).split("\n").filter(Boolean)); } catch (e) {
          if (e?.containerStands || e?.containerPaused) throw e;
          confirmed = new Set(); // exit 1: none is ignored; another error: unconfirmed — no folder counts as ignored
        }
        list.ignored = list.ignored.filter((x) => !x.endsWith("/") || confirmed.has(x));
      }
      return { relPath, ...list };
    } catch (e) {
      if (e?.containerStands || e?.containerPaused) {
        projects.push({ projectId: ignoredInstance?.projectId, ...copyField(ignoredInstance), error: String(e?.message || e) });
        return null;
      }
      return { relPath, ignored: null, clipped: false };
    }
  }))).filter(Boolean);
  repos.sort((a, b) => (a.relPath || "").localeCompare(b.relPath || ""));
  return projects.length ? { repos, projects } : { repos };
}

// ── Actions (commit / push / checkout) ───────────────────────────────────────
// Resolve the repo root from project path + relPath. relPath is the path relative to the project that readGitTree delivers
// ("" = the project folder itself). Prevents path escape (no "..", not absolute, must lie inside the project).
async function resolveRepoRoot(projectPath, relPath, opts = {}) {
  const rel = String(relPath || "");
  if (rel.includes("..") || path.isAbsolute(rel)) throw new Error(T("Invalid repo path"));
  const candidate = rel ? path.join(projectPath, rel) : projectPath;
  if (rel) {
    const base = path.resolve(projectPath);
    const resolved = path.resolve(candidate);
    if (resolved !== base && !resolved.startsWith(base + path.sep)) throw new Error(T("Repo path outside the project"));
  }
  let root;
  // The situation BEFORE the first docker call; a stopped container stays a stopped container (not "no repo").
  const inst = instanceFrom(opts, candidate);
  checkSituation(inst, opts);
  try { root = (await git(candidate, ["rev-parse", "--show-toplevel"], { instance: inst })).trim(); }
  catch (e) { if (e?.containerStands || e?.containerPaused) throw e; throw new Error(T("No git repository at this path")); }
  if (!root) throw new Error(T("No git repository at this path"));
  // The project repo is no target of the git actions: `relPath ""` (or a folder next to the code repos) would hit it as soon
  // as the project folder is its root — the git view does not show it, so it does not act in it either.
  const safe = Boolean(inst) || safeOn(opts, root); // for a relocated project read without following links
  if (isProjectRepo(root, safe ? { safe: true, anchor: projectPath } : undefined)) throw new Error(T("No git repository at this path (cbase keeps the project repository itself; it is not a code repository)"));
  return root;
}

// The repo of an action — the root with the starters bound to its instance. Every action begins with
// `const { root, git, raw, … } = await repoAt(projectPath, relPath, opts)`: the local `git`/`raw`/`gitStdin`/`pushRepo`
// SHADOW the module starters with the same signature and carry the repo's instance. Without an instance they are the module
// starters themselves. The instance applies to the ROOT (workspace level: a repo under the folder of a relocated project,
// `opts.instanceFor`), not to the path the search started from. With an instance the access goes ONLY in list form to the
// host of the remote (`auth.host` — origin, with port, lowercase; set by workspaces/git-auth.js gitAuthCtx). Without a host no
// host gets the token (never a hostless helper with a value, runtime/git-run.js). Without an instance as before via askpass.
const accessList = (auth) => (auth?.username && auth?.host ? [{ host: auth.host, access: auth }] : []);
async function repoAt(projectPath, relPath, opts = {}) {
  const root = await resolveRepoRoot(projectPath, relPath, opts);
  const instance = instanceFrom(opts, root);
  const access = (auth) => (instance ? accessAsEnvironment(accessList(auth)) : authEnv(auth));
  if (!instance) return { root, instance, access, git, raw, gitStdin, pushRepo };
  const including = (o) => ({ ...(o || {}), instance });
  const g = (cwd, args, o) => git(cwd, args, including(o));
  return {
    root, instance, access, git: g,
    raw: (cwd, args, o) => raw(cwd, args, including(o)),
    gitStdin: (cwd, args, input, o) => gitStdin(cwd, args, input, including(o)),
    pushRepo: (r, env) => pushRepo(r, env, g),
  };
}

// Local + remote branches of a repo + current branch.
export async function listBranches(projectPath, relPath, opts = {}) {
  const { root, git } = await repoAt(projectPath, relPath, opts);
  let current = "";
  try { current = (await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"])).trim(); } catch { /* detached */ }
  const locals = (await git(root, ["branch", "--format=%(refname:short)"]))
    .split("\n").map((s) => s.trim()).filter(Boolean);
  let remotes = [];
  try {
    remotes = (await git(root, ["branch", "-r", "--format=%(refname:short)"]))
      .split("\n").map((s) => s.trim()).filter(Boolean).filter((r) => !r.endsWith("/HEAD"));
  } catch { /* no remotes */ }
  return { current, locals, remotes };
}

// Commit. opts.all → stage EVERYTHING first (add -A); otherwise the already staged changes are committed (VS Code behavior).
// opts.push → push afterwards. opts.amend → the last commit is amended: with a message it gets the new one, without it keeps
// its own (`--no-edit`, otherwise git would wait for an editor the server does not have). Only without amend is a missing
// message an error — the route's answer shape stays the same in both cases.
export async function gitCommit(projectPath, relPath, message, opts = {}) {
  const { root, git, pushRepo, access } = await repoAt(projectPath, relPath, opts);
  const msg = String(message || "").trim();
  if (!msg && !opts.amend) throw new Error(T("Commit message missing"));
  if (opts.all) await git(root, ["add", "-A"]);
  await git(root, opts.amend ? ["commit", "--amend", ...(msg ? ["-m", msg] : ["--no-edit"])] : ["commit", "-m", msg]);
  if (opts.push) await pushRepo(root, access(opts.auth));
  return { ok: true };
}

// ── Staging / Diff / Sync ───────────────────────────────────────────────────
export async function gitStage(projectPath, relPath, files, opts = {}) {
  const { root, git } = await repoAt(projectPath, relPath, opts);
  const list = files === "all" ? null : (Array.isArray(files) ? files : [files]).filter(Boolean);
  if (!list || !list.length) await git(root, ["add", "-A"]);
  else await git(root, ["add", "--", ...list]);
  return { ok: true };
}
export async function gitUnstage(projectPath, relPath, files, opts = {}) {
  const { root, git } = await repoAt(projectPath, relPath, opts);
  const list = files === "all" ? null : (Array.isArray(files) ? files : [files]).filter(Boolean);
  if (!list || !list.length) await git(root, ["reset", "-q"]); // take everything out of the index
  else await git(root, ["restore", "--staged", "--", ...list]).catch(() => git(root, ["reset", "-q", "HEAD", "--", ...list]));
  return { ok: true };
}
// Discard the changes of a file (back to HEAD); untracked → delete the file.
export async function gitDiscard(projectPath, relPath, file, opts = {}) {
  const { root, git, instance } = await repoAt(projectPath, relPath, opts);
  // opts.all → all UNSTAGED changes at once (the head of the "Changes" group): the work tree back to the index, untracked
  // files gone — like VS Code's "Discard All Changes". Staged stays. One call instead of one per file, because every answer is
  // a full `git status`.
  if (opts.all) {
    // `checkout -- .` fails on an EMPTY index ("pathspec '.' did not match" — fresh repo without a commit, only untracked
    // files, exactly the case in which the group head appears), and `clean` would then never run: 400, nothing discarded. So it
    // is reset only if the work tree differs from the index; the list is as big as the status, not as the repo, and `diff` needs
    // neither HEAD nor entries.
    if ((await git(root, ["diff", "--name-only"])).trim()) await git(root, ["checkout", "--", "."]);
    await git(root, ["clean", "-fd"]);
    return { ok: true };
  }
  const f = String(file || "");
  if (!f) throw new Error(T("No file given"));
  if (opts.untracked) {
    const abs = path.resolve(root, f);
    if (abs !== path.resolve(root) && !abs.startsWith(path.resolve(root) + path.sep)) throw new Error(T("Path outside the repo"));
    // With an instance the project container deletes (same semantics as rmSync: recursive, missing is no error) — the check
    // above is only lexical, and the deletion follows a symlink as an intermediate. Without an instance as before.
    if (instance) {
      const r = await commandRun(instance, root, "rm", ["-rf", "--", abs]);
      if (r.code !== 0) throw withStatus(new Error(String(r.stderr || "").trim() || `rm: exit ${r.code}`), instance, r);
    } else {
      fs.rmSync(abs, { recursive: true, force: true });
    }
  } else {
    await git(root, ["checkout", "HEAD", "--", f]).catch(() => git(root, ["restore", "--staged", "--worktree", "--", f]));
  }
  return { ok: true };
}
// Unified diff of a file (staged or work tree; untracked → everything as an addition). `content: true` (the diff tab): in
// addition the text of both sides, a hardened diff and a cap — see "Content of both sides" below; without the option unchanged.
export async function gitDiff(projectPath, relPath, file, opts = {}) {
  if (opts.content != null) return gitDiffWithContent(projectPath, relPath, file, opts);
  const { root, raw } = await repoAt(projectPath, relPath, opts);
  const f = String(file || "");
  if (!f) throw new Error(T("No file given"));
  let diff;
  if (opts.staged) {
    diff = await raw(root, ["diff", "--staged", "--", f]);
  } else {
    diff = await raw(root, ["diff", "--", f]);
    if (!diff.trim()) diff = await raw(root, ["diff", "--no-index", "--", "/dev/null", f]);
  }
  return { path: f, staged: !!opts.staged, diff };
}
// With an instance the pull afterwards fetches the LFS files — in the project container the image default
// `GIT_LFS_SKIP_SMUDGE=1` would otherwise leave pointers. A repo without an LFS file asks for nothing (neither does a
// container without git-lfs, as long as no file carries `filter=lfs`); if the fetch fails, the pull throws with its own message
// (the changes are already there — only the big files are missing). Without an instance the plain pull.
// With an instance AND `opts.accessesFor` (devtools/code-route.js, from the workspace's accesses — like gitSubmoduleUpdate) pull
// and fetch get the accesses of ALL hosts the repo networks to (remotes and submodules, networkHosts `{ submodule: true }`:
// git fetches submodules `on-demand` along with the fetch), the LFS fetch afterwards those of the hosts from remotes and
// `.lfsconfig` (networkHosts `{ lfs: true }`, read AFTER the pull — it can bring a `.lfsconfig`; like runs/git-post-work.js
// lfsInWorktree). Each token only to its host (list form), the origin remote's host first. Without `accessesFor` only the
// remote's host as before. push stays with the remote's host (gitPush).
async function networkAccess(instance, root, auth, opts, kind) {
  const list = accessList(auth);
  if (!instance || typeof opts?.accessesFor !== "function") return accessAsEnvironment(list);
  const hosts = await networkHosts(instance, root, kind);
  return accessAsEnvironment([...list, ...(opts.accessesFor(hosts) || [])]);
}
export async function gitPull(projectPath, relPath, auth, opts = {}) {
  const { root, git, access, instance } = await repoAt(projectPath, relPath, opts);
  await git(root, ["pull"], { timeout: 90000, env: instance ? await networkAccess(instance, root, auth, opts, { submodule: true }) : access(auth) });
  if (instance) {
    const l = await lfsFetch(instance, root, { env: await networkAccess(instance, root, auth, opts, { lfs: true }) });
    if (!l.ok) {
      const row = l.withoutLfs ? T("git-lfs is missing in the project container") : String(l.stderr || "").trim().split("\n").filter(Boolean).pop() || `Exit ${l.code}`;
      throw withStatus(new Error(T`Pull done, but the LFS files did not arrive: ${row.slice(0, 300)}`), instance, l);
    }
  }
  return { ok: true };
}
export async function gitFetch(projectPath, relPath, auth, opts = {}) {
  const { root, git, access, instance } = await repoAt(projectPath, relPath, opts);
  await git(root, ["fetch", "--all", "--prune"], { timeout: 90000, env: instance ? await networkAccess(instance, root, auth, opts, { submodule: true }) : access(auth) });
  return { ok: true };
}

// ── Git auth (workspace credentials for HTTPS remotes) ───────────────────────
// Stored credentials are NEVER written into URLs/arguments, but injected via a GIT_ASKPASS script + env (so they appear in
// no process list).
function authEnv(auth) {
  if (!auth || !auth.askpass || !auth.username) return {};
  return { GIT_ASKPASS: auth.askpass, CBASE_GIT_USERNAME: auth.username, CBASE_GIT_PASSWORD: auth.secret || "" };
}
export const isGitAuthError = (msg) =>
  /authentication failed|could not read username|could not read password|terminal prompts disabled|permission denied \(publickey\)|access denied|invalid credentials|http basic|fatal:.*\b40[13]\b/i.test(String(msg || ""));
export const isSshAuthError = (msg) => /permission denied \(publickey\)|host key verification failed/i.test(String(msg || ""));
// The host git NAMES in its message — "could not read Username for 'https://h'", "could not read Password for
// 'https://n@h'", "Authentication failed for 'https://h/…/'". Since pull and fetch take along the hosts of the submodules,
// the rejected host is no longer always the remote's; the access modal (workspaces/git-auth.js gitErrPayload) would otherwise
// save under the wrong name. Only https, lowercase, without port (that is how accesses are stored), checked against
// HOST_WITH_PORT; what cannot be read: null (then the remote's host as before).
export function hostFromGitError(msg) {
  const m = String(msg || "").match(/(?:could not read (?:username|password) for|authentication failed for) '([^'\s]{1,2000})'/i);
  if (!m) return null;
  let u;
  try { u = new URL(m[1]); } catch { return null; }
  if (u.protocol !== "https:") return null;
  const h = u.hostname.toLowerCase();
  return h && !h.includes(":") && HOST_WITH_PORT.test(h) ? h : null;
}
// Host of the origin remote (for credential assignment and meaningful auth modals).
export async function gitRemoteHost(projectPath, relPath, opts = {}) {
  return (await gitRemoteTarget(projectPath, relPath, opts)).host;
}
// Plus the host WITH port (lowercase) — the key of the per-host helper in the project container (repoAt `access`).
export async function gitRemoteTarget(projectPath, relPath, opts = {}) {
  try {
    const { root, git } = await repoAt(projectPath, relPath, opts);
    const url = (await git(root, ["remote", "get-url", "origin"])).trim();
    const r = parseRemote(url);
    return { host: r?.host || "", hostWithPort: r?.hostWithPort || "" };
  } catch { return { host: "", hostWithPort: "" }; }
}

// ── The location of a remote URL (read by gitView/detail.js for a branch's MR) ───────────────────────────────────────────────
// A remote URL can carry a token (`https://oauth2:<token>@host/group/project.git`) — it NEVER leaves this function: only host
// and path go out.
/** Host and project path of a remote URL (`https`, `ssh`, `git`, scp-like `user@host:path`) — without credentials; otherwise `null`. */
export function remoteLocation(url) {
  const s = String(url || "").trim();
  if (!s) return null;
  let host = "";
  let rawText = "";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    let u;
    try { u = new URL(s); } catch { return null; }
    if (!/^(https?|ssh|git|git\+ssh|ssh\+git):$/i.test(u.protocol)) return null; // file:// and others: no GitLab project
    host = u.hostname;
    rawText = u.pathname;
  } else {
    const m = s.match(/^(?:[^@/:]+@)?([^/:@]+):(?!\/)(.+)$/); // scp-like: [user@]host:path (a local path has no "host:")
    if (!m) return null;
    host = m[1];
    rawText = m[2];
  }
  let filePath = rawText.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "").replace(/\/+$/, "");
  try { filePath = decodeURIComponent(filePath); } catch { return null; }
  if (!host || !filePath.includes("/") || filePath.split("/").some((t) => !t || t === "." || t === "..")) return null;
  return { host: host.toLowerCase(), path: filePath };
}

/**
 * Is the commit `sha` in a code repo of the project — and, if `branch` is named, on that branch (local or `origin/<branch>`)?
 * The git anchor of the timeline (timeline/check.js). With an instance (`opts.instance`) every git runs in the project
 * container like the git view. → `{ found, onBranch }` (`onBranch` null without `branch`). Throws with `uncheckable = true`
 * if a container is not ready or git fails on a deadline — that is not "does not exist". The caller checks the form of
 * `sha`/`branch` (no option, no whitespace).
 */
export async function commitInProject(projectPath, sha, { branch = null, ...opts } = {}) {
  const uncheckable = (e) => Boolean(e?.containerStands || e?.containerPaused || e?.situation || e?.cap);
  let onBranchAnywhere = false;
  let found = false;
  for (const { root } of await projectRepos(projectPath, opts)) {
    const inst = instanceFrom(opts, root);
    try { await git(root, ["cat-file", "-e", `${sha}^{commit}`], { instance: inst }); } catch (e) {
      if (uncheckable(e)) throw Object.assign(new Error(e.message), { uncheckable: true });
      continue;
    }
    found = true;
    if (!branch) return { found: true, onBranch: null };
    for (const ref of [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`]) {
      try { await git(root, ["merge-base", "--is-ancestor", sha, ref], { instance: inst }); onBranchAnywhere = true; break; } catch (e) {
        if (uncheckable(e)) throw Object.assign(new Error(e.message), { uncheckable: true });
      }
    }
    if (onBranchAnywhere) return { found: true, onBranch: true };
  }
  return { found, onBranch: found && branch ? false : null };
}

// git with stdin (for `git apply` in hunk staging). With an instance in the project container (same error shape), otherwise
// the plain starter `gitStdinInB` unchanged.
async function gitStdin(cwd, args, input, opts = {}) {
  const inst = opts.instance || null;
  if (!inst) return gitRun(null, cwd, args, { fallback: () => gitStdinInB(cwd, args, input, opts) });
  const r = await gitRun(inst, cwd, args, { stdin: input, timeout: opts.timeout || 15000 });
  if (r.code === 0) return r.stdout;
  throw withStatus(new Error(String(r.stderr || "").trim() || `git apply exit ${r.code}`), inst, r);
}
function gitStdinInB(cwd, args, input, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    let out = "", err = "";
    const to = setTimeout(() => { try { p.kill(); } catch { /* ignore */ } }, opts.timeout || 15000);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => { clearTimeout(to); reject(e); });
    p.on("close", (code) => { clearTimeout(to); code === 0 ? resolve(out) : reject(new Error(err.trim() || `git apply exit ${code}`)); });
    // Through the ONE path (providers/kind-stdin.js): if git dies before it has read the patch, the EPIPE would otherwise be
    // an unhandled exception — and that kills the server process.
    writeStdin(p, input, { close: true });
  });
}

// ── Hunk staging (git apply against the index) ───────────────────────────────
// patch = a valid unified-diff excerpt (file header + one or more hunks).
// reverse=true → take the hunk out of the index (unstage).
// workingTree=true (the diff tab: "discard hunk") → against the WORK TREE instead of the index (without `--cached`); with
// `reverse` that reverts a hunk of an unstaged change. `true` or absent — anything else is an error BEFORE the first git.
export async function gitApply(projectPath, relPath, patch, opts = {}) {
  if (opts.workingTree != null && opts.workingTree !== true) throw new Error(T("workingTree is true or absent"));
  const { root, gitStdin } = await repoAt(projectPath, relPath, opts);
  const p = String(patch || "");
  if (!p.trim()) throw new Error(T("Empty patch"));
  const args = ["apply", ...(opts.workingTree === true ? [] : ["--cached"]), "--whitespace=nowarn"];
  if (opts.reverse) args.push("--reverse");
  args.push("-");
  await gitStdin(root, args, p.endsWith("\n") ? p : p + "\n");
  return { ok: true };
}

// ── Stash ────────────────────────────────────────────────────────────────────
export async function gitStashList(projectPath, relPath, opts = {}) {
  const { root, raw } = await repoAt(projectPath, relPath, opts);
  // %ct + relativeDe instead of git's %cr — its wording depends on locale and gettext build (in the container always English,
  // "29 minutes ago" above "vor 28 Min." in the same panel). Localized like tree, lastCommit and blame.
  const out = await raw(root, ["stash", "list", `--format=%gd${US}%s${US}%ct`]);
  return { stashes: out.split("\n").filter(Boolean).map((l) => { const [ref, message, ct] = l.split(US); return { ref, message, relative: relativeDe(parseInt(ct, 10) || 0) }; }) };
}
export async function gitStashPush(projectPath, relPath, opts = {}) {
  const { root, git } = await repoAt(projectPath, relPath, opts);
  const args = ["stash", "push"];
  if (opts.includeUntracked) args.push("-u");
  if (opts.message) args.push("-m", String(opts.message));
  await git(root, args);
  return { ok: true };
}
export async function gitStashOp(projectPath, relPath, op, ref, opts = {}) {
  const { root, git } = await repoAt(projectPath, relPath, opts);
  if (!["pop", "apply", "drop"].includes(op)) throw new Error(T("Invalid stash operation"));
  if (ref) noOption(ref, T("stash##invalid value"));
  await git(root, ["stash", op, ...(ref ? [String(ref)] : [])]);
  return { ok: true };
}
export async function gitStashShow(projectPath, relPath, ref, opts = {}) {
  const { root, raw } = await repoAt(projectPath, relPath, opts);
  noOption(ref, T("stash##invalid value")); // `--output=<file>` would write an arbitrary file
  // Hardened like every diff of this module: measured on git 2.50, `stash show` without the switches does withstand
  // `diff.external` and textconv, but follows `diff.noprefix` (header `a.txt a.txt` instead of `a/… b/…`) and `color.ui=always`
  // (escape sequences) — both break the patch computation of the diff tab (lib/diff-tab.ts) and of the DiffModal. The prefixes
  // are pinned through the configuration (`STASH_PREFIXES`), NOT with `--src-prefix`/`--dst-prefix` as in `WITHOUT_PROGRAM`:
  // git 2.54 drops the VALUE of both options in `stash show` (header `a.txt a.txt` even without any configuration; `git diff`
  // and git 2.39/2.50 keep it — measured). The other switches stand BEHIND the stash: git separates options and stash in
  // `stash show`. Guard: test/git-diff-content.test.js (k).
  return { ref, diff: await raw(root, [...STASH_PREFIXES, "stash", "show", "-p", String(ref), ...WITHOUT_PROGRAM_STASH]) };
}

// ── Merge / Rebase (conflict-tolerant: conflicts are no error but a state) ──
const hasConflicts = (statusPorcelain) => /^(UU|AA|DD|AU|UA|DU|UD) /m.test(statusPorcelain);
export async function gitMerge(projectPath, relPath, branch, opts = {}) {
  const { root, git, raw } = await repoAt(projectPath, relPath, opts);
  const b = String(branch || "").trim();
  if (!b) throw new Error(T("Branch missing"));
  noOption(b, T("branch##invalid value")); // `--strategy=…`, `-X…`
  try { await git(root, ["merge", "--no-edit", b]); return { ok: true }; }
  catch (e) { if (hasConflicts(await raw(root, ["status", "--porcelain"]))) return { ok: true, conflicts: true }; throw e; }
}
export async function gitRebase(projectPath, relPath, branch, opts = {}) {
  const { root, git, raw } = await repoAt(projectPath, relPath, opts);
  const b = String(branch || "").trim();
  if (!b) throw new Error(T("Branch missing"));
  noOption(b, T("branch##invalid value")); // `--exec=<command>` ran a command
  try { await git(root, ["rebase", b]); return { ok: true }; }
  catch (e) { if (hasConflicts(await raw(root, ["status", "--porcelain"]))) return { ok: true, conflicts: true }; throw e; }
}
export async function gitMergeAbort(projectPath, relPath, opts = {}) {
  const { root, git } = await repoAt(projectPath, relPath, opts);
  await git(root, ["merge", "--abort"]).catch(() => git(root, ["rebase", "--abort"]));
  return { ok: true };
}

// ── Blame (per line: commit, author, time, summary) ──────────────────────────
export async function gitBlame(projectPath, relPath, file, opts = {}) {
  const { root, raw } = await repoAt(projectPath, relPath, opts);
  const f = String(file || "");
  if (!f) throw new Error(T("No file"));
  const out = await raw(root, ["blame", "--line-porcelain", "--", f]);
  const lines = [];
  let cur = null;
  for (const ln of out.split("\n")) {
    if (/^[0-9a-f]{40} /.test(ln)) cur = { sha: ln.slice(0, 40) };
    else if (cur && ln.startsWith("author ")) cur.author = ln.slice(7);
    else if (cur && ln.startsWith("author-time ")) cur.time = parseInt(ln.slice(12), 10) || 0;
    else if (cur && ln.startsWith("summary ")) cur.summary = ln.slice(8);
    else if (ln.startsWith("\t") && cur) {
      const uncommitted = /^0{40}$/.test(cur.sha);
      lines.push({ sha: cur.sha.slice(0, 8), author: uncommitted ? T("Not committed") : (cur.author || ""), relative: cur.time ? relativeDe(cur.time) : "", summary: cur.summary || "" });
    }
  }
  return { file: f, lines };
}

// ── History (commits + a single commit's diff) ───────────────────────────────
// Without `opts.graph` the plain answer (history sheet, iOS): the current branch, linear, `{ commits }` — argv and body byte-equal
// (anchors fixtures/projectbox-git/argv-without-instance.json and fixtures/code-scopes/responses.json). With `opts.graph` the graph (see below).
export async function gitLog(projectPath, relPath, opts = {}) {
  if (opts.graph != null) return gitGraphLog(projectPath, relPath, opts);
  const { root, raw } = await repoAt(projectPath, relPath, opts);
  // %ct + relativeDe instead of %cr (see gitStashList).
  const args = ["log", `--format=%H${US}%h${US}%s${US}%an${US}%ct`, "-n", String(Math.min(500, opts.limit || 100))];
  if (opts.file) args.push("--", String(opts.file));
  const out = await raw(root, args);
  return { commits: out.split("\n").filter(Boolean).map((l) => { const [hash, short, subject, author, ct] = l.split(US); return { hash, short, subject, author, relative: relativeDe(parseInt(ct, 10) || 0) }; }) };
}

// ── The time axis of a file ─────────────────────────────────────────────────────────────────────────────────────────────
// `POST …/git/log` with `timeAxis: true` and `file` (relative to the repo): the commits that changed THIS file, across renames
// (`--follow`, like VS Code's timeline, extensions/git `log` with `follow`), newest first. Per commit the file's path IN it
// (`file`) and, for a rename, the old one (`old`) — the web's diff tab needs both. `time` = committer time in Unix seconds as in
// the graph (VS Code `git.timeline.date` default "committed"); the web computes the relative display in its language. Announced
// cap: at most TIME_AXIS_CAP per page, one more is asked, `clipped: true` means "there are older". "Load more" pages through a
// CURSOR like VS Code's git timeline (`paging.cursor` = hash of the last entry): `after` (the hash) and `file` = the file's path
// IN that commit — the next page starts there (the commit itself drops out again). An offset (`--skip`) does NOT work: with
// `--follow` git loses the rename when its commit is skipped (page 2 behind the rename commit was empty). Paths like every other
// read here: `-z` (git then never quotes — "Ärger.md" used to arrive as `"\303\204rger.md"` and the diff pointed at a file that
// does not exist; plus `core.quotePath=false` like `contentTreeArgs`) and `--literal-pathspecs` (otherwise "app/[id]/page.tsx"
// is a pattern and pulls in the commits of "app/d/page.tsx", "a?.md" those of "ab.md"). Runs via repoAt (in a relocated project
// inside the project container via gitRun) and read-only — POST /git/log is in COPY_READING (devtools/code-route.js), a copy
// being cleaned up keeps reading. Guard: server/backend/test/git-time-axis.test.js.
export const TIME_AXIS_CAP = 200;
export const TIME_AXIS_FORMAT = `%x1e%H${US}%h${US}%an${US}%ae${US}%ct${US}%s`;
/** The argv of the time axis (pure, exported for the guard); with `after` (a checked hash) it starts at that commit — it comes
 *  along and drops out in `parseTimeAxis`, hence one more. */
export function timeAxisArgs(file, n, to = null) {
  return ["-c", "core.quotePath=false", "--literal-pathspecs", "log", "--follow", "-M", "--no-show-signature", "--no-color", "--name-status", "-z",
    `--format=${TIME_AXIS_FORMAT}`, "-n", String(n + 1 + (to ? 1 : 0)), ...(to ? [to] : []), "--", file];
}
/** The output of `timeAxisArgs` → `{ entries, clipped }` (pure). Per commit (`-z`): the header up to the first NUL, then "\n" and the
 *  status line as NUL-separated fields (status, path[, new path]). `file` is never missing: without a status line (a merge) the asked path. */
export function parseTimeAxis(out, n, asked = "", to = null) {
  const entries = [];
  for (const block of String(out).split("\x1e")) {
    if (!block.trim()) continue;
    const end = block.indexOf("\0");
    const header = end < 0 ? block.replace(/\n+$/, "") : block.slice(0, end);
    const fields = end < 0 ? [] : block.slice(end + 1).replace(/^\n+/, "").split("\0");
    const [hash, short, author, email, ct, ...subject] = header.split(US);
    if (!HASH.test(hash || "")) continue;
    let file = null, old = null;
    if (/^[RC]\d*$/.test(fields[0] || "") && fields[1] && fields[2]) { old = fields[1]; file = fields[2]; } else if (fields[0] && fields[1]) file = fields[1];
    const time = parseInt(ct, 10);
    entries.push({
      hash, short, subject: subject.join(US), author: author || "", email: email || null, time: Number.isFinite(time) ? time : null,
      file: file || asked, ...(old && old !== file ? { old: old } : {}),
    });
  }
  if (to && entries[0]?.hash === to) entries.shift(); // the cursor itself was already on the page before
  return { entries: entries.slice(0, n), clipped: entries.length > n };
}
export async function gitTimeAxis(projectPath, relPath, file, opts = {}) {
  const fileItem = typeof file === "string" ? file : "";
  if (!fileItem) throw Object.assign(new Error(T("The file for the time axis is missing")), { status: 400 });
  const { root, raw } = await repoAt(projectPath, relPath, opts);
  const n = Math.max(1, Math.min(TIME_AXIS_CAP, Math.floor(Number(opts.limit)) || TIME_AXIS_CAP));
  if (opts.after != null && !(typeof opts.after === "string" && /^[0-9a-f]{7,64}$/.test(opts.after))) throw Object.assign(new Error(T("The cursor of the time axis is not a commit")), { status: 400 });
  const after = opts.after || null;
  return parseTimeAxis(await raw(root, timeAxisArgs(fileItem, n, after)), n, fileItem, after);
}

// ── Graph of the git bar ────────────────────────────────────────────────────────────────────────────────────────────────
// `POST …/git/log` with `graph: "all" | "current"` (web/src/components/git-bar/GitGraph.tsx). Per commit additionally `parents`
// (full hashes, `%P`), `refs` (`{ name, kind: "head" | "local" | "remote" | "tag" }`, from `%D`), `time` (Unix seconds) and
// `head: true` on HEAD's commit; plus `clipped` (the cap says that it is one) and `extent` (the echo of the choice — an old
// server does not know `graph` and answers without both; the web then draws linearly, never wrongly).
//   all     — `--branches --remotes --tags HEAD`: every local and remote branch, every tag, plus a detached HEAD.
//   current — HEAD and its upstream if it has one (VS Code "Auto" adds the base branch; git does not guess it — missing here).
// DECIDED: `--topo-order` (like VS Code: extensions/git `log` with refNames sets `--topo-order`), not `--date-order`. Both show no
// parent before its children, but `--date-order` mixes the lines by time, so every parallel piece of work crosses the other and
// keeps its lane open — `--topo-order` shows one line in one piece (the merged side before the merge parent), and the lanes stay
// short. `--decorate=full` so a local branch "origin/x" is not read as a remote; `<remote>/HEAD` drops out (a pointer to the
// remote's default branch that has its own badge anyway — like the branch list, listBranches). Other refs (refs/stash,
// refs/notes, refs/cbase/…) get no badge. The subject comes LAST in the format: it is the only field that can carry the
// separator (a ref name cannot: git check-ref-format forbids control characters and spaces — so ", " separates the decorations
// safely, even with commas in the name).
// Cap like the history sheet: at most LOG_CAP (500); one more is asked, and `clipped: true` means "there are older". Deadline
// GRAPH_DEADLINE_MS instead of the 6 s of a read command: `--topo-order` over all refs walks the whole history once without a
// commit-graph (ESTIMATED, NOT MEASURED for large repos).
// Guard: server/backend/test/git-graph-log.test.js.
export const GRAPH_EXTENTS = Object.freeze(["all", "current"]);
export const LOG_CAP = 500;
const GRAPH_DEADLINE_MS = 15_000;
export const GRAPH_FORMAT = `%H${US}%h${US}%P${US}%D${US}%an${US}%ct${US}%s`;
const HASH = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/; // SHA-1 or SHA-256

/** The argv of the graph (pure, exported for the guard). `withUpstream` only for "current". */
export function graphLogArgs(extent, n, withUpstream = false) {
  const revs = extent === "all" ? ["--branches", "--remotes", "--tags", "HEAD"] : withUpstream ? ["HEAD", "@{upstream}"] : ["HEAD"];
  return ["log", "--topo-order", "--decorate=full", "--no-show-signature", `--format=${GRAPH_FORMAT}`, "-n", String(n + 1), ...revs];
}

// An entry of `%D` (with --decorate=full) → badge or null.
function refFromDeco(s) {
  if (s.startsWith("tag: ")) return s.startsWith("tag: refs/tags/") && s.length > 15 ? { name: s.slice(15), kind: "tag" } : null;
  if (s.startsWith("refs/heads/") && s.length > 11) return { name: s.slice(11), kind: "local" };
  if (s.startsWith("refs/remotes/") && s.length > 13) return s.endsWith("/HEAD") ? null : { name: s.slice(13), kind: "remote" };
  return null;
}

/** `%D` → `{ refs, head }`. "HEAD -> refs/heads/x" is the checked-out branch (`kind: "head"`), a bare "HEAD" a detached one. */
export function refsFromDeco(deco) {
  const refs = [];
  let head = false;
  for (const part of String(deco || "").split(", ")) {
    const s = part.trim();
    if (!s) continue;
    if (s === "HEAD") { head = true; refs.push({ name: "HEAD", kind: "head" }); continue; }
    const arrow = s.indexOf(" -> ");
    if (arrow >= 0) {
      // A symbolic ref: the work tree's HEAD or (depending on git) `refs/remotes/origin/HEAD -> refs/remotes/origin/main` — the
      // pointer itself drops out, its target stands.
      const target = refFromDeco(s.slice(arrow + 4));
      if (s.slice(0, arrow) === "HEAD") { head = true; if (target) refs.push(target.kind === "local" ? { ...target, kind: "head" } : target); }
      else if (target) refs.push(target);
      continue;
    }
    const r = refFromDeco(s);
    if (r) refs.push(r);
  }
  const seen = new Set();
  return { refs: refs.filter((r) => { const k = `${r.kind === "head" ? "local" : r.kind}\u0000${r.name}`; if (seen.has(k)) return false; seen.add(k); return true; }), head };
}

/** The output of `git log --format=GRAPH_FORMAT` → entries. What does not have the shape (e.g. a signature line) drops out. */
export function parseGraphLog(out) {
  const commits = [];
  for (const row of String(out || "").split("\n")) {
    const parts = row.split(US);
    if (parts.length < 7 || !HASH.test(parts[0])) continue;
    const [hash, short, parent, deco, author, ct] = parts;
    const { refs, head } = refsFromDeco(deco);
    const time = parseInt(ct, 10) || 0;
    commits.push({
      hash, short, subject: parts.slice(6).join(US), author, relative: relativeDe(time), time,
      parents: parent.split(" ").filter((p) => HASH.test(p)), refs, ...(head ? { head: true } : {}),
    });
  }
  return commits;
}

async function gitGraphLog(projectPath, relPath, opts) {
  const extent = String(opts.graph);
  if (!GRAPH_EXTENTS.includes(extent)) {
    throw new Error(T`Unknown graph scope: "${extent.slice(0, 40)}" — allowed are ${GRAPH_EXTENTS.join(", ")}.`);
  }
  // A file filter would rewrite the parents (history simplification) — there is no graph of one file.
  if (opts.file) throw new Error(T("The graph has no file filter."));
  const { root, git } = await repoAt(projectPath, relPath, opts);
  const n = Math.max(1, Math.min(LOG_CAP, Math.floor(Number(opts.limit)) || 100));
  let withUpstream = false;
  if (extent === "current") {
    // Without an upstream `@{upstream}` would abort the whole call. A stopped container is no answer "without upstream": the log
    // afterwards throws it anyway.
    try { withUpstream = Boolean((await git(root, [...READ_COMMANDS.upstream])).trim()); } catch { /* no upstream */ }
  }
  // `git`, not `raw` like the history sheet: `raw` would return half the output as whole on a deadline — without `clipped`. The
  // only failure that is an answer: HEAD without a commit (fresh repo) — then without HEAD ("all": the remote branches of an empty
  // clone) or empty; recognized via `rev-parse`, not by the wording (git translates it).
  const args = graphLogArgs(extent, n, withUpstream);
  let out;
  try { out = await git(root, args, { timeout: GRAPH_DEADLINE_MS }); }
  catch (e) {
    if (e?.containerStands || e?.containerPaused || e?.situation) throw e;
    const headExists = await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]).then(() => true, (f) => { if (f?.containerStands || f?.containerPaused || f?.situation) throw f; return false; });
    if (headExists) throw e;
    out = extent === "all" ? await git(root, args.filter((a) => a !== "HEAD"), { timeout: GRAPH_DEADLINE_MS }) : "";
  }
  const commits = parseGraphLog(out);
  const clipped = commits.length > n;
  return { commits: clipped ? commits.slice(0, n) : commits, clipped, extent };
}

// `POST …/git/show`: without `files`/`file`/`info` the whole commit as before (`git show --stat -p`, argv and body byte-equal —
// anchors fixtures/projectbox-git/argv-without-instance.json and fixtures/code-scopes/responses.json); with one of them the parts of
// the expanded or hovered commit in the graph of the git bar (see "One commit, expanded" and "One commit, hovered" below).
export async function gitShow(projectPath, relPath, hash, opts = {}) {
  if (opts.files != null || opts.file != null || opts.info != null || opts.content != null) return gitCommitPart(projectPath, relPath, hash, opts);
  const { root, raw } = await repoAt(projectPath, relPath, opts);
  const h = String(hash || "");
  if (!/^[0-9a-f]{5,40}$/i.test(h)) throw new Error(T("Invalid commit hash"));
  return { hash: h, diff: await raw(root, ["show", h, "--stat", "-p"]) };
}

// ── One commit, expanded ──────────────────────────────────────────────────────────────────────────────────────────────
// Two read paths as OPTIONS of `POST …/git/show` (web/src/components/git-bar/GitGraph.tsx):
//   { hash, files: true }   → { hash, parent, files: [{ path, old, status }], total, clipped }
//       `git diff-tree -r -M --name-status -z <parent1> <hash>` — the files against the FIRST parent (a merge commit like VS Code:
//       only what it carries compared with the line merged into), a root commit against the empty tree (`--root`). `status` is one
//       of COMMIT_STATUS, `old` the old path of a rename (R) or the source of a copy (C), otherwise null. At most COMMIT_FILES_MAX
//       entries; `total` counts all (null if the output cap hit — then the number is unknown, not "this many"), `clipped` says the
//       list does not show everything. `parent` are the full hashes of all parents (empty = root).
//   { hash, file, old? }    → { hash, path, old, diff, clipped }
//       `git --literal-pathspecs diff-tree -p -M <parent1> <hash> -- <file> [<old>]` — the diff of EXACTLY this file in this commit
//       (for a rename both paths, otherwise git would see only a creation), at most COMMIT_DIFF_MAX bytes (`clipped`, cut at a line
//       boundary). `path` is the echo of the request: an old server does not know `file` and answers with the WHOLE commit without
//       `path` — the web then does not show it as the file's diff (lib/api/git.ts).
// DECIDED: options of the same route instead of two new ones. `POST /git/show` is already among the reading paths of a copy that
// is not ready (devtools/code-route.js COPY_READING), goes through the same instance choice (`?chat=`/`instance=`, gitOptions) and
// the same route list (code-scopes, dispatcher) — a new path would have to be added at all these places and would, where missing,
// be blocked or misrouted. And an old server answers the options with the old shape, by which the web recognizes it.
// DECIDED: `diff-tree` (plumbing) instead of `diff`: it reads neither `diff.external` nor `diff.noprefix`/`color.*` of the
// configuration, and `--root` compares a root commit with the empty tree without knowing its hash (in a SHA-256 repo that is a
// different one).
// HARDENING (like gitView/detail.js DIFF_SCRIPT): the hash only hex (5–64: SHA-1 or SHA-256) and resolved to EXACTLY one commit that
// starts with it; the paths only behind `--`, with `--literal-pathspecs` (`:(glob)*`, `*`, `:!x` are then file names, not patterns),
// `--no-ext-diff --no-textconv` (no program from the configuration runs), no `--output`. A path with a leading "-" is a 400 — a file
// that really has that name comes as `./-name` (like the option check above); absolute, with `..`, `.` or empty segments likewise.
// Reading, via `repoAt` — with an instance in the project container or in the copy, no new starter.
// Guards: server/backend/test/git-commit-files.test.js; the options run in the scenario (projectbox-git-scenario.mjs, "show-files",
// "show-file") with and without an instance.
export const COMMIT_STATUS = Object.freeze(["M", "A", "D", "R", "C", "T", "U"]);
export const COMMIT_FILES_MAX = 1000;
export const COMMIT_DIFF_MAX = 2 * 1024 * 1024;
const COMMIT_DEADLINE_MS = 15_000; // `-M` over a large commit (renames) needs more than the 6 s of a read command
const COMMIT_LIST_OUTPUT = 16 * 1024 * 1024;
const COMMIT_HASH = /^[0-9a-f]{5,64}$/;

/** A path in the repo from the body → the path (unchanged) or a throw. Relative to the repo root; a leading `./` is allowed. */
export function commitPath(value, what = "file") {
  const s = typeof value === "string" ? value : "";
  if (!s || s.length > 4096 || s.includes("\0")) {
    throw new Error(T`${what} is missing (a path relative to the repository)`);
  }
  if (s.startsWith("-")) {
    throw new Error(T`Invalid path "${s.slice(0, 80)}" — it must not start with "-" (send a file of that name as "./${s.slice(0, 40)}").`);
  }
  const parts = (s.startsWith("./") ? s.slice(2) : s).split("/");
  // `git status` shows an untracked folder (often an embedded repository) as ONE entry with a trailing "/": say what it is, not "invalid".
  if (parts.length > 1 && s.endsWith("/") && !s.startsWith("/") && parts.slice(0, -1).every((t) => t !== "" && t !== "." && t !== "..")) {
    throw new Error(T`"${s.slice(0, 80)}" is a folder (untracked, or an embedded repository) — Git shows it as one entry and has no diff for it. Open the files inside it, or the embedded repository on its own.`);
  }
  if (s.startsWith("/") || parts.some((t) => t === "" || t === "." || t === "..")) {
    throw new Error(T`Invalid path "${s.slice(0, 80)}" — only a path inside the repository (not absolute, no "..", "." or empty segments).`);
  }
  return s;
}

/** The argv of the file list (pure, exported for the guard). `parent1` null = root commit. */
export function commitFilesArgs(parent1, hash) {
  return ["diff-tree", "-r", "-M", "--no-commit-id", "--name-status", "-z", "--no-ext-diff", "--no-textconv", ...(parent1 ? [parent1, hash] : ["--root", hash])];
}
/** The argv of a file's diff (pure, exported for the guard). */
export function commitFileDiffArgs(parent1, hash, filePath, old = null) {
  return [
    "-c", "core.quotePath=false", "--literal-pathspecs", "diff-tree", "-p", "-M", "--no-commit-id", "--no-color", "--no-ext-diff", "--no-textconv",
    ...(parent1 ? [parent1, hash] : ["--root", hash]), "--", filePath, ...(old && old !== filePath ? [old] : []),
  ];
}

/** The output of `diff-tree --name-status -z` → `{ files, total }` (at most `max` in `files`). `cutOff`: the output ended at the cap
 *  — the last entry may be half and drops out. An unknown letter (X, B — only on an error in git or with `-B`, which never stands
 *  here) skips its path. */
export function parseNameStatus(out, { max = COMMIT_FILES_MAX, cutOff = false } = {}) {
  const parts = String(out || "").split("\0");
  const all = [];
  for (let i = 0; i < parts.length;) {
    const header = parts[i];
    if (!header) { i += 1; continue; }
    const s = header[0];
    const two = s === "R" || s === "C";
    const paths = parts.slice(i + 1, i + (two ? 3 : 2));
    i += two ? 3 : 2;
    if (paths.length < (two ? 2 : 1) || paths.some((p) => !p)) break; // the end of the output in the middle of an entry
    if (!COMMIT_STATUS.includes(s)) continue;
    all.push(two ? { path: paths[1], old: paths[0], status: s } : { path: paths[0], old: null, status: s });
  }
  if (cutOff) all.pop();
  return { files: all.slice(0, max), total: all.length };
}

// Throws with a flag (the route's way stays 400, the message says it) — a stopped container passes through unchanged.
const notFound = (h) => new Error(T`Commit ${h} not found (or ambiguous)`);
async function gitCommitPart(projectPath, relPath, hash, opts) {
  const h = String(hash ?? "");
  if (!COMMIT_HASH.test(h)) throw new Error(T("Invalid commit hash (lowercase hex only, 5–64 characters)"));
  if ([opts.files, opts.file, opts.info].filter((x) => x != null).length > 1) throw new Error(T("files, file and info are mutually exclusive"));
  if (opts.files != null && opts.files !== true) throw new Error(T("files is true or absent"));
  if (opts.info != null && opts.info !== true) throw new Error(T("info is true or absent"));
  if (opts.content != null && opts.content !== true) throw new Error(T("content is true or absent"));
  if (opts.content != null && opts.file == null) throw new Error(T("content only together with file"));
  // The paths BEFORE the first git: an invalid path costs no call (and no container start).
  const filePath = opts.file != null ? commitPath(opts.file, "file") : null;
  const old = filePath !== null && opts.old != null && opts.old !== "" ? commitPath(opts.old, "old") : null;
  const { root, git } = await repoAt(projectPath, relPath, opts);
  let row;
  try { row = (await git(root, ["rev-list", "--parents", "-n", "1", `${h}^{commit}`, "--"])).trim(); }
  catch (e) { if (e?.containerStands || e?.containerPaused || e?.situation) throw e; throw notFound(h); }
  const [full, ...rest] = row.split(" ");
  if (!HASH.test(full || "") || !full.startsWith(h) || row.includes("\n")) throw notFound(h);
  const parent = rest.filter((p) => HASH.test(p));
  const parent1 = parent[0] || null;
  if (opts.info != null) return commitInfo(git, root, full, parent);
  if (filePath === null) {
    let out;
    let cutOff = false;
    try { out = await git(root, commitFilesArgs(parent1, full), { timeout: COMMIT_DEADLINE_MS, maxBuffer: COMMIT_LIST_OUTPUT }); }
    catch (e) {
      if (e?.cap !== "output" || typeof e.stdout !== "string") throw e;
      out = e.stdout;
      cutOff = true;
    }
    const { files, total } = parseNameStatus(out, { cutOff });
    return { hash: full, parent, files, total: cutOff ? null : total, clipped: cutOff || total > files.length };
  }
  let diff;
  let clipped = false;
  try { diff = await git(root, commitFileDiffArgs(parent1, full, filePath, old), { timeout: COMMIT_DEADLINE_MS, maxBuffer: COMMIT_DIFF_MAX + 64 * 1024 }); }
  catch (e) {
    if (e?.cap !== "output" || typeof e.stdout !== "string") throw e;
    diff = e.stdout;
    clipped = true;
  }
  ({ diff, clipped } = kappeDiff(diff, clipped));
  if (opts.content !== true) return { hash: full, path: filePath, old, diff, clipped };
  // `content` (see "Content of both sides" below): before at the FIRST parent (under the old path of a rename), after in the commit.
  const prior = parent1 ? await pageFromTree(git, root, parent1, old ?? filePath) : { kind: "missing" };
  const after = await pageFromTree(git, root, full, filePath);
  return { hash: full, path: filePath, old, diff, clipped, prior, after };
}

// At most COMMIT_DIFF_MAX bytes, cut at a line boundary (`clipped` says so) — for the diff of a file in a commit and the diff with
// content (gitDiff `content`).
function kappeDiff(diff, clipped) {
  if (!clipped && Buffer.byteLength(diff) <= COMMIT_DIFF_MAX) return { diff, clipped: false };
  const rawText = Buffer.from(diff).subarray(0, COMMIT_DIFF_MAX).toString("utf8");
  const nl = rawText.lastIndexOf("\n");
  return { diff: nl >= 0 ? rawText.slice(0, nl + 1) : "", clipped: true };
}

// ── Content of both sides ───────────────────────────────────────────────────────────────────────────────────────────────
// The diff tab shows a file SIDE BY SIDE like VS Code (web/src/components/code/DiffTab.tsx, @codemirror/merge) — for that it
// needs the WHOLE text of both sides, not just the patch (three lines of context do not suffice for a file). Two options of
// existing routes:
//   POST …/git/show { hash, file, old?, content: true } → like `file` (see above) plus `prior` (at the first parent, under `old`,
//       otherwise `file`; a root commit has no prior) and `after` (in the commit).
//   POST …/git/diff { repo, file, staged, content: true } → { path, staged, diff, clipped, prior, after, conflict? }
//       `conflict: true` if the path in the index has only stages 1–3 (`isConflict`) — also without our side (DU, UA); the tab then
//       locks the hunks (staging a hunk would silently resolve the conflict).
//       staged:    prior = HEAD (no commit ⇒ missing), after = index (stage 0)
//       unstaged:  prior = index (stage 0; on a conflict stage 2 = our side, `stage: 2`), after = `{ kind: "workingTree" }` —
//                  the tab reads the work tree via `GET …/files/read`, the same path it saves through (`PUT …/files/write`).
//       The diff itself hardened (`diffContentArgs`): --no-ext-diff --no-textconv --no-color, prefixes a/ b/ explicitly
//       (`diff.noprefix` would make every `git apply` of a hunk fail), --literal-pathspecs; untracked (not in the index) against
//       /dev/null. At most COMMIT_DIFF_MAX bytes as above (`clipped`). Without `content` gitDiff stays byte-equal (anchor
//       argv-without-instance.json).
// A side is EXACTLY one of: { kind: "text", text, reference?, stage? } · { kind: "missing" } (the file does not exist on this side —
// created, deleted, untracked, no commit; NOT the same as an empty text) · { kind: "binary" } (NUL in the first 8,000 bytes, git's
// rule) · { kind: "large" } (above CONTENT_MAX) · { kind: "submodule" } (gitlink) · { kind: "workingTree" } (see above).
// HARDENING as in "One commit, expanded": the path via `commitPath` (leading "-", `..`, absolute ⇒ 400 BEFORE the first git — a file
// "-x" comes as "./-x"), only behind `--`, `--literal-pathspecs`; a blob is read only via its object id from `ls-tree`/`ls-files`
// (hex checked), never via `<rev>:<path>` — no path is ever read as a revision. `cat-file blob` applies no filters and no textconv.
// Reading, via `repoAt` (with an instance in the project container or in the copy). Guard: server/backend/test/git-diff-content.test.js;
// the options run in the scenario (projectbox-git-scenario.mjs, "diff-content*", "show-content", "apply-working-tree") with and without
// an instance.
export const CONTENT_MAX = 2 * 1024 * 1024;
export const CONTENT_KINDS = Object.freeze(["text", "missing", "binary", "large", "submodule", "workingTree"]);
// `-U3` explicitly: `diff.context=0` in the repo's configuration would give hunks without context, and `git apply` would reject
// every one of them — staging and discarding a hunk would be dead.
const WITHOUT_PROGRAM = ["--no-color", "--no-ext-diff", "--no-textconv", "-U3", "--src-prefix=a/", "--dst-prefix=b/"];
// `stash show` without the two prefix options (see gitStashShow) — the prefixes come from `STASH_PREFIXES`: every configuration
// key that changes them, set to the default (`diff.srcPrefix`/`diff.dstPrefix` exist since git 2.45; an older git ignores them).
const WITHOUT_PROGRAM_STASH = WITHOUT_PROGRAM.filter((a) => !/^--(?:src|dst)-prefix=/.test(a));
const STASH_PREFIXES = ["-c", "diff.noprefix=false", "-c", "diff.mnemonicPrefix=false", "-c", "diff.srcPrefix=a/", "-c", "diff.dstPrefix=b/"];
/** The argv of the diff with content (pure, exported for the guard). */
export function diffContentArgs(filePath, staged) {
  return ["-c", "core.quotePath=false", "--literal-pathspecs", "diff", ...WITHOUT_PROGRAM, ...(staged ? ["--staged"] : []), "--", filePath];
}
/** The argv of the diff of an untracked file against /dev/null — the path WITHOUT "./" (behind `--` it cannot be an option; with "./"
 *  `b/./-x` would stand in the header, and `git apply` would reject the hunk). */
export function diffContentNewArgs(filePath) {
  return ["-c", "core.quotePath=false", "diff", "--no-index", ...WITHOUT_PROGRAM, "--", "/dev/null", filePath.replace(/^\.\//, "")];
}
/** The argv of an entry in a tree or in the index (pure, exported for the guard). */
export function contentTreeArgs(rev, filePath) { return ["-c", "core.quotePath=false", "--literal-pathspecs", "ls-tree", "-z", rev, "--", filePath]; }
export function contentIndexArgs(filePath) { return ["-c", "core.quotePath=false", "--literal-pathspecs", "ls-files", "-s", "-z", "--", filePath]; }

const withoutPoint = (p) => p.replace(/^\.\//, "");
/** `ls-tree -z` → the entry of EXACTLY this path `{ mode, type, oid }` or null. */
export function parseLsTree(out, filePath) {
  for (const z of String(out ?? "").split("\0")) {
    const m = /^(\d{6}) (\w+) ([0-9a-f]+)\t([\s\S]+)$/.exec(z);
    if (m && m[4] === withoutPoint(filePath)) return { mode: m[1], type: m[2], oid: m[3] };
  }
  return null;
}
/** `ls-files -s -z` → the entries of EXACTLY this path `[{ mode, oid, stage }]` (on a conflict the stages 1–3). */
export function parseLsFiles(out, filePath) {
  const result = [];
  for (const z of String(out ?? "").split("\0")) {
    const m = /^(\d{6}) ([0-9a-f]+) ([0-3])\t([\s\S]+)$/.exec(z);
    if (m && m[4] === withoutPoint(filePath)) result.push({ mode: m[1], oid: m[2], stage: Number(m[3]) });
  }
  return result;
}
async function blobPage(git, root, e, extra = {}) {
  if (e.mode === "160000") return { kind: "submodule" };
  if ((e.type && e.type !== "blob") || !HASH.test(e.oid)) return { kind: "missing" }; // a folder in that place: as a file it does not exist
  let text;
  try { text = await git(root, ["cat-file", "blob", e.oid], { maxBuffer: CONTENT_MAX + 64 * 1024 }); }
  catch (err) { if (err?.cap === "output") return { kind: "large" }; throw err; }
  if (Buffer.byteLength(text) > CONTENT_MAX) return { kind: "large" };
  if (text.slice(0, 8000).includes("\0")) return { kind: "binary" };
  return { kind: "text", text, ...(e.mode === "120000" ? { reference: true } : {}), ...extra };
}
async function pageFromTree(git, root, rev, filePath) {
  const e = parseLsTree(await git(root, contentTreeArgs(rev, filePath)), filePath);
  return e ? blobPage(git, root, e) : { kind: "missing" };
}
/** A conflict (pure, exported for the guard): the path has NO stage 0 in the index but one of the stages 1–3. Not just "stage 2
 *  there" — "deleted by us" (DU: stages 1 and 3) and "added by them" (UA: only stage 3) have no side of ours and are conflicts all
 *  the same (they used to run as "new file (untracked)" against /dev/null, and staging a hunk silently resolved the conflict). */
export function isConflict(stages) {
  return !stages.some((s) => s.stage === 0) && stages.some((s) => s.stage > 0);
}
async function pageFromStages(git, root, stages, { conflict = false } = {}) {
  const null0 = stages.find((s) => s.stage === 0);
  if (null0) return blobPage(git, root, null0);
  const our = conflict ? stages.find((s) => s.stage === 2) : null;
  return our ? blobPage(git, root, our, { stage: 2 }) : { kind: "missing" };
}
// A diff with a cap: `git diff --no-index` ends with 1 on differences (no error), a stopped container passes through.
async function diffCapped(git, root, args) {
  try { return kappeDiff(await git(root, args, { timeout: COMMIT_DEADLINE_MS, maxBuffer: COMMIT_DIFF_MAX + 64 * 1024 }), false); }
  catch (e) {
    if (e?.containerStands || e?.containerPaused || e?.situation || typeof e?.stdout !== "string") throw e;
    if (e.cap === "output") return kappeDiff(e.stdout, true);
    if (e.code === 1) return kappeDiff(e.stdout, false);
    throw e;
  }
}
async function gitDiffWithContent(projectPath, relPath, file, opts) {
  if (opts.content !== true) throw new Error(T("content is true or absent"));
  const filePath = commitPath(file, "file"); // BEFORE the first git
  const staged = !!opts.staged;
  const { root, git, raw } = await repoAt(projectPath, relPath, opts);
  if (staged) {
    const { diff, clipped } = await diffCapped(git, root, diffContentArgs(filePath, true));
    const head = (await raw(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])).trim();
    const prior = HASH.test(head) ? await pageFromTree(git, root, head, filePath) : { kind: "missing" };
    const stages = parseLsFiles(await git(root, contentIndexArgs(filePath)), filePath);
    const after = await pageFromStages(git, root, stages);
    return { path: filePath, staged, diff, clipped, prior, after, ...(isConflict(stages) ? { conflict: true } : {}) };
  }
  const stages = parseLsFiles(await git(root, contentIndexArgs(filePath)), filePath);
  const conflict = isConflict(stages);
  const prior = await pageFromStages(git, root, stages, { conflict: true });
  // Against /dev/null only what the index does not know AT ALL (untracked) — a conflict without our side gets git's own diff.
  const fresh = !conflict && prior.kind === "missing";
  const { diff, clipped } = await diffCapped(git, root, fresh ? diffContentNewArgs(filePath) : diffContentArgs(filePath, false));
  return { path: filePath, staged, diff, clipped, prior, after: { kind: "workingTree" }, ...(conflict ? { conflict: true } : {}) };
}

// ── Stage one change ─────────────────────────────────────────────────────────────────────────────────────────────────────
// VS Code "Stage Change" (git.stageChange) builds the new index content from the index and the BUFFER (applyLineChanges with
// exactly this one change) and writes it with `repository.stage(path, content)` = `hash-object --stdin -w` + `update-index
// --cacheinfo`. The same here: the client sends the block in lines of the INDEX (`from`/`until` half-open, 0-based, counted like
// web/src/lib/dirty-diff.ts — CR LF, CR and LF separate, an empty text has no line), the lines that stood there (`old`), the
// lines from the buffer (`rows` — the UNSAVED text, not the disk), the line count of the index it computed against (`rowCount`),
// and the checksum of this WHOLE index text (`baseSha`: sha256 of the normalized text — CR LF and CR as LF, as the margin holds
// it; `indexChecksum`). If the index moved meanwhile (an agent staged, another window), the checksum no longer fits ⇒ 409
// INDEX_CHANGED, never a block in the wrong place (`old` and the count alone let a pure insertion through at a shifted place).
// Immediately before `update-index` the entry is read a second time; if another object id or mode stands there, it is likewise
// 409 (git has no compare-and-swap for an entry — the window cannot get narrower than between these two calls).
// The index's line endings stay where they were; new lines get the index's prevailing line ending — if the index has none, LF when
// git normalized the file on staging (`text`/`eol` in .gitattributes, otherwise `core.autocrlf` true/input), and otherwise the
// buffer's (`lineEnding`) — as `git add` with the buffer would do.
// FILTER: VS Code writes with `hash-object --stdin -w --path <path>`, the clean filter runs. Here it does NOT (no filter program
// from the repo should ever run in B or in the container) — and with `--no-filters` the raw buffer would stand in the index,
// bypassing Git LFS. So `check-attr` asks `filter`, `working-tree-encoding` and `ident` beforehand; if one is set, it is a 400
// FILTER (staging the whole file still goes through `git add`).
// HARDENING as in "Content of both sides": the path via `commitPath` BEFORE the first git, the entry from `ls-files -s -z` with
// `--literal-pathspecs` and `core.quotePath=false`, read only via the object id; `hash-object --no-filters`; `update-index
// --cacheinfo <mode>,<oid>,<path>` (ONE argument, no path becomes an option). EVERY call carries `-c core.hooksPath=/dev/null -c
// core.fsmonitor=false` (measured with git 2.50: `update-index` calls the hook `post-index-change`, `ls-files` and `check-attr`
// call `core.fsmonitor`) — so no program from the repo's configuration runs. A conflict, a file the index does not know, a
// submodule, a link, binary content and content that is not UTF-8 are rejected (400 NO_TEXT_FILE), a file in the index over 2 MB
// and a block over the limit with the limit in the text (400 BLOCK_TOO_LARGE). Via `repoAt` (with an instance in the project
// container or in the copy). Guard: server/backend/test/git-stage-block.test.js; the argv runs in the scenario
// (projectbox-git-scenario.mjs, "stage-block") with and without an instance.
const STAGE_BLOCK_ROWS_MAX = 60_000; // web/src/lib/dirty-diff.ts SIZE_MAX: the margin computes no more
export const WITHOUT_REPO_PROGRAMS = READ_TOGGLE; // the same set as for every read path (runtime/git-run.js readingArgs)
const blockError = (status, code, text) => Object.assign(new Error(text), { stageBlock: true, status, code });
const TOO_BIG_BLOCK = () => blockError(400, "BLOCK_TOO_LARGE",
  T`The block is too large — staging by block goes up to ${STAGE_BLOCK_ROWS_MAX.toLocaleString(T("en-US##locale"))} lines and ${CONTENT_MAX / 1024 / 1024} MB.`);
/** The checksum of an index text, as the client computes it over its base (web/src/lib/quick-diff.ts `stageBody` → `baseSha`):
 *  sha256 (hex) over the UTF-8 of the text with LF instead of CR LF and CR (pure, exported for the guard). */
export function indexChecksum(text) {
  return crypto.createHash("sha256").update(String(text).replace(/\r\n?/g, "\n"), "utf8").digest("hex");
}
/** The argv of `check-attr` (pure, exported for the guard) — the path without "./" behind `--`. */
export function stageAttributeArgs(filePath) {
  return [...WITHOUT_REPO_PROGRAMS, "-c", "core.quotePath=false", "check-attr", "-z", "filter", "working-tree-encoding", "ident", "text", "eol", "--", withoutPoint(filePath)];
}
/** `check-attr -z` → `{ attribute: value }` (`unspecified`, `unset`, `set` or the value). */
export function parseAttribute(out) {
  const t = String(out ?? "").split("\0"), result = {};
  for (let i = 0; i + 2 < t.length; i += 3) result[t[i + 1]] = t[i + 2];
  return result;
}
const set = (w) => w !== undefined && w !== "unspecified" && w !== "unset";
/** Does the file go through a program or a re-encoding on staging (pure, exported for the guard)? */
export const needsFilter = (a) => set(a.filter) || set(a["working-tree-encoding"]) || set(a.ident);
/** Does git normalize this file's line endings to LF on staging (pure, exported for the guard)? `autocrlf` = `core.autocrlf` ("" without). */
export function normalizedToLf(a, autocrlf) {
  if (a.text === "unset") return false; // -text: never converted
  if (set(a.text) || set(a.eol)) return true; // text, text=auto, eol=… (eol implies text)
  const ac = String(autocrlf || "").trim().toLowerCase();
  return ac === "true" || ac === "input";
}
/** The lines of a text with their separators: `rows[i]` + `separator[i]` gives the text; the last separator is empty. */
function rowsWithSeparators(text) {
  const rows = [], separator = [];
  if (text === "") return { rows, separator };
  const re = /\r\n|\r|\n/g;
  let start = 0, m;
  while ((m = re.exec(text))) { rows.push(text.slice(start, m.index)); separator.push(m[0]); start = m.index + m[0].length; }
  rows.push(text.slice(start)); separator.push("");
  return { rows, separator };
}
const isRows = (a) => Array.isArray(a) && a.every((z) => typeof z === "string" && !/[\r\n]/.test(z));
const isCount = (n) => Number.isInteger(n) && n >= 0;
/** Checks the body of a block request (pure, exported for the guard) — a throw with `status` 400 or the block. */
export function stageBlockBody(b) {
  const r = b && typeof b === "object" ? b : {};
  if (!isCount(r.from) || !isCount(r.until) || r.until < r.from || !isCount(r.rowCount) || r.until > r.rowCount) {
    throw blockError(400, "BLOCK_INVALID", T("from, until and rowCount are integers with 0 ≤ from ≤ until ≤ rowCount"));
  }
  if (!isRows(r.old) || !isRows(r.rows) || r.old.length !== r.until - r.from) {
    throw blockError(400, "BLOCK_INVALID", T("old and rows are lists of lines without line breaks (old has until − from entries)"));
  }
  if (r.rows.length > STAGE_BLOCK_ROWS_MAX || r.rowCount > STAGE_BLOCK_ROWS_MAX
    || r.rows.reduce((n, z) => n + Buffer.byteLength(z) + 2, 0) > CONTENT_MAX) {
    throw TOO_BIG_BLOCK();
  }
  if (r.lineEnding !== "\n" && r.lineEnding !== "\r\n") {
    throw blockError(400, "BLOCK_INVALID", T("lineEnding is \"\\n\" or \"\\r\\n\" (the line ending of the buffer)"));
  }
  if (typeof r.baseSha !== "string" || !/^[0-9a-f]{64}$/.test(r.baseSha)) {
    throw blockError(400, "BLOCK_INVALID", T("baseSha is missing (sha256 of the index text the block was computed against)"));
  }
  return { from: r.from, until: r.until, old: r.old, rows: r.rows, rowCount: r.rowCount, lineEnding: r.lineEnding, baseSha: r.baseSha };
}
const indexChanged = () => blockError(409, "INDEX_CHANGED", T("The index has changed — the change was not staged. Please try again."));
/** The index content with exactly this block (pure, exported for the guard): `text` = the content in the index. Throws 409 INDEX_CHANGED if
 *  the index is no longer the one the client computed against (checksum, line count, `old`). `lfWithoutEnd`: if the index has no line ending,
 *  new lines get LF instead of the buffer's ending (git normalizes the file on staging, `normalizedToLf`). */
export function blockInIndex(text, block, { lfWithoutEnd = false } = {}) {
  const { rows, separator } = rowsWithSeparators(String(text));
  const { from, until, old, rowCount } = block;
  if (indexChecksum(text) !== block.baseSha || rows.length !== rowCount || old.some((z, i) => rows[from + i] !== z)) throw indexChanged();
  const count = (s) => separator.filter((t) => t === s).length;
  const lf = count("\n"), crlf = count("\r\n"), cr = count("\r");
  const newEnd = lf + crlf + cr === 0 ? (lfWithoutEnd ? "\n" : block.lineEnding) : crlf > lf && crlf >= cr ? "\r\n" : cr > lf && cr > crlf ? "\r" : "\n";
  const parts = [
    ...rows.slice(0, from).map((z, i) => ({ z, t: separator[i] })),
    ...block.rows.map((z) => ({ z, t: newEnd })),
    ...rows.slice(until).map((z, i) => ({ z, t: separator[until + i] })),
  ];
  // The last line never ends (its end is the end of the text); a line before it that had none (the old last one) gets one.
  return parts.map((s, i) => s.z + (i === parts.length - 1 ? "" : s.t || newEnd)).join("");
}
export async function gitStageBlock(projectPath, relPath, file, body, opts = {}) {
  const filePath = commitPath(file, "file"); // BEFORE the first git
  const block = stageBlockBody(body);
  const turnedOn = await repoAt(projectPath, relPath, opts);
  const root = turnedOn.root;
  const git = (r, args, o) => turnedOn.git(r, [...WITHOUT_REPO_PROGRAMS, ...args], o);
  const raw = (r, args, o) => turnedOn.raw(r, [...WITHOUT_REPO_PROGRAMS, ...args], o);
  const entry = async () => parseLsFiles(await git(root, contentIndexArgs(filePath)), filePath);
  const stages = await entry();
  if (isConflict(stages)) throw blockError(409, "CONFLICT", T("The file has a conflict — resolve it first."));
  const e = stages.find((s) => s.stage === 0);
  if (!e) throw blockError(409, "NOT_IN_INDEX", T("The file is not in the index (untracked)."));
  if (e.mode !== "100644" && e.mode !== "100755") {
    throw blockError(400, "NO_TEXT_FILE", T("Only a text file can be staged by block (no submodule, no symbolic link)."));
  }
  const attribute = parseAttribute(await turnedOn.git(root, stageAttributeArgs(filePath)));
  if (needsFilter(attribute)) {
    throw blockError(400, "FILTER", T("This file goes through a Git filter when staged (filter, ident or working-tree-encoding in .gitattributes, e.g. Git LFS) — staging by block would bypass it. Please stage the whole file."));
  }
  const page = await blobPage(git, root, e);
  if (page.kind === "large") {
    throw blockError(400, "BLOCK_TOO_LARGE", T`The file in the index is larger than ${CONTENT_MAX / 1024 / 1024} MB — staging by block only goes up to this limit.`);
  }
  if (page.kind !== "text" || page.text.includes("\uFFFD")) {
    throw blockError(400, "NO_TEXT_FILE", T("The content in the index is not UTF-8 text — staging by block is not possible."));
  }
  // Without a line ending in the index and with CR LF in the buffer git's normalization decides; `core.autocrlf` is only asked if
  // no attribute decides already.
  const withoutEnd = !/[\r\n]/.test(page.text) && block.lineEnding === "\r\n" && block.rows.length > 0;
  const autocrlf = withoutEnd && attribute.text === "unspecified" && !set(attribute.eol) ? await raw(root, ["config", "--get", "core.autocrlf"]) : "";
  const fresh = blockInIndex(page.text, block, { lfWithoutEnd: withoutEnd && normalizedToLf(attribute, autocrlf) });
  const oid = (await turnedOn.gitStdin(root, [...WITHOUT_REPO_PROGRAMS, "hash-object", "-w", "--stdin", "--no-filters"], fresh)).trim();
  if (!HASH.test(oid)) throw new Error(T("git hash-object returned no object id"));
  // Second read immediately before the write: if the same entry no longer stands there, it is 409.
  const now = (await entry()).find((s) => s.stage === 0);
  if (!now || now.oid !== e.oid || now.mode !== e.mode) throw indexChanged();
  await git(root, ["update-index", "--cacheinfo", `${e.mode},${oid},${withoutPoint(filePath)}`]);
  return { ok: true };
}

// ── One commit, hovered ─────────────────────────────────────────────────────────────────────────────────────────────────
// The third option of `POST …/git/show` — the hover card in the graph of the git bar (web/src/components/git-bar/CommitCard.tsx,
// like VS Code's card: author, time, the whole message, "n files changed, n insertions(+), n deletions(−)", hash):
//   { hash, info: true } → { hash, parent, author, email, time, message, messageClipped, files, plus, minus, binary, countsClipped }
//   `author`/`email` are %an/%ae (the same name as in the graph's row), `time` the AUTHOR time in ms (%at — like VS Code, which shows
//   `authorDate`; the graph's row carries the commit time %ct, a rewritten commit tells them apart), `message` the whole message (%B:
//   subject and body, line breaks kept, only trailing whitespace drops), at most COMMIT_MESSAGE_MAX bytes at a character boundary
//   (`messageClipped`). The counts against the FIRST parent — the same base as the files of the expanded commit (`--root` for a
//   root): `files` counts every changed file, binary ones too; `plus`/`minus` are lines of the text files; `binary` says how many of
//   the files are binary — they have no lines, and "0 insertions" alone would hide them. If the output cap hits, all four are `null`
//   and `countsClipped` is true: unknown, not "this many".
// DECIDED: three calls one after the other (rev-list to resolve as above, `log -1` for header and message, `diff-tree --numstat` for
// the counts), not side by side — the argv anchor (projectbox-git-scenario.mjs, "show-info") fixes the order, and with an instance
// every call is a `docker exec` of the same shell. `log -1 --no-show-signature` (no gpg from `log.showSignature`), `--encoding=UTF-8`
// (a Latin-1 message arrives re-encoded), `--no-color`; the fields are separated by NUL (%x00) — `git commit` accepts no message with
// NUL, a name cannot carry one (an object built by hand with NUL in the message loses it, `parseCommitInfo`). `diff-tree --numstat -z`
// with `-M` (a rename is ONE file, as in the file list and as `git show --shortstat`), `--no-ext-diff --no-textconv` (no program from
// the configuration counts lines).
// Guard: server/backend/test/git-commit-files.test.js (part "info"), in the scenario as step "show-info" with and without an instance.
export const COMMIT_MESSAGE_MAX = 16 * 1024;
export const COMMIT_INFO_FORMAT = "%an%x00%ae%x00%at%x00%B";
// The fields of the answer, in their order — ONE list: server/backend/test/git-commit-files.test.js holds that the route sends exactly
// these; web/test/git-card.test.mjs reads them here (by path, as a literal) and holds that `normGitCommitInfo` (lib/api/git.ts) reads
// exactly these.
export const COMMIT_INFO_FIELDS = ["hash", "parent", "author", "email", "time", "message", "messageClipped", "files", "plus", "minus", "binary", "countsClipped"];

/** The argv of header and message (pure, exported for the guard). */
export function commitInfoArgs(hash) {
  return ["log", "-1", "--no-show-signature", "--no-color", "--encoding=UTF-8", `--format=${COMMIT_INFO_FORMAT}`, hash, "--"];
}
/** The argv of the counts (pure, exported for the guard). `parent1` null = root commit. */
export function commitCountsArgs(parent1, hash) {
  return ["diff-tree", "-r", "-M", "--no-commit-id", "--numstat", "-z", "--no-ext-diff", "--no-textconv", ...(parent1 ? [parent1, hash] : ["--root", hash])];
}

// At most `max` bytes of UTF-8, never in the middle of a character (a continuation byte 10xxxxxx at the cut moves it to the start of its character).
function kappeUtf8(s, max) {
  const b = Buffer.from(s, "utf8");
  if (b.length <= max) return s;
  let end = max;
  while (end > 0 && (b[end] & 0xc0) === 0x80) end -= 1;
  return b.subarray(0, end).toString("utf8");
}

/** The output of `log -1 --format=COMMIT_INFO_FORMAT` → `{ author, email, time, message, messageClipped }`. `cutOff`: the output cap
 *  hit (the message is then clipped in any case). Without the three separators it is no answer — a throw. */
export function parseCommitInfo(out, { cutOff = false, max = COMMIT_MESSAGE_MAX } = {}) {
  const parts = String(out ?? "").split("\0");
  if (parts.length < 4) throw new Error(T("git log returned no header for the commit"));
  const [author, email, at] = parts;
  const sec = /^\d+$/.test(at) ? Number(at) : 0;
  const rawText = parts.slice(3).join("").trimEnd(); // trimEnd, not /\s+$/: that expression would run quadratically over long runs of whitespace
  const message = kappeUtf8(rawText, max);
  return { author, email, time: sec > 0 ? sec * 1000 : null, message, messageClipped: cutOff || message.length < rawText.length };
}

/** The output of `diff-tree --numstat -z` → `{ files, plus, minus, binary }` or `null` if it does not have the shape (then the counts are
 *  unknown — never half-counted). A rename (`a\tb\t` with an empty path) carries the old and the new path after it; a binary file stands
 *  as `-\t-`: it counts as a file, not as lines. */
export function parseNumstat(out) {
  const parts = String(out ?? "").split("\0");
  let files = 0, plus = 0, minus = 0, binary = 0;
  for (let i = 0; i < parts.length;) {
    if (!parts[i]) { i += 1; continue; }
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(parts[i]);
    if (!m) return null;
    if (m[3] === "") {
      if (!parts[i + 1] || !parts[i + 2]) return null;
      i += 3;
    } else i += 1;
    files += 1;
    if (m[1] === "-" || m[2] === "-") binary += 1;
    else { plus += Number(m[1]); minus += Number(m[2]); }
  }
  return { files, plus, minus, binary };
}

async function commitInfo(git, root, full, parent) {
  let header;
  let cutOff = false;
  try { header = await git(root, commitInfoArgs(full), { maxBuffer: COMMIT_MESSAGE_MAX + 64 * 1024 }); }
  catch (e) {
    if (e?.cap !== "output" || typeof e.stdout !== "string") throw e;
    header = e.stdout;
    cutOff = true;
  }
  const info = parseCommitInfo(header, { cutOff });
  let counts = null;
  let countsClipped = false;
  try { counts = parseNumstat(await git(root, commitCountsArgs(parent[0] || null, full), { timeout: COMMIT_DEADLINE_MS, maxBuffer: COMMIT_LIST_OUTPUT })); }
  catch (e) {
    if (e?.cap !== "output") throw e;
    countsClipped = true;
  }
  return { hash: full, parent, ...info, ...(counts ?? { files: null, plus: null, minus: null, binary: null }), countsClipped };
}

// Cherry-pick (conflict-tolerant).
export async function gitCherryPick(projectPath, relPath, hash, opts = {}) {
  const { root, git, raw } = await repoAt(projectPath, relPath, opts);
  const h = String(hash || "");
  if (!/^[0-9a-f]{5,40}$/i.test(h)) throw new Error(T("Invalid commit hash"));
  try { await git(root, ["cherry-pick", h]); return { ok: true }; }
  catch (e) { if (hasConflicts(await raw(root, ["status", "--porcelain"]))) return { ok: true, conflicts: true }; throw e; }
}

// ── Worktrees ─────────────────────────────────────────────────────────────────
export async function gitWorktreeList(projectPath, relPath, opts = {}) {
  const { root, raw } = await repoAt(projectPath, relPath, opts);
  const out = await raw(root, ["worktree", "list", "--porcelain"]);
  const worktrees = [];
  let cur = null;
  for (const ln of out.split("\n")) {
    if (ln.startsWith("worktree ")) { if (cur) worktrees.push(cur); cur = { path: ln.slice(9), branch: "", head: "", locked: false }; }
    else if (cur && ln.startsWith("HEAD ")) cur.head = ln.slice(5, 12);
    else if (cur && ln.startsWith("branch ")) cur.branch = ln.slice(7).replace("refs/heads/", "");
    else if (cur && ln === "detached") cur.branch = "(detached)";
    else if (cur && ln.startsWith("locked")) cur.locked = true;
  }
  if (cur) worktrees.push(cur);
  return { worktrees };
}
export async function gitWorktreeAdd(projectPath, relPath, wtPath, branch, opts = {}) {
  const { root, git } = await repoAt(projectPath, relPath, opts);
  const p = String(wtPath || "").trim();
  if (!p) throw new Error(T("Path missing"));
  noOption(p, T("worktree path##invalid value")); // `--lock`, `--orphan`, …
  if (branch) noOption(branch, T("branch##invalid value"));
  if (opts.newBranch) noOption(opts.newBranch, T("new branch##invalid value"));
  const args = ["worktree", "add"];
  if (opts.newBranch) args.push("-b", String(opts.newBranch));
  args.push(p);
  if (branch) args.push(String(branch));
  await git(root, args, { timeout: 60000 });
  return { ok: true };
}
export async function gitWorktreeRemove(projectPath, relPath, wtPath, opts = {}) {
  const { root, git } = await repoAt(projectPath, relPath, opts);
  noOption(wtPath, T("worktree path##invalid value"));
  await git(root, ["worktree", "remove", "--force", String(wtPath || "")]);
  return { ok: true };
}

// ── Submodule ─────────────────────────────────────────────────────────────────
export async function gitSubmoduleStatus(projectPath, relPath, opts = {}) {
  const { root, raw } = await repoAt(projectPath, relPath, opts);
  const out = await raw(root, ["submodule", "status", "--recursive"]);
  const submodules = out.split("\n").filter(Boolean).map((ln) => {
    const flag = ln[0]; // ' '=ok, '-'=not initialized, '+'=other commit, 'U'=conflict
    const m = ln.slice(1).match(/^([0-9a-f]+)\s+(\S+)(?:\s+\((.+)\))?/);
    return m ? { sha: m[1].slice(0, 8), path: m[2], describe: m[3] || "", state: flag === "-" ? "uninitialized" : flag === "+" ? "modified" : flag === "U" ? "conflict" : "ok" } : null;
  }).filter(Boolean);
  return { submodules };
}
// With an instance WITHOUT a deadline (content) and with the accesses of the hosts the repo and its submodules network to
// (runtime/git-run.js networkHosts: remotes, `.gitmodules`, local `submodule.<n>.url` — there the https address stands after a
// clone), in list form: each token only to its host. `opts.accessesFor(hosts)` supplies them (devtools/code-route.js from the
// workspace's accesses — git.js does not know the store). Submodules of deeper levels on a host that does not appear above get no
// access. Without an instance the call as it was, byte-equal.
export async function gitSubmoduleUpdate(projectPath, relPath, opts = {}) {
  const { root, git, instance } = await repoAt(projectPath, relPath, opts);
  if (!instance) {
    await git(root, ["submodule", "update", "--init", "--recursive"], { timeout: 120000 });
    return { ok: true };
  }
  const hosts = await networkHosts(instance, root, { submodule: true });
  const env = accessAsEnvironment(typeof opts.accessesFor === "function" ? opts.accessesFor(hosts) : []);
  await git(root, ["submodule", "update", "--init", "--recursive"], { withoutDeadline: true, env });
  return { ok: true };
}

// Push with upstream detection: without an upstream `push -u origin <branch>`, otherwise `push`.
// Longer timeout (network); fails fast thanks to GIT_TERMINAL_PROMPT=0 when credentials are missing.
// `git` is the repo's starter (repoAt) — without it the module starter as before.
async function pushRepo(root, env = {}, git = gitModule) {
  let hasUpstream = true;
  try { await git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]); }
  catch { hasUpstream = false; }
  if (hasUpstream) {
    await git(root, ["push"], { timeout: 60000, env });
  } else {
    const branch = (await git(root, ["symbolic-ref", "--short", "HEAD"])).trim();
    if (!branch) throw new Error(T("Detached HEAD — no branch to push"));
    await git(root, ["push", "-u", "origin", branch], { timeout: 60000, env });
  }
}
export async function gitPush(projectPath, relPath, auth, opts = {}) {
  const { root, pushRepo, access } = await repoAt(projectPath, relPath, opts);
  await pushRepo(root, access(auth));
  return { ok: true };
}

// Switch branch (or create a new one with create=true).
export async function gitCheckout(projectPath, relPath, branch, opts = {}) {
  const { root, git } = await repoAt(projectPath, relPath, opts);
  const b = String(branch || "").trim();
  if (!b) throw new Error(T("Branch name missing"));
  noOption(b, T("branch##invalid value")); // `--orphan=…`, `-f` (discards changes)
  await git(root, opts.create ? ["checkout", "-b", b] : ["checkout", b]);
  return { ok: true };
}
