// File operations for a project's code editor — every path is strictly confined to the project folder (no escape via ".." and
// the like): read/write/create/rename/delete and a capped full-text search.
//
// THE LIMIT OF A RELOCATED PROJECT. These paths run in B — also for a relocated project whose folder the project container can
// write to. A link it creates there (`note → /home/agent/.bashrc`) would lead the literal check in `resolveInside` out of the
// project: read, write, rename, delete in B. With `{ limit }` (from devtools/code-route.js: `limit(abs)` → the real roots of the
// instance that own `abs`, or null) every path goes through runtime/real-path.js — on the opened, checked descriptor: no link out
// of the area is followed, a link is moved itself on delete and rename, never its target; tree walks (search, deleting a folder)
// never leave their start folder once a limit is present. Without `limit` (or for a path it maps to null) the plain path — the
// local server included. Guard: server/backend/test/engine-in-project.test.js.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import {
  renameInArea, descriptorLocation, traverseWithoutReferences, removeInArea, inFolderInArea, createFileInArea, createFolderInArea,
  nameInFolder, openFileWithoutReference, openInArea, folderContentInArea, writeInArea, statInArea,
} from "./runtime/real-path.js";
import { searchArea, searchPattern, searchLines } from "./runtime/fileAccess.js";
import { fastPattern, fastOpen, fastMatches } from "./runtime/fast-open.js";
import { T } from "./i18n.js";

const MAX_READ = 5 * 1024 * 1024;        // larger files are not opened in the editor
const SEARCH_MAX_FILE = 1 * 1024 * 1024; // search skips files larger than this
const SEARCH_MAX_MATCHES = 2000;         // cap on total matches
const SEARCH_MAX_FILES = 40000;          // cap on files searched

// Directories the tree/search skips or leaves collapsed as "heavy".
export const HEAVY_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", "out", "target", "vendor",
  ".venv", "venv", "__pycache__", ".cache", "coverage", ".turbo",
]);

// Resolve `rel` (project-relative) safely to an absolute path INSIDE the project.
function resolveInside(projectPath, rel) {
  const base = path.resolve(projectPath);
  const cleaned = String(rel || "").replace(/^[/\\]+/, "");
  const abs = path.resolve(base, cleaned);
  if (abs !== base && !abs.startsWith(base + path.sep)) throw new Error(T("Path outside the project"));
  return abs;
}

// Build the relative POSIX path (with /) from an absolute path.
const toRel = (projectPath, abs) => path.relative(projectPath, abs).split(path.sep).join("/");

// The real roots that apply to `abs` (see header) — null = the plain path.
const areaFor = (limit, abs) => (typeof limit === "function" ? limit(abs) || null : null);

const lstatOrNull = (p) => { try { return fs.lstatSync(p); } catch (e) { if (e?.code === "ENOENT") return null; throw e; } };

function statType(abs) {
  const st = fs.lstatSync(abs);
  if (st.isSymbolicLink()) {
    // Mark symlinks as such, but determine the target type (for sorting/icon).
    let target = null;
    try { target = fs.statSync(abs); } catch { /* dead link */ }
    return { type: target && target.isDirectory() ? "dir" : "file", symlink: true, size: target ? target.size : 0 };
  }
  return { type: st.isDirectory() ? "dir" : "file", symlink: false, size: st.size };
}

// Directory content (not recursive) — folders first, then files, alphabetical.
export function listDir(projectPath, rel, { limit } = {}) {
  const abs = resolveInside(projectPath, rel);
  const area = areaFor(limit, abs);
  if (area) return listDirInArea(projectPath, rel, abs, area);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new Error(T("Not a directory"));
  const out = [];
  for (const name of fs.readdirSync(abs)) {
    if (name === ".git") continue; // hide repo internals (like VS Code)
    const childAbs = path.join(abs, name);
    let info;
    try { info = statType(childAbs); } catch { continue; } // unreadable → skip
    out.push({ name, path: toRel(projectPath, childAbs), type: info.type, size: info.size, symlink: info.symlink, heavy: info.type === "dir" && HEAVY_DIRS.has(name) });
  }
  out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
  chainsAlongside(out, projectPath, abs, (location) => fs.readdirSync(location, { withFileTypes: true }).map((d) => ({ name: d.name, folder: d.isDirectory() })));
  return { path: rel ? String(rel).replace(/^[/\\]+/, "") : "", entries: out };
}

// With a limit: the folder is opened and checked, every entry goes through it; a link out of the area shows nothing of its
// target (like a link without a target: file, size 0).
function listDirInArea(projectPath, rel, abs, area) {
  let entries;
  try { entries = folderContentInArea(abs, area); } catch (e) {
    if (e?.code === "ENOENT" || e?.code === "ENOTDIR") throw new Error(T("Not a directory"));
    throw e;
  }
  const out = [];
  for (const { name, st, target } of entries) {
    if (name === ".git" || !st) continue;
    const symlink = st.isSymbolicLink();
    const info = symlink
      ? { type: target && target.isDirectory() ? "dir" : "file", size: target ? target.size : 0 }
      : { type: st.isDirectory() ? "dir" : "file", size: st.size };
    out.push({ name, path: toRel(projectPath, path.join(abs, name)), type: info.type, size: info.size, symlink, heavy: info.type === "dir" && HEAVY_DIRS.has(name) });
  }
  out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
  chainsAlongside(out, projectPath, abs, (location) => folderContentInArea(location, area).filter((x) => x.st).map((x) => ({ name: x.name, folder: x.st.isDirectory() })));
  return { path: rel ? String(rel).replace(/^[/\\]+/, "") : "", entries: out };
}

