// The objects and the location of a copy in the user container. The ONE place where the user container writes below
// the layer and objects folders of a copy (otherwise only stacks/clearAway.js) — and only BEFORE the first mount. The
// paths come from location.js; no literal of the copy is here.
//
// createCopyLocation(location)
//   creates `<data>/copies/<pid>/<name>` with its open folder (0700; the copy later mounts the root under /cbase-copy).
//   No stage may be a symlink. If the root already exists, it THROWS (`COPY_LOCATION_EXISTS`) and creates nothing: a
//   leftover of an earlier copy does not belong to this build, its dismantling does not touch it.
// linkObjects({ source, target, repo, anchor })
//   `<repo>/.git/objects` (source) file by file via `fs.link` into the objects folder of the part (target) — a LOWER
//   layer: a write access of the copy copies up, the inode of the main instance stays untouched. Rules:
//     - only regular files and folders (lstat); a symlink, a device, a FIFO, a socket ⇒ error with the repo name
//       (`COPY_OBJECT_KIND`) — `cp -a` would put the symlink into the layer, and it would point anywhere in the copy;
//     - without `info/alternates` and `info/http-alternates` (reported: `alternates`), without `tmp_*` (on every level)
//       and `incoming-*` (quarantine of a running receive), without `*.lock` (a git that was writing at the freeze) —
//       everything skipped is in `skipped`; `*.promisor` is linked and reported (`promisor`, a partial clone);
//     - `EPERM` on link (a root-owned object under `protected_hardlinks`) ⇒ copy this file and count it (`copied`);
//       `EXDEV` ⇒ error (`COPY_OBJECT_EXDEV`: project folder and data folder are not on one file system);
//     - cap: at most `CBASE_COPY_OBJECTS_CAP` entries per repo (default OBJECTS_CAP), otherwise an error with a
//       message (`COPY_CAP`) instead of a truncated objects folder; EVERY entry read counts (also skipped ones), and
//       BEFORE the next one: a folder is read entry by entry via `opendir`, never loaded and sorted as a whole; at most
//       OBJECTS_DEPTH levels (one open descriptor per level), otherwise `COPY_CAP`; `skipped` is sorted;
//     - no git process, no reading of a repo configuration; after every YIELD_EVERY entries the walk yields to the
//       event loop;
//     - `anchor` (the project folder, a mount point): if a path part between it and `source` leads over a symlink,
//       nothing is linked; every folder is opened pinned (O_NOFOLLOW), entries are addressed through it
//       (runtime/real-path.js).
//   → { files, folder, copied, skipped: [rel], alternates, promisor }
// prepareLayer({ layer, shallow, anchor })
//   In the upper layer of a repo: `.git` and the empty mount point `.git/objects` (for the object overlay),
//   `user.overlay.opaque=y` on `.git` (the copy does NOT see the `.git` of the main instance, it gets its own — `git
//   init` over the linked objects), and the main instance's `shallow` file as `.git/shallow` (a copy, not a link: it
//   is in an upper layer, where no file shares an inode with the main instance) — at most `CBASE_COPY_SHALLOW_CAP`
//   bytes (default SHALLOW_CAP), checked via fstat BEFORE reading, otherwise `COPY_CAP`. The xattr is set by python3 in
//   the user container (`os.setxattr`, userxattr overlay); test seam `CBASE_COPY_OPAQUE_PROGRAM` (a program instead
//   of python3, gets the paths as arguments — macOS has no `os.setxattr`).
// removeCopyLocation({ location, projectId, instance })
//   The dismantling of the location: `fs.rmSync`; if something stays that the user container may not delete
//   (root-owned), a helper clears as root (bind of the parent `<data>/copies/<pid>`). → { removed, overHelper }.
// removeCopyWorktrees({ runLocation, root, projectId, instance })
//   The folder of a copy's worktrees in the runtime folder (runs/runtime-location.js worktreeRoot — `runLocation` is
//   the project's location, `root` this path) drops with the clearing away of the copy. Checked as in
//   runs/git-post-work.js: `root` is a DIRECT child of `runLocation.copyWorktrees`, neither it nor the child is a
//   symlink, and the real path is in the runtime folder — otherwise it THROWS and deletes nothing. A missing folder is
//   not an error. It is NEVER deleted recursively in the user container: the runtime folder is mounted rw at the same
//   path in the running main instance, a JS rimraf over path names would follow a symlink swapped in meanwhile. First
//   `rm -rf` as root in the main container (projectbox/cleanUp.js removeAsRoot); if the main instance is down or
//   something stays, a helper as root (`rm -rf --`, bind of the runtime folder — a mount point in the main instance,
//   not replaceable). Without the ops marker it THROWS (no way). → { removed, overHelper }.
// createOverlays({ location, rows })  creates the upper layers and work folders of the overlays (the rows from
//   stacks/creation.js overlayRows: `topB`/`workB` the paths in the user container) and writes `overlays.tsv` — per row
//   `target\tbottom\ttop\twork` with the copy's paths, 0644, `wx` (an existing file is a leftover, not of this build).
//   BEFORE the first mount; no stage between the copy's root and a created folder may be a symlink, and each is BELOW
//   the root. A work folder must be empty (the kernel demands it) — an existing, non-empty one is an error.
// setLinkSeam(fn)  test seam for `fs.linkSync` (an EPERM, an EXDEV) — the product never calls it.
// createReturnPath(location, { processes })  before the return-path helper: the return-path folder in the copy's root
//   (0700 — the helper creates the bare repos in it as agent) and the runtime folder `processes` of the main instance
//   (the wrapper creates no folders). No stage below the copy's root may be a symlink. An existing folder stays (a
//   second fetch takes the same bare repos: `init` in an existing one is harmless, it sets the refs anew).
// createBackup(location)  `<data>/copies-backup/<pid>/<name>` (0700) — only when there is something to back up (a new
//   repo or the tar of the ignored files): as long as the folder stands, the name is occupied (stacks/names.js). No
//   stage below `<data>` may be a symlink.
// dismissBackupFile(location, file)  removes a half-written file of the backup (a bundle or the tar at the cap); only
//   below `location.backup`, only a regular file. → true if something is gone.
// cleanUpBackup(location)  removes the backup folder if it is EMPTY (rmdir — content always stays).
//
// Guards: server/backend/test/stacks-code.test.js; createOverlays in server/backend/test/stacks-creation.test.js; the
// four return-path helpers in server/backend/test/stacks-fetch.test.js.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { T } from "../i18n.js";
import { removeAsRoot } from "../projectbox/cleanUp.js";
import { executeHelper, withHelper } from "../projectbox/helper.js";
import { realRoots, nameInFolder, openFileWithoutReference, openInArea } from "../runtime/real-path.js";

