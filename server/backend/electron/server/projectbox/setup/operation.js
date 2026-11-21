// Upload operations and staging areas. Table `project_upload` (store/project-setup.js).
//
// STAGING. Every folder and file source is written to `<root>/.cbase-source-<seq>/` (subtree = the target paths relative to the
// root), a later upload to `.cbase-upload-<operation>/`. The folder belongs to cbase only: created INSIDE the container
// (runtime/fileAccess.js `create`), a dot folder (layout, list, findRepos skip it; the project repo excludes `/.cbase-*/`,
// projectRepo.js staging areas), the same disk as the target (a rename across two mount points would fail with EXDEV — hence not
// in the runtime folder).
//
//   stagingName(seq) / stagingAbs(root, seq)   the place of a creation source
//   createStaging(inst, abs, { signal })     create in the container (EEXIST with a folder is fine; a reference or a file there throws)
//   beginCreation({ projectId, source, inst, root, paths, operation })
//                                            ONE computation for `sources/:seq/begin` (and `upload/begin`): create the operation or
//                                            return the same one (idempotent while the source is in `wait-upload`), plus the sizes of the
//                                            files in `paths` that are already STAGED — read through the descriptor without a reference
//                                            (statInArea, area = the staging under the anchor project root), never at the target.
//   chunkBegins(operation, projectId?, { begin, kind }) → end()
//                                            every chunk request with `operation` (POST /api/projects/:id/upload,
//                                            devtools/code-route.js) — `last_chunk` in the row and the upload stamp
//                                            (runtime/upload-stamp.js); `end` at the end of the request. If the operation is in the
//                                            ADDRESS, at the BEGINNING (before the body); if it is in the BODY (web and iOS), after
//                                            reading — until then the request was "unsettled" in the project's stamp, `begin` is its
//                                            beginning. An empty or unknown operation ⇒ OPERATION_UNKNOWN; with `projectId` a foreign one
//                                            ⇒ OPERATION_FOREIGN; an operation of another kind (`kind`, default `files`; the archive's chunk
//                                            route asks `archive`) ⇒ 409 OPERATION_KIND — an archive's operation takes no file chunks and
//                                            the other way round.
//   beginArchive({ projectId, source, archiveId?, bytes, fresh?, name? }) → { operation, archiveId, size }
//                                            `sources/:seq/begin` of a ZIP source. Synchronous (no await between check and create — a
//                                            second tab already sees the row). If the source has an archive in `upload`, it is THE SAME
//                                            (with `size` at the descriptor — resuming never starts at zero); otherwise the operation
//                                            (`kind: archive`), the archive row, the ids on the source and LAST the empty file
//                                            (archive.js createArchive) are created. An archive of the source in another state (or of a
//                                            foreign project) is a leftover and drops. A `archiveId` sent along that is not the source's
//                                            ⇒ 409 ARCHIVE_FOREIGN (the client begins without it). If the archive already holds bytes and
//                                            `bytes` is not the size announced last ⇒ 409 ARCHIVE_DIFFERENT `{ bytes, size }`
//                                            (archiveDifferent), `bytes` stays; with `fresh: true` the same archive begins from the start
//                                            (truncated to 0, `size: 0`, `name` becomes the source's name).
//   targetInOperation(operation, path) → abs the place of a chunk — ONLY under the operation's staging, an invalid path throws.
//   writeChunks(operation, root, { dir, files })
//                                            the chunks of a request, each ONLY into the staging (targetInOperation), through the
//                                            descriptor without a reference (area = the staging under the anchor project root,
//                                            runtime/real-path.js writeInArea `offset`): `offset` mandatory per chunk — 0 replaces, > 0
//                                            appends only if it equals the size at the opened descriptor (else 409 OFFSET with `size`,
//                                            the file unchanged). An invalid chunk (400 CHUNK) rejects the WHOLE request before anything
//                                            is written. A full disk (ENOSPC — the check at `begin` is no reservation) is 409 SLOT with
//                                            a readable text (instead of the raw system text).
//   setChunkWriter(fn)                       seam for tests: a chunk's writer (default runtime/real-path.js writeInArea).
//   dismissOperation(inst, root, operation)  delete the staging in the container, row gone.
//   uploadStagingName(operation)             the place of a LATER operation, `.cbase-upload-<operation>` (a UUID — else it throws).
//   chunkBegins also asks the layout job (./status.js layoutStatus): while `running` ⇒ 409 LAYOUT_RUNNING — the layout is moving the
//   project's folders right now.
//
// The operation survives every restart (row + staging); resuming starts at the size at the descriptor — safe because the staging holds
// only files this operation began.
import crypto from "node:crypto";
import path from "node:path";
import * as store from "../../store.js";
import * as access from "../../runtime/fileAccess.js";
import { T } from "../../i18n.js";
import { realRoots, writeInArea, statInArea } from "../../runtime/real-path.js";
import { uploadBegins } from "../../runtime/upload-stamp.js";
import { removeArchive, archiveSize, createArchive } from "./archive.js";
import { uploadPath } from "./rules.js";
import { layoutStatus } from "./status.js";

