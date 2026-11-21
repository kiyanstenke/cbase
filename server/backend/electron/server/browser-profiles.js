// Chromium profiles of the Playwright browsers (one browser per chat).
//
// A Chromium profile tolerates exactly ONE browser: at start Chromium creates <profile>/SingletonLock as a symlink to "<host>-<pid>"
// and otherwise aborts: "Failed to create a ProcessSingleton for your profile directory" (exit code 21). Once all chats of a
// workspace pointed at the same profile, so the second chat browsing at the same time got no browser at all. Hence: a profile of
// its own per chat (flat as "chat-<chatId>" so the scanner in browsers.js still finds them). This is also the way @playwright/mcp
// itself names: "A persistent profile can only be used by one browser instance at a time ... point it at a distinct --user-data-dir."
//
// The lasting logins survive because the workspace profile serves as a shared STOCK. The exchange runs in BOTH directions, "the
// fresher wins" per store:
//   - before the run: fresher login stores from the stock into the chat profile,
//   - after the run: fresher login stores of the chat back into the stock.
// One-way (only clone on creation) a login never reached an older chat, and mirroring back "all or nothing" could delete foreign
// logins from the stock: a chat that had merely opened some page would carry its old stock over the newer one.
//
// Why --storage-state does NOT replace the layer (checked on @playwright/mcp 0.0.78): the file is pure INPUT. In isolated mode the
// state is lost after closing ("all the storage state for this session is lost"), and no tool writes it back, so logins done by
// the agent itself would be gone after every run.
//
// IN THE RUNTIME FOLDER: the chat profile of a relocated project lives in `<data>/projects/<pid>/playwright-profiles`, mounted rw
// in the project container, the stock flat in B. A link the container creates there would divert every path writer outside:
// `Default/Cookies.cbase-tmp -> <B file>` made the reconciliation's `copyFileSync` overwrite any file of B (without any race), a
// link at an intermediate folder created folders and files outside; conversely the reconciliation back into the stock read
// `Default/Cookies -> ~/.claude-login/.credentials.json`, a file of B, and carried it into the runtime folder on the next run.
// So when a side lies in a runtime folder, copy, clone, delete, rename and create go through runs/runtime-write.js (descriptor, no
// link, temp O_EXCL in the pinned folder); otherwise (flat place, the local server) with exactly the calls as before. This leaf
// imports neither store nor docker.
// Guards: server/backend/test/runtime-write.test.js ("browser-profiles ..."), runtime-write-guard.test.js.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  renameInRuntimeFolder, removeInRuntimeFolder, cloneWithoutReference, copyInRuntimeFolder, createFolderInRuntimeFolder,
} from "./runs/runtime-write.js";

const CHAT_PREFIX = "chat-";

// Skipped when copying a whole tree (replaceTree): caches are large and worthless, the singleton/DevTools files describe a RUNNING
// instance and would block a browser using the copy at once.
const SKIP_WHEN_CLONING = new Set([
  "Cache", "Code Cache", "GPUCache", "DawnCache", "DawnGraphiteCache", "DawnWebGPUCache",
  "ShaderCache", "GrShaderCache", "GraphiteDawnCache", "component_crx_cache", "extensions_crx_cache",
  "Crashpad", "CrashpadMetrics", "Service Worker", "Safe Browsing", "OptimizationHints",
  "SingletonLock", "SingletonSocket", "SingletonCookie", "DevToolsActivePort", "cbase-tabs.json",
  "lockfile", "Last Version", "RunningChromeVersion",
]);

// What makes a login. The cookies' encryption does NOT hang on the profile (Playwright starts Chromium with --use-mock-keychain or
// --password-store=basic, both profile-independent keys), so these stores are transferable between profiles.
//
// Single SQLite files, with sidecars, see copyDatabase.
const LOGIN_DBS = ["Default/Cookies", "Default/Login Data", "Default/Web Data", "Default/Trust Tokens"];
// A LevelDB is consistent only as a WHOLE: CURRENT and MANIFEST refer to specific file numbers. Mixing files of two different
// instances destroys it, so the unit of comparison is the database, not the file in it.
const LOGIN_DB_DIRS = ["Default/Local Storage/leveldb"];
// Folders whose CHILDREN are each a unit of their own (for IndexedDB one LevelDB per origin): merged child by child here, so
// foreign origins are kept.
const LOGIN_DIR_GROUPS = ["Default/IndexedDB"];
// Session Storage is deliberately left out: it only lasts for the life of a tab.

