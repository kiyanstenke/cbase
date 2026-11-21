// The setup of a new project. The mechanics (steps, occupancy, resumption) are in projectbox/setup/procedure.js;
// here is only the storage — four tables, all with `project_id`, all falling in projectbox/erase.js
// deleteProjectbox (project AND workspace; the exceptions with their reasons are in
// server/backend/test/schema-register.test.js).
//
//   project_setup          one row per OPEN setup, deleted on success and on every delete path. `step`
//                          (SETUP_STEPS), `state` (setUp · error), `error` (text without values), `code`, `waiting`
//                          (storage · conflict · empty), `conflict` (JSON `{ existing, examples, mode? }`, only in
//                          `place`), `code_repos` (JSON `[{ rel, created, message? }]` from the plan), `process` (the
//                          boot id of the process whose procedure is driving a server step RIGHT NOW; empty while
//                          waiting for a human, an upload or storage).
//   project_setup_source   per source (PK project_id, seq): `kind` (SOURCE_KINDS), `target` (relative to the root),
//                          `state` (SOURCE_STATES), `error`, `code`, `host`, `clone_url` (without user),
//                          `clone_branch`, the three flags `*_fetched` (each AFTER the effect), `operation`,
//                          `archive_id`, `mapping` (JSON, ZIP only), `bytes` (announced), `process`.
//   project_archive        archives per `archive_id` (ZIP) — the file is in the runtime folder.
//   project_upload         upload operations (`operation` PK): `purpose` (UPLOAD_PURPOSES), `source_seq`, `kind`,
//                          `staging` (relative to the root), `state` (UPLOAD_STATES), `new_folder` (JSON),
//                          `conflict`, `last_chunk` (START of the last chunk request), `process`; for retroactive
//                          uploads also `error` (text without values), `code`, `finding` (JSON — on a conflict
//                          `{ existing, examples }`) and `state_since`, added by ALTER. In state `place`, `process`
//                          carries the boot id of the process that is placing or unpacking RIGHT NOW — like the
//                          server steps of the setup (a foreign one is "interrupted" to the outside).
//
// No CHECK clauses (the delete-list guard seeds every table with all-purpose values) and no foreign key to
// `projects` (pattern store/project-instances.js). Reached through the facade `store.js` (`export *`, registration
// "project-setup" there); the names here are wrappers (`export { … };`).
//
// THE VIEW (setupView, PURE): a row whose server step carries a FOREIGN `process` (a boot id other than the one
// passed in) computes as `error`/`INTERRUPTED` — until the resumption takes it over. The same per source in a
// server state. The server step is a property of the row, never a memory value: after a restart it stands as the
// previous process left it.
import { db, inOneTransaction } from "./db.js";

const SETUP_STEPS = Object.freeze(["container", "sources", "place", "code-repos", "project-repo"]);
// The steps the server drives itself — `sources` waits for uploads and clones.
const SETUP_SERVER_STEPS = Object.freeze(["container", "place", "code-repos", "project-repo"]);
const SOURCE_KINDS = Object.freeze(["files", "folder", "zip", "clone"]);
const SOURCE_STATES = Object.freeze(["wait-upload", "staged", "unpack", "clone", "submodule", "lfs", "error", "aborted", "leftOut"]);
// The states of a source in which the server works (unpack, clone).
const SOURCE_SERVER_STATES = Object.freeze(["unpack", "clone", "submodule", "lfs"]);
const UPLOAD_PURPOSES = Object.freeze(["creation", "retroactive"]);
const UPLOAD_STATES = Object.freeze(["upload", "place", "error"]);
const UPLOAD_ADDENDUM = Object.freeze([
  ["error", "TEXT NOT NULL DEFAULT ''"], ["code", "TEXT NOT NULL DEFAULT ''"], ["finding", "TEXT NOT NULL DEFAULT ''"],
  ["state_since", "INTEGER NOT NULL DEFAULT 0"],
]);

function initProjectSetupSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_setup (
      project_id TEXT PRIMARY KEY,
      step TEXT NOT NULL DEFAULT 'container',
      state TEXT NOT NULL DEFAULT 'setUp',
      error TEXT NOT NULL DEFAULT '',
      code TEXT NOT NULL DEFAULT '',
      waiting TEXT NOT NULL DEFAULT '',
      conflict TEXT NOT NULL DEFAULT '',
      code_repos TEXT NOT NULL DEFAULT '[]',
      process TEXT NOT NULL DEFAULT '',
      state_since INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS project_setup_source (
      project_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      kind TEXT NOT NULL DEFAULT '',
      target TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT 'wait-upload',
      error TEXT NOT NULL DEFAULT '',
      code TEXT NOT NULL DEFAULT '',
      host TEXT NOT NULL DEFAULT '',
      clone_url TEXT NOT NULL DEFAULT '',
      clone_branch TEXT NOT NULL DEFAULT '',
      clone_fetched INTEGER NOT NULL DEFAULT 0,
      submodule_fetched INTEGER NOT NULL DEFAULT 0,
      lfs_fetched INTEGER NOT NULL DEFAULT 0,
      operation TEXT NOT NULL DEFAULT '',
      archive_id TEXT NOT NULL DEFAULT '',
      mapping TEXT NOT NULL DEFAULT '',
      bytes INTEGER NOT NULL DEFAULT 0,
      process TEXT NOT NULL DEFAULT '',
      state_since INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (project_id, seq)
    );
    CREATE TABLE IF NOT EXISTS project_archive (
      archive_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      operation TEXT NOT NULL DEFAULT '',
      purpose TEXT NOT NULL DEFAULT 'creation',
      state TEXT NOT NULL DEFAULT 'upload',
      size INTEGER NOT NULL DEFAULT 0,
      target TEXT NOT NULL DEFAULT '',
      mode TEXT NOT NULL DEFAULT '',
      process TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_project_archive_project ON project_archive(project_id);
    CREATE TABLE IF NOT EXISTS project_upload (
      operation TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      purpose TEXT NOT NULL DEFAULT 'creation',
      source_seq INTEGER,
      kind TEXT NOT NULL DEFAULT 'files',
      staging TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT 'upload',
      new_folder TEXT NOT NULL DEFAULT '[]',
      conflict TEXT,
      last_chunk INTEGER NOT NULL DEFAULT 0,
      process TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_project_upload_project ON project_upload(project_id);
  `);
  // The columns of the retroactive operation — an addendum to an existing table (the same form as
  // store/project-instances.js `dns_name`). No backfill: the defaults are the values of an operation without error.
  const columns = new Set(db.prepare("PRAGMA table_info(project_upload)").all().map((c) => c.name));
  for (const [column, kind] of UPLOAD_ADDENDUM) {
    if (!columns.has(column)) db.exec(`ALTER TABLE project_upload ADD COLUMN ${column} ${kind}`);
  }
}

const jsonFrom = (text, fallback = null) => {
  if (!text) return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
};

function mapSource(r) {
  if (!r) return null;
  return {
    projectId: r.project_id, seq: r.seq, kind: r.kind, target: r.target, name: r.name, state: r.state, error: r.error, code: r.code,
    host: r.host, cloneUrl: r.clone_url, cloneBranch: r.clone_branch, cloneFetched: Boolean(r.clone_fetched),
    submoduleFetched: Boolean(r.submodule_fetched), lfsFetched: Boolean(r.lfs_fetched), operation: r.operation, archiveId: r.archive_id,
    mapping: jsonFrom(r.mapping), bytes: r.bytes, process: r.process, stateSince: r.state_since,
  };
}

function mapSetup(r) {
  if (!r) return null;
  return {
    projectId: r.project_id, step: r.step, state: r.state, error: r.error, code: r.code, waiting: r.waiting,
    conflict: jsonFrom(r.conflict), codeRepos: jsonFrom(r.code_repos, []) || [], process: r.process, stateSince: r.state_since,
    createdAt: r.created_at, updatedAt: r.updated_at,
    sources: db.prepare("SELECT * FROM project_setup_source WHERE project_id = ? ORDER BY seq").all(r.project_id).map(mapSource),
  };
}

/**
 * Create the setup and its sources in ONE transaction (the POST). `sources`: `[{ seq, kind, target, name?, host?,
 * cloneUrl?, cloneBranch?, bytes?, mapping? }]`; `codeRepos`: `[rel]`; `process`: the boot id of the creating
 * process (step `container`). An existing row THROWS (the POST creates a new project — there is none).
 */
function createSetup({ projectId, sources = [], codeRepos = [], process = "" }) {
  if (!projectId) throw new TypeError("setup: projectId missing");
  const t = Date.now();
  inOneTransaction(() => {
    db.prepare(`INSERT INTO project_setup (project_id, step, state, code_repos, process, state_since, created_at, updated_at)
                VALUES (?, 'container', 'setUp', ?, ?, ?, ?, ?)`)
      .run(String(projectId), JSON.stringify(codeRepos.map((rel) => ({ rel: String(rel), created: false }))), String(process || ""), t, t, t);
    const q = db.prepare(`INSERT INTO project_setup_source (project_id, seq, kind, target, name, state, host, clone_url, clone_branch, mapping, bytes, state_since)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const x of sources) {
      if (!SOURCE_KINDS.includes(x.kind)) throw new TypeError(`setup: unknown source kind "${x.kind}"`);
      q.run(String(projectId), Number(x.seq), x.kind, String(x.target || ""), String(x.name || ""), x.kind === "clone" ? "clone" : "wait-upload",
        String(x.host || ""), String(x.cloneUrl || ""), String(x.cloneBranch || ""), x.mapping ? JSON.stringify(x.mapping) : "",
        Number(x.bytes) > 0 ? Math.floor(Number(x.bytes)) : 0, t);
    }
  });
  return setupOf(projectId);
}

