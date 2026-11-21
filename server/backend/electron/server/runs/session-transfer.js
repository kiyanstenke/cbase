// The transfer of the CLI sessions. A leaf: imports only node:* and the leaf ./runtime-write.js — the homes come as
// an argument (runs/session-location.js computes them from instance and runtime location).
//
// IN THE RUNTIME FOLDER. A project's home (its `.claude` and `.codex` under the project's runtime folder) is mounted
// rw in the project container. Via path names the transfer would follow every link there: `mkdirSync` and
// `renameSync` through an intermediate folder linked into the backend would put the session there, `cpSync`/`rmSync`
// of the folder `<sid>/` would delete through a swapped part, and a copy BACK would read a backend file through a
// linked `<sid>.jsonl` (and carry it into a project on the next transfer). So if one side lies in the runtime
// folder, `copyInRuntimeFolder`/`cloneWithoutReference` copy (descriptor, no link) and `removeInRuntimeFolder`
// deletes; otherwise (backend ↔ backend) the plain calls.
//
// WHAT THE CLIs DO (measured at the binaries):
//   Claude  session = `<CLAUDE_CONFIG_DIR>/projects/<slug(cwd)>/<sid>.jsonl`, plus a folder `<sid>/` (subagents, tool
//           results). `--resume <sid>` finds the file in EVERY slug of the same home but then keeps writing to the
//           old file; if two copies lie in one home, the one in the cwd's slug wins. In ANOTHER home it finds
//           nothing: "No conversation found with session ID: <sid>", exit 1, no `result`.
//   Codex   rollout = `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<time>-<threadId>.jsonl`, found via the FILE (not
//           via `state_5.sqlite`, which stays). If it is missing: "no rollout found for thread id <id>", exit 1, no
//           JSON event.
//   Slug    every character except [A-Za-z0-9] becomes `-` (also `.` and `_`), built from the physical working
//           folder (getcwd, without symlinks). Longer than 200 characters: the first 200, `-` and the absolute value
//           of the Java hashCode of the UNTRUNCATED path in base 36 (the same folder carries `<sid>/tool-results`).
//           Without the truncation the target of a transfer for a long cwd would lie in a slug the CLI never uses:
//           it would take the real copy, write the turn there, and the confirmation would delete exactly that file.
// Reference-Version: 2.1.322
//           (A jump of the Claude pin needs the slug re-measured at the new binary and this line updated.)
//
// THE RULE: the search goes via the session id in ALL homes (the backend's and every project home), never via a
// stored location; the NEWEST copy wins (mtime, then size, on a tie the one at the target). If it already lies at
// the target (Claude: in the slug of the new cwd; Codex: anywhere under `sessions/` of the target home), nothing is
// to be done ("present"). Otherwise it is copied — tmp + rename, timestamps along, the folder `<sid>/` likewise —, and
// the old copies stay until the first turn at the new location is confirmed (`removeCopies`, called by
// runs/session-location.js sessionConfirmed). No copy ⇒ "missing": then the transfer cannot save anything either,
// the turn runs into the retry path without resume (runs/do-run.js).
//
// THE FINAL DELETE: `sessionTraces` names what lies in the homes of the sessions with these ids,
// `removeSessionTraces` removes it, `removeEmptyWorktreeSlug` the empty slug of a subagent worktree. Which ids fall
// (not those of a fork) is decided by the closing path (chats/sessions.js) — here only the mechanics, built from the
// id, never from a pattern.
import fs from "node:fs";
import path from "node:path";
import {
  renameInRuntimeFolder, removeInRuntimeFolder, cloneWithoutReference, copyInRuntimeFolder, runtimeFolderOf,
} from "./runtime-write.js";

// The CLI's truncation: slug longer than SLUG_MAX ⇒ beginning + `-` + hash of the untruncated path.
const SLUG_MAX = 200;
// Java's String.hashCode over UTF-16 units, as a 32-bit integer.
const javaHash = (s) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h;
};
/** The folder name under which Claude stores the sessions of a working folder (truncation: see header). */
export const sessionSlug = (cwd) => {
  const filePath = String(cwd || "");
  const slug = filePath.replace(/[^A-Za-z0-9]/g, "-");
  return slug.length <= SLUG_MAX ? slug : `${slug.slice(0, SLUG_MAX)}-${Math.abs(javaHash(filePath)).toString(36)}`;
};

