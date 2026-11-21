// After-the-fact upload into an existing project. The computation behind the routes (./routes.js setupProjectRoutes):
//
//   beginUpload(pid, proj, req)                POST …/upload/begin
//   uploadFinished(pid, proj, operation, req)  POST …/upload/:operation/finished
//   uploadAbort(pid, operation)                POST …/upload/:operation/abort
//   dismissUpload(pid, proj, operation)        DELETE …/upload/:operation
//   checkArchive(pid, proj, req)               POST …/archive/check
//   startArchiveUnpack(pid, proj, req)         POST …/archive/unpack
//   archiveForRetroactive(pid, a)              the chunk route …/archive for an after-the-fact archive (./routes.js archiveChunk)
// Each returns `{ status, body }`; ./routes.js sends.
//
// THE OPERATION (table `project_upload`, `purpose: retroactive`; staging `.cbase-upload-<operation>/` in the root, created
// IN the container; survives every restart). States: `upload` (chunks arrive) → `place` (the server places or unpacks,
// `process` = the boot id of THIS process — holds `busy`) → the row falls (success). `error` with `code`/`error`
// (CONFLICT with `finding` `{ existing, examples }`, PLACE, UNPACK, SLOT, TARGET, STAGING, REPO_EXISTING, TARGET_BLOCKED,
// …). A `place` this process is not working on (restart, abort) is INTERRUPTED to the outside (./status.js uploadView).
// Resuming = `finished` once more (placing is repeatable: what is no longer in the staging is done; an archive that is
// still there is unpacked anew — the staging is emptied first). No time cap.
//
// LOCKS: `begin`, `finished`, `archive/check` and `archive/unpack` only without an open setup (409 SETUP_RUNNING),
// without a layout job (409 LAYOUT_WAITING while it waits — an upload counts as a holder there, a new one would prolong
// the wait —, 409 LAYOUT_RUNNING otherwise; ./status.js layoutStatus) and with a `ready` instance (409 NOT_READY). `abort`
// and `DELETE` (discard — "stopping" a holder of the layout) always work, `DELETE` only when `ready` (the staging falls
// in the container).
//
// B checks at the target only through pinned folders and follows no link (targetsExisting: lstat per path part, a link is
// in the way); everything that moves, counts or creates files of the project runs in the project container
// (./provisioner.js, runtime/fileAccess.js, ./code-repos.js createCodeRepo, protectStaging). No commit except the first
// one of a new code repo.
//
// PRE-CHECK against the root of NOW, in `begin` (files), `finished`, `archive/check`, `archive/unpack` (synchronous, 409)
// and once more in `run` right before placing (state `error` with the same code):
//   TARGET_BLOCKED `{ count, examples[≤5] }` — a target the provisioner replaces in no mode (a link at the target or on
//     the way, a folder where a file goes, a file in the way of a folder, something else); it does NOT count as
//     `existing`, is not in `existingPaths`, and the first `begin` then creates no operation. If it only appears DURING
//     placing, it stays an item error (PLACE).
//   REPO_EXISTING `{ folder }` — EVERY `.git` of the staging or the archive (not only the outermost) below which
//     something already lies in the root; in addition the provisioner never writes into a `.git` that exists at the target.
//
// `begin` (files · folders): `{ paths: [{ path, size }], operation? }` — batches of at most 5,000 paths, `size` per path
// required (the space check counts what is STILL to come: Σ max(0, size − already staged)). The first call creates
// operation and staging (with `/.cbase-*/` in `.git/info/exclude` of the root repo, protectStaging) and records
// `newFolders` — the top folders of the selection that do NOT exist in the root NOW. A later batch of THE SAME operation
// takes none away but adds top folders that first occur in it.
// → 200 `{ operation, existing (count), examples [≤5], existingPaths, staged: [{ path, size }], newFolders }` or 409
// TARGET_BLOCKED — `existing` is EVERY target file of this batch in whose place a file already lies in the root, whatever
// its size; `existingPaths` the same paths, so that the client does not upload them at all on "skip"; `staged` the sizes
// in the OWN staging (./operation.js stagedSizes) — resuming from a size only happens there.
// `begin` (ZIP): `{ archive: { bytes, name }, operation? }` → 200 `{ operation, archiveId, size }` (operation of kind
// `archive`, archive in the runtime folder, `size` at the descriptor; with `operation` the same one — ARCHIVE_DIFFERENT
// as in the creation when bytes already lie there and `bytes` changed). `name` (the file name) yields the target without
// a top folder (`<zipname>/`, the same rule as the client: zipTarget = workspaces/git-auth.js slugify).
//
// `finished` `{ conflict? }` (`overwrite` | `skip`): the pre-check, then the conflicts against the root of NOW; if there
// are any and no answer (neither here nor stored) ⇒ 409 CONFLICT `{ existing, examples }`. Checked against the staging —
// for an archive whose file is still there (resuming after an error, abort or restart while unpacking), against the
// archive; an archive without a stored and without a given answer places with `keep` like files. In `upload` without a
// staging ⇒ 409 STAGING ("missing = everything placed" only holds in `place`/`error`). Then: a top folder from
// `newFolders` that exists by now (an agent created it) is no longer new (uploading into an existing folder changes
// nothing about its git; once more in `run` through `newOccupied`); state `place` with the own boot id, 202, and
// asynchronously under `withProjectOccupancy(pid, "place")`: the pre-check, placing (mode from the answer; without a
// conflict `keep` — if a target appears meanwhile, it is counted again and the operation goes to `error` CONFLICT),
// `createCodeRepo` per new folder (it leaves out by itself: `.git` brought along, repos inside, inside a code repo, the
// root itself a code repo) — also after a partial placing for every new folder that arrived, only then the error —,
// row gone, event, then the detection with `onlySupplement` — only if something was placed or a code repo was created.
// `archive/check` `{ operation }`: the archive complete (otherwise 409 ARCHIVE_INCOMPLETE), provisioner `list` with the
// target (a top folder stays, otherwise `<zipname>/`), the pre-check and the conflicts against the root → 200
// `{ operation, target, parentFolder, files, folder, references, sizeDeclared, omitted, existing, examples,
// throughReference, hints }`.
// `archive/unpack` `{ operation, mode? }` (`mode` only after a conflict answer; missing means `keep` — a target that only
// appears while unpacking is asked about, not silently skipped; a given one outside CONFLICT_MODES ⇒ 400 MODE): like
// `finished`, but the procedure first unpacks into the staging (space against the declared size, minus what already
// lies there) — the archive only falls AFTER unpacking; a new target folder becomes a code repo. Without an archive
// (resuming after unpacking) it checks the staging.
// `abort`: ends the group in the container (the `signal` to commandRun); the operation is then as if interrupted.
// Discarding (`DELETE`): staging in the container, archive (row, file), row.
//
// EVENT `project/upload` `{ projectId, operation, state, code? }` (`state`: upload · place · unpack · interrupted ·
// error · finished · dismissed) — ids and codes only.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { BOOT_ID } from "../../app-state.js";
import { T } from "../../i18n.js";
import * as store from "../../store.js";
import * as access from "../../runtime/fileAccess.js";
import { realRoots, inFolderInArea, nameInFolder } from "../../runtime/real-path.js";
import { commandRun } from "../../runtime/git-run.js";
import { readBody } from "../../runtime/http.js";
import { broadcast } from "../../runtime/sse.js";
import { chunkOpen } from "../../runtime/upload-stamp.js";
import { serverEnds } from "../../runs/server-end.js";
import { slugify } from "../../workspaces/git-auth.js";
import { MAIN } from "../creation.js";
import { detectServices } from "../detection.js";
import { occupancyOfProject, withProjectOccupancy } from "../instance.js";
import { runInstance } from "../run-instance.js";
import { creationOptionsFor } from "../recreate.js";
import { STAGINGS, upkeepExclude, carriesProjectRepoMarker } from "../projectRepo.js";
import { deniedText, reportSetupHint } from "./procedure.js";
import { removeArchive, archiveSize, archivePath, createArchive } from "./archive.js";
import { createCodeRepo } from "./code-repos.js";
import { unpackArchive, archiveList, stagedBytes, place, countConflicts } from "./provisioner.js";
import { SlotError, checkSlot } from "./slot.js";
import { uploadPath } from "./rules.js";
import { setupOpen, layoutStatus, uploadBegins, uploadReported, uploadRun, uploadView } from "./status.js";
import { PATHS_PER_STACK, OperationError, stagedSizes, createStaging, uploadStagingName } from "./operation.js";