export const OBJECTS_CAP = 5_000_000; // ESTIMATED, NOT MEASURED: ten times a large monorepo with loose objects
export const OBJECTS_DEPTH = 8; //         ESTIMATED: git creates at most two levels below objects/ (info/commit-graphs/…)
export const SHALLOW_CAP = 64 * 1024 * 1024; // ESTIMATED, NOT MEASURED: one line (41/65 bytes) per shallow root
export const YIELD_EVERY = 256;
const objectsCap = () => {
  const n = Number(process.env.CBASE_COPY_OBJECTS_CAP);
  return Number.isInteger(n) && n > 0 ? n : OBJECTS_CAP;
};
const shallowCap = () => {
  const n = Number(process.env.CBASE_COPY_SHALLOW_CAP);
  return Number.isInteger(n) && n > 0 ? n : SHALLOW_CAP;
};

export class ObjectError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "ObjectError";
    this.code = code;
  }
}

let linkSeam = null;
/** Test seam: replaces `fs.linkSync(source, target)` (null takes it back). */
export function setLinkSeam(fn) { linkSeam = typeof fn === "function" ? fn : null; }
const link = (q, z) => (linkSeam ? linkSeam(q, z) : fs.linkSync(q, z));

const lstatOrNull = (p) => { try { return fs.lstatSync(p); } catch (e) { if (e?.code === "ENOENT") return null; throw e; } };

function noReferenceUntil(stages) {
  for (const s of stages) {
    const st = fs.lstatSync(s);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new ObjectError(T`Location of the copy: ${s} is not a folder (symlink or file) — nothing created`, "COPY_LOCATION_REFERENCE");
  }
}

export function createCopyLocation(location) {
  const base = location.root.base;
  if (lstatOrNull(base)) {
    throw new ObjectError(T`Location of the copy ${base} already exists — a leftover of an earlier copy, not of this build; nothing created`, "COPY_LOCATION_EXISTS");
  }
  const parent = path.dirname(base);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  noReferenceUntil([path.dirname(parent), parent]);
  fs.mkdirSync(base, { mode: 0o700 });
  fs.mkdirSync(location.root.open, { mode: 0o700 });
  noReferenceUntil([base, location.root.open]);
  return { created: true };
}

// Skipping goes by name, never by content (nothing from the repo is read).
const IS_TMP = (name) => name.startsWith("tmp_");
const IS_LOCK = (name) => name.endsWith(".lock");
const ALTERNATES = new Set(["alternates", "http-alternates"]);

