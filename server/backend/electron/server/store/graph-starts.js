// The starts of graph workflows from the chat.
//
// One row per accepted call of `cbase_workflow_start`: which chat started (`chat_id`, the orchestrator), which
// workflow with which input, on which announcement of the human (`announcement_id`, `attachments`), from which call
// block (`call_id`), and what became of it (`status`, `reason`, `run_id`). Also: background (`child_chat_id`),
// worktree (`worktree*`), wait queue (`lock_key`).
//
// Status: `earmarked` (waits for the end of the turn) · `waiting_lock` · `waiting_storage` · `started` (a run in
// `workflow_runs`, `run_id`) · discarded · `stopped` (`stopped_of`: agent · human · erase). The state of the run
// view is computed from this and from the run by workflows/graph-start.js:graphRunView.
//
// A SEPARATE table instead of a column on `chats` (child chat) or `workflow_runs`: the golden fixtures record every
// column of every non-empty table (test/golden-harness.mjs) — a new `chats` column would be in all of them. No
// foreign keys on `chats`: deletion goes through the ONE closing path (chats/erase.js tidyUp →
// deleteGraphStartsFor). Reached via the facade `store.js` (`export *`, the registration "graph-starts" is there
// too) — `import-direction.test.js` keeps the facade as the only way; the names here are a wrapper
// (`export { … };`).
import { db } from "./db.js";
import { workflowOpenSql } from "./workflows.js";

// The status values in which a row has not started anything yet and can still start something.
const WAITING = ["earmarked", "waiting_lock", "waiting_storage"];
const list = (xs) => xs.map(() => "?").join(", ");

function initGraphStartSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS graph_starts (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      child_chat_id TEXT,
      workflow_id TEXT NOT NULL,
      workflow_name TEXT NOT NULL,
      shortName TEXT NOT NULL,
      input TEXT NOT NULL DEFAULT '',
      attachments TEXT NOT NULL DEFAULT '',
      background INTEGER NOT NULL DEFAULT 0,
      worktree INTEGER NOT NULL DEFAULT 0,
      worktree_path TEXT NOT NULL DEFAULT '',
      worktree_info TEXT NOT NULL DEFAULT '',
      announcement_id TEXT NOT NULL DEFAULT '',
      call_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      lock_key TEXT NOT NULL DEFAULT '',
      run_id TEXT,
      stopped_of TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_graph_starts_chat ON graph_starts(chat_id);
    CREATE INDEX IF NOT EXISTS idx_graph_starts_status ON graph_starts(status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_graph_starts_child ON graph_starts(child_chat_id) WHERE child_chat_id IS NOT NULL;
  `);
  // The instance in which a background start began — the identifier `<projectId>/copy-<name>` of the copy of its
  // orchestrator, otherwise '' (main, or a row from before the column). From then on the child chat runs in this
  // instance and never switches mid-run (runs/instance.js instanceForChat). After the copy is cleared away it is ''
  // again (graphStartsInstanceBack, stacks/inset.js).
  try { db.exec("ALTER TABLE graph_starts ADD COLUMN instance TEXT NOT NULL DEFAULT ''"); } catch { /* column already exists */ }
  // THE EARMARK STORE of a graph run in the background. A message to the node agent (`graph:<startId>`, a channel
  // message to the child chat, a leftover entry of the queue) while NO node turn is running lies here and goes out
  // with the job of the next node turn (workflows/graph-message.js withEarmarked) — persisted so that it survives a
  // restart. A SEPARATE table, not a column on graph_starts: the golden fixtures record every column of every
  // non-empty table (see head). `prompt` is the finished, fenced text (runs/message-marker.js or the channel prompt);
  // the row in the history of the child chat already stands when it lands here. `status`: earmarked · delivered ·
  // expired (the run ended before the next node turn).
  db.exec(`
    CREATE TABLE IF NOT EXISTS graph_messages (
      id TEXT PRIMARY KEY,
      start_id TEXT NOT NULL,
      child_chat_id TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT '',
      prompt TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      delivered_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_graph_messages_child ON graph_messages(child_chat_id, status);
  `);
  // The SENDER of a message — `of_chat_id` (the parent chat for `graph:`, a chat from the queue) or `channel_id` (a
  // channel message to the child chat). If the run ends before a node turn takes it along, it stands on `expired`,
  // and the sender gets exactly one note (workflows/graph-background.js letExpire). The index by `start_id`: reading
  // happens per RUN, not per child chat (a second workflow started by hand in the child chat would otherwise get the
  // leftovers of the first).
  try { db.exec("ALTER TABLE graph_messages ADD COLUMN of_chat_id TEXT NOT NULL DEFAULT ''"); } catch { /* column already exists */ }
  try { db.exec("ALTER TABLE graph_messages ADD COLUMN channel_id TEXT NOT NULL DEFAULT ''"); } catch { /* column already exists */ }
  db.exec("CREATE INDEX IF NOT EXISTS idx_graph_messages_start ON graph_messages(start_id, status)");
}

// `attachments` is a JSON list of absolute paths (those of the announcement) or empty; broken JSON yields [] — the
// row stays readable, the attachments are then simply none.
function attachmentsFrom(text) {
  if (!text) return [];
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v.filter((p) => typeof p === "string") : [];
  } catch { return []; }
}

function mapGraphStart(r) {
  if (!r) return null;
  return {
    id: r.id, chatId: r.chat_id, childChatId: r.child_chat_id ?? null,
    workflowId: r.workflow_id, workflowName: r.workflow_name, shortName: r.shortName,
    input: r.input, attachments: attachmentsFrom(r.attachments),
    background: Boolean(r.background), worktree: Boolean(r.worktree),
    worktreePath: r.worktree_path, worktreeInfo: r.worktree_info,
    announcementId: r.announcement_id, callId: r.call_id,
    status: r.status, reason: r.reason, lockKey: r.lock_key, runId: r.run_id ?? null, stoppedOf: r.stopped_of,
    instance: r.instance ?? "",
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

/** A new row; `status` is mandatory (no silent default). Returns the row read back. */
function createGraphStart({
  id, chatId, childChatId = null, workflowId, workflowName, shortName, input = "", attachments = [], background = false,
  worktree = false, announcementId = "", callId = "", status, reason = "", instance = "", createdAt = Date.now(),
}) {
  if (!id || !chatId || !workflowId || !status) throw new Error("createGraphStart: id, chatId, workflowId and status are mandatory");
  db.prepare(`INSERT INTO graph_starts (id, chat_id, child_chat_id, workflow_id, workflow_name, shortName, input, attachments,
                background, worktree, announcement_id, call_id, status, reason, instance, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(String(id), String(chatId), childChatId, String(workflowId), String(workflowName || ""), String(shortName || ""),
      String(input ?? ""), Array.isArray(attachments) && attachments.length ? JSON.stringify(attachments) : "",
      background ? 1 : 0, worktree ? 1 : 0, String(announcementId || ""), String(callId || ""), String(status), String(reason || ""), String(instance || ""),
      createdAt, createdAt);
  return graphStart(id);
}

const graphStart = (id) => mapGraphStart(db.prepare("SELECT * FROM graph_starts WHERE id = ?").get(String(id)));

/** The starts of a chat (as orchestrator), newest first, at most `limit`. */
function graphStartsOf(chatId, { limit = 50 } = {}) {
  const n = Math.max(1, Math.min(500, Math.floor(Number(limit) || 50)));
  return db.prepare("SELECT * FROM graph_starts WHERE chat_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?")
    .all(String(chatId), n).map(mapGraphStart);
}

// The changeable fields. `undefined` is "not set" (like updateWorkflowRunById), `null` a value.
const FIELDS = {
  status: "status", reason: "reason", lockKey: "lock_key", runId: "run_id", childChatId: "child_chat_id",
  worktreePath: "worktree_path", worktreeInfo: "worktree_info", stoppedOf: "stopped_of", instance: "instance",
};
/** Change fields of a row; stamps `updated_at`. Returns the row afterwards (`null` if it does not exist). */
function changeGraphStart(id, fields = {}) {
  const sets = ["updated_at = ?"];
  const vals = [Date.now()];
  for (const [k, column] of Object.entries(FIELDS)) {
    if (fields[k] === undefined) continue;
    sets.push(`${column} = ?`);
    vals.push(fields[k]);
  }
  vals.push(String(id));
  db.prepare(`UPDATE graph_starts SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  return graphStart(id);
}

/** The open foreground start of a chat (earmarked or waiting), the oldest first — otherwise `null`. */
function openForegroundStart(chatId) {
  return mapGraphStart(db.prepare(`SELECT * FROM graph_starts WHERE chat_id = ? AND background = 0 AND status IN (${list(WAITING)})
    ORDER BY created_at, rowid LIMIT 1`).get(String(chatId), ...WAITING));
}

/** All rows in one of the status values, in order of creation (the wait queue). An empty list yields []. */
function graphStartsInStatus(statusList) {
  const s = (Array.isArray(statusList) ? statusList : []).map(String);
  if (!s.length) return [];
  return db.prepare(`SELECT * FROM graph_starts WHERE status IN (${list(s)}) ORDER BY created_at, rowid`).all(...s).map(mapGraphStart);
}

/**
 * The copy binding of the child chats — `graph_starts.instance` back to '' (main) as soon as the copy is gone.
 * `identifier` = `<projectId>/copy-<name>`. Returns the child chat ids that were moved (for the silent hint).
 */
function graphStartsInstanceBack(identifier) {
  const k = String(identifier ?? "");
  if (!k) return [];
  const ids = db.prepare("SELECT child_chat_id FROM graph_starts WHERE instance = ? AND child_chat_id IS NOT NULL").all(k).map((r) => r.child_chat_id);
  db.prepare("UPDATE graph_starts SET instance = '', updated_at = ? WHERE instance = ?").run(Date.now(), k);
  return ids;
}

/** Every identifier a child pin still points to (`graph_starts.instance` ≠ '') — for the restart (stacks/inset.js). */
function graphStartsPinIdentifiers() {
  return db.prepare("SELECT DISTINCT instance FROM graph_starts WHERE instance != ''").all().map((r) => r.instance);
}

/** The row whose child chat this is (background) — otherwise `null`. */
const graphStartOfChild = (childChatId) =>
  mapGraphStart(db.prepare("SELECT * FROM graph_starts WHERE child_chat_id = ?").get(String(childChatId)));

/**
 * The row of the run `runId` that runs in the chat `runChatId` (the observer at emitWorkflowRun and at the approval
 * hooks): the row with this `run_id` — or the background row of this child chat while it does not carry a run yet
 * (beginWorkflow reports the run before `run_id` is written). A child row with ANOTHER run (a second workflow,
 * started by hand in the child chat) does not match. ONE query — it runs at every run change of every workflow,
 * even without any row.
 */
function graphStartOfTheRun(runChatId, runId) {
  return mapGraphStart(db.prepare(`SELECT * FROM graph_starts WHERE run_id = ? OR (child_chat_id = ? AND run_id IS NULL)
    ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(String(runId ?? ""), String(runChatId ?? "")));
}

/** The ids of the child chats (background) — with `chatId` only those of this orchestrator, in order of creation. */
function graphChildChatIds(chatId) {
  if (chatId === undefined) {
    return db.prepare("SELECT child_chat_id FROM graph_starts WHERE child_chat_id IS NOT NULL").all().map((r) => r.child_chat_id);
  }
  return db.prepare("SELECT child_chat_id FROM graph_starts WHERE chat_id = ? AND child_chat_id IS NOT NULL ORDER BY created_at, rowid")
    .all(String(chatId)).map((r) => r.child_chat_id);
}

/**
 * The OPEN background starts — with `chatId` those of this orchestrator, otherwise of all chats; in order of
 * creation. Open means: the row still waits (earmarked, for lock or storage) OR it is started and its run is open
 * (`workflow_runs.status` in the open list — the same list as everywhere, `workflowOpenSql`). A started start
 * without a run (deleted) or with an ended run is over. The source of the background work "graphworkflow"
 * (runs/background.js).
 */
function graphRunsOpenOf(chatId) {
  const where = `background = 1 AND (status IN (${list(WAITING)})
    OR (status = 'started' AND run_id IN (SELECT id FROM workflow_runs WHERE ${workflowOpenSql()})))`;
  const rows = chatId === undefined || chatId === null
    ? db.prepare(`SELECT * FROM graph_starts WHERE ${where} ORDER BY created_at, rowid`).all(...WAITING)
    : db.prepare(`SELECT * FROM graph_starts WHERE chat_id = ? AND ${where} ORDER BY created_at, rowid`).all(String(chatId), ...WAITING);
  return rows.map(mapGraphStart);
}

// `worktree_info` is pure JSON (workflows/worktree.js); broken or empty yields null.
function worktreeInfoFrom(text) {
  if (!text) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && typeof v.dir === "string" && v.dir ? v : null;
  } catch { return null; }
}

/**
 * The worktree in which the chat `chatId` is currently running a graph workflow — the most recent start with
 * `worktree_path` whose RUN chat this is: as child chat (background) or as the starting chat in the foreground.
 * Returns `{ startId, path, info, background, active }` or null. `active`: the row still waits (created but not yet
 * redeemed — beginWorkflow runs the first step before `run_id` stands) or its run is open; afterwards a changed
 * worktree keeps standing (`active` false). ONE query — runs/system-prompt.js resolveCwd and do-run.js ask it in
 * every run; without a row with a worktree it is empty.
 */
function graphWorktreeFor(chatId) {
  const r = db.prepare(`SELECT *, (status IN (${list(WAITING)})
      OR (status = 'started' AND run_id IN (SELECT id FROM workflow_runs WHERE ${workflowOpenSql()}))) AS active
    FROM graph_starts WHERE worktree_path != '' AND (child_chat_id = ? OR (chat_id = ? AND background = 0))
    ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(...WAITING, String(chatId), String(chatId));
  const info = r ? worktreeInfoFrom(r.worktree_info) : null;
  if (!r || !info) return null;
  return { startId: r.id, path: r.worktree_path, info, background: Boolean(r.background), active: Boolean(r.active) };
}

/**
 * Does the chat have a foreground row with a worktree that is still open — also while its worktree does NOT YET
 * stand (`worktree_path` empty: earmarked, waiting, being created)? (graphWorktreeFor only sees rows with a path.)
 * Open: it waits, or its run is open.
 */
function graphWorktreeOpenFor(chatId) {
  return Boolean(db.prepare(`SELECT 1 FROM graph_starts WHERE worktree = 1 AND background = 0 AND chat_id = ?
      AND (status IN (${list(WAITING)}) OR (status = 'started' AND run_id IN (SELECT id FROM workflow_runs WHERE ${workflowOpenSql()}))) LIMIT 1`)
    .get(String(chatId), ...WAITING));
}

/**
 * All worktrees that hang on a chat (the deletion): the rows it started as orchestrator, and the row whose child it
 * is — each `{ startId, path, info }`.
 */
function graphWorktreesOf(chatId) {
  return db.prepare("SELECT id, worktree_path, worktree_info FROM graph_starts WHERE worktree_path != '' AND (chat_id = ? OR child_chat_id = ?) ORDER BY created_at, rowid")
    .all(String(chatId), String(chatId))
    .map((r) => ({ startId: r.id, path: r.worktree_path, info: worktreeInfoFrom(r.worktree_info) }))
    .filter((w) => w.info);
}

/** Delete the starts of a chat (as orchestrator) — only from the closing path (chats/erase.js tidyUp). Their earmark store too. */
function deleteGraphStartsFor(chatId) {
  db.prepare("DELETE FROM graph_messages WHERE start_id IN (SELECT id FROM graph_starts WHERE chat_id = ?)").run(String(chatId));
  db.prepare("DELETE FROM graph_starts WHERE chat_id = ?").run(String(chatId));
}

// ── Earmark store ────────────────────────────────────────────────────────────────────────────────────────────────────
const mapGraphMessage = (r) => (r ? {
  id: r.id, startId: r.start_id, childChatId: r.child_chat_id, source: r.source, prompt: r.prompt, status: r.status,
  ofChatId: r.of_chat_id || "", channelId: r.channel_id || "",
  createdAt: r.created_at, deliveredAt: r.delivered_at ?? null,
} : null);

/** Earmark a message. Mandatory: id, startId, childChatId, prompt. The sender (`ofChatId` | `channelId`) is optional. */
function earmarkGraphMessage({ id, startId, childChatId, source = "", prompt, ofChatId = "", channelId = "", createdAt = Date.now() }) {
  if (!id || !startId || !childChatId || !prompt) throw new Error("earmarkGraphMessage: id, startId, childChatId and prompt are mandatory");
  db.prepare(`INSERT INTO graph_messages (id, start_id, child_chat_id, source, prompt, status, of_chat_id, channel_id, created_at)
              VALUES (?, ?, ?, ?, ?, 'earmarked', ?, ?, ?)`)
    .run(String(id), String(startId), String(childChatId), String(source || ""), String(prompt), String(ofChatId || ""), String(channelId || ""), createdAt);
  return mapGraphMessage(db.prepare("SELECT * FROM graph_messages WHERE id = ?").get(String(id)));
}

/**
 * The messages of a child chat in order of arrival — with `status` only those in this state, with `startId` only
 * those of this RUN (a second workflow in the same child chat does not see the leftovers of the first).
 */
function graphMessages(childChatId, { status, startId } = {}) {
  const where = ["child_chat_id = ?"];
  const values = [String(childChatId)];
  if (startId) { where.push("start_id = ?"); values.push(String(startId)); }
  if (status) { where.push("status = ?"); values.push(String(status)); }
  return db.prepare(`SELECT * FROM graph_messages WHERE ${where.join(" AND ")} ORDER BY created_at, rowid`).all(...values).map(mapGraphMessage);
}

/**
 * At the end of a run: what is still earmarked of it stands on `expired` afterwards — exactly once (only what was
 * still earmarked). Returns exactly the rows that expired in the process, in order of arrival.
 */
function expireGraphMessages(startId) {
  const open = db.prepare("SELECT * FROM graph_messages WHERE start_id = ? AND status = 'earmarked' ORDER BY created_at, rowid").all(String(startId));
  const fresh = [];
  const set = db.prepare("UPDATE graph_messages SET status = 'expired' WHERE id = ? AND status = 'earmarked'");
  for (const r of open) if (Number(set.run(r.id).changes || 0) > 0) fresh.push(mapGraphMessage({ ...r, status: "expired" }));
  return fresh;
}

/** Mark earmarked ones as delivered (only what is still earmarked — exactly once). Returns the number marked. */
function graphMessagesDelivered(ids) {
  const list = (Array.isArray(ids) ? ids : []).map(String).filter(Boolean);
  if (!list.length) return 0;
  return Number(db.prepare(`UPDATE graph_messages SET status = 'delivered', delivered_at = ? WHERE status = 'earmarked' AND id IN (${list.map(() => "?").join(", ")})`)
    .run(Date.now(), ...list).changes || 0);
}

export {
  graphChildChatIds, graphRunsOpenOf, earmarkGraphMessage, graphMessages, expireGraphMessages, graphMessagesDelivered, graphStart, changeGraphStart, createGraphStart, graphStartOfTheRun, graphStartOfChild, graphStartsInStatus,
  graphStartsInstanceBack, deleteGraphStartsFor, graphStartsPinIdentifiers, graphStartsOf, graphWorktreeFor, graphWorktreeOpenFor, graphWorktreesOf, initGraphStartSchema, openForegroundStart,
};

/**
 * Every row with a worktree, RAW (`worktree_info` as text, as it stands in the column) — for the relocation
 * (projectbox/relocation/data.js): it rewrites the entries of the moved worktrees (changeGraphStart) and restores
 * them byte-equal on the return path.
 */
function graphWorktreeRows() {
  return db.prepare("SELECT id, worktree_path, worktree_info FROM graph_starts WHERE worktree_path != '' ORDER BY created_at, rowid")
    .all().map((r) => ({ id: r.id, path: r.worktree_path, info: r.worktree_info }));
}

export { graphWorktreeRows };