export const workspaceProfileDir = (root, workspaceId) => path.join(root, workspaceId || "default");
export const chatProfileDir = (root, chatId) => path.join(root, CHAT_PREFIX + chatId);
// Inverse for the agent browser scanner: "chat-<id>" -> <id>, otherwise "".
export const chatIdOfProfile = (dirName) => (dirName.startsWith(CHAT_PREFIX) ? dirName.slice(CHAT_PREFIX.length) : "");
// The parts of a profile folder: "chat-<chatId>" is the main agent's browser, "chat-<chatId>-agent-<agentId>" that of a subagent or
// workflow agent (runs/agents.js, profileKey); everything else (the workspace stock) has no chat. Before, the scanner only read
// `chatIdOfProfile`, looked for "<chatId>-agent-<id>" as a chat id, found none and led a subagent's browser without workspace and
// under its raw folder name. A chat id is a UUID and never carries "-agent-": the first hit separates.
const AGENT_SEPARATOR = "-agent-";
export function profileParts(dirName) {
  const rest = chatIdOfProfile(String(dirName || ""));
  const i = rest.indexOf(AGENT_SEPARATOR);
  if (!rest || i === 0) return { chatId: "", agentId: "" };
  return i < 0 ? { chatId: rest, agentId: "" } : { chatId: rest.slice(0, i), agentId: rest.slice(i + AGENT_SEPARATOR.length) };
}

// ── Locks ───────────────────────────────────────────────────────────────────
// Does the process entered in SingletonLock still hold? The symlink points to "<hostname>-<pid>"; a lock without a living process is
// the corpse of a crashed run and blocks the next browser of this chat.
//
// WHOSE PID: the pid holds in the namespace of the machine named in the hostname. A Chromium in the project container (hostname
// `cbp-<n>`) writes the pid of ITS namespace; in B the same number means something else or nothing, and `process.kill` in B would
// delete the lock of a LIVING browser (two Chromium on one profile). So the hostname decides:
//   own (os.hostname(), as Chromium writes it through gethostname) => as before, `process.kill(pid, 0)`;
//   a foreign one => the seam (`setProfileLockSeam`, set in server.js from projectbox/browser-network.js; this leaf imports neither
//     store nor docker). It gets `{ host, pid, immediately, mtime }` (mtime: lstat of the SingletonLock link) and answers `null`
//     ("not mine, as before": always without the ops marker, and for every hostname that is not a project container's: a former
//     user container carries a different name after every deploy, and its corpses must keep falling), `false` (dead: a `cbp-<n>`
//     without an instance row with a READABLE store, and a lock older than the last start of its container), `true` (unknown =>
//     alive: an unreadable store, docker without a verdict, `immediately` with an instance) or a promise (docker inspect/exec <c>
//     kill -0 <pid> in the instance whose hostname it is).
// Unset, every lock is "as before" (unit tests, the local server).
//
// TWO WAYS, ONE VERDICT. The verdict is immediate (`true`/`false`) or a promise. The asynchronous readers (releaseStaleLocks,
// leaveProfileSafely, profileLockAlive, profileLockVerdict, saveChatLogins, reapUnusedChatProfiles) wait for it, without execFileSync,
// so the event loop does not stand (a `docker exec` costs 83 ms at the median). The ONE synchronous reader is prepareChatProfile: it
// runs per turn in writeMcpConfig (toolchain/mcp-config.js), which sits in synchronous callers (do-run.js, a subagent's spec
// build, runs/agents.js). There docker is not asked at all (`immediately`): a lock whose verdict only the instance knows counts as
// alive and stays. That costs nothing: Chromium in the project container finds its own corpse (same hostname, dead process) at start
// itself and clears it (ProcessSingleton); only a FOREIGN lock blocks it, and that is never one of a project container that keeps
// the same name.
let lockSeam = null;

/** Sets the seam `({ host, pid, immediately }) -> null | boolean | Promise<boolean>` for foreign hostnames; `null` takes it back. */
export function setProfileLockSeam(fn) {
  lockSeam = typeof fn === "function" ? fn : null;
}

