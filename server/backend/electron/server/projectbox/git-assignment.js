// Who owns a repo, and the list for `cbase-git`. Administrative git of a converted project runs in the project container; on the
// workspace level (it stays in B) the LOCATION of a repo decides — and its common git directory:
//
// THE ROOTS of a converted project: its folder and its WHOLE runtime folder (`locationFor({projectId, converted: true}).root`,
//     `<data>/projects/<id>`): subagents and graph workflows put their worktrees there, but the project container creates `.git`
//     folders everywhere in the runtime folder (output per chat, the CLI home). Both lie at the same path in the project container
//     (creation.js mountRules "project", "runtime"). Each root physically (after realpath, even if it does not exist yet: the next
//     existing ancestor) and as it stands in the store or in `locationFor`.
//
// THE ROOTS OF A COPY: the worktrees of the subagents and graph runs of a chat in its copy live under
//     `<runtime>/copy-worktrees/<name>/` (runs/runtime-location.js worktreeRoot) — NEXT TO the main worktrees folder, so that the
//     assignment by path gives them to the COPY and not to the main instance (below the main folder the aftercare would run in the
//     main instance). Every instance row `copy-<name>` with `converted_at` (from `ready`; the observer below follows exactly this
//     column, also its deletion) brings ONE root; the original path of the project stays with the main instance in B (the copy sees
//     it as an overlay, in B the main instance lies there). The path of a repo under such a root belongs to the copy —
//     `runInstance(id, "copy-<name>")`; if the row no longer exists, the assignment THROWS: never a fallback to the main instance or
//     to B. The same holds for ANY path under `<runtime>/copy-worktrees/` (the collective root of the project, `location.copyWorktrees`),
//     even if the row is already gone: a leftover after clearing away would otherwise have fallen to the main instance through its
//     common git directory — the path of the original in B. The collective root appears in the list for `cbase-git` as a LOCK ROW
//     (see "THE LOCK ROWS" below; the roots of live copies below it are longer and win). A root under the runtime folder counts only
//     if no part in between is a link (`rootUnder`).
//
// gitInstanceForWorkspace()   → `(path) => instance | null` or `null`. A repo belongs to a converted project if (1) its location lies
//     physically under a root of the project (longest prefix), otherwise (2) its COMMON git directory does (a linked worktree outside
//     shares `.git/config` and `.git/hooks` with the main repo — `commonGitDirectory`, the file system ONLY, no git in B). Its commands
//     run in that instance, all others as today in B; if the container does not see the folder (case 2), git fails there visibly —
//     never silently in B. The converted projects of ALL workspaces count (a superset of the "project paths of the workspace": if
//     the folder of a project lies under a foreign workspace, its container can still write the hooks). `null` without the ops marker
//     and without any converted project — then codeRoute gets no instance source, and every call is today's. The instance itself comes
//     through runInstance (run-instance.js): if unreadable it THROWS — the route fails visibly instead of starting git in B.
//
// THE LIST FOR `cbase-git` (server/backend/cbase-git: the wrapper VS Code in B gets as `git.path`). It cannot ask — it is an sh script
// that runs at every git call of VS Code — so the backend writes what it must know: per root of a converted project a row
// `<projectId>\t<path>` (physical and, if different, also as it stands in the store — cbase-project takes the store form as the working
// folder in the container). The common git directory the wrapper computes itself. A path with a line break cannot be represented:
// instead of silently omitting it (git would then run in B), the row `!incomplete` stands in the list and the wrapper refuses
// EVERY call with a message. (The tokens `!incomplete` and `!locked` are the file format read by cbase-git.)
//   gitProjectsPath()        `CBASE_GIT_PROJECTS` or `<DIRS.data>/git-projects` (in the image `~/cbase/data/git-projects`, the same
//                            place the wrapper reads without an argument)
//   writeGitProjects()       ONLY with the ops marker: writes the list (tmp + rename — the wrapper never reads a half one), also empty
//                            (then old rows go). → `{ ops: false }` | `{ path, rows, written }`. Never throws; unreadable instances or a
//                            write error ⇒ `{ error }`, and the existing list is marked `!incomplete` (otherwise it would stay as
//                            it was, and a stale list would send git to B; an empty one likewise: empty is not unknown). A failure
//                            schedules ONE repetition (otherwise the mark would stand until `converted_at` changes the next time,
//                            possibly never, and the wrapper would refuse EVERY git until then): after `CBASE_GIT_LIST_REPEAT_MS`
//                            (default 30 s; 0 switches it off), twice as long per further failure, at most 10 min; at most one open at a
//                            time, unref (keeps no process alive); a successful write — whoever makes it — cancels it. Test seam
//                            `setGitListClock({ schedule, abort })`.
//   gitProjectsIncomplete()  ONLY with the ops marker: `!incomplete` in front of the existing list (or a new one with the mark alone);
//                            the start calls it BEFORE the first read of the instances (server.js, before initStore).
//   Callers: the start (server.js, after setInProjectSeam and setGitLocksAddition) — and EVERY change of `converted_at` (creating,
//   changing, deleting a row that carried it): the observer of the data layer (store/project-instances.js setConvertedObserver, set in
//   server.js to this function; batched as a microtask). Guard: server/backend/test/projectbox-git.test.js "(K)".
//
// THE GIT ACCESS FOR `cbase-project`. A network command from VS Code in a converted project (through cbase-git → `cbase-project
// --git-access`) gets ONLY the stored git access of the workspace — the same source as part A (workspaces/git-auth.js gitAuthCtx →
// store.getGitCred), never the access of VS Code, of B's global helper or of the Mac: in B no `git credential` runs for this any more.
// cbase-project asks THIS backend:
//   POST /api/workspaces/:wid/git-access   body `{ hosts: ["git.example.com", …] }` → `{ accesses: { <host>: { username, secret } } }`
//       (only hosts with a stored access; `Cache-Control: no-store`). Only with the ops marker (otherwise 404 ONLY_IN_OPS), only from
//       loopback (the gateway, and with it every browser, comes from outside: 403), only with the key in the header `x-cbase-git-key`
//       (otherwise 403). From a project network the fence already rejects — 401 without a token, 403 with one (fence-table.js
//       "git-access", rejected). The principle "never to a project container" holds for THIS route: there is a second one that gives
//       the stored access of ONE host for Git LFS to an agent shell — `POST /api/projects/:id/lfs-access` (projectbox/lfs-access.js,
//       fence row "lfs-access" allowed, only with the token of the instance).
//   createGitAccessKey()  at start (server.js, only with the ops marker): 32 random bytes, in the memory of this backend start and in
//       `<DIRS.data>/git-access.key` (0600, tmp + rename; `CBASE_GIT_KEY` changes the place). `<DIRS.data>` itself is mounted by no
//       project container — only `<data>/projects/<id>` (mountRules "runtime"); whoever runs in B as agent can read the file (VS Code,
//       the terminal, a run in B — the same ones that can read the DB today). The value of an earlier start no longer counts.
//   gitAccessResponse({ source, key, workspaceId, body })  the verdict of the route, pure over the store.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as store from "../store.js";
import { DIRS } from "../app-state.js";
import { locationFor, worktreeRoot } from "../runs/runtime-location.js";
import { MAIN, COPIES_FOLDER, COPY_PREFIX } from "./creation.js";
import { realRoot, realRoots, openFileWithoutReference } from "../runtime/real-path.js";
import { ONLY_IN_OPS, projectboxOps } from "./ops.js";
import { runInstance } from "./run-instance.js";
import { convertedProjects } from "./network-targets.js";

