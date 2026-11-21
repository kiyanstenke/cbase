// The copies of the stacks. Request, queue, state and journal of a copy; the runtime (container, network, IP) is —
// as for the main instance — in `project_instances` under the instance `copy-<name>`.
//
// THE ROW IS THE SWITCH: without a live row here nothing changes for a relocated project. Live means
// `state != 'removed'`. ONE partial UNIQUE index over the live rows: ONE name per project. No foreign key on
// `projects` or `chats` (pattern store/project-instances.js).
//
// A COPY BELONGS TO NO CHAT: `chat_id` is optional and means "created by" — the chat that created it (via the tool),
// otherwise NULL (a human). A chat can create any number, and which chat works in which copy is in `chats.instance`
// (store/chats.js), not here. In the code the name `chatId` stays (a second name for the same field would be a
// double truth) — the routes additionally answer with `createdOf: { chatId, title } | null` (stacks/routes.js).
//   base_instance  the instance the copy is created from (default `main`; also `copy-<name>` of a ready copy — the
//                  template).
//   inset          1: the creating chat moves in at `ready` and is woken (the tool, and legacy rows via the migration
//                  `migration.copies_free`); 0: nobody moves in, no wake call (a human created it).
// SQLite does not relax NOT NULL: a store whose `chat_id` still carries NOT NULL is rebuilt ONCE at start (new
// table, all rows with their id, name index anew, in one transaction — `rebuildWithoutChatRequired`).
//
// States (STACK_COPY_STATES) and their phases (STACK_COPY_PHASES; a state without a list has no phase):
//   waiting_queue · waiting_storage   requested, not yet begun — do not hold `busy`
//   build      clone1 · freeze · clone2 · creation · prepare · start
//   ready                             the copy runs
//   clearAway  earmarked · fetch · save · projectRepo · layer · remove
//   error                             with a reason (`error`)
//   removed                           with a report (`result`) — no longer live
// The coupling to the instance row and the stream event for a copy are NOT here (store/ is domain-free) but in the
// setter stacks/state.js — whoever changes the state goes through it.
//
// JSON columns: `base` (what the copy starts from), `result` (report — never a value) and `journal`
// (`{ direction, step, done, log, data }` — the mechanism is the leaf projectbox/journal.js, here only the storage;
// `data` has named sections, each is replaced as a WHOLE when written, an unknown one THROWS as in the relocation —
// what is not named, the return path would not find; see STACK_COPY_JOURNAL_SECTIONS). Broken or empty yields null.
// THE SEPARATOR `fresh_start` in the log: the journal is never reset, and two paths put a copy from the build back
// into the queue (after a restart, stacks/queue.js; at server end, stacks/build.js backAfterServerEnd) — both only
// note. The new attempt begins with the step "freeze", and if the state already carried "freeze",
// `writeStackCopyJournal` appends NO row (same step, same direction): without a separator the old rows would belong
// to the new attempt. Hence `changeStackCopy` appends `{ step: "", what: "fresh_start", at }` in the SAME UPDATE when
// entering `build` from a waiting state — the beginning of EVERY attempt — if the log already carries rows (a first
// attempt stays byte-equal). Without a direction: not a step of any direction. The readers of the log ask for their
// step (stacks/inset.js `readyInLog`; stacks/clearAway.js `backedUpAt`) — the separator matches none; the state
// (`direction`/`step`/`done`, stackCopyJournalStatus and projectbox/journal.js) stays untouched. It is read by
// projectbox/copy-progress.js (the last attempt). If the entry fails at the instance row (stacks/state.js takes the
// copy back), the separator stays — a following entry writes a new one, and the last one counts.
//
// Reached via the facade `store.js` (`export *`, the registration "stack-copies" is there); the names here are a
// wrapper (`export { … };`).
import { db, inOneTransaction } from "./db.js";

const STACK_COPY_STATES = Object.freeze(["waiting_queue", "waiting_storage", "build", "ready", "clearAway", "error", "removed"]);
const STACK_COPY_PHASES = Object.freeze({
  build: Object.freeze(["clone1", "freeze", "clone2", "creation", "prepare", "start"]),
  clearAway: Object.freeze(["earmarked", "fetch", "save", "projectRepo", "layer", "remove"]),
});
const STACK_COPY_WAITING = Object.freeze(["waiting_queue", "waiting_storage"]);
// Journal sections: `freeze` (stacks/freeze.js); stacks/build.js — `creation` (overlays.tsv, containers), `prepare`
// (per repo), `start` (desired state, policy, services), `dismantling` (what the dismantling removed and what
// stayed); `fetch` (the fixed number per new repo), `clearAway` (state, report and backups of the clearing,
// stacks/clearAway.js); `trigger` — the job to remove (stacks/remove.js: reason, who), written BEFORE any effect;
// the queue never starts a row with a job, and the restart picks it up again; `inset` — the marker of the wake call
// `ready`/`error` (stacks/inset.js), so that a restart does not wake once more and a lost wake call is caught up
// after the restart.
const STACK_COPY_JOURNAL_SECTIONS = Object.freeze(["plan", "report", "freeze", "code", "creation", "prepare", "start", "dismantling", "fetch", "clearAway", "trigger", "inset"]);
const JOURNAL_DIRECTIONS = Object.freeze(["forward", "backward"]);
/** The row of the separator in the log (head, "THE SEPARATOR"): `what` of a row without direction, appended when entering the build. */
const STACK_COPY_FRESH_START = "fresh_start";