const setupOf = (projectId) => mapSetup(db.prepare("SELECT * FROM project_setup WHERE project_id = ?").get(String(projectId)));
const setups = () => db.prepare("SELECT * FROM project_setup ORDER BY created_at").all().map(mapSetup);
const sourceOf = (projectId, seq) => mapSource(db.prepare("SELECT * FROM project_setup_source WHERE project_id = ? AND seq = ?").get(String(projectId), Number(seq)));

const SETUP_COLUMNS = { step: "step", state: "state", error: "error", code: "code", waiting: "waiting", conflict: "conflict", codeRepos: "code_repos", process: "process" };
// `name`: starting a ZIP source anew sets the name of the newly chosen archive.
const SOURCE_COLUMNS = {
  state: "state", error: "error", code: "code", host: "host", cloneFetched: "clone_fetched", submoduleFetched: "submodule_fetched",
  lfsFetched: "lfs_fetched", operation: "operation", archiveId: "archive_id", bytes: "bytes", process: "process", name: "name",
};
const columnsValue = (field, v) => {
  if (field === "conflict" || field === "codeRepos") return v === null || v === undefined ? (field === "codeRepos" ? "[]" : "") : JSON.stringify(v);
  if (typeof v === "boolean") return v ? 1 : 0;
  return v === null || v === undefined ? "" : v;
};

/**
 * Change fields of the setup. `when` (optional): `{ step?, state?, process? }` — the condition sits in the UPDATE;
 * not applied ⇒ `null` (the caller lost the race, nothing changed). A change of `state` or `step` sets
 * `state_since`. Returns the row afterwards (or null if there is none or the condition did not hold).
 */
function changeSetup(projectId, fields = {}, { when = null } = {}) {
  const prior = db.prepare("SELECT * FROM project_setup WHERE project_id = ?").get(String(projectId));
  if (!prior) return null;
  const set = [];
  const values = [];
  for (const [field, column] of Object.entries(SETUP_COLUMNS)) {
    if (fields[field] === undefined) continue;
    set.push(`${column} = ?`);
    values.push(columnsValue(field, fields[field]));
  }
  const t = Date.now();
  if ((fields.state !== undefined && fields.state !== prior.state) || (fields.step !== undefined && fields.step !== prior.step)) {
    set.push("state_since = ?");
    values.push(t);
  }
  set.push("updated_at = ?");
  values.push(t);
  const bed = ["project_id = ?"];
  const bedValues = [String(projectId)];
  for (const [field, column] of [["step", "step"], ["state", "state"], ["process", "process"]]) {
    if (when && when[field] !== undefined) { bed.push(`${column} = ?`); bedValues.push(String(when[field])); }
  }
  const r = db.prepare(`UPDATE project_setup SET ${set.join(", ")} WHERE ${bed.join(" AND ")}`).run(...values, ...bedValues);
  if (!r.changes) return null;
  return setupOf(projectId);
}

