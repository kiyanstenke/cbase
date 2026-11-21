// The boundary of a converted project for the readers and writers in the backend (B = the user container's
// backend process). A leaf: node:*, app-state.js, the store facade, runtime-location.js, instance.js and the leaf
// runtime/real-path.js.
//
// anchorOfTheInstance(inst)   The TRUSTED ANCHORS of an instance: its project folder and its runtime folder under
//                         <data> — both mount points of the project container, it cannot replace them by a link
//                         (their subfolders it can: outputs, attachments, worktrees …). runtime/real-path.js only
//                         determines their realpath and computes every root below relative to it (realRoot).
//                         Without an instance `[]`. Without DIRS (unit test without a server) there is no runtime
//                         folder and so no anchor for it; without an opened store no project folder anchor. If the
//                         opened store throws, this question throws too (empty is not unknown).
//                         For a COPY only the runtime folder — its project folder lives in its container, B would
//                         see the main there.
// rootsOfTheInstance(inst) The same two anchors separately, `{ project, runtime }` (each `null` if it cannot be
//                         determined) — for a copy's file access (runtime/fileAccess.js): the project folder lives
//                         in the copy, the runtime folder stays in B.
// readInTheInstance(p, { instance, encoding })   The async reader for paths that may also lie in the project folder
//                         of a COPY (a dynamic workflow's script): there through the file access
//                         (runtime/fileAccess.js), otherwise like readInRuntimeFolder. What the copy does not have
//                         is "not found" — never a file from the main.
// areaInB(inst, roots)    THE area in B for the roots of a reader/writer of an instance (file tools of the loop
// areaOfTheInstance(inst) engine, channel files, code view, the readers below) — ONE computation. Without a copy
// locksOfTheCopy(inst)    `realRoots(roots, anchors)`. For a COPY strict (a root without an anchor does not count —
//                         otherwise its project folder would enter the area by realpath in B as the MAIN's folder)
//                         and locked (no real location below the realpath of its project folder, not even via a
//                         link in the runtime folder or /proc/self/root); if its project folder cannot be
//                         determined, it throws (EOUTSIDE).
// instanceOfTheRuntimeFolder(p)  The instance of the project in whose runtime folder `p` lies BY ITS WORDING —
//                         `null` if it lies in none or the project has no instance.
// readInRuntimeFolder(p, { instance, encoding })   The backend's readers below the runtime folder (image
// openInRuntimeFolder(p, { instance })             attachments of the engine, attachment route, a dynamic
//                         workflow's script). With an instance (`instance` explicitly, otherwise that of the
//                         runtime folder `p` lies in) via the checked descriptor: the real location must lie in the
//                         project folder or the runtime folder of THIS instance. Without an instance
//                         `fs.readFileSync(p, encoding)` or `null` (the caller opens as usual) — byte-identical.
// Guards: server/backend/test/tool-runtime.test.js, channel.test.js, engine-in-project.test.js; for the copy
// tool-runtime-copy.test.js, channel-copy.test.js, memory-copy.test.js.
import fs from "node:fs";
import path from "node:path";
import { DIRS } from "../app-state.js";
import * as store from "../store.js";
import { PROJECTS, locationFor } from "./runtime-location.js";
import { instanceFromIdentifier, instanceForProject, instanceIsCopy, instanceOfChat, turnIdentifier } from "./instance.js";
import { realPath, realRoots, readInArea, withLocks, openInArea } from "../runtime/real-path.js";
import * as access from "../runtime/fileAccess.js";

export function anchorOfTheInstance(inst) {
  const w = rootsOfTheInstance(inst);
  // For a COPY B carries only the runtime folder. Its project folder lives in its container (overlay view); what B
  // opened there would be the main. So a reader in B that gets a path below a copy's project folder does not find
  // it in the area and reports "not readable" — the way there is the file access (readInTheInstance). This only
  // holds via areaInB: with the anchors alone the project folder would still enter the area by realpath as a ROOT
  // without an anchor.
  return (instanceIsCopy(inst) ? [w.runtime] : [w.project, w.runtime]).filter(Boolean);
}

/** The same two anchors, named — `{ project, runtime }` (each `null` if it cannot be determined). A copy's file
 *  access (runtime/fileAccess.js fileWay) needs them separately: the project folder lives in the copy, the runtime
 *  folder stays in B. Not resolved (no realpath) — that is what both are called in the container's namespace. */
export function rootsOfTheInstance(inst) {
  if (!inst?.projectId) return { project: null, runtime: null };
  let project = null;
  if (store.instancesReadable()) {
    const p = store.getProject(String(inst.projectId))?.path;
    if (p) project = path.resolve(p);
  }
  const runtime = DIRS?.data ? locationFor({ projectId: inst.projectId, converted: true }).root : null;
  return { project, runtime };
}

export function instanceOfTheRuntimeFolder(filePath) {
  if (!DIRS?.data || typeof filePath !== "string" || !filePath) return null;
  const base = path.join(DIRS.data, PROJECTS);
  const rel = path.relative(base, path.resolve(filePath));
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  const projectId = rel.split(path.sep)[0];
  return projectId ? instanceForProject(projectId) : null;
}

/** The instance whose boundary applies to a read path on behalf of a chat: the pinned one of the running turn,
 *  otherwise that of its project; `null` without an instance. If the turn carries an identifier whose instance no
 *  longer exists, it throws — closed instead of reading unchecked in B. */