// The symlink, taken apart. A hostname itself carries "-" (cbp-12): split at the LAST one.
function lockOf(dir) {
  let target = "";
  try { target = fs.readlinkSync(path.join(dir, "SingletonLock")); } catch { return null; }
  const i = target.lastIndexOf("-");
  // mtime of the link itself (lstat): when the lock was set, for the seam (older than the container's start => dead). Unreadable: 0
  // (the seam then decides without it).
  let mtime = 0;
  try { mtime = fs.lstatSync(path.join(dir, "SingletonLock")).mtimeMs; } catch { mtime = 0; }
  return { target, host: i > 0 ? target.slice(0, i) : "", pid: Number(target.slice(i + 1)), mtime };
}

const pidAliveHere = (pid) => {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === "EPERM"; }
};

// The verdict: `{ alive, target }`; `alive` is `true`/`false` or (only without `immediately`) a promise; `target` the symlink the
// verdict was based on (null without a lock).
function lockVerdict(dir, { immediately = false } = {}) {
  const s = lockOf(dir);
  if (!s) return { alive: false, target: null };
  if (!Number.isInteger(s.pid) || s.pid <= 0) return { alive: false, target: s.target };
  if (lockSeam && s.host !== os.hostname()) {
    let u = null;
    try { u = lockSeam({ host: s.host, pid: s.pid, immediately, mtime: s.mtime }); } catch { u = true; } // a throwing seam: unknown => alive
    if (u !== null && u !== undefined) {
      if (typeof u === "boolean") return { alive: u, target: s.target };
      if (immediately) { Promise.resolve(u).catch(() => {}); return { alive: true, target: s.target }; } // contract broken: alive
      return { alive: Promise.resolve(u).then(Boolean, () => true), target: s.target };
    }
  }
  return { alive: pidAliveHere(s.pid), target: s.target };
}

async function lockHolderAlive(dir) {
  return Boolean(await lockVerdict(dir).alive);
}

// The synchronous way (prepareChatProfile, see "TWO WAYS"): without docker; what only the instance would know counts as alive.
const lockHolderAliveImmediately = (dir) => lockVerdict(dir, { immediately: true }).alive === true;

const LOCK_FILES = ["SingletonLock", "SingletonSocket", "SingletonCookie", "DevToolsActivePort"];
const deleteLock = (dir) => {
  for (const f of LOCK_FILES) {
    try { if (!removeInRuntimeFolder(path.join(dir, f))) fs.rmSync(path.join(dir, f), { force: true }); } catch { /* ignore */ }
  }
};

// Is this profile SAFELY left: does the lock still stand but its process is dead (crash, SIGKILL)? For the agent browser scanner
// (browsers.js): its DevToolsActivePort survives EVERY end of the browser (measured on @playwright/mcp 0.0.78: after SIGTERM to npx,
// Chromium and lock are gone, the port file stays), and a call to a dead or meanwhile foreign-assigned port is exactly the one that
// can kill Chromium's debug HTTP loop. Without a lock (clean end, or a Chromium without ProcessSingleton) nobody knows: then `false`,
// the scanner asks. Asynchronous because the lock of a project container asks docker.
export async function leaveProfileSafely(dir) {
  try { fs.lstatSync(path.join(dir, "SingletonLock")); } catch { return false; }
  return !(await lockHolderAlive(dir));
}

// Does the lock stand with a living process? For the scanner (browsers.js): a session whose CDP line broke off is only dead if its
// Chromium is too. Asynchronous.
export function profileLockAlive(dir) {
  return lockHolderAlive(dir);
}

// Both questions in ONE verdict, with the target it was based on: `{ lock, alive, target }`; `lock` whether SingletonLock stands
// (leaveProfileSafely = lock && !alive, profileLockAlive = alive). For the scanner on an instance's profiles (browsers.js): there
// every question is a `docker exec`, and a confirmed "dead" it remembers per target (see `abandonedLocks` there).
// `profileLockTarget(dir)` is the target without a verdict (synchronous, without docker; null without a lock or with a lock that is
// not a symlink): the key under which it looks before asking.
export async function profileLockVerdict(dir) {
  try { fs.lstatSync(path.join(dir, "SingletonLock")); } catch { return { lock: false, alive: false, target: null }; }
  const { alive, target } = lockVerdict(dir);
  return { lock: true, alive: Boolean(await alive), target };
}
export const profileLockTarget = (dir) => lockOf(dir)?.target ?? null;