export async function linkObjects({ source, target, repo, anchor }) {
  const cap = objectsCap();
  const result = { files: 0, folder: 0, copied: 0, skipped: [], alternates: false, promisor: false };
  let accesses = 0;
  const handOver = async () => { if (++accesses % YIELD_EVERY === 0) await new Promise((r) => setImmediate(r)); };
  // The location of the source via the trusted anchor (the project folder — a mount point no container can replace):
  // if a path part between it and `.git/objects` leads over a symlink, the source does not count (runtime/real-path.js).
  const realW = realRoots([source], anchor ? [anchor] : []);
  if (!realW.length) throw new ObjectError(T`${repo}: ${source} leads over a symlink — no objects linked`, "COPY_OBJECT_KIND");
  if (lstatOrNull(target)) throw new ObjectError(T`${repo}: ${target} already exists — an objects folder is never mixed`, "COPY_LOCATION_EXISTS");
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
  // Every folder is opened and pinned (O_NOFOLLOW); entries are addressed through it (Linux: /proc/self/fd) — if a
  // process replaces a folder by a symlink on the way, the walk does not follow it.
  // The cap counts EVERY entry read (also skipped ones) and hits BEFORE the next one is read: a folder is read entry
  // by entry (opendir), never loaded and sorted as a whole; the depth is bounded (one open descriptor and one open
  // folder per level).
  let read = 0;
  const walk = async (fd, display, z, rel, depth) => {
    if (depth > OBJECTS_DEPTH) {
      throw new ObjectError(T`${repo}: .git/objects/${rel} is deeper than ${OBJECTS_DEPTH} levels (cap, estimated, not measured) — aborted instead of truncated`, "COPY_CAP");
    }
    fs.mkdirSync(z, { mode: (fs.fstatSync(fd).mode & 0o7777) | 0o700 });
    result.folder += 1;
    const folder = fs.opendirSync(nameInFolder(fd, display, ""));
    try {
      for (let e = folder.readSync(); e !== null; e = folder.readSync()) {
        if (++read > cap) {
          throw new ObjectError(T`${repo}: more than ${cap} entries below .git/objects (cap, estimated, not measured; setting CBASE_COPY_OBJECTS_CAP) — aborted instead of truncated`, "COPY_CAP");
        }
        await handOver();
        await entry(fd, display, z, rel, depth, e.name);
      }
    } finally { folder.closeSync(); }
  };
  const entry = async (fd, display, z, rel, depth, name) => {
    const at = nameInFolder(fd, display, name);
    const zn = path.join(z, name);
    const r = rel ? `${rel}/${name}` : name;
    if (IS_TMP(name) || IS_LOCK(name) || (!rel && name.startsWith("incoming-"))) { result.skipped.push(r); return; }
    if (rel === "info" && ALTERNATES.has(name)) { result.alternates = true; result.skipped.push(r); return; }
    const st = fs.lstatSync(at);
    if (st.isDirectory()) {
      let kind;
      try { kind = fs.openSync(at, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW); } catch (e) {
        if (e?.code === "ELOOP" || e?.code === "ENOTDIR") throw new ObjectError(T`${repo}: .git/objects/${r} became a symlink on the way — no objects linked`, "COPY_OBJECT_KIND");
        throw e;
      }
      try { await walk(kind, path.join(display, name), zn, r, depth + 1); } finally { fs.closeSync(kind); }
      return;
    }
    if (!st.isFile()) {
      const kind = st.isSymbolicLink() ? T("a symlink") : st.isFIFO() ? T("a FIFO") : st.isSocket() ? T("a socket") : T("a device");
      throw new ObjectError(T`${repo}: .git/objects/${r} is ${kind} — only regular files and folders are linked, nothing created`, "COPY_OBJECT_KIND");
    }
    if (name.endsWith(".promisor")) result.promisor = true;
    try {
      link(at, zn);
      result.files += 1;
    } catch (e) {
      if (e?.code === "EXDEV") throw new ObjectError(T`${repo}: .git/objects/${r} is on a different file system than the copy (EXDEV) — no hard link possible`, "COPY_OBJECT_EXDEV");
      if (e?.code !== "EPERM") throw e;
      // protected_hardlinks: an object the user container does not own (root in the project container). Copy without following a symlink.
      copyFile(at, zn, st.mode);
      result.files += 1;
      result.copied += 1;
    }
  };
  const root = openInArea(source, realW, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try { await walk(root, source, target, "", 0); } finally { fs.closeSync(root); }
  result.skipped.sort(); // the reading order is that of the file system
  return result;
}

function copyFile(source, target, mode) {
  const q = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    if (!fs.fstatSync(q).isFile()) throw new ObjectError(T`${source}: no longer a regular file — not copied`, "COPY_OBJECT_KIND");
    const z = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, mode & 0o777);
    try {
      const buffer = Buffer.allocUnsafe(1 << 20);
      for (;;) {
        const n = fs.readSync(q, buffer, 0, buffer.length, null);
        if (!n) break;
        fs.writeSync(z, buffer, 0, n);
      }
      fs.fchmodSync(z, mode & 0o777);
    } finally { fs.closeSync(z); }
  } finally { fs.closeSync(q); }
}