// Compact folders already in the collapsed tree (explorer like VS Code, `resolveSingleChildDescendants`): for each subfolder of the
// list the chain of single subfolders ("deep" → a → b → c, as long as a folder has EXACTLY one entry and it is a folder — no link,
// `.git` does not count, a heavy folder ends it). The tree (web/src/lib/explorer-tree.ts) draws "deep/a/b/c" from it without
// expanding. Capped with notice inward: at most CHAIN_DEPTH links per folder and CHAINS_READ_MAX folders read per list — a cut chain
// simply ends earlier (the rest loads on expand like any folder). `read2(location)` → `[{ name, folder }]` (lstat kind: a link is
// not a folder) or throws. Guard: server/backend/test/files-chains.test.js.
export const CHAIN_DEPTH = 32;
export const CHAINS_READ_MAX = 200;
export function chainsAlongside(out, projectPath, abs, read2) {
  let read = 0;
  for (const e of out) {
    if (e.type !== "dir" || e.symlink || e.heavy) continue;
    const chain = [];
    let location = path.join(abs, e.name);
    while (chain.length < CHAIN_DEPTH && read < CHAINS_READ_MAX) {
      read++;
      let content;
      try { content = read2(location).filter((x) => x.name !== ".git"); } catch { break; }
      if (content.length !== 1 || !content[0].folder) break;
      const name = content[0].name;
      location = path.join(location, name);
      const heavy = HEAVY_DIRS.has(name);
      chain.push({ name, path: toRel(projectPath, location), type: "dir", size: 0, symlink: false, heavy });
      if (heavy) break;
    }
    if (chain.length) e.chain = chain;
  }
  return out;
}

// Image formats the code viewer previews instead of showing "binary file". SVG is deliberately absent:
// it is text and belongs in the editor (readFile therefore returns it as text).
export const IMAGE_MIME = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".avif": "image/avif", ".bmp": "image/bmp", ".ico": "image/x-icon",
  ".heic": "image/heic", ".heif": "image/heif", ".apng": "image/apng", ".tiff": "image/tiff",
  ".tif": "image/tiff",
};
export const imageMime = (name) => IMAGE_MIME[path.extname(String(name || "")).toLowerCase()] || "";

// Read a file's text content. Too large / binary → flag instead of content. Images are additionally
// marked as such so the viewer can show a preview instead of "binary file".
export function readFile(projectPath, rel, { limit } = {}) {
  const abs = resolveInside(projectPath, rel);
  const area = areaFor(limit, abs);
  if (area) return readFileInArea(projectPath, abs, area);
  const st = fs.statSync(abs);
  if (st.isDirectory()) throw new Error(T("Is a directory"));
  const mime = imageMime(abs);
  // Do NOT measure images against MAX_READ: they are not loaded into the editor but delivered
  // separately as bytes. An 8 MB photo should still be visible.
  if (mime) return { path: toRel(projectPath, abs), binary: true, image: true, mime, size: st.size };
  if (st.size > MAX_READ) return { path: toRel(projectPath, abs), tooLarge: true, size: st.size };
  const buf = fs.readFileSync(abs);
  const sniff = buf.subarray(0, 8192);
  if (sniff.includes(0)) return { path: toRel(projectPath, abs), binary: true, size: st.size };
  return { path: toRel(projectPath, abs), content: buf.toString("utf8"), size: st.size };
}

// With a limit: ONE checked descriptor (O_NONBLOCK — a FIFO does not stall B), only regular files are read.
function readFileInArea(projectPath, abs, area) {
  const fd = openInArea(abs, area);
  try {
    const st = fs.fstatSync(fd);
    if (st.isDirectory()) throw new Error(T("Is a directory"));
    if (!st.isFile()) throw new Error(T("Not a regular file"));
    const mime = imageMime(abs);
    if (mime) return { path: toRel(projectPath, abs), binary: true, image: true, mime, size: st.size };
    if (st.size > MAX_READ) return { path: toRel(projectPath, abs), tooLarge: true, size: st.size };
    const buf = fs.readFileSync(fd);
    if (buf.subarray(0, 8192).includes(0)) return { path: toRel(projectPath, abs), binary: true, size: st.size };
    return { path: toRel(projectPath, abs), content: buf.toString("utf8"), size: st.size };
  } finally { fs.closeSync(fd); }
}

