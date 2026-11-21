// The state of a setup, outward. A leaf above the data layer — imports only node:fs/node:path, store, app-state, ops and the two
// leaves runtime/real-path.js and runtime/upload-stamp.js — so readers without a procedure (the workspaces' and projects' routes, the
// chat lock, /api/runs/active, the write lock in devtools/ and workspaces/) reach it without a cycle.
//
//   setupField(projects)   ONE computation for `GET /api/workspaces`, `GET /api/workspaces/:id` and `GET /api/projects`: per project
//                          with an open setup the field `setup` (store setupView — a row whose server step carries a FOREIGN `process`
//                          is computed as `error`/`INTERRUPTED`); without a row no field, without ops the list unchanged (byte-equal).
//                          Plus `remoteHints` (setupFor), also after the setup has ended.
//   setupRunning(pid)      is a server step of this setup running RIGHT NOW in THIS process (boot id)? — the reason "setup" of the
//                          lock and the write lock `SETUP_RUNNING` ask here.
//   sourceRunning(pid, seq)       is a server step of the project or of THIS source running RIGHT NOW, or its `leaveOut`? — the source
//                          routes.
//   leaveOutBegins(pid, seq) → end(), leaveOutRunning(pid, seq?)
//                          while `leaveOut` waits for the delete in the container, the source counts as running — for the source
//                          routes (through sourceRunning), "retry" (./procedure.js, per project) and the unpacking of an interrupted
//                          source (./procedure.js unpackSource then does not take it over).
//   setupOpen(pid)       is there an open setup row (every step, `error` too)? — the copy lock `NO_COPY_DURING_SETUP` and the
//                          adoption of the layout ask here.
//   setupAtPath(wid, paths)  the write lock of the WORKSPACE level (devtools/code-route.js): `{ projectId, name }` of the first project
//                          of this workspace whose server step is running RIGHT NOW (setupRunning) and which touches one of the
//                          absolute `paths` — the path lies in the project folder OR the project folder under the path (a delete,
//                          rename or git of the parent folder hits it too). The wording AND the real place are compared (realpath of the
//                          deepest existing ancestor): a reference in the workspace to the project folder hits it too. Without `paths`
//                          (undefined): the first running project of the workspace at all — the question whether reading the body is
//                          worth it. Else null. Plus every project whose layout writes (layoutWriteLock) — then with
//                          `code: "LAYOUT_RUNNING"`.
//   setDetectionReader(fn)       THE SEAM for detection: fn(projectId) → `{ status, since }` or null; carries the field `detection`.
//                          Unset: no field.
//
// Later upload:
//   setLayoutReader(fn), layoutStatus(pid)
//                          THE SEAM for the layout: fn(projectId) → the state of the layout job (`waiting` · `running` · `error`) or
//                          null (no job). Unset it is always null. `layoutStatus` gives `null`, `waiting`, `running`, `error` or
//                          `unknown` (another value, a throw: empty is not unknown — the caller blocks). The callers: ./upload.js
//                          uploadLock (409 LAYOUT_WAITING or LAYOUT_RUNNING) and ./operation.js chunkBegins (a chunk while `running`
//                          ⇒ 409 LAYOUT_RUNNING).
//   layoutWriteLock(pid)
//                          does the layout block every write path in this project RIGHT NOW? `running`, `error` (after the turnaround —
//                          the tree is half rebuilt) and `unknown` (empty is not unknown) yes; `waiting` no (work may continue there,
//                          the quiet waits). The project level's write paths (devtools/routes.js `setupLock`), the start of a service
//                          (projects/routes.js) and — through setupAtPath — the workspace level's answer 409 LAYOUT_RUNNING.
//   uploadBegins(operation, run) → end(), uploadRun(operation)
//                          what is working on a later operation RIGHT NOW (counting before `finish`, placing, unpacking, discarding) —
//                          `run`: `{ projectId, what, controller? }`. Memory of this process only (like `leavingOut`): a restart ends
//                          every piece of work, the row then shows it as interrupted.
//   uploadView(v)          the view of ONE later operation, outward — the field `uploads` per project (see setupFor).
//
// The field `superseded` per project in the SAME computation (setupFor/setupField) — the number of old containers of renamed stacks in
// main (store supersededCount), only if > 0; the button "remove old containers" hangs on it.
import fs from "node:fs";
import path from "node:path";
import { BOOT_ID } from "../../app-state.js";
import * as store from "../../store.js";
import { traverseWithoutReferences, realRoots } from "../../runtime/real-path.js";
import { chunkOpen, uploadQuietMs } from "../../runtime/upload-stamp.js";
import { projectboxOps } from "../ops.js";