export const GIT_PROJECTS_FILE = "git-projects";
export const INCOMPLETE = "!incomplete";

export const LOCKED = "!locked";

// THE LOCK ROWS. Under `<data>/copies` lie the layers of the copies (a copy container writes `.git`, hooks, `core.fsmonitor` there),
// under `<data>/copies-backup` their backups. No project owns these places, so they would fall through in the list — and `cbase-git`
// would start git in B there. With the ops marker therefore ALWAYS (also without a converted project) one row `!locked\t<path>`
// (physical and literal) per place stands in the list; plus per converted project `<runtime>/copy-worktrees` (the collective root — a
// LIVE copy lies deeper below it and wins). The wrapper refuses every call under a lock row (exit 128), even if only the common git
// directory lies there; gitInstanceForWorkspace throws there. The backup folder is known only to stacks/ (stacks/location.js
// neverMountedCopies — projectbox/ never imports stacks/): server.js sets it through `setGitLocksAddition` (the same pattern as
// instance.js setNeverMountedAddition). Without the setter the list is incomplete (`!incomplete`): empty is not unknown.
let locksAddition = null;
export function setGitLocksAddition(fn) { locksAddition = typeof fn === "function" ? fn : null; }
/** The lock places of `<data>` — literal; `null` as long as the setter is missing. */
function lockLocations() {
  if (!locksAddition) return null;
  const addition = (locksAddition({ data: DIRS.data }) || []).map((x) => x?.path).filter((p) => typeof p === "string" && p);
  return [...new Set([path.join(DIRS.data, COPIES_FOLDER), ...addition].map((p) => path.resolve(p)))];
}