// Write a batch of files (base64) into a folder. `dir` is the target directory relative to
// `projectPath` (empty = root), the paths of the individual files are relative to IT — so the
// client can upload a whole folder with subfolders without knowing the root.
// `append` continues a follow-up chunk (large files arrive in pieces).
export function uploadFiles(projectPath, { dir = "", files = [] } = {}, { limit } = {}) {
  const target = resolveInside(projectPath, dir);
  const targetArea = areaFor(limit, target);
  if (targetArea) {
    let st = null;
    try { st = statInArea(target, targetArea); } catch (e) { if (e?.code === "EOUTSIDE") throw e; }
    if (!st || !st.isDirectory()) throw new Error(T("Target folder not found"));
  } else if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) throw new Error(T("Target folder not found"));
  const base = path.resolve(target);
  let written = 0;
  for (const f of files) {
    const rel = String(f?.path || "").replace(/\\/g, "/");
    if (!rel || rel.startsWith("/") || rel.split("/").some((s) => s === ".." || s === "." || s === "")) {
      throw new Error(T`Invalid path: ${rel}`);
    }
    const abs = path.resolve(base, rel);
    if (!abs.startsWith(base + path.sep)) throw new Error(T("Path leaves the folder"));
    const area = areaFor(limit, abs);
    if (area) {
      writeInArea(abs, Buffer.from(String(f.dataB64 || ""), "base64"), area, { append: Boolean(f?.append) });
      written++;
      continue;
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, Buffer.from(String(f.dataB64 || ""), "base64"), { flag: f?.append ? "a" : "w" });
    written++;
  }
  return { written, dir: toRel(projectPath, base) };
}

// Resolve the target of a download: file or folder, always INSIDE `projectPath`.
// Symlinks are followed, but their target must lie in the folder — otherwise a link in the
// project could deliver arbitrary files of the machine.
export function downloadTarget(projectPath, rel, { limit } = {}) {
  const abs = resolveInside(projectPath, rel);
  const area = areaFor(limit, abs);
  // With a limit, the checked descriptor first (same verdict path as /files/read) — then the plain path.
  if (area) {
    try { fs.closeSync(openInArea(abs, area)); } catch (e) {
      if (e?.code === "ENOENT") throw new Error(T("Not found"));
      throw e;
    }
  }
  if (!fs.existsSync(abs)) throw new Error(T("Not found"));
  const base = fs.realpathSync(path.resolve(projectPath));
  const real = fs.realpathSync(abs);
  if (real !== base && !real.startsWith(base + path.sep)) throw new Error(T("Path outside the project"));
  const st = fs.statSync(real);
  const name = path.basename(real) || path.basename(base) || "download";
  return { abs: real, dir: st.isDirectory(), size: st.size, name, mtime: st.mtime };
}

// OPEN the target of a download with a limit — for runtime/http.js serveDownload. Pre-checking via the descriptor and then downloading
// via the PATH left a window: if the project container swapped the target for a link in between, the bytes went out of B. → `null`
// (no limit for this path: the plain path) or `{ fd, st, abs, name, area }` with ONE checked descriptor (O_NONBLOCK — a FIFO does
// not stall B), `st` from fstat. A regular file goes out over this fd, a folder as ZIP via zip.js (inside the area, without links;
// the fd is then closed). Anything else throws "Not a regular file" (the caller answers 400). The caller closes `fd` when it is set.
export function openDownload(projectPath, rel, { limit } = {}) {
  const abs = resolveInside(projectPath, rel);
  const area = areaFor(limit, abs);
  if (!area) return null;
  let fd;
  try { fd = openInArea(abs, area); } catch (e) {
    if (e?.code === "ENOENT") throw new Error(T("Not found"));
    throw e;
  }
  let st;
  try { st = fs.fstatSync(fd); } catch (e) { fs.closeSync(fd); throw e; }
  const name = path.basename(abs) || path.basename(path.resolve(projectPath)) || "download";
  if (st.isFile()) return { fd, st, abs, name, area };
  fs.closeSync(fd);
  if (st.isDirectory()) return { fd: null, st, abs, name, area };
  throw Object.assign(new Error(T`Not a regular file: ${toRel(projectPath, abs) || "."}`), { code: "ENOFILE" });
}

// Write a file (parent folders are created as needed).
export function writeFile(projectPath, rel, content, { limit } = {}) {
  const abs = resolveInside(projectPath, rel);
  const area = areaFor(limit, abs);
  if (area) {
    try { writeInArea(abs, String(content ?? ""), area); } catch (e) {
      if (e?.code === "EISDIR") throw new Error(T("Is a directory"));
      throw e;
    }
    return { ok: true, path: toRel(projectPath, abs), size: Buffer.byteLength(String(content ?? "")) };
  }
  if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) throw new Error(T("Is a directory"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, String(content ?? ""), "utf8");
  return { ok: true, path: toRel(projectPath, abs), size: Buffer.byteLength(String(content ?? "")) };
}

