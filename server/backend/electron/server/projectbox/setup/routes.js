// The routes of the setup.
//
//   GET  /api/projectCreation/rules                     `projectCreationRoutes` (top-level route, ROUTES in server.js) — the
//                                                       ONE version of the rules for web and iOS; also WITHOUT ops (static,
//                                                       touches nothing). Plus `mode` ("container" | "folder", ./rules.js
//                                                       creationMode).
//   POST /api/projects/:id/setup/sources/:seq/begin      `{ bytes, paths?, operation? }` → 200 `{ operation, existing }`;
//                                                       ZIP: `{ bytes, archiveId?, fresh?, name? }` → 200 `{ operation,
//                                                       archiveId, size }` (./operation.js beginArchive — the same
//                                                       `archiveId` while the source is in `wait-upload`; `size` at the
//                                                       descriptor). If bytes already lie in the archive and `bytes` is not
//                                                       the size announced last ⇒ 409 ARCHIVE_DIFFERENT `{ bytes, size }`,
//                                                       nothing changed; `fresh: true` (exactly true) ⇒ the same archive
//                                                       from the start (cut to 0, `size: 0`), `name` (only with `fresh`; not
//                                                       empty, ≤ 255, without "/" and NUL, otherwise 400 NAME) becomes the
//                                                       name of the source
//   POST /api/projects/:id/setup/sources/:seq/finished   → 202 (folder/files → `staged`); ZIP: `{ archiveId, size }` → 202,
//                                                       archive and source → `unpack` (./procedure.js). "Take as is": in
//                                                       `error`/`aborted` ONLY with `{ takeOver: true }` → 202 `staged` with
//                                                       what lies in the staging (ZIP: the archive falls); without ⇒ 409
//                                                       SOURCE_STATE (soTakeOver, below)
//   POST /api/projects/:id/setup/sources/:seq/abort      → 202 (only unpacking/cloning)
//   POST /api/projects/:id/setup/sources/:seq/leaveOut   → 202 ("Continue without this source"; ZIP: the archive falls too).
//                                                       While it waits for the deletion in the container the source counts
//                                                       as running (409 RUNNING for its begin/finished/leaveOut and for
//                                                       "Try again"), the final write is conditional (409 SOURCE_STATE,
//                                                       archive and operation stay)
//   POST /api/projects/:id/setup/conflict               `{ mode }` → 202 (the conflict question)
//   POST /api/projects/:id/setup/again                  → 202 ("Try again")
//   POST /api/projects/:id/archive[?archiveId=<id>]     ONE chunk of an archive, `{ archiveId, offset, dataB64 }` → 200
//                                                       `{ ok, size }` (archiveChunk, below). `?archiveId=` (recommended)
//                                                       stamps the operation BEFORE the body; without it the request counts
//                                                       as "unresolved" for the project until it is read. Also the chunks of
//                                                       an AFTER-THE-FACT archive (./upload.js archiveForRetroactive).
//   After-the-fact upload — the computation and the bodies are in the header of ./upload.js:
//   POST   /api/projects/:id/upload/begin               → 200 `{ operation, existing, examples, existingPaths, staged,
//                                                       newFolders }` (files) or `{ operation, archiveId, size }` (ZIP);
//                                                       409 TARGET_BLOCKED `{ count, examples }` (files, no operation)
//   POST   /api/projects/:id/upload/:operation/finished → 202 `{ ok, upload }` (also resuming); 409 CONFLICT `{ existing,
//                                                       examples }`, REPO_EXISTING `{ folder }`, TARGET_BLOCKED, STAGING
//   POST   /api/projects/:id/upload/:operation/abort    → 202 `{ ok, upload }`; 409 NOT_ABORTABLE
//   DELETE /api/projects/:id/upload/:operation          → 200 `{ ok }` (discard)
//   POST   /api/projects/:id/archive/check              → 200 `{ operation, target, parentFolder, files, folder, references,
//                                                       sizeDeclared, omitted, existing, examples, throughReference, hints }`;
//                                                       409 REPO_EXISTING, TARGET_BLOCKED
//   POST   /api/projects/:id/archive/unpack             `{ operation, mode? }` → 202 `{ ok, upload }`; without `mode` "keep",
//                                                       one other than overwrite/skip 400 MODE; 409 REPO_EXISTING,
//                                                       TARGET_BLOCKED
//   Locks (begin, finished, check, unpack): 409 SETUP_RUNNING, LAYOUT_WAITING, LAYOUT_RUNNING, NOT_READY.
//   All below /api/projects/:id: `setupProjectRoutes`, a sub-slice of `projectRoutes` (projects/routes.js; ctx carries
//   `pid`, `sub`, `proj`). WITHOUT ops 404 before anything happens. From a project network the fence rejects them
//   (../fence-table.js, rows "project-setup", "project-archive", "project-upload"): only the human sets up and uploads.
//
//   projectCreateInOps(body, { res, ws })   the switch at the start of POST /api/workspaces/:id/projects
//                                           (workspaces/routes.js) — check (./sources.js, 400 and nothing is created),
//                                           folder WITHOUT links, runtime folder, project, instance row `create` WITH
//                                           `convertedAt` and setup row in ONE synchronous step before the 201;
//                                           afterwards ./procedure.js runs asynchronously.
//
// Codes (besides those of the check, ./sources.js, and of the procedure, ./procedure.js): NO_SETUP, SOURCE_UNKNOWN,
// NOT_READY, SOURCE_STATE, BYTES, UPLOAD_RUNNING, SLOT (with `free`, `needed`), PATHS, OPERATION_FOREIGN, STAGING, RUNNING,
// WAITING_FOR_UPLOAD, MODE, NO_CONFLICT, NOT_ABORTABLE, PATH_REFERENCE, FOLDER, WORKSPACE_GETS_DELETED, RUNTIME, CREATION.
// ZIP: ARCHIVE (400, no valid `archiveId`), ARCHIVE_FOREIGN (409, not the archive of this project or source — begin again
// without `archiveId`), ARCHIVE_CLOSED (409, the archive accepts no more chunks: reported finished, left out, source not
// in `wait-upload`), ARCHIVE_LOCATION (400, `archiveId` differs between address and body), ARCHIVE_INCOMPLETE (409 with
// `size` at the descriptor and `expected`), SIZE (400), CHUNK (400, `offset`/`dataB64` missing or the chunk reaches
// beyond the announced `bytes`), OFFSET (409 with `size` — continue from there), OPERATION_KIND (409, ./operation.js),
// EOUTSIDE or ENOFILE (409, the archive file is a link leading out or not a file), ARCHIVE_DIFFERENT (409 with `bytes`,
// `size`) and NAME (400). After-the-fact: OPERATION_UNKNOWN (404), OPERATION_CLOSED, OPERATION_KIND, SETUP_RUNNING,
// LAYOUT_WAITING, LAYOUT_RUNNING, CONFLICT (with `existing`, `examples`), REPO_EXISTING (with `folder`),
// ARCHIVE_MISSING, ARCHIVE, TARGET, UNPACK, OCCUPIED, ROOT (all 409).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as store from "../../store.js";
import { BOOT_ID } from "../../app-state.js";
import { T } from "../../i18n.js";
import * as access from "../../runtime/fileAccess.js";
import { NEXT, readBody, send } from "../../runtime/http.js";
import { chunkOpen, uploadBegins } from "../../runtime/upload-stamp.js";
import { isArchiveId, createLocation, createWorktreeRoot, locationFor, worktreeRoot } from "../../runs/runtime-location.js";
import { createFolderInRuntimeFolder } from "../../runs/runtime-write.js";
import { slugify } from "../../workspaces/git-auth.js";
import { MAIN } from "../creation.js";
import { ONLY_IN_OPS, projectboxOps } from "../ops.js";
import { cliHomeFolder } from "../cli-home.js";
import { setInstanceState } from "../instances.js";
import { runInstance } from "../run-instance.js";
import { workspaceGetsDeleted } from "../idle.js";
import { projectInstanceField } from "../names.js";
import { setupAgain, resumeSetup, conflictResponse, reportSetup, abortSource, startSetup } from "./procedure.js";
import { removeArchive, archiveSize, writeArchiveChunk } from "./archive.js";
import { stagedBytes } from "./provisioner.js";
import { startArchiveUnpack, archiveForRetroactive, checkArchive, uploadAbort, beginUpload, uploadFinished, dismissUpload } from "./upload.js";
import { SlotError, checkSlot } from "./slot.js";
import { checkCreation } from "./sources.js";
import { creationMode, rulesResponse } from "./rules.js";
import { setupField, sourceRunning, leaveOutBegins } from "./status.js";
import { OperationError, archiveDifferent, beginCreation, beginArchive, stagingAbs, chunkBegins } from "./operation.js";

