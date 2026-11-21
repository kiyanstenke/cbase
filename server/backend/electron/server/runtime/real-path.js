// The REAL location of a path. A leaf with node:* only.
//
// WHY. The loop engine's file tools (providers/tool-runtime.js) and the channel files (channels/messages.js) run in the
// BACKEND, i.e. in B — also for a converted project whose Bash runs in the project container. A symlink the agent creates
// there (`ln -s /home/agent/workspace/neighbour/.env secret`) points nowhere in the container (the neighbour is not mounted),
// but in B to the real file of the neighbouring project. `path.resolve` does not see that: by its wording the path lies in
// the project. So what is checked is the place where the file system really ends up.
//
// realPath(p)              `realpath` of the DEEPEST EXISTING ancestor, followed by the rest (which does not exist yet — a
//                            new file, a new folder of a write). A symlink without a target (lstat yes, realpath ENOENT) is
//                            resolved as if its target existed: a write through it would create the file THERE. More than
//                            40 hops ⇒ ELOOP (like the operating system). Other errors (EACCES, ELOOP) are thrown.
// realRoot(w, anchor)      THE LOCATION OF A ROOT. Taking the `realpath` of a root is wrong as soon as the project container
// realRoots(ws, anchor)    can replace it: the output folder `outputs/<chat>`, the attachment folder `attachments/<chat>`
//                            and graph worktrees are ordinary subfolders of the rw-mounted runtime folder, NOT mount points —
//                            a symlink in their place (`outputs/c1 → /`) would make "/" the root and B's whole file system
//                            readable and writable. Only a TRUSTED ANCHOR (project folder, runtime folder
//                            `<data>/projects/<pid>` — both mount points, the container cannot replace them) is determined
//                            by realpath; a root below it counts as `realpath(anchor) + relative(anchor, root)` and DOES
//                            NOT COUNT if one of its path parts between anchor and root (itself included) is a symlink by
//                            lstat. A root under no anchor lies outside every rw mount in B — there the plain realpath
//                            applies. Without anchors `realRoot` is exactly the plain path.
// realLocation(p, ws, {anchor, area})  `{ inside, real }` — does the real location of `p` lie in (or equal) the real location
//                            of a root? A root whose location cannot be determined does not count; a path whose location
//                            cannot be determined lies nowhere inside (`real: null`). `area`: an already determined area.
//
// STRICT AND LOCKED (for a COPY, runs/runtime-limit.js areaInB). In a copy the project folder exists only in its container; B
// sees the MAIN instance under the same path. A path that by its wording does not lie under the project folder (a symlink in
// the rw-mounted runtime folder, `/proc/self/root<P>/…`) still resolves in B — and its real location would be the main
// instance if the project folder entered the area as a root without an anchor via realpath. Hence:
//   realRoot(w, anchor, { strict })   a root under no anchor does NOT count (instead of its realpath in B).
//   withLocks(realW, lock)            real locations under which nothing lies in the area (the realpath of the copy's project
//                                     folder), except via a root that itself lies deeper than the lock. `inArea`, and with
//                                     it every check of this leaf (also on the opened descriptor), respects them.
//
// VIA THE DESCRIPTOR. Checking and then accessing via the PATH leaves a window: between the two the project container can
// replace a path part with a symlink. With an instance, readers and writers therefore open first, check the location of the
// OPENED object and then access through the descriptor:
//   descriptorLocation(fd, path)    Linux (B): `readlink /proc/self/fd/<fd>`. Without /proc (macOS — no ops marker there, only
//                                   tests) the real location of the path, but only if it is THE SAME object as the descriptor
//                                   (dev+ino), otherwise `null`. Test seam `setDescriptorSeam(fn)`: replaces both, and the
//                                   traversal then goes via the path.
//   readInArea(p, realW, enc)       open (O_NONBLOCK: a FIFO does not stall B), check, regular files only, read. With
//                                   `{ maxBytes }` it throws `ETOOLARGE` before reading if the file is larger
//                                   (`readDescriptor` — at most maxBytes + 1 bytes are read).
//   readBeginningInArea(p, realW, n)  the same open, but only the BEGINNING: `{ data, truncated }` with at most n bytes
//                                   (`readBeginning(fd, n)`) — for readers that truncate anyway (project memory).
//   editInArea(p, realW, fn)        the same with O_RDWR, `fn(text)` → new text, written through the descriptor.
//   writeInArea(p, data, realW)     open and check the deepest existing ancestor, create missing folders AFTERWARDS and inside
//                                   it (Linux: `/proc/self/fd/<fd>/<name>` — the checked folder is pinned; every new part
//                                   O_NOFOLLOW), create the file with O_CREAT|O_EXCL (never follows a symlink) or open the
//                                   existing one, check the file's location, only then truncate and write. A symlink without
//                                   a target becomes its target, and the same check applies there.
//   statInArea / entriesInArea      stat or directory listing of a checked descriptor (Glob, Grep).
// A location outside throws an error with `code: "EOUTSIDE"`.
//
// FOR THE CODE VIEW (files.js). Its file routes run in B; a symlink the project container creates (`note →
// /home/agent/.bashrc`, a folder symlink into the data directory) would let them read, write, rename and delete outside.
// For that, each via an OPENED, checked folder (`realW` = null means: only pinned, without an area check — the workspace
// level for paths that belong to no converted project):
//   writeInArea(…, { append })      appends instead of truncating (chunked upload).
//   writeInArea(…, { offset })      the contract of a chunk with an operation: `0` replaces (create, or truncate to 0 on the
//                                   DESCRIPTOR), `> 0` appends only if it equals the size at the opened descriptor (fstat
//                                   after opening) — otherwise it throws `code: "OFFSET"` with `size`, and the file stays
//                                   unchanged (one just created is removed again). `offset` beats `append`.
//   inFolderInArea(folder, realW, fn, { create })  `fn({ fd, path, at })` with the opened folder (`at(name)` = the name in
//                                   it, on Linux via the descriptor); `create` creates missing parts like writeInArea.
//   folderContentInArea(folder, realW)  entries with lstat; for a symlink the stat of its target only inside the area,
//                                   otherwise `hinaus` (the target is never stat-ed).
//   createFileInArea / createFolderInArea   create anew (O_EXCL — follows no symlink) or mkdir -p inside the area.
//   renameInArea(from, to, realOf, realAfter)  rename between two opened parent folders: a symlink itself is renamed, never
//                                   its target. ENOENT = source missing, EEXIST = target exists.
//   removeInArea(path, realW)       a symlink itself is removed; a folder is emptied via pinned descriptors (every subfolder
//                                   O_NOFOLLOW — whatever becomes a symlink on the way is removed as a symlink).
//   traverseWithoutReferences(start, realW, visit)  the search walk: every subfolder and file O_NOFOLLOW from the pinned
//                                   parent folder — it never leaves the start folder.
//
// FOR THE SERVICE FILES. Service log, pgid and exit file live in the rw-mounted runtime folder; B reads and writes them:
//   openFileWithoutReference(p, realW, { flags, create })  the parent folder checked (with `create` created as above), the
//                                   file in it O_NOFOLLOW|O_NONBLOCK — NO symlink, not even one inside the area; a regular
//                                   file only.
//   The same function reads `.git/config` of a repo a project container can write (git.js isProjectRepo, anchor: the search
//   folder) and the pgid file of a start in the project container (runtime/inProject.js readPgid, anchor: the runtime folder)
//   — a FIFO there would stall B, a symlink would read a file of B.
//
// FOR B'S OWN WRITERS IN THE RUNTIME FOLDER. Whatever B itself creates, writes, copies, renames or deletes there (output
// files, configurations, profiles, attachments, captures, sessions) goes through runs/runtime-write.js — and that through
// openFileWithoutReference, createFolderInArea, inFolderInArea, renameInArea, removeInArea and traverseWithoutReferences here,
// anchored at the runtime folder. Guards: server/backend/test/runtime-write.test.js, runtime-write-guard.test.js.
//
// ONLY WITH AN INSTANCE: callers ask here only for a converted project. Without an instance the literal check stays.
// Guards: server/backend/test/tool-runtime.test.js, channel.test.js, engine-in-project.test.js, projectbox-services.test.js,
// projectbox-git.test.js, inProject.test.js; strict and locked: tool-runtime-copy.test.js, channel-copy.test.js,
// memory-copy.test.js.
import fs from "node:fs";
import path from "node:path";

