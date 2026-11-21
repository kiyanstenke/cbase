// Scheduled jobs in Coding. The data layer: the job (instructions, cadence, state) and its runs. Registration "scheduled"
// in store.js.
//
// ONE truth on the chat: name, workspace, project, instance, provider, model, effort level, permission mode and
// notification choice stand on the chat that carries the job (`chats.job_id`, unique — store/chats.js
// initChatJobSchema); the job does NOT copy them. Its settings are written by the chat PATCH with its rules. Hence
// there is no provider and no model here.
//
// What the values mean (cadences, status, causes) is in the contract `../scheduled/contract.js` — not once more as
// a CHECK here: the store stays domain-free (server/backend/test/import-direction.test.js), and a second list in SQL
// would silently drift apart. Checking happens at the routes, here is written what they let through.
//
// Delete paths: the workspace takes both tables with it (workspaces.js deleteWorkspace, guard "delete lists ↔
// schema" in server/backend/test/schema-register.test.js); a project has no column here — its job runs on at the
// chat without a project. Deleting the job leaves the chat (`deleteScheduledJob`); deleting the chat deletes the
// job (hook on `chatClosed`: deleteOrphanedScheduledJobs — the chat row is already gone there).
import { db, inOneTransaction } from "./db.js";
import { parseJson } from "./_util.js";
import { createChat, getChat, updateChat } from "./chats.js";

function initScheduledSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_jobs (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      instructions TEXT NOT NULL DEFAULT '',
      cadence TEXT NOT NULL,
      plan TEXT NOT NULL DEFAULT '{}',
      cron TEXT NOT NULL DEFAULT '',
      one_time_at INTEGER NOT NULL DEFAULT 0,
      timeZone TEXT NOT NULL DEFAULT 'UTC',
      status TEXT NOT NULL DEFAULT 'active',
      next_at INTEGER NOT NULL DEFAULT 0,
      retry_at INTEGER NOT NULL DEFAULT 0,
      last_run_at INTEGER NOT NULL DEFAULT 0,
      last_status TEXT NOT NULL DEFAULT '',
      last_error TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_scheduled_ws ON scheduled_jobs(workspace_id, status);
    CREATE INDEX IF NOT EXISTS idx_scheduled_next ON scheduled_jobs(status, next_at);

    CREATE TABLE IF NOT EXISTS scheduled_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      cause TEXT NOT NULL DEFAULT 'tick',
      scheduled_at INTEGER NOT NULL DEFAULT 0,
      queued_at INTEGER NOT NULL DEFAULT 0,
      started_at INTEGER NOT NULL DEFAULT 0,
      ended_at INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'open',
      error TEXT NOT NULL DEFAULT '',
      short TEXT NOT NULL DEFAULT '',
      question INTEGER NOT NULL DEFAULT 0,
      entry_id TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_scheduled_runs ON scheduled_runs(job_id, id);
  `);
}

// ── Jobs ───────────────────────────────────────────────────────────────────────
// `chatId` comes from the binding on the chat (the one truth) — the same join in every read, so that no reader
// rebuilds the assignment itself. A job without a chat (only possible between two statements of one transaction)
// reads with `chatId: null`.
const JOB_SQL = "SELECT a.*, (SELECT c.id FROM chats c WHERE c.job_id = a.id) AS chat_id FROM scheduled_jobs a";
// No row ⇒ null (not undefined): the routes answer 404 to that, and a comparison with null should hold.
const mapJob = (r) => r ? {
  id: r.id, workspaceId: r.workspace_id, chatId: r.chat_id || null, instructions: r.instructions || "",
  cadence: r.cadence, plan: parseJson(r.plan, {}), cron: r.cron || "", oneTimeAt: r.one_time_at || 0, timeZone: r.timeZone || "UTC",
  status: r.status || "active", nextAt: r.next_at || 0, retryAt: r.retry_at || 0,
  lastRunAt: r.last_run_at || 0, lastStatus: r.last_status || "", lastError: r.last_error || "",
  createdAt: r.created_at, updatedAt: r.updated_at,
} : null;
const getScheduledJob = (id) => mapJob(db.prepare(`${JOB_SQL} WHERE a.id = ?`).get(String(id ?? "")));

/** The job this chat carries, or null. */
const jobOfTheChat = (chatId) =>
  mapJob(db.prepare(`${JOB_SQL} WHERE a.id = (SELECT job_id FROM chats WHERE id = ?)`).get(String(chatId ?? "")));

/**
 * The jobs of a workspace, oldest first. `status` filters on a state, `projectId` on the jobs whose chat works in
 * that project (the project stands on the chat).
 */
function listScheduledJobs(workspaceId, { status = null, projectId = null } = {}) {
  const where = ["a.workspace_id = ?"]; const vals = [String(workspaceId ?? "")];
  if (status) { where.push("a.status = ?"); vals.push(status); }
  if (projectId) { where.push("EXISTS (SELECT 1 FROM chats c WHERE c.job_id = a.id AND c.project_id = ?)"); vals.push(projectId); }
  return db.prepare(`${JOB_SQL} WHERE ${where.join(" AND ")} ORDER BY a.created_at, a.rowid`).all(...vals).map(mapJob);
}

function createScheduledJob({ id, workspaceId, instructions = "", cadence, plan = {}, cron = "", oneTimeAt = 0, timeZone = "UTC", status = "active", nextAt = 0, createdAt = Date.now(), updatedAt = createdAt }) {
  db.prepare(`INSERT INTO scheduled_jobs (id, workspace_id, instructions, cadence, plan, cron, one_time_at, timeZone, status, next_at, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, workspaceId, instructions, cadence, JSON.stringify(plan || {}), cron, oneTimeAt, timeZone, status, nextAt, createdAt, updatedAt);
  return getScheduledJob(id);
}