// ── The precondition of writing ────────────────────────────────────────────────────────────────────────────────────────────────
// `GET …/files/read` gives every text a `sha` (sha256 of the text as delivered: UTF-8), `PUT …/files/write` takes it as optional
// `base` — "I am writing on the state I read". If the file has meanwhile deviated (an agent wrote, it is deleted, it is no longer
// text), the route answers 409 `{ code: "CHANGED", current, missing? }` instead of silently overwriting; the editor (web
// lib/file-status.ts) then asks "reload / keep mine", and "keep" deliberately writes WITHOUT `base`. Without `base` the route writes
// as before (iOS, older clients). Checking and writing are two steps, no lock — the gap between them is milliseconds, the window
// before it (an open editor) minutes. Applies in the main and in a copy (devtools/code-route.js). Guard: files-base.test.js.
export const contentSha = (text) => crypto.createHash("sha256").update(String(text ?? ""), "utf8").digest("hex");
/** A readFile response with `sha` when it carries text (binary, too large, image: without). */
export const withSha = (r) => (r && typeof r.content === "string" ? { ...r, sha: contentSha(r.content) } : r);
/** `base` from the body: missing/null ⇒ null (no precondition); 64 hex ⇒ the value; anything else throws (the route answers 400). */
export function baseFromBody(b) {
  const v = b?.base;
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || !/^[0-9a-f]{64}$/.test(v)) throw new Error(T("base must be a sha256 (64 hex characters) or absent"));
  return v;
}
/** Does the precondition hold? `reading` = what /files/read says NOW, null = the file does not exist. Null ⇒ it holds; else the 409 body. */
export function baseDeviation(base, reading) {
  const error = T("The file has changed in the meantime — reload or overwrite deliberately.");
  if (reading === null) return { error, code: "CHANGED", current: null, missing: true };
  const current = typeof reading?.content === "string" ? contentSha(reading.content) : null;
  return current === base ? null : { error, code: "CHANGED", current };
}
/** Read for the check: a missing file is null, any other error passes on (the route answers as with writing). */
export async function readingOrMissing(read) {
  try { return await read(); } catch (e) { if (e?.code === "ENOENT") return null; throw e; }
}

// Create a file or folder (error if it already exists).
export function createEntry(projectPath, rel, type, { limit } = {}) {
  const abs = resolveInside(projectPath, rel);
  const area = areaFor(limit, abs);
  if (area) {
    // lstat instead of existsSync: a link WITHOUT a target is an existing name (writeFileSync would create the file at its target).
    if (lstatOrNull(abs)) throw new Error(T("Already exists"));
    try {
      if (type === "dir") createFolderInArea(abs, area);
      else createFileInArea(abs, area);
    } catch (e) {
      if (e?.code === "EEXIST") throw new Error(T("Already exists"));
      throw e;
    }
    return { ok: true, path: toRel(projectPath, abs), type: type === "dir" ? "dir" : "file" };
  }
  if (fs.existsSync(abs)) throw new Error(T("Already exists"));
  if (type === "dir") {
    fs.mkdirSync(abs, { recursive: true });
  } else {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, "", "utf8");
  }
  return { ok: true, path: toRel(projectPath, abs), type: type === "dir" ? "dir" : "file" };
}

// Rename / move.
export function renameEntry(projectPath, fromRel, toRel_, { limit } = {}) {
  const from = resolveInside(projectPath, fromRel);
  const to = resolveInside(projectPath, toRel_);
  const ofArea = areaFor(limit, from);
  const afterArea = areaFor(limit, to);
  // If either side belongs to a relocated project: via the opened parent folders (the other side — on the workspace level a
  // path in B — is only pinned, without an area check).
  if (ofArea || afterArea) {
    try { renameInArea(from, to, ofArea, afterArea); } catch (e) {
      if (e?.code === "ENOENT") throw new Error(T("Source not found"));
      if (e?.code === "EEXIST") throw new Error(T("Target already exists"));
      throw e;
    }
    return { ok: true, path: toRel(projectPath, to) };
  }
  if (!fs.existsSync(from)) throw new Error(T("Source not found"));
  if (fs.existsSync(to)) throw new Error(T("Target already exists"));
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
  return { ok: true, path: toRel(projectPath, to) };
}

// ── Copying ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Copy/paste, duplicate and ⌥-drag in the tree: a file or a folder with content to a NEW place — never overwrite (an existing target
// is an error with `code: "TARGET_EXISTS"`, the route answers 409; the free name "name copy.ext" is computed by the client,
// web/src/lib/explorer-names.ts). Links are NOT followed: a link is copied as a link (its target verbatim), never its target; a FIFO,
// device or socket is dropped (`omitted` counts them). ONE path for all cases: every folder is read and created through its opened
// parent folder (runtime/real-path.js `nameInFolder`/`inFolderInArea`), every file opened O_NOFOLLOW and created O_EXCL — with a limit
// (a relocated project) within its areas, without one as in the local server. A folder into itself (also via a link in the target
// path: the REAL locations are compared, at the descriptor) and the project folder itself are errors. Cap with notice (counted before
// the first effect): COPY_MAX_ENTRIES entries, COPY_MAX_BYTES bytes — above that nothing is copied, the error names both numbers
// (`code: "COPY_TOO_LARGE"`). Exactly the plan of the count is copied (a second walk would see the entries just created and copy in
// a circle, past the cap), the bytes asynchronously. Guard: server/backend/test/files-copy.test.js.
export const COPY_MAX_ENTRIES = 5000;
export const COPY_MAX_BYTES = 512 * 1024 * 1024;
const withCode = (text, code) => Object.assign(new Error(text), { code });
const COPY_BUFFER = 1024 * 1024;

// Bytes from fd to fd, in pieces and ASYNCHRONOUS (a large file does not stall B and is never fully in memory).
const readFd = promisify(fs.read), writeFd = promisify(fs.write);
async function copyBytes(from, to) {
  const buf = Buffer.allocUnsafe(COPY_BUFFER);
  for (;;) {
    const { bytesRead: n } = await readFd(from, buf, 0, buf.length, null);
    if (n <= 0) return;
    let fromIdx = 0;
    while (fromIdx < n) fromIdx += (await writeFd(to, buf, fromIdx, n - fromIdx)).bytesWritten;
  }
}