const MAX_JUMPS = 40;
const O = fs.constants;

export function realPath(p) {
  let current = path.resolve(String(p));
  const rest = [];
  let jumps = 0;
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(current), ...rest);
    } catch (e) {
      if (e?.code !== "ENOENT" && e?.code !== "ENOTDIR") throw e;
    }
    let st = null;
    try { st = fs.lstatSync(current); } catch { /* does not exist */ }
    if (st?.isSymbolicLink()) {
      // A symlink whose target is (still) missing: its target is where a write operation would land.
      if (++jumps > MAX_JUMPS) throw Object.assign(new Error(`too many symlinks: ${p}`), { code: "ELOOP" });
      current = path.resolve(path.dirname(current), fs.readlinkSync(current));
      continue;
    }
    const top = path.dirname(current);
    if (top === current) return path.join(current, ...rest); // the file system root — always exists
    rest.unshift(path.basename(current));
    current = top;
  }
}

const attempts = (p) => { try { return realPath(p); } catch { return null; } };
const under = (p, r) => p === r || p.startsWith(r.endsWith(path.sep) ? r : r + path.sep);

/** The real location of a root — via the deepest trusted anchor that contains it by wording; `null` = does not count.
 *  `strict`: a root under NO anchor does not count (instead of its realpath — see the header, "STRICT AND LOCKED"). */