function updateScheduledJob(id, fields) {
  const map = { instructions: "instructions", cadence: "cadence", cron: "cron", oneTimeAt: "one_time_at", timeZone: "timeZone", status: "status", nextAt: "next_at", retryAt: "retry_at", lastRunAt: "last_run_at", lastStatus: "last_status", lastError: "last_error", updatedAt: "updated_at" };
  const sets = [], vals = [];
  for (const [k, col] of Object.entries(map)) if (k in fields) { sets.push(`${col} = ?`); vals.push(fields[k]); }
  if ("plan" in fields) { sets.push("plan = ?"); vals.push(JSON.stringify(fields.plan || {})); }
  if (!sets.length) return getScheduledJob(id);
  vals.push(id);
  db.prepare(`UPDATE scheduled_jobs SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  return getScheduledJob(id);
}

/**
 * Delete a job: the chat STAYS — it only loses the binding (`job_id` = NULL, so the auto-archive applies again) —,
 * the runs fall with it. In ONE transaction. The hint row in the history is written by the route.
 * Returns `{ deleted, chatId }` (the chat that carried it, or null).
 */
function deleteScheduledJob(id) {
  const aid = String(id ?? "");
  return inOneTransaction(() => {
    const chatId = db.prepare("SELECT id FROM chats WHERE job_id = ?").get(aid)?.id || null;
    db.prepare("UPDATE chats SET job_id = NULL WHERE job_id = ?").run(aid);
    db.prepare("DELETE FROM scheduled_runs WHERE job_id = ?").run(aid);
    const deleted = db.prepare("DELETE FROM scheduled_jobs WHERE id = ?").run(aid).changes > 0;
    return { deleted, chatId };
  });
}

/**
 * Delete the jobs whose chat no longer stands, with their runs — the path "deleting the chat deletes the job" (hook
 * on `chatClosed`): the hook only fires AFTER the chat row (chats/erase.js), the binding is already gone by then. A
 * job without a chat otherwise only arises between two statements of ONE transaction (creation) —
 * synchronous, no hook gets in between. Returns the deleted `{ id, workspaceId }`.
 */
function deleteOrphanedScheduledJobs() {
  return inOneTransaction(() => {
    const orphans = db.prepare("SELECT id, workspace_id FROM scheduled_jobs a WHERE NOT EXISTS (SELECT 1 FROM chats c WHERE c.job_id = a.id)").all();
    for (const r of orphans) {
      db.prepare("DELETE FROM scheduled_runs WHERE job_id = ?").run(r.id);
      db.prepare("DELETE FROM scheduled_jobs WHERE id = ?").run(r.id);
    }
    return orphans.map((r) => ({ id: r.id, workspaceId: r.workspace_id }));
  });
}

/**
 * Create job AND chat in ONE transaction: `job` are the fields of createScheduledJob, `chat` those of createChat
 * (without `jobId` — this transaction sets the binding), `notify` the already normalized notification choice. A
 * throw in between leaves no job without a chat and no chat without a job. Returns `{ job, chat }`.
 */
function setUpScheduledJob({ job, chat, notify = null }) {
  return inOneTransaction(() => {
    createScheduledJob(job);
    createChat({ ...chat, jobId: job.id });
    updateChat(chat.id, { titled: 1, ...(notify ? { notify: JSON.stringify(notify) } : {}) });
    return { job: getScheduledJob(job.id), chat: getChat(chat.id) };
  });
}

/** The earliest upcoming occurrence or the earliest retry over all active jobs (ms), 0 without — the alarm. */
function nextScheduledOccurrence() {
  const r = db.prepare(`SELECT MIN(t) AS t FROM (
      SELECT next_at AS t FROM scheduled_jobs WHERE status = 'active' AND next_at > 0
      UNION ALL
      SELECT retry_at AS t FROM scheduled_jobs WHERE status = 'active' AND retry_at > 0)`).get();
  return Number(r?.t) || 0;
}

// ── Runs ───────────────────────────────────────────────────────────────────────
const mapRun = (r) => r ? {
  id: r.id, jobId: r.job_id, workspaceId: r.workspace_id, chatId: r.chat_id,
  cause: r.cause || "tick", scheduledAt: r.scheduled_at || 0, queuedAt: r.queued_at || 0,
  startedAt: r.started_at || 0, endedAt: r.ended_at || 0,
  status: r.status || "open", error: r.error || "", short: r.short || "", question: !!r.question,
  entryId: r.entry_id || null,
} : null;
const getScheduledRun = (id) => mapRun(db.prepare("SELECT * FROM scheduled_runs WHERE id = ?").get(Number(id)));

function createScheduledRun({ jobId, workspaceId, chatId, cause = "tick", scheduledAt = 0, queuedAt = 0, startedAt = 0, status = "open", error = "", entryId = null }) {
  const id = db.prepare(`INSERT INTO scheduled_runs (job_id, workspace_id, chat_id, cause, scheduled_at, queued_at, started_at, status, error, entry_id)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(jobId, workspaceId, chatId, cause, scheduledAt, queuedAt, startedAt, status, error, entryId || "").lastInsertRowid;
  return getScheduledRun(Number(id));
}

function updateScheduledRun(id, fields) {
  const map = { queuedAt: "queued_at", startedAt: "started_at", endedAt: "ended_at", status: "status", error: "error", short: "short", question: "question", entryId: "entry_id" };
  const sets = [], vals = [];
  for (const [k, col] of Object.entries(map)) {
    if (!(k in fields)) continue;
    sets.push(`${col} = ?`);
    vals.push(k === "question" ? (fields[k] ? 1 : 0) : k === "entryId" ? (fields[k] || "") : fields[k]);
  }
  if (!sets.length) return getScheduledRun(id);
  vals.push(Number(id));
  db.prepare(`UPDATE scheduled_runs SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  return getScheduledRun(id);
}

/** The runs of a job, newest first; `before` is a run id (paging), `limit` 1–200 (default 20). */
function listScheduledRuns(jobId, { before = 0, limit = 20 } = {}) {
  const lim = Math.min(200, Math.max(1, Number(limit) || 20));
  const beforeValue = Number(before) || 0;
  return (beforeValue
    ? db.prepare("SELECT * FROM scheduled_runs WHERE job_id = ? AND id < ? ORDER BY id DESC LIMIT ?").all(String(jobId ?? ""), beforeValue, lim)
    : db.prepare("SELECT * FROM scheduled_runs WHERE job_id = ? ORDER BY id DESC LIMIT ?").all(String(jobId ?? ""), lim)).map(mapRun);
}

/** The open runs of a job, oldest first (the run end closes the oldest). */
const openScheduledRuns = (jobId) =>
  db.prepare("SELECT * FROM scheduled_runs WHERE job_id = ? AND status = 'open' ORDER BY id").all(String(jobId ?? "")).map(mapRun);

/**
 * The jobs the tick has to look at now: active and with a due occurrence or a due retry. Oldest first — a backlog
 * of many jobs is worked off in the order of their creation.
 */
const dueScheduledJobs = (now = Date.now()) =>
  db.prepare(`${JOB_SQL} WHERE a.status = 'active' AND ((a.next_at > 0 AND a.next_at <= ?) OR (a.retry_at > 0 AND a.retry_at <= ?)) ORDER BY a.created_at, a.rowid`)
    .all(now, now).map(mapJob);

/** All open runs of all jobs, oldest first — the cleanup at start (scheduled/tick.js). */
const allOpenScheduledRuns = () =>
  db.prepare("SELECT * FROM scheduled_runs WHERE status = 'open' ORDER BY id").all().map(mapRun);

export { initScheduledSchema, getScheduledJob, jobOfTheChat, listScheduledJobs, createScheduledJob, updateScheduledJob, deleteScheduledJob, deleteOrphanedScheduledJobs, setUpScheduledJob, nextScheduledOccurrence };
export { getScheduledRun, createScheduledRun, updateScheduledRun, listScheduledRuns, openScheduledRuns, dueScheduledJobs, allOpenScheduledRuns };