/** Change a source; `when: { state, process? }` as above (`state` text or list; with `process`, leaving a source out
 *  only writes if the source still stands as it was checked). Returns the source afterwards or null. */
function changeSource(projectId, seq, fields = {}, { when = null } = {}) {
  const prior = db.prepare("SELECT * FROM project_setup_source WHERE project_id = ? AND seq = ?").get(String(projectId), Number(seq));
  if (!prior) return null;
  const set = [];
  const values = [];
  for (const [field, column] of Object.entries(SOURCE_COLUMNS)) {
    if (fields[field] === undefined) continue;
    set.push(`${column} = ?`);
    values.push(columnsValue(field, fields[field]));
  }
  if (fields.state !== undefined && fields.state !== prior.state) { set.push("state_since = ?"); values.push(Date.now()); }
  if (!set.length) return mapSource(prior);
  const bed = ["project_id = ?", "seq = ?"];
  const bedValues = [String(projectId), Number(seq)];
  if (when?.state !== undefined) {
    const list = Array.isArray(when.state) ? when.state : [when.state];
    bed.push(`state IN (${list.map(() => "?").join(", ")})`);
    bedValues.push(...list.map(String));
  }
  if (when?.process !== undefined) { bed.push("process = ?"); bedValues.push(String(when.process)); }
  const r = db.prepare(`UPDATE project_setup_source SET ${set.join(", ")} WHERE ${bed.join(" AND ")}`).run(...values, ...bedValues);
  if (!r.changes) return null;
  return sourceOf(projectId, seq);
}

/** Everything of a setup falls (success) — only the setup and its sources; operations and archives have their own paths. */
function endSetup(projectId) {
  const pid = String(projectId);
  return inOneTransaction(() => {
    db.prepare("DELETE FROM project_setup_source WHERE project_id = ?").run(pid);
    return db.prepare("DELETE FROM project_setup WHERE project_id = ?").run(pid).changes;
  });
}

/** The delete path: all four tables of a project, plus its remote hints. Returns the archive ids whose files the
 *  caller removes. */
function deleteSetup(projectId) {
  const pid = String(projectId);
  return inOneTransaction(() => {
    const archive = db.prepare("SELECT archive_id FROM project_archive WHERE project_id = ?").all(pid).map((r) => r.archive_id);
    db.prepare("DELETE FROM project_setup_source WHERE project_id = ?").run(pid);
    db.prepare("DELETE FROM project_setup WHERE project_id = ?").run(pid);
    db.prepare("DELETE FROM project_archive WHERE project_id = ?").run(pid);
    db.prepare("DELETE FROM project_upload WHERE project_id = ?").run(pid);
    db.prepare("DELETE FROM app_settings WHERE key = ?").run(`${HINT_PREFIX}${pid}`);
    return archive;
  });
}

