// The upload stamp. A leaf with no imports: whoever uploads a chunk into a project calls `uploadBegins(projectId)` at the START
// of the request and the returned function at its end. The stamp marks the start, not the end — a 3 MB chunk over a slow line
// takes longer than the upload quiet period.
//
//   uploadBegins(projectId, operation?, { unresolved }) → end()
//                            counts the open request (per project and, with `operation`, per operation) and remembers when it
//                            began; `end` uncounts it (called repeatedly: once). With `unresolved: true` the request's
//                            operation is NOT yet known — it may be in the body, which has not been read yet (web and iOS send
//                            it there): until `end.clarified()` (body read, operation known or absent) it counts as open for
//                            EVERY operation of its project (chunkOpen with `projectId`).
//   uploadRunning(projectId) whether a chunk request is open for the project or one BEGAN less than the quiet period ago
//                            (`uploadsActive`, the "upload running" indicator).
//   chunkOpen(operation, projectId?)
//                            whether a chunk request is open for the operation RIGHT NOW — the verdict of the routes (begin,
//                            finish, drop ⇒ 409 `UPLOAD_RUNNING`, the second tab). By the open request, not by the clock: the
//                            own client calls finish right after its last chunk. With `projectId` every open request of this
//                            project whose operation is still unresolved counts too (its body is still coming) — it may belong
//                            to this operation (rather locked than slipped through).
//   uploadsActive()          the number of such projects (and workspaces, key `ws:<id>`) — `/api/runs/active` carries it, and
//                            `busy` is true while it is > 0 (deploy gate and idle reaper).
//   uploadQuietMs()          CBASE_UPLOAD_QUIET_MS (integer ≥ 0, default 60 s). 0 means: only open requests count.
//
// The clock is a product cap, not a test criterion: a test measures via an open request (gate), never via time.
// Kept in this process's memory — after a restart no request is open, and a client that keeps uploading stamps anew.
// Callers: devtools/code-route.js stamps at the START of EVERY `POST …/upload`, before the body — at project level under the
// project id (with `?operation=` via projectbox/setup/operation.js chunkBegins, which counts the operation; without it
// `unresolved`, and if the operation is in the BODY, chunkBegins counts it after reading), at workspace level under `ws:<id>`
// (workspaces/routes.js; no project, but `busy`). Readers: runs/routes.js, projectbox/setup/routes.js (`chunkOpen`).

export const UPLOAD_QUIET_MS = 60_000;

export function uploadQuietMs() {
  const raw = process.env.CBASE_UPLOAD_QUIET_MS;
  const ms = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isInteger(ms) && ms >= 0 ? ms : UPLOAD_QUIET_MS;
}

const open = new Map(); // projectId → number of open chunk requests
const openOperation = new Map(); // operation → number of open chunk requests
const last = new Map(); // projectId → start of the last chunk request (ms)
const openUnresolved = new Map(); // projectId → number of open requests whose operation is not yet known

const count = (m, k, d) => { const n = (m.get(k) || 0) + d; if (n > 0) m.set(k, n); else m.delete(k); };

export function uploadBegins(projectId, operation = "", { unresolved = false } = {}) {
  const pid = String(projectId || "");
  if (!pid) return Object.assign(() => {}, { clarified: () => {} });
  const v = String(operation || "");
  count(open, pid, 1);
  if (v) count(openOperation, v, 1);
  let openWithoutOperation = Boolean(unresolved) && !v;
  if (openWithoutOperation) count(openUnresolved, pid, 1);
  last.set(pid, Date.now());
  const clarified = () => {
    if (!openWithoutOperation) return;
    openWithoutOperation = false;
    count(openUnresolved, pid, -1);
  };
  let past = false;
  const end = () => {
    if (past) return;
    past = true;
    clarified();
    count(open, pid, -1);
    if (v) count(openOperation, v, -1);
  };
  return Object.assign(end, { clarified });
}

export const chunkOpen = (operation, projectId = null) => (openOperation.get(String(operation || "")) || 0) > 0
  || (projectId !== null && projectId !== undefined && (openUnresolved.get(String(projectId)) || 0) > 0);

export function uploadRunning(projectId, now = Date.now()) {
  const pid = String(projectId || "");
  if ((open.get(pid) || 0) > 0) return true;
  const t = last.get(pid);
  if (t === undefined) return false;
  const quiet = uploadQuietMs();
  if (now - t < quiet) return true;
  last.delete(pid);
  return false;
}

/** The start of the last chunk request (ms) or null. */
export const lastUploadBegin = (projectId) => last.get(String(projectId || "")) ?? null;

export function uploadsActive(now = Date.now()) {
  const pids = new Set([...open.keys(), ...last.keys()]);
  let n = 0;
  for (const pid of pids) if (uploadRunning(pid, now)) n += 1;
  return n;
}

/** Forget a deleted project (delete path). */
export function forgetUpload(projectId) {
  const pid = String(projectId || "");
  last.delete(pid);
}