export const CONFLICT_MODES = Object.freeze(["overwrite", "skip"]);
const short = (s, n = 300) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const response = (status, code, text, fields = {}) => ({ status, body: { code, error: text, ...fields } });

class UploadError extends Error {
  constructor(code, message, fields = {}) { super(message); this.name = "UploadError"; this.code = code; Object.assign(this, fields); }
}
// The codes an after-the-fact operation fails with; everything else (a docker error, an error of the program) is PLACE.
const ERROR_CODES = Object.freeze(["CONFLICT", "PLACE", "UNPACK", "SLOT", "TARGET", "STAGING", "INTERRUPTED", "OCCUPIED", "GIT", "REPO_EXISTING", "TARGET_BLOCKED"]);

/** `project/upload` to the global stream (header) — ids and codes only. */
function report(pid, operation, state, fields = {}) {
  broadcast({ type: "project/upload", projectId: String(pid), operation: String(operation), state, ...fields });
  uploadReported(pid, state); // the layout checks its quiet anew (status.js)
}

// ── The pre-check against the root of NOW ──────────────────────────────────────────────────────────────────────────
//
// TARGET_BLOCKED: a target the provisioner replaces in no mode (a link at the target or on the way, a folder where a
// file goes, a file in the way of a folder, something other than file/folder — ./provisioner.js `never_replaced`) is no
// conflict: the question would offer "overwrite", and placing would then fail in every mode, any number of times.
// `count` are the PLACES (deduplicated), `examples` at most five of them — the place where it lies (also an ancestor).
const blockedTexts = (count, examples) => {
  const list = (examples || []).slice(0, 5).map((b) => short(b, 160));
  const more = Math.max(0, (Number(count) || 0) - list.length);
  const quoted = (list.length ? list : [""]).map((x) => T`“${x}”`).join(", ");
  return T`${quoted}${more ? T` and ${more} more` : ""} is in the way (a link, or a folder/file) — remove or rename it there first; nothing was placed.`;
};
const targetBlocked = (count, examples) => response(409, "TARGET_BLOCKED", blockedTexts(count, examples), { count, examples: (examples || []).slice(0, 5).map((b) => short(b, 160)) });
// REPO_EXISTING: EVERY `.git` of the staging or the archive, not only the outermost (./provisioner.js `gitCollision`) —
// `folder` is the place that carries it.
const repoTexts = (g) => T`“${short(g, 160)}” brings a .git, and a repository already exists there — cbase never merges two repositories. Rename the folder or upload it without .git; nothing was placed.`;
const repoExisting = (g) => response(409, "REPO_EXISTING", repoTexts(g), { folder: short(g, 160) });
const conflictQuestion = (k) => response(409, "CONFLICT", T`${k.existing} file(s) already exist — overwrite or skip?`,
  { existing: k.existing, examples: (k.examples || []).slice(0, 5) });
const stagingMissing = () => T("The staging folder is missing — discard and upload again.");
/** Over the result of the provisioner's `conflicts` or `list` (with root): REPO_EXISTING, then TARGET_BLOCKED — `{ status, body }` or null. */
function precheck(k) {
  if ((Number(k?.gitCollisionCount) || 0) > 0) return repoExisting(String(k.gitCollision?.[0] ?? ""));
  if ((Number(k?.blocked) || 0) > 0) return targetBlocked(Number(k.blocked), k.blockedExamples || []);
  return null;
}

const RUNNING = () => response(409, "RUNNING", T("The server is working on this upload right now (placing, unpacking or discarding)."));
const UPLOAD_RUNNING = () => response(409, "UPLOAD_RUNNING", T("A chunk of this upload is running (a second tab?)."));

/** The locks of the after-the-fact way (header "LOCKS") — `{ status, body }` or null. */
export function uploadLock(pid) {
  if (setupOpen(pid)) {
    return response(409, "SETUP_RUNNING", T("The project is still being set up — uploading files later only works afterwards."));
  }
  const g = layoutStatus(pid);
  if (g === "waiting") {
    return response(409, "LAYOUT_WAITING", T("The project's layout is waiting for quiet — an upload would prolong the wait and write into a tree that was already checked. Apply or revert the layout first."));
  }
  if (g) {
    return response(409, "LAYOUT_RUNNING", T("The project's layout is being applied or is not finished — uploading only works afterwards."));
  }
  if (store.projectInstance(pid, MAIN)?.state !== "ready") return response(409, "NOT_READY", T("The project container is not ready."));
  return null;
}

// The operation from the address or the body — `{ v }` or `{ no }`.
function operationCheck(pid, operation, kind = null) {
  const v = typeof operation === "string" && operation ? store.projectUpload(operation) : null;
  if (!v) return { no: response(404, "OPERATION_UNKNOWN", T("No such upload (any more).")) };
  if (v.projectId !== String(pid)) return { no: response(409, "OPERATION_FOREIGN", T("The upload does not belong to this project.##2")) };
  if (v.purpose !== "retroactive") {
    return { no: response(409, "OPERATION_FOREIGN", T("The upload belongs to the project's setup — continue there (…/setup/sources/:nr/…).")) };
  }
  if (kind && v.kind !== kind) {
    return { no: response(409, "OPERATION_KIND", v.kind === "archive" ? T`The upload is of kind “${v.kind}” — an archive goes through …/archive/check and …/archive/unpack.` : T`The upload is of kind “${v.kind}” — files go through …/upload/:operation/finished.`) };
  }
  return { v };
}