const no = (res, status, code, text, fields = {}) => send(res, status, { code, error: text, ...fields });
// An OperationError as the answer — with its fields (ARCHIVE_DIFFERENT: `bytes`, `size`).
const operationNo = (res, x) => {
  const { name: _name, code, status, ...fields } = x;
  return send(res, status, { code, error: x.message, ...fields });
};
const view = (pid) => store.setupView(store.setupOf(pid), { bootId: BOOT_ID, instance: store.projectInstance(pid, MAIN) });
// What already lies in the archive of a ZIP source (at the descriptor) — an archive that no longer uploads, or an
// unreadable file, counts 0 (beginArchive clears the rest, the check then requires the full space).
function alreadyInArchive(pid, q) {
  const a = q.archiveId ? store.projectArchive(q.archiveId) : null;
  if (!a || a.projectId !== String(pid) || a.state !== "upload") return 0;
  try { return archiveSize(pid, a.archiveId); } catch { return 0; }
}

// ── GET /api/projectCreation/rules (also without ops) ──────────────────────────────────────────────────────────────

export async function projectCreationRoutes(ctx) {
  const { res, p, m } = ctx;
  // `mode`: the creation way — the clients read it HERE, not at /api/health (the gateway answers that itself, see the
  // header of ./rules.js).
  if (p === "/api/projectCreation/rules" && m === "GET") return send(res, 200, { mode: creationMode(), ...rulesResponse() });
  return NEXT;
}