let detectionReader = null;
export function setDetectionReader(fn) { detectionReader = typeof fn === "function" ? fn : null; }

// ── The seam for the layout: the state of the layout job (header) ──────────────────────────────────────────────────

let layoutReader = null;
export function setLayoutReader(fn) { layoutReader = typeof fn === "function" ? fn : null; }
const LAYOUT_STATES = Object.freeze(["waiting", "running", "error"]);
export function layoutStatus(projectId) {
  if (!layoutReader) return null;
  let z;
  try { z = layoutReader(String(projectId)); } catch (e) {
    console.warn(`[upload] ${projectId}: layout state not readable: ${e?.message || e}`);
    return "unknown";
  }
  if (z === null || z === undefined) return null;
  return LAYOUT_STATES.includes(z) ? z : "unknown";
}
const LAYOUT_WRITES = new Set(["running", "error", "unknown"]);
export const layoutWriteLock = (projectId) => LAYOUT_WRITES.has(layoutStatus(projectId));

// The job's row for the project list — fn(projectId) → `{ state, turned, backwards, step, error, since, holders }` or null (no job
// or `finished`). Set in server.js (projectbox/layout/job.js: the number of holders computes the quiet only there).
let layoutRowsReader = null;
export function setLayoutRowsReader(fn) { layoutRowsReader = typeof fn === "function" ? fn : null; }

// ONE observer of every report of a later operation (./upload.js calls `uploadReported`) — fn(projectId, state). Set in server.js.
// It triggers a re-check after `finish` or discarding an upload operation.
let uploadObserver = null;
export function setUploadObserver(fn) { uploadObserver = typeof fn === "function" ? fn : null; }
export function uploadReported(projectId, state) {
  if (!uploadObserver) return;
  try { uploadObserver(String(projectId), String(state || "")); } catch (e) { console.error(`[upload] observer (${projectId}):`, e?.message || e); }
}

// ── What is working on a later operation right now (header) ────────────────────────────────────────────────────────

const uploading = new Map(); // operation → { projectId, what, controller? }
export function uploadBegins(operation, run) {
  const k = String(operation);
  uploading.set(k, run);
  return () => { if (uploading.get(k) === run) uploading.delete(k); };
}
export const uploadRun = (operation) => uploading.get(String(operation)) || null;

// "N files staged": counted in B over pinned folders, without following a reference (runtime/real-path.js
// traverseWithoutReferences), only for an operation in `upload` without an open chunk, remembered per `last_chunk` (the files change
// only through chunk requests, and each sets the time at its beginning). Capped, and the cap says so (`capped: true`).
export const STAGED_CAP = 100_000;
const counted = new Map(); // operation → { key, files, capped }
function countStaged(v) {
  const key = String(v.lastChunk || 0);
  const old = counted.get(v.operation);
  if (old && old.key === key) return old;
  const proj = store.getProject(v.projectId);
  if (!proj) return null;
  const w = path.resolve(String(proj.path));
  const b = path.join(w, v.staging);
  let files = 0;
  let capped = false;
  try {
    const area = realRoots([b], [w]);
    traverseWithoutReferences(b, area, (_abs, e) => {
      if (e.isFile()) files += 1;
      if (files >= STAGED_CAP) { capped = true; return "hold"; }
      return e.isDirectory();
    });
  } catch (e) { if (e?.code !== "ENOENT") return null; }
  const fresh = { key, files, capped };
  if (counted.size > 1000) counted.clear();
  counted.set(v.operation, fresh);
  return fresh;
}

/** The view of a later operation (header) — `{ operation, kind, state (upload · place · unpack · error), since, interrupted?,
 *  lastChunk?, staged?, capped?, archiveId?, bytes?, conflict?, code?, error?, existing?, examples?, newFolders }`. "Interrupted": in
 *  `upload` without an open chunk and without one that BEGAN more recently than the upload quiet (`interrupted` with `staged` —
 *  "upload interrupted (N files staged)"); in `place`/`unpack` without THIS process working on it ("placing interrupted"). Resuming is
 *  `finish` (or, for an archive in `upload`, `archive/unpack`), discarding `DELETE …/upload/:operation`. */