export function realRoot(root, anchor = [], { strict = false } = {}) {
  const w = path.resolve(String(root));
  let a = null;
  for (const x of anchor || []) {
    if (!x) continue;
    const r = path.resolve(String(x));
    if (under(w, r) && (!a || r.length > a.length)) a = r;
  }
  if (!a) return strict ? null : attempts(w);
  const aReal = attempts(a);
  if (!aReal) return null;
  const rel = path.relative(a, w);
  if (!rel) return aReal;
  let part = a;
  for (const name of rel.split(path.sep)) {
    part = path.join(part, name);
    let st;
    try { st = fs.lstatSync(part); } catch (e) {
      if (e?.code === "ENOENT") break; // the rest does not exist yet — what appears there is checked on access
      return null;
    }
    if (st.isSymbolicLink()) return null;
  }
  return path.join(aReal, rel);
}

export const realRoots = (roots, anchor = [], opts = {}) =>
  [...new Set((roots || []).filter(Boolean).map((w) => realRoot(w, anchor, opts)).filter(Boolean))];

/** An area with LOCKS (see the header): the real roots, plus real locations under which nothing lies in the area — except via
 *  a root that itself lies DEEPER than the lock (the deeper location wins, as in runtime/fileAccess.js). Frozen: whoever copies
 *  the area (`[...b]`, `filter`) would silently lose the locks — so pass it unchanged to the functions of this leaf. */
export function withLocks(realW, lock) {
  const b = [...(realW || [])];
  Object.defineProperty(b, "lock", { value: Object.freeze([...new Set((lock || []).filter((s) => typeof s === "string" && s))]) });
  return Object.freeze(b);
}
const locked = (real, r, lock) => lock.some((s) => under(real, s) && !(r !== s && under(r, s)));

/** Does a real location (string) lie in one of the real roots (and under no lock of the area, see withLocks)? */
export const inArea = (real, realW) => typeof real === "string" && Boolean(real) &&
  (realW || []).some((r) => under(real, r) && !locked(real, r, realW?.lock || []));

