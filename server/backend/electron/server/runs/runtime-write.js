// What the backend (B) WRITES in a project's runtime folder. A leaf: imports only node:*, app-state.js and
// runtime/real-path.js — no store, no docker (browser-profiles.js and browsers.js are leaves without both and write
// via this file).
//
// WHY. The runtime folder of a project under <data> is mounted rw in the main AND in the copy container, at the same
// path (projectbox/creation.js mountRules). A process there (an agent with an injection, root in the privileged
// container) creates arbitrary links: an output subfolder → the backend's data folder, a per-chat config file →
// ~/.bashrc, a dangling link in the attachments → ~/.ssh/authorized_keys. In the container they resolve in ITS
// namespace; but a backend that writes via path names (`mkdirSync` + `writeFileSync`, `copyFileSync`, `existsSync`
// as a pre-check) follows them with its uid: the database, the login, the files of other projects. The readers are
// protected via the descriptor (runs/runtime-limit.js, runtime/real-path.js openFileWithoutReference); this file does
// the same for the writers.
//
// THE RULE. If a path lies BY ITS WORDING in a runtime folder (`runtimeFolderOf` — pure, without store and without
// instance row: a location there was or still is mounted in a container, and a link outlasts every way back), B
// writes only via the descriptor: the parent folder is opened and checked via the runtime folder as TRUSTED ANCHOR
// (missing parts are created afterwards, each O_NOFOLLOW), the file in it O_NOFOLLOW|O_NONBLOCK — no link, not even
// one that stays inside the folder, only a regular file; truncation only after the check (runtime/real-path.js
// openFileWithoutReference). A copy is created as a temp file O_EXCL|O_NOFOLLOW in the pinned parent folder and
// renamed there — a link at the target's place falls itself, never its target. The area is the whole runtime folder:
// a link that stays inside is harmless (the container writes there anyway), one leading outside throws `EOUTSIDE`.
//
// WITHOUT a runtime folder (flat location, every project that is not converted, the local server) the functions
// return `false` and do NOTHING: the caller then writes with exactly its previous calls, byte-identical
// (`if (!write…(…)) { … as before … }`). The guard server/backend/test/runtime-write-guard.test.js holds every write
// site of the files that write runtime paths against this form or a named entry.
//
//   runtimeFolderOf(p)                 the runtime folder in which `p` lies by its wording, otherwise null (kept here
//                                        so the leaves can ask without the store; runs/runtime-location.js passes it
//                                        on, services.js gets it as `logAnchor`).
//   writeInRuntimeFolder(p, data, { mode })   create or replace → true; false outside.
//   createFolderInRuntimeFolder(folder)  mkdir -p in the area → true; false outside.
//   copyInRuntimeFolder(from, to, { onlyIfMissing, times })   → "copied" | "present" (already there) | false (no side in
//                                        a runtime folder). If the TARGET lies in one, the above applies; if only the
//                                        SOURCE lies in one (back into the flat store, browser-profiles.js
//                                        saveChatLogins), the target is created in B via the path as before (temp +
//                                        rename), but the source is opened without links (otherwise B would copy a
//                                        login into the store through a link — and into the runtime folder on the
//                                        next run). `from` may be `{ fd }` (already open, from a walk without links —
//                                        the caller closes). A source outside is opened as before (`copyFileSync`
//                                        followed it). `onlyIfMissing`: like `existsSync(to)` before (a link with a
//                                        target counts as there, one without as missing — and falls on rename).
//                                        `times`: atime/mtime of the source (milliseconds). The source's mode goes
//                                        along (as with `copyFileSync`), without setuid/setgid/sticky.
//   cloneWithoutReference(from, to, { omit, take })   a tree (or a file) → { kind, copied, error } | false (no side
//                                        in a runtime folder). The walk never leaves `from`
//                                        (traverseWithoutReferences): links, FIFOs and devices stay behind — a link
//                                        from the runtime folder that landed in B would meet writers without a check
//                                        there. Every file via its descriptor, every target folder in the area.
//                                        `omit(name)` skips an entry with its content, `take(source, target)` (fstat
//                                        of the source, lstat of the target or null) decides per file (default:
//                                        always; a folder at the target is never replaced). Without a readable
//                                        source it throws (ENOENT, EOUTSIDE) and creates nothing; an error at an
//                                        entry is in `error`. `kind`: "folder" | "file" | null (the source itself is
//                                        a link, FIFO, device — then nothing is created).
//   removeInRuntimeFolder(p)          file, link or folder with content via pinned descriptors (a link falls itself)
//                                        → true, also if `p` did not exist; false outside.
//   renameInRuntimeFolder(from, to)   rename via the opened parent folders (EEXIST if `to` exists) → true; false if
//                                        no side lies in a runtime folder.
//   areaInRuntimeFolder(p)            the real roots for a walk of one's own (runtime/real-path.js
//                                        traverseWithoutReferences), `null` outside.
//
// READING. The same situation applies to the backend's readers that know only the wording of a runtime path (leaves
// without store, readers without instance): `readFileSync` would follow a link (the bytes would go to whoever
// asked), and a FIFO at the file's place would stall the backend's event loop (blocking `open`). Two functions with
// the same switch: in the runtime folder via the descriptor — parent folder checked via the anchor, the file
// O_NOFOLLOW|O_NONBLOCK, only a regular one (`EOUTSIDE`, `ENOFILE` as above) —, outside `null`, and the caller reads
// as before.
//   openFromRuntimeFolder(p)           → fd (the caller closes) | null outside.
//   readFromRuntimeFolder(p, encoding)   like `readFileSync(p, encoding)` | null outside.
//   Both with `{ maxBytes }`: larger at the descriptor ⇒ throws BEFORE reading (a huge sparse file in the runtime
//   folder would otherwise be read whole — in the scanner every 3 s); without the option as before.
// With instance and store (project folder AND runtime folder as anchors) runs/runtime-limit.js readInRuntimeFolder
// reads.
// Errors: `EOUTSIDE` (a part leads outside, a link at the file's place), `ENOFILE` (FIFO, device, folder), otherwise
// as the file system. What a caller does on `EOUTSIDE` (report, 409, discard) is its decision — it never writes via
// the path then.
// Consumers (writers): providers/agent-runtime.js, runs/outputs.js, toolchain/playwright.js and mcp-config.js,
// browsers.js, browser-profiles.js, captures.js, runs/agents.js, runs/runtime-location.js, runs/session-transfer.js,
// channels/messages.js, workflows/graph-start.js and graph-background.js, chats/routes.js, dynworkflows/,
// projectbox/instance.js, projectbox/cli-home.js.
// Readers: captures.js, browsers.js, dynworkflows/approval.js, chats/routes.js, channels/messages.js. Folder
// listings keep reading the names with `readdirSync` — every entry then goes through one of these readers.
// Guards: server/backend/test/runtime-write.test.js (behaviour per site), runtime-read.test.js (the readers, mount
// sources), runtime-write-guard.test.js (source text).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DIRS } from "../app-state.js";
import {
  renameInArea, traverseWithoutReferences, realRoots, removeInArea, inFolderInArea, createFolderInArea,
  readDescriptor, openFileWithoutReference, tooBig,
} from "../runtime/real-path.js";