// The columns of the table — ONCE, for the creation and the rebuild.
const COLUMNS = `
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      chat_id TEXT,
      base TEXT NOT NULL DEFAULT '',
      base_instance TEXT NOT NULL DEFAULT 'main',
      inset INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL,
      phase TEXT NOT NULL DEFAULT '',
      reason TEXT NOT NULL DEFAULT '',
      requested_at INTEGER NOT NULL,
      journal TEXT NOT NULL DEFAULT '',
      result TEXT NOT NULL DEFAULT '',
      error TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL`;
const COLUMNS_NAMES = ["id", "project_id", "name", "chat_id", "base", "base_instance", "inset", "state", "phase", "reason", "requested_at",
  "journal", "result", "error", "created_at", "updated_at"];

function initStackCopiesSchema() {
  db.exec(`CREATE TABLE IF NOT EXISTS stack_copies (${COLUMNS}\n    );`);
  const columns = () => db.prepare("PRAGMA table_info(stack_copies)").all();
  const has = (n) => columns().some((c) => c.name === n);
  if (!has("base_instance")) db.exec("ALTER TABLE stack_copies ADD COLUMN base_instance TEXT NOT NULL DEFAULT 'main'");
  if (!has("inset")) db.exec("ALTER TABLE stack_copies ADD COLUMN inset INTEGER NOT NULL DEFAULT 0");
  if (columns().find((c) => c.name === "chat_id")?.notnull) rebuildWithoutChatRequired();
  db.exec(`
    DROP INDEX IF EXISTS idx_stack_copies_chat;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_stack_copies_name ON stack_copies(project_id, name) WHERE state != 'removed';
  `);
}

// `chat_id` NOT NULL → nullable. SQLite can only do that via a new table: all rows with their id across
// (AUTOINCREMENT keeps counting in sqlite_sequence, an insert with an id raises the counter too), the old one gone,
// the new one under the old name; the name index is created anew afterwards (initStackCopiesSchema), the chat index
// no more. In ONE transaction: if something throws, the old one stays.
function rebuildWithoutChatRequired() {
  const list = COLUMNS_NAMES.join(", ");
  inOneTransaction(() => db.exec(`
    CREATE TABLE stack_copies_rebuild (${COLUMNS}
    );
    INSERT INTO stack_copies_rebuild (${list}) SELECT ${list} FROM stack_copies;
    DROP TABLE stack_copies;
    ALTER TABLE stack_copies_rebuild RENAME TO stack_copies;
  `));
}

const jsonFrom = (text) => {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
};
const jsonText = (value) => (value === null || value === undefined ? "" : JSON.stringify(value));