export const PATHS_PER_STACK = 5000;
export const stagingName = (seq) => `.cbase-source-${Number(seq)}`;
export const stagingAbs = (root, seq) => path.join(path.resolve(String(root)), stagingName(seq));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The place of a later operation (header). */
export function uploadStagingName(operation) {
  if (!UUID.test(String(operation || ""))) throw new TypeError(`staging: not an operation ("${String(operation).slice(0, 40)}")`);
  return `.cbase-upload-${operation}`;
}

export class OperationError extends Error {
  constructor(code, message, status = 409, fields = {}) {
    super(message);
    this.name = "OperationError";
    this.code = code;
    this.status = status;
    Object.assign(this, fields);
  }
}

export async function createStaging(inst, abs, { signal = null } = {}) {
  try { await access.create(inst, abs, "folder", { withoutDeadline: true, ...(signal ? { signal } : {}) }); }
  catch (e) {
    if (e?.code !== "EEXIST") throw e;
    const st = await access.stat(inst, abs, { withoutDeadline: true, ...(signal ? { signal } : {}) });
    if (st?.kind !== "folder") throw new OperationError("STAGING", T`${path.basename(abs)} is not a folder (${st?.kind || "missing"}) — the staging belongs only to cbase`, 409);
  }
}

/** The sizes of the already staged files from `paths` (relative to the target) — through the descriptor, without following a reference. */
export function stagedSizes(root, stagingRel, paths) {
  const w = path.resolve(String(root));
  const b = path.join(w, stagingRel);
  let area;
  try { area = realRoots([b], [w]); } catch { return []; }
  const out = [];
  for (const p of paths) {
    const rel = typeof p?.path === "string" ? p.path : "";
    if (uploadPath(rel).error) continue;
    try {
      const st = statInArea(path.join(b, rel), area);
      if (st.isFile()) out.push({ path: rel, size: st.size });
    } catch { /* missing or outside — not staged */ }
  }
  return out;
}

function pathsFrom(paths) {
  if (paths === undefined || paths === null) return [];
  if (!Array.isArray(paths)) throw new OperationError("PATHS", T("“paths” is not a list"), 400);
  if (paths.length > PATHS_PER_STACK) throw new OperationError("PATHS", T`At most ${PATHS_PER_STACK} paths per batch (${paths.length})`, 400);
  for (const p of paths) {
    const r = uploadPath(typeof p?.path === "string" ? p.path : null);
    if (r.error) throw new OperationError("PATHS", T`Path “${String(p?.path ?? "").slice(0, 200)}”: ${r.error}`, 400);
  }
  return paths;
}

/**
 * `sources/:seq/begin`: `{ operation, existing }`. The checks of state, space and `UPLOAD_RUNNING` are the route's, beforehand; here
 * only operation, staging and sizes. Idempotent: if the source already has an operation in `upload`, it is the same one — a foreign
 * `operation` sent along is 409 `OPERATION_FOREIGN`.
 */
export async function beginCreation({ projectId, source, inst, root, paths, operation = null, signal = null }) {
  const list = pathsFrom(paths);
  const staging = stagingName(source.seq);
  let v = source.operation ? store.projectUpload(source.operation) : null;
  if (v && v.state !== "upload") v = null;
  if (operation && (!v || v.operation !== String(operation))) throw new OperationError("OPERATION_FOREIGN", T("The upload does not belong to this source"), 409);
  await createStaging(inst, path.join(path.resolve(String(root)), staging), { signal });
  // During the await a second `begin` (second tab) may have created the operation — then it is the same one, not a second that
  // displaced the first from the source.
  if (!v) {
    const fresh = store.sourceOf(projectId, source.seq);
    const found = fresh?.operation ? store.projectUpload(fresh.operation) : null;
    if (found && found.state === "upload") v = found;
  }
  if (!v) {
    const fresh = crypto.randomUUID();
    v = store.createProjectUpload({ operation: fresh, projectId, purpose: "creation", sourceSeq: source.seq, kind: "files", staging });
    store.changeSource(projectId, source.seq, { operation: fresh });
  }
  return { operation: v.operation, existing: stagedSizes(root, staging, list) };
}

/**
 * Archive identity: if the source's archive (in `upload`) already holds bytes and `begin` announces a DIFFERENT size than the one
 * announced last (`source.bytes`), it is another archive — the client would otherwise append foreign bytes.
 * → OperationError 409 ARCHIVE_DIFFERENT with `{ bytes: <announced last>, size: <in the archive> }`, or null.
 */