// A session id becomes a file name — never something with path separators (Claude: UUID; Codex: the thread's UUID).
const VALID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
/** Whether an id is usable as a session (otherwise nothing searches or copies). */
export const validSession = (sid) => typeof sid === "string" && VALID.test(sid);

const statOf = (p) => { try { return fs.statSync(p); } catch { return null; } };
// The CLI sees its working folder via getcwd() — the PHYSICAL path (on macOS /private/var instead of /var); the slug
// is built from it. If the folder does not exist (yet), the path counts as it is.
const physical = (p) => { try { return fs.realpathSync(p); } catch { return String(p); } };
const resolved = (list) => [...new Set((list || []).filter(Boolean).map((p) => path.resolve(String(p))))];

// Newest first; on a tie the copy at the target (it is then already there — after a transfer without a confirmed turn).
const arrange = (copies, atTarget) => copies.sort((a, b) => (b.mtimeMs - a.mtimeMs) || (b.size - a.size) || (atTarget(b) - atTarget(a)));

/**
 * Every copy of a Claude session: `{ dir, slug, file, folder, mtimeMs, size }`.
 * @param {string} sid
 * @param {string[]} dirs  the CLAUDE_CONFIG_DIRs (the backend's and the project homes)
 */
export function claudeCopies(sid, dirs) {
  if (!validSession(sid)) return [];
  const out = [];
  for (const dir of resolved(dirs)) {
    const root = path.join(dir, "projects");
    let slugs = [];
    try { slugs = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const s of slugs) {
      if (!s.isDirectory()) continue;
      const file = path.join(root, s.name, `${sid}.jsonl`);
      const st = statOf(file);
      if (!st?.isFile()) continue;
      const folder = path.join(root, s.name, sid);
      out.push({ dir, slug: s.name, file, folder: statOf(folder)?.isDirectory() ? folder : null, mtimeMs: st.mtimeMs, size: st.size });
    }
  }
  return out;
}

/**
 * Every copy of a Codex rollout: `{ dir, rel, file, mtimeMs, size }` — `rel` relative to the home (`sessions/YYYY/MM/DD/…`).
 * @param {string} threadId
 * @param {string[]} dirs  the CODEX_HOMEs (the backend's and the project homes)
 */
export function codexCopies(threadId, dirs) {
  if (!validSession(threadId)) return [];
  const suffix = `-${threadId}.jsonl`;
  const out = [];
  for (const dir of resolved(dirs)) {
    const go = (d, depth) => {
      let entries = [];
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const p = path.join(d, e.name);
        if (e.isDirectory() && depth < 4) go(p, depth + 1);
        else if (e.isFile() && e.name.startsWith("rollout-") && e.name.endsWith(suffix)) {
          const st = statOf(p);
          if (st) out.push({ dir, rel: path.relative(dir, p), file: p, mtimeMs: st.mtimeMs, size: st.size });
        }
      }
    };
    go(path.join(dir, "sessions"), 0);
  }
  return out;
}

// A file to its target via tmp + rename, timestamps along (the rule "newest wins" compares real work).
function copyFile(from, to) {
  if (copyInRuntimeFolder(from, to, { times: true })) return; // one side in the runtime folder (see header)
  fs.mkdirSync(path.dirname(to), { recursive: true });
  const tmp = `${to}.transfer-${process.pid}-${Date.now()}`;
  try {
    fs.copyFileSync(from, tmp);
    const st = fs.statSync(from);
    fs.utimesSync(tmp, st.atime, st.mtime);
    fs.renameSync(tmp, to);
  } catch (e) { try { fs.rmSync(tmp, { force: true }); } catch { /* leftover of a failure */ } throw e; }
}
// A folder likewise: first completely next to it, then into its place in one move.
// If one side lies in the runtime folder (see header): cloned without links, deleted and renamed via pinned folders.
const removeTree = (p) => { if (!removeInRuntimeFolder(p)) fs.rmSync(p, { recursive: true, force: true }); };
function copyFolder(from, to) {
  const tmp = `${to}.transfer-${process.pid}-${Date.now()}`;
  let k;
  try { k = cloneWithoutReference(from, tmp); } catch (e) { try { removeTree(tmp); } catch { /* leftover */ } throw e; }
  if (k) {
    try {
      if (k.kind !== "folder") throw Object.assign(new Error(`not a folder: ${from}`), { code: "ENOFILE" });
      if (k.error.length) throw Object.assign(new Error(`not copied completely: ${k.error.join("; ")}`), { code: "EINCOMPLETE" });
      removeTree(to);
      if (!renameInRuntimeFolder(tmp, to)) fs.renameSync(tmp, to);
    } catch (e) { try { removeTree(tmp); } catch { /* leftover */ } throw e; }
    return;
  }
  try {
    fs.cpSync(from, tmp, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
    fs.rmSync(to, { recursive: true, force: true });
    fs.renameSync(tmp, to);
  } catch (e) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* leftover */ } throw e; }
}