// A source that vanished or became a link between plan and copy is dropped (`omitted`) — the target is never silently wrong.
const SOURCE_GONE = new Set(["ENOENT", "ELOOP", "ENOTDIR", "EMLINK"]);
const sourceOrNull = (f) => { try { return f(); } catch (e) { if (SOURCE_GONE.has(e?.code)) return null; throw e; } };

// One entry to the new place. `q` describes the source: `kind` ("reference" | "folder" | "file" | other), `open()` opens a file
// O_NOFOLLOW (via pinned folders), `reference()` reads a link's target. `prior({ fd, path })` runs in the opened target folder
// before anything is created (the location check of the top entry). → true if it was copied.
async function copyEntryValue(q, target, afterArea, prior = null) {
  const name = path.basename(target);
  const inTarget = (fn) => inFolderInArea(path.dirname(target), afterArea, (o) => { if (prior) prior(o); return fn(o.at(name)); }, { create: true });
  if (q.kind === "folder") { inTarget((at) => fs.mkdirSync(at)); return true; }
  if (q.kind === "reference") {
    const whereTo = sourceOrNull(() => q.reference());
    if (whereTo === null) return false;
    inTarget((at) => fs.symlinkSync(whereTo, at));
    return true;
  }
  if (q.kind !== "file") return false;
  const from = sourceOrNull(() => q.open());
  if (from === null) return false;
  try {
    const st = fs.fstatSync(from);
    if (!st.isFile()) return false; // something else by now — do not read
    const to = inTarget((at) => fs.openSync(at, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, st.mode & 0o777));
    try { await copyBytes(from, to); } finally { fs.closeSync(to); }
  } finally { fs.closeSync(from); }
  return true;
}
const kindOf = (x) => (x.isSymbolicLink() ? "reference" : x.isDirectory() ? "folder" : x.isFile() ? "file" : "otherwise");
const OPEN_SOURCE = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
const OPEN_FOLDER = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;

// Open the folder `rel` under the pinned `start` — every part O_NOFOLLOW from the previous one (Linux via /proc/self/fd) — and call
// `fn({ at })` in it. So the copy reads exactly the entries of the plan, never one that has become a link meanwhile.
function inPlanFolder(startFd, start, rel, fn) {
  const open = [];
  let fd = startFd, filePath = start;
  try {
    for (const part of rel ? rel.split(path.sep) : []) {
      fd = fs.openSync(nameInFolder(fd, filePath, part), OPEN_FOLDER);
      open.push(fd);
      filePath = path.join(filePath, part);
    }
    const f = fd, p = filePath;
    return fn({ at: (name) => nameInFolder(f, p, name) });
  } finally { for (const x of open) fs.closeSync(x); }
}

// The real location of a (maybe not yet existing) target folder: its deepest existing ancestor opened, its location at the descriptor
// (runtime/real-path.js descriptorLocation), the rest behind it. `null`: not determinable.
function targetLocationUpfront(folder) {
  let p = path.resolve(folder);
  const rest = [];
  for (;;) {
    let fd = null;
    try { fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY); } catch (e) {
      if (e?.code !== "ENOENT") return null;
    }
    if (fd !== null) {
      try { const location = descriptorLocation(fd, p); return location ? path.join(location, ...rest) : null; } catch { return null; } finally { fs.closeSync(fd); }
    }
    const top = path.dirname(p);
    if (top === p) return null;
    rest.unshift(path.basename(p));
    p = top;
  }
}
const locationOf = (fd, filePath) => { try { return descriptorLocation(fd, filePath); } catch { return null; } };
const inItselfSelf = () => new Error(T("A folder cannot be copied into itself"));
const tooBig = () => withCode(T`Too large to copy: more than ${COPY_MAX_ENTRIES} entries or ${COPY_MAX_BYTES / 1048576} MB (cap) — copy in the terminal.`, "COPY_TOO_LARGE");