// An error of a partial step (check, space, provisioner) as the answer of a route.
function errorResponse(x) {
  if (x instanceof SlotError) return { status: 409, body: { code: "SLOT", error: x.message, free: x.free, needed: x.needed } };
  if (x instanceof OperationError) {
    const { name: _n, code, status, message: _m, ...fields } = x;
    return { status: status || 409, body: { code, error: x.message, ...fields } };
  }
  if (x instanceof UploadError) {
    const { name: _n, code, status, finding, ...fields } = x;
    return { status: status || 409, body: { code, error: x.message, ...(finding || {}), ...fields } };
  }
  if (x?.code === "ABORTED") return response(409, "ABORTED", T("Cancelled."));
  return { status: 409, body: { code: typeof x?.code === "string" && ERROR_CODES.includes(x.code) ? x.code : "PLACE", error: short(x?.message || x, 600) } };
}

// ── B: what already exists at the target ───────────────────────────────────────────────────────────────────────────

/**
 * The targets from `paths` (checked, `parts`) that already exist in the root, those that are never replaced, and the top
 * folders of the selection that do NOT exist there. → `{ existing: [path], blocked: [place], fresh: [name] }`. Every
 * path part by lstat from the pinned parent folder (runtime/real-path.js inFolderInArea/nameInFolder, the next folder
 * opened O_NOFOLLOW), a link is never followed. `existing`: a file where a file goes (the conflict answer decides
 * that), and an entry lstat cannot read (better asked than silently overwritten). `blocked` (the same rule as
 * ./provisioner.js `never_replaced`): the PLACES (relative, each once) holding something the provisioner replaces in no
 * mode — a link (as the target or on the way), a folder where a file goes, a file in the way of a folder, something
 * other than file/folder.
 */
export function targetsExisting(root, paths) {
  const w = path.resolve(String(root));
  const tree = new Map();
  for (const p of paths) {
    let k = { children: tree };
    p.parts.forEach((t, i) => {
      if (!k.children.has(t)) k.children.set(t, { children: new Map(), sheet: [] });
      k = k.children.get(t);
      if (i === p.parts.length - 1) k.sheet.push(p.path);
    });
  }
  const existing = [];
  const blocked = [];
  const fresh = [];
  const all = (children) => { for (const k of children.values()) { existing.push(...k.sheet); all(k.children); } };
  const walk = (fd, folder, children, top, rel) => {
    for (const [name, k] of children) {
      const at = nameInFolder(fd, folder, name);
      const location = rel ? `${rel}/${name}` : name;
      let st = null;
      try { st = fs.lstatSync(at); } catch (e) {
        if (e?.code === "ENOENT") { if (top && k.children.size) fresh.push(name); continue; }
        // not readable: asked, not silently overwritten
        existing.push(...k.sheet);
        all(k.children);
        continue;
      }
      if (st.isSymbolicLink() || (!st.isDirectory() && !st.isFile())) { blocked.push(location); continue; }
      if (st.isFile()) {
        existing.push(...k.sheet);
        if (k.children.size) blocked.push(location); // a file in the way of a folder
        continue;
      }
      // a folder: where a file goes it is in the way; below it the walk goes on
      if (k.sheet.length) blocked.push(location);
      if (!k.children.size) continue;
      let kfd;
      try { kfd = fs.openSync(at, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW); } catch { all(k.children); continue; }
      try { walk(kfd, path.join(folder, name), k.children, false, location); } finally { fs.closeSync(kfd); }
    }
  };
  inFolderInArea(w, realRoots([w], [w]), ({ fd, path: filePath }) => walk(fd, filePath, tree, true, ""));
  return { existing, blocked, fresh };
}

function pathsWithSize(paths) {
  if (!Array.isArray(paths)) throw new OperationError("PATHS", T("“paths” is required: a list of { path, size }."), 400);
  if (paths.length > PATHS_PER_STACK) throw new OperationError("PATHS", T`at most ${PATHS_PER_STACK} paths per batch (${paths.length})`, 400);
  return paths.map((p) => {
    const raw = typeof p?.path === "string" ? p.path : null;
    const r = uploadPath(raw);
    if (r.error) throw new OperationError("PATHS", T`Path “${String(raw ?? "").slice(0, 200)}”: ${r.error}`, 400);
    if (!Number.isSafeInteger(p.size) || p.size < 0) throw new OperationError("PATHS", T`Path “${raw.slice(0, 200)}”: “size” is required (integer ≥ 0).`, 400);
    return { path: raw, size: p.size, parts: r.parts };
  });
}

// ── In the container: folders that are still new; the exclusion of the staging ─────────────────────────────────────

async function stillNew(inst, root, folder, signal) {
  const out = [];
  for (const rel of folder) {
    const st = await access.stat(inst, path.join(root, rel), { withoutDeadline: true, signal });
    if (st) console.log(`[upload] ${path.basename(root)}: "${short(rel, 120)}" appeared during the upload — no longer a new folder, no code repo`);
    else out.push(rel);
  }
  return out;
}