export function instanceOfTheChat(chat) {
  if (!chat) return null;
  const k = turnIdentifier(chat.id);
  if (k) {
    const inst = instanceFromIdentifier(k);
    if (!inst) throw Object.assign(new Error(`The instance ${k} of the running turn no longer exists.`), { code: "EOUTSIDE" });
    return inst;
  }
  return chat.projectId ? instanceOfChat(chat) : null; // the chat's copy if it carries one (copy missing ⇒ throws)
}

const instanceFor = (filePath, instance) => (instance !== undefined ? instance || null : instanceOfTheRuntimeFolder(filePath));

/** The LOCKS of a copy in B — the real location of its project folder (and its wording): in B the main lives there.
 *  If it cannot be determined, this THROWS (EOUTSIDE) — no silent "then without a lock". For anything but a copy
 *  `[]`. */
export function locksOfTheCopy(inst) {
  if (!instanceIsCopy(inst)) return [];
  const { project } = rootsOfTheInstance(inst);
  let real = null;
  if (project) { try { real = realPath(project); } catch { real = null; } }
  if (!real) throw Object.assign(new Error(`The project folder of the copy ${inst.identifier || inst.projectId} cannot be determined — nothing read or written, not in the main either.`), { code: "EOUTSIDE" });
  return [...new Set([real, project])];
}

/**
 * The area in B that a reader or writer checks for `roots` of an instance — the ONE computation for the file tools
 * of the loop engine (providers/tool-runtime.js), the channel files (channels/messages.js), the code view
 * (devtools/code-route.js) and the readers in the runtime folder (below). Without a copy:
 * `realRoots(roots, anchorOfTheInstance(inst))`. For a COPY STRICT and LOCKED (runtime/real-path.js): a root
 * without a trusted anchor (the project folder — for the copy it lives in its container) does not count, instead of
 * entering the area with its realpath in B (= the main's folder); and nothing below the real location of the
 * project folder is in the area, however a path leads there (a link in the runtime folder, `/proc/self/root`). What
 * belongs to the copy below its project folder goes through its container (runtime/fileAccess.js), never through B.
 */
export function areaInB(inst, roots) {
  const anchor = anchorOfTheInstance(inst);
  if (!instanceIsCopy(inst)) return realRoots(roots, anchor);
  const lock = locksOfTheCopy(inst);
  return withLocks(realRoots(roots, anchor, { strict: true }), lock);
}
/** The area of the anchors themselves (project folder and runtime folder; for a copy only the runtime folder, locked as above). */
export const areaOfTheInstance = (inst) => areaInB(inst, anchorOfTheInstance(inst));

// The cap of the reader WITH an instance — the same as for the copy (runtime/fileAccess.js READ_MAX, 32 MiB), at the
// seam instead of at every consumer. The project container writes the file: a huge sparse script file would
// otherwise blow up the backend's memory. Larger ⇒ the read throws BEFORE reading (real-path.js, also for a file
// that grows after the fstat). The consumers (script, image attachment, `.git`/`commondir`) catch the throw like any
// other read error. Without an instance as before (there only writes who runs in B anyway).
// Guard: server/backend/test/runtime-read.test.js.
export const RUNTIME_READ_MAX = access.READ_MAX;
export function readInRuntimeFolder(filePath, { instance, encoding, maxBytes = RUNTIME_READ_MAX } = {}) {
  const inst = instanceFor(filePath, instance);
  return inst ? readInArea(filePath, areaOfTheInstance(inst), encoding, { maxBytes }) : fs.readFileSync(filePath, encoding);
}

/**
 * Like `readInRuntimeFolder`, but async and with the copy's way: if the path belongs to the COPY (below its project
 * folder, runtime/fileAccess.js fileWay), its container reads it; everything else stays with the reader in B — and
 * for a copy that carries only the runtime folder (anchorOfTheInstance). An error of the access (container stopped,
 * cap) throws; the file is missing in the copy ⇒ ENOENT.
 */
export async function readInTheInstance(filePath, { instance, encoding } = {}) {
  const inst = instanceFor(filePath, instance);
  if (inst && instanceIsCopy(inst)) {
    const w = rootsOfTheInstance(inst);
    if (!w.project) throw Object.assign(new Error(`The project folder of the copy ${inst.identifier || inst.projectId} cannot be determined.`), { code: "EOUTSIDE" });
    if (access.fileWay(inst, filePath, w) === "copy") {
      const r = await access.read(inst, path.resolve(filePath));
      if (r.kind !== "file") throw Object.assign(new Error(`Not a regular file: ${filePath}`), { code: "ENOFILE" });
      if (r.tooBig) throw Object.assign(new Error(`File too large (${r.size} bytes): ${filePath}`), { code: "TOO_LARGE" });
      return encoding ? r.data.toString(encoding) : r.data;
    }
  }
  return readInRuntimeFolder(filePath, { instance, encoding });
}

/** → a checked, opened descriptor (the caller closes it) or `null` without an instance. */
export function openInRuntimeFolder(filePath, { instance } = {}) {
  const inst = instanceFor(filePath, instance);
  if (!inst) return null;
  const fd = openInArea(filePath, areaOfTheInstance(inst));
  if (fs.fstatSync(fd).isFile()) return fd;
  fs.closeSync(fd);
  throw Object.assign(new Error(`Not a regular file: ${filePath}`), { code: "ENOFILE" });
}