/** `area`: an already determined area (e.g. with locks, runs/runtime-limit.js areaInB) instead of `realRoots(roots, anchor)`. */
export function realLocation(p, roots, { anchor = [], area = null } = {}) {
  const real = attempts(p);
  if (!real) return { inside: false, real: null };
  return { inside: inArea(real, area || realRoots(roots, anchor)), real };
}

// ── Via the descriptor ────────────────────────────────────────────────────────────────────────────────────────────

const PROC_FD = "/proc/self/fd";
let seam = null;
let procExists = null;
/** Test seam: `(fd, path) => real location` instead of `/proc/self/fd` (on a system without /proc). `null` takes it back. */
export function setDescriptorSeam(fn) { seam = typeof fn === "function" ? fn : null; }
const withProc = () => !seam && (procExists ??= fs.existsSync(PROC_FD));

/** The real location of the object behind `fd` (opened under `filePath`) — `null` if it cannot be determined. */
export function descriptorLocation(fd, filePath) {
  if (seam) return seam(fd, filePath);
  if (withProc()) return fs.readlinkSync(`${PROC_FD}/${fd}`);
  const a = fs.fstatSync(fd);
  const real = realPath(filePath);
  let b;
  try { b = fs.statSync(real); } catch { return null; }
  return a.dev === b.dev && a.ino === b.ino ? real : null;
}
/** A name IN the opened folder `fd` (Linux: via the pinned descriptor, otherwise via the path). */
const inFolder = (fd, filePath, name) => (withProc() ? `${PROC_FD}/${fd}/${name}` : path.join(filePath, name));
/** The same for a walk that pins its folders itself (stacks: hard links from an opened folder). */
export const nameInFolder = inFolder;

function hinaus(display, real, addition = "") {
  const p = path.resolve(String(display));
  const e = new Error(real && real !== p
    ? `Path leads out of the allowed area: ${p} → ${real} (symlink)`
    : `Path outside the allowed area: ${p}${addition}`);
  e.code = "EOUTSIDE";
  return e;
}
const loop = (display) => hinaus(display, null, " (Symlink-Loop)");

function checkFd(fd, filePath, realW, display = filePath) {
  let real = null;
  try { real = descriptorLocation(fd, filePath); } catch { real = null; }
  if (!inArea(real, realW)) throw hinaus(display, real);
  return real;
}

function open(filePath, flags, display) {
  try { return fs.openSync(filePath, flags); } catch (e) {
    if (e?.code === "ELOOP") throw loop(display);
    throw e;
  }
}

/** Open and check the location of the opened object → fd (the caller closes it). */
export function openInArea(filePath, realW, flags = O.O_RDONLY | O.O_NONBLOCK) {
  const fd = open(filePath, flags, filePath);
  try { checkFd(fd, filePath, realW); return fd; } catch (e) { fs.closeSync(fd); throw e; }
}

function onlyFile(fd, filePath) {
  if (!fs.fstatSync(fd).isFile()) throw Object.assign(new Error(`Not a regular file: ${filePath}`), { code: "ENOFILE" });
}

function writeEverything(fd, buf, fromIdx = 0) {
  let n = 0;
  while (n < buf.length) n += fs.writeSync(fd, buf, n, buf.length - n, fromIdx + n);
}

// A reader's cap: with `maxBytes` set, a file larger at the descriptor throws `ETOOLARGE` (with `size`) BEFORE reading; at
// most `maxBytes + 1` bytes are read — a file that grows after the fstat (the container keeps writing) throws as well instead
// of making B read to its end. Without `maxBytes` it reads like `readFileSync(fd, encoding)`.
export function tooBig(filePath, size, maxBytes) {
  return Object.assign(new Error(`File too large (${size} bytes, limit ${maxBytes}): ${filePath}`), { code: "ETOOLARGE", size, limit: maxBytes });
}
export function readDescriptor(fd, encoding, { maxBytes = null, display = "" } = {}) {
  if (maxBytes === null || maxBytes === undefined) return fs.readFileSync(fd, encoding);
  const max = Math.max(0, Math.floor(Number(maxBytes)));
  const size = fs.fstatSync(fd).size;
  if (size > max) throw tooBig(display, size, max);
  const buf = Buffer.allocUnsafe(max + 1);
  let n = 0;
  while (n < buf.length) {
    const r = fs.readSync(fd, buf, n, buf.length - n, n);
    if (!r) break;
    n += r;
  }
  if (n > max) throw tooBig(display, n, max);
  const data = buf.subarray(0, n);
  return encoding ? data.toString(encoding) : Buffer.from(data);
}