function mapStackCopy(r) {
  if (!r) return null;
  return {
    id: r.id, projectId: r.project_id, name: r.name,
    chatId: r.chat_id ?? null, baseInstance: r.base_instance || "main", inset: Boolean(r.inset), base: jsonFrom(r.base), state: r.state, phase: r.phase, reason: r.reason, requestedAt: r.requested_at,
    journal: jsonFrom(r.journal), result: jsonFrom(r.result), error: r.error, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

/** Throws if `phase` does not fit `state` (a state without phases carries none). */
function checkState(state, phase = "") {
  if (!STACK_COPY_STATES.includes(state)) throw new TypeError(`copy: unknown state "${state}"`);
  const phases = STACK_COPY_PHASES[state];
  if (!phases) { if (phase) throw new TypeError(`copy: the state "${state}" has no phase ("${phase}")`); return; }
  if (!phases.includes(phase)) throw new TypeError(`copy: "${phase}" is not a phase of "${state}" (${phases.join(", ")})`);
}

/**
 * Create a request (default `waiting_queue`). Throws without project or name, for `inset` without a chat (who is to
 * move in?) and — via the partial index — for a live name of the same project (SQLITE_CONSTRAINT). `chatId` is
 * optional (a human creates without a chat). The SHAPE of the name is checked by stacks/ (store/ is domain-free).
 */
function createStackCopy({ projectId, name, chatId = null, inset = false, baseInstance = "main", base = null, state = "waiting_queue", phase = "", reason = "" }) {
  if (!projectId || !name) throw new TypeError("copy: projectId and name are mandatory");
  if (inset && !chatId) throw new TypeError("copy: inset requires the chat that moves in (chatId)");
  checkState(state, phase);
  const t = Date.now();
  const r = db.prepare(`INSERT INTO stack_copies (project_id, name, chat_id, inset, base_instance, base, state, phase, reason, requested_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(String(projectId), String(name), chatId ? String(chatId) : null, inset ? 1 : 0,
    String(baseInstance || "main"), jsonText(base), state, phase, String(reason || ""), t, t, t);
  return stackCopy(Number(r.lastInsertRowid));
}

const stackCopy = (id) => mapStackCopy(db.prepare("SELECT * FROM stack_copies WHERE id = ?").get(Number(id)));

/** The live copies a chat has created (any number), in order of request. */
const liveStackCopiesOfChat = (chatId) =>
  db.prepare("SELECT * FROM stack_copies WHERE chat_id = ? AND state != 'removed' ORDER BY requested_at, id").all(String(chatId ?? "")).map(mapStackCopy);

/** Set `inset` of a row — only the migration of the legacy rows (`migration.copies_free`) calls this. */
function setStackCopyMoveIn(id, inset) {
  db.prepare("UPDATE stack_copies SET inset = ? WHERE id = ?").run(inset ? 1 : 0, Number(id));
  return stackCopy(id);
}

/** The live copy of a project under this name, otherwise null. */
const liveStackCopy = (projectId, name) =>
  mapStackCopy(db.prepare("SELECT * FROM stack_copies WHERE project_id = ? AND name = ? AND state != 'removed'").get(String(projectId), String(name)));

/** The live copies — of one project or (without argument) of all — in order of request. */
function liveStackCopies(projectId) {
  const rows = projectId === undefined || projectId === null
    ? db.prepare("SELECT * FROM stack_copies WHERE state != 'removed' ORDER BY requested_at, id").all()
    : db.prepare("SELECT * FROM stack_copies WHERE project_id = ? AND state != 'removed' ORDER BY requested_at, id").all(String(projectId));
  return rows.map(mapStackCopy);
}

/** All rows of a project, removed ones too (history), in order of request. */
const stackCopiesOf = (projectId) =>
  db.prepare("SELECT * FROM stack_copies WHERE project_id = ? ORDER BY requested_at, id").all(String(projectId)).map(mapStackCopy);

/**
 * The copies of a project that have COMPLETED their build — their log carries `ready` as done; removed ones too
 * (their journal is history) —, without the row `withoutId`; those with the base `baseInstance` first, within that
 * the newest; at most `limit` (1–50). Read by the estimate of a copy being built (projectbox/copy-progress.js):
 * `GET /api/active-runs` asks every few seconds per tab, so the WHOLE history of the project with every journal
 * must not be pulled into JS on each call. A log that is not valid JSON carries nothing.
 */
function stackCopiesFinishedBuilt(projectId, { withoutId = null, baseInstance = "main", limit = 5 } = {}) {
  const n = Math.max(1, Math.min(50, Math.floor(Number(limit)) || 5));
  return db.prepare(`SELECT * FROM stack_copies
    WHERE project_id = ? AND id != ?
      AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(journal) THEN journal ELSE '{}' END, '$.log') AS p
        WHERE json_extract(CASE WHEN p.type = 'object' THEN p.value END, '$.step') = 'ready'
          AND json_extract(CASE WHEN p.type = 'object' THEN p.value END, '$.what') = 'done')
    ORDER BY (base_instance = ?) DESC, requested_at DESC, id DESC
    LIMIT ?`).all(String(projectId), withoutId === null || withoutId === undefined ? -1 : Number(withoutId), String(baseInstance || "main"), n).map(mapStackCopy);
}

/** The copies in one of the states, in order of request (the queue). */
function stackCopiesInState(states) {
  const list = [...states];
  if (!list.length) return [];
  for (const z of list) if (!STACK_COPY_STATES.includes(z)) throw new TypeError(`copy: unknown state "${z}"`);
  return db.prepare(`SELECT * FROM stack_copies WHERE state IN (${list.map(() => "?").join(", ")}) ORDER BY requested_at, id`).all(...list).map(mapStackCopy);
}

/**
 * Change fields: `{ state, phase, reason, error, base, result }` — each optional; `state`/`phase` are checked
 * together (the phase belongs to the state afterwards). Returns `{ prior, after }`. Throws for a missing row, for a
 * removed one (it is history) and for an unknown field. Entering `build` from a waiting state appends the separator
 * `fresh_start` to a log that already has rows (head, "THE SEPARATOR").
 */
function changeStackCopy(id, fields = {}) {
  const prior = stackCopy(id);
  if (!prior) throw new Error(`copy ${id}: no row`);
  if (prior.state === "removed") throw new Error(`copy ${prior.id} (${prior.projectId}, ${prior.name}): already removed`);
  const known = ["state", "phase", "reason", "error", "base", "result"];
  const unknown = Object.keys(fields).filter((k) => !known.includes(k));
  if (unknown.length) throw new TypeError(`copy: unknown field ${unknown.join(", ")}`);
  const state = fields.state ?? prior.state;
  const phase = fields.phase !== undefined ? String(fields.phase) : (fields.state !== undefined && fields.state !== prior.state ? "" : prior.phase);
  checkState(state, phase);
  const t = Date.now();
  const set = ["state = ?", "phase = ?", "updated_at = ?"];
  const values = [state, phase, t];
  if (fields.reason !== undefined) { set.push("reason = ?"); values.push(String(fields.reason)); }
  if (fields.error !== undefined) { set.push("error = ?"); values.push(String(fields.error)); }
  if (fields.base !== undefined) { set.push("base = ?"); values.push(jsonText(fields.base)); }
  if (fields.result !== undefined) { set.push("result = ?"); values.push(jsonText(fields.result)); }
  // The separator (head): a new attempt, and the log already carries rows of an earlier one.
  const j = prior.journal;
  if (state === "build" && STACK_COPY_WAITING.includes(prior.state) && j && typeof j === "object" && Array.isArray(j.log) && j.log.length) {
    set.push("journal = ?");
    values.push(JSON.stringify({ ...j, log: [...j.log, { step: "", what: STACK_COPY_FRESH_START, at: t }] }));
  }
  db.prepare(`UPDATE stack_copies SET ${set.join(", ")} WHERE id = ? AND state != 'removed'`).run(...values, Number(id));
  return { prior, after: stackCopy(id) };
}

/** The state of the journal for projectbox/journal.js (`{ direction, step, done }`), or null if nothing is announced. */
function stackCopyJournalStatus(id) {
  const j = stackCopy(id)?.journal;
  if (!j || !j.step) return null;
  return { direction: j.direction, step: j.step, done: j.done || "" };
}

/**
 * Write the journal: `{ direction, step, done, data }`, each optional; every change of step or direction and
 * everything newly done appends a row to `log` (pattern store/project-relocations.js). Throws for a missing or
 * removed row, an unknown direction and an unknown section.
 */
function writeStackCopyJournal(id, { direction, step, done, data } = {}) {
  const k = stackCopy(id);
  if (!k) throw new Error(`copy ${id}: no row`);
  if (k.state === "removed") throw new Error(`copy ${k.id} (${k.projectId}, ${k.name}): already removed — the journal is history`);
  if (direction !== undefined && !JOURNAL_DIRECTIONS.includes(direction)) throw new TypeError(`copy journal: unknown direction "${direction}"`);
  const old = k.journal && typeof k.journal === "object" ? k.journal : {};
  const fresh = {
    direction: direction ?? old.direction ?? "forward",
    step: step ?? old.step ?? "",
    done: done ?? old.done ?? "",
    log: Array.isArray(old.log) ? [...old.log] : [],
    data: old.data && typeof old.data === "object" ? { ...old.data } : {},
  };
  for (const [section, value] of Object.entries(data || {})) {
    if (!STACK_COPY_JOURNAL_SECTIONS.includes(section)) throw new TypeError(`copy journal: unknown section "${section}" (known: ${STACK_COPY_JOURNAL_SECTIONS.join(", ")})`);
    if (value === null || value === undefined) delete fresh.data[section]; else fresh.data[section] = value;
  }
  const t = Date.now();
  if (fresh.direction !== (old.direction ?? "forward") || fresh.step !== (old.step ?? "")) fresh.log.push({ direction: fresh.direction, step: fresh.step, what: "announced", at: t });
  if (fresh.done && fresh.done !== (old.done ?? "")) fresh.log.push({ direction: fresh.direction, step: fresh.done, what: "done", at: t });
  db.prepare("UPDATE stack_copies SET journal = ?, updated_at = ? WHERE id = ? AND state != 'removed'").run(JSON.stringify(fresh), t, Number(id));
  return stackCopy(id);
}

export {
  STACK_COPY_JOURNAL_SECTIONS, STACK_COPY_FRESH_START, STACK_COPY_PHASES, STACK_COPY_WAITING, STACK_COPY_STATES, initStackCopiesSchema,
  liveStackCopy, liveStackCopiesOfChat, liveStackCopies, stackCopy, changeStackCopy, createStackCopy, setStackCopyMoveIn,
  writeStackCopyJournal, stackCopyJournalStatus, stackCopiesFinishedBuilt, stackCopiesInState, stackCopiesOf,
};
