// The code editor's file paths for the project folder of a COPY. The async sibling of files.js: the same functions with the same
// answer shapes, but every access goes through the file access (runtime/fileAccess.js) into the copy's container — B sees the main
// project, the overlay view of the copy exists only there. No fallback: if the container fails, the path fails with
// FileAccessError; never a read or write in B in its place.
//
// Caller: devtools/code-route.js, when `opts.instance` is the instance of a copy (project level: the token of a copy or
// `?chat=<chat of the copy>`, devtools/routes.js targetInstance). Workspace level and main stay files.js.
//
// The rules come from files.js (MAX_READ, search caps, resolveInside, toRel — one version); the tree walks have their cores in
// runtime/fileAccess.js (search, names), which carry the same rules into the container. What a copy does NOT have:
//   · the folder download as ZIP (zip.js packs in B): `downloadCopy` reports it, a file goes raw (up to the cap of the line,
//     a message instead of truncation);
//   · the language service of the agents (`/api/lsp` would read B's disk): `supported:false`. The editor of a copy has its own
//     language server INSIDE the copy (`/lsp/*`).
// Guard: server/backend/test/files-in-copy.test.js.
import path from "node:path";
import * as access from "./runtime/fileAccess.js";
import { T } from "./i18n.js";
import { HEAVY_DIRS, CHAIN_DEPTH, CHAINS_READ_MAX, MAX_READ, NAME_SEARCH_MAX_FILES, FAST_WALK_MAX, SEARCH_MAX_FILE, SEARCH_MAX_FILES, SEARCH_MAX_MATCHES, imageMime, resolveInside, toRel } from "./files.js";

const error = (text) => new Error(text);
// What files.js asks via `fs.statSync(abs).isDirectory()` / `statType`: the kind after following the reference.
const targetKind = (e) => (e.kind === "reference" ? e.target?.kind ?? null : e.kind);

/** Directory contents (not recursive) — folders first, then files, alphabetical; `.git` hidden (files.js listDir). */
export async function listDir(inst, projectPath, rel) {
  const abs = resolveInside(projectPath, rel);
  let entries;
  // The container computes the chains of single subfolders (files.js chainsAlongside) in the same call.
  try { entries = await access.list(inst, abs, { chains: { depth: CHAIN_DEPTH, max: CHAINS_READ_MAX, heavy: [...HEAVY_DIRS] } }); } catch (e) {
    if (e?.code === "ENOENT" || e?.code === "ENOTDIR") throw error(T("Not a directory"));
    throw e;
  }
  const out = [];
  for (const e of entries) {
    if (e.name === ".git" || !e.kind) continue; // repo internals out; unreadable → skip
    const symlink = e.kind === "reference";
    const dir = symlink ? e.target?.kind === "folder" : e.kind === "folder";
    const size = symlink ? (e.target ? e.target.size : 0) : e.size;
    const entry = { name: e.name, path: toRel(projectPath, path.join(abs, e.name)), type: dir ? "dir" : "file", size, symlink, heavy: dir && HEAVY_DIRS.has(e.name) };
    if (dir && !symlink && Array.isArray(e.chain) && e.chain.length) {
      let location = path.join(abs, e.name);
      entry.chain = e.chain.map((name) => { location = path.join(location, name); return { name, path: toRel(projectPath, location), type: "dir", size: 0, symlink: false, heavy: HEAVY_DIRS.has(name) }; });
    }
    out.push(entry);
  }
  out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
  return { path: rel ? String(rel).replace(/^[/\\]+/, "") : "", entries: out };
}

/** Text content of a file; too large / binary → a flag instead of content, an image marked as such (files.js readFile). */
export async function readFile(inst, projectPath, rel) {
  const abs = resolveInside(projectPath, rel);
  const mime = imageMime(abs);
  // An image is not loaded into the editor: `maxBytes` 0 fetches only kind and size (the download delivers the bytes).
  const r = await access.read(inst, abs, { maxBytes: mime ? 0 : MAX_READ });
  if (r.kind === "folder") throw error(T("Is a directory"));
  if (r.kind !== "file") throw error(T("Not a regular file"));
  const p = toRel(projectPath, abs);
  if (mime) return { path: p, binary: true, image: true, mime, size: r.size };
  if (r.tooBig) return { path: p, tooLarge: true, size: r.size };
  if (r.data.subarray(0, 8192).includes(0)) return { path: p, binary: true, size: r.size };
  return { path: p, content: r.data.toString("utf8"), size: r.size };
}

/** File batch (base64) into a folder; `append` continues a follow-up chunk (files.js uploadFiles). */
export async function uploadFiles(inst, projectPath, { dir = "", files = [] } = {}) {
  const target = resolveInside(projectPath, dir);
  const st = await access.stat(inst, target);
  if (!st || targetKind(st) !== "folder") throw error(T("Target folder not found"));
  const base = path.resolve(target);
  let written = 0;
  for (const f of files) {
    const rel = String(f?.path || "").replace(/\\/g, "/");
    if (!rel || rel.startsWith("/") || rel.split("/").some((s) => s === ".." || s === "." || s === "")) throw error(T`Invalid path: ${rel}`);
    const abs = path.resolve(base, rel);
    if (!abs.startsWith(base + path.sep)) throw error(T("Path leaves the folder"));
    await access.write(inst, abs, Buffer.from(String(f.dataB64 || ""), "base64"), { append: Boolean(f?.append) });
    written++;
  }
  return { written, dir: toRel(projectPath, base) };
}