export function readInArea(filePath, realW, encoding, { maxBytes = null } = {}) {
  const fd = openInArea(filePath, realW);
  try {
    onlyFile(fd, filePath);
    return readDescriptor(fd, encoding, { maxBytes, display: filePath });
  } finally { fs.closeSync(fd); }
}

// The BEGINNING of a file: whoever needs only a part anyway (the project memory in the system prompt, truncated to 40,000
// characters) reads at most `maxBytes` bytes instead of the whole file — a sparse 1.9 GB CLAUDE.md then costs the same as a
// small one, and a large one stays truncated in the prompt instead of missing (as in the copy, runtime/fileAccess.js
// readSeveral). → `{ data, truncated }`: `data` the first at most `maxBytes` bytes, `truncated` true if more followed (for
// that exactly one more byte is read).
export function readBeginning(fd, maxBytes) {
  const max = Math.max(0, Math.floor(Number(maxBytes)));
  const buf = Buffer.allocUnsafe(max + 1);
  let n = 0;
  while (n < buf.length) {
    const r = fs.readSync(fd, buf, n, buf.length - n, n);
    if (!r) break;
    n += r;
  }
  return { data: Buffer.from(buf.subarray(0, Math.min(n, max))), truncated: n > max };
}
export function readBeginningInArea(filePath, realW, maxBytes) {
  const fd = openInArea(filePath, realW);
  try {
    onlyFile(fd, filePath);
    return readBeginning(fd, maxBytes);
  } finally { fs.closeSync(fd); }
}

/** Stat of a checked object (file or folder). */
export function statInArea(filePath, realW) {
  const fd = openInArea(filePath, realW);
  try { return fs.fstatSync(fd); } finally { fs.closeSync(fd); }
}

/** The entries of a checked folder (`withFileTypes`). */
export function entriesInArea(folder, realW) {
  const fd = openInArea(folder, realW, O.O_RDONLY | O.O_DIRECTORY);
  try { return fs.readdirSync(inFolder(fd, folder, ""), { withFileTypes: true }); } finally { fs.closeSync(fd); }
}

/** Read, modify, write back — all through ONE checked descriptor. `fn(text)` → new text. */
export function editInArea(filePath, realW, fn) {
  const fd = openInArea(filePath, realW, O.O_RDWR | O.O_NONBLOCK);
  try {
    onlyFile(fd, filePath);
    const fresh = Buffer.from(String(fn(fs.readFileSync(fd, "utf8"))));
    fs.ftruncateSync(fd, 0);
    writeEverything(fd, fresh);
  } finally { fs.closeSync(fd); }
}