// Remove orphaned locks, but only those of a dead process. Pulling the lock from a living browser would let two Chromium instances
// onto the same profile: exactly the profile damage the lock exists against.
// Asynchronous: between verdict and delete docker may have been asked; if a DIFFERENT lock stands there meanwhile (a new
// browser), it stays.
export async function releaseStaleLocks(dir) {
  const { alive, target } = lockVerdict(dir);
  if (await alive) return false;
  if (target !== null && lockOf(dir)?.target !== target) return false;
  deleteLock(dir);
  return true;
}

// The synchronous twin for prepareChatProfile: the same verdict, just without docker (see "TWO WAYS").
function releaseStaleLocksImmediately(dir) {
  if (lockHolderAliveImmediately(dir)) return false;
  deleteLock(dir);
  return true;
}

// ── Copying ─────────────────────────────────────────────────────────────────
const mtimeOf = (p) => { try { return fs.statSync(p).mtimeMs; } catch { return 0; } };

// "Fresher" with 1 ms of play. Timestamps survive a copy only to the millisecond (the source had e.g. ...672.5603 ms, the copy ...673);
// without play the copy would count as fresher than its original and the first reconciliation would write back although nothing
// changed. Some file systems are coarser anyway; real changes lie seconds apart.
const isNewer = (src, dst) => mtimeOf(src) > mtimeOf(dst) + 1;

// Newest change within a tree: the comparison value for a whole database.
function newestMtime(dir) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  let newest = mtimeOf(dir);
  for (const e of entries) {
    const p = path.join(dir, e.name);
    const at = e.isDirectory() ? newestMtime(p) : mtimeOf(p);
    if (at > newest) newest = at;
  }
  return newest;
}

// Write alongside first, then rename: a failure in the middle of copying must not leave half a file.
//
// The source's timestamps are TAKEN OVER. Otherwise the mtime would mean "when copied" instead of "when did this login state arise": a
// chat that only caught up and did not browse at all would then be "fresher" than the stock and rewrite it on every run. With the time
// taken over both sides are equally old; only what Chromium really touched moves.
//
// If a side lies in a runtime folder (see top), runs/runtime-write.js copies: the fixed temp name here was a target the container
// could present as a link. A failure there leaves the target untouched as below.
function copyFileAtomic(src, dst) {
  try { if (copyInRuntimeFolder(src, dst, { times: true })) return; } catch { return; }
  const tmp = `${dst}.cbase-tmp`;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  try {
    const stat = fs.statSync(src);
    fs.copyFileSync(src, tmp);
    fs.utimesSync(tmp, stat.atimeMs / 1000, stat.mtimeMs / 1000);
    fs.renameSync(tmp, dst);
  } catch {
    try { fs.rmSync(tmp, { force: true }); } catch {}
  }
}

// Copy recursively, without caches/runtime files. Symlinks are skipped (in the profile they are only the singleton locks).
// If a side lies in a runtime folder (see top), runs/runtime-write.js clones: the walk never leaves the source, links stay behind as
// here, every file through its descriptor, every target folder in the area; and the answer says whether a folder was created (`false`:
// the source is a link, not a folder, or the path leads outside). Otherwise `undefined`.
function cloneTree(from, to) {
  try {
    const k = cloneWithoutReference(from, to, { omit: (name) => SKIP_WHEN_CLONING.has(name) });
    if (k) return k.kind === "folder";
  } catch { return false; }
  let entries = [];
  try { entries = fs.readdirSync(from, { withFileTypes: true }); } catch { return; }
  fs.mkdirSync(to, { recursive: true });
  for (const e of entries) {
    if (SKIP_WHEN_CLONING.has(e.name)) continue;
    const src = path.join(from, e.name);
    const dst = path.join(to, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) cloneTree(src, dst);
    // Take over timestamps, for the same reason as in copyFileAtomic.
    else if (e.isFile()) {
      try {
        const stat = fs.statSync(src);
        fs.copyFileSync(src, dst);
        fs.utimesSync(dst, stat.atimeMs / 1000, stat.mtimeMs / 1000);
      } catch { /* ignore */ }
    }
  }
}