/**
 * Target of a download: a file raw (`{ dir: false, name, size, data }`, up to the cap of the line — above it an error WITH a message,
 * nothing truncated). A folder as ZIP does not exist from a copy: `{ dir: true, name }`, the caller reports it.
 */
export async function downloadCopy(inst, projectPath, rel) {
  const abs = resolveInside(projectPath, rel);
  const st = await access.stat(inst, abs);
  const kind = st ? targetKind(st) : null;
  if (!kind) throw error(T("Not found"));
  const name = path.basename(abs) || path.basename(path.resolve(projectPath)) || "download";
  if (kind === "folder") return { dir: true, name };
  const r = await access.read(inst, abs);
  if (r.kind !== "file") throw error(T("Not a regular file"));
  if (r.tooBig) throw error(T`File too large to download from the copy (${r.size} bytes, limit ${access.READ_MAX}) — pack it in the copy's terminal or fetch it.`);
  return { dir: false, name, size: r.data.length, data: r.data };
}

/** Write a file (parent folders are created as needed). */
export async function writeFile(inst, projectPath, rel, content) {
  const abs = resolveInside(projectPath, rel);
  const text = String(content ?? "");
  try { await access.write(inst, abs, Buffer.from(text, "utf8")); } catch (e) {
    if (e?.code === "EISDIR") throw error(T("Is a directory"));
    throw e;
  }
  return { ok: true, path: toRel(projectPath, abs), size: Buffer.byteLength(text) };
}

/** Create a file or folder (error if it exists — a reference without a target is an existing name too). */
export async function createEntry(inst, projectPath, rel, type) {
  const abs = resolveInside(projectPath, rel);
  try { await access.create(inst, abs, type === "dir" ? "folder" : "file"); } catch (e) {
    if (e?.code === "EEXIST") throw error(T("Already exists"));
    throw e;
  }
  return { ok: true, path: toRel(projectPath, abs), type: type === "dir" ? "dir" : "file" };
}

/** Rename / move. */
export async function renameEntry(inst, projectPath, fromRel, toRel_) {
  const from = resolveInside(projectPath, fromRel);
  const to = resolveInside(projectPath, toRel_);
  try { await access.name(inst, from, to); } catch (e) {
    if (e?.code === "ENOENT") throw error(T("Source not found"));
    if (e?.code === "EEXIST") throw error(T("Target already exists"));
    throw e;
  }
  return { ok: true, path: toRel(projectPath, to) };
}

/**
 * Copy (explorer like VS Code): the same rules as files.js `copyEntry` (never overwrite ⇒ `TARGET_EXISTS`, no folder into itself —
 * not even through a reference in the target's path, compared by the real location in the container (`stat` → `real`) — not the
 * project folder), every access through the copy's file access. The file access knows no reference as the target of a write: a
 * reference INSIDE a folder is dropped and counted in `omitted` (a reference as the source itself is an error). Every file is one
 * call into the container — hence its own small cap COPY_MAX_IN_COPY; it and the size of each file (limit of the file access) are
 * checked from the plan BEFORE the first effect (otherwise a half copy would be left standing). The permissions (+x) go along.
 */