/** The subfolder of `<data>/` under which the projects' runtime folders live. */
export const PROJECTS = "projects";

const O = fs.constants;

/**
 * The runtime folder in which `filePath` lies BY ITS WORDING — otherwise `null`. Pure, without store and without the
 * instance row: a path there belongs to a folder that a project container has or had mounted rw (a link it created
 * there outlasts the way back). Without an instance row runs/runtime-location.js assigns no path there (flat
 * location).
 */
export function runtimeFolderOf(filePath) {
  if (!DIRS?.data || typeof filePath !== "string" || !filePath) return null;
  const base = path.join(DIRS.data, PROJECTS);
  const rel = path.relative(base, path.resolve(filePath));
  if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  return path.join(base, rel.split(path.sep)[0]);
}

// The area of a path in the runtime folder: the runtime folder itself, via itself as anchor (its realpath — a mount
// point of the container that it cannot replace). `null` outside.
function areaOf(filePath) {
  const anchor = runtimeFolderOf(filePath);
  return anchor ? realRoots([anchor], [anchor]) : null;
}

/** The real roots of the runtime folder `filePath` lies in (for a walk of one's own without links) — `null` outside. */
export const areaInRuntimeFolder = (filePath) => areaOf(filePath);

// ── Reading (see header) ───────────────────────────────────────────────────────────────────────────────────────────

/** Open a file in the runtime folder for reading (see header, "READING") → fd (the caller closes); `null` outside.
 *  `maxBytes`: if the file is larger at the descriptor, this throws — the caller then reads itself (via
 *  `readDescriptor` with the same cap, in case the file keeps growing). Without `maxBytes` as before. */