// Physical — also for a path that does not exist (yet): the next existing ancestor after realpath, the rest behind it (the worktree
// folder arises only with the first worktree; if `<data>` lay behind a link, its physical row would otherwise be missing until the
// next write of the list). Only for the TRUSTED anchors (project folder, runtime folder — mount points the project container cannot
// replace) and for `<data>`; a root UNDER the runtime folder goes through `rootUnder`.
function real(p) {
  const abs = path.resolve(String(p));
  let header = abs;
  const rest = [];
  for (;;) {
    try { return path.join(fs.realpathSync.native(header), ...rest.reverse()); } catch { /* go further up */ }
    const top = path.dirname(header);
    if (top === header) return abs;
    rest.push(path.basename(header));
    header = top;
  }
}
const liesIn = (kind, parent) => kind === parent || kind.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

// A root UNDER the runtime folder: `location.copyWorktrees` and its subfolder per copy are ordinary subfolders of the rw-mounted
// runtime folder — the project container can replace them with a link (`→` the repo of another project, `→ /`), and their realpath
// would make its target a root of THIS project. It is therefore determined like runtime/real-path.js realRoot: realpath of the anchor
// (the runtime folder) plus the relative rest, and if a part in between is a link, the LITERAL root counts (its realpath does not
// count — physically nothing of this project lies there).
const rootUnder = (w, anchor) => realRoot(w, [anchor]) || path.resolve(w);

// The converted projects with their roots (see header): [{ projectId, roots: [{ path, real, instance? }], copies: { path, real } }].
// `instance` is carried only by the roots of a copy: the name of the instance `copy-<name>`; if missing, the root belongs to the main
// instance. `copies` is the collective root of all copies of the project (for assigning a path; a lock row in the list). The roots of
// the main instance: the project folder and the WHOLE runtime folder — the project container creates `.git` folders everywhere there
// (output per chat, the CLI home), and in B git ran in them with hooks and `core.fsmonitor` it can write. The worktrees folder lies
// inside it (physical and literal).
function convertedWithPath() {
  const ids = convertedProjects(); // throws if unreadable
  if (!ids.size) return [];
  const out = [];
  for (const id of ids) {
    const p = store.getProject(id);
    if (!p?.path) continue;
    const location = locationFor({ projectId: id, converted: true });
    const roots = [p.path, location.root].map((x) => ({ path: path.resolve(x), real: real(x) }));
    // The rows of the copies; the root is determined by runs/runtime-location.js (ONE place for the literals).
    for (const z of store.projectInstancesOf(id)) {
      if (z.instance === MAIN || !z.instance.startsWith(COPY_PREFIX) || !z.convertedAt) continue;
      const w = worktreeRoot(location, z.instance);
      roots.push({ path: path.resolve(w), real: rootUnder(w, location.root), instance: z.instance });
    }
    out.push({ projectId: id, roots, copies: { path: path.resolve(location.copyWorktrees), real: rootUnder(location.copyWorktrees, location.root) } });
  }
  return out;
}

// The first line of a pointer file (`.git` file, `commondir`) — WITHOUT a link, O_NONBLOCK, only a regular file, capped: the folder that
// carries it is the area (runtime/real-path.js openFileWithoutReference). A FIFO there would have stopped B (readFileSync waits for a
// writer), a link read a file of B. Throws on anything else; `ENOENT` means: it does not exist.
const POINTER_CAP = 64 * 1024; // ESTIMATED: a `.git` file and `commondir` carry ONE path line
function firstRow(file) {
  const fd = openFileWithoutReference(file, realRoots([path.dirname(file)]));
  try {
    const size = fs.fstatSync(fd).size;
    if (size > POINTER_CAP) throw Object.assign(new Error(`${file}: larger than ${POINTER_CAP} bytes`), { code: "ECAP" });
    const buffer = Buffer.alloc(size);
    let n = 0;
    for (let k; n < size && (k = fs.readSync(fd, buffer, n, size - n, n)) > 0;) n += k;
    return buffer.toString("utf8", 0, n).split("\n")[0].replace(/\r$/, "");
  } finally { fs.closeSync(fd); }
}

