// The container program of the layout. Kind `runtime/fileAccess.js` PROGRAM: ONE pure core, given as text in
// `node -e <program> -- <op> <options JSON>` and run in the project container via `commandRun` — B NEVER reads in the mounted project
// folder through path names. The answer is ONE line of JSON; an error is `{ ok: false, code }`.
//
// The core only reads (lstat, readdir, and a `.git` file, `pyvenv.cfg`, the first line of a shebang, an `alternates` file — each only
// as a regular file after lstat and capped). It follows no link: a link is a leaf (kind `file`, `reference: true`), a path with a
// link in it is `REFERENCE`.
//
// OPERATIONS (o.root = the project folder, absolute — in the container the same path as in B)
//   level   { root, path, cap }       one level: `{ entries: [{ name, kind, isRepo?, worktreeOf?, gitFile?, reference?, special? }],
//                                     total, rootGit }` — `kind` in the kinds of the layout (file · folder · code-repo · worktree);
//                                     sorted by UTF-16; above `cap` entries only the first (`total` says how many there are).
//                                     Hidden: `.git` and `.cbase-*` of the root. A path INSIDE a block is `IN_CODE_REPO`.
//   tree    { root, cap }             the whole tree down to the blocks: `{ node: [{ path, kind, worktreeOf?, gitFile?, reference? }],
//                                     rootGit, rootReal }` (`rootReal` = realpath of the root, git names paths so); above `cap` nodes
//                                     `CAP` (never truncated — a truncated tree would compute a different plan).
//   details { root, sizes, venv, alternates }
//                                     `sizes: [rel]` → `{ rel: { bytes, files } }` (sum of the lstat sizes, no link followed, hard links
//                                     once); `venv: [{ rel, old }]` → `[{ folder, kind, file }]` (under `rel`: `pyvenv.cfg` or an
//                                     executable file in a `bin/` whose shebang names `old`); `alternates: [rel]` → `{ rel: [abs] }`
//                                     (`.git/objects/info/alternates` of a repo).
//
// BLOCK (like git.js findRepos: a folder with ANY entry `.git` is a repo): `.git` a folder ⇒ `code-repo` (`isRepo: true`); a regular
// `.git` file whose `gitdir` points to `<repo>/.git/worktrees/<n>` of a repo under the root ⇒ `worktree` (`worktreeOf` = path of the
// repo, "." for the root); any other `.git` (a file with another target, a link) ⇒ `code-repo` with `gitFile: true` — the repo search
// sees it as a repo, so it is a block.