// ── The project folder without links ───────────────────────────────────────────────────────────────────────────────

class FolderError extends Error {
  constructor(code, message, status) { super(message); this.code = code; this.status = status; }
}

// `<ws>/<slug>`, `<ws>/<slug>-2`, … — every candidate by `lstat` (an existing entry, also a link, ⇒ next suffix), created
// NOT recursively (EEXIST ⇒ next), afterwards its real place must be the real workspace folder plus name — otherwise
// 409 PATH_REFERENCE and the folder just created falls again (rmdir follows no link). The comparison is against the
// REAL workspace folder: if the workspace itself lies behind a link (macOS `/var` → `/private/var`), that is no link
// BELOW it.
export function createProjectFolder(wsPath, name) {
  const base = path.resolve(String(wsPath || ""));
  let baseReal;
  try { baseReal = fs.realpathSync(base); if (!fs.statSync(baseReal).isDirectory()) throw new Error("not a folder"); }
  catch { throw new FolderError("FOLDER", T("The workspace folder is missing."), 400); }
  const slug = slugify(name);
  for (let i = 1; i <= 999; i++) {
    const n = i === 1 ? slug : `${slug}-${i}`;
    const p = path.join(base, n);
    try { fs.lstatSync(p); continue; } catch (e) { if (e?.code !== "ENOENT") throw e; }
    try { fs.mkdirSync(p); } catch (e) { if (e?.code === "EEXIST") continue; throw new FolderError("FOLDER", T`Cannot create folder: ${e?.message || e}`, 400); }
    let real = null;
    try { real = fs.realpathSync(p); } catch { real = null; }
    if (real !== path.join(baseReal, n)) {
      try { fs.rmdirSync(p); } catch { /* a link or not empty: stays, the answer says so */ }
      throw new FolderError("PATH_REFERENCE", T("The project folder leads through a link — nothing created."), 409);
    }
    return p;
  }
  throw new FolderError("FOLDER", T("No free folder name for this project."), 409);
}

// ── POST /api/workspaces/:id/projects in ops ───────────────────────────────────────────────────────────────────────