/** Sets the xattr `user.overlay.opaque=y` on the paths (python3 in the user container; test seam CBASE_COPY_OPAQUE_PROGRAM). */
export function setOpaque(paths) {
  if (!paths.length) return;
  const program = process.env.CBASE_COPY_OPAQUE_PROGRAM;
  if (program) { execFileSync(program, paths, { stdio: ["ignore", "ignore", "pipe"] }); return; }
  execFileSync("python3", ["-c", "import os,sys\nfor p in sys.argv[1:]: os.setxattr(p, 'user.overlay.opaque', b'y', follow_symlinks=False)", ...paths], { stdio: ["ignore", "ignore", "pipe"] });
}

export function prepareLayer({ layer, shallow = null, anchor = null }) {
  const git = path.join(layer, ".git");
  fs.mkdirSync(layer, { recursive: true, mode: 0o755 });
  fs.mkdirSync(git, { mode: 0o755 });
  fs.mkdirSync(path.join(git, "objects"), { mode: 0o755 });
  if (shallow) {
    // The main instance's file via the checked parent folder, without following a symlink (runtime/real-path.js).
    let fd;
    try { fd = openFileWithoutReference(shallow, realRoots([path.dirname(shallow)], anchor ? [anchor] : [])); } catch (e) {
      if (e?.code !== "ENOENT") throw new ObjectError(T`${shallow} is not readable (${e?.code || e?.message}) — not taken over`, "COPY_OBJECT_KIND");
    }
    if (fd !== undefined) {
      // The cap BEFORE reading (fstat) and while reading (never more than cap + 1 bytes).
      const cap = shallowCap();
      try {
        const tooBig = (n) => new ObjectError(T`${shallow} has ${n} bytes — cap ${cap} (estimated, not measured; setting CBASE_COPY_SHALLOW_CAP) reached, not taken over`, "COPY_CAP");
        const size = fs.fstatSync(fd).size;
        if (size > cap) throw tooBig(size);
        const chunks = [];
        let n = 0;
        for (;;) {
          const b = Buffer.allocUnsafe(Math.min(1 << 20, cap + 1 - n));
          const k = fs.readSync(fd, b, 0, b.length, n);
          if (!k) break;
          chunks.push(b.subarray(0, k));
          n += k;
          if (n > cap) throw tooBig(T`more than ${cap}`);
        }
        fs.writeFileSync(path.join(git, "shallow"), Buffer.concat(chunks, n), { mode: 0o644, flag: "wx" });
      } finally { fs.closeSync(fd); }
    }
  }
  setOpaque([git]);
  return { git };
}

export function createOverlays({ location, rows }) {
  const base = location.root.base;
  noReferenceUntil([base]);
  const under = (p) => {
    const rel = path.relative(base, p);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new ObjectError(T`Overlay: ${p} is not below ${base} — nothing created`, "COPY_LOCATION_REFERENCE");
    return rel.split(path.sep);
  };
  for (const z of rows) {
    for (const [kind, p] of [["top", z.topB], ["work", z.workB]]) {
      const parts = under(p);
      fs.mkdirSync(p, { recursive: true, mode: 0o755 });
      noReferenceUntil(parts.map((_, i) => path.join(base, ...parts.slice(0, i + 1))));
      if (kind === "work" && fs.readdirSync(p).length) throw new ObjectError(T`Overlay: work folder ${p} is not empty — a leftover, nothing mounted`, "COPY_LOCATION_EXISTS");
    }
  }
  const text = rows.map((z) => [z.target, z.bottom, z.top, z.work].join("\t")).join("\n");
  fs.writeFileSync(location.root.overlays, `${text}\n`, { mode: 0o644, flag: "wx" });
  return { rows: rows.length };
}