// The staging lies in the ROOT — without an exclusion `git status` of the root repo shows it with everything uploaded
// as untracked, and an agent's "commit everything" would take half-uploaded files into the repo. So `/.cbase-*/`
// (projectRepo.js STAGINGS) is in `.git/info/exclude` of the root repo before a byte arrives: if the root carries the
// PROJECT repo (marker), through its block (upkeepExclude, in the container); if it is a repo of the user itself, as a
// line of its own. Everything in the container: `.git` and `.git/info` must be real folders, `exclude` a regular file
// or missing, opened O_NOFOLLOW; without a `.git` in the root there is nothing to protect. argv: root, `append` |
// `check`; output JSON `{ present, written }` | `{ without: true }` | `{ error }`.
export const EXCLUSION_ROW = STAGINGS;
const EXCLUSION_COMMENT = "# cbase: stagings of after-the-fact uploads (projectbox/setup/upload.js)";
export const EXCLUSION_PROGRAM = `const fs = require("node:fs"), path = require("node:path");
const run = () => {
  const root = process.argv[1], append = process.argv[2] === "append";
  const row = ${JSON.stringify(EXCLUSION_ROW)}, comment = ${JSON.stringify(EXCLUSION_COMMENT)};
  const git = path.join(root, ".git"), info = path.join(git, "info"), file = path.join(info, "exclude");
  const statOf = (p) => { try { return fs.lstatSync(p); } catch (e) { if (e.code === "ENOENT") return null; throw e; } };
  const g = statOf(git);
  if (!g || !g.isDirectory()) return { without: true };
  const i = statOf(info);
  if (i && !i.isDirectory()) throw new Error(info + " is not a folder");
  let old = "";
  if (i) {
    const d = statOf(file);
    if (d && !d.isFile()) throw new Error(file + " is not a regular file");
    if (d) {
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try { if (!fs.fstatSync(fd).isFile()) throw new Error(file + " is not a regular file"); old = fs.readFileSync(fd, "utf8"); } finally { fs.closeSync(fd); }
    }
  }
  const present = old.split("\\n").some((z) => z.trim() === row);
  if (present || !append) return { present, written: false };
  if (!i) fs.mkdirSync(info);
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o644);
  try { fs.writeSync(fd, (old && !old.endsWith("\\n") ? "\\n" : "") + comment + "\\n" + row + "\\n"); } finally { fs.closeSync(fd); }
  return { present: true, written: true };
};
let out;
try { out = run(); } catch (e) { out = { error: String((e && e.message) || e) }; }
process.stdout.write(JSON.stringify(out));
`;
async function exclusionRun(inst, root, what, signal) {
  const r = await commandRun(inst, root, process.execPath, ["-e", EXCLUSION_PROGRAM, root, what], { withoutDeadline: true, ...(signal ? { signal } : {}) });
  let a = null;
  try { a = JSON.parse(String(r.stdout || "").trim()); } catch { a = null; }
  if (r.code !== 0 || !a || typeof a !== "object" || a.error) throw new Error(a?.error || `exit ${r.code ?? r.signal} ${String(r.stderr || "").trim().slice(0, 200)}`);
  return a;
}
/** `/.cbase-*` in `.git/info/exclude` of the root repo (see above) — never throws; an error is logged, the upload goes on. */
export async function protectStaging(inst, root, { signal } = {}) {
  try {
    if (carriesProjectRepoMarker(root)) {
      const a = await exclusionRun(inst, root, "check", signal);
      if (!a.without && !a.present) await upkeepExclude(root, { instance: inst, inContainer: true, withoutDeadline: true });
      return;
    }
    await exclusionRun(inst, root, "append", signal);
  } catch (x) {
    console.error(`[upload] ${path.basename(String(root))}: ${EXCLUSION_ROW} not in .git/info/exclude: ${short(x?.message || x, 300)}`);
  }
}

// ── The archive: its target ────────────────────────────────────────────────────────────────────────────────────────

/** The folder name without a top folder: the file name without `.zip`, by the rule of the clients. */
export const zipTarget = (name) => slugify(String(name || "").replace(/\.zip$/i, ""));

// Provisioner `list` with the mapping — `{ list, mapping, target }`. First with `{ from: "", to: <zipname> }` (that is
// already the result without a top folder); if the list reports a top folder, once more with `{ from: top, to: top }`.
async function archivePlan(inst, root, pid, a, signal) {
  const archive = archivePath(pid, a.archiveId);
  const fallback = a.target || "unnamed";
  let mapping = [{ from: "", to: fallback }];
  let target = fallback;
  let l = await archiveList(inst, root, archive, mapping, { againstRoot: true, signal });
  if (l.denied) return { list: l, mapping, target };
  if (l.parentFolder) {
    const f = uploadPath(String(l.parentFolder)).error;
    if (f) {
      throw new UploadError("TARGET", T`The archive's top folder “${short(l.parentFolder, 120)}” cannot be a folder in the project root (${f}) — nothing unpacked.`, { status: 409 });
    }
    target = String(l.parentFolder);
    mapping = [{ from: target, to: target }];
    l = await archiveList(inst, root, archive, mapping, { againstRoot: true, signal });
  }
  if (!l.denied && (l.missingCount > 0 || l.withoutTargetCount > 0)) {
    throw new UploadError("UNPACK", T("The archive is empty or holds nothing that would go into the project — nothing unpacked."), { status: 409 });
  }
  return { list: l, mapping, target };
}

// ── The locks of a running operation, asked anew after every await ─────────────────────────────────────────────────

function stillPresent(pid, operation, { kind = null, states = null, ownRun = null } = {}) {
  const r = operationCheck(pid, operation, kind);
  if (r.no) return r;
  const l = uploadRun(r.v.operation);
  if (l && l !== ownRun) return { no: RUNNING() };
  if (chunkOpen(r.v.operation, pid)) return { no: UPLOAD_RUNNING() };
  if (states && !states.includes(r.v.state)) {
    return { no: response(409, "OPERATION_CLOSED", T`The upload is “${r.v.state}” — this step is not possible now.`) };
  }
  return r;
}

// ── POST …/upload/begin ────────────────────────────────────────────────────────────────────────────────────────────

export async function beginUpload(pid, proj, req) {
  const s0 = uploadLock(pid);
  if (s0) return s0;
  const b = await readBody(req);
  const s1 = uploadLock(pid);
  if (s1) return s1;
  if (b?.archive !== undefined) return archiveBegin(pid, proj, b);
  let paths;
  try { paths = pathsWithSize(b?.paths); } catch (x) { return errorResponse(x); }
  const withOperation = b?.operation !== undefined && b?.operation !== null;
  let v = null;
  if (withOperation) {
    const r = stillPresent(pid, b.operation, { kind: "files", states: ["upload"] });
    if (r.no) return r.no;
    v = r.v;
  }
  const inst = runInstance(pid);
  if (!inst) return response(409, "NOT_READY", T("The project container is not ready."));
  const root = path.resolve(String(proj.path));
  let targets;
  try { targets = targetsExisting(root, paths); } catch (x) {
    return response(409, "ROOT", T`The project root is not readable: ${short(x?.code || x?.message || x, 120)}`);
  }
  // What is never replaced is no conflict question (header "PRE-CHECK") — without an operation none is created here.
  if (targets.blocked.length) return targetBlocked(targets.blocked.length, targets.blocked);
  const staged = v ? stagedSizes(root, v.staging, paths) : [];
  const already = new Map(staged.map((x) => [x.path, x.size]));
  const needed = paths.reduce((n, p) => n + Math.max(0, p.size - (already.get(p.path) || 0)), 0);
  try { await checkSlot(inst, root, needed); } catch (x) { return errorResponse(x); }
  const s2 = uploadLock(pid);
  if (s2) return s2;
  try {
    if (!v) {
      const fresh = crypto.randomUUID();
      const rel = uploadStagingName(fresh);
      // The row BEFORE the folder: if B dies in between, an interrupted operation is left (discarding cleans it); nobody
      // would clean a folder without a row.
      v = store.createProjectUpload({ operation: fresh, projectId: pid, purpose: "retroactive", kind: "files", staging: rel, newFolders: targets.fresh });
      try { await createStaging(inst, path.join(root, rel)); } catch (x) { store.deleteProjectUpload(fresh); return errorResponse(x); }
      await protectStaging(inst, root);
      report(pid, fresh, "upload");
    } else {
      const r = stillPresent(pid, v.operation, { kind: "files", states: ["upload"] });
      if (r.no) return r.no;
      v = r.v;
      const alongside = targets.fresh.filter((n) => !v.newFolders.includes(n));
      if (alongside.length) v = store.changeProjectUpload(v.operation, { newFolders: [...v.newFolders, ...alongside] }, { when: { state: "upload" } }) || v;
      // If the staging is missing (an agent cleared it away), it is created anew — in the container.
      await createStaging(inst, path.join(root, v.staging));
    }
  } catch (x) { return errorResponse(x); }
  return {
    status: 200,
    body: { operation: v.operation, existing: targets.existing.length, examples: targets.existing.slice(0, 5), existingPaths: targets.existing, staged, newFolders: v.newFolders },
  };
}