export function uploadView(v, { now = Date.now() } = {}) {
  if (!v) return null;
  const out = { operation: v.operation, kind: v.kind, state: v.state, since: v.stateSince, newFolders: v.newFolders };
  const run = uploadRun(v.operation);
  const a = v.kind === "archive" ? store.projectArchiveOfOperation(v.operation) : null;
  if (a) out.archiveId = a.archiveId;
  if (v.lastChunk) out.lastChunk = v.lastChunk;
  if (v.conflict) out.conflict = v.conflict;
  if (v.state === "upload") {
    const open = chunkOpen(v.operation, v.projectId);
    const last = Math.max(Number(v.lastChunk) || 0, Number(v.createdAt) || 0);
    if (!open && !run && now - last >= uploadQuietMs()) out.interrupted = true;
    if (v.kind === "archive") {
      if (a) out.bytes = a.size;
    } else if (!open) {
      const z = countStaged(v);
      if (z) { out.staged = z.files; if (z.capped) out.capped = true; }
    }
  } else if (v.state === "place") {
    if (a) out.state = "unpack"; // the archive drops only after unpacking (./upload.js)
    if (!(run && run.what === "place" && v.process === BOOT_ID)) out.interrupted = true;
  } else if (v.state === "error") {
    if (v.code) out.code = v.code;
    if (v.error) out.error = v.error;
    if (v.code === "CONFLICT" && v.finding) { out.existing = Number(v.finding.existing) || 0; out.examples = Array.isArray(v.finding.examples) ? v.finding.examples.slice(0, 5) : []; }
  }
  return out;
}

export const setupRunning = (projectId) => {
  try { return store.setupServerStepRunning(store.setupOf(String(projectId)), BOOT_ID); } catch { return false; }
};

// `leaveOut` waits for the deletion of the staging in the container (slow) — as long as it does, its source counts as running.
// Without that a simultaneous "retry" (source in `error`) or a `finish` from a second tab would have moved it to `unpack` in the
// meantime, and the leaving-out would then discard the archive and operation of a source that was just being unpacked. Memory of this
// process only (a restart ends every request too).
const leavingOut = new Set(); // `${projectId}\0${seq}`
const leaveKey = (projectId, seq) => `${String(projectId)}\0${Number(seq)}`;
/** `leaveOut` of this source begins → end() (in the route's finally). */
export function leaveOutBegins(projectId, seq) {
  const k = leaveKey(projectId, seq);
  leavingOut.add(k);
  return () => { leavingOut.delete(k); };
}
/** Is a `leaveOut` of this source running (or, without `seq`, of any source of the project)? */
export function leaveOutRunning(projectId, seq) {
  if (seq !== undefined) return leavingOut.has(leaveKey(projectId, seq));
  const front = `${String(projectId)}\0`;
  for (const k of leavingOut) if (k.startsWith(front)) return true;
  return false;
}

/** Is a server step of the PROJECT or of THIS source (unpacking, later cloning) running RIGHT NOW in this process — or its
 *  `leaveOut`? — the question of the source routes (`begin`, `finish`, `leaveOut` ⇒ 409 RUNNING): unpacking ONE source does not hold
 *  up the others (the clients do not repeat `finish`). Without a source in a server state the same as setupRunning. */
export const sourceRunning = (projectId, seq) => {
  try {
    if (leaveOutRunning(projectId, seq)) return true;
    const e = store.setupOf(String(projectId));
    if (!e) return false;
    if (store.setupServerStepRunning({ ...e, sources: [] }, BOOT_ID)) return true;
    return e.sources.some((q) => q.seq === Number(seq) && store.SOURCE_SERVER_STATES.includes(q.state) && q.process === BOOT_ID);
  } catch { return false; }
};
export const setupOpen = (projectId) => {
  try { return Boolean(store.setupOf(String(projectId))); } catch { return false; }
};

