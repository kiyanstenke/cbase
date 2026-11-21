// The state of the project containers.
//
// One row per INSTANCE of a project: `main` (the relocated main stack) and `copy-<name>` (then with `chat_id` and
// `copy_name`). Key `(project_id, instance)`; the external identifier is `<projectId>/<instance>`
// (instanceIdentifier). No foreign key on `projects` (pattern store/graph-starts.js) — the delete paths clear the
// row themselves.
//
// THE ROW IS THE SWITCH: a project counts as converted as soon as `converted_at` is set (`converted(projectId)`),
// set only in the relocation when the stack starts inside. Without a row every switch takes the old path. A row
// WITHOUT `converted_at` (in the middle of creation or relocation) converts nothing.
//
// States: `create` · `start` · `ready` · `recreate` · `relocation` · `clearAway` · `error` · `stop` · `stopped`.
// The six WORKING ones (PROJECT_WORK_STATES) are an unsecured step: they stand in /api/runs/active under
// `projectWork` and make `busy` true (deploy and idle reaper hold, runs/routes.js). `clearAway` carries a copy from
// the start of the phase `fetch`. `error` is NOT a final state and does not hold `busy`; `ready` is rest.
// `stop` is the stop by a human (projectbox/instance-stop.js — about 11 s, the inner containers with their own
// grace period) and works: without it the row would stand on `ready` for 11 s without a reachable dockerd.
// `stopped` is REST like `ready` (does not hold `busy`) — no path starts it by itself (restore, resume, recreate
// leave it); only "Start" and a turn go `stopped → start → ready`. A start waiting for storage stays `stopped` with
// the phase `waiting_storage`. `state_since` is stamped only by a change of state (the `since` in `projectWork`),
// `updated_at` by every change.
//
// `desired` is pure JSON (the containers that should run — name, service, state, exit code, `depends_on`; native
// services; timestamp), kept up to date as a snapshot; broken or empty yields null.
//
// `dns_name`: the name `<slug>.cbase` under which chats without a project, the workspace terminal and the workspace
// browser reach the instance in the user container (line `<ip> <name>` in /etc/hosts, projectbox/names.js). It
// stands HERE so that it stays fixed after creation — a renamed project keeps it, a second one with the same slug
// gets `-2`. Unique across ALL rows (index `idx_project_instances_dns_name`, empty exempt): a collision would be two
// lines of the same name in /etc/hosts, and the first would silently win. `hostname` stays the container hostname
// cbp-<n>.
//
// The stream event for an instance is NOT written by this file (store/ is domain-free) but by the setter
// projectbox/instances.js — whoever changes the state goes through it. Reached via the facade `store.js`
// (`export *`, the registration "project-instances" is there too); the names here are a wrapper (`export { … };`).
import { db } from "./db.js";

const PROJECT_STATES = Object.freeze(["create", "start", "ready", "recreate", "relocation", "clearAway", "error", "stop", "stopped"]);
const PROJECT_WORK_STATES = Object.freeze(["create", "start", "recreate", "relocation", "clearAway", "stop"]);
const list = (xs) => xs.map(() => "?").join(", ");

// WHICH PROJECTS CARRY A ROW, in memory: the ids with at least one row, filled when the schema is created (every
// initStore), maintained at the TWO places that create or delete rows (createProjectInstance, deleteProjectInstance;
// a change does not touch the set). Asked ONLY when the database just threw (`instanceRowPossible`): the lock per
// project (projectbox/idle.js) and the run instance (projectbox/run-instance.js) fail closed only where a row
// affects or could affect the project — without any row a read error stays the old path. Via the ROW, not via
// `converted_at`: a row before the relocation (create, start, relocation) holds starts too. "Empty is not unknown":
// before the first fill every project counts as possible (closed). The limit: a row that ANOTHER process writes into
// the same file is only known to the set after the next start — only this server writes (creation, relocation,
// deletion run through it). A deletion that could not be read back leaves the id (closed, never open).
const withRow = new Set();
let withRowLoaded = false;

function initProjectInstanceSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_instances (
      project_id TEXT NOT NULL,
      instance TEXT NOT NULL,
      container_id TEXT NOT NULL DEFAULT '',
      network TEXT NOT NULL DEFAULT '',
      subnet TEXT NOT NULL DEFAULT '',
      bridge TEXT NOT NULL DEFAULT '',
      ip TEXT NOT NULL DEFAULT '',
      gateway TEXT NOT NULL DEFAULT '',
      hostname TEXT NOT NULL DEFAULT '',
      image_id TEXT NOT NULL DEFAULT '',
      mounts_hash TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL,
      phase TEXT NOT NULL DEFAULT '',
      converted_at INTEGER,
      desired TEXT NOT NULL DEFAULT '',
      chat_id TEXT,
      copy_name TEXT NOT NULL DEFAULT '',
      error TEXT NOT NULL DEFAULT '',
      state_since INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, instance)
    );
    CREATE INDEX IF NOT EXISTS idx_project_instances_state ON project_instances(state);
  `);
  // The name of the instance — added later for an existing table (the same form as store/dynworkflow-runs.js).
  if (!db.prepare("PRAGMA table_info(project_instances)").all().some((c) => c.name === "dns_name")) {
    db.exec("ALTER TABLE project_instances ADD COLUMN dns_name TEXT NOT NULL DEFAULT ''");
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_project_instances_dns_name ON project_instances(dns_name) WHERE dns_name != ''");
  // The set of this database (a second initStore in the same process opens another one).
  withRowLoaded = false;
  withRow.clear();
  for (const r of db.prepare("SELECT DISTINCT project_id FROM project_instances").all()) withRow.add(String(r.project_id));
  withRowLoaded = true;
}

/**
 * Could an instance row affect this project — answered WITHOUT the database, for the case that it just threw (see
 * above). `projectId` empty ⇒ any project (that of the chat could not be read). Before the first fill: yes.
 */
function instanceRowPossible(projectId = null) {
  if (!withRowLoaded) return true;
  return projectId ? withRow.has(String(projectId)) : withRow.size > 0;
}

// THE OBSERVER OF THE SWITCH. Whoever needs to know WHICH projects are converted without being able to ask the
// database — the wrapper `cbase-git` in the user container reads a list for that (projectbox/git-assignment.js
// writeGitProjects) — would otherwise learn of a change only at the next server start. Hence every change of
// `converted_at` calls the observer HERE: creating a row WITH `converted_at`, a change that switches `converted_at`,
// and deleting a row that carried it — the three write paths of this file, hence EVERY path. As a microtask and
// batched: the caller has finished writing its step, and several changes in one transaction (deleting several
// projects) yield ONE call. A setter, not an import (store/ is domain-free) — set in server.js to writeGitProjects;
// without a setter nothing happens. A throw of the observer is only logged.
let convertedObserver = null;
let convertedDue = false;
function setConvertedObserver(fn) { convertedObserver = typeof fn === "function" ? fn : null; }
function convertedChanged() {
  if (!convertedObserver || convertedDue) return;
  convertedDue = true;
  queueMicrotask(() => {
    convertedDue = false;
    const fn = convertedObserver;
    if (!fn) return;
    try { fn(); } catch (e) { console.error("[project-instances] observer of converted_at:", e?.message || e); }
  });
}

// THE OBSERVER OF THE DELETE PATHS. Whoever is bound to a target that a delete path of the data layer removes — an
// instance, a project, a service — must LEARN of it before the same target can be assigned anew: a preview link
// (preview/links.js) points with a public ngrok listener at the IP of an instance, and `selectSubnet`
// (projectbox/creation.js) gives the first free /24 with its .2 to the NEXT instance — possibly that of a foreign
// project. A tick alone would be up to a minute late. Hence every delete path calls the observer HERE,
// SYNCHRONOUSLY and after the DELETE (with a transaction after the transaction — a rolled-back one reports nothing):
// `deleteProjectInstance` (this file), `deleteProject`/`deleteWorkspace` (store/workspaces.js),
// `deleteProjectService`, `serviceFallsWithLayout` and the scan reconciliation `reconcileScan` (store/projects.js).
// The events:
//   { kind: "instance", projectId, instances: [name, …] }   the deleted instance rows (names read before the DELETE)
//   { kind: "project", projectId }                          a deleted project (also one without an instance row)
//   { kind: "service", projectId, serviceIds: [id, …] }     deleted services
// A setter, not an import (store/ is domain-free) — set in server.js to preview/links.js `targetRemoved`; without a
// setter nothing happens. Here instead of in a file of its own because the instance is the cause (and
// projects.js/workspaces.js only import `reportTargetRemoved` — an edge to a leaf that itself only imports db.js).
// A throw of the observer is only logged: a delete path never fails because of it.
let targetWayObserver = null;
function setTargetRemovedObserver(fn) { targetWayObserver = typeof fn === "function" ? fn : null; }
/** ONLY for the delete paths of the data layer (see above). */
function reportTargetRemoved(event) {
  const fn = targetWayObserver;
  if (!fn) return;
  try { fn(event); } catch (e) { console.error("[project-instances] observer of the delete paths:", e?.message || e); }
}

function desiredFrom(text) {
  if (!text) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" ? v : null;
  } catch { return null; }
}

function mapProjectInstance(r) {
  if (!r) return null;
  return {
    projectId: r.project_id, instance: r.instance, identifier: `${r.project_id}/${r.instance}`,
    containerId: r.container_id, network: r.network, subnet: r.subnet, bridge: r.bridge, ip: r.ip, gateway: r.gateway,
    hostname: r.hostname, dnsName: r.dns_name ?? "", imageId: r.image_id, mountsHash: r.mounts_hash,
    state: r.state, phase: r.phase, convertedAt: r.converted_at ?? null, desired: desiredFrom(r.desired),
    chatId: r.chat_id ?? null, copyName: r.copy_name, error: r.error,
    stateSince: r.state_since, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

function checkState(state) {
  if (!PROJECT_STATES.includes(state)) throw new Error(`project instance: unknown state "${state}"`);
}

const instanceIdentifier = (projectId, instance = "main") => `${projectId}/${instance}`;

const projectInstance = (projectId, instance = "main") =>
  mapProjectInstance(db.prepare("SELECT * FROM project_instances WHERE project_id = ? AND instance = ?").get(String(projectId), String(instance)));

/** The main instance of a project; `null` without a row (the old path). */
const instanceFor = (projectId) => projectInstance(projectId, "main");

/** Is the project converted? Exactly if its main instance carries `converted_at`. */
const converted = (projectId) => Boolean(instanceFor(projectId)?.convertedAt);

/**
 * Is the store open (initStore has run)? Before that there is no instance row — runs/runtime-location.js then takes
 * the flat location (unit tests without a database) and throws on every OTHER read error.
 */
const instancesReadable = () => db != null;

// The changeable fields. `undefined` is "not set", `null` a value.
const FIELDS = {
  containerId: "container_id", network: "network", subnet: "subnet", bridge: "bridge", ip: "ip", gateway: "gateway",
  hostname: "hostname", dnsName: "dns_name", imageId: "image_id", mountsHash: "mounts_hash", phase: "phase", convertedAt: "converted_at",
  chatId: "chat_id", copyName: "copy_name", error: "error",
};
const desiredText = (desired) => (desired === null || desired === undefined ? "" : JSON.stringify(desired));

/**
 * A new row; `projectId` and `state` are mandatory (no silent state). A second row with the same key throws
 * (UNIQUE — `isUniqueViolation` detects it). Returns the row read back.
 */
function createProjectInstance({ projectId, instance = "main", state, desired = null, now = Date.now(), ...fields } = {}) {
  if (!projectId || !instance || !state) throw new Error("createProjectInstance: projectId, instance and state are mandatory");
  checkState(state);
  const columns = ["project_id", "instance", "state", "desired", "state_since", "created_at", "updated_at"];
  const values = [String(projectId), String(instance), state, desiredText(desired), now, now, now];
  for (const [k, column] of Object.entries(FIELDS)) {
    if (fields[k] === undefined) continue;
    columns.push(column);
    values.push(fields[k]);
  }
  db.prepare(`INSERT INTO project_instances (${columns.join(", ")}) VALUES (${list(columns)})`).run(...values);
  withRow.add(String(projectId));
  if (fields.convertedAt !== undefined && fields.convertedAt !== null) convertedChanged();
  return projectInstance(projectId, instance);
}

/**
 * Change fields of a row; stamps `updated_at`, a change of state also `state_since`. `desired` is replaced as a
 * whole. Returns `{ prior, after, applied }` (`prior`/`after` `null` if the row does not exist) — the setter
 * (projectbox/instances.js) decides from it whether an event is due.
 * `ifState`: the change holds ONLY if the row is in this state — condition in the UPDATE itself, ONE step (the
 * transition of a copy to `ready` together with `converted_at`). If it stands differently, nothing changes,
 * `applied` is false and `after` the unchanged row.
 */
function changeProjectInstance(projectId, instance = "main", { state, desired, now = Date.now(), ifState, ...fields } = {}) {
  const prior = projectInstance(projectId, instance);
  if (!prior) return { prior: null, after: null, applied: false };
  const sets = ["updated_at = ?"];
  const vals = [now];
  if (state !== undefined) {
    checkState(state);
    sets.push("state = ?");
    vals.push(state);
    if (state !== prior.state) { sets.push("state_since = ?"); vals.push(now); }
  }
  if (desired !== undefined) { sets.push("desired = ?"); vals.push(desiredText(desired)); }
  for (const [k, column] of Object.entries(FIELDS)) {
    if (fields[k] === undefined) continue;
    sets.push(`${column} = ?`);
    vals.push(fields[k]);
  }
  vals.push(String(projectId), String(instance));
  let condition = "";
  if (ifState !== undefined) { checkState(ifState); condition = " AND state = ?"; vals.push(ifState); }
  const r = db.prepare(`UPDATE project_instances SET ${sets.join(", ")} WHERE project_id = ? AND instance = ?${condition}`).run(...vals);
  const after = projectInstance(projectId, instance);
  if ((prior.convertedAt ?? null) !== (after?.convertedAt ?? null)) convertedChanged();
  return { prior, after, applied: r.changes > 0 };
}

/** All instances, in order of creation. */
const projectInstances = () =>
  db.prepare("SELECT * FROM project_instances ORDER BY created_at, rowid").all().map(mapProjectInstance);

/** The instances in one of the states, in order of creation. An empty list yields []. */
function projectInstancesInState(states) {
  const z = (Array.isArray(states) ? states : []).map(String);
  if (!z.length) return [];
  return db.prepare(`SELECT * FROM project_instances WHERE state IN (${list(z)}) ORDER BY created_at, rowid`).all(...z).map(mapProjectInstance);
}

/** All instances of ONE project, in order of creation — for the delete paths. */
const projectInstancesOf = (projectId) =>
  db.prepare("SELECT * FROM project_instances WHERE project_id = ? ORDER BY created_at, rowid").all(String(projectId)).map(mapProjectInstance);

/**
 * Delete the row(s) of a project — only the delete paths, AFTER the container is gone: without a row every switch
 * takes the old path again. Without `instance` all instances of the project. Returns the number of deleted rows.
 */
function deleteProjectInstance(projectId, instance) {
  const pid = String(projectId);
  if (instance === undefined) {
    const trug = db.prepare("SELECT 1 FROM project_instances WHERE project_id = ? AND converted_at IS NOT NULL LIMIT 1").get(pid);
    const names = db.prepare("SELECT instance FROM project_instances WHERE project_id = ?").all(pid).map((r) => r.instance);
    const n = db.prepare("DELETE FROM project_instances WHERE project_id = ?").run(pid).changes;
    withRow.delete(pid);
    if (trug && n) convertedChanged();
    if (n) reportTargetRemoved({ kind: "instance", projectId: pid, instances: names });
    return n;
  }
  const trug = db.prepare("SELECT 1 FROM project_instances WHERE project_id = ? AND instance = ? AND converted_at IS NOT NULL").get(pid, String(instance));
  const n = db.prepare("DELETE FROM project_instances WHERE project_id = ? AND instance = ?").run(pid, String(instance)).changes;
  if (trug && n) convertedChanged();
  if (n) reportTargetRemoved({ kind: "instance", projectId: pid, instances: [String(instance)] });
  try { if (!db.prepare("SELECT 1 FROM project_instances WHERE project_id = ? LIMIT 1").get(pid)) withRow.delete(pid); }
  catch { /* could not be read back: the id stays (closed, never open) */ }
  return n;
}

export {
  PROJECT_WORK_STATES, PROJECT_STATES, initProjectInstanceSchema, instanceFor, instanceIdentifier, projectInstance, changeProjectInstance,
  createProjectInstance, deleteProjectInstance, projectInstances, projectInstancesInState, projectInstancesOf, setConvertedObserver, converted,
  instancesReadable, instanceRowPossible, reportTargetRemoved, setTargetRemovedObserver,
};