// The deepest existing ancestor of `folder`, opened and checked; the missing parts are created only AFTERWARDS, each
// O_NOFOLLOW. What is checked is whether the ancestor itself — or, if it lies above a root, the location that arises with the
// missing parts — lies in the area (a root that does not exist yet is created this way); at the end the finished folder once
// more. → { fd, path } (the caller closes fd).
function createFolder(folder, realW, display) {
  const missing = [];
  let base = path.resolve(folder);
  let fd;
  for (;;) {
    try { fd = fs.openSync(base, O.O_RDONLY | O.O_DIRECTORY); break; } catch (e) {
      if (e?.code === "ELOOP") throw loop(display);
      if (e?.code !== "ENOENT") throw e;
      const top = path.dirname(base);
      if (top === base) throw e;
      missing.unshift(path.basename(base));
      base = top;
    }
  }
  let real = null;
  try { real = descriptorLocation(fd, base); } catch { real = null; }
  if (!inArea(real, realW) && !(missing.length && real && inArea(path.join(real, ...missing), realW))) {
    fs.closeSync(fd);
    throw hinaus(display, real);
  }
  let filePath = base;
  for (const name of missing) {
    const at = inFolder(fd, filePath, name);
    let fresh;
    try {
      try { fs.mkdirSync(at); } catch (e) { if (e?.code !== "EEXIST") throw e; }
      // A part that is (by now) a symlink is not entered — not even a symlink without a target.
      try { fresh = fs.openSync(at, O.O_RDONLY | O.O_DIRECTORY | O.O_NOFOLLOW); } catch (e) {
        if (e?.code === "ELOOP" || e?.code === "ENOTDIR") throw hinaus(display, attempts(path.join(filePath, name)));
        throw e;
      }
    } catch (e) { fs.closeSync(fd); throw e; }
    fs.closeSync(fd);
    fd = fresh;
    filePath = path.join(filePath, name);
  }
  // The finished folder (without /proc, `at` went via the path — a part that became a symlink in between shows up here).
  if (missing.length) { try { checkFd(fd, filePath, realW, display); } catch (e) { fs.closeSync(fd); throw e; } }
  return { fd, path: filePath };
}

/** Write a file (create or replace) without ever creating or truncating anything outside the real roots. */
export function writeInArea(filePath, data, realW, { display = filePath, jumps = 0, append = false, offset = null } = {}) {
  const abs = path.resolve(String(filePath));
  const { fd: ofd, path: opath } = createFolder(path.dirname(abs), realW, display);
  const name = path.basename(abs);
  const at = inFolder(ofd, opath, name);
  let fd = null;
  let created = false;
  let folderOpen = true;
  try {
    try { fd = fs.openSync(at, O.O_WRONLY | O.O_CREAT | O.O_EXCL | O.O_NONBLOCK, 0o666); created = true; } catch (e) {
      if (e?.code !== "EEXIST") throw e;
      if (fs.lstatSync(at).isSymbolicLink()) {
        try { fd = fs.openSync(at, O.O_WRONLY | O.O_NONBLOCK); } catch (e2) {
          if (e2?.code === "ELOOP") throw loop(display);
          if (e2?.code !== "ENOENT") throw e2;
          // A symlink without a target: a write would create the file at its target — the same check applies there.
          if (jumps >= MAX_JUMPS) throw loop(display);
          const target = path.resolve(opath, fs.readlinkSync(at));
          fs.closeSync(ofd);
          folderOpen = false;
          return writeInArea(target, data, realW, { display, jumps: jumps + 1, append, offset });
        }
      } else fd = open(at, O.O_WRONLY | O.O_NOFOLLOW | O.O_NONBLOCK, display);
    }
    onlyFile(fd, abs);
    try { checkFd(fd, path.join(opath, name), realW, display); } catch (e) {
      if (created) { try { fs.unlinkSync(at); } catch { /* already gone */ } }
      throw e;
    }
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
    if (offset !== null && offset !== undefined) {
      // A chunk with an operation (see the header). The size at the OPENED descriptor is what is compared — never the path's.
      const size = fs.fstatSync(fd).size;
      if (offset > 0 && offset !== size) {
        if (created) { try { fs.unlinkSync(at); } catch { /* already gone */ } }
        throw Object.assign(new Error(`${display}: offset ${offset} does not match the size ${size}`), { code: "OFFSET", size });
      }
      if (offset === 0) { fs.ftruncateSync(fd, 0); writeEverything(fd, buf); } else writeEverything(fd, buf, size);
    } else if (append) writeEverything(fd, buf, fs.fstatSync(fd).size);
    else {
      fs.ftruncateSync(fd, 0);
      writeEverything(fd, buf);
    }
  } finally {
    if (fd !== null) fs.closeSync(fd);
    if (folderOpen) fs.closeSync(ofd);
  }
}

// ── For the code view (see the header) ────────────────────────────────────────────────────────────────────────────

