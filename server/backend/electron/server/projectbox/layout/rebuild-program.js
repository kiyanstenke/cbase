// The WRITING container program of the layout (steps 10–12, 16, 20). Pattern of ./program.js (the READING program of the check): ONE
// pure core `rebuildCore(fs, path, cp, op, o)`, given as text in `node -e <REBUILD_PROGRAM> -- <op> <options-JSON>` and run in the
// project container through `commandRun` — B touches nothing in the mounted project folder through path names. The answer is ONE
// line of JSON; an error is `{ ok: false, code, message }`. A file of its own because program.js only reads (its header says so, and
// the check should keep being able to without a single word in it writing) — a deviation from using `runtime/fileAccess.js`
// delete/rename: their program checks no reference in a path part and knows no root fallback with `rm --one-file-system`, and one
// `docker exec` per path would be a hundred calls at a hundred moves.
//
// EVERY path is relative to `o.root` (absolute; in the container the same path as in B), without empty parts, `.`, `..` and NUL. No
// path part BEFORE the last may be a reference (REFERENCE — the move would otherwise hang on a place outside that nobody confirmed);
// the last may be one, then the reference itself counts (it drops or moves, its target stays).
//
// OPERATIONS
//   gone      { paths: [rel], asRoot? }   per path `{ rel, outcome }`: `deleted` · `missing` · `refused` (with `code`, EACCES/EPERM — the
//                                          caller then runs the same operation as root). `asRoot`: instead of `fs.rmSync`
//                                          `rm -rf --one-file-system -- <abs>` (GNU; the project container is Debian; BSD `-x`) — after
//                                          the same check of the path parts, in the same process (without the deadline of `execIn`).
//   turns     { turns: [{ from, to }] }    in order: source present and target free ⇒ `rename` (missing parent folders of the target are
//                                          created — as root with the owner of the root); source gone and target present ⇒ `already` (a
//                                          second run); both present ⇒ CONFLICT; neither ⇒ MISSING. EACCES/EPERM ⇒ `refused` and end of
//                                          the list (the caller runs it once more as root — every move already done is then `already`).
//                                          → `{ turns: [{ from, to, outcome, code? }] }`.
//   empty     { rel }                      remove an empty folder (`missing` if it does not exist; NOT_EMPTY if something lies in it —
//                                          then a move did not run).
//   exists    { paths: [rel] }             which ones exist (lstat) → `{ exists: [rel] }`.
//   alternates { repos: [{ rel, replace: [{ old, fresh }], remove: [abs] }] }
//                                          `.git/objects/info/alternates` per repo: a line that (resolved relative to the objects folder)
//                                          lies under `remove` drops; one under `old` becomes `fresh` + rest (absolute). Compared in both
//                                          versions of the root (git writes realpath). Read only as a regular file without a reference
//                                          (O_NOFOLLOW); written through a file next to it and `rename`. → `{ changed: [rel] }`.
//   links     { links: [{ path, source }], limits: [abs] }
//                                          the linked dependencies of a graph worktree (workflows/worktree.js, own entries with
//                                          `kind: "link"` — ABSOLUTE references to the main folder) to their new source (step 15 "set
//                                          links anew"). `path` lies by wording under one of the `limits` (the runtime folder — worktrees
//                                          never lie in the project folder), no part in between is a reference; `source` lies under the
//                                          root (one version). Per entry `{ path, outcome }`: `set` (a new reference next to it, `rename`
//                                          over it) · `already` · `missing` (no entry or a parent folder missing) · `no-reference`
//                                          (something of its own lies there — never replaced) · `outside` (path or source outside, a
//                                          reference in between). → `{ links: [{ path, outcome }] }`.
//
// "Under" means everywhere: by whole path parts ("..old" lies under the root).