export async function copyEntry(projectPath, fromRel, toRel_, { limit } = {}) {
  const baseValue = path.resolve(projectPath);
  const from = resolveInside(projectPath, fromRel);
  const to = resolveInside(projectPath, toRel_);
  if (from === baseValue) throw new Error(T("The project folder itself cannot be copied"));
  if (to === baseValue) throw withCode(T("Target already exists"), "TARGET_EXISTS");
  if (to === from || to.startsWith(from + path.sep)) throw inItselfSelf();
  const ofArea = areaFor(limit, from);
  const afterArea = areaFor(limit, to);
  const name = path.basename(from);
  // The source via its opened parent folder (checked with the limit) — lstat, never its target; a folder is pinned (O_NOFOLLOW).
  const { st, startFd, reference } = inFolderInArea(path.dirname(from), ofArea, ({ at }) => {
    let s;
    try { s = fs.lstatSync(at(name)); } catch (e) { if (e?.code === "ENOENT") throw new Error(T("Source not found")); throw e; }
    if (s.isSymbolicLink()) return { st: s, startFd: null, reference: fs.readlinkSync(at(name)) };
    return { st: s, startFd: s.isDirectory() ? fs.openSync(at(name), OPEN_FOLDER) : null, reference: null };
  });
  // An existing target (also a link without a target) — nothing is overwritten. ONE place protects: creating the top entry is
  // O_EXCL or mkdir/symlink (EEXIST ⇒ TARGET_EXISTS), without a look beforehand (that would be a race).
  const top = async (q, prior = null) => {
    try { return await copyEntryValue(q, to, afterArea, prior); } catch (e) { if (e?.code === "EEXIST") throw withCode(T("Target already exists"), "TARGET_EXISTS"); throw e; }
  };
  if (!st.isDirectory()) {
    if (st.isFile() && st.size > COPY_MAX_BYTES) throw tooBig();
    const q = { kind: kindOf(st), reference: () => reference, open: () => inFolderInArea(path.dirname(from), ofArea, ({ at }) => fs.openSync(at(name), OPEN_SOURCE)) };
    const ok = await top(q);
    return { ok: true, path: toRel(projectPath, to), copied: ok ? 1 : 0, omitted: ok ? 0 : 1 };
  }
  try {
    // (1) No folder into itself — not even via a link in the target path (`link → src`, target `link/zz`): the REAL location of the
    //     target folder against the real location of the source, beforehand (without creating anything) and again at the opened
    //     target folder.
    const sourceLocation = locationOf(startFd, from);
    if (!sourceLocation) throw new Error(T("The location of the source cannot be determined"));
    const checkTarget = (location) => {
      if (!location) throw new Error(T("The location of the target cannot be determined"));
      if (location === sourceLocation || location.startsWith(sourceLocation + path.sep)) throw inItselfSelf();
    };
    checkTarget(targetLocationUpfront(path.dirname(to)));
    // (2) The plan BEFORE the first effect, read from the pinned folder (folders before their content): cap with notice (entries AND
    //     bytes). Then exactly the plan is copied — what only appears during copying is not included.
    const plan = [];
    let bytes = 0, full = false;
    const go = (fd, filePath, rel) => {
      let entries;
      try { entries = fs.readdirSync(nameInFolder(fd, filePath, ""), { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (full) return;
        const r = rel ? path.join(rel, e.name) : e.name;
        const kindName = kindOf(e);
        if (kindName === "file") { try { bytes += fs.lstatSync(nameInFolder(fd, filePath, e.name)).size; } catch { /* gone meanwhile */ } }
        plan.push({ rel: r, kind: kindName });
        if (plan.length + 1 > COPY_MAX_ENTRIES || bytes > COPY_MAX_BYTES) { full = true; return; }
        if (kindName !== "folder") continue;
        let kind;
        try { kind = fs.openSync(nameInFolder(fd, filePath, e.name), OPEN_FOLDER); } catch { continue; }
        try { go(kind, path.join(filePath, e.name), r); } finally { fs.closeSync(kind); }
      }
    };
    go(startFd, from, "");
    if (full) throw tooBig();
    // (3) The top folder — the real location once more at the opened target folder (a path part can change between pre-check and creation).
    let copied = 0, omitted = 0;
    await top({ kind: "folder" }, ({ fd, path: filePath }) => checkTarget(locationOf(fd, filePath)));
    copied++;
    // (4) The plan, entry by entry; the source via pinned folders under `startFd`.
    for (const { rel, kind } of plan) {
      const dir = path.dirname(rel) === "." ? "" : path.dirname(rel);
      const base = path.basename(rel);
      const q = {
        kind,
        open: () => inPlanFolder(startFd, from, dir, ({ at }) => fs.openSync(at(base), OPEN_SOURCE)),
        reference: () => inPlanFolder(startFd, from, dir, ({ at }) => fs.readlinkSync(at(base))),
      };
      if (await copyEntryValue(q, path.join(to, rel), afterArea)) copied++; else omitted++;
    }
    return { ok: true, path: toRel(projectPath, to), copied, omitted };
  } finally { fs.closeSync(startFd); }
}

// Delete (file or folder recursively). The project folder itself cannot be deleted.
export function deleteEntry(projectPath, rel, { limit } = {}) {
  const abs = resolveInside(projectPath, rel);
  if (abs === path.resolve(projectPath)) throw new Error(T("The project folder cannot be deleted"));
  // With a limit: a link is removed itself, a folder is emptied without leaving its tree — also on the workspace level for a path
  // in B (area null): the folder of a relocated project can lie below it.
  if (typeof limit === "function") {
    try { removeInArea(abs, areaFor(limit, abs)); } catch (e) {
      if (e?.code === "ENOENT") throw new Error(T("Not found"));
      throw e;
    }
    return { ok: true };
  }
  // `lstat`, not `existsSync`: a dead link is an entry; rmSync removes the link itself, never its target.
  try { fs.lstatSync(abs); } catch { throw new Error(T("Not found")); }
  fs.rmSync(abs, { recursive: true, force: true });
  return { ok: true };
}

// Capped full-text search over the project tree (binary/large files skipped). "Whole word" (`wholeWord`) and the filters
// `include`/`exclude` (globs like VS Code, comma-separated) go through the SAME pattern as the search in a copy
// (runtime/fileAccess.js `searchPattern`) — an excluded folder is not entered, an excluded file not counted. Like the program in
// the container: what is entered is decided by `searchArea` (switch `exclusions` = "use exclude settings and ignore files": the
// VS Code defaults and .gitignore/.ignore/.git/info/exclude), the matches of a file by `searchLines` (per line the columns of EVERY
// hit, a trailing `\r` is dropped); `open` (paths of unsaved buffers) comes back as `openMatches` — those inside the area. With a
// limit, B reads the ignore files without following links.
export function searchFiles(projectPath, { query, regex, caseSensitive, wholeWord, include, exclude, exclusions = true, open = [] } = {}, { limit } = {}) {
  const q = String(query || "");
  if (!q) return { results: [], count: 0, files: 0, truncated: false, openMatches: [] };
  const o = { query: q, regex: Boolean(regex), caseSensitive: Boolean(caseSensitive), wholeWord: Boolean(wholeWord), include, exclude, exclusions: exclusions !== false };
  const pattern = searchPattern(o);
  if (pattern.error) throw new Error(pattern.error);
  const base = path.resolve(projectPath);
  const areaW = areaFor(limit, base);
  const readText = (abs) => {
    let fd;
    try {
      if (typeof limit === "function") fd = openFileWithoutReference(abs, areaW);
      else { if (!fs.lstatSync(abs).isFile()) return null; fd = fs.openSync(abs, "r"); }
    } catch { return null; }
    try { const st = fs.fstatSync(fd); return st.isFile() && st.size <= SEARCH_MAX_FILE ? fs.readFileSync(fd, "utf8") : null; } catch { return null; } finally { fs.closeSync(fd); }
  };
  const area = searchArea(base, o, readText, (w, folder, file) => path.join(w, folder, file));
  const results = [];
  let matchCount = 0, filesWalked = 0, truncated = false;
  const checkRows = (abs, buf) => {
    if (buf.subarray(0, 8192).includes(0)) return; // binary
    const r = searchLines(buf.toString("utf8"), pattern, SEARCH_MAX_MATCHES - matchCount);
    if (r.rows.length) results.push({ path: toRel(projectPath, abs), matches: r.rows });
    matchCount += r.n;
    if (matchCount >= SEARCH_MAX_MATCHES) truncated = true;
  };
  const folderFrom = (abs) => { const rel = toRel(projectPath, abs); return area.folderFrom(rel) || pattern.folderFrom(rel); };
  const fileFrom = (abs) => { const rel = toRel(projectPath, abs); return area.fileFrom(rel) || !pattern.pathMatches(rel); };

  const walk = (dir) => {
    if (truncated) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (truncated) return;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (folderFrom(abs)) continue;
        walk(abs);
      } else if (e.isFile()) {
        if (fileFrom(abs)) continue;
        if (++filesWalked > SEARCH_MAX_FILES) { truncated = true; return; }
        let st;
        try { st = fs.statSync(abs); } catch { continue; }
        if (st.size > SEARCH_MAX_FILE) continue;
        let buf;
        try { buf = fs.readFileSync(abs); } catch { continue; }
        checkRows(abs, buf);
      }
    }
  };
  // With a limit: the same walk, but from pinned folders (O_NOFOLLOW) — a folder the project container replaces by a link between
  // listing and descending does not lead out.
  if (typeof limit === "function") {
    traverseWithoutReferences(base, areaW, (abs, e, { open }) => {
      if (truncated) return "hold";
      if (e.isDirectory()) return !folderFrom(abs);
      if (!e.isFile()) return false;
      if (fileFrom(abs)) return false;
      if (++filesWalked > SEARCH_MAX_FILES) { truncated = true; return "hold"; }
      let fd;
      try { fd = open(); } catch { return false; }
      try {
        const st = fs.fstatSync(fd);
        if (!st.isFile() || st.size > SEARCH_MAX_FILE) return false;
        checkRows(abs, fs.readFileSync(fd));
      } catch { /* unreadable */ } finally { fs.closeSync(fd); }
      return truncated ? "hold" : false;
    });
  } else walk(base);
  results.sort((a, b) => a.path.localeCompare(b.path));
  const openMatches = (Array.isArray(open) ? open : []).filter((rel) => typeof rel === "string" && area.inArea(rel, pattern));
  return { results, count: matchCount, files: results.length, truncated, openMatches };
}