export async function projectCreateInOps(body, { res, ws }) {
  const pr = checkCreation(body);
  if (!pr.ok) return send(res, 400, { code: pr.code, error: pr.error });
  // No new project in a workspace that is being deleted (DELETE /api/workspaces/:id holds its lock over the docker
  // steps, ../idle.js). From here to the 201 no await: the question holds for the synchronous step below.
  if (workspaceGetsDeleted(ws.id)) {
    return no(res, 409, "WORKSPACE_GETS_DELETED", T("The workspace is being deleted — no project can be created in it."));
  }
  let projPath;
  try { projPath = createProjectFolder(ws.path, pr.name); }
  catch (e) { return send(res, e?.status || 500, { code: e?.code || "FOLDER", error: e?.message || String(e) }); }
  const pid = crypto.randomUUID();
  // The runtime folder BEFORE the first run (addDirs only takes what exists): location, worktree root, `~/.local` per
  // project. Before the project — if it fails, nothing is created except the empty folder the answer names.
  try {
    const location = createLocation(locationFor({ projectId: pid, converted: true }));
    createWorktreeRoot(worktreeRoot(location));
    const local = cliHomeFolder(pid).local;
    if (!createFolderInRuntimeFolder(local)) fs.mkdirSync(local, { recursive: true });
  } catch (e) {
    try { fs.rmdirSync(projPath); } catch { /* stays */ }
    return send(res, 500, { code: "RUNTIME", error: T`Cannot create the runtime folder: ${e?.message || e}` });
  }
  // Setup, instance row (WITH convertedAt) and project in the same synchronous step, before the 201 — the project LAST:
  // if a step before it fails, only the two rows fall; a project never falls outside the project deletion.
  let proj;
  try {
    store.createSetup({ projectId: pid, sources: pr.sources, codeRepos: pr.codeRepos, process: BOOT_ID });
    setInstanceState(pid, MAIN, "create", { phase: "prepare", convertedAt: Date.now() });
    proj = store.addProject(ws.id, { id: pid, name: pr.name, path: path.resolve(projPath), createdAt: Date.now() });
  } catch (e) {
    console.error(`[setup] creation ${pid}: ${e?.message || e}`);
    try { store.deleteSetup(pid); } catch { /* */ }
    try { store.deleteProjectInstance(pid); } catch { /* */ }
    try { fs.rmdirSync(projPath); } catch { /* */ }
    return send(res, 500, { code: "CREATION", error: T`Project not created: ${e?.message || e}` });
  }
  reportSetup(pid);
  const [including] = setupField(projectInstanceField([proj]));
  send(res, 201, including);
  startSetup(pid);
  return true;
}

// ── /api/projects/:id/setup/… ──────────────────────────────────────────────────────────────────────────────────────

const SOURCE_RE = /^\/setup\/sources\/(\d{1,4})\/(begin|finished|abort|leaveOut)$/;
// `/upload/<operation>` (DELETE) and `/upload/<operation>/(finished|abort)` (POST) — the operation is a UUID.
const UPLOAD_RE = /^\/upload\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/(finished|abort))?$/;
// Without ops 404 before anything happens; otherwise the `{ status, body }` of the computation.
async function uploadResponse(res, fn) {
  if (!projectboxOps()) return send(res, 404, { error: ONLY_IN_OPS });
  const r = await fn();
  return send(res, r.status, r.body);
}
const runningAlready = (res) => no(res, 409, "UPLOAD_RUNNING", T("An upload is running for this source (a second tab?)."));

// ── POST /api/projects/:id/archive — one chunk of an archive ───────────────────────────────────────────────────────
//
// The offset rule is that of the staging (./archive.js writeArchiveChunk → runtime/real-path.js writeInArea): 0
// replaces, > 0 only appends when it equals the size at the opened descriptor (otherwise 409 OFFSET with `size`). A
// chunk never reaches beyond the `bytes` announced at `begin` (the space check was about that number). The second tab:
// while a chunk is open for the operation of the archive, every further one is 409 UPLOAD_RUNNING
// (runtime/upload-stamp.js — by the open request, never by the clock). The row is read once more after the body: while
// reading, `finished`, `leaveOut` or a deletion may have taken it.

// The archive of a chunk → `{ archive, source?, announced }` or `{ no: [status, code, text] }` (`source` only in the creation).
function archiveForChunk(pid, archiveId) {
  if (!isArchiveId(archiveId)) return { no: [400, "ARCHIVE", T("“archiveId” is required (the id from “begin”).")] };
  const a = store.projectArchive(archiveId);
  if (!a || a.projectId !== String(pid)) return { no: [409, "ARCHIVE_FOREIGN", T("This archive does not belong to this project — begin again without “archiveId”.")] };
  // An AFTER-THE-FACT archive (…/upload/begin with `archive`) has no source — announced is the size at the archive.
  if (a.purpose === "retroactive") return archiveForRetroactive(pid, a);
  const q = store.setupOf(pid)?.sources.find((x) => x.archiveId === a.archiveId) || null;
  if (a.state !== "upload" || !q || q.state !== "wait-upload") {
    return { no: [409, "ARCHIVE_CLOSED", T("This archive accepts no more chunks.")] };
  }
  return { archive: a, source: q, announced: q.bytes };
}