// The real place of a (maybe not yet existing) path: realpath of the deepest existing ancestor plus the rest.
function realOrNear(abs) {
  let part = path.resolve(String(abs));
  const rest = [];
  for (let i = 0; i < 4096; i++) {
    try { return path.join(fs.realpathSync(part), ...rest.reverse()); } catch { /* go further up */ }
    const top = path.dirname(part);
    if (top === part) return null;
    rest.push(path.basename(part));
    part = top;
  }
  return null;
}
const below = (a, b) => { const r = path.relative(b, a); return r === "" || (!r.startsWith("..") && !path.isAbsolute(r)); };
const touched = (filePath, project) => below(filePath, project) || below(project, filePath);

export function setupAtPath(workspaceId, paths) {
  let running;
  try { running = store.setups().filter((e) => store.setupServerStepRunning(e, BOOT_ID)); } catch { return null; }
  // The projects whose layout is writing right now (header layoutWriteLock). An unreadable list does not block here — the project
  // level's write paths and the procedure itself (the lock "layout") hold there.
  let structuring = [];
  try { structuring = store.layoutJobs().filter((a) => layoutWriteLock(a.projectId)).map((a) => a.projectId); } catch { structuring = []; }
  const open = [...running.map((e) => ({ projectId: e.projectId })), ...structuring.map((pid) => ({ projectId: pid, code: "LAYOUT_RUNNING" }))];
  for (const e of open) {
    let p;
    try { p = store.getProject(e.projectId); } catch { p = null; }
    if (!p || (workspaceId && String(p.workspaceId) !== String(workspaceId))) continue;
    const info = { projectId: String(p.id), name: String(p.name || ""), ...(e.code ? { code: e.code } : {}) };
    if (paths === undefined) return info;
    const locations = [path.resolve(String(p.path))];
    const real = realOrNear(p.path);
    if (real && real !== locations[0]) locations.push(real);
    for (const x of paths || []) {
      const candidates = [path.resolve(String(x))];
      const ex = realOrNear(x);
      if (ex && ex !== candidates[0]) candidates.push(ex);
      if (candidates.some((k) => locations.some((o) => touched(k, o)))) return info;
    }
  }
  return null;
}

/** A project's field — `{ setup?, detection?, remoteHints?, uploads?, layout?, superseded? }`. `remoteHints`: `[{ repo, remote }]` — a
 *  remote of a code repo whose address carries credentials (names only; the line says "remote <remote> in <repo> contains credentials in
 *  the URL"). Stays after the setup has ended. `uploads`: per open later operation its view (uploadView); without one no field.
 *  `layout`: the layout job as long as it is not `finished` (setLayoutRowsReader). `superseded`: the number of old containers in
 *  main, only > 0. */
export function setupFor(projectId) {
  const pid = String(projectId);
  const out = {};
  const e = store.setupOf(pid);
  if (e) out.setup = store.setupView(e, { bootId: BOOT_ID, instance: store.projectInstance(pid, "main") });
  if (detectionReader) {
    try { const k = detectionReader(pid); if (k) out.detection = k; } catch { /* display only */ }
  }
  try { const h = store.remoteHintsOf(pid); if (h.length) out.remoteHints = h; } catch { /* display only */ }
  try { const u = store.retroactiveOperations(pid).map((v) => uploadView(v)); if (u.length) out.uploads = u; } catch { /* display only */ }
  if (layoutRowsReader) {
    try { const g = layoutRowsReader(pid); if (g) out.layout = g; } catch { /* display only */ }
  }
  try { const n = store.supersededCount(pid); if (n > 0) out.superseded = n; } catch { /* display only */ }
  return out;
}

export function setupField(projects) {
  if (!projectboxOps() || !Array.isArray(projects)) return projects;
  let withRow;
  try {
    withRow = new Set(store.setups().map((e) => e.projectId));
    for (const pid of store.remoteHintProjects()) withRow.add(pid);
    for (const pid of store.retroactiveProjects()) withRow.add(pid);
    if (layoutRowsReader) for (const a of store.layoutJobs()) if (a.state !== "finished") withRow.add(a.projectId);
    for (const pid of store.supersededProjects()) withRow.add(pid);
  } catch { return projects; }
  if (!withRow.size && !detectionReader) return projects;
  return projects.map((p) => {
    if (!p || (!withRow.has(String(p.id)) && !detectionReader)) return p;
    const f = setupFor(p.id);
    return Object.keys(f).length ? { ...p, ...f } : p;
  });
}