const NAME_SEARCH_MAX_FILES = 20000;
// The safety cap of the ⌘P walk (`quickOpenFiles`): it sees at most this many files in the search area.
export const FAST_WALK_MAX = 200000;
// File/path search by NAME (for @-mentions in the chat): returns project-relative paths whose path contains the query as a
// substring (case-insensitive). Basename hits and flat paths first. HEAVY_DIRS (node_modules, .git, …) are skipped.
// With `{ limit }` (workspaces/routes.js on the workspace level): a folder to which the limit gives an area (a relocated project) is
// walked from there via traverseWithoutReferences (O_NOFOLLOW per folder) — a folder the project container replaces by a link
// between listing and descending does not lead to B. If the limit throws for a folder (lock, unreadable mapping), it is left out.
// Without a limit (and for folders without an area) the plain walk.
export function findFilesByName(projectPath, query, limit = 30, { limit: limitValue } = {}) {
  const base = path.resolve(projectPath);
  const q = String(query || "").toLowerCase();
  const out = [];
  let walked = 0, stop = false;
  const file = (abs) => {
    if (++walked > NAME_SEARCH_MAX_FILES) { stop = true; return; }
    const rel = toRel(projectPath, abs);
    if (!q || rel.toLowerCase().includes(q)) out.push(rel);
  };
  const walkInArea = (dir, area) => {
    traverseWithoutReferences(dir, area, (abs, e) => {
      if (stop) return "hold";
      if (e.isDirectory()) return !HEAVY_DIRS.has(e.name);
      if (e.isFile()) { file(abs); if (stop) return "hold"; }
      return false;
    });
  };
  const walk = (dir) => {
    if (stop) return;
    if (typeof limitValue === "function") {
      let area;
      try { area = limitValue(dir); } catch { return; }
      if (area) { try { walkInArea(dir, area); } catch { /* out of the area or unreadable: the folder is left out */ } return; }
    }
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (stop) return;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (HEAVY_DIRS.has(e.name)) continue;
        walk(abs);
      } else if (e.isFile()) {
        file(abs);
        if (stop) return;
      }
    }
  };
  walk(base);
  const rank = (rel) => {
    const bn = rel.split("/").pop().toLowerCase();
    let r = rel.split("/").length + rel.length / 200; // flatter/shorter = better
    if (q && bn.includes(q)) r -= 100;
    if (q && bn.startsWith(q)) r -= 50;
    return r;
  };
  out.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return { results: out.slice(0, limit), truncated: out.length > limit || stop };
}

