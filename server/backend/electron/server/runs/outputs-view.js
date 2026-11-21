// The VIEW of a chat's output location. Agents and subagents put reports and screenshots into the output location
// (runs/outputs.js) — the UI could not reach them. Here is the READING for the human: the list (newest first, capped) and the
// opening of ONE file. Nothing is written here.
//
// THE BOUNDARY. The output location of a converted project lies in the runtime folder, which the project container mounts rw — an
// agent there can create arbitrary links (`screens → /home/agent/cbase/data`, `report.md → ~/.claude-login/.credentials.json`).
// The area is therefore the output location itself, anchored at a place the container cannot replace: the runtime folder
// (`runtimeFolderOf`) or flat `<data>/outputs` (`location.outputs`), STRICTLY — if the output location itself (or a part between
// anchor and it) is a link, it does not count. The list walks with `traverseWithoutReferences` (links, FIFOs, devices do not
// appear, every folder O_NOFOLLOW from the pinned parent folder); a file is opened by `openFileWithoutReference` (parent folder
// checked, the file O_NOFOLLOW|O_NONBLOCK, only a regular one). The relative path from the request first goes through
// `relativeOutputPath` (no `..`, nothing absolute) — the check at the descriptor is the boundary, the word check only keeps the
// answer honest (400 instead of 404).
//
// THE FALLBACK (like runs/runtime-location.js `outputFile`): after a project change the files lie at the old location until the
// move. The current location is read first, then every other where the chat has an output location; identical paths take the
// current one.
//
// A leaf: imports only node:*, runs/runtime-location.js, runs/runtime-write.js and runtime/real-path.js.
// Consumer: chats/outputs-routes.js. Guard: server/backend/test/outputs-view.test.js.
import fs from "node:fs";
import path from "node:path";
import { allLocations, outputLocationIn, locationForChat } from "./runtime-location.js";
import { runtimeFolderOf } from "./runtime-write.js";
import { traverseWithoutReferences, realRoots, openFileWithoutReference } from "../runtime/real-path.js";

/** At most this many entries go to the client — the newest. A cap, and the response says when it took effect. */
export const OUTPUTS_LIST_MAX = 2000;
/** The walk visits at most this many files (fstat per file) — above it `clipped`, and `total` is this cap. */
export const OUTPUTS_WALK_MAX = 20_000;
/** The internal folders at the top of the output location (runs/outputs.js): output files of the subagents, scripts of the
 *  dynamic workflows, the log files of the monitors (runs/monitors.js, `monitors/<taskId>.log`). */
export const OUTPUTS_INTERNAL = Object.freeze(["agents", "workflows", "monitors"]);
const PATH_MAX = 1024;

/**
 * A relative path from a request → the parts (`["screens", "a.png"]`) or `null`: no leading `/`, no empty part, no
 * `.`/`..`, no NUL, no `\`, at most 1,024 characters. Pure.
 */
export function relativeOutputPath(rel) {
  if (typeof rel !== "string" || !rel || rel.length > PATH_MAX) return null;
  if (rel.includes("\0") || rel.includes("\\") || rel.startsWith("/")) return null;
  const parts = rel.split("/");
  if (parts.some((t) => t === "" || t === "." || t === "..")) return null;
  return parts;
}

// The chat's roots for reading: the current location first (even if it does not exist yet), then every other that exists. Per root
// its area (strict at the anchor) — `null` if the root itself leads through a link.
function rootsOfTheChats(chat) {
  const id = String(chat.id);
  const location = locationForChat(chat);
  const out = [{ path: outputLocationIn(location, id), anchor: location.outputs }];
  for (const o of allLocations()) {
    if (o.root === location.root) continue;
    const p = outputLocationIn(o, id);
    if (fs.existsSync(p)) out.push({ path: p, anchor: o.outputs });
  }
  return out.map((w) => {
    const anchor = runtimeFolderOf(w.path) || w.anchor;
    const area = realRoots([w.path], [anchor], { strict: true });
    return { path: w.path, area: area.length ? area : null };
  });
}