export function archiveDifferent(projectId, source, bytes) {
  const pid = String(projectId);
  const a = source?.archiveId ? store.projectArchive(source.archiveId) : null;
  if (!a || a.projectId !== pid || a.state !== "upload") return null;
  let size = 0;
  try { size = archiveSize(pid, a.archiveId); } catch { size = 0; }
  if (size <= 0 || bytes === source.bytes) return null;
  return new OperationError("ARCHIVE_DIFFERENT", T(
    "The chosen archive is larger or smaller than the one that was being uploaded — upload from the start (“fresh”) or choose the same archive.",
  ), 409, { bytes: source.bytes, size });
}

/** `sources/:seq/begin` of a ZIP source (header). State, space and `UPLOAD_RUNNING` are checked by the route beforehand. `bytes`: the
 *  announced size (set only AFTER the ARCHIVE_DIFFERENT check — archiveDifferent); `fresh === true`: the archive begins from the
 *  start — the same id, the file truncated to 0 (at the descriptor, archive.js createArchive), `name` (checked by the route) becomes
 *  the source's name. */
export function beginArchive({ projectId, source, archiveId = null, bytes, fresh = false, name = null }) {
  const pid = String(projectId);
  let q = store.sourceOf(pid, source.seq) || source;
  let a = q.archiveId ? store.projectArchive(q.archiveId) : null;
  if (q.archiveId && (!a || a.projectId !== pid || a.state !== "upload" || !a.operation)) {
    // A leftover (an archive that no longer uploads, or an id without a row): gone with its operation, the source begins anew.
    if (a && a.projectId === pid) removeArchive(a);
    if (q.operation) store.deleteProjectUpload(q.operation);
    q = store.changeSource(pid, q.seq, { archiveId: "", operation: "" }) || q;
    a = null;
  }
  if (archiveId !== null && archiveId !== undefined && (!a || a.archiveId !== String(archiveId))) {
    throw new OperationError("ARCHIVE_FOREIGN", T("The archive does not belong to this source — begin again without “archiveId”."), 409);
  }
  if (fresh !== true) {
    const different = archiveDifferent(pid, q, bytes);
    if (different) throw different;
  }
  q = store.changeSource(pid, q.seq, { bytes, ...(fresh === true && typeof name === "string" ? { name } : {}) }) || q;
  if (a && fresh === true) createArchive(pid, a.archiveId); // from the start: the same id, the file at 0
  if (!a) {
    const newId = crypto.randomUUID();
    const operation = crypto.randomUUID();
    // Rows before the file: if B dies in between, the post-start hook finds no file without a row, and `begin` creates it.
    store.createProjectUpload({ operation, projectId: pid, purpose: "creation", sourceSeq: q.seq, kind: "archive", staging: stagingName(q.seq) });
    a = store.createProjectArchive({ archiveId: newId, projectId: pid, operation, purpose: "creation", target: q.target || "" });
    q = store.changeSource(pid, q.seq, { archiveId: newId, operation }) || q;
    createArchive(pid, newId);
  } else {
    // The same operation: if its row is missing (a delete path that died between the rows), it is recreated under the archive's id.
    if (!store.projectUpload(a.operation)) {
      store.createProjectUpload({ operation: a.operation, projectId: pid, purpose: "creation", sourceSeq: q.seq, kind: "archive", staging: stagingName(q.seq) });
    }
    if (q.operation !== a.operation) store.changeSource(pid, q.seq, { operation: a.operation });
  }
  return { operation: a.operation, archiveId: a.archiveId, size: archiveSize(pid, a.archiveId) };
}

/** At the BEGINNING of every chunk request with `operation` (marks the project `busy`). → end() (at the end of the request). If the
 *  operation is in the BODY (devtools/routes.js), the path calls it only after reading — `begin` is then the beginning of the request
 *  (`last_chunk` is the BEGINNING of the last chunk request), and the project's stamp was there before ("unsettled",
 *  runtime/upload-stamp.js). */
export function chunkBegins(operation, projectId = null, { begin, kind = "files" } = {}) {
  const v = typeof operation === "string" && operation ? store.projectUpload(operation) : null;
  if (!v) throw new OperationError("OPERATION_UNKNOWN", T("Unknown upload"), 409);
  if (projectId && v.projectId !== String(projectId)) throw new OperationError("OPERATION_FOREIGN", T("The upload does not belong to this project."), 409);
  if (v.kind !== kind) throw new OperationError("OPERATION_KIND", T`The upload is of kind “${v.kind}” and accepts no chunks here.`, 409);
  if (v.state !== "upload") throw new OperationError("OPERATION_CLOSED", T("The upload accepts no more chunks"), 409);
  // `running` and `error` after the turnaround judge the same (the tree is half rebuilt); "unknown" (the reader threw) blocks — empty
  // is not unknown. In `waiting` an open operation takes chunks: it is a holder, the adoption waits for it (projectbox/layout/job.js).
  if (["running", "error", "unknown"].includes(layoutStatus(v.projectId))) {
    throw new OperationError("LAYOUT_RUNNING", T("The project's layout is being applied — continue afterwards."), 409);
  }
  const end = uploadBegins(v.projectId, v.operation);
  store.changeProjectUpload(v.operation, { lastChunk: Number.isSafeInteger(begin) && begin > 0 ? begin : Date.now() });
  return end;
}