// ── Remote hints ───────────────────────────────────────────────────────────────────────────────────────────────────
// After the setup: per code repo the remotes whose address carries a credential — `[{ repo, remote }]`, NAMES only
// (the address and its value are stored nowhere). They survive the end of the setup (the list row shows them,
// projectbox/setup/status.js) and fall with the project (deleteSetup). One key in `app_settings` per project — no
// table of its own for a list that is written once and only displayed. Read only at the end of the setup: whoever
// cleans the remote afterwards keeps seeing the hint (open, see README).
const HINT_PREFIX = "project.remote_hints.";
function setRemoteHints(projectId, list) {
  const key = `${HINT_PREFIX}${String(projectId)}`;
  const clean = (Array.isArray(list) ? list : []).map((h) => ({ repo: String(h?.repo ?? ""), remote: String(h?.remote ?? "") })).filter((h) => h.remote);
  if (!clean.length) { db.prepare("DELETE FROM app_settings WHERE key = ?").run(key); return []; }
  db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(clean));
  return clean;
}
const remoteHintsOf = (projectId) => {
  const r = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(`${HINT_PREFIX}${String(projectId)}`);
  const list = jsonFrom(r?.value, []);
  return Array.isArray(list) ? list : [];
};
/** The projects with remote hints (the project list only asks for them). */
const remoteHintProjects = () => new Set(db.prepare("SELECT key FROM app_settings WHERE substr(key, 1, ?) = ?")
  .all(HINT_PREFIX.length, HINT_PREFIX).map((r) => r.key.slice(HINT_PREFIX.length)));

// ── Upload operations ──────────────────────────────────────────────────────────────────────────────────────────────

function mapUpload(r) {
  if (!r) return null;
  return {
    operation: r.operation, projectId: r.project_id, purpose: r.purpose, sourceSeq: r.source_seq ?? null, kind: r.kind, staging: r.staging,
    state: r.state, newFolders: jsonFrom(r.new_folder, []) || [], conflict: r.conflict ?? null, lastChunk: r.last_chunk,
    process: r.process, createdAt: r.created_at, error: r.error ?? "", code: r.code ?? "", finding: jsonFrom(r.finding),
    stateSince: r.state_since || r.created_at || 0,
  };
}