export const COPY_MAX_IN_COPY = 200;
const targetExists = () => Object.assign(error(T("Target already exists")), { code: "TARGET_EXISTS" });
export async function copyEntry(inst, projectPath, fromRel, toRel_) {
  const base = path.resolve(projectPath);
  const from = resolveInside(projectPath, fromRel);
  const to = resolveInside(projectPath, toRel_);
  if (from === base) throw error(T("The project folder itself cannot be copied"));
  if (to === base) throw targetExists();
  if (to === from || to.startsWith(from + path.sep)) throw error(T("A folder cannot be copied into itself"));
  const st = await access.stat(inst, from);
  if (!st) throw error(T("Source not found"));
  if (st.kind === "reference") throw error(T("A reference cannot be copied in a copy — copy in the copy's terminal."));
  if (await access.stat(inst, to)) throw targetExists();
  // No folder into itself through a reference in the target's path: the real location of the deepest existing target folder against the source's.
  if (st.kind === "folder") {
    let location = path.dirname(to), zst = null;
    while (!(zst = await access.stat(inst, location)) && path.dirname(location) !== location) location = path.dirname(location);
    if (!st.real || !zst?.real) throw error(T("The location of source or target cannot be determined in the copy"));
    if (zst.real === st.real || zst.real.startsWith(st.real + "/")) throw error(T("A folder cannot be copied into itself"));
  }
  // The plan BEFORE the first effect: folders before their contents, references and the rest omitted; size and permissions from the listing.
  const plan = [];
  let omitted = 0;
  const collect = async (abs, kind, size, mode) => {
    if (plan.length > COPY_MAX_IN_COPY) return;
    if (kind === "file") { plan.push({ abs, kind, size, mode }); return; }
    if (kind !== "folder") { omitted++; return; }
    plan.push({ abs, kind });
    for (const e of await access.list(inst, abs)) await collect(path.join(abs, e.name), e.kind, e.size, e.mode);
  };
  await collect(from, st.kind, st.size, st.mode);
  if (plan.length > COPY_MAX_IN_COPY) {
    throw Object.assign(error(T`Too large to copy in a copy: more than ${COPY_MAX_IN_COPY} entries (cap — each is a call into the container). Copy in the copy's terminal.`), { code: "COPY_TOO_LARGE" });
  }
  const tooBig = plan.find((x) => x.kind === "file" && x.size > access.READ_MAX);
  if (tooBig) {
    throw Object.assign(error(T`File too large to copy in a copy (${path.relative(path.dirname(from), tooBig.abs)}: ${tooBig.size} bytes, limit ${access.READ_MAX}) — copy in the copy's terminal.`), { code: "COPY_TOO_LARGE" });
  }
  let copied = 0;
  for (const { abs, kind, mode } of plan) {
    const target = path.join(to, path.relative(from, abs));
    try {
      if (kind === "folder") await access.create(inst, target, "folder");
      else {
        const r = await access.read(inst, abs);
        if (r.kind !== "file") { omitted++; continue; }
        if (r.tooBig) throw error(T`File too large to copy in a copy (${r.size} bytes, limit ${access.READ_MAX}) — copy in the copy's terminal.`);
        // expect null: the file must not exist; the source's permissions (+x) go along.
        await access.write(inst, target, r.data, { expect: null, ...(typeof mode === "number" ? { mode } : {}) });
      }
    } catch (e) {
      if (e?.code === "EEXIST" || e?.code === "ECONFLICT") throw targetExists();
      throw e;
    }
    copied++;
  }
  return { ok: true, path: toRel(projectPath, to), copied, omitted };
}

/** Delete (file or folder, recursive). The project folder itself cannot be deleted. */
export async function deleteEntry(inst, projectPath, rel) {
  const abs = resolveInside(projectPath, rel);
  if (abs === path.resolve(projectPath)) throw error(T("The project folder cannot be deleted"));
  try { await access.erase(inst, abs); } catch (e) {
    if (e?.code === "ENOENT") throw error(T("Not found"));
    throw e;
  }
  return { ok: true };
}

/** Capped full-text search over the copy's project tree (binary/large files skipped) — like files.js `searchFiles`: exclusions and
 *  ignore files like VS Code (`exclusions`), per line the columns of every hit, `openMatches`. */
export async function searchFiles(inst, projectPath, { query, regex, caseSensitive, wholeWord, include, exclude, exclusions = true, open = [] } = {}) {
  const q = String(query || "");
  if (!q) return { results: [], count: 0, files: 0, truncated: false, openMatches: [] };
  const r = await access.search(inst, path.resolve(projectPath), {
    query: q, regex: Boolean(regex), caseSensitive: Boolean(caseSensitive),
    wholeWord: Boolean(wholeWord), include: String(include ?? ""), exclude: String(exclude ?? ""),
    exclusions: exclusions !== false, open: Array.isArray(open) ? open : [],
    maxFiles: SEARCH_MAX_FILES, maxFile: SEARCH_MAX_FILE, maxHits: SEARCH_MAX_MATCHES,
  });
  if (r.error) throw error(r.error);
  const results = r.results.map((e) => ({ path: e.rel, matches: e.matches }));
  results.sort((a, b) => a.path.localeCompare(b.path));
  return { results, count: r.hits, files: results.length, truncated: r.cutOff, openMatches: r.openMatches ?? [] };
}

/** Quick Open (⌘P) in the copy — like files.js `quickOpenFiles` (scope of the search, order like VS Code), computed in the container. */
export async function quickOpenFiles(inst, projectPath, query, limit = 512, { maxHits = NAME_SEARCH_MAX_FILES, maxWalk = FAST_WALK_MAX } = {}) {
  const r = await access.fast(inst, path.resolve(projectPath), { query: String(query ?? ""), cap: limit, maxFiles: maxHits, maxWalk });
  return { results: r.results, truncated: Boolean(r.truncated), ...(r.aborted ? { aborted: true, searched: r.searched } : {}) };
}

/** File/path search by NAME (@ mentions): project-relative paths whose path contains the query; shallow and basename hits first. */
export async function findFilesByName(inst, projectPath, query, limit = 30) {
  const q = String(query || "").toLowerCase();
  const r = await access.names(inst, path.resolve(projectPath), { query: q, skip: [...HEAVY_DIRS], maxFiles: NAME_SEARCH_MAX_FILES });
  const out = r.files;
  const rank = (rel) => {
    const bn = rel.split("/").pop().toLowerCase();
    let x = rel.split("/").length + rel.length / 200;
    if (q && bn.includes(q)) x -= 100;
    if (q && bn.startsWith(q)) x -= 50;
    return x;
  };
  out.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return { results: out.slice(0, limit), truncated: out.length > limit || r.stopped };
}