async function archiveBegin(pid, proj, b) {
  const { bytes, name } = b.archive && typeof b.archive === "object" ? b.archive : {};
  if (!Number.isSafeInteger(bytes) || bytes < 0) return response(400, "BYTES", T("“archive.bytes” is required (the size of the whole archive, integer ≥ 0)."));
  if (typeof name !== "string" || !name || name.length > 255 || name.includes("/") || name.includes("\0")) {
    return response(400, "NAME", T("“archive.name” is the file name of the archive (not empty, at most 255 characters, without “/” and NUL)."));
  }
  const target = zipTarget(name);
  let v = null;
  let a = null;
  if (b.operation !== undefined && b.operation !== null) {
    const r = stillPresent(pid, b.operation, { kind: "archive", states: ["upload"] });
    if (r.no) return r.no;
    v = r.v;
    a = store.projectArchiveOfOperation(v.operation);
    if (!a || a.state !== "upload") return response(409, "ARCHIVE_CLOSED", T("This archive accepts no more chunks."));
  }
  let already = 0;
  try { already = a ? archiveSize(pid, a.archiveId) : 0; } catch { already = 0; }
  if (a && already > 0 && bytes !== a.size) {
    return response(409, "ARCHIVE_DIFFERENT", T("The chosen archive is larger or smaller than the one that was being uploaded — discard and begin again, or choose the same archive."), { bytes: a.size, size: already });
  }
  const inst = runInstance(pid);
  if (!inst) return response(409, "NOT_READY", T("The project container is not ready."));
  try { await checkSlot(inst, path.resolve(String(proj.path)), Math.max(0, bytes - already)); } catch (x) { return errorResponse(x); }
  const s = uploadLock(pid);
  if (s) return s;
  if (!a) {
    const operation = crypto.randomUUID();
    const archiveId = crypto.randomUUID();
    // Rows before the file (as in ./operation.js beginArchive): the restartGrace hook "project-archive" cleans a file without a row.
    store.createProjectUpload({ operation, projectId: pid, purpose: "retroactive", kind: "archive", staging: uploadStagingName(operation) });
    a = store.createProjectArchive({ archiveId, projectId: pid, operation, purpose: "retroactive", target, size: bytes });
    createArchive(pid, archiveId);
    report(pid, operation, "upload");
    return { status: 200, body: { operation, archiveId, size: 0 } };
  }
  const r = stillPresent(pid, v.operation, { kind: "archive", states: ["upload"] });
  if (r.no) return r.no;
  if (bytes !== a.size) a = store.changeProjectArchive(a.archiveId, { size: bytes }, { when: { state: "upload" } }) || a;
  return { status: 200, body: { operation: v.operation, archiveId: a.archiveId, size: archiveSize(pid, a.archiveId) } };
}

/** For ./routes.js archiveChunk: a chunk of an AFTER-THE-FACT archive — `{ archive, announced }` or `{ no: [status, code, text] }`. */
export function archiveForRetroactive(pid, a) {
  const v = a.operation ? store.projectUpload(a.operation) : null;
  if (a.state !== "upload" || !v || v.state !== "upload" || v.projectId !== String(pid)) {
    return { no: [409, "ARCHIVE_CLOSED", T("This archive accepts no more chunks.")] };
  }
  return { archive: a, announced: a.size };
}

// ── The procedure: unpacking, placing, code repos (under the occupancy "place") ────────────────────────────────────

async function unpack(pid, inst, root, v, a, signal) {
  const plan = await archivePlan(inst, root, pid, a, signal);
  if (plan.list.denied) throw new UploadError("UNPACK", deniedText(plan.list.denied));
  const b = path.join(root, v.staging);
  const already = await stagedBytes(inst, root, b, { signal });
  await checkSlot(inst, root, Math.max(0, (Number(plan.list.sizeDeclared) || 0) - already));
  // The rest of an aborted pass falls: unpacking starts with an empty staging (repeatable).
  try { await access.erase(inst, b, { withoutDeadline: true, signal }); } catch (x) { if (x?.code !== "ENOENT") throw x; }
  await createStaging(inst, b, { signal });
  await protectStaging(inst, root, { signal });
  const e = await unpackArchive(inst, root, archivePath(pid, a.archiveId), b, plan.mapping, { signal });
  if (e.denied) throw new UploadError("UNPACK", deniedText(e.denied));
  if (e.slot) {
    throw new UploadError("SLOT", T("No space left on the server's disk — the archive is not fully unpacked. Free some space and continue."));
  }
  if (e.errorCount > 0) {
    const examples = (e.error || []).slice(0, 3).map((f) => `${f.kind}: ${short(f.path, 120)}`).join("; ");
    throw new UploadError("UNPACK", T`${e.errorCount} entr(y/ies) not unpacked${examples ? ` (${examples})` : ""} — continuing unpacks again, discarding removes everything`);
  }
  reportReferences(pid, e);
  return e;
}

// The out-of-project hint at the bell (the same seam as the creation, ./procedure.js reportHints): what was not created
// when unpacking or when placing with `references`.
function reportReferences(pid, r) {
  const hints = (r.hints || []).slice(0, 20);
  if (!(r.referenceOutside > 0) && !hints.length) return;
  const list = hints.slice(0, 5).map((h) => short(h, 160)).join("; ");
  console.log(`[upload] ${pid}: ${r.referenceOutside || 0} link(s) pointing out not created, ${hints.length} hint(s)`);
  reportSetupHint({
    projectId: pid,
    title: T("ZIP unpacked — not everything created"),
    text: T`${r.referenceOutside || 0} link(s) pointing out of the project not created; ${list}`,
  });
}