// Quick Open (⌘P): the files ⌘P shows, in the order of VS Code — the area is that of the search (`searchArea` with the exclusions:
// VS Code's files.exclude/search.exclude and the ignore files; the name search of the @-mentions stays on HEAVY_DIRS,
// `findFilesByName`), filtered and sorted by runtime/fast-open.js (`fuzzyContains`, `compareItemsByFuzzyScore`), only then capped.
// With `{ limit }` as `findFilesByName`: a folder with an area is walked without links, its ignore files read without links.
//
// TWO CAPS, each with notice (a non-ignored `.venv` with more than 20,000 files before `src/` filled the cap BEFORE filtering —
// ⌘P did not find `app.ts`, and the list said "The first 512 …" and "No results" at once):
//   `maxHits` (NAME_SEARCH_MAX_FILES) counts only MATCHING files — the walk already filters with VS Code's pre-filter
//                (`fastPattern`/`fastMatches`: the first word, `fuzzyContains`); full ⇒ `truncated`.
//   `maxWalk`  (FAST_WALK_MAX) counts every file in the area — the safety cap of the walk; full ⇒ `aborted: true` and
//                `searched` (this many files it saw), the UI says so in its own wording.
export function quickOpenFiles(projectPath, query, limit = 512, { limit: limitValue, maxHits = NAME_SEARCH_MAX_FILES, maxWalk = FAST_WALK_MAX } = {}) {
  const base = path.resolve(projectPath);
  const readText = (abs) => {
    let fd;
    try {
      const b = typeof limitValue === "function" ? limitValue(path.dirname(abs)) : null;
      if (b) fd = openFileWithoutReference(abs, b);
      else { if (!fs.lstatSync(abs).isFile()) return null; fd = fs.openSync(abs, "r"); }
    } catch { return null; }
    try { const st = fs.fstatSync(fd); return st.isFile() && st.size <= SEARCH_MAX_FILE ? fs.readFileSync(fd, "utf8") : null; } catch { return null; } finally { fs.closeSync(fd); }
  };
  const pattern = fastPattern(String(query ?? ""));
  if (!pattern) return { results: [], truncated: false };
  const area = searchArea(base, { exclusions: true }, readText, (w, folder, file) => path.join(w, folder, file));
  const files = [];
  let seen = 0, stop = false, aborted = false;
  const file = (abs) => {
    const rel = toRel(projectPath, abs);
    if (area.fileFrom(rel)) return;
    if (++seen > maxWalk) { stop = aborted = true; return; }
    if (!fastMatches(rel, pattern)) return;
    if (files.length >= maxHits) { stop = true; return; }
    files.push(rel);
  };
  const folderFrom = (abs) => area.folderFrom(toRel(projectPath, abs));
  const walkInArea = (dir, b) => {
    traverseWithoutReferences(dir, b, (abs, e) => {
      if (stop) return "hold";
      if (e.isDirectory()) return !folderFrom(abs);
      if (e.isFile()) { file(abs); if (stop) return "hold"; }
      return false;
    });
  };
  const walk = (dir) => {
    if (stop) return;
    if (typeof limitValue === "function") {
      let b;
      try { b = limitValue(dir); } catch { return; }
      if (b) { try { walkInArea(dir, b); } catch { /* out of the area or unreadable: the folder is left out */ } return; }
    }
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (stop) return;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { if (!folderFrom(abs)) walk(abs); }
      else if (e.isFile()) { file(abs); if (stop) return; }
    }
  };
  walk(base);
  const r = fastOpen(files, String(query ?? ""), limit);
  return { results: r.results, truncated: r.truncated || stop, ...(aborted ? { aborted: true, searched: maxWalk } : {}) };
}

// The rules files-in-copy.js (the same paths in a copy's container) shares with this module — one version, no second.
export { MAX_READ, NAME_SEARCH_MAX_FILES, SEARCH_MAX_FILE, SEARCH_MAX_FILES, SEARCH_MAX_MATCHES, resolveInside, toRel };
