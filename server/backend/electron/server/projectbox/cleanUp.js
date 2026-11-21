// The root fallback when clearing a runtime folder.
//
// In the project container some things run as root, and on the idmapped home of the user container its files then belong to root: the
// backend (agent) cannot remove them, `fs.rmSync` throws EACCES/EPERM. Then the project container clears itself:
// `docker exec -u root <container> rm -rf <path>` — the same path, because the runtime folder is mounted there at the same path.
//
// removeAsRoot({ projectId, path, area, inst })
//   The fallback for runs/runtime-location.js removeTrace (caller: chats/erase.js). SYNCHRONOUS in the verdict, asynchronous in the
//   execution: it throws if there is no way — without an ops marker (no docker call, the local server has no project container) or
//   for a path outside the runtime folder of THIS project; then the caller reports what stayed. Otherwise it starts the call and
//   returns its promise; if that fails, a message goes to stderr (deleting the chat does not hang on the clearing).
//   Container: the id from the instance row, without a row the name `cbase-p-<projectId>`.
//   The call goes through `execIn` (docker.js) with user root, behind the pause barrier: if the main stands frozen for the code snapshot
//   of a copy, the clearing waits for the thaw instead of reading "is paused" as a failure and leaving the root-owned rest. Guard:
//   server/backend/test/stacks-freeze.test.js "P2A-1 …".
//   Not only a fallback: with an instance row it is the FIRST way of every trace (runs/runtime-location.js removeTrace) and step 1 of
//   deleting the project (erase.js stopAll) — as long as the container runs, B deletes nothing recursively there.
//   With `{ area: "project", inst }` for a path in the PROJECT FOLDER (the layout leaves a folder out, and agent may not delete
//   everything in it — an inner container wrote as root). Not via `execIn` (its cap of 120 s — a big folder takes longer), but
//   `commandRun(inst, …, { asUser: "root", withoutDeadline: true })` with the container program of the layout
//   (layout/rebuild-program.js `gone` with `asRoot`): it checks INSIDE the container that the path lies under the root and that no
//   part of the path before it is a link, and then deletes with `rm -rf --one-file-system`. The caller hands the instance in
//   (run-instance.js imports this file — an import in the opposite direction would be a cycle). Synchronously it throws as above
//   (without operations, without an instance of this project, path outside the project folder); the promise resolves `{ ok, stand,
//   text }` (`state` from the program: deleted · missing · refused), never a throw.
// cleanUpOpenRoot()  all fallbacks still running (for tests and the server end).
import path from "node:path";
import { T } from "../i18n.js";
import * as store from "../store.js";
import { projectboxOps } from "./ops.js";
import { containerName } from "./creation.js";
import { execIn } from "./docker.js";
import { locationFor } from "../runs/runtime-location.js";
import { commandRun } from "../runtime/git-run.js";
import { REBUILD_PROGRAM } from "./layout/rebuild-program.js";

const open = new Set();

// The name stands ONCE, in creation.js — only passed through here.
export const projectContainerName = containerName;

function containerFor(projectId) {
  let id = "";
  try { id = store.instanceFor(projectId)?.containerId || ""; } catch { /* without a table: the name */ }
  return id || projectContainerName(projectId);
}

// Outside means: the FIRST path part is `..` — "..alt" is a folder under the root; a prefix comparison on ".." threw there
// synchronously, after the turning point, identically at every "Try again".
const outside = (rel) => rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);

export function removeAsRoot({ projectId, path: filePath, area = "runtime", inst = null }) {
  if (!projectboxOps()) throw new Error(T("no server operation — a root-owned rest stays"));
  if (area === "project") return asRootInProject({ projectId, path: filePath, inst });
  if (area !== "runtime") throw new TypeError(`removeAsRoot: unknown area “${area}”`);
  const root = locationFor({ projectId, converted: true }).root;
  const rel = path.relative(root, String(filePath || ""));
  if (!rel || outside(rel)) throw new Error(T`not in the runtime folder of ${projectId}: ${filePath}`);
  const container = containerFor(projectId);
  const p = execIn(container, ["rm", "-rf", path.join(root, rel)], { user: "root" })
    .then(() => true)
    .catch((e) => {
      console.warn(`[projectbox] ${filePath} not removed even as root (${container}): ${e?.message || e}`);
      return false;
    })
    .finally(() => open.delete(p));
  open.add(p);
  return p;
}

// A path in the project folder, as root in the project container, via the container program of the layout (see header).
function asRootInProject({ projectId, path: filePath, inst }) {
  const pid = String(projectId ?? "");
  if (!inst || String(inst.projectId) !== pid) throw new Error(`removeAsRoot: without an instance of ${pid} no root in the project container`);
  const proj = store.getProject(pid);
  if (!proj?.path) throw new Error(`removeAsRoot: project ${pid} without a path`);
  const root = path.resolve(proj.path);
  const rel = path.relative(root, path.resolve(String(filePath || "")));
  if (!rel || outside(rel)) throw new Error(T`not in the project folder of ${pid}: ${filePath}`);
  const options = JSON.stringify({ root, paths: [rel.split(path.sep).join("/")], asRoot: true });
  const p = commandRun(inst, "/", process.execPath, ["-e", REBUILD_PROGRAM, "--", "gone", options], { asUser: "root", withoutDeadline: true })
    .then((r) => {
      let a = null;
      try { a = JSON.parse(String(r.stdout || "").trim().split("\n").pop() || "null"); } catch { a = null; }
      if (!a || a.ok === false) {
        const text = a?.message || String(r.stderr || "").trim().split("\n").pop()?.slice(0, 200) || `Exit ${r.code}`;
        console.warn(`[projectbox] ${filePath} not removed even as root (${inst.identifier || pid}): ${text}`);
        return { ok: false, outcome: a?.code || "error", text };
      }
      const x = Array.isArray(a.paths) ? a.paths[0] : null;
      const ok = x?.outcome === "deleted" || x?.outcome === "missing";
      if (!ok) console.warn(`[projectbox] ${filePath} not removed even as root (${inst.identifier || pid}): ${x?.code || "?"} ${x?.text || ""}`.trim());
      return { ok, outcome: x?.outcome || "?", text: ok ? "" : `${x?.code || "?"} ${x?.text || ""}`.trim() };
    })
    .catch((e) => {
      console.warn(`[projectbox] ${filePath} not removed even as root (${inst.identifier || pid}): ${e?.message || e}`);
      return { ok: false, outcome: "error", text: String(e?.message || e) };
    })
    .finally(() => open.delete(p));
  open.add(p);
  return p;
}

export const cleanUpOpenRoot = () => Promise.all([...open]);