/**
 * The common git directory of the repo in which `path` lies — physical, or null (no repo). Like git climbing to the root: the first
 * `.git` (a folder, or a file `gitdir: <path>`, relative to its folder), in it `commondir` (relative to the gitdir). Reads the file
 * system ONLY — no git runs in B for this. Both pointer files without a link and O_NONBLOCK (see firstRow): a `.git` FILE that cannot
 * be read so (link, FIFO, too large) is no hit (null); a `commondir` that cannot be read so does not count — the gitdir itself is then
 * the directory (like the wrapper cbase-git: its `[ -f … ]` takes only a regular file).
 */
export function commonGitDirectory(filePath) {
  if (!filePath) return null;
  let d = path.resolve(String(filePath));
  for (;;) {
    const dotgit = path.join(d, ".git");
    let st = null;
    try { st = fs.statSync(dotgit); } catch { /* none here */ }
    if (st) {
      let gitdir = null;
      if (st.isDirectory()) gitdir = dotgit;
      else if (st.isFile()) {
        let z = "";
        try { z = firstRow(dotgit); } catch { return null; }
        if (!z.startsWith("gitdir: ")) return null;
        gitdir = path.resolve(d, z.slice("gitdir: ".length));
      }
      if (!gitdir) return null;
      let common = gitdir;
      try {
        const c = firstRow(path.join(gitdir, "commondir"));
        if (c) common = path.resolve(gitdir, c);
      } catch { /* not a linked worktree — or a commondir that does not count (see above) */ }
      return real(common);
    }
    const top = path.dirname(d);
    if (top === d) return null;
    d = top;
  }
}

/** The instance source of the workspace level — see header. */
export function gitInstanceForWorkspace() {
  if (!projectboxOps()) return null;
  const projects = convertedWithPath();
  if (!projects.length) return null;
  // Longer roots first: the first hit is the longest prefix. Plus per project the collective root of its copies (`collecting`): it is
  // shorter than any root of a live copy and hits only the path whose copy has no row any more. The lock places: the same as in
  // the list — under them nothing belongs to a project, and nothing runs in B.
  const lock = (lockLocations() || [path.join(DIRS.data, COPIES_FOLDER)]).flatMap((s) => [...new Set([real(s), s])]);
  const roots = projects.flatMap((x) => [
    ...x.roots.map((w) => ({ projectId: x.projectId, real: w.real, instance: w.instance || MAIN })),
    { projectId: x.projectId, real: x.copies.real, instance: null, collecting: true },
  ]).sort((a, b) => b.real.length - a.real.length);
  const owner = (p) => roots.find((x) => liesIn(p, x.real)) || null;
  const locked = (p, b) => lock.find((s) => liesIn(p, s) && !(b && b.real.length > s.length)) || null;
  const lockError = (p, s) => new Error(`The path ${p} lies under ${s} (layers or backups of a copy) — no git there, not even in B`);
  return (filePath) => {
    if (!filePath) return null;
    const here = real(String(filePath));
    let b = owner(here);
    const s1 = locked(here, b);
    if (s1) throw lockError(here, s1);
    const g = commonGitDirectory(filePath);
    if (g) {
      const s2 = locked(g, owner(g));
      if (s2) throw lockError(g, s2);
      if (!b) b = owner(g);
    }
    if (!b) return null;
    if (b.collecting) {
      // Under `copy-worktrees/`, but under no live copy: the first folder below is the name — the row does not exist (any more), so
      // the assignment throws instead of giving it to the main instance.
      const name = path.relative(b.real, here).split(path.sep)[0];
      throw new Error(`The path ${here} lies under the worktrees of a copy${name ? ` (“${name}”)` : ""}, which does not exist (any more) — no git in the main instance and none in B`);
    }
    if (b.instance === MAIN) return runInstance(b.projectId);
    // A path under the worktree root of a copy belongs to THIS copy. If its row no longer exists (a leftover after clearing away),
    // the main instance is not the answer and B even less — the route fails visibly.
    const inst = runInstance(b.projectId, b.instance);
    if (!inst) throw new Error(`The copy ${b.instance} of project ${b.projectId} cannot be resolved — no git in the main instance and none in B`);
    return inst;
  };
}