export function openFromRuntimeFolder(filePath, { maxBytes = null } = {}) {
  const w = areaOf(filePath);
  if (!w) return null;
  const fd = openFileWithoutReference(filePath, w);
  if (maxBytes !== null && maxBytes !== undefined) {
    let size = 0;
    try { size = fs.fstatSync(fd).size; } catch (e) { fs.closeSync(fd); throw e; }
    if (size > maxBytes) { fs.closeSync(fd); throw tooBig(filePath, size, maxBytes); }
  }
  return fd;
}

/** Read a file in the runtime folder like `readFileSync(filePath, encoding)` (see header) — `null` outside.
 *  `maxBytes`: larger ⇒ throws BEFORE reading, and at most `maxBytes + 1` bytes are read. */
export function readFromRuntimeFolder(filePath, encoding, { maxBytes = null } = {}) {
  const fd = openFromRuntimeFolder(filePath, { maxBytes });
  if (fd === null) return null;
  try { return readDescriptor(fd, encoding, { maxBytes, display: filePath }); } finally { fs.closeSync(fd); }
}

const asBuffer = (data) => (Buffer.isBuffer(data) ? data
  : ArrayBuffer.isView(data) ? Buffer.from(data.buffer, data.byteOffset, data.byteLength) : Buffer.from(String(data)));

function writeEverything(fd, buf) {
  let n = 0;
  while (n < buf.length) n += fs.writeSync(fd, buf, n, buf.length - n, n);
}

/**
 * Create or replace a file in the runtime folder — via the descriptor (see header). → true; `false` if `filePath`
 * lies in no runtime folder (then nothing happened, the caller writes as before). `mode`: the mode after the write.
 */
export function writeInRuntimeFolder(filePath, data, { mode = null } = {}) {
  const w = areaOf(filePath);
  if (!w) return false;
  const fd = openFileWithoutReference(filePath, w, { flags: O.O_WRONLY, create: true });
  try {
    fs.ftruncateSync(fd, 0);
    writeEverything(fd, asBuffer(data));
    if (mode !== null) fs.fchmodSync(fd, mode);
  } finally { fs.closeSync(fd); }
  return true;
}

/**
 * Open a file in the runtime folder for APPENDING (a monitor's log file, runs/monitors.js) — via the descriptor
 * without links, created if missing → fd (the caller holds and closes it); `null` if `filePath` lies in no runtime
 * folder.
 */
export function openForAppendInRuntimeFolder(filePath) {
  const w = areaOf(filePath);
  if (!w) return null;
  return openFileWithoutReference(filePath, w, { flags: O.O_WRONLY | O.O_APPEND, create: true });
}

/** mkdir -p in the runtime folder (existing parts by their real location in the area, new ones O_NOFOLLOW) → true; `false` outside. */
export function createFolderInRuntimeFolder(folder) {
  const w = areaOf(folder);
  if (!w) return false;
  createFolderInArea(folder, w);
  return true;
}

// The source of a copy: `{ fd }` (already open), in a runtime folder without links (the container could swap it for
// a file of B), otherwise like `copyFileSync` (follows). → { fd, own } (`own`: this file closes it).
const isFd = (from) => Boolean(from) && typeof from === "object" && Number.isInteger(from.fd);
function openSource(from) {
  if (isFd(from)) {
    if (!fs.fstatSync(from.fd).isFile()) throw Object.assign(new Error("Not a regular file (descriptor)"), { code: "ENOFILE" });
    return { fd: from.fd, own: false };
  }
  const w = areaOf(from);
  const fd = w ? openFileWithoutReference(from, w) : fs.openSync(from, O.O_RDONLY);
  try {
    if (!fs.fstatSync(fd).isFile()) throw Object.assign(new Error(`Not a regular file: ${from}`), { code: "ENOFILE" });
  } catch (e) { fs.closeSync(fd); throw e; }
  return { fd, own: true };
}

function copyContent(q, z) {
  const buf = Buffer.allocUnsafe(1 << 20);
  let pos = 0;
  for (;;) {
    const n = fs.readSync(q, buf, 0, buf.length, pos);
    if (!n) return;
    let w = 0;
    while (w < n) w += fs.writeSync(z, buf, w, n - w);
    pos += n;
  }
}

/**
 * A copy where one side lies in a runtime folder (see header) → "copied" | "present" (only with `onlyIfMissing`) |
 * `false` if no side lies in one (then nothing happened). `at(name)` is the name in the target folder: in the
 * runtime folder via the opened, checked folder, in B via the path (no container mounts anything there).
 */