/* eslint-disable no-control-regex */
export function rebuildCore(fs, path, cp, op, o) {
  const error = (code, message) => Object.assign(new Error(message), { code });
  if (typeof o.root !== "string" || !path.isAbsolute(o.root)) throw error("EARG", "root missing or not absolute");
  const root = path.resolve(o.root);
  const lst = (p) => { try { return fs.lstatSync(p); } catch (e) { if (e.code === "ENOENT" || e.code === "ENOTDIR") return null; throw e; } };
  const wl = lst(root);
  if (!wl || wl.isSymbolicLink() || !wl.isDirectory()) throw error("ENOENT", "The root is missing or not a folder");
  let rootReal = root;
  try { rootReal = fs.realpathSync(root); } catch { /* stays */ }
  const refused = (e) => e && (e.code === "EACCES" || e.code === "EPERM");
  const inside = (r) => r === "" || (r !== ".." && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r));
  // The place of a relative path: no reference in a path part before the last. `parent: false` if a parent folder is missing.
  const location = (rel) => {
    if (typeof rel !== "string" || !rel || rel.split("/").some((t) => !t || t === "." || t === ".." || t.includes("\0"))) throw error("EARG", `invalid path: ${String(rel).slice(0, 200)}`);
    const parts = rel.split("/");
    let abs = root;
    for (let i = 0; i < parts.length - 1; i++) {
      abs = path.join(abs, parts[i]);
      const l = lst(abs);
      if (!l) return { abs: path.join(root, rel), parent: false };
      if (l.isSymbolicLink()) throw error("REFERENCE", `A part of “${rel}” is a reference`);
      if (!l.isDirectory()) throw error("ENOTDIR", `A part of “${rel}” is not a folder`);
    }
    return { abs: path.join(root, rel), parent: true };
  };

  if (op === "gone") {
    const out = [];
    for (const rel of Array.isArray(o.paths) ? o.paths : []) {
      const x = location(rel);
      if (!x.parent || !lst(x.abs)) { out.push({ rel, outcome: "missing" }); continue; }
      if (o.asRoot === true) {
        // GNU (the project container is Debian) knows `--one-file-system`, BSD (macOS, the fake docker in the test) the same as `-x`.
        const r = cp.spawnSync("rm", process.platform === "linux" ? ["-rf", "--one-file-system", "--", x.abs] : ["-rfx", "--", x.abs], { encoding: "utf8" });
        if (r.status === 0 && !lst(x.abs)) out.push({ rel, outcome: "deleted" });
        else out.push({ rel, outcome: "refused", code: r.error ? String(r.error.code || "EERROR") : `EXIT_${r.status}`, text: String(r.stderr || "").trim().split("\n").slice(-1)[0].slice(0, 200) });
        continue;
      }
      try { fs.rmSync(x.abs, { recursive: true, force: true }); out.push({ rel, outcome: "deleted" }); } catch (e) {
        if (!refused(e) && e.code !== "ENOTEMPTY") throw e;
        out.push({ rel, outcome: "refused", code: e.code });
      }
    }
    return { paths: out };
  }

  if (op === "turns") {
    const out = [];
    for (const z of Array.isArray(o.turns) ? o.turns : []) {
      const q = location(z.from), n = location(z.to);
      const qd = q.parent ? lst(q.abs) : null;
      const nd = n.parent ? lst(n.abs) : null;
      if (!qd && nd) { out.push({ from: z.from, to: z.to, outcome: "already" }); continue; }
      if (qd && nd) throw Object.assign(error("CONFLICT", `“${z.from}” and “${z.to}” both exist — nothing moved`), { turns: out });
      if (!qd) throw Object.assign(error("MISSING", `“${z.from}” is missing (and “${z.to}” too)`), { turns: out });
      try {
        const first = fs.mkdirSync(path.dirname(n.abs), { recursive: true });
        // Parent folders created as root (the fallback after EACCES) belong to the root's owner — otherwise nobody but root could write
        // there afterwards.
        if (first && typeof process.getuid === "function" && process.getuid() === 0) {
          const w = fs.statSync(root);
          for (let d = path.dirname(n.abs); d.length >= first.length; d = path.dirname(d)) {
            fs.lchownSync(d, w.uid, w.gid);
            if (d === first) break;
          }
        }
        // Once more after creating the parents: a parent part that is a reference now was put there by someone in between.
        location(z.to);
        fs.renameSync(q.abs, n.abs);
        out.push({ from: z.from, to: z.to, outcome: "moved" });
      } catch (e) {
        if (!refused(e)) throw Object.assign(e, { turns: out });
        out.push({ from: z.from, to: z.to, outcome: "refused", code: e.code });
        break;
      }
    }
    return { turns: out };
  }

  if (op === "empty") {
    const x = location(String(o.rel || ""));
    const l = x.parent ? lst(x.abs) : null;
    if (!l) return { outcome: "missing" };
    if (l.isSymbolicLink() || !l.isDirectory()) throw error("ENOTDIR", `“${o.rel}” is not a folder`);
    const inside = fs.readdirSync(x.abs);
    if (inside.length) throw Object.assign(error("NOT_EMPTY", `“${o.rel}” is not empty (${inside.length} entries)`), { count: inside.length });
    fs.rmdirSync(x.abs);
    return { outcome: "removed" };
  }

  if (op === "exists") {
    const existing = [];
    for (const rel of Array.isArray(o.paths) ? o.paths : []) {
      let x;
      try { x = location(rel); } catch (e) { if (e.code === "REFERENCE" || e.code === "ENOTDIR") continue; throw e; }
      if (x.parent && lst(x.abs)) existing.push(rel);
    }
    return { exists: existing };
  }

  if (op === "alternates") {
    const OPEN = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);
    const both = (p) => {
      const r = path.relative(root, p);
      if (inside(r)) return [p, ...(rootReal !== root ? [path.join(rootReal, r)] : [])];
      const r2 = path.relative(rootReal, p);
      return inside(r2) ? [path.join(root, r2), p] : [p];
    };
    const underAbs = (p, b) => inside(path.relative(b, p));
    const changed = [];
    for (const repo of Array.isArray(o.repos) ? o.repos : []) {
      const rr = String(repo.rel || "");
      const x = location(`${rr && rr !== "." ? `${rr}/` : ""}.git/objects/info/alternates`); // "." = the repo at the root
      if (!x.parent) continue;
      let fd;
      try { fd = fs.openSync(x.abs, OPEN); } catch (e) { if (e.code === "ENOENT") continue; throw e; }
      let text;
      try {
        const s = fs.fstatSync(fd);
        if (!s.isFile() || s.size > 65536) throw error("UNREADABLE", `${repo.rel}: alternates is not a small regular file`);
        const b = Buffer.alloc(s.size);
        text = b.toString("utf8", 0, fs.readSync(fd, b, 0, b.length, 0));
      } finally { fs.closeSync(fd); }
      const objects = path.dirname(path.dirname(x.abs));
      let different = false;
      const rows = [];
      for (const z of text.split("\n")) {
        const t = z.trim();
        if (!t || t.startsWith("#")) { rows.push(z); continue; }
        const abs = path.resolve(objects, t);
        if ((o.remove || []).some((e) => both(abs).some((a) => both(path.resolve(e)).some((b) => underAbs(a, b))))) { different = true; continue; }
        let fresh = null;
        for (const w of repo.replace || []) {
          for (const a of both(abs)) for (const b of both(path.resolve(w.old))) {
            if (fresh === null && underAbs(a, b)) fresh = path.join(path.resolve(w.fresh), path.relative(b, a));
          }
        }
        if (fresh !== null) { rows.push(fresh); different = true; } else rows.push(z);
      }
      if (!different) continue;
      const tmp = `${x.abs}.cbase-${process.pid}-${Date.now()}`;
      try { fs.writeFileSync(tmp, rows.join("\n"), { flag: "wx" }); fs.renameSync(tmp, x.abs); } finally { try { fs.rmSync(tmp, { force: true }); } catch { /* gone */ } }
      changed.push(String(repo.rel || ""));
    }
    return { changed };
  }

  if (op === "links") {
    const limits = (Array.isArray(o.limits) ? o.limits : []).filter((g) => typeof g === "string" && path.isAbsolute(g)).map((g) => path.resolve(g));
    const out = [];
    for (const l of Array.isArray(o.links) ? o.links : []) {
      const filePath = l && typeof l.path === "string" && path.isAbsolute(l.path) && !l.path.includes("\0") ? path.resolve(l.path) : null;
      const source = l && typeof l.source === "string" && path.isAbsolute(l.source) && !l.source.includes("\0") ? path.resolve(l.source) : null;
      const row = (outcome) => out.push({ path: String(l?.path ?? ""), outcome });
      const g = filePath === null ? undefined : limits.find((x) => { const r = path.relative(x, filePath); return r !== "" && inside(r); });
      if (g === undefined || source === null || !(inside(path.relative(root, source)) || inside(path.relative(rootReal, source)))) { row("outside"); continue; }
      // No part between the limit and the reference is itself a reference (the new reference would otherwise arise elsewhere).
      let abs = g, state = null;
      for (const t of path.relative(g, path.dirname(filePath)).split(path.sep).filter(Boolean)) {
        abs = path.join(abs, t);
        const x = lst(abs);
        if (!x) { state = "missing"; break; }
        if (x.isSymbolicLink() || !x.isDirectory()) { state = "outside"; break; }
      }
      if (state) { row(state); continue; }
      const x = lst(filePath);
      if (!x) { row("missing"); continue; }
      if (!x.isSymbolicLink()) { row("no-reference"); continue; }
      if (fs.readlinkSync(filePath) === source) { row("already"); continue; }
      const tmp = `${filePath}.cbase-${process.pid}-${Date.now()}`;
      try { fs.symlinkSync(source, tmp, "dir"); fs.renameSync(tmp, filePath); } finally { try { if (lst(tmp)) fs.unlinkSync(tmp); } catch { /* gone */ } }
      row("set");
    }
    return { links: out };
  }
  throw error("EOP", `Unknown operation ${op}`);
}

export const REBUILD_PROGRAM = `"use strict";
const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");
${rebuildCore.toString()}
const [op, options] = process.argv.slice(1);
let response;
try {
  response = { ok: true, ...rebuildCore(fs, path, cp, op, JSON.parse(options || "{}")) };
} catch (e) {
  response = { ok: false, code: (e && e.code) || "EERROR", message: String((e && e.message) || e), ...(e && Array.isArray(e.turns) ? { turns: e.turns } : {}) };
}
process.stdout.write(JSON.stringify(response) + "\\n");
`;