async function archiveChunk(req, res, url, pid) {
  const inAddress = url.searchParams.get("archiveId");
  const ends = [];
  try {
    if (inAddress !== null) {
      const upfront = archiveForChunk(pid, inAddress);
      if (upfront.no) return no(res, ...upfront.no);
      if (chunkOpen(upfront.archive.operation)) return runningAlready(res);
      ends.push(chunkBegins(upfront.archive.operation, pid, { kind: "archive" }));
    } else ends.push(uploadBegins(pid, "", { unresolved: true }));
    const begin = Date.now();
    const b = await readBody(req);
    const archiveId = typeof b?.archiveId === "string" ? b.archiveId : "";
    if (inAddress !== null && archiveId !== inAddress) return no(res, 400, "ARCHIVE_LOCATION", T("“archiveId” differs between address and body."));
    const now = archiveForChunk(pid, archiveId);
    if (now.no) return no(res, ...now.no);
    if (inAddress === null) {
      ends[0].clarified();
      if (chunkOpen(now.archive.operation)) return runningAlready(res);
      ends.push(chunkBegins(now.archive.operation, pid, { begin, kind: "archive" }));
    }
    const { offset, dataB64 } = b;
    if (!Number.isSafeInteger(offset) || offset < 0) return no(res, 400, "CHUNK", T("“offset” is required (integer ≥ 0)."));
    if (typeof dataB64 !== "string") return no(res, 400, "CHUNK", T("“dataB64” is required (base64)."));
    const data = Buffer.from(dataB64, "base64");
    const announced = now.announced;
    if (offset + data.length > announced) {
      return no(res, 400, "CHUNK", T`The chunk reaches beyond the announced size of the archive (${announced} bytes) — call “begin” with the right size.`);
    }
    let size;
    try { size = writeArchiveChunk(pid, archiveId, offset, data); }
    catch (x) {
      if (x?.code === "OFFSET") {
        return no(res, 409, "OFFSET", T`The chunk starts at ${offset}, the archive holds ${x.size} bytes — continue at “size” or restart at 0.`, { size: x.size });
      }
      if (x?.code === "ENOSPC") return no(res, 409, "SLOT", T("No space left on the server's disk — the archive is not fully uploaded. Free some space and continue."));
      if (x?.code === "EOUTSIDE" || x?.code === "ENOFILE") return no(res, 409, x.code, T("The archive file is not a file in the runtime folder (a link?) — nothing written."));
      throw x;
    }
    return send(res, 200, { ok: true, size });
  } catch (x) {
    if (x instanceof OperationError) return send(res, x.status, { code: x.code, error: x.message });
    throw x;
  } finally {
    for (const end of ends) end();
  }
}

// `sources/:seq/finished` of a ZIP source: the archive is complete (`size` == the size at the descriptor) ⇒ archive and
// source `unpack`, the operation `place`, the procedure unpacks (./procedure.js unpackSource). No await after the body.
async function archiveFinished(req, res, pid, seq) {
  const b = await readBody(req);
  const archiveId = b?.archiveId;
  const size = b?.size;
  if (!isArchiveId(archiveId)) return no(res, 400, "ARCHIVE", T("“archiveId” is required (the id from “begin”)."));
  if (!Number.isSafeInteger(size) || size < 0) return no(res, 400, "SIZE", T("“size” is required (the size of the whole archive, integer ≥ 0)."));
  const q = store.sourceOf(pid, seq);
  if (!q || q.state !== "wait-upload") return no(res, 409, "SOURCE_STATE", T`Source ${seq} is not waiting for an upload.`);
  const a = q.archiveId === archiveId ? store.projectArchive(archiveId) : null;
  if (!a || a.projectId !== String(pid)) return no(res, 409, "ARCHIVE_FOREIGN", T("The archive does not belong to this source — begin again without “archiveId”."));
  if (a.state !== "upload") return no(res, 409, "ARCHIVE_CLOSED", T("This archive accepts no more chunks."));
  if (chunkOpen(a.operation, pid)) return runningAlready(res);
  let present;
  try { present = archiveSize(pid, archiveId); }
  catch (x) {
    if (x?.code === "EOUTSIDE" || x?.code === "ENOFILE") return no(res, 409, x.code, T("The archive file is not a file in the runtime folder (a link?)."));
    throw x;
  }
  if (present !== size) {
    return no(res, 409, "ARCHIVE_INCOMPLETE", T`The archive holds ${present} of ${size} bytes — continue at “size”.`, { size: present, expected: size });
  }
  if (!store.changeProjectArchive(archiveId, { state: "unpack", size: present }, { when: { state: "upload" } })) {
    return no(res, 409, "ARCHIVE_CLOSED", T("This archive accepts no more chunks."));
  }
  store.changeSource(pid, seq, { state: "unpack", error: "", code: "", process: "" }, { when: { state: "wait-upload" } });
  if (a.operation) store.changeProjectUpload(a.operation, { state: "place" });
  reportSetup(pid, seq);
  resumeSetup(pid);
  return send(res, 202, { ok: true, setup: view(pid) });
}