// `prior`: the state before the hand-over (handOver) — "the staging is missing = everything placed" only holds for a
// pass before which placing already happened (`place`/`error`); out of `upload` or right after unpacking it would mean
// "lost" (empty is not unknown).
async function run(pid, operation, run2, prior) {
  const signal = run2.controller.signal;
  const proj = store.getProject(pid);
  const inst = runInstance(pid);
  if (!proj || !inst) throw new UploadError("INTERRUPTED", T("project or instance gone"));
  const root = path.resolve(String(proj.path));
  const v = store.projectUpload(operation);
  if (!v) throw new UploadError("INTERRUPTED", T("the upload is gone"));
  const b = path.join(root, v.staging);
  let fresh = v.kind === "files" && prior === "upload";
  if (v.kind === "archive") {
    const a = store.projectArchiveOfOperation(operation);
    if (a) {
      await unpack(pid, inst, root, v, a, signal);
      // The archive only falls AFTER unpacking: if B dies before, resuming unpacks anew.
      removeArchive(a);
      report(pid, operation, "place");
      fresh = true;
    }
  }
  // The pre-check RIGHT before placing (only here is the moment right — after unpacking, after a restart, after an
  // abort; header "PRE-CHECK"): REPO_EXISTING, TARGET_BLOCKED, and a new top folder that exists at the target by now
  // while the staging still carries it is no longer new (no code repo — an agent created it).
  let newFolders = [...v.newFolders];
  const st0 = await access.stat(inst, b, { withoutDeadline: true, signal });
  if (!st0 && fresh) throw new UploadError("STAGING", stagingMissing());
  if (st0 && st0.kind === "folder") {
    const k = await countConflicts(inst, root, [b], { newFolders, signal });
    if ((Number(k.gitCollisionCount) || 0) > 0) {
      const g = String(k.gitCollision?.[0] ?? "");
      throw new UploadError("REPO_EXISTING", repoTexts(g), { finding: { folder: short(g, 160) } });
    }
    if ((Number(k.blocked) || 0) > 0) {
      const examples = (k.blockedExamples || []).slice(0, 5).map((x) => short(x, 160));
      throw new UploadError("TARGET_BLOCKED", blockedTexts(k.blocked, examples), { finding: { count: Number(k.blocked), examples } });
    }
    const occupied = (k.newOccupied || []).filter((n) => newFolders.includes(n));
    if (occupied.length) {
      newFolders = newFolders.filter((n) => !occupied.includes(n));
      store.changeProjectUpload(operation, { newFolders }, { when: { state: "place", process: BOOT_ID } });
      console.log(`[upload] ${path.basename(root)}: ${occupied.map((n) => `"${short(n, 80)}"`).join(", ")} appeared during the upload — no longer a new folder, no code repo`);
    }
  }
  const mode = v.conflict || "keep";
  let written = 0;
  // A partial placing (item errors, or a conflict question after `keep`): first the code repos of the new folders that
  // already arrived, then the error — with `part`, so that `start` runs the detection.
  let part = null;
  for (;;) {
    if (signal.aborted) throw new UploadError("ABORTED", "aborted");
    const st = await access.stat(inst, b, { withoutDeadline: true, signal });
    if (!st) {
      if (fresh) throw new UploadError("STAGING", stagingMissing());
      break; // everything placed (an earlier pass died afterwards)
    }
    fresh = false;
    if (st.kind !== "folder") throw new UploadError("STAGING", T`${v.staging} is not a folder (${st.kind}).`);
    const r = await place(inst, root, b, mode, { signal, ...(v.kind === "archive" ? { references: true } : {}) });
    written += (Number(r.written) || 0) + (Number(r.references) || 0);
    if (v.kind === "archive" && r.referenceOutside > 0) reportReferences(pid, r);
    else if (r.hints?.length) console.log(`[upload] ${pid}: ${r.hints.length} hint(s), among them ${short(r.hints[0], 160)}`);
    const occupied = Number(r.occupied) || 0;
    if (r.errorCount > 0 || (r.rest && !occupied)) {
      const examples = (r.error || []).slice(0, 3).map((f) => `${f.kind}: ${short(f.path, 120)}`).join("; ");
      part = new UploadError("PLACE", T`${r.errorCount} file(s) not placed${examples ? ` (${examples})` : ""} — the rest stays in the staging folder`);
      break;
    }
    if (!occupied) break;
    // `keep` (no answer, nothing counted): a target only appeared after the count — count again and ask (never silent).
    const k = await countConflicts(inst, root, [b], { signal });
    if (k.existing > 0) {
      part = new UploadError("CONFLICT", T`${k.existing} file(s) already exist — overwrite or skip?`,
        { finding: { existing: k.existing, examples: (k.examples || []).slice(0, 5) } });
      break;
    }
  }
  const repos = [];
  const home = creationOptionsFor(pid).home;
  for (const rel of newFolders) {
    if (signal.aborted) throw new UploadError("ABORTED", "aborted");
    if (part && serverEnds()) break;
    let r;
    try { r = await createCodeRepo(inst, root, rel, { signal, permissionsFromIndex: true, ...(home ? { home } : {}) }); } catch (x) {
      if (!part) throw x;
      // After a partial placing the first error counts; a code repo that fails here is caught up by resuming.
      console.error(`[upload] ${path.basename(root)}: code repo "${short(rel, 80)}" after partial placing: ${short(x?.message || x, 300)}`);
      continue;
    }
    repos.push({ rel, created: Boolean(r.created), ...(r.reason ? { reason: r.reason } : {}) });
  }
  if (part) {
    part.part = { written, repos };
    throw part;
  }
  return { written, repos };
}