/** Open the folder (and check it, if `realW`), call `fn({ fd, path, at })` with it, then close. */
export function inFolderInArea(folder, realW, fn, { create = false } = {}) {
  const abs = path.resolve(String(folder));
  let fd;
  let filePath = abs;
  if (create && realW) ({ fd, path: filePath } = createFolder(abs, realW, abs));
  else {
    if (create) fs.mkdirSync(abs, { recursive: true });
    fd = realW ? openInArea(abs, realW, O.O_RDONLY | O.O_DIRECTORY) : open(abs, O.O_RDONLY | O.O_DIRECTORY, abs);
  }
  try { return fn({ fd, path: filePath, at: (name) => inFolder(fd, filePath, name) }); } finally { fs.closeSync(fd); }
}

const lstatOrNull = (p) => { try { return fs.lstatSync(p); } catch (e) { if (e?.code === "ENOENT") return null; throw e; } };
const withCode = (text, code) => Object.assign(new Error(text), { code });

/** Entries of a checked folder: `{ name, st }` (lstat via the pinned folder), for a symlink also `target` (stat of the target,
 *  only if it lies in the area) or `hinaus: true`. An entry without lstat has `st: null`. `realW` is required here (without
 *  an area every target would be "outside"). */
export function folderContentInArea(folder, realW) {
  return inFolderInArea(folder, realW, ({ at }) => fs.readdirSync(at("")).map((name) => {
    let st;
    try { st = fs.lstatSync(at(name)); } catch { return { name, st: null }; }
    if (!st.isSymbolicLink()) return { name, st };
    // The listing is a mere look: a target that already lies outside by its path is not opened at all; one inside goes
    // through the checked descriptor (the symlink can change between the two).
    if (!inArea(attempts(at(name)), realW)) return { name, st, target: null, hinaus: true };
    try { return { name, st, target: statInArea(at(name), realW) }; } catch (e) {
      return { name, st, target: null, hinaus: e?.code === "EOUTSIDE" };
    }
  }));
}

/** Create a NEW file (O_EXCL: EEXIST if the name exists — also as a symlink); missing folders inside the area. */
export function createFileInArea(filePath, realW) {
  const abs = path.resolve(String(filePath));
  inFolderInArea(path.dirname(abs), realW, ({ at }) => {
    fs.closeSync(fs.openSync(at(path.basename(abs)), O.O_WRONLY | O.O_CREAT | O.O_EXCL | O.O_NONBLOCK, 0o666));
  }, { create: true });
}

/** mkdir -p inside the area: an existing part must lie in the area (after symlinks), new parts are created O_NOFOLLOW. */
export function createFolderInArea(folder, realW) {
  inFolderInArea(folder, realW, () => {}, { create: true });
}

/** Rename/move via the opened parent folders (the target's is created if needed). */
export function renameInArea(from, to, realOf, realAfter) {
  const a = path.resolve(String(from));
  const b = path.resolve(String(to));
  inFolderInArea(path.dirname(a), realOf, (q) => {
    const source = q.at(path.basename(a));
    if (!lstatOrNull(source)) throw withCode(`Source not found: ${a}`, "ENOENT");
    inFolderInArea(path.dirname(b), realAfter, (z) => {
      const target = z.at(path.basename(b));
      if (lstatOrNull(target)) throw withCode(`Target already exists: ${b}`, "EEXIST");
      fs.renameSync(source, target);
    }, { create: true });
  });
}

// Remove an entry (addressed via its parent folder) without ever following a symlink.
function removeEntry(at, display) {
  const st = fs.lstatSync(at);
  if (!st.isDirectory()) { fs.unlinkSync(at); return; }
  let fd;
  try { fd = fs.openSync(at, O.O_RDONLY | O.O_DIRECTORY | O.O_NOFOLLOW); } catch (e) {
    if (e?.code === "ELOOP" || e?.code === "ENOTDIR") { fs.unlinkSync(at); return; } // by now a symlink or a file
    throw e;
  }
  try {
    for (const name of fs.readdirSync(inFolder(fd, display, ""))) {
      try { removeEntry(inFolder(fd, display, name), path.join(display, name)); } catch (e) { if (e?.code !== "ENOENT") throw e; }
    }
  } finally { fs.closeSync(fd); }
  fs.rmdirSync(at);
}