// Replace a folder as a WHOLE (tmp + rename), for self-consistent databases. In the runtime folder, delete and rename go through the
// pinned folders (see top): recursive `rmSync` would follow an intermediate folder that became a link.
const removeTree = (p) => { if (!removeInRuntimeFolder(p)) fs.rmSync(p, { recursive: true, force: true }); };
const renamePath = (from, to) => { if (!renameInRuntimeFolder(from, to)) fs.renameSync(from, to); };
// In the runtime folder without a cloned folder the target stays: a link in the place of the source (`.../leveldb -> /`) would
// otherwise have deleted the stock's store.
function replaceTree(src, dst) {
  const tmp = `${dst}.cbase-tmp`;
  try { removeTree(tmp); } catch {}
  if (cloneTree(src, tmp) === false) { try { removeTree(tmp); } catch {} return; }
  try { removeTree(dst); } catch {}
  try { renamePath(tmp, dst); } catch { try { removeTree(tmp); } catch {} }
}

// SQLite file with sidecars. A leftover -wal/-journal of the target belonged to the OLD database and would damage the new one on
// opening; so it must move along or go.
function copyDatabase(src, dst) {
  copyFileAtomic(src, dst);
  for (const suffix of ["-journal", "-wal", "-shm"]) {
    if (fs.existsSync(src + suffix)) copyFileAtomic(src + suffix, dst + suffix);
    else { try { if (!removeInRuntimeFolder(dst + suffix)) fs.rmSync(dst + suffix, { force: true }); } catch {} }
  }
}