/**
 * Pull a Claude session into this run's home before the spawn.
 * @param {{ sid: string, target: string, cwd: string, sources: string[] }} o  `target` = the run's CLAUDE_CONFIG_DIR,
 *   `sources` = all homes a copy can lie in (`target` is searched too).
 * @returns {{ kind: "claude", sid: string, status: "present"|"copied"|"missing", target: string|null, source: string|null,
 *   old: string[], folder?: { from: string, target: string } }}
 *   `old`: the remaining copies (files and `<sid>/` folders) — to be removed only after the confirmed turn. `folder`
 *   (only "copied" with `<sid>/`): from where to where the folder moved — the history names large tool results under
 *   the OLD absolute path (`<sid>/tool-results/…`, "Full output saved to: …"; runs/session-location.js).
 */
export function pullClaudeSession({ sid, destination, cwd, sources = [] }) {
  const empty = { kind: "claude", sid: String(sid || ""), status: "missing", target: null, source: null, old: [] };
  if (!validSession(sid) || !destination || !cwd) return empty;
  const targetDir = path.resolve(destination);
  const target = path.join(targetDir, "projects", sessionSlug(physical(cwd)), `${sid}.jsonl`);
  const copies = arrange(claudeCopies(sid, [targetDir, ...sources]), (k) => (k.file === target ? 1 : 0));
  if (!copies.length) return empty;
  const [newest, ...rest] = copies;
  const targetFolder = path.join(path.dirname(target), sid);
  // An older copy AT the target is overwritten, never removed as an old one.
  const old = rest.flatMap((k) => [k.file, ...(k.folder ? [k.folder] : [])]).filter((p) => p !== target && p !== targetFolder);
  if (newest.file === target) return { ...empty, status: "present", target, source: target, old };
  if (newest.folder) copyFolder(newest.folder, targetFolder);
  copyFile(newest.file, target);
  return {
    ...empty, status: "copied", target, source: newest.file, old: [newest.file, ...(newest.folder ? [newest.folder] : []), ...old],
    ...(newest.folder ? { folder: { from: newest.folder, destination: targetFolder } } : {}),
  };
}

/**
 * Pull a Codex rollout into this run's home before the spawn — under the same relative path (`sessions/YYYY/MM/DD/`).
 * @param {{ threadId: string, target: string, sources: string[] }} o  `target` = the run's CODEX_HOME.
 * @returns {{ kind: "codex", sid: string, status: "present"|"copied"|"missing", target: string|null, source: string|null, old: string[] }}
 */
export function pullCodexRollout({ threadId, destination, sources = [] }) {
  const empty = { kind: "codex", sid: String(threadId || ""), status: "missing", target: null, source: null, old: [] };
  if (!validSession(threadId) || !destination) return empty;
  const targetDir = path.resolve(destination);
  const copies = arrange(codexCopies(threadId, [targetDir, ...sources]), (k) => (k.dir === targetDir ? 1 : 0));
  if (!copies.length) return empty;
  const [newest, ...rest] = copies;
  // Codex finds the rollout via the file, whatever the day — it is at the target once the newest lies there.
  const old = rest.map((k) => k.file);
  if (newest.dir === targetDir) return { ...empty, status: "present", target: newest.file, source: newest.file, old };
  const target = path.join(targetDir, newest.rel);
  copyFile(newest.file, target);
  return { ...empty, status: "copied", target, source: newest.file, old: [newest.file, ...old.filter((d) => d !== target)] };
}

/** Remove the old copies (files and `<sid>/` folders). Returns how many fell. Never throws. */
export function removeCopies(old) {
  let n = 0;
  for (const p of Array.isArray(old) ? old : []) {
    try { if (!removeInRuntimeFolder(p)) fs.rmSync(p, { recursive: true, force: true }); n++; } catch (e) { console.warn(`[session] old copy ${p} not removed: ${e?.message || e}`); }
  }
  return n;
}

