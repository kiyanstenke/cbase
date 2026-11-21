// The archive storage of a ZIP source. Table `project_archive` (store/project-setup.js), the file
// `<runtime>/setup/archive-<archiveId>.zip` (runs/runtime-location.js archiveFile — only in the runtime folder of a converted
// project; the flat location has no such folder, and a ZIP source only exists in operations).
//
// WHY IN THE RUNTIME FOLDER. The archive is read by the SETUP helper in the project container (modes `list`/`unpack`,
// ./provisioner.js) — the runtime folder is mounted there at the same path (mountRules "runtime"). B touches the file only through
// the descriptor: the chunks via runtime/real-path.js `writeInArea` in the area `areaInRuntimeFolder` (parent folder checked against
// the anchor, the file O_NOFOLLOW, a link out ⇒ EOUTSIDE), the size via `statInArea`, the removal via runs/runtime-write.js
// `removeInRuntimeFolder` (a link falls itself, its target never). The CONTENT is never read by B. The guard
// server/backend/test/runtime-write-guard.test.js (4) holds exactly this form.
//
//   archivePath(projectId, archiveId)            the place of the file (throws for an invalid id).
//   createArchive(projectId, archiveId)          the empty file (offset 0, replaces) — `begin` AFTER creating the row.
//   archiveSize(projectId, archiveId)            the size at the opened descriptor; a missing file is 0.
//   writeArchiveChunk(projectId, archiveId, offset, data) → size
//                                              THE SAME offset rule as the chunks of a provision: 0 replaces, > 0 appends only if it
//                                              equals the size at the descriptor (else real-path.js throws `OFFSET` with `size`) — no
//                                              second append way. `EOUTSIDE` and `ENOSPC` go to the caller (the route answers 409).
//   removeArchive(archive)                     row, THEN file (if B dies in between, the restart grace clears the file without a row).
//   removeArchiveFiles(projectId, ids)         only the files (the delete path, projectbox/erase.js: store.deleteSetup already took the
//                                              rows along and returned the ids).
//   cleanArchive() → { files, rows }           THE RESTART-GRACE HOOK "project-archive" (server.js, synchronous): clears ONLY
//                                              (a) an archive file without a row — or with the row of ANOTHER project — in the runtime
//                                              folder of a project (crash between row and file, a delete path that died between rows
//                                              and files) and (b) a row whose project is gone (with its file). NO DEADLINE: the archive
//                                              of an open source (`wait-upload`, `error`, `aborted`) and of an interrupted operation
//                                              stays until someone leaves it out, discards, deletes or the unpacking succeeds. Another
//                                              name in the folder (not `archive-<uuid>.zip`) stays — it does not belong to cbase.
//                                              Nothing without operations. There is no await between listing and removing: a file
//                                              that `begin` creates has its row already (createArchive after the row).
import path from "node:path";
import * as store from "../../store.js";
import { T } from "../../i18n.js";
import { entriesInArea, writeInArea, statInArea } from "../../runtime/real-path.js";
import { allLocations, archiveFile, archiveIdFromName, locationFor } from "../../runs/runtime-location.js";
import { areaInRuntimeFolder, removeInRuntimeFolder } from "../../runs/runtime-write.js";
import { projectboxOps } from "../ops.js";

/** The place of the archive file — always in the runtime folder of the project (converted; see header). */
export const archivePath = (projectId, archiveId) => archiveFile(locationFor({ projectId: String(projectId), converted: true }), archiveId);

// The name in an error message — never the path in B; deliberately not the spelling of the file (path guard in
// server/backend/test/runtime-location.test.js: the file name arises only in runs/runtime-location.js).
const display = (archiveId) => `Archive ${String(archiveId).slice(0, 8)}`;
// The area of every place below is `areaInRuntimeFolder(abs)` — the runtime folder of the project above it as anchor. If a path did
// not lie there by its wording (impossible with archiveFile), it would be `null`, and real-path.js would accept nothing (EOUTSIDE).

/** Create the empty file (or truncate to 0). */
export function createArchive(projectId, archiveId) {
  const abs = archivePath(projectId, archiveId);
  writeInArea(abs, Buffer.alloc(0), areaInRuntimeFolder(abs), { display: display(archiveId), offset: 0 });
}

/** The size at the opened descriptor; if the file is missing, 0. A link out or anything other than a file throws. */
export function archiveSize(projectId, archiveId) {
  const abs = archivePath(projectId, archiveId);
  try {
    const st = statInArea(abs, areaInRuntimeFolder(abs));
    if (!st.isFile()) throw Object.assign(new Error(T("The archive is not a file.")), { code: "ENOFILE" });
    return st.size;
  } catch (e) {
    if (e?.code === "ENOENT") return 0;
    throw e;
  }
}

/** One chunk (see header) → the size afterwards. */
export function writeArchiveChunk(projectId, archiveId, offset, data) {
  const abs = archivePath(projectId, archiveId);
  writeInArea(abs, data, areaInRuntimeFolder(abs), { display: display(archiveId), offset });
  return archiveSize(projectId, archiveId);
}

function fileGone(projectId, archiveId) {
  try { removeInRuntimeFolder(archivePath(projectId, archiveId)); }
  catch (e) {
    // ENOENT: the runtime folder is already gone (a delete path with purge) — nothing left to remove.
    if (e?.code !== "ENOENT") console.warn(`[setup] archive ${String(archiveId).slice(0, 8)} of ${projectId}: file not removed: ${e?.code || e?.message || e}`);
  }
}

/** Row, then file (see header). `archive`: the row (store.projectArchive). */
export function removeArchive(archive) {
  if (!archive?.archiveId) return;
  store.deleteProjectArchive(archive.archiveId);
  fileGone(archive.projectId, archive.archiveId);
}

/** The delete path: the files of the ids whose rows are already gone. */
export function removeArchiveFiles(projectId, ids) {
  for (const id of ids || []) fileGone(projectId, id);
}

// ── The restart-grace hook "project-archive" ────────────────────────────────────────────────────────────────────────

export function cleanArchive() {
  const out = { files: 0, rows: 0 };
  if (!projectboxOps()) return out;
  // (b) rows whose project is gone — first: their file falls along, (a) no longer sees it afterwards.
  for (const a of store.projectArchiveAll()) {
    if (store.getProject(a.projectId)) continue;
    removeArchive(a);
    out.rows += 1;
  }
  // (a) files without a row, per runtime folder of a project (the flat location has no folder `setup`).
  for (const location of allLocations()) {
    if (!location.projectId || !location.setup) continue;
    let entries;
    try { entries = entriesInArea(location.setup, areaInRuntimeFolder(location.setup)); }
    catch (e) {
      if (e?.code !== "ENOENT") console.warn(`[setup] restart grace: ${path.basename(location.root)}/setup not readable: ${e?.code || e?.message || e}`);
      continue;
    }
    for (const e of entries) {
      const id = archiveIdFromName(e.name);
      if (!id) continue;
      const row = store.projectArchive(id);
      if (row && row.projectId === location.projectId) continue;
      fileGone(location.projectId, id);
      out.files += 1;
    }
  }
  if (out.files || out.rows) console.log(`[setup] restart grace: removed ${out.files} archive file(s) without a row, ${out.rows} row(s) without a project`);
  return out;
}

/** The consumer in server.js (returns undefined: holds neither start nor quiet). */
export function archiveRestartGrace() {
  try { cleanArchive(); } catch (e) { console.error(`[setup] restart grace "project-archive": ${e?.message || e}`); }
}