// Start the procedure: the operation is already in `place` with the own boot id; `run2` (./status.js uploadBegins)
// belongs to the procedure from here on, `end` falls at its end. No await before withProjectOccupancy (it occupies
// synchronously).
function start(pid, operation, run2, end, prior) {
  run2.what = "place";
  let p;
  try { p = withProjectOccupancy(pid, "place", () => run(pid, operation, run2, prior)); } catch (e) { p = Promise.reject(e); }
  p.then((result) => {
    store.deleteProjectUpload(operation);
    const created = result.repos.filter((r) => r.created).map((r) => r.rel);
    console.log(`[upload] ${pid}: ${operation.slice(0, 8)} placed — ${result.written} file(s)/link(s), code repos ${created.length ? created.map((r) => short(r, 80)).join(", ") : "no"}`);
    report(pid, operation, "finished", { codeRepos: created.length });
    if ((result.written > 0 || created.length) && store.getProject(pid)) {
      try { detectServices(pid, { onlySupplement: true }); } catch (x) { console.error(`[upload] ${pid}: service detection: ${x?.message || x}`); }
    }
  }, (e) => {
    // If the server is ending, the row stays with this boot id: interrupted after the restart (resuming = `finished`).
    if (serverEnds()) return;
    if (run2.controller.signal.aborted || e?.code === "ABORTED") {
      store.changeProjectUpload(operation, { process: "" }, { when: { state: "place", process: BOOT_ID } });
      console.log(`[upload] ${pid}: ${operation.slice(0, 8)} aborted`);
      report(pid, operation, "interrupted");
      return;
    }
    const code = typeof e?.code === "string" && ERROR_CODES.includes(e.code) ? e.code : "PLACE";
    console.error(`[upload] ${pid}: ${operation.slice(0, 8)}: ${code}: ${short(e?.message || e, 600)}`);
    store.changeProjectUpload(operation, { state: "error", code, error: short(e?.message || e), finding: e?.finding ?? null, process: "" }, { when: { process: BOOT_ID } });
    report(pid, operation, "error", { code });
    // A partial placing (`part` from `run`): what arrived is detected as after a success — the code repos already ran.
    const t = e?.part;
    if (t && (t.written > 0 || t.repos.some((r) => r.created)) && store.getProject(pid)) {
      const created = t.repos.filter((r) => r.created).length;
      console.log(`[upload] ${pid}: ${operation.slice(0, 8)} partially placed — ${t.written} file(s)/link(s), ${created} code repo(s)`);
      try { detectServices(pid, { onlySupplement: true }); } catch (x) { console.error(`[upload] ${pid}: service detection: ${x?.message || x}`); }
    }
  }).finally(end);
}

// The shared end of `finished` and `archive/unpack`: occupancy free, state `place` with the own boot id (conditional),
// procedure started, 202. `run2`/`end`: the marker of the counting (./status.js uploadBegins) — it passes to the procedure.
function handOver(pid, v, fields, run2, end) {
  const b = occupancyOfProject(pid);
  if (b) return { response: response(409, "OCCUPIED", T`Something else is running on the project (${b.what}) — continue afterwards.`) };
  const z = store.changeProjectUpload(v.operation, { state: "place", process: BOOT_ID, error: "", code: "", finding: null, ...fields }, { when: { state: v.state } });
  if (!z) return { response: response(409, "OPERATION_CLOSED", T("The upload just changed its state.")) };
  start(pid, z.operation, run2, end, v.state);
  report(pid, z.operation, z.kind === "archive" && store.projectArchiveOfOperation(z.operation) ? "unpack" : "place");
  return { response: { status: 202, body: { ok: true, upload: uploadView(store.projectUpload(z.operation)) } }, handedOver: true };
}

// ── POST …/upload/:operation/finished ──────────────────────────────────────────────────────────────────────────────

export async function uploadFinished(pid, proj, operation, req) {
  const r0 = stillPresent(pid, operation);
  if (r0.no) return r0.no;
  const s0 = uploadLock(pid);
  if (s0) return s0;
  if (r0.v.kind === "archive" && r0.v.state === "upload") {
    return response(409, "OPERATION_KIND", T("An archive goes through …/archive/check and …/archive/unpack."));
  }
  const b = await readBody(req);
  const k = b?.conflict;
  if (k !== undefined && k !== null && !CONFLICT_MODES.includes(k)) {
    return response(400, "MODE", T`“conflict” is ${CONFLICT_MODES.join(T(" or "))} (or missing).`);
  }
  const r1 = stillPresent(pid, operation, { states: ["upload", "place", "error"] });
  if (r1.no) return r1.no;
  const s1 = uploadLock(pid);
  if (s1) return s1;
  let v = r1.v;
  if (v.kind === "archive" && v.state === "upload") return response(409, "OPERATION_KIND", T("An archive goes through …/archive/check and …/archive/unpack."));
  // An archive without a stored and without a given answer: `keep` as for files — counted below.
  const mode = k || v.conflict || null;
  const run2 = { projectId: String(pid), what: "count", controller: new AbortController() };
  const end = uploadBegins(v.operation, run2);
  let handedOver = false;
  try {
    const inst = runInstance(pid);
    if (!inst) return response(409, "NOT_READY", T("The project container is not ready."));
    const root = path.resolve(String(proj.path));
    const signal = run2.controller.signal;
    let newFolders = v.newFolders;
    // An archive whose file is still there (an error while or before unpacking, an abort, a restart): `run` unpacks
    // anew — the check goes against the archive. Otherwise against the staging, as for files.
    const a = v.kind === "archive" ? store.projectArchiveOfOperation(v.operation) : null;
    if (a) {
      const plan = await archivePlan(inst, root, pid, a, signal);
      if (plan.list.denied) return response(409, "UNPACK", T(""), { error: deniedText(plan.list.denied), denied: { reason: plan.list.denied.reason } });
      const vp = precheck(plan.list);
      if (vp) return vp;
      if (plan.list.existing > 0 && !mode) return conflictQuestion(plan.list);
    } else {
      const bAbs = path.join(root, v.staging);
      const st = await access.stat(inst, bAbs, { withoutDeadline: true, signal });
      if (st && st.kind !== "folder") return response(409, "STAGING", T`${v.staging} is not a folder.`);
      // In `upload` nothing was placed yet — a missing staging means "lost" there, not "finished".
      if (!st && v.state === "upload") return response(409, "STAGING", stagingMissing());
      if (st) {
        const kz = await countConflicts(inst, root, [bAbs], { signal });
        const vp = precheck(kz);
        if (vp) return vp;
        if (kz.existing > 0 && !mode) return conflictQuestion(kz);
      }
      if (v.state === "upload") newFolders = await stillNew(inst, root, v.newFolders, signal);
    }
    const r2 = stillPresent(pid, operation, { states: [v.state], ownRun: run2 });
    if (r2.no) return r2.no;
    const s2 = uploadLock(pid);
    if (s2) return s2;
    v = r2.v;
    const u = handOver(pid, v, { conflict: mode, newFolders }, run2, end);
    handedOver = Boolean(u.handedOver);
    return u.response;
  } catch (x) {
    return errorResponse(x);
  } finally {
    if (!handedOver) end();
  }
}

// ── POST …/archive/check, …/archive/unpack ─────────────────────────────────────────────────────────────────────────

// The archive of an operation in `upload` — complete (the announced size at the descriptor)? → `{ a }` or `{ no }`.
function completeArchive(pid, v) {
  const a = store.projectArchiveOfOperation(v.operation);
  if (!a || a.projectId !== String(pid)) return { no: response(409, "ARCHIVE_MISSING", T("The archive of this upload is missing — discard and upload again.")) };
  let present;
  try { present = archiveSize(pid, a.archiveId); } catch (x) {
    return { no: response(409, x?.code === "EOUTSIDE" || x?.code === "ENOFILE" ? x.code : "ARCHIVE", T("The archive file is not a file in the runtime folder (a link?).")) };
  }
  if (v.state === "upload" && present !== a.size) {
    return { no: response(409, "ARCHIVE_INCOMPLETE", T`The archive holds ${present} of ${a.size} bytes — continue at “size”.`, { size: present, expected: a.size }) };
  }
  return { a };
}