/* eslint-disable no-control-regex */
export function layoutCore(fs, path, op, o) {
  const error = (code, message) => Object.assign(new Error(message), { code });
  if (typeof o.root !== "string" || !path.isAbsolute(o.root)) throw error("EARG", "root is missing or not absolute");
  const root = path.resolve(o.root);
  const lst = (p) => { try { return fs.lstatSync(p); } catch { return null; } };
  const vgl = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  // git writes `gitdir:` with the REAL path (macOS: /private/var/… for /var/…) — so both versions of the root are compared; only the
  // root itself is resolved, never a target.
  let rootReal = root;
  try { rootReal = fs.realpathSync(root); } catch { /* stays */ }
  // By whole path parts: "..old" lies under the root.
  const relIn = (base, p) => { const r = path.relative(base, p); return r === "" || (r !== ".." && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r)) ? r : null; };
  const relToRoot = (p) => relIn(root, p) ?? (rootReal !== root ? relIn(rootReal, p) : null);
  const hidden = (atRoot, name) => atRoot && (name === ".git" || name.startsWith(".cbase-"));
  // Opened without following links and without waiting for a FIFO, checked at the opened descriptor (no window between lstat and
  // reading).
  const OPEN = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);
  const readBeginning = (p, max, whole) => {
    let fd;
    try { fd = fs.openSync(p, OPEN); } catch { return null; }
    try {
      const s = fs.fstatSync(fd);
      if (!s.isFile() || (whole && s.size > max)) return null;
      const b = Buffer.alloc(Math.min(s.size, max));
      return b.toString("utf8", 0, fs.readSync(fd, b, 0, b.length, 0));
    } catch { return null; } finally { fs.closeSync(fd); }
  };
  const readSmall = (p, max) => readBeginning(p, max, true);
  const block = (abs) => {
    const g = lst(path.join(abs, ".git"));
    if (!g) return null;
    if (g.isDirectory()) return { kind: "code-repo", isRepo: true };
    const text = g.isFile() ? readSmall(path.join(abs, ".git"), 4096) : null;
    const m = text ? /^gitdir:[ \t]*(.+?)[ \t\r]*$/m.exec(text) : null;
    const w = m ? /^(.*)\/\.git\/worktrees\/[^/]+\/?$/.exec(path.resolve(abs, m[1])) : null;
    const from = w ? relToRoot(w[1] || "/") : null;
    // A worktree only if its repo under the root really is a `.git` folder.
    if (from !== null && lst(path.join(root, from, ".git"))?.isDirectory()) return { kind: "worktree", isRepo: false, worktreeOf: from || "." };
    return { kind: "code-repo", isRepo: false, gitFile: true };
  };
  const entry = (abs, name) => {
    const l = lst(abs);
    if (!l) return null;
    if (l.isSymbolicLink()) return { name, kind: "file", reference: true };
    if (l.isDirectory()) {
      const b = block(abs);
      return b ? { name, ...b } : { name, kind: "folder" };
    }
    return l.isFile() ? { name, kind: "file" } : { name, kind: "file", special: true };
  };
  const wl = lst(root);
  if (!wl || !wl.isDirectory()) throw error("ENOENT", "The project folder is missing");
  const wg = lst(path.join(root, ".git"));
  const rootGit = !wg ? null : wg.isDirectory() ? "folder" : wg.isSymbolicLink() ? "reference" : "file";
  const cap = Number.isSafeInteger(o.cap) && o.cap > 0 ? o.cap : 200000;

  if (op === "level") {
    const parts = typeof o.path === "string" && o.path ? o.path.split("/") : [];
    let abs = root;
    for (let i = 0; i < parts.length; i++) {
      if (!parts[i] || parts[i] === "." || parts[i] === ".." || parts[i].includes("\0")) throw error("EARG", "Invalid path");
      if (hidden(i === 0, parts[i])) throw error("ENOENT", "Not found");
      abs = path.join(abs, parts[i]);
      const l = lst(abs);
      if (!l) throw error("ENOENT", "Not found");
      if (l.isSymbolicLink()) throw error("REFERENCE", "A part of the path is a link");
      if (!l.isDirectory()) throw error("ENOTDIR", "Not a folder");
      if (block(abs)) throw Object.assign(error("IN_CODE_REPO", "The path lies in a code repo"), { block: parts.slice(0, i + 1).join("/") });
    }
    let names;
    try { names = fs.readdirSync(abs); } catch (e) { throw error(e.code || "EERROR", "Folder not readable"); }
    names = names.filter((n) => !hidden(parts.length === 0, n)).sort(vgl);
    const entries = [];
    for (const n of names.slice(0, cap)) { const e = entry(path.join(abs, n), n); if (e) entries.push(e); }
    return { entries, total: names.length, rootGit };
  }

  if (op === "tree") {
    const node = [];
    const stack = [[root, ""]];
    while (stack.length) {
      const [dir, rel] = stack.pop();
      let names;
      try { names = fs.readdirSync(dir); } catch (e) { throw error("UNREADABLE", `Folder not readable: ${rel || "."} (${e.code || "?"})`); }
      for (const n of names) {
        if (hidden(rel === "", n)) continue;
        const r = rel ? `${rel}/${n}` : n;
        const e = entry(path.join(dir, n), n);
        if (!e) continue;
        if (node.length >= cap) throw Object.assign(error("CAP", `more than ${cap} nodes in the project`), { cap });
        const k = { path: r, kind: e.kind };
        if (e.worktreeOf !== undefined) k.worktreeOf = e.worktreeOf;
        if (e.gitFile) k.gitFile = true;
        if (e.reference) k.reference = true;
        node.push(k);
        if (e.kind === "folder") stack.push([path.join(dir, n), r]);
      }
    }
    return { node, rootGit, rootReal };
  }

  if (op === "details") {
    const sizes = {};
    for (const rel of Array.isArray(o.sizes) ? o.sizes : []) {
      const start = path.join(root, rel);
      const l0 = lst(start);
      if (!l0) { sizes[rel] = null; continue; }
      let bytes = 0, files = 0;
      const seen = new Set();
      const count = (l) => {
        if (l.nlink > 1 && !l.isDirectory()) { const k = `${l.dev}:${l.ino}`; if (seen.has(k)) return; seen.add(k); }
        bytes += l.size;
        if (!l.isDirectory()) files += 1;
      };
      count(l0);
      const stack = l0.isDirectory() ? [start] : [];
      while (stack.length) {
        const dir = stack.pop();
        let names;
        try { names = fs.readdirSync(dir); } catch { continue; }
        for (const n of names) {
          const p = path.join(dir, n);
          const l = lst(p);
          if (!l) continue;
          count(l);
          if (l.isDirectory()) stack.push(p);
        }
      }
      sizes[rel] = { bytes, files };
    }
    const venv = [];
    for (const v of Array.isArray(o.venv) ? o.venv : []) {
      const start = path.join(root, String(v.rel || ""));
      const prev = String(v.old || "");
      // The old path in both versions of the root (see rootReal).
      const old = [prev, ...(prev && rootReal !== root && prev.startsWith(`${root}/`) ? [rootReal + prev.slice(root.length)] : [])];
      const found = new Map();
      const stack = [[start, 0]];
      let n = 0;
      while (stack.length && n < cap) {
        const [dir, depth] = stack.pop();
        let names;
        try { names = fs.readdirSync(dir); } catch { continue; }
        for (const name of names) {
          if (++n > cap) break;
          const p = path.join(dir, name);
          const l = lst(p);
          if (!l) continue;
          if (l.isDirectory()) { if (name !== ".git" && name !== "node_modules" && depth < 8) stack.push([p, depth + 1]); continue; }
          if (!l.isFile()) continue;
          if (name === "pyvenv.cfg") { const location = path.relative(root, dir); if (!found.has(location)) found.set(location, { folder: location, kind: "pyvenv", file: path.relative(root, p) }); continue; }
          if (path.basename(dir) !== "bin" || !(l.mode & 0o111) || !prev) continue;
          const header = readBeginning(p, 512, false);
          if (!header || !header.startsWith("#!")) continue;
          const row = header.split("\n")[0];
          const names2 = old.some((a) => {
            const i = row.indexOf(a);
            return i >= 0 && (row.length === i + a.length || /[/\s]/.test(row[i + a.length]));
          });
          if (!names2) continue;
          const location = path.relative(root, path.dirname(dir));
          if (!found.has(location)) found.set(location, { folder: location, kind: "shebang", file: path.relative(root, p) });
        }
      }
      venv.push(...found.values());
    }
    const alternates = {};
    for (const rel of Array.isArray(o.alternates) ? o.alternates : []) {
      const objects = path.join(root, rel, ".git", "objects");
      const text = readSmall(path.join(objects, "info", "alternates"), 65536);
      if (text === null) continue;
      const targets = text.split("\n").map((z) => z.trim()).filter((z) => z && !z.startsWith("#")).map((z) => path.resolve(objects, z))
        .map((z) => { const r = relToRoot(z); return r === null ? z : path.join(root, r); });
      if (targets.length) alternates[rel] = targets;
    }
    return { sizes, venv, alternates };
  }
  throw error("EOP", `Unknown operation ${op}`);
}

export const PROGRAM = `"use strict";
const fs = require("node:fs");
const path = require("node:path");
${layoutCore.toString()}
const [op, options] = process.argv.slice(1);
let response;
try {
  response = { ok: true, ...layoutCore(fs, path, op, JSON.parse(options || "{}")) };
} catch (e) {
  response = { ok: false, code: (e && e.code) || "EERROR", message: String((e && e.message) || e), ...(e && e.block ? { block: e.block } : {}), ...(e && e.cap ? { cap: e.cap } : {}) };
}
process.stdout.write(JSON.stringify(response) + "\\n");
`;