// Reconcile login stores in one direction: per store the fresher side wins. NOTHING is deleted in the target that the source does not
// know; foreign origins are kept.
function syncLogins(from, to) {
  for (const rel of LOGIN_DBS) {
    const src = path.join(from, ...rel.split("/"));
    if (!fs.existsSync(src)) continue;
    const dst = path.join(to, ...rel.split("/"));
    if (isNewer(src, dst)) copyDatabase(src, dst);
  }
  for (const rel of LOGIN_DB_DIRS) {
    const src = path.join(from, ...rel.split("/"));
    if (!fs.existsSync(src)) continue;
    const dst = path.join(to, ...rel.split("/"));
    if (newestMtime(src) > newestMtime(dst) + 1) replaceTree(src, dst);
  }
  for (const rel of LOGIN_DIR_GROUPS) {
    const src = path.join(from, ...rel.split("/"));
    let entries = [];
    try { entries = fs.readdirSync(src, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const childSrc = path.join(src, e.name);
      const childDst = path.join(to, ...rel.split("/"), e.name);
      if (e.isDirectory()) {
        if (newestMtime(childSrc) > newestMtime(childDst) + 1) replaceTree(childSrc, childDst);
      } else if (e.isFile() && isNewer(childSrc, childDst)) {
        copyFileAtomic(childSrc, childDst);
      }
    }
  }
}

// ── Profiles ────────────────────────────────────────────────────────────────
// A profile is "used" as soon as Chromium has created its default files in it.
const profileInitialized = (dir) => fs.existsSync(path.join(dir, "Default"));

// Provide a profile for a chat: pull the fresher login stores from the stock. This is also the initial fill: cloning a whole profile
// would be a waste (8.5 MB per chat, also for chats that never browse), and everything except the logins Chromium creates itself. On
// the first run there is nothing in the target yet, so "fresher" applies to everything.
// Safe moment: this chat's browser is not running yet.
// Returns the profile path. `stock` is the root of the login stock if it is not `root`: the profile of a chat of a relocated project
// lies in its runtime folder, the stock stays flat (runs/runtime-location.js).
export function prepareChatProfile({ root, chatId, workspaceId, stock = root }) {
  const dir = chatProfileDir(root, chatId);
  if (!createFolderInRuntimeFolder(dir)) fs.mkdirSync(dir, { recursive: true });
  const jar = workspaceProfileDir(stock, workspaceId);
  // Nothing is read from a stock with a RUNNING browser: its databases are open, a copy of them would possibly be a half state.
  // Synchronous (per turn in writeMcpConfig): docker is never asked here, see "TWO WAYS" above.
  if (profileInitialized(jar) && !lockHolderAliveImmediately(jar)) syncLogins(jar, dir);
  releaseStaleLocksImmediately(dir);
  return dir;
}

// Runs end concurrently but write into the same stock -> serialize in-process.
let jarWrite = Promise.resolve();

// After the run: fresher login stores of the chat profile back into the stock (the chat's browser has ended with the run, so its
// databases are closed).
export function saveChatLogins({ root, chatId, workspaceId, stock = root }) {
  const dir = chatProfileDir(root, chatId);
  const jar = workspaceProfileDir(stock, workspaceId);
  if (!profileInitialized(dir)) return jarWrite;
  jarWrite = jarWrite.then(async () => {
    // In the stock a manual claude call may browse (writeWorkspaceMcpJson gives it the same profile). Replacing its cookie database
    // under its feet damages it.
    if (await lockHolderAlive(jar)) return;
    fs.mkdirSync(path.join(jar, "Default"), { recursive: true });
    syncLogins(dir, jar);
  }).catch(() => {});
  return jarWrite;
}

// ── A chat's browser ──────────────────────────────────────────────────────────────────────────────
// Every chat has its own browser (browsers.js, scope `chat:<id>`) in which human and main agent work. Its logins come from the STOCKS
// of its scope and go back there, with exactly the mechanics of the Playwright profiles above (syncLogins: per store the fresher one,
// never delete): in before the start, back after the process ends. Two stocks: the profile of the own browser of its project (with
// copy) or workspace (the logins of the browser page) and the workspace's Playwright stock (`playwright-profiles/<wid>`, from which
// subagents and workflow agents inherit, prepareChatProfile). `initialFill` only reads a NEW profile (still without `Default`): once
// the old Playwright profile of the main agent (`playwright-profiles/chat-<id>`, formerly its browser), never again. From a profile
// whose browser runs nothing is read and nothing written (open databases); a login from the chat then waits in the chat profile for the
// next end. All paths over the ONE chain `jarWrite`: a read in the middle of replacing a LevelDB (remove + rename) would see it half.
/** Before the start: fresher login stores from `initialFill` (only into a new profile) and `stocks` into `target`. -> number read. */
export function takeOverLogins({ target, stocks = [], initialFill = [] }) {
  const run = jarWrite.then(async () => {
    const sources = [...(profileInitialized(target) ? [] : initialFill), ...stocks].filter(Boolean);
    let n = 0;
    for (const q of sources) {
      if (!profileInitialized(q) || (await lockHolderAlive(q))) continue;
      syncLogins(q, target);
      n++;
    }
    return n;
  });
  jarWrite = run.catch(() => {});
  return run.catch(() => 0);
}
/** After the end: fresher login stores from `source` back into each of the `stocks`. -> number written. */
export function mirrorLogins({ source, stocks = [] }) {
  const run = jarWrite.then(async () => {
    if (!profileInitialized(source)) return 0;
    if (await lockHolderAlive(source)) return 0; // the chat's browser is still alive: its databases are open
    let n = 0;
    for (const v of stocks.filter(Boolean)) {
      if (await lockHolderAlive(v)) continue;
      const d = path.join(v, "Default");
      if (!createFolderInRuntimeFolder(d)) fs.mkdirSync(d, { recursive: true });
      syncLogins(source, v);
      n++;
    }
    return n;
  });
  jarWrite = run.catch(() => {});
  return run.catch(() => 0);
}

// Chat deleted -> its browser profile too. The stock (workspace profile) stays.
export function removeChatProfile({ root, chatId }) {
  try { if (!removeInRuntimeFolder(chatProfileDir(root, chatId))) fs.rmSync(chatProfileDir(root, chatId), { recursive: true, force: true }); } catch { /* ignore */ }
}

// When was the profile last used? Chromium writes "Preferences" at the end of every session and touches the cookie database on
// every page visit.
function lastUsedAt(dir) {
  return Math.max(
    mtimeOf(dir),
    mtimeOf(path.join(dir, "Default", "Preferences")),
    mtimeOf(path.join(dir, "Default", "Cookies")),
  );
}

// Throw away long-unused chat profiles (8.5 MB each). Harmless because the logins are in the stock: if the chat browses again, its
// profile is cloned anew from it. Returns the chat ids of the removed profiles so the caller can also delete their Playwright configs.
// Asynchronous (the lock of a project container asks docker): the promise carries the list.
export async function reapUnusedChatProfiles({ root, maxAgeMs = 30 * 24 * 60 * 60 * 1000, now = Date.now() } = {}) {
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  const removed = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const chatId = chatIdOfProfile(e.name);
    if (!chatId) continue;
    const dir = path.join(root, e.name);
    if (await lockHolderAlive(dir)) continue; // browsing right now
    if (now - lastUsedAt(dir) < maxAgeMs) continue;
    try { if (!removeInRuntimeFolder(dir)) fs.rmSync(dir, { recursive: true, force: true }); removed.push(chatId); } catch { /* ignore */ }
  }
  return removed;
}