export async function checkArchive(pid, proj, req) {
  const s0 = uploadLock(pid);
  if (s0) return s0;
  const b = await readBody(req);
  const r = stillPresent(pid, b?.operation, { kind: "archive", states: ["upload", "error"] });
  if (r.no) return r.no;
  const s1 = uploadLock(pid);
  if (s1) return s1;
  const va = completeArchive(pid, r.v);
  if (va.no) return va.no;
  const inst = runInstance(pid);
  if (!inst) return response(409, "NOT_READY", T("The project container is not ready."));
  const run2 = { projectId: String(pid), what: "check", controller: new AbortController() };
  const end = uploadBegins(r.v.operation, run2);
  try {
    const root = path.resolve(String(proj.path));
    const plan = await archivePlan(inst, root, pid, va.a, run2.controller.signal);
    const l = plan.list;
    if (l.denied) return response(409, "UNPACK", T(""), { error: deniedText(l.denied), denied: { reason: l.denied.reason, names: (l.denied.names || []).slice(0, 5) } });
    const vp = precheck(l);
    if (vp) return vp;
    return {
      status: 200,
      body: {
        operation: r.v.operation, target: plan.target, parentFolder: Boolean(l.parentFolder), files: l.files, folder: l.folder, references: l.references,
        sizeDeclared: l.sizeDeclared, omitted: l.omitted, existing: l.existing, examples: (l.examples || []).slice(0, 5),
        throughReference: l.throughReference, hints: (l.hints || []).slice(0, 20),
      },
    };
  } catch (x) {
    return errorResponse(x);
  } finally { end(); }
}

export async function startArchiveUnpack(pid, proj, req) {
  const s0 = uploadLock(pid);
  if (s0) return s0;
  const b = await readBody(req);
  // `mode` only after a conflict answer — without it `keep` (what only appears at the target while unpacking is asked
  // about, not silently skipped); a given one must be one of CONFLICT_MODES.
  const mode = b?.mode ?? null;
  if (mode !== null && !CONFLICT_MODES.includes(mode)) {
    return response(400, "MODE", T`“mode” is ${CONFLICT_MODES.join(T(" or "))} (or missing).`);
  }
  const r = stillPresent(pid, b?.operation, { kind: "archive", states: ["upload", "place", "error"] });
  if (r.no) return r.no;
  const s1 = uploadLock(pid);
  if (s1) return s1;
  let v = r.v;
  const a = store.projectArchiveOfOperation(v.operation);
  if (v.state === "upload") {
    const va = completeArchive(pid, v);
    if (va.no) return va.no;
  }
  const inst = runInstance(pid);
  if (!inst) return response(409, "NOT_READY", T("The project container is not ready."));
  const run2 = { projectId: String(pid), what: "count", controller: new AbortController() };
  const end = uploadBegins(v.operation, run2);
  let handedOver = false;
  try {
    const root = path.resolve(String(proj.path));
    let newFolders = v.newFolders;
    if (a) {
      const plan = await archivePlan(inst, root, pid, a, run2.controller.signal);
      if (plan.list.denied) return response(409, "UNPACK", T(""), { error: deniedText(plan.list.denied), denied: { reason: plan.list.denied.reason } });
      const vp = precheck(plan.list);
      if (vp) return vp;
      // A new target folder becomes a code repo — decided at the FIRST unpacking; resuming keeps the choice.
      if (v.state === "upload") newFolders = (await access.stat(inst, path.join(root, plan.target), { withoutDeadline: true, signal: run2.controller.signal })) ? [] : [plan.target];
    } else {
      // No archive any more (it fell after unpacking): the staging is checked.
      const bAbs = path.join(root, v.staging);
      const st = await access.stat(inst, bAbs, { withoutDeadline: true, signal: run2.controller.signal });
      if (st && st.kind !== "folder") return response(409, "STAGING", T`${v.staging} is not a folder.`);
      if (st) {
        const vp = precheck(await countConflicts(inst, root, [bAbs], { signal: run2.controller.signal }));
        if (vp) return vp;
      }
    }
    const r2 = stillPresent(pid, v.operation, { kind: "archive", states: [v.state], ownRun: run2 });
    if (r2.no) return r2.no;
    const s2 = uploadLock(pid);
    if (s2) return s2;
    v = r2.v;
    if (a) store.changeProjectArchive(a.archiveId, { state: "unpack" }, { when: { state: ["upload", "unpack", "error"] } });
    const u = handOver(pid, v, { conflict: mode || v.conflict || null, newFolders }, run2, end);
    handedOver = Boolean(u.handedOver);
    return u.response;
  } catch (x) {
    return errorResponse(x);
  } finally {
    if (!handedOver) end();
  }
}

// ── POST …/upload/:operation/abort, DELETE …/upload/:operation ─────────────────────────────────────────────────────

export function uploadAbort(pid, operation) {
  const r = operationCheck(pid, operation);
  if (r.no) return r.no;
  const run2 = uploadRun(r.v.operation);
  if (!run2 || !run2.controller || run2.what === "dismiss") {
    return response(409, "NOT_ABORTABLE", T("Cancelling only works while placing or unpacking."));
  }
  run2.controller.abort();
  return { status: 202, body: { ok: true, upload: uploadView(store.projectUpload(r.v.operation)) } };
}

export async function dismissUpload(pid, proj, operation) {
  const r = stillPresent(pid, operation);
  if (r.no) return r.no;
  if (store.projectInstance(pid, MAIN)?.state !== "ready") {
    return response(409, "NOT_READY", T("The project container is not ready — the staging folder can only be removed there."));
  }
  const inst = runInstance(pid);
  if (!inst) return response(409, "NOT_READY", T("The project container is not ready."));
  const run2 = { projectId: String(pid), what: "dismiss" };
  const end = uploadBegins(r.v.operation, run2);
  try {
    try { await access.erase(inst, path.join(path.resolve(String(proj.path)), r.v.staging), { withoutDeadline: true }); }
    catch (x) { if (x?.code !== "ENOENT") return { status: 500, body: { code: "STAGING", error: T`Staging folder not removed: ${short(x?.message || x)}` } }; }
    // Archive (row, then file — ./archive.js), then the row of the operation: if B dies in between, an operation
    // without an archive is left, and discarding works once more.
    const a = store.projectArchiveOfOperation(r.v.operation);
    if (a) removeArchive(a);
    store.deleteProjectUpload(r.v.operation);
    report(pid, r.v.operation, "dismissed");
    return { status: 200, body: { ok: true } };
  } finally { end(); }
}