export const gitProjectsPath = () => process.env.CBASE_GIT_PROJECTS || path.join(DIRS.data, GIT_PROJECTS_FILE);

/** Mark the existing list as incomplete: `!incomplete` in front, the rows stay below; if it is missing, it arises with the mark
 *  alone. Only with the ops marker; never throws. The start calls this BEFORE the first read of the instances (server.js, before
 *  initStore), writeGitProjects on a read or write error — the wrapper then refuses every call instead of deciding by a stale
 *  list. → `{ ops: false }` | `{ path }` | `{ error, path }`. */
export function gitProjectsIncomplete() {
  if (!projectboxOps()) return { ops: false };
  const target = gitProjectsPath();
  try {
    let old = "";
    try { old = fs.readFileSync(target, "utf8"); } catch (e) { if (e?.code !== "ENOENT") throw e; }
    if (old.split("\n")[0] === INCOMPLETE) return { path: target };
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${INCOMPLETE}\n${old}`, { mode: 0o644 });
    fs.renameSync(tmp, target);
    return { path: target };
  } catch (e) {
    const error = `list for cbase-git not marked as incomplete (${target}): ${e?.message || e}`;
    console.warn(`[projectbox] ${error}`);
    return { error, path: target };
  }
}

// ── The repetition after a failure (see header) ─────────────────────────────────────────────────────────
export const GIT_LIST_REPEAT_DEFAULT_MS = 30_000;
export const GIT_LIST_REPEAT_CAP_MS = 10 * 60_000;
const CLOCK_DEFAULT = Object.freeze({
  schedule: (f, ms) => { const t = setTimeout(f, ms); t.unref?.(); return t; },
  abort: (t) => clearTimeout(t),
});
let listClock = CLOCK_DEFAULT;
let repetition = null; // the open repetition (at most one)
let failures = 0; // failures in a row — the delay doubles with each further one

function repetitionCancel() {
  if (repetition !== null) { listClock.abort(repetition); repetition = null; }
}
function repetitionSchedule() {
  failures++;
  if (repetition !== null) return;
  const raw = process.env.CBASE_GIT_LIST_REPEAT_MS;
  const base = raw === undefined || raw === "" ? GIT_LIST_REPEAT_DEFAULT_MS : Number(raw);
  if (!Number.isFinite(base) || base <= 0) return;
  const ms = Math.min(GIT_LIST_REPEAT_CAP_MS, base * 2 ** Math.min(failures - 1, 20));
  repetition = listClock.schedule(() => { repetition = null; writeGitProjects(); }, ms);
}
function writtenWithoutError() {
  failures = 0;
  repetitionCancel();
}
/** Test seam: the clock of the repetition (`{ schedule(f, ms) → id, abort(id) }`), `null` = the real one. Cancels an open one. */
export function setGitListClock(clock) {
  repetitionCancel();
  failures = 0;
  listClock = clock || CLOCK_DEFAULT;
}

/** Write the list for cbase-git — see header. */
export function writeGitProjects() {
  if (!projectboxOps()) { writtenWithoutError(); return { ops: false }; }
  const target = gitProjectsPath();
  let projects;
  try { projects = convertedWithPath(); } catch (e) {
    const error = `list for cbase-git not written: instances unreadable (${e?.message || e}) — ${target} is marked as incomplete`;
    console.warn(`[projectbox] ${error}`);
    gitProjectsIncomplete();
    repetitionSchedule();
    return { error, path: target };
  }
  const rows = [];
  // The lock rows: `<data>/copies`, `<data>/copies-backup` — ALWAYS; without the setter the list does not know everything.
  const lock = lockLocations();
  if (!lock) rows.push(INCOMPLETE);
  const lockRow = (p) => {
    if (/[\r\n]/.test(p)) { rows.unshift(INCOMPLETE); return; }
    rows.push(`${LOCKED}\t${p}`);
  };
  for (const s of lock || []) for (const p of new Set([real(s), s])) lockRow(p);
  for (const x of projects) for (const p of new Set([x.copies.real, x.copies.path])) lockRow(p);
  for (const x of projects) {
    for (const w of x.roots) {
      // The key of the row is the target of `cbase-project`: `<projectId>` for the main instance, `<projectId>/<name>` for a copy (its
      // resolution takes the name WITHOUT "copy-"; `<pid>/copy-<name>` would not find it).
      const name = w.instance ? w.instance.slice(COPY_PREFIX.length) : "";
      const key = w.instance ? `${x.projectId}/${name}` : x.projectId;
      for (const p of new Set([w.real, w.path])) {
        if (/[\r\n]/.test(p) || /[\t\r\n]/.test(x.projectId) || /[\t\r\n]/.test(name)) { rows.unshift(INCOMPLETE); continue; }
        rows.push(`${key}\t${p}`);
      }
    }
  }
  const text = rows.length ? `${[...new Set(rows)].join("\n")}\n` : "";
  try {
    if (fs.existsSync(target) && fs.readFileSync(target, "utf8") === text) {
      writtenWithoutError();
      return { path: target, rows: rows.length, written: false };
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text, { mode: 0o644 });
    fs.renameSync(tmp, target);
    writtenWithoutError();
    return { path: target, rows: rows.length, written: true };
  } catch (e) {
    const error = `list for cbase-git not written (${target}): ${e?.message || e} — marked as incomplete as far as possible`;
    console.warn(`[projectbox] ${error}`);
    gitProjectsIncomplete(); // otherwise the old list would stay valid
    repetitionSchedule(); // do not wait until converted_at changes again
    return { error, path: target };
  }
}

// ── The git access for cbase-project (see header) ────────────────────────────────────────────────────────────────────
export const GIT_ACCESS_FILE = "git-access.key";
export const GIT_ACCESS_HEADER = "x-cbase-git-key";
const HOSTS_MAX = 32;
const HOST_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;

let accessKey = null; // only in the memory of this backend start (and in the file)

export const gitAccessKeyPath = () => process.env.CBASE_GIT_KEY || path.join(DIRS.data, GIT_ACCESS_FILE);

/** Create the key of this backend start — see header. → `{ ops: false }` | `{ path }` | `{ error, path }`; never throws. */
export function createGitAccessKey() {
  if (!projectboxOps()) return { ops: false };
  const target = gitAccessKeyPath();
  accessKey = null; // a half-created key does not count
  try {
    const value = crypto.randomBytes(32).toString("hex");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    fs.rmSync(tmp, { force: true });
    const fd = fs.openSync(tmp, "wx", 0o600);
    try {
      fs.fchmodSync(fd, 0o600); // the umask could only narrow it — explicit, so that it depends on no setting
      fs.writeSync(fd, `${value}\n`);
    } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, target);
    accessKey = value;
    return { path: target };
  } catch (e) {
    const error = `key for the git access not created (${target}): ${e?.message || e} — cbase-project then asks without an access`;
    console.warn(`[projectbox] ${error}`);
    return { error, path: target };
  }
}

const isLoopback = (ip) => {
  const n = String(ip || "").replace(/^::ffff:/i, "");
  return n === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(n);
};
function equal(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * The verdict of the route (see header) → `{ status, body }`. `source` the address of the caller (projectbox/fence.js
 * requestSource), `key` the header, `body` the read JSON body.
 */
export function gitAccessResponse({ source, key, workspaceId, body }) {
  if (!projectboxOps()) return { status: 404, body: { error: ONLY_IN_OPS } };
  if (!isLoopback(source)) return { status: 403, body: { error: "git access: only for cbase-project in the user container (loopback)" } };
  if (!accessKey || typeof key !== "string" || !equal(key.trim(), accessKey)) {
    return { status: 403, body: { error: `git access: only with the key from ${GIT_ACCESS_FILE} (header ${GIT_ACCESS_HEADER})` } };
  }
  const hosts = body?.hosts;
  if (!Array.isArray(hosts) || hosts.length > HOSTS_MAX || !hosts.every((h) => typeof h === "string" && HOST_PATTERN.test(h))) {
    return { status: 400, body: { error: `hosts: a list of at most ${HOSTS_MAX} host names` } };
  }
  const accesses = {};
  for (const host of new Set(hosts)) {
    const c = store.getGitCred(workspaceId, host);
    if (c?.username) accesses[host] = { username: c.username, secret: c.secret || "" };
  }
  return { status: 200, body: { accesses } };
}