/** The place of a chunk — only under the operation's staging. */
export function targetInOperation(operation, filePath, root) {
  const v = store.projectUpload(operation);
  if (!v) throw new OperationError("OPERATION_UNKNOWN", T("Unknown upload"), 409);
  const r = uploadPath(typeof filePath === "string" ? filePath : null);
  if (r.error) throw new OperationError("PATHS", T`Path: ${r.error}`, 400);
  return path.join(path.resolve(String(root)), v.staging, ...r.parts);
}

const chunkError = (text) => new OperationError("CHUNK", text, 400);

let chunkWriter = writeInArea;
/** Seam (header): a test makes the writer throw ENOSPC. Without a function the real one again. */
export function setChunkWriter(fn) { chunkWriter = typeof fn === "function" ? fn : writeInArea; }

/** The chunks of ONE request with an operation (header). → `{ written }`. An error in the middle of the batch carries `written`. */
export function writeChunks(operation, root, { dir = "", files = [] } = {}) {
  const v = store.projectUpload(operation);
  if (!v) throw new OperationError("OPERATION_UNKNOWN", T("Unknown upload"), 409);
  if (v.kind === "archive") throw new OperationError("OPERATION_KIND", T("The upload belongs to an archive — its chunks go to …/archive."), 409);
  if (v.state !== "upload") throw new OperationError("OPERATION_CLOSED", T("The upload accepts no more chunks"), 409);
  if (!Array.isArray(files)) throw chunkError(T("“files” is not a list."));
  const front = String(dir ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  // Check EVERYTHING first — an invalid chunk writes nothing, not even a valid one before it.
  const chunks = files.map((f) => {
    const raw = String(f?.path ?? "").replace(/\\/g, "/");
    if (f?.append !== undefined) throw chunkError(T`${raw}: “append” only applies without an upload id — a chunk carries “offset”.`);
    const offset = f?.offset;
    if (!Number.isSafeInteger(offset) || offset < 0) throw chunkError(T`${raw}: “offset” is required (integer ≥ 0).`);
    const rel = front ? `${front}/${raw}` : raw;
    const r = uploadPath(rel);
    if (r.error) throw chunkError(T`Path “${rel.slice(0, 200)}”: ${r.error}`);
    return { rel, offset, abs: path.join(path.resolve(String(root)), v.staging, ...r.parts), data: Buffer.from(String(f?.dataB64 || ""), "base64") };
  });
  const w = path.resolve(String(root));
  const area = realRoots([path.join(w, v.staging)], [w]);
  // Only the container creates the staging (createStaging) — if it is missing or a reference, B writes nothing.
  let st = null;
  try { st = statInArea(path.join(w, v.staging), area); } catch { st = null; }
  if (!st?.isDirectory()) {
    throw new OperationError("STAGING", T`${v.staging} is missing or not a folder — “begin” recreates it in the project container.`, 409);
  }
  let written = 0;
  for (const st of chunks) {
    try { chunkWriter(st.abs, st.data, area, { display: st.rel, offset: st.offset }); }
    catch (e) {
      if (e?.code === "OFFSET") {
        throw new OperationError("OFFSET", T`${st.rel}: the chunk starts at ${st.offset}, ${e.size} bytes are staged — continue at “size” or restart at 0.`, 409, { path: st.rel, size: e.size, written });
      }
      if (e?.code === "EOUTSIDE") throw new OperationError("EOUTSIDE", String(e.message || e), 409, { path: st.rel, written });
      if (e?.code === "ENOSPC") {
        throw new OperationError("SLOT", T`No space left on the server's disk — ${st.rel} is not fully staged. Free some space and continue.`, 409, { path: st.rel, written });
      }
      throw Object.assign(e, { written });
    }
    written += 1;
  }
  return { written };
}

/** Delete the staging in the container (a missing one is no error), row gone. */
export async function dismissOperation(inst, root, operation, { signal = null } = {}) {
  const v = store.projectUpload(operation);
  if (!v) return false;
  try { await access.erase(inst, path.join(path.resolve(String(root)), v.staging), { withoutDeadline: true, ...(signal ? { signal } : {}) }); }
  catch (e) { if (e?.code !== "ENOENT") throw e; }
  store.deleteProjectUpload(v.operation);
  return true;
}
