// The instance of a Git overview request. Shared by fetch.js and detail.js: both work in EXACTLY one instance that is
// `ready`, and never wake one.
//
// NAMES. At the seam an instance is called `main` or by its copy (`k1`) — NOT `copy-k1` as in the instances tree and in
// the chat's instance field, and not the identifier `<pid>/<name>`. Internally (instance row, container, chats) the copy
// is `copy-<name>` (projectbox/creation.js copyInstance). Strict: `copy-k1` as a request name is the copy "copy-k1"
// (COPY_NAME allows the hyphen) — if it does not exist that is a 404, never silently the copy "k1".
//
// READY. An instance whose row is not `ready` is never asked: no `docker exec`, no start, no resume — 409
// INSTANCE_NOT_READY with its state. The reading (read.js) shows the same instance with `read: false` and a reason.
import * as store from "../store.js";
import { T } from "../i18n.js";
import { MAIN, copyInstance } from "../projectbox/creation.js";
import { runInstance } from "../projectbox/run-instance.js";

const error = (status, code, text, extra = {}) => Object.assign(new Error(text), { status, code, ...extra });

/** The seam name (`main` | `<copy>`) → the internal one (`main` | `copy-<copy>`). Throws 400 for an invalid name. */
export function instanceInternal(name) {
  const n = typeof name === "string" ? name.trim() : "";
  if (!n) throw error(400, "INSTANCE_INVALID", T("instance is missing (\"main\" or the name of a copy)"));
  if (n === MAIN) return MAIN;
  try { return copyInstance(n); } catch {
    throw error(400, "INSTANCE_INVALID", T`"${n}" is not an instance name ("main" or the name of a copy)`);
  }
}

/** The internal name (`main` | `copy-<copy>`) → the seam name (`main` | `<copy>`). */
export const instanceDisplay = (internalName) => (!internalName || internalName === MAIN ? MAIN : String(internalName).replace(/^copy-/, ""));

/**
 * The ready instance of a converted project for a seam name → `{ inst, internalName, name }`. Throws with `status`/`code`:
 * 400 INSTANCE_INVALID, 404 UNKNOWN_INSTANCE (no row), 409 INSTANCE_NOT_READY (`state`), 409 NOT_CONVERTED (no run
 * instance). Reads only the database — no docker.
 */
export function readyInstance(projectId, name) {
  const pid = String(projectId);
  const internalName = instanceInternal(name);
  const row = store.projectInstance(pid, internalName);
  if (!row) throw error(404, "UNKNOWN_INSTANCE", T`unknown instance: ${name}`);
  if (row.state !== "ready") {
    throw error(409, "INSTANCE_NOT_READY", T`Instance ${name} is not ready (${row.state || T("no state")}) — the Git overview does not wake it.`, { state: row.state || null });
  }
  const inst = runInstance(pid, internalName);
  if (!inst) throw error(409, "NOT_CONVERTED", T`Project ${pid} has not been moved.`);
  return { inst, internalName, name: instanceDisplay(internalName) };
}