export async function removeCopyLocation({ location, projectId, instance }) {
  const base = location.root.base;
  try { fs.lstatSync(base); } catch (e) { if (e?.code === "ENOENT") return { removed: true, overHelper: false }; throw e; }
  try {
    fs.rmSync(base, { recursive: true, force: true });
    return { removed: true, overHelper: false };
  } catch (e) {
    if (e?.code !== "EACCES" && e?.code !== "EPERM" && e?.code !== "ENOTEMPTY") throw e;
  }
  // Root-owned leftovers: a helper clears as root. Mounted is the PARENT folder (nobody can remove a mount point
  // itself), the target at the same path.
  const parent = path.dirname(base);
  await withHelper({ kind: "clearAway", projectId, instance, mounts: [{ type: "bind", source: parent, target: parent }] }, (h) => executeHelper(h, ["rm", "-rf", "--", base]));
  return { removed: !fs.existsSync(base), overHelper: true };
}

export async function removeCopyWorktrees({ runLocation, root, projectId, instance }) {
  const parent = runLocation.copyWorktrees;
  const no = (what) => new ObjectError(T`Worktrees of the copy: ${root} ${what} — nothing removed`, "COPY_LOCATION_REFERENCE");
  if (!parent || !root || path.dirname(root) !== parent || path.basename(root) === "." || path.basename(root) === "..") throw no(T`is not a direct child of ${parent}`);
  const st = lstatOrNull(root);
  if (!st) return { removed: true, overHelper: false };
  const el = lstatOrNull(parent);
  if (!el || el.isSymbolicLink() || !el.isDirectory()) throw no(T`is below ${parent}, which is not a folder (symlink or file)`);
  if (st.isSymbolicLink() || !st.isDirectory()) throw no(T("is not a folder (symlink or file)"));
  if (fs.realpathSync(root) !== path.join(fs.realpathSync(runLocation.root), path.relative(runLocation.root, parent), path.basename(root))) throw no(T`is not really in the runtime folder ${runLocation.root}`);
  // NEVER recursively in the user container. The runtime folder is mounted rw at the same path in the running main
  // instance — the check above only holds before the delete, and a JS rimraf over path names would follow a subfolder
  // the main instance swaps for a symlink meanwhile. First the main instance itself (`rm -rf` as root, cleanUp.js
  // removeAsRoot — there a symlink only resolves in the project's namespace); if it is down or something stays, the
  // root helper with the runtime folder as bind (a mount point in the main instance: it cannot be replaced itself,
  // unlike the folder of the copy worktrees), GNU `rm -rf --` follows no symlink. Without the ops marker neither
  // exists: then it THROWS.
  let inMain = false;
  try { inMain = await removeAsRoot({ projectId, path: root }); } catch { /* no way (without the ops marker) — the helper */ }
  if (inMain && !lstatOrNull(root)) return { removed: true, overHelper: false };
  await withHelper({ kind: "clearAway", projectId, instance, mounts: [{ type: "bind", source: runLocation.root, target: runLocation.root }] }, (h) => executeHelper(h, ["rm", "-rf", "--", root]));
  return { removed: !lstatOrNull(root), overHelper: true };
}

// ── Return path and backup ─────────────────────────────────────────────────────────────────────────────────────────────

export function createReturnPath(location, { processes } = {}) {
  noReferenceUntil([location.root.base]);
  const r = location.root.returnPathFolder;
  if (!lstatOrNull(r)) fs.mkdirSync(r, { mode: 0o700 });
  noReferenceUntil([r]);
  if (processes) fs.mkdirSync(processes, { recursive: true });
  return { returnPath: r };
}

export function createBackup(location) {
  const s = location.backup;
  // `<data>/copies-backup/<pid>/<name>`: the three stages below `<data>` — none may be a symlink.
  const stages = [path.dirname(path.dirname(s)), path.dirname(s), s];
  fs.mkdirSync(s, { recursive: true, mode: 0o700 });
  noReferenceUntil(stages);
  return { backup: s };
}

const directlyIn = (folder, file) => {
  const rel = path.relative(folder, file);
  return Boolean(rel) && !rel.startsWith("..") && !path.isAbsolute(rel) && !rel.includes(path.sep);
};

export function dismissBackupFile(location, file) {
  if (!directlyIn(location.backup, file)) throw new ObjectError(T`${file} is not directly in ${location.backup} — not dismissed`, "COPY_LOCATION_REFERENCE");
  const st = lstatOrNull(file);
  if (!st) return false;
  if (!st.isFile()) throw new ObjectError(T`${file} is not a regular file — not dismissed`, "COPY_OBJECT_KIND");
  fs.unlinkSync(file);
  return true;
}

export function cleanUpBackup(location) {
  if (!lstatOrNull(location.backup)?.isDirectory()) return false;
  try { fs.rmdirSync(location.backup); return true; } catch (e) { if (e?.code === "ENOTEMPTY" || e?.code === "EEXIST") return false; throw e; }
}