/** Delete (file, symlink or folder with its content) — ENOENT if the entry does not exist. */
export function removeInArea(filePath, realW) {
  const abs = path.resolve(String(filePath));
  inFolderInArea(path.dirname(abs), realW, ({ at, path: o }) => removeEntry(at(path.basename(abs)), path.join(o, path.basename(abs))));
}

/** The walk over a tree that never leaves the start folder: `visit(abs, dirent, { open })` per entry — `true` for a folder
 *  descends (O_NOFOLLOW from the pinned parent folder), `open()` opens a file O_NOFOLLOW|O_NONBLOCK (→ fd, the caller closes
 *  it). Symlinks are neither folder nor file (Dirent) and are never entered. `visit` returns `"hold"` to end the walk. The
 *  start folder is checked if `realW` is set. */
export function traverseWithoutReferences(start, realW, visit) {
  let hold = false;
  const walk = (fd, folder) => {
    let entries;
    try { entries = fs.readdirSync(inFolder(fd, folder, ""), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (hold) return;
      const abs = path.join(folder, e.name);
      const at = inFolder(fd, folder, e.name);
      const r = visit(abs, e, { open: () => fs.openSync(at, O.O_RDONLY | O.O_NOFOLLOW | O.O_NONBLOCK) });
      if (r === "hold") { hold = true; return; }
      if (r === true && e.isDirectory()) {
        let kind;
        try { kind = fs.openSync(at, O.O_RDONLY | O.O_DIRECTORY | O.O_NOFOLLOW); } catch { continue; }
        try { walk(kind, abs); } finally { fs.closeSync(kind); }
      }
    }
  };
  inFolderInArea(start, realW, ({ fd, path: filePath }) => walk(fd, filePath));
}

// ── A file without any symlink ───────────────────────────────────────────────────────────────────────────────────────

/** Open a file whose LAST part must not be a symlink — not even one that would stay inside the area: the parent folder is
 *  opened and checked (with `create` missing parts as in writeInArea, each O_NOFOLLOW), the file IN it with
 *  `flags` | O_NOFOLLOW | O_NONBLOCK (with `create` also O_CREAT; O_TRUNC is never set on open — truncate only after the
 *  check, through the descriptor). A symlink throws `EOUTSIDE`, anything but a regular file `ENOFILE` (a FIFO does not stall
 *  B, a device is not written). → fd (the caller closes it). For the files B reads and writes in the runtime folder of a
 *  converted project (services.js: service log, pgid and exit file of the wrapper). */
export function openFileWithoutReference(filePath, realW, { flags = O.O_RDONLY, create = false } = {}) {
  const abs = path.resolve(String(filePath));
  const name = path.basename(abs);
  let ofd;
  let opath = path.dirname(abs);
  if (create) ({ fd: ofd, path: opath } = createFolder(opath, realW, abs));
  else ofd = openInArea(opath, realW, O.O_RDONLY | O.O_DIRECTORY);
  try {
    let fd;
    try { fd = fs.openSync(inFolder(ofd, opath, name), (flags & ~O.O_TRUNC) | O.O_NOFOLLOW | O.O_NONBLOCK | (create ? O.O_CREAT : 0), 0o666); } catch (e) {
      if (e?.code === "ELOOP" || e?.code === "EMLINK") throw Object.assign(new Error(`A symlink instead of a file: ${abs}`), { code: "EOUTSIDE" });
      throw e;
    }
    try {
      onlyFile(fd, abs);
      checkFd(fd, path.join(opath, name), realW, abs);
    } catch (e) { fs.closeSync(fd); throw e; }
    return fd;
  } finally { fs.closeSync(ofd); }
}