// The session ids of a home, from the file names: Claude `projects/<slug>/<sid>.jsonl`, Codex `sessions/…/rollout-<time>-<id>.jsonl`.
const ROLLOUT = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/;
function sessionIdsIn(home, kind) {
  const ids = new Set();
  const read = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }); } catch { return []; } };
  if (kind === "claude") {
    for (const s of read(path.join(home, "projects"))) {
      if (!s.isDirectory()) continue;
      for (const f of read(path.join(home, "projects", s.name))) if (f.isFile() && f.name.endsWith(".jsonl")) ids.add(f.name.slice(0, -6));
    }
  } else {
    const go = (d, depth) => {
      for (const e of read(d)) {
        if (e.isDirectory() && depth < 4) go(path.join(d, e.name), depth + 1);
        else if (e.isFile()) { const m = e.name.match(ROLLOUT); if (m) ids.add(m[1]); }
      }
    };
    go(path.join(home, "sessions"), 0);
  }
  return [...ids].filter(validSession).sort();
}

/**
 * Fetch EVERY session of one home back into another (deleting a project fetches them from its home into the
 * backend's before the instance row falls — after that nobody searches there any more). Per session id, not per
 * chat: also that of a chat that left the project without a new turn, and those of its subagents. The newest copy
 * wins as in the transfer; if it already lies at the target, everything stays ("present"). Claude: into the slug of the
 * copy that already lies at the target (the CLI finds that one there in the slug of its cwd — it is overwritten, no
 * second one next to it), otherwise into the slug of the source (`--resume` finds it in EVERY slug of the same
 * home). Codex: the same relative path (pullCodexRollout). The source stays. Never throws: a failure is in the
 * report as "error".
 * @param {{ kind: "claude"|"codex", from: string, target: string }} o
 * @returns {Array<{ kind: string, sid: string, status: "present"|"copied"|"error", target: string|null, error?: string }>}
 */
export function fetchSessionsBack({ kind, from, destination }) {
  const ofDir = path.resolve(from);
  const destDir = path.resolve(destination);
  const report = [];
  for (const sid of sessionIdsIn(ofDir, kind)) {
    try {
      if (kind === "codex") {
        const turn = pullCodexRollout({ threadId: sid, destination: destDir, sources: [ofDir] });
        report.push({ kind, sid, status: turn.status, target: turn.target });
        continue;
      }
      const atTarget = arrange(claudeCopies(sid, [destDir]), () => 0);
      const [newest] = arrange([...claudeCopies(sid, [ofDir]), ...atTarget], (k) => (k.dir === destDir ? 1 : 0));
      if (newest.dir === destDir) { report.push({ kind, sid, status: "present", target: newest.file }); continue; }
      const target = path.join(destDir, "projects", atTarget[0]?.slug ?? newest.slug, `${sid}.jsonl`);
      if (newest.folder) copyFolder(newest.folder, path.join(path.dirname(target), sid));
      copyFile(newest.file, target);
      report.push({ kind, sid, status: "copied", target });
    } catch (e) {
      report.push({ kind, sid, status: "error", target: null, error: String(e?.message || e) });
    }
  }
  return report;
}

// ── The final delete (closing path chats/erase.js via chats/sessions.js) ─────────────────────────────────────────────

const lstatOf = (p) => { try { return fs.lstatSync(p); } catch { return null; } };

/**
 * What lies in the homes of sessions — for removal (Claude `projects/<slug>/<sid>.jsonl` with `<sid>/`, Codex the
 * rollouts). Only names that EQUAL the id, never a pattern: Claude in EVERY slug folder exactly `<sid>.jsonl` and
 * `<sid>` — every entry of that name (file, folder or link: it falls itself, never its target; also a `<sid>/`
 * without a file); a slug that is itself a link is not entered (Dirent). Codex every file (or link) under
 * `sessions/` whose name is EXACTLY `rollout-<time>-<sid>.jsonl` — a suffix alone is not enough
 * (`rollout-<time>-x-<sid>.jsonl` belongs to thread `x-<sid>`). One walk per home for all ids (deleting a workspace
 * names many).
 * @param {string|string[]} sids
 * @param {{ claude?: string[], codex?: string[] }} homes  the CLAUDE_CONFIG_DIRs or CODEX_HOMEs (the backend's and the project homes)
 * @returns {Array<{ kind: "claude"|"codex", sid: string, dir: string, path: string }>}
 */
