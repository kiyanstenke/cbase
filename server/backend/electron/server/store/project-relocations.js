// The journal of a relocation. The mechanism (write before the effect, decider, resume) is the leaf
// projectbox/journal.js; here is only the storage.
//
// One row per relocation, key `id` (sequential). At most ONE open relocation per project (partial UNIQUE index over
// `ended_at IS NULL`); at most one per user container is enforced by the heavy-load lock (projectbox/heavyLoad.js),
// not by the table — an open journal of a crashed relocation must not block the relocation of ANOTHER project
// forever.
//
// The state of the journal: `direction` (forward | backward), `step` (announced, written BEFORE its effect), `done`
// (confirmed). Every change of one of the three appends a row to `log` ({ direction, step, what, at }) — from it the
// report computes the duration per step. `end`: '' (open), `finished`, `back` (the return path is through),
// `aborted`; open means `ended_at IS NULL`.
//
// The SECTIONS (one JSON column each, each is replaced as a WHOLE when written):
//   plan         the plan from step 1 (hold reasons, hints, space needed — without values)
//   container    the complete container list from step 4
//   policies     the old restart policies (step 4, before `update --restart=no`)
//   insideIds    the ids created inside (images, volumes, networks, containers); plus `volumeFound` (step 3: was the
//                volume of the project container already there before the creation — then the return path does not
//                remove it)
//   dismantling  the dismantling keys from step 9: `[{ file, key: [NAME, …] }]` — ONLY names. A value from an `.env*`
//                file NEVER gets into the database; the original lies byte-exact (0600) in the relocation location.
//                The shape is enforced here: an entry with `=`, with a value field or with a non-name THROWS.
//   override     the location of the override file that was set aside
//   copies       the locations of the copies from step 13 (chat files, project files, `~/.local`, sessions; per entry
//                possibly `aside` — a pre-existing version in the relocation location —, for a browser profile
//                `beforeCopy` { copiedAt, fingerprint })
//   services     per service that step 9 touches: the old `project_services.start_command` and `.port` and the row
//                in `service_start_commands` (null = "no row")
//   worktrees    per worktree from step 13: repo, old and new path, the old `graph_starts.worktree_path`/
//                `worktree_info` and `cwd`/`worktree` in the image of the subagents
//   report       the report (without values)
//   projectRepo  step 11: `{ path, state: "running" | "created" | "not", commit?, reason? }` — "running" is written
//                BEFORE `git init`, so that the return path recognizes a half-created repo by its marker and only
//                removes one created in THIS relocation (projectbox/relocation/data.js)
// An unknown section THROWS — what is not named, the return path would not find.
//
// No foreign key on `projects` (pattern store/project-instances.js). Reached via the facade `store.js` (`export *`,
// the registration "project-relocations" is there); the names here are a wrapper (`export { … };`).
import { db } from "./db.js";

const RELOCATION_ENDS = Object.freeze(["finished", "back", "aborted"]);
const RELOCATION_DIRECTIONS = Object.freeze(["forward", "backward"]);
const RELOCATION_SECTIONS = Object.freeze({
  plan: "plan", container: "container", policies: "policies", insideIds: "inside_ids", dismantling: "dismantling",
  override: "override_location", copies: "copies", services: "services", worktrees: "worktrees", report: "report",
  projectRepo: "project_repo",
});

function initProjectRelocationSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_relocations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      instance TEXT NOT NULL DEFAULT 'main',
      location TEXT NOT NULL,
      direction TEXT NOT NULL DEFAULT 'forward',
      step TEXT NOT NULL DEFAULT '',
      done TEXT NOT NULL DEFAULT '',
      end TEXT NOT NULL DEFAULT '',
      error TEXT NOT NULL DEFAULT '',
      log TEXT NOT NULL DEFAULT '[]',
      plan TEXT NOT NULL DEFAULT '',
      container TEXT NOT NULL DEFAULT '',
      policies TEXT NOT NULL DEFAULT '',
      inside_ids TEXT NOT NULL DEFAULT '',
      dismantling TEXT NOT NULL DEFAULT '',
      override_location TEXT NOT NULL DEFAULT '',
      copies TEXT NOT NULL DEFAULT '',
      services TEXT NOT NULL DEFAULT '',
      worktrees TEXT NOT NULL DEFAULT '',
      report TEXT NOT NULL DEFAULT '',
      project_repo TEXT NOT NULL DEFAULT '',
      started_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      ended_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_project_relocations_open ON project_relocations(project_id) WHERE ended_at IS NULL;
  `);
  // The section `projectRepo` came after the first version of the table — a database that already carries it gets
  // the column added.
  if (!db.prepare("PRAGMA table_info(project_relocations)").all().some((c) => c.name === "project_repo")) {
    db.exec("ALTER TABLE project_relocations ADD COLUMN project_repo TEXT NOT NULL DEFAULT ''");
  }
}

const jsonFrom = (text) => {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
};

function mapRelocation(r) {
  if (!r) return null;
  const m = {
    id: r.id, projectId: r.project_id, instance: r.instance, identifier: `${r.project_id}/${r.instance}`, location: r.location,
    direction: r.direction, step: r.step, done: r.done, end: r.end, error: r.error,
    log: jsonFrom(r.log) || [], startedAt: r.started_at, updatedAt: r.updated_at, endedAt: r.ended_at ?? null,
  };
  for (const [field, column] of Object.entries(RELOCATION_SECTIONS)) m[field] = jsonFrom(r[column]);
  return m;
}

// The shape of the dismantling keys: only names. An `.env` key is a shell name; everything else (an `=`, a space,
// an object with a value) is either a value or a mistake — neither belongs in the database.
const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
function checkDismantling(rb) {
  if (rb === null) return;
  if (!Array.isArray(rb)) throw new TypeError("relocation journal: dismantling must be a list");
  for (const e of rb) {
    const fields = e && typeof e === "object" ? Object.keys(e).sort().join(",") : "";
    if (fields !== "file,key") throw new TypeError(`relocation journal: dismantling entry only with { file, key } — never values (${fields || typeof e})`);
    if (typeof e.file !== "string" || !e.file || e.file.startsWith("/") || e.file.split("/").includes("..")) {
      throw new TypeError(`relocation journal: dismantling file "${e.file}" is not a path inside the project`);
    }
    if (!Array.isArray(e.key) || e.key.some((k) => typeof k !== "string" || !KEY.test(k))) {
      throw new TypeError(`relocation journal: dismantling keys of ${e.file} — only names, never values from .env*`);
    }
  }
}

function createRelocation({ projectId, instance = "main", location }) {
  if (!projectId || typeof location !== "string" || !location) throw new TypeError("relocation journal: projectId and location are mandatory");
  const t = Date.now();
  const r = db.prepare(`INSERT INTO project_relocations (project_id, instance, location, started_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
    .run(String(projectId), String(instance), location, t, t);
  return readRelocation(Number(r.lastInsertRowid));
}