const isFolder = (p) => { try { return fs.lstatSync(p).isDirectory(); } catch { return false; } };

/**
 * The list: `{ roots, entries: [{ path, size, changed, internal }], total, clipped, max }` — newest first, at most
 * `max`. `roots` are all locations of the chat (the current one first), also one that is still empty: the client recognises paths in
 * the chat text by them. A root that leads through a link contributes nothing.
 */
export function outputsList(chat, { max = OUTPUTS_LIST_MAX, walkMax = OUTPUTS_WALK_MAX } = {}) {
  const roots = rootsOfTheChats(chat);
  const seen = new Map();
  let visited = 0;
  let clipped = false;
  for (const w of roots) {
    if (!w.area || !isFolder(w.path) || clipped) continue;
    try {
      traverseWithoutReferences(w.path, w.area, (abs, e, { open }) => {
        if (e.isDirectory()) return true;
        if (!e.isFile()) return false;
        const rel = path.relative(w.path, abs).split(path.sep).join("/");
        if (seen.has(rel)) return false;
        if (++visited > walkMax) { clipped = true; return "hold"; }
        let fd = null;
        try {
          fd = open();
          const st = fs.fstatSync(fd);
          if (!st.isFile()) return false;
          seen.set(rel, { path: rel, size: st.size, changed: Math.round(st.mtimeMs), internal: OUTPUTS_INTERNAL.includes(rel.split("/")[0]) && rel.includes("/") });
        } catch { /* meanwhile gone or turned into a link */ } finally { if (fd !== null) fs.closeSync(fd); }
        return false;
      });
    } catch (e) {
      // The location leads out (EOUTSIDE) or has vanished: it contributes nothing — it is never followed.
      if (e?.code !== "EOUTSIDE" && e?.code !== "ENOENT" && e?.code !== "ENOTDIR") throw e;
    }
  }
  const all = [...seen.values()].sort((a, b) => b.changed - a.changed || a.path.localeCompare(b.path));
  if (all.length > max) clipped = true;
  return {
    roots: roots.map((w) => w.path),
    entries: all.slice(0, max),
    total: clipped && visited > walkMax ? walkMax : all.length,
    clipped,
    max,
  };
}

/**
 * Open a file of the output location for reading → `{ fd, name }` (the caller closes the fd — `supplyFile` does).
 * Errors carry `status`: 400 invalid path, 404 nowhere (or not a regular file), 403 the path leads out.
 */
export function openOutput(chat, rel) {
  const parts = relativeOutputPath(rel);
  if (!parts) throw Object.assign(new Error("invalid path"), { status: 400 });
  let hinaus = null;
  for (const w of rootsOfTheChats(chat)) {
    if (!w.area) { hinaus ??= w.path; continue; }
    try {
      return { fd: openFileWithoutReference(path.join(w.path, ...parts), w.area), name: parts[parts.length - 1] };
    } catch (e) {
      if (e?.code === "EOUTSIDE") { hinaus ??= e.message; continue; }
      if (e?.code === "ENOENT" || e?.code === "ENOTDIR" || e?.code === "ENOFILE") continue;
      throw Object.assign(new Error(String(e?.message || e)), { status: 500 });
    }
  }
  if (hinaus) throw Object.assign(new Error(`The path leads out of the output location: ${rel}`), { status: 403 });
  throw Object.assign(new Error(`Not in the output location: ${rel}`), { status: 404 });
}

// The type by extension — for the view (image, Markdown, text) and the headers (`servingHeader` locks active types into
// the sandbox). Unknown ⇒ octet-stream.
const TYPES = {
  ".md": "text/markdown; charset=utf-8", ".markdown": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8", ".log": "text/plain; charset=utf-8", ".output": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".csv": "text/csv; charset=utf-8", ".yaml": "application/yaml", ".yml": "application/yaml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".pdf": "application/pdf", ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".ts": "text/typescript; charset=utf-8",
  ".zip": "application/zip", ".mp4": "video/mp4", ".webm": "video/webm",
};
export const outputType = (name) => TYPES[path.extname(String(name)).toLowerCase()] || "application/octet-stream";
