// The job of a layout and the superseded containers of renamed stacks. The mechanism (quiet, lock, procedure) is in
// projectbox/layout/; here is only the storage.
//
// `project_layout` — at most ONE job per project (key `project_id`). `state`: waiting · running · error · finished.
//   `turned` (0/1: the procedure has passed the turning point — from there only forward), `backward` (0/1: a return
//   path is outstanding, after a restart before the turning point), `plan` (JSON: steps and final mapping),
//   `confirmed` (JSON: the confirmed check — paths and Docker objects with id, name and size), `prior` (JSON: the
//   inventory before the rebuild; ONLY written if the column is empty — `setLayoutPrior` — and only cleared once a
//   return path ran completely or the job is `finished`), `journal` (JSON: the state of projectbox/journal.js with
//   its data), `step`, `process` (boot id of the process in which `running` holds), `error`, `report` (JSON), `since`
//   (start of the job — the pass-through `parentSince < since`), `created_at`, `updated_at`. A row in `finished`
//   carries the last report until the next job; `error` with `turned = 0` means "failed before the turning point,
//   nothing changed" (the lock is released then).
//   OPEN (`layoutLocks`): `waiting`, `running` and `error` AFTER the turning point — the layout lock stands, copy and
//   upload answer 409, a new job is JOB_OPEN. `finished` and `error` before the turning point are replaced by a new
//   job.
// `project_superseded` — the old containers of a renamed stack, key (project_id, instance, container_id).
//   `name_now` is the name after a `docker rename` (otherwise equal to `name_prior`). Read by matchContainers (skips
//   them), by the target snapshot (never includes them), by step 20 of the layout and by "remove old containers"
//   (projectbox/layout/superseded.js — a row ONLY falls if the daemon no longer knows its container AND its
//   earmarked objects are done; `supersededCount` is the count shown on the project).
//   `earmarked` (JSON `{ volumes: [name], networks: [id] }`, empty = nothing): the CONFIRMED volumes and networks
//   this container mounts or hangs in — written BEFORE its `docker rm` (`earmarkSuperseded`). After an abort or
//   restart between `rm` and `volume rm` an anonymous volume would otherwise have no assignment left (the container
//   that mounted it is gone) and would lie around invisibly. Added later via ALTER with default '' — a release
//   without the column reads `SELECT *` and writes with named columns, it does no harm there.
//
// Both tables fall in the delete path of the project box (projectbox/erase.js → `deleteLayout`), never by the data
// layer alone — a running job is an occupation, deleting then answers `OCCUPIED`. No foreign key on `projects`
// (pattern store/project-instances.js). Reached via the facade `store.js` (`export *`, registration
// "project-layout" before "chat-search"); the names here are a wrapper (`export { … };`).
import { db } from "./db.js";

const LAYOUT_STATES = Object.freeze(["waiting", "running", "error", "finished"]);
const JSON_FIELDS = Object.freeze({ plan: "plan", confirmed: "confirmed", prior: "prior", journal: "journal", report: "report" });

function initProjectLayoutSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_layout (
      project_id TEXT PRIMARY KEY,
      state TEXT NOT NULL DEFAULT 'waiting',
      turned INTEGER NOT NULL DEFAULT 0,
      backward INTEGER NOT NULL DEFAULT 0,
      plan TEXT NOT NULL DEFAULT '',
      confirmed TEXT NOT NULL DEFAULT '',
      prior TEXT NOT NULL DEFAULT '',
      journal TEXT NOT NULL DEFAULT '',
      step TEXT NOT NULL DEFAULT '',
      process TEXT NOT NULL DEFAULT '',
      error TEXT NOT NULL DEFAULT '',
      report TEXT NOT NULL DEFAULT '',
      since INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS project_superseded (
      project_id TEXT NOT NULL,
      instance TEXT NOT NULL DEFAULT 'main',
      container_id TEXT NOT NULL,
      name_prior TEXT NOT NULL DEFAULT '',
      name_now TEXT NOT NULL DEFAULT '',
      stack_prior TEXT NOT NULL DEFAULT '',
      stack_now TEXT NOT NULL DEFAULT '',
      since INTEGER NOT NULL,
      earmarked TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (project_id, instance, container_id)
    );
  `);
  // The column for databases that already carried the table without it (see head, `earmarked`).
  if (!db.prepare("PRAGMA table_info(project_superseded)").all().some((c) => c.name === "earmarked")) {
    db.exec("ALTER TABLE project_superseded ADD COLUMN earmarked TEXT NOT NULL DEFAULT ''");
  }
}

const jsonFrom = (text) => {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
};
const jsonIn = (value) => (value === null || value === undefined ? "" : JSON.stringify(value));

function mapLayout(r) {
  if (!r) return null;
  const m = {
    projectId: r.project_id, state: r.state, turned: r.turned === 1, backward: r.backward === 1,
    step: r.step, process: r.process, error: r.error, since: r.since, createdAt: r.created_at, updatedAt: r.updated_at,
  };
  for (const [field, column] of Object.entries(JSON_FIELDS)) m[field] = jsonFrom(r[column]);
  return m;
}

/** Does this job lock (head, "OPEN")? Pure, on the mapped row. */
const layoutLocks = (a) => Boolean(a) && (a.state === "waiting" || a.state === "running" || (a.state === "error" && a.turned === true));

const layoutJob = (projectId) => mapLayout(db.prepare("SELECT * FROM project_layout WHERE project_id = ?").get(String(projectId ?? "")));
const layoutJobs = () => db.prepare("SELECT * FROM project_layout ORDER BY created_at, project_id").all().map(mapLayout);
/** The OPEN job (head) — or null. For copy, upload, delete and the reader of the setup. */
const layoutOpen = (projectId) => { const a = layoutJob(projectId); return layoutLocks(a) ? a : null; };

/** Create a new job — it replaces a row in `finished` or `error` before the turning point, otherwise it throws (the
 *  route checks JOB_OPEN beforehand; here it is the safeguard). Returns the row. */
function createLayout({ projectId, plan, confirmed, since = Date.now() }) {
  if (!projectId) throw new TypeError("layout: projectId is mandatory");
  const pid = String(projectId);
  const old = layoutJob(pid);
  if (layoutLocks(old)) throw Object.assign(new Error(`layout ${pid}: a job is open (${old.state})`), { code: "JOB_OPEN" });
  const t = Date.now();
  db.prepare("DELETE FROM project_layout WHERE project_id = ?").run(pid);
  db.prepare(`INSERT INTO project_layout (project_id, state, plan, confirmed, since, created_at, updated_at)
              VALUES (?, 'waiting', ?, ?, ?, ?, ?)`).run(pid, jsonIn(plan), jsonIn(confirmed), Number(since), t, t);
  return layoutJob(pid);
}

/**
 * Write fields: `{ state, turned, backward, step, process, error, since, plan, confirmed, journal, report }` — each
 * optional. `prior` ONLY goes through setLayoutPrior/clearLayoutPrior (the rule "only with an empty column"). Throws
 * on an unknown state or a missing row. Returns the row afterwards.
 */
function layoutSet(projectId, fields = {}) {
  const pid = String(projectId ?? "");
  const sets = []; const values = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    if (k === "state") {
      if (!LAYOUT_STATES.includes(v)) throw new TypeError(`layout: unknown state "${v}"`);
      sets.push("state = ?"); values.push(v);
    } else if (k === "turned" || k === "backward") { sets.push(`${k} = ?`); values.push(v ? 1 : 0); }
    else if (k === "step" || k === "process" || k === "error") { sets.push(`${k} = ?`); values.push(String(v ?? "")); }
    else if (k === "since") { sets.push("since = ?"); values.push(Number(v)); } // "again" before the turning point: a new wait
    else if (k === "prior") throw new TypeError("layout: `prior` only via setLayoutPrior/clearLayoutPrior");
    else if (Object.hasOwn(JSON_FIELDS, k)) { sets.push(`${JSON_FIELDS[k]} = ?`); values.push(jsonIn(v)); }
    else throw new TypeError(`layout: unknown field "${k}"`);
  }
  sets.push("updated_at = ?"); values.push(Date.now());
  const r = db.prepare(`UPDATE project_layout SET ${sets.join(", ")} WHERE project_id = ?`).run(...values, pid);
  if (!r.changes) throw new Error(`layout ${pid}: no job`);
  return layoutJob(pid);
}

/** Write `prior` — ONLY if the column is empty (head). → true if written; false if an inventory already stood. */
function setLayoutPrior(projectId, prior) {
  const r = db.prepare("UPDATE project_layout SET prior = ?, updated_at = ? WHERE project_id = ? AND prior = ''")
    .run(jsonIn(prior), Date.now(), String(projectId ?? ""));
  return r.changes > 0;
}
/** Clear `prior` — after a complete return path or at the end (`finished`). */
function clearLayoutPrior(projectId) {
  db.prepare("UPDATE project_layout SET prior = '', updated_at = ? WHERE project_id = ?").run(Date.now(), String(projectId ?? ""));
}

/** Delete the job of a project (take back; delete path). → whether a row fell. */
const deleteLayoutJob = (projectId) => db.prepare("DELETE FROM project_layout WHERE project_id = ?").run(String(projectId ?? "")).changes > 0;

/** The delete path of the project box (projectbox/erase.js): both tables of the project. */
function deleteLayout(projectId) {
  const pid = String(projectId ?? "");
  db.prepare("DELETE FROM project_layout WHERE project_id = ?").run(pid);
  db.prepare("DELETE FROM project_superseded WHERE project_id = ?").run(pid);
}

/** For `/api/runs/active` and the deploy (rollback lock): the jobs in `running` (before OR after the turning point),
 *  in `error` after the turning point and in `error` with a failed RETURN PATH (`backward = 1`) — there containers
 *  still stand stopped with `restart no` and the target without them, the old rules only in the journal; a release
 *  without layout does not know this journal, and everything would stay off (the same reasoning as for `running`
 *  before the turning point). The same condition is in the reader of the deploy (the deploy tool's capabilities.mjs
 *  LAYOUT_SCRIPT). */
const layoutsOpenCount = () => db.prepare("SELECT count(*) AS n FROM project_layout WHERE state = 'running' OR (state = 'error' AND (turned = 1 OR backward = 1))").get().n;
/** The jobs in `waiting` (the status line of the deploy). */
const layoutsWaitingCount = () => db.prepare("SELECT count(*) AS n FROM project_layout WHERE state = 'waiting'").get().n;
/** For the project work in `/api/runs/active`: the jobs running IN THIS process (`process` = boot id) — light,
 *  without the JSON columns. → [{ projectId, step, since }]. */
const layoutsInWork = (bootId) => db.prepare("SELECT project_id, step, since FROM project_layout WHERE state = 'running' AND process = ? ORDER BY project_id")
  .all(String(bootId ?? "")).map((r) => ({ projectId: r.project_id, step: r.step, since: r.since }));

// ── project_superseded ─────────────────────────────────────────────────────────────────────────────────────────────────

// `earmarked` (head) read: only lists of strings; anything unreadable is empty (only earmarkSuperseded writes the column).
const strings = (l) => (Array.isArray(l) ? [...new Set(l.filter((x) => typeof x === "string" && x))] : []);
function earmarkingFrom(text) {
  const v = jsonFrom(text);
  return { volumes: strings(v?.volumes), networks: strings(v?.networks) };
}

const mapSuperseded = (r) => (r ? {
  projectId: r.project_id, instance: r.instance, containerId: r.container_id, namePrior: r.name_prior, nameNow: r.name_now,
  stackPrior: r.stack_prior, stackNow: r.stack_now, since: r.since, earmarked: earmarkingFrom(r.earmarked),
} : null);

/** Create a row (idempotent: an existing one stays, only `name_now` follows). */
function rememberSuperseded({ projectId, instance = "main", containerId, namePrior = "", nameNow = "", stackPrior = "", stackNow = "" }) {
  if (!projectId || !containerId) throw new TypeError("superseded: projectId and containerId are mandatory");
  db.prepare(`INSERT INTO project_superseded (project_id, instance, container_id, name_prior, name_now, stack_prior, stack_now, since)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(project_id, instance, container_id) DO UPDATE SET name_now = excluded.name_now`)
    .run(String(projectId), String(instance), String(containerId), String(namePrior), String(nameNow || namePrior), String(stackPrior), String(stackNow), Date.now());
}
const supersededOf = (projectId, instance = null) => (instance
  ? db.prepare("SELECT * FROM project_superseded WHERE project_id = ? AND instance = ? ORDER BY since, container_id").all(String(projectId), String(instance))
  : db.prepare("SELECT * FROM project_superseded WHERE project_id = ? ORDER BY since, container_id").all(String(projectId))).map(mapSuperseded);
/** The ids of the superseded containers of a project (all instances) — for matchContainers and the target snapshot. */
const supersededIds = (projectId) => new Set(db.prepare("SELECT container_id FROM project_superseded WHERE project_id = ?").all(String(projectId ?? "")).map((r) => r.container_id));
const removeSuperseded = (projectId, instance, containerId) =>
  db.prepare("DELETE FROM project_superseded WHERE project_id = ? AND instance = ? AND container_id = ?").run(String(projectId), String(instance), String(containerId)).changes > 0;
/** Replace the earmarking of ONE row — `{ volumes: [name], networks: [id] }`. → whether the row was there. */
function earmarkSuperseded(projectId, instance, containerId, { volumes = [], networks = [] } = {}) {
  const value = JSON.stringify({ volumes: strings(volumes), networks: strings(networks) });
  return db.prepare("UPDATE project_superseded SET earmarked = ? WHERE project_id = ? AND instance = ? AND container_id = ?")
    .run(value, String(projectId), String(instance), String(containerId)).changes > 0;
}
/** The number of rows of a project in the MAIN instance — the superseded count on the project (a number without
 *  ids; layout and with it `project_superseded` only exist there). */
const supersededCount = (projectId) => db.prepare("SELECT count(*) AS n FROM project_superseded WHERE project_id = ? AND instance = 'main'").get(String(projectId ?? "")).n;
/** The projects with at least one row in the main instance (for setupField: which projects carry the field). */
const supersededProjects = () => db.prepare("SELECT DISTINCT project_id FROM project_superseded WHERE instance = 'main' ORDER BY project_id").all().map((r) => r.project_id);

export {
  LAYOUT_STATES, initProjectLayoutSchema, layoutLocks, layoutJob, layoutJobs, layoutOpen,
  createLayout, layoutSet, setLayoutPrior, clearLayoutPrior, deleteLayoutJob, deleteLayout,
  layoutsOpenCount, layoutsWaitingCount, layoutsInWork, rememberSuperseded, supersededOf, supersededIds, removeSuperseded,
  earmarkSuperseded, supersededCount, supersededProjects,
};