// `sources/:seq/finished` with `{ takeOver: true }` in `error`/`aborted` (header): the source becomes `staged` with what
// lies in its staging (a part of the archive after item errors or an abort; nothing after a rejection — the client's
// confirmation names that beforehand), the operation `place` (a later "Try again" after an error while placing leads it
// to `staged`, ./procedure.js restartState). The archive of a ZIP source falls: the choice is made, and "Try again"
// would otherwise unpack it anew over the taken-over staging. No await after the body.
async function soTakeOver(req, res, pid, q) {
  const b = await readBody(req);
  if (b?.takeOver !== true) {
    return no(res, 409, "SOURCE_STATE", T`Source ${q.seq} is not waiting for an upload (${q.state}) — “take as is” requires “takeOver: true”.`);
  }
  // A clone only when it is fetched (`cloneFetched` — without it history and working tree are missing, "Take as is"
  // would take half a `.git`); then it is taken without the missing submodules or LFS files, as it lies in the staging.
  if (q.kind === "clone" && !q.cloneFetched) {
    return no(res, 409, "SOURCE_STATE", T`Source ${q.seq} is not cloned yet — “take as is” only works after the clone (otherwise “Try again”).`);
  }
  if (q.operation && chunkOpen(q.operation, pid)) return runningAlready(res);
  const z = store.changeSource(pid, q.seq, { state: "staged", error: "", code: "", process: "", ...(q.kind === "zip" ? { archiveId: "" } : {}) },
    { when: { state: q.state } });
  if (!z) return no(res, 409, "SOURCE_STATE", T`Source ${q.seq} just changed its state.`);
  if (q.operation) store.changeProjectUpload(q.operation, { state: "place" });
  if (q.kind === "zip" && q.archiveId) removeArchive(store.projectArchive(q.archiveId) || { archiveId: q.archiveId, projectId: pid });
  reportSetup(pid, q.seq);
  resumeSetup(pid);
  return send(res, 202, { ok: true, setup: view(pid) });
}