function createProjectUpload({ operation, projectId, purpose = "creation", sourceSeq = null, kind = "files", staging, newFolders = [] }) {
  if (!operation || !projectId || !staging) throw new TypeError("upload operation: operation, projectId and staging are mandatory");
  if (!UPLOAD_PURPOSES.includes(purpose)) throw new TypeError(`upload operation: unknown purpose "${purpose}"`);
  const t = Date.now();
  db.prepare(`INSERT INTO project_upload (operation, project_id, purpose, source_seq, kind, staging, new_folder, created_at, state_since)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(String(operation), String(projectId), purpose, sourceSeq === null ? null : Number(sourceSeq), kind, String(staging), JSON.stringify(newFolders), t, t);
  return projectUpload(operation);
}
const projectUpload = (operation) => mapUpload(db.prepare("SELECT * FROM project_upload WHERE operation = ?").get(String(operation)));
const projectUploadsOf = (projectId) => db.prepare("SELECT * FROM project_upload WHERE project_id = ? ORDER BY created_at").all(String(projectId)).map(mapUpload);
// `newFolders` and `finding` as JSON; `conflict` raw (text or NULL — "not asked").
const UPLOAD_COLUMNS = {
  state: "state", conflict: "conflict", lastChunk: "last_chunk", process: "process", newFolders: "new_folder", error: "error",
  code: "code", finding: "finding",
};
const uploadValue = (field, v) => {
  if (field === "newFolders") return JSON.stringify(Array.isArray(v) ? v : []);
  if (field === "finding") return v === null ? "" : JSON.stringify(v);
  if (field === "conflict") return v;
  return v === null ? "" : v;
};
/**
 * Change fields of an operation. `when` (optional): `{ state?, process? }` (`state` text or list) — the condition
 * sits in the UPDATE; not applied ⇒ `null`. Without `when`: the row afterwards (or null if there is none). A change
 * of `state` sets `state_since`.
 */
function changeProjectUpload(operation, fields = {}, { when = null } = {}) {
  const set = [];
  const values = [];
  for (const [field, column] of Object.entries(UPLOAD_COLUMNS)) {
    if (fields[field] === undefined) continue;
    if (field === "state" && !UPLOAD_STATES.includes(fields[field])) throw new TypeError(`upload operation: unknown state "${fields[field]}"`);
    set.push(`${column} = ?`);
    values.push(uploadValue(field, fields[field]));
  }
  if (!set.length) return projectUpload(operation);
  if (fields.state !== undefined) {
    set.push("state_since = CASE WHEN state = ? THEN state_since ELSE ? END");
    values.push(fields.state, Date.now());
  }
  const bed = ["operation = ?"];
  const bedValues = [String(operation)];
  if (when?.state !== undefined) {
    const list = Array.isArray(when.state) ? when.state : [when.state];
    bed.push(`state IN (${list.map(() => "?").join(", ")})`);
    bedValues.push(...list.map(String));
  }
  if (when?.process !== undefined) { bed.push("process = ?"); bedValues.push(String(when.process)); }
  const r = db.prepare(`UPDATE project_upload SET ${set.join(", ")} WHERE ${bed.join(" AND ")}`).run(...values, ...bedValues);
  if (when && !r.changes) return null;
  return projectUpload(operation);
}
const deleteProjectUpload = (operation) => db.prepare("DELETE FROM project_upload WHERE operation = ?").run(String(operation)).changes;

// ── Retroactive operations (upload into an existing project) ───────────────────────────────────────────────────────
// Every row with `purpose = 'retroactive'` is OPEN (a success deletes it) — in every state, also interrupted.

/** PURE (one query): the open retroactive operations of a project — the holder "upload" of the layout (an open
 *  retroactive operation holds, also when interrupted). */
const retroactiveOperations = (projectId) => db.prepare("SELECT * FROM project_upload WHERE project_id = ? AND purpose = 'retroactive' ORDER BY created_at")
  .all(String(projectId)).map(mapUpload);
/** The projects with open retroactive operations (the project list only asks for them). */
const retroactiveProjects = () => new Set(db.prepare("SELECT DISTINCT project_id FROM project_upload WHERE purpose = 'retroactive'")
  .all().map((r) => String(r.project_id)));
/** The retroactive operations placing or unpacking RIGHT NOW with this boot id — `[{ projectId, operation, kind,
 *  since }]` for the project work in runs/routes.js (they count as busy). A foreign boot id never holds. */
const retroactiveInWork = (bootId) => (bootId
  ? db.prepare("SELECT * FROM project_upload WHERE purpose = 'retroactive' AND state = 'place' AND process = ? ORDER BY created_at").all(String(bootId)).map(mapUpload)
  : []).map((v) => ({ projectId: v.projectId, operation: v.operation, kind: v.kind, since: v.stateSince }));

// ── Archives (per ZIP source ONE archive, the file is in the runtime folder — projectbox/setup/archive.js) ─────────
// `state`: upload (chunks arrive) · unpack (complete, reported as finished; stays so across an abort, a restart or
// lack of space — "try again" unpacks anew) · error (the archive itself is no good: rejected, PLAN_MATCHES_NOT or
// an entry that could not be unpacked — bomb, damaged, duplicate in the archive or folder against file; unpacking
// anew would fail again. "Try again" leads the source back to `wait-upload`, a new archive can be uploaded).

const ARCHIVE_STATES = Object.freeze(["upload", "unpack", "error"]);
const mapArchive = (r) => (r ? { archiveId: r.archive_id, projectId: r.project_id, operation: r.operation, purpose: r.purpose, state: r.state, size: r.size, target: r.target, mode: r.mode, process: r.process, createdAt: r.created_at } : null);
const projectArchiveOf = (projectId) => db.prepare("SELECT * FROM project_archive WHERE project_id = ? ORDER BY created_at").all(String(projectId)).map(mapArchive);
const projectArchive = (archiveId) => mapArchive(db.prepare("SELECT * FROM project_archive WHERE archive_id = ?").get(String(archiveId)));
/** All archive rows (the restart-grace hook "project-archive"). */
const projectArchiveAll = () => db.prepare("SELECT * FROM project_archive ORDER BY created_at").all().map(mapArchive);

// `size`: for a retroactive archive the size of the whole archive announced when the upload begins (the creation
// sets it only when finished, its announcement is on the source); `target` there is the folder name from the file
// name (without a parent folder).
function createProjectArchive({ archiveId, projectId, operation = "", purpose = "creation", target = "", size = 0 }) {
  if (!archiveId || !projectId) throw new TypeError("archive: archiveId and projectId are mandatory");
  if (!UPLOAD_PURPOSES.includes(purpose)) throw new TypeError(`archive: unknown purpose "${purpose}"`);
  db.prepare(`INSERT INTO project_archive (archive_id, project_id, operation, purpose, state, target, size, created_at) VALUES (?, ?, ?, ?, 'upload', ?, ?, ?)`)
    .run(String(archiveId), String(projectId), String(operation || ""), purpose, String(target || ""), Number.isSafeInteger(size) && size > 0 ? size : 0, Date.now());
  return projectArchive(archiveId);
}
/** The archive of an operation (retroactive: at most one per operation), otherwise null. */
const projectArchiveOfOperation = (operation) => mapArchive(db.prepare("SELECT * FROM project_archive WHERE operation = ? AND operation != '' ORDER BY created_at LIMIT 1").get(String(operation || "")));

const ARCHIVE_COLUMNS = { state: "state", size: "size", mode: "mode", process: "process" };
/** Change fields of an archive; `when: { state }` (text or list) sits in the UPDATE — not applied ⇒ null. */
function changeProjectArchive(archiveId, fields = {}, { when = null } = {}) {
  const set = [];
  const values = [];
  for (const [field, column] of Object.entries(ARCHIVE_COLUMNS)) {
    if (fields[field] === undefined) continue;
    if (field === "state" && !ARCHIVE_STATES.includes(fields[field])) throw new TypeError(`archive: unknown state "${fields[field]}"`);
    set.push(`${column} = ?`);
    values.push(fields[field] === null ? "" : fields[field]);
  }
  if (!set.length) return projectArchive(archiveId);
  const bed = ["archive_id = ?"];
  const bedValues = [String(archiveId)];
  if (when?.state !== undefined) {
    const list = Array.isArray(when.state) ? when.state : [when.state];
    bed.push(`state IN (${list.map(() => "?").join(", ")})`);
    bedValues.push(...list.map(String));
  }
  const r = db.prepare(`UPDATE project_archive SET ${set.join(", ")} WHERE ${bed.join(" AND ")}`).run(...values, ...bedValues);
  return r.changes ? projectArchive(archiveId) : null;
}
const deleteProjectArchive = (archiveId) => db.prepare("DELETE FROM project_archive WHERE archive_id = ?").run(String(archiveId)).changes;

// ── The view and the numbers ───────────────────────────────────────────────────────────────────────────────────────

const foreign = (process, bootId) => Boolean(process) && process !== bootId;

/** Is a server step running for this row RIGHT NOW with THIS boot id (setup or one of its sources)? */
function setupServerStepRunning(e, bootId) {
  if (!e || !bootId) return false;
  if (SETUP_SERVER_STEPS.includes(e.step) && e.state === "setUp" && e.process === bootId) return true;
  return e.sources.some((q) => SOURCE_SERVER_STATES.includes(q.state) && q.process === bootId);
}

/** Is the row interrupted by a foreign process? */
function setupInterrupted(e, bootId) {
  if (!e) return false;
  if (SETUP_SERVER_STEPS.includes(e.step) && e.state === "setUp" && foreign(e.process, bootId)) return true;
  return e.sources.some((q) => SOURCE_SERVER_STATES.includes(q.state) && foreign(q.process, bootId));
}

/**
 * The field `setup` to the outside — `{ state, step, phase?, error?, code?, waiting?, conflict?, sources }`.
 * `instance`: the main row (for `phase` and `waiting: "container"`); `bootId`: that of this process. `lastChunk`
 * per source from its upload operation (`project_upload`). Per source with `kind: "zip"` also `name` (the file name
 * of the archive) and `bytes` (the size last announced).
 */
function setupView(e, { bootId = "", instance = null } = {}) {
  if (!e) return null;
  const sources = e.sources.map((q) => {
    const interrupted = SOURCE_SERVER_STATES.includes(q.state) && foreign(q.process, bootId);
    return {
      seq: q.seq, kind: q.kind, target: q.target, state: interrupted ? "error" : q.state,
      ...(interrupted ? { code: "INTERRUPTED" } : q.code ? { code: q.code } : {}),
      ...(q.error && !interrupted ? { error: q.error } : {}),
      ...(q.host ? { host: q.host } : {}),
      // Archive identity: name and last announced size of the archive of a ZIP source — the clients compare both before
      // resuming (otherwise 409 ARCHIVE_DIFFERENT).
      ...(q.kind === "zip" ? { name: q.name, bytes: q.bytes } : {}),
      // The address of a clone (without user part — the check rejects one) and its branch, for the row and "create
      // credential" (`host` above, for SUBMODULE_ACCESS the host of the submodule). Never the value of a credential.
      // `fetched: true` once the clone itself is in the staging (`clone_fetched`) — only then can it be taken as is
      // (projectbox/setup/routes.js, 409 otherwise); the clients show the button after that.
      ...(q.kind === "clone" ? { url: q.cloneUrl, ...(q.cloneBranch ? { branch: q.cloneBranch } : {}), ...(q.cloneFetched ? { fetched: true } : {}) } : {}),
      // "Resume upload": the START of the last chunk request of this source's operation (the row shows by it whether an
      // upload is interrupted).
      ...(q.operation ? (() => { const v = projectUpload(q.operation); return v?.lastChunk ? { lastChunk: v.lastChunk } : {}; })() : {}),
    };
  });
  const out = { state: e.state, step: e.step, sources };
  const interrupted = SETUP_SERVER_STEPS.includes(e.step) && e.state === "setUp" && foreign(e.process, bootId);
  if (interrupted) { out.state = "error"; out.code = "INTERRUPTED"; }
  else {
    if (e.code) out.code = e.code;
    if (e.error) out.error = e.error;
  }
  if (instance?.state === "create" && instance.phase) out.phase = instance.phase;
  if (!interrupted && e.state === "setUp") {
    if (e.waiting) out.waiting = e.waiting;
    else if (e.step === "container") out.waiting = "container";
  }
  if (e.waiting === "conflict" && e.conflict) out.conflict = { existing: e.conflict.existing || 0, examples: e.conflict.examples || [] };
  return out;
}

/** The numbers without ids for /api/runs/active: open (without error), failed (error or INTERRUPTED). */
function setupCounts(bootId) {
  let open = 0;
  let error = 0;
  for (const e of setups()) {
    if (e.state === "error" || setupInterrupted(e, bootId) || e.sources.some((q) => q.state === "error" || q.state === "aborted")) error += 1;
    else open += 1;
  }
  return { open, error };
}

/** The setups whose server step is running RIGHT NOW with this boot id — `[{ projectId, phase, since }]` for the project work. */
function setupsInWork(bootId) {
  const out = [];
  for (const e of setups()) {
    if (!setupServerStepRunning(e, bootId)) continue;
    const q = e.sources.find((x) => SOURCE_SERVER_STATES.includes(x.state) && x.process === bootId);
    out.push({ projectId: e.projectId, phase: q && !(SETUP_SERVER_STEPS.includes(e.step) && e.process === bootId) ? q.state : e.step, since: e.stateSince });
  }
  return out;
}

/** The setups waiting for storage (storage queue). */
const setupsWaitForStorage = () => setups().filter((e) => e.waiting === "storage" && e.state === "setUp");

export {
  ARCHIVE_STATES, SETUP_STEPS, SETUP_SERVER_STEPS, SOURCE_KINDS, SOURCE_SERVER_STATES, SOURCE_STATES, UPLOAD_STATES,
  UPLOAD_PURPOSES,
  changeSetup, createSetup, endSetup, setups, setupsInWork, setupsWaitForStorage,
  deleteSetup, setupServerStepRunning, setupView, setupInterrupted, setupOf, setupCounts,
  initProjectSetupSchema, retroactiveInWork, retroactiveProjects, retroactiveOperations, projectArchive,
  changeProjectArchive, createProjectArchive, projectArchiveAll, projectArchiveOf, deleteProjectArchive, projectArchiveOfOperation,
  projectUpload, changeProjectUpload, createProjectUpload, deleteProjectUpload, projectUploadsOf, changeSource,
  sourceOf, remoteHintProjects, setRemoteHints, remoteHintsOf,
};