export function sessionTraces(sids, { claude = [], codex = [] } = {}) {
  const searched = new Set((Array.isArray(sids) ? sids : [sids]).filter(validSession));
  if (!searched.size) return [];
  const out = [];
  const read = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }); } catch { return []; } };
  for (const dir of resolved(claude)) {
    const root = path.join(dir, "projects");
    for (const s of read(root)) {
      if (!s.isDirectory()) continue;
      for (const e of read(path.join(root, s.name))) {
        const sid = e.name.endsWith(".jsonl") ? e.name.slice(0, -6) : e.name;
        if (searched.has(sid)) out.push({ kind: "claude", sid, dir, path: path.join(root, s.name, e.name) });
      }
    }
  }
  for (const dir of resolved(codex)) {
    const go = (d, depth) => {
      for (const e of read(d)) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { if (depth < 4) go(p, depth + 1); continue; }
        if (!e.isFile() && !e.isSymbolicLink()) continue;
        const m = e.name.match(ROLLOUT);
        if (m && searched.has(m[1])) out.push({ kind: "codex", sid: m[1], dir, path: p });
      }
    };
    go(path.join(dir, "sessions"), 0);
  }
  return out;
}

const PERMISSIONS = new Set(["EACCES", "EPERM"]);

/**
 * Remove the traces. In a project's runtime folder via the descriptor (`removeInRuntimeFolder`: pinned folders, a
 * link falls itself — the project container mounts the home rw), in the backend via the path (no container mounts
 * the backend's home). A root-owned leftover in the runtime folder (EACCES/EPERM) goes to
 * `rootFallback({ projectId, path })` (if it throws, there is no way), otherwise a warning is recorded. Never throws.
 * @returns {{ removed: string[], warnings: string[] }}
 */
export function removeSessionTraces(lanes, { rootFallback = null, warn = console.warn } = {}) {
  const removed = [];
  const warnings = [];
  const report = (w) => { warnings.push(w); try { warn(w); } catch { /* the warning must not break the path */ } };
  for (const s of Array.isArray(lanes) ? lanes : []) {
    const p = typeof s === "string" ? s : s?.path;
    if (!p) continue;
    try {
      if (!removeInRuntimeFolder(p)) fs.rmSync(p, { recursive: true, force: true });
      removed.push(p);
    } catch (e) {
      let error = e;
      const location = runtimeFolderOf(p);
      if (PERMISSIONS.has(e?.code) && location && typeof rootFallback === "function") {
        try { rootFallback({ projectId: path.basename(location), path: p }); removed.push(p); continue; } catch (e2) { error = e2; }
      }
      report(`[session] ${p} not removed (${error?.code || error?.message || error})`);
    }
  }
  return { removed, warnings };
}

// The physical path up to the nearest existing ancestor (the CLI builds the slug from getcwd(); a worktree is often
// already gone when the chat is deleted, its parent folder is not).
function physicalSoFar(p) {
  const full = path.resolve(String(p));
  const rest = [];
  for (let header = full; ;) {
    try { return path.join(fs.realpathSync(header), ...rest); } catch { /* further up */ }
    const top = path.dirname(header);
    if (top === header) return full;
    rest.unshift(path.basename(header));
    header = top;
  }
}

/**
 * Remove the slug folder of a subagent worktree in the Claude homes if it is EMPTY (the working folder
 * `…/agent-<aid>` belongs to exactly this agent — after its sessions its empty transcript folder would otherwise
 * stay in the project's home). Both spellings of the slug (the path as written, and physical). A folder with content
 * stays (e.g. a session someone else carries). The caller names only the working folder of a worktree agent. Never
 * throws.
 * @returns {string[]} the removed folders
 */
export function removeEmptyWorktreeSlug(cwd, claudeDirs, { warn = console.warn } = {}) {
  if (typeof cwd !== "string" || !cwd) return [];
  const slugs = [...new Set([sessionSlug(path.resolve(cwd)), sessionSlug(physicalSoFar(cwd))])];
  const removed = [];
  for (const dir of resolved(claudeDirs)) {
    for (const slug of slugs) {
      const folder = path.join(dir, "projects", slug);
      if (!lstatOf(folder)?.isDirectory()) continue;
      let empty = false;
      try { empty = fs.readdirSync(folder).length === 0; } catch { empty = false; }
      if (!empty) continue;
      try {
        if (!removeInRuntimeFolder(folder)) fs.rmdirSync(folder);
        removed.push(folder);
      } catch (e) { try { warn(`[session] empty folder ${folder} not removed (${e?.code || e?.message || e})`); } catch { /* see above */ } }
    }
  }
  return removed;
}