const readRelocation = (id) => mapRelocation(db.prepare("SELECT * FROM project_relocations WHERE id = ?").get(Number(id)));

const openRelocation = (projectId) =>
  mapRelocation(db.prepare("SELECT * FROM project_relocations WHERE project_id = ? AND ended_at IS NULL").get(String(projectId)));

const openRelocations = () =>
  db.prepare("SELECT * FROM project_relocations WHERE ended_at IS NULL ORDER BY started_at, id").all().map(mapRelocation);

const relocationsOf = (projectId) =>
  db.prepare("SELECT * FROM project_relocations WHERE project_id = ? ORDER BY started_at, id").all(String(projectId)).map(mapRelocation);

/**
 * Write state and sections: `{ direction, step, done, data: { <section>: value }, error }` — every field optional.
 * Throws on an unknown section, on dismantling values, on an ended or missing row. Returns the row afterwards.
 */
function writeRelocation(id, { direction, step, done, data, error } = {}) {
  const prior = readRelocation(id);
  if (!prior) throw new Error(`relocation journal ${id}: no row`);
  if (prior.endedAt !== null) throw new Error(`relocation journal ${id}: already ended (${prior.end})`);
  if (direction !== undefined && !RELOCATION_DIRECTIONS.includes(direction)) throw new TypeError(`relocation journal: unknown direction "${direction}"`);
  const set = [];
  const values = [];
  for (const [field, value] of Object.entries(data || {})) {
    const column = RELOCATION_SECTIONS[field];
    if (!column) throw new TypeError(`relocation journal: unknown section "${field}" (known: ${Object.keys(RELOCATION_SECTIONS).join(", ")})`);
    if (field === "dismantling") checkDismantling(value ?? null);
    set.push(`${column} = ?`);
    values.push(value === null || value === undefined ? "" : JSON.stringify(value));
  }
  const fresh = { direction: direction ?? prior.direction, step: step ?? prior.step, done: done ?? prior.done };
  const t = Date.now();
  const log = prior.log;
  if (fresh.direction !== prior.direction || fresh.step !== prior.step) log.push({ direction: fresh.direction, step: fresh.step, what: "announced", at: t });
  if (fresh.done && fresh.done !== prior.done) log.push({ direction: fresh.direction, step: fresh.done, what: "done", at: t });
  set.push("direction = ?", "step = ?", "done = ?", "log = ?", "updated_at = ?");
  values.push(fresh.direction, fresh.step, fresh.done, JSON.stringify(log), t);
  if (error !== undefined) { set.push("error = ?"); values.push(String(error)); }
  db.prepare(`UPDATE project_relocations SET ${set.join(", ")} WHERE id = ? AND ended_at IS NULL`).run(...values, Number(id));
  return readRelocation(id);
}

/** End: `finished`, `back` or `aborted`. After that the row is read-only. */
function endRelocation(id, end, { error } = {}) {
  if (!RELOCATION_ENDS.includes(end)) throw new TypeError(`relocation journal: unknown end "${end}"`);
  const t = Date.now();
  const r = db.prepare(`UPDATE project_relocations SET end = ?, ended_at = ?, updated_at = ?${error !== undefined ? ", error = ?" : ""} WHERE id = ? AND ended_at IS NULL`)
    .run(...[end, t, t, ...(error !== undefined ? [String(error)] : []), Number(id)]);
  if (!r.changes) throw new Error(`relocation journal ${id}: no open row`);
  return readRelocation(id);
}

/** Delete (the return path; the delete paths of a project). Returns the number of rows. */
const deleteRelocation = (id) => db.prepare("DELETE FROM project_relocations WHERE id = ?").run(Number(id)).changes;

export {
  RELOCATION_SECTIONS, RELOCATION_ENDS, RELOCATION_DIRECTIONS, initProjectRelocationSchema, openRelocation, openRelocations, createRelocation, endRelocation,
  readRelocation, deleteRelocation, writeRelocation, relocationsOf,
};