export function copyInRuntimeFolder(from, to, { onlyIfMissing = false, times = false } = {}) {
  const w = areaOf(to);
  if (!w && !isFd(from) && !areaOf(from)) return false;
  const target = path.resolve(String(to));
  const name = path.basename(target);
  const copy = (at) => {
    if (onlyIfMissing && fs.existsSync(at(name))) return "present";
    const q = openSource(from);
    try {
      const st = fs.fstatSync(q.fd);
      const tmp = `${name}.copy-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
      const z = fs.openSync(at(tmp), O.O_WRONLY | O.O_CREAT | O.O_EXCL | O.O_NOFOLLOW | O.O_NONBLOCK, 0o666);
      try {
        copyContent(q.fd, z);
        fs.fchmodSync(z, st.mode & 0o777);
        if (times) fs.futimesSync(z, st.atimeMs / 1000, st.mtimeMs / 1000);
      } catch (e) {
        fs.closeSync(z);
        try { fs.unlinkSync(at(tmp)); } catch { /* already gone */ }
        throw e;
      }
      fs.closeSync(z);
      try { fs.renameSync(at(tmp), at(name)); } catch (e) { try { fs.unlinkSync(at(tmp)); } catch { /* already gone */ } throw e; }
      return "copied";
    } finally { if (q.own) fs.closeSync(q.fd); }
  };
  if (w) return inFolderInArea(path.dirname(target), w, ({ at }) => copy(at), { create: true });
  // Only the source lies in the runtime folder: the target in B via the path as before.
  fs.mkdirSync(path.dirname(target), { recursive: true });
  return copy((n) => path.join(path.dirname(target), n));
}

/** Delete in the runtime folder (see header) → true (also if the path did not exist); `false` outside. */
export function removeInRuntimeFolder(filePath) {
  const w = areaOf(filePath);
  if (!w) return false;
  try { removeInArea(filePath, w); } catch (e) { if (e?.code !== "ENOENT") throw e; }
  return true;
}

/** Rename if one side lies in the runtime folder (see header) → true; `false` if none does. */
export function renameInRuntimeFolder(from, to) {
  const wv = areaOf(from);
  const wn = areaOf(to);
  if (!wv && !wn) return false;
  renameInArea(from, to, wv, wn);
  return true;
}

const lstatOrNull = (p) => fs.lstatSync(p, { throwIfNoEntry: false }) ?? null;
const always = () => true;

/** Copy a tree (or a file) without links if one side lies in the runtime folder (see header). */
export function cloneWithoutReference(from, to, { omit = () => false, take = always } = {}) {
  const wv = areaOf(from);
  if (!wv && !areaOf(to)) return false;
  const a = path.resolve(String(from));
  const b = path.resolve(String(to));
  const result = { kind: null, copied: 0, error: [] };
  const folder = (o) => { if (!createFolderInRuntimeFolder(o)) fs.mkdirSync(o, { recursive: true }); };
  const file = (open, dst) => {
    let fd = null;
    try {
      fd = open();
      const q = fs.fstatSync(fd);
      if (!q.isFile()) return;
      const z = lstatOrNull(dst);
      if (z?.isDirectory() || !take(q, z)) return;
      copyInRuntimeFolder({ fd }, dst, { times: true });
      result.copied++;
    } catch (e) { result.error.push(`${dst}: ${e?.code || e?.message || e}`); } finally { if (fd !== null) fs.closeSync(fd); }
  };
  // The source itself, without following it: a link at its place is not copied.
  const name = path.basename(a);
  const kind = inFolderInArea(path.dirname(a), wv, ({ at }) => fs.lstatSync(at(name)));
  if (kind.isFile()) {
    result.kind = "file";
    file(() => inFolderInArea(path.dirname(a), wv, ({ at }) => fs.openSync(at(name), O.O_RDONLY | O.O_NOFOLLOW | O.O_NONBLOCK)), b);
    return result;
  }
  if (!kind.isDirectory()) return result;
  folder(b);
  result.kind = "folder";
  traverseWithoutReferences(a, wv, (abs, e, { open }) => {
    if (omit(e.name)) return false;
    const dst = path.join(b, path.relative(a, abs));
    if (e.isDirectory()) {
      try { folder(dst); return true; } catch (err) { result.error.push(`${dst}: ${err?.code || err?.message || err}`); return false; }
    }
    if (e.isFile()) file(open, dst);
    return false;
  });
  return result;
}