export async function setupProjectRoutes(ctx) {
  const { req, res, url, m, pid, sub, proj } = ctx;
  if (sub === "/archive" && m === "POST") {
    if (!projectboxOps()) return send(res, 404, { error: ONLY_IN_OPS });
    return archiveChunk(req, res, url, pid);
  }
  // After-the-fact upload — the computation is in ./upload.js (header there).
  if (sub === "/upload/begin" && m === "POST") return uploadResponse(res, () => beginUpload(pid, proj, req));
  if (sub === "/archive/check" && m === "POST") return uploadResponse(res, () => checkArchive(pid, proj, req));
  if (sub === "/archive/unpack" && m === "POST") return uploadResponse(res, () => startArchiveUnpack(pid, proj, req));
  const hm = UPLOAD_RE.exec(sub);
  if (hm && hm[2] === "finished" && m === "POST") return uploadResponse(res, () => uploadFinished(pid, proj, hm[1], req));
  if (hm && hm[2] === "abort" && m === "POST") return uploadResponse(res, () => uploadAbort(pid, hm[1]));
  if (hm && !hm[2] && m === "DELETE") return uploadResponse(res, () => dismissUpload(pid, proj, hm[1]));
  if (!sub.startsWith("/setup/")) return NEXT;
  const qm = SOURCE_RE.exec(sub);
  if (!(m === "POST" && (qm || sub === "/setup/conflict" || sub === "/setup/again"))) return NEXT;
  if (!projectboxOps()) return send(res, 404, { error: ONLY_IN_OPS });
  const e = store.setupOf(pid);

  if (sub === "/setup/again") {
    const r = setupAgain(pid);
    return send(res, r.status, r.body);
  }
  if (sub === "/setup/conflict") {
    const b = await readBody(req);
    const r = conflictResponse(pid, typeof b?.mode === "string" ? b.mode : null);
    return send(res, r.status, r.body);
  }

  const seq = Number(qm[1]);
  const what = qm[2];
  if (!e) return no(res, 409, "NO_SETUP", T("No setup is open for this project."));
  const q = store.sourceOf(pid, seq);
  if (!q) return no(res, 404, "SOURCE_UNKNOWN", T("No such source."));
  if (what === "abort") {
    const r = abortSource(pid, seq);
    return send(res, r.status, r.body);
  }
  // `begin` and `finished` ask the step BEFORE "running" — right after the 201 the setup is in the RUNNING step
  // `container`, and both clients start their uploads at once and only wait on NOT_READY. With RUNNING first every
  // source would fail at the first attempt. In `sources` RUNNING still holds afterwards (a source the server is
  // unpacking or cloning), likewise for `leaveOut` in every step.
  if ((what === "begin" || what === "finished") && (e.state !== "setUp" || e.step !== "sources")) {
    return no(res, 409, "NOT_READY", T`The setup is not accepting uploads right now (step ${e.step}, ${e.state}).`);
  }
  // Per SOURCE — unpacking a ZIP source does not hold up `begin`/`finished` of the others (./status.js sourceRunning).
  if (sourceRunning(pid, seq)) return no(res, 409, "RUNNING", T("The setup is running."));
  const ready = store.projectInstance(pid, MAIN)?.state === "ready";

  // "Take as is": a source in `error`/`aborted` with the EXPLICIT field `takeOver: true` — a missing field says nothing
  // (a `finished` a client repeats after a network error would otherwise silently take a half state).
  if (what === "finished" && ["error", "aborted"].includes(q.state)) return soTakeOver(req, res, pid, q);

  if (what === "begin" || what === "finished") {
    if (q.state !== "wait-upload") return no(res, 409, "SOURCE_STATE", T`Source ${seq} is not waiting for an upload (${q.state}).`);
    if (q.operation && chunkOpen(q.operation, pid)) return no(res, 409, "UPLOAD_RUNNING", T("An upload is running for this source (a second tab?)."));
  }

  if (what === "begin") {
    if (!ready) return no(res, 409, "NOT_READY", T("The project container is not ready yet."));
    const b = await readBody(req);
    const bytes = b?.bytes;
    if (!Number.isSafeInteger(bytes) || bytes < 0) return no(res, 400, "BYTES", T("“bytes” is required (integer ≥ 0)."));
    const inst = runInstance(pid);
    const zip = q.kind === "zip";
    // Archive identity: `fresh` only counts when EXACTLY true (another value counts as none); `name` only with `fresh` —
    // ignored otherwise. An archive with bytes and a different announced size ⇒ 409 ARCHIVE_DIFFERENT, BEFORE the space
    // check (it would otherwise count with the old archive); the binding check is in beginArchive, after the awaits.
    const fresh2 = zip && b?.fresh === true;
    const name = fresh2 ? b?.name : undefined;
    if (name !== undefined && (typeof name !== "string" || !name || name.length > 255 || name.includes("/") || name.includes("\0"))) {
      return no(res, 400, "NAME", T("“name” is the file name of the archive (not empty, at most 255 characters, without “/” and NUL)."));
    }
    if (zip && !fresh2) {
      const different = archiveDifferent(pid, q, bytes);
      if (different) return operationNo(res, different);
    }
    // Required is only what is STILL to come — what an aborted upload already staged has reduced the free space
    // already (rejected only if LESS than the reserve stayed free AFTERWARDS). Measured IN the container (provisioner
    // `size`); `bytes` is the size of the whole selection (both clients send it in every batch). ZIP: what already
    // lies in the archive (at the descriptor; with `fresh` nothing); unpacking checks the space once more against the
    // size of the content.
    try {
      const already = zip ? (fresh2 ? 0 : alreadyInArchive(pid, q)) : await stagedBytes(inst, proj.path, stagingAbs(proj.path, seq));
      await checkSlot(inst, proj.path, Math.max(0, bytes - already));
    } catch (x) {
      if (x instanceof SlotError) return send(res, 409, { code: "SLOT", error: x.message, free: x.free, needed: x.needed });
      throw x;
    }
    // A second tab may have begun between the awaits: the same check once more, on the fresh row.
    const fresh = store.sourceOf(pid, seq);
    if (!fresh || fresh.state !== "wait-upload") return no(res, 409, "SOURCE_STATE", T`Source ${seq} is not waiting for an upload.`);
    if (fresh.operation && chunkOpen(fresh.operation, pid)) return no(res, 409, "UPLOAD_RUNNING", T("An upload is running for this source (a second tab?)."));
    if (sourceRunning(pid, seq)) return no(res, 409, "RUNNING", T("The setup is running."));
    try {
      if (zip) return send(res, 200, beginArchive({ projectId: pid, source: fresh, archiveId: b?.archiveId ?? null, bytes, fresh: fresh2, name }));
      store.changeSource(pid, seq, { bytes });
      return send(res, 200, await beginCreation({ projectId: pid, source: fresh, inst, root: proj.path, paths: b?.paths, operation: b?.operation || null }));
    } catch (x) {
      if (x instanceof OperationError) return operationNo(res, x);
      throw x;
    }
  }

  if (what === "finished") {
    if (q.kind === "zip") return archiveFinished(req, res, pid, seq);
    const z = store.changeSource(pid, seq, { state: "staged" }, { when: { state: "wait-upload" } });
    if (!z) return no(res, 409, "SOURCE_STATE", T`Source ${seq} is not waiting for an upload.`);
    if (q.operation) store.changeProjectUpload(q.operation, { state: "place" });
    reportSetup(pid, seq);
    resumeSetup(pid);
    return send(res, 202, { ok: true, setup: view(pid) });
  }

  if (what === "leaveOut") {
    // "Continue without this source": only this explicit choice discards; the staging falls IN the container.
    const interrupted = store.SOURCE_SERVER_STATES.includes(q.state) && q.process && q.process !== BOOT_ID;
    if (!["error", "aborted", "wait-upload"].includes(q.state) && !interrupted) {
      return no(res, 409, "SOURCE_STATE", T`Source ${seq} cannot be dropped now (${q.state}).`);
    }
    if (q.operation && chunkOpen(q.operation, pid)) return no(res, 409, "UPLOAD_RUNNING", T("An upload is running for this source (a second tab?)."));
    if (!ready) return no(res, 409, "NOT_READY", T("The project container is not ready — the staging folder can only be removed there."));
    // The deletion in the container is slow — until it is back the source counts as running (./status.js
    // leaveOutBegins: `begin`, `finished`, a second `leaveOut` ⇒ 409 RUNNING, "Try again" too, unpacking does not take
    // it over). No await between the checks above and this line. The final write is CONDITIONAL (state and boot id as
    // checked): if a way the lock does not know changed the source after all, `leaveOut` answers 409, and archive and
    // operation stay.
    const end = leaveOutBegins(pid, seq);
    let dropped = false;
    try {
      try { await access.erase(runInstance(pid), stagingAbs(proj.path, seq), { withoutDeadline: true }); }
      catch (x) { if (x?.code !== "ENOENT") return send(res, 500, { code: "STAGING", error: T`Staging folder not removed: ${x?.message || x}` }); }
      const z = store.changeSource(pid, seq, { state: "leftOut", error: "", code: "", process: "", ...(q.kind === "zip" ? { archiveId: "" } : {}) },
        { when: { state: q.state, process: q.process } });
      if (!z) {
        return no(res, 409, "SOURCE_STATE", T`Source ${seq} just changed its state — nothing dropped (the staging folder is empty).`);
      }
      if (q.operation) store.deleteProjectUpload(q.operation);
      // The archive of a ZIP source falls too (row, then file — ./archive.js).
      if (q.kind === "zip" && q.archiveId) removeArchive(store.projectArchive(q.archiveId) || { archiveId: q.archiveId, projectId: pid });
      dropped = true;
    } finally {
      end();
      // Without success: whoever waited during the lock (the unpacking of an interrupted source) starts again.
      if (!dropped) resumeSetup(pid);
    }
    // If placing failed at the LOCATION of the repos (CODE_REPO_LOCATION), every source involved carries the error —
    // also the one whose repo was only wrong together with the left-out one (repo in repo across two sources). Its
    // staging is untouched (the check comes before any placing): back to `staged`, placing checks it on the real tree
    // once more — if it has an error of its OWN, it fails there again, alone.
    const prior = store.setupOf(pid);
    if (prior.state === "error" && prior.code === "CODE_REPO_LOCATION") {
      for (const x of prior.sources) {
        if (x.seq !== seq && x.state === "error" && x.code === "CODE_REPO_LOCATION") {
          store.changeSource(pid, x.seq, { state: "staged", error: "", code: "", process: "" }, { when: { state: "error" } });
          reportSetup(pid, x.seq);
        }
      }
    }
    // If the setup was in error BECAUSE of this source (placing failed at it or at the location of its repos) and
    // depends on no other any more, it goes on. Also the TARGET_OCCUPIED of a clone (placing found its target
    // occupied) — not the TARGET_OCCUPIED of the conflict question ("abort": no source carries the code there).
    const after = store.setupOf(pid);
    const open = after.sources.some((x) => x.state === "error" || x.state === "aborted");
    const dueToClone = after.code === "TARGET_OCCUPIED" && q.kind === "clone" && q.code === "TARGET_OCCUPIED";
    if (after.state === "error" && (["PLACE", "CODE_REPO_LOCATION"].includes(after.code) || dueToClone) && !open) {
      store.changeSetup(pid, { state: "setUp", error: "", code: "", process: "" }, { when: { state: "error" } });
    }
    reportSetup(pid, seq);
    resumeSetup(pid);
    return send(res, 202, { ok: true, setup: view(pid) });
  }
  return NEXT;
}
