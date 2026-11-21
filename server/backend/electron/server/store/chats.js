// Chats and chat folders (create, read, move, delete, archive) and messages (history, roles, truncation).
// Answers: how does a chat hang on workspace, project and folder, and how is its history read.
// A registered topic file. Its schemas (registration names in store.js):
//   `initArchiveSchema` ("chat-archive") — column `archived_at` on chat and folder and the three triggers that keep
//     the folder rule in the DATABASE.
//   `migrateUltraToMax` ("effort-ultra-max") — stored effort levels from the time of the sixth level.
//   `initUpstreamSchema` ("chat-upstream") — `upstream_provider` and `upstream_window`: the provider behind a router
//     that delivered the last answer, and its window (display only).
//   `initChatInstanceSchema` ("chat-instance") — `instance`: the instance the chat works in (NULL = main, otherwise
//     `copy-<name>`).
//   `initArchiveReasonSchema` ("chat-archive-reason") — `archive_reason` (who archived: 'user' | 'auto') and
//     `restored_at` (the auto-archive clock restarts on restore).
//   `initEffortOwnSchema` ("chat-effort-own") — `effort_own`: the level is the human's choice in this chat.
//   `initTargetPauseSchema` ("chat-target-pause") — `goal_paused`: a set goal rests (no goal in the system prompt,
//     no verdict, no continuation) until the human resumes it.

import { abandonWorkflowRuns, workflowOpenSql, CHAT_DELETED_NOTE } from "./workflows.js";
import { chatSearchCauseBelongsIn, exemptChatSearch } from "./chat-search.js";
import { db, inOneTransaction, columnWithBackfill } from "./db.js";
import { getSetting, setSetting } from "./workspaces.js";
import { parseJson } from "./_util.js";


// ── Chats ────────────────────────────────────────────────────────────────────
const mapChat = (r) => r && {
  id: r.id, workspaceId: r.workspace_id, projectId: r.project_id, folderId: r.folder_id || null,
  title: r.title, profile: r.profile, claudeSessionId: r.claude_session_id,
  pinned: !!r.pinned, kind: r.kind || "normal", model: r.model || "", permissionMode: r.permission_mode || "", effort: r.effort || "", ultracode: !!r.ultracode, contextTokens: r.context_tokens || 0,
  // The level is the human's CHOICE in this chat (see initEffortOwnSchema): set only by a client PATCH.
  effortOwn: !!r.effort_own,
  goal: r.goal || "", contextSummary: r.context_summary || "", forkPending: !!r.fork_pending, titled: !!r.titled, provider: r.provider || "",
  // The goal rests (see initTargetPauseSchema): it is not in the system prompt, the judge gives no verdict, nothing is
  // continued. Only true with a goal — every write of `goal` without the pause resets it (updateChat).
  goalPaused: !!r.goal_paused,
  browserMode: r.browser_mode || "", briefing: r.briefing || "",
  // Legacy of the manager agents and schedules: set only in manager chats of old stores; a scheduled job is bound through `jobId`.
  agentId: r.agent_id || null, scheduleId: r.schedule_id || null, scheduleRunId: r.schedule_run_id || null,
  // The special role of a legacy manager chat: '' · 'pipeline' · 'verwalter'. Exactly one per workspace AND role
  // (partial index). There is deliberately no derived boolean next to it: a forgotten reader is then `undefined`,
  // i.e. false instead of accidentally true.
  specialRole: r.specialRole || "",
  // Notification choice per kind; a broken value must not make the chat unreadable.
  notify: parseJson(r.notify, {}),
  // Autocompact: null = default, 0 = off, otherwise percent.
  autocompact: r.autocompact == null ? null : Number(r.autocompact),
  autocompactMax: r.autocompact_max == null ? null : Number(r.autocompact_max),
  createdAt: r.created_at, updatedAt: r.updated_at,
  // Archive: ms, null = active. The only truth about "archived" — set only through archiveChat/archiveFolder, never
  // through updateChat (a PATCH cannot archive).
  archivedAt: r.archived_at ?? null,
  // Who archived it: "user" | "auto", null while active. Bound to `archived_at` — that stays the only truth about
  // "archived"; an archived chat without a reason (legacy only) was the user's.
  archiveReason: r.archived_at == null ? null : (r.archive_reason === "auto" ? "auto" : "user"),
  // The provider BEHIND a router that delivered the last answer, and its context window (0 = unknown) — display
  // ONLY, calculations use the catalog number. Written by runs/do-run.js (runs/upstream-display.js), cleared when
  // model or provider of the chat change (updateChat below); compaction leaves it — the provider depends on the
  // model, not on the history.
  upstreamProvider: r.upstream_provider || "",
  upstreamWindow: r.upstream_window || 0,
  // The instance the chat works in: null = main, otherwise `copy-<name>`. Meaningful only in a converted project and
  // only in ITS project — a project change resets it in the same UPDATE (updateChat). Read by the binding
  // (stacks/remove.js copyOfTheChat → runs/instance.js), set through PATCH (chats/routes.js), the move-in of a copy
  // (stacks/inset.js) and the one-time migration `migration.copies_free`.
  instance: r.instance || null,
  // The scheduled job this chat carries (see initChatJobSchema): null = none. The ONE binding — the job does not
  // copy the chat's run values.
  jobId: r.job_id || null,
};

// "Has at least one row in the history OR a queued input" — as a condition over `chats` without alias, ONE
// expression for both lists (listChats, chatFolderCounts). An EXISTS instead of a JOIN: it uses
// `idx_messages_chat(chat_id)` or the primary key `(chat_id, seq)` of `run_inputs` and stops at the first hit.
// The queue: a queued message writes its row to `messages` only at START (runs/queue.js deliverUserPrompt — e.g.
// under the project lock); until then it only lives in `run_inputs`, the image of `pendingRunInputs`
// (runs/state.js persistRunInputs). Without the second part a chat whose FIRST message waits was in no list.
// The auto-archive candidate (autoArchiveCandidates below) stays at "≥ 1 message": a queued chat has open work
// anyway.
// A chat with a scheduled job is in it too, even empty: it is created with the job and first written at the first
// occurrence — without the third part a freshly created job would be missing from the list until then.
const WITH_MESSAGE_OR_QUEUED_SQL = "(EXISTS (SELECT 1 FROM messages m WHERE m.chat_id = chats.id)"
  + " OR EXISTS (SELECT 1 FROM run_inputs q WHERE q.chat_id = chats.id)"
  + " OR chats.job_id IS NOT NULL)";

export function createChat({ id, workspaceId, projectId = null, folderId = null, title = "New chat", profile = "default", kind = "normal", model = "", permissionMode = "", effort = "", ultracode = false, provider = "", browserMode = "", agentId = null, scheduleId = null, scheduleRunId = null, instance = null, jobId = null, createdAt, updatedAt }) {
  db.prepare(`INSERT INTO chats (id, workspace_id, project_id, folder_id, title, profile, kind, model, permission_mode, effort, ultracode, provider, browser_mode, agent_id, schedule_id, schedule_run_id, instance, job_id, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, workspaceId, projectId, folderId, title, profile, kind, model, permissionMode, effort, ultracode ? 1 : 0, provider, browserMode, agentId, scheduleId, scheduleRunId, instance || null, jobId || null, createdAt, updatedAt);
  return getChat(id);
}
export const getChat = (id) => mapChat(db.prepare("SELECT * FROM chats WHERE id = ?").get(id));
// The chat list only shows normal chats — conflict chats hang on the project (services view).
/**
 * History counters per chat (for the chat views of the agents): rows, user turns and the time of the LAST row.
 * `updated_at` on the chat is unsuitable — it also rises on rename and pin; "last activity" is the last message.
 * ONE query per 500 ids.
 */
export function chatStats(ids = []) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500);
    const rows = db.prepare(`SELECT chat_id, COUNT(*) AS lines, SUM(CASE WHEN role = 'user' THEN 1 ELSE 0 END) AS user_turns, MAX(created_at) AS last_at
      FROM messages WHERE chat_id IN (${part.map(() => "?").join(",")}) AND role <> 'input' GROUP BY chat_id`).all(...part); // `input`: model context (see listMessages)
    for (const r of rows) out.set(r.chat_id, { lines: r.lines, userTurns: r.user_turns || 0, lastMessageAt: r.last_at || 0 });
  }
  return out;
}
/**
 * The FIRST user message per chat (overview and search of cbase_agents_list) — without the completion notices of
 * subagents, which also carry the role `user` (runs/completionNotice.js FINISHED_MARKER, here as a literal as in
 * listOpenAsks), and without the messages of other agents (`<cbase-message`, runs/message-marker.js MESSAGE_MARKER
 * — the same list as store/chat-search.js CHAT_SEARCH_EXEMPT). Truncated to `max` characters, ONE query per 500
 * ids — the history itself is not read.
 */
function firstUserMessages(ids = [], max = 400) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500);
    const rows = db.prepare(`SELECT m.chat_id, substr(m.text, 1, ?) AS text FROM messages m JOIN (
        SELECT chat_id, MIN(id) AS id FROM messages
        WHERE chat_id IN (${part.map(() => "?").join(",")}) AND role = 'user' AND text NOT LIKE '<task-notification>%' AND text NOT LIKE '<cbase-message%' GROUP BY chat_id
      ) f ON f.id = m.id`).all(Math.max(1, max | 0), ...part);
    for (const r of rows) out.set(r.chat_id, r.text || "");
  }
  return out;
}
// `archive`: "without" (default, only active) · "only" (the archive, most recently archived first) · "including".
// Without the child chats of background graph workflows: a child is `kind = 'normal'`, the link lives in
// `graph_starts.child_chat_id` — it hangs on the orchestrator, appears in NO chat list and is opened through the
// orchestrator's card.
// `onlyWithMessage`: only chats with at least one row in the history (any role) or a queued input
// (WITH_MESSAGE_OR_QUEUED_SQL above) — the lists the CLIENTS read set it (chats/routes.js); a created, never
// written chat is a draft and is in no list. Default OFF: the agents' tools (communication/read.js) and the
// internal counters still see every chat.
export function listChats(workspaceId, { archive = "without", onlyWithMessage = false } = {}) {
  const where = `kind = 'normal' AND ${archiveSql(archive)} AND id NOT IN (SELECT child_chat_id FROM graph_starts WHERE child_chat_id IS NOT NULL)${onlyWithMessage ? ` AND ${WITH_MESSAGE_OR_QUEUED_SQL}` : ""}`;
  const ordering = archive === "only" ? "archived_at DESC, updated_at DESC" : "pinned DESC, updated_at DESC";
  const rows = workspaceId
    ? db.prepare(`SELECT * FROM chats WHERE workspace_id = ? AND ${where} ORDER BY ${ordering}`).all(workspaceId)
    : db.prepare(`SELECT * FROM chats WHERE ${where} ORDER BY ${ordering}`).all();
  return rows.map(mapChat);
}

// ── Chat folders ─────────────────────────────────────────────────────────────
// Logical grouping of the chat list, ONE level deep (folders only contain chats).
const mapFolder = (r) => r && {
  id: r.id, workspaceId: r.workspace_id, projectId: r.project_id || null, name: r.name,
  kind: r.kind || "normal",
  createdAt: r.created_at, updatedAt: r.updated_at,
  archivedAt: r.archived_at ?? null,
};
export const listChatFolders = (workspaceId, kind = "normal", { archive = "without" } = {}) =>
  db.prepare(`SELECT * FROM chat_folders WHERE workspace_id = ? AND kind = ? AND ${archiveSql(archive)}
              ORDER BY ${archive === "only" ? "archived_at DESC, name COLLATE NOCASE" : "name COLLATE NOCASE"}`)
    .all(workspaceId, kind).map(mapFolder);
export const getChatFolder = (id) => mapFolder(db.prepare("SELECT * FROM chat_folders WHERE id = ?").get(id));
export function createChatFolder({ id, workspaceId, projectId = null, name, kind = "normal", createdAt, updatedAt }) {
  db.prepare("INSERT INTO chat_folders (id, workspace_id, project_id, name, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, workspaceId, projectId || null, name, kind === "manager" ? "manager" : "normal", createdAt, updatedAt);
  return getChatFolder(id);
}
export function updateChatFolder(id, fields) {
  const map = { name: "name", updatedAt: "updated_at" };
  const sets = [], vals = [];
  for (const [k, col] of Object.entries(map)) if (k in fields) { sets.push(`${col} = ?`); vals.push(fields[k]); }
  if (!sets.length) return getChatFolder(id);
  vals.push(id);
  db.prepare(`UPDATE chat_folders SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  return getChatFolder(id);
}
// Deleting a folder ONLY dissolves the grouping — the chats (and their artifacts) stay.
export function deleteChatFolder(id) {
  db.prepare("UPDATE chats SET folder_id = NULL WHERE folder_id = ?").run(id);
  return db.prepare("DELETE FROM chat_folders WHERE id = ?").run(id).changes > 0;
}
// Chats of a folder — in the kind of the FOLDER.
// Deliberately WITHOUT archive filter: artifact siblings and folder context also apply to archived chats —
// archived means readable, not gone.
export const listChatsInFolder = (folderId) => {
  const kind = getChatFolder(folderId)?.kind || "normal";
  return db.prepare("SELECT * FROM chats WHERE folder_id = ? AND kind = ? ORDER BY updated_at DESC")
    .all(folderId, kind).map(mapChat);
};
// Number of chats per folder (for the sidebar), as { [folderId]: n } — counted are the chats of the SAME archive
// side as the list the number belongs to (default: only active). Without special chats: the list never showed
// them, so the number next to it does not count them either — and in the archive it is the same number a final
// delete removes (archive.test.js holds both against each other).
// `onlyWithMessage`: the same option as on `listChats` — the number on the folder row counts what the list below
// shows. An empty chat in the folder does not count there; the delete confirmation still names it, because it is
// deleted too.
export function chatFolderCounts(workspaceId, kind = "normal", { archive = "without", onlyWithMessage = false } = {}) {
  const out = {};
  for (const r of db.prepare(
    `SELECT folder_id AS id, COUNT(*) AS n FROM chats WHERE workspace_id = ? AND kind = ? AND specialRole = '' AND folder_id IS NOT NULL AND ${archiveSql(archive)}${onlyWithMessage ? ` AND ${WITH_MESSAGE_OR_QUEUED_SQL}` : ""} GROUP BY folder_id`,
  ).all(workspaceId, kind)) out[r.id] = r.n;
  return out;
}

// The ids of all chats of a project (idle and wake per project, projectbox/idle.js), of every kind and archived or
// not — the child chats of a graph workflow carry the project of their orchestrator too (workflows/graph-start.js).
// In creation order.
// Wrapper (`export { … };` at the end of the file), not `export const`: the facade guard (store-facade.test.js)
// only lets new names through that way.
const chatIdsInProject = (projectId) =>
  db.prepare("SELECT id FROM chats WHERE project_id = ? ORDER BY created_at, rowid").all(String(projectId ?? "")).map((r) => r.id);
// The same for a workspace: every chat, of every kind, archived or not — the set `deleteWorkspace` deletes. The
// workspace delete asks through it for the open work of each chat (runs/archive.js deleteObstacles).
const chatIdsInWorkspace = (workspaceId) =>
  db.prepare("SELECT id FROM chats WHERE workspace_id = ? ORDER BY created_at, rowid").all(String(workspaceId ?? "")).map((r) => r.id);

/**
 * Create a fork in ONE transaction: the chat row, the copied history and the fork marker — all or nothing. Copying
 * row by row in autocommit cost one fsync each (3,000 rows: 930 ms against 17 ms, with the event loop blocked), and
 * an error midway left half a fork without `fork_pending`. Copied are role, text and timestamp in the order of the
 * original; attachments deliberately stay with the origin. `chat`: the fields of createChat, `afterwards`: the
 * fields of updateChat.
 */
function createFork(ofChatId, chat, afterwards) {
  return inOneTransaction(() => {
    const fork = createChat(chat);
    db.prepare(`INSERT INTO messages (chat_id, role, text, created_at)
                SELECT ?, role, text, created_at FROM messages WHERE chat_id = ? ORDER BY id`).run(fork.id, ofChatId);
    return updateChat(fork.id, afterwards);
  });
}

// The column `specialRole` and its index stay (store/db.js) for the legacy chats of old stores.
// Deliberately WITHOUT `archivedAt`: archiving only goes through the four archive functions at the end of the
// file — a PATCH that sends the field changes nothing.
export function updateChat(id, fields) {
  const map = { title: "title", profile: "profile", projectId: "project_id", folderId: "folder_id", pinned: "pinned", claudeSessionId: "claude_session_id", model: "model", permissionMode: "permission_mode", effort: "effort", ultracode: "ultracode", effortOwn: "effort_own", contextTokens: "context_tokens", goal: "goal", goalPaused: "goal_paused", contextSummary: "context_summary", forkPending: "fork_pending", titled: "titled", provider: "provider", browserMode: "browser_mode", briefing: "briefing", agentId: "agent_id", scheduleId: "schedule_id", scheduleRunId: "schedule_run_id", notify: "notify", autocompact: "autocompact", autocompactMax: "autocompact_max", specialRole: "specialRole", upstreamProvider: "upstream_provider", upstreamWindow: "upstream_window", instance: "instance", jobId: "job_id", updatedAt: "updated_at" };
  const sets = [], vals = [];
  // `instance` and `jobId`: empty means NULL — a '' in `job_id` would collide with the next '' on the unique partial index.
  for (const [k, col] of Object.entries(map)) if (k in fields) { sets.push(`${col} = ?`); vals.push(k === "instance" || k === "jobId" ? (fields[k] || null) : k === "goalPaused" ? (fields.goalPaused ? 1 : 0) : fields[k]); }
  // The pause belongs to THE goal that was paused (see initTargetPauseSchema): every write of `goal` — newly set, the
  // same again or cleared (the judge on "reached", /goal clear) — without `goalPaused` in the same call takes it back
  // in the SAME UPDATE, in ONE place for every path (PATCH, target gate, future writers). Whoever sets both (PATCH
  // with both fields, the fork) wins with their value.
  if ("goal" in fields && !("goalPaused" in fields)) sets.push("goal_paused = 0");
  // If the project changes, the instance no longer applies — it falls to NULL (main) in the SAME UPDATE, in ONE
  // place for every path. An explicitly passed instance wins (a caller that sets both).
  if ("projectId" in fields && !("instance" in fields)) {
    const old = getChat(id);
    if (old && (old.projectId || null) !== (fields.projectId || null)) sets.push("instance = NULL");
  }
  // If model or provider change, the provider of the last answer belongs to the OLD model — it falls, in ONE place
  // for every path (PATCH, provider switch, special model of a run kind, migrations) instead of in every caller.
  if (("model" in fields || "provider" in fields) && !("upstreamProvider" in fields)) {
    const old = getChat(id);
    const changeover = old && (("model" in fields && String(fields.model ?? "") !== old.model)
      || ("provider" in fields && String(fields.provider ?? "") !== old.provider));
    if (changeover) sets.push("upstream_provider = ''", "upstream_window = 0");
  }
  if (!sets.length) return getChat(id);
  vals.push(id);
  db.prepare(`UPDATE chats SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  return getChat(id);
}
// In ONE transaction: if a statement throws midway, no half chat remains (history gone, row there).
export function deleteChat(id) {
  return inOneTransaction(() => {
    db.prepare("DELETE FROM messages WHERE chat_id = ?").run(id);
    // A run of this chat waiting at the limit has nothing left to continue — and what was queued behind it has no
    // recipient any more.
    db.prepare("DELETE FROM pending_resumes WHERE chat_id = ?").run(id);
    db.prepare("DELETE FROM run_inputs WHERE chat_id = ?").run(id);
    // The workflow runs of this chat STAY: they are the history and the evidence of what ran. They only remember that
    // their chat is gone (chat_gone) — an open run is closed in the process, otherwise resumeInterruptedWork would try
    // to resume it forever. The note is a stored value that workflows/graph-background.js compares.
    abandonWorkflowRuns(id, CHAT_DELETED_NOTE);
    return db.prepare("DELETE FROM chats WHERE id = ?").run(id).changes > 0;
  });
}
// Discard the sessions of all chats WITHOUT an explicit provider. Such chats follow the GLOBALLY active provider
// (providerForChat falls back to it); if that changes, their resume id (created under the old provider) would be
// foreign → on the next run either a failing --resume or a synthetic engine UUID in a native CLI. Nulling
// prevents the carry-over cleanly (the history in DB/UI is kept).
export function clearGlobalProviderChatSessions() {
  return db.prepare(
    "UPDATE chats SET claude_session_id = NULL, context_tokens = 0, upstream_provider = '', upstream_window = 0 WHERE (provider IS NULL OR provider = '') AND claude_session_id IS NOT NULL",
  ).run().changes;
}
// Discard the sessions of all chats explicitly bound to ONE particular provider — used when that provider is
// deleted (the chats then fall back to the global provider, their resume id would be foreign). History is kept.
export function clearSessionsForProvider(providerId) {
  return db.prepare(
    "UPDATE chats SET claude_session_id = NULL, context_tokens = 0, upstream_provider = '', upstream_window = 0 WHERE provider = ? AND claude_session_id IS NOT NULL",
  ).run(providerId).changes;
}
// ── Messages ─────────────────────────────────────────────────────────────────
// `cause`: the cause of the turn this user row opens (runs/queue.js). A cause outside the full-text search (event,
// channel, agent, …) takes the row out of the index in the same transaction (store/chat-search.js
// exemptChatSearch) — otherwise a system text would be there as if the human had written it.
export function addMessage(chatId, role, text, ts = Date.now(), attachments = null, cause = undefined) {
  const write = () => db.prepare("INSERT INTO messages (chat_id, role, text, created_at, attachments) VALUES (?, ?, ?, ?, ?)")
    .run(chatId, role, text, ts, attachments?.length ? JSON.stringify(attachments) : null);
  if (role !== "user" || chatSearchCauseBelongsIn(cause)) {
    const r = write();
    if (ROWS_IN_STREAM.has(role)) reportRow(chatId, { id: Number(r.lastInsertRowid), role, text, ts, attachments: attachments?.length ? attachments : null });
    return Number(r.lastInsertRowid);
  }
  inOneTransaction(() => exemptChatSearch(write().lastInsertRowid));
}
// Rows written into a chat OUTSIDE its own turn stream: many places write the role `hint` (subagent at the limit,
// dynamic workflow, graph background, migrations, instance switch, limit gate, resume, …) — none of them sent an
// event, an open chat saw the row only after the next load. The observer sits HERE, at the one write site, not at
// each caller (the next one would forget it); connected in server.js (store/ is domain free, no import of
// runtime/sse.js). `row` has the same shape as a row from GET /api/chats/:id/log (listMessages).
// An observer that throws does not abort the write — the row is in the DB, the event is only the fast path.
const ROWS_IN_STREAM = new Set(["hint"]);
let rowsObserver = null;
function setRowsObserver(fn) { rowsObserver = typeof fn === "function" ? fn : null; }
function reportRow(chatId, row) {
  if (!rowsObserver) return;
  try { rowsObserver(String(chatId), row); } catch (e) { console.error("[store] rows observer:", e?.message || e); }
}
// The row id travels WITH the row: clients cache the history and afterwards only load the delta
// (`listMessagesSince`). Without a stable, monotonically growing identifier that would not be possible — the
// timestamp is no good (several rows share a millisecond).
//
// The role `input` is the wording that REALLY went out as the user message in a run of the loop engine —
// including agenda, hint and ultracode prefix, summary, hook context and date line (runs/do-run.js writes it from
// the engine event `cbase_input`). It is model context, not history for humans: the three client readers below
// (history, delta, stats — the same exception in all three, otherwise a client would consider its cache stale)
// leave it out, and with them every server reader of `listMessages`. It is only read through
// `listMessagesWithInputs` (runs/system-prompt.js buildEngineTranscript → providers/transcript.js).
const WITHOUT_INPUT = "role <> 'input'";
const withAppend = (m) => ({ ...m, attachments: m.attachments ? JSON.parse(m.attachments) : null });
export const listMessages = (chatId) =>
  db.prepare(`SELECT id, role, text, created_at AS ts, attachments FROM messages WHERE chat_id = ? AND ${WITHOUT_INPUT} ORDER BY id ASC`).all(chatId)
    .map(withAppend);
// The history INCLUDING the `input` rows — only for the look-back of the loop engine (see above).
const listMessagesWithInputs = (chatId) =>
  db.prepare("SELECT id, role, text, created_at AS ts, attachments FROM messages WHERE chat_id = ? ORDER BY id ASC").all(chatId)
    .map(withAppend);
// Only the rows AFTER `sinceId` — basis of the incremental reload on chat switch.
export const listMessagesSince = (chatId, sinceId) =>
  db.prepare(`SELECT id, role, text, created_at AS ts, attachments FROM messages WHERE chat_id = ? AND id > ? AND ${WITHOUT_INPUT} ORDER BY id ASC`)
    .all(chatId, Number(sinceId) || 0)
    .map(withAppend);
// The WINDOW of the history (chats/log-window.js — the rule is there, only the queries here): the most recent
// `limit` rows before `before` (returned ascending), a range [ab, before), the last row of a boundary role up to
// `until`, "are there rows before?" and ONE row untruncated. The same `input` exception as the three readers
// above — otherwise `total` would not add up.
const UPPER_LIMIT_ID = Number.MAX_SAFE_INTEGER;
const listMessagesBefore = (chatId, before, limit) =>
  db.prepare(`SELECT id, role, text, created_at AS ts, attachments FROM messages WHERE chat_id = ? AND id < ? AND ${WITHOUT_INPUT} ORDER BY id DESC LIMIT ?`)
    .all(chatId, Number(before) || UPPER_LIMIT_ID, Math.max(1, Number(limit) || 1))
    .map(withAppend).reverse();
const listMessagesArea = (chatId, from, before) =>
  db.prepare(`SELECT id, role, text, created_at AS ts, attachments FROM messages WHERE chat_id = ? AND id >= ? AND id < ? AND ${WITHOUT_INPUT} ORDER BY id ASC`)
    .all(chatId, Number(from) || 0, Number(before) || UPPER_LIMIT_ID)
    .map(withAppend);
const lastLimitUntil = (chatId, until, roles) =>
  db.prepare(`SELECT id FROM messages WHERE chat_id = ? AND id <= ? AND role IN (${roles.map(() => "?").join(",")}) ORDER BY id DESC LIMIT 1`)
    .get(chatId, Number(until) || 0, ...roles)?.id ?? 0;
const hasMessagesBefore = (chatId, before) =>
  !!db.prepare(`SELECT 1 FROM messages WHERE chat_id = ? AND id < ? AND ${WITHOUT_INPUT} LIMIT 1`).get(chatId, Number(before) || 0);
const getMessageRow = (chatId, id) => {
  const r = db.prepare(`SELECT id, role, text, created_at AS ts, attachments FROM messages WHERE chat_id = ? AND id = ? AND ${WITHOUT_INPUT}`).get(chatId, Number(id) || 0);
  return r ? withAppend(r) : null;
};
// Stats of the history WITHOUT reading it: total count + highest row id. A client checks its cache with it in one
// query — and also notices deleted rows (cleaned-up partial output of an aborted run), for which a pure delta
// would not be enough.
export const messageStats = (chatId) =>
  db.prepare(`SELECT COUNT(*) AS total, COALESCE(MAX(id), 0) AS lastId FROM messages WHERE chat_id = ? AND ${WITHOUT_INPUT}`).get(chatId)
  || { total: 0, lastId: 0 };
// Remove the `input` rows of a failed attempt again (runs/do-run.js, retry without session: the same turn goes
// out once more, and the look-back should show it ONCE). Only this role — a foreign id deletes nothing.
function deleteInputs(chatId, ids) {
  const list = (Array.isArray(ids) ? ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (!list.length) return 0;
  return db.prepare(`DELETE FROM messages WHERE chat_id = ? AND role = 'input' AND id IN (${list.map(() => "?").join(",")})`).run(chatId, ...list).changes;
}
// Chats with an OPEN question card (cbase_ask): of the roles that open or close a card (question, its answer, any
// other user message, clear), the MOST RECENT must be the question itself. Deliberately ONE query over all chats
// instead of reading the whole history per chat — the header pill asks every second.
// The same open rule as `openAskOf` in the server. The exceptions apply here too: while a workflow runs in the
// chat, a user row does NOT invalidate the card (otherwise it would vanish from the header pill while the run
// waits for exactly it). Neither does the completion notice of a subagent (role `user`, starting with
// `<task-notification>` = FINISHED_MARKER from runs/completionNotice.js — a literal here, store/ is domain free;
// bound through ask-card.test.js) nor the message of another agent (`<cbase-message` = MESSAGE_MARKER from
// runs/message-marker.js).
export const listOpenAsks = () =>
  db.prepare(`SELECT m.chat_id AS chatId, m.text AS text, m.created_at AS ts
              FROM messages m
              JOIN (SELECT chat_id, MAX(id) AS id FROM messages msg
                    WHERE msg.role IN ('ask', 'ask_answer', 'clear')
                       OR (msg.role = 'user' AND instr(msg.text, '<task-notification>') <> 1 AND instr(msg.text, '<cbase-message') <> 1 AND NOT EXISTS (
                             SELECT 1 FROM workflow_runs wr
                             WHERE wr.chat_id = msg.chat_id AND ${workflowOpenSql("wr.status")}))
                    GROUP BY chat_id) last
                ON last.id = m.id
              WHERE m.role = 'ask'`).all();

// Clean up the partial output of an interrupted run: delete all messages from a point in time (>= ts). The user
// message is stored BEFORE doRun with a smaller ts and stays. EXCLUDED are rows that are not output: the step row
// of a workflow is written right before the turn and would fall with it on the same millisecond — the history
// then showed an answer without its step header.
export const deleteMessagesFrom = (chatId, ts) =>
  db.prepare("DELETE FROM messages WHERE chat_id = ? AND created_at >= ? AND role NOT IN ('workflow','user')")
    .run(chatId, ts).changes;

// ── Archive ──────────────────────────────────────────────────────────────────
// `archived_at` (ms, NULL = active) on chat and folder is the only truth about "archived". The lists above filter
// for active by default (`archive = "without"`), `listChatsInFolder` stays unfiltered. Archiving and restoring do
// NOT change `updated_at`: the chat list sorts by it, and a restored chat is back at its old place; `pinned` stays
// as well.
//
// THE FOLDER RULE LIVES IN THE DATABASE, not in the callers: no active chat is in an archived folder. Two triggers
// bring back the folder of an active chat — on create, on move (PATCH folderId) and on restore —, the third
// forbids archiving a folder while it has an active chat. Many callers create chats; a store function per path
// would be the list that is forgotten at the next path. The trigger names are a contract: the guards look for them
// in `sqlite_master`. Deleting (`deleteChatFolder` sets folder_id = NULL, the workspace delete DELETEs) fires none.
//
// No index on `archived_at`: the lists filter per workspace, the tables are small — measure first.
function initArchiveSchema() {
  try { db.exec("ALTER TABLE chats ADD COLUMN archived_at INTEGER"); } catch { /* column already exists */ }
  try { db.exec("ALTER TABLE chat_folders ADD COLUMN archived_at INTEGER"); } catch { /* column already exists */ }
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS chats_active_holt_folder_new AFTER INSERT ON chats
    WHEN NEW.archived_at IS NULL AND NEW.folder_id IS NOT NULL
    BEGIN UPDATE chat_folders SET archived_at = NULL WHERE id = NEW.folder_id AND archived_at IS NOT NULL; END;

    CREATE TRIGGER IF NOT EXISTS chats_active_holt_folder AFTER UPDATE OF archived_at, folder_id ON chats
    WHEN NEW.archived_at IS NULL AND NEW.folder_id IS NOT NULL
    BEGIN UPDATE chat_folders SET archived_at = NULL WHERE id = NEW.folder_id AND archived_at IS NOT NULL; END;

    CREATE TRIGGER IF NOT EXISTS folder_archive_only_without_active BEFORE UPDATE OF archived_at ON chat_folders
    WHEN NEW.archived_at IS NOT NULL
      AND EXISTS (SELECT 1 FROM chats WHERE folder_id = NEW.id AND archived_at IS NULL)
    BEGIN SELECT RAISE(ABORT, 'folder-has-active-chats'); END;
  `);
}

// The provider of the last answer (see mapChat, initUpstreamSchema below): two columns, '' / 0 = none known.
// The instance a chat works in — NULL = main. No index: read per chat (chatInstance) and per project
// (chatsInInstance, filtered by project_id); measure first.
function initChatInstanceSchema() {
  try { db.exec("ALTER TABLE chats ADD COLUMN instance TEXT"); } catch { /* column already exists */ }
}

// The instance of a chat: `copy-<name>` or null (main, or the chat does not exist).
const chatInstance = (chatId) => db.prepare("SELECT instance FROM chats WHERE id = ?").get(String(chatId ?? ""))?.instance || null;
// The chats of a project that work in `instance` (moving out a copy resets them) — of every kind, archived or
// not, in creation order. `main` means NULL.
function chatsInInstance(projectId, instance) {
  const pid = String(projectId ?? "");
  return (!instance || instance === "main"
    ? db.prepare("SELECT id FROM chats WHERE project_id = ? AND instance IS NULL ORDER BY created_at, rowid").all(pid)
    : db.prepare("SELECT id FROM chats WHERE project_id = ? AND instance = ? ORDER BY created_at, rowid").all(pid, String(instance))).map((r) => r.id);
}
// All bindings to a copy (after a restart a binding to a copy without a living row is reset) —
// `[{ id, projectId, instance }]`.
const chatInstanceBindings = () =>
  db.prepare("SELECT id, project_id, instance FROM chats WHERE instance IS NOT NULL ORDER BY created_at, rowid").all()
    .map((r) => ({ id: r.id, projectId: r.project_id || null, instance: r.instance }));

// The column `job_id` — the scheduled job the chat carries (store/scheduled.js), NULL = none (registration
// "chat-job" in store.js). The unique partial index keeps "one job, one chat" in the database instead of in
// the callers; a chat without a job does not count. Set when the job is created (createChat) and by the
// migration, cleared by deleteScheduledJob; the fork does not take it over.
function initChatJobSchema() {
  try { db.exec("ALTER TABLE chats ADD COLUMN job_id TEXT"); } catch { /* column already exists */ }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_chats_job ON chats(job_id) WHERE job_id IS NOT NULL");
}

function initUpstreamSchema() {
  try { db.exec("ALTER TABLE chats ADD COLUMN upstream_provider TEXT NOT NULL DEFAULT ''"); } catch { /* column already exists */ }
  try { db.exec("ALTER TABLE chats ADD COLUMN upstream_window INTEGER NOT NULL DEFAULT 0"); } catch { /* column already exists */ }
}

// ── Auto-archive ─────────────────────────────────────────────────────────────
// `archive_reason`: who archived — 'user' | 'auto', NULL while active (set by archiveChat/archiveFolder, cleared
// by both restore paths). Existing rows get 'user' in the SAME transaction: until then only the human archived
// (column and backfill in one transaction — db.js columnWithBackfill). `restored_at`: when it last came out of the
// archive (ms, NULL = never) — the auto-archive clock restarts there. No index: the pass reads once per hour,
// measure first. The archive triggers (initArchiveSchema) listen on `archived_at`/`folder_id` and stay as they are.
function initArchiveReasonSchema() {
  columnWithBackfill("chats", "archive_reason", "ALTER TABLE chats ADD COLUMN archive_reason TEXT",
    "UPDATE chats SET archive_reason = 'user' WHERE archived_at IS NOT NULL AND archive_reason IS NULL");
  try { db.exec("ALTER TABLE chats ADD COLUMN restored_at INTEGER"); } catch { /* column already exists */ }
}

// ── The human's own effort choice ────────────────────────────────────────────
// `effort_own`: 1 = the level of this chat is a choice of the human (PATCH /api/chats/:id with a NEW `effort` or
// `ultracode`, chats/routes.js). No server writer sets the marker (run kind, migrations, workflows) — only the
// client path. Existing rows get 0. Its reader, the manager agent run, is gone; the column stays.
function initEffortOwnSchema() {
  try { db.exec("ALTER TABLE chats ADD COLUMN effort_own INTEGER NOT NULL DEFAULT 0"); } catch { /* column already exists */ }
}

// ── Pause the goal ───────────────────────────────────────────────────────────
// `goal_paused`: 1 = the set goal RESTS — it is not in the system prompt (runs/do-run.js), and the target gate
// gives no verdict and does not continue (runs/post-run.js goalGateAfterRun, both read fresh from the row: the run
// may already be running when it is paused). 0 = it works as usual. Set only through PATCH /api/chats/:id
// `goalPaused` (chats/routes.js: a boolean, and only with a non-empty goal) and through the fork, which inherits
// the goal with its pause; taken back by every write of `goal` without the pause (updateChat). Resuming starts
// no run — it takes effect from the next one. Existing rows get 0.
function initTargetPauseSchema() {
  try { db.exec("ALTER TABLE chats ADD COLUMN goal_paused INTEGER NOT NULL DEFAULT 0"); } catch { /* column already exists */ }
}

/**
 * The auto-archive candidates: Coding chats without special role, no child chat of a graph workflow, active, NOT
 * pinned, with at least one message, and their last activity is before `limit` (ms):
 *   max(MAX(messages.created_at), chats.created_at, chats.restored_at) < limit.
 * EVERY role counts (agent, channel, schedule too); `chats.created_at` keeps a fork (old history, new row) and
 * `restored_at` a just restored chat out of the next tick. `updated_at` does NOT count: it rises on rename and
 * pin, and "no new message" is what the setting promises. The kind rule is a prefilter in SQL here; the truth
 * stays in `chats/genus.js`, which the pass asks again per candidate.
 * A chat with a live monitor (e.g. a watch on a WebSocket) stays too — not here but in the pass: a monitor is process state,
 * and the pass asks open work per candidate (runs/archive.js, reason "monitor").
 * Oldest activity first.
 */
const AUTO_ARCHIVE_SQL = `SELECT c.*, MAX(
        (SELECT MAX(m.created_at) FROM messages m WHERE m.chat_id = c.id), c.created_at, COALESCE(c.restored_at, 0)
      ) AS last_activity
    FROM chats c
    WHERE c.kind = 'normal' AND c.specialRole = '' AND c.archived_at IS NULL AND c.pinned = 0
      AND c.id NOT IN (SELECT child_chat_id FROM graph_starts WHERE child_chat_id IS NOT NULL)
      AND EXISTS (SELECT 1 FROM messages m WHERE m.chat_id = c.id)
      AND c.job_id IS NULL
      AND last_activity < ?`;
const limitCheck = (who, limit) => {
  if (!Number.isSafeInteger(limit)) throw new Error(`${who}: limit must be an integer (ms), not ${JSON.stringify(limit)}`);
};
const withActivity = (r) => ({ ...mapChat(r), lastActivity: r.last_activity });
function autoArchiveCandidates(limit) {
  limitCheck("autoArchiveCandidates", limit);
  return db.prepare(`${AUTO_ARCHIVE_SQL}
    ORDER BY last_activity, c.rowid`).all(limit).map(withActivity);
}
/**
 * Is THIS chat still a candidate NOW (the same condition as autoArchiveCandidates, from the same SQL)? The chat or
 * null. The pass (chats/auto-archive.js) works in chunks and yields the event loop in between — in the gap a
 * candidate may have received a message, been pinned, or been archived by hand and restored. Asked right before
 * archiving, with no await in between.
 */
function autoArchiveCandidate(id, limit) {
  limitCheck("autoArchiveCandidate", limit);
  const r = db.prepare(`${AUTO_ARCHIVE_SQL} AND c.id = ?`).get(limit, id);
  return r ? withActivity(r) : null;
}

// The condition of an archive side as an SQL snippet (internal). An unknown value THROWS — the route turns it
// into 400; a silent fallback to "without" would be a list that silently leaves something out.
function archiveSql(archive, alias = "") {
  const column = alias ? `${alias}.archived_at` : "archived_at";
  if (archive === "without") return `${column} IS NULL`;
  if (archive === "only") return `${column} IS NOT NULL`;
  if (archive === "including") return "1 = 1";
  throw new Error(`archive: unknown value ${JSON.stringify(archive)} — allowed are "without", "only", "including"`);
}

// A timestamp is mandatory and a positive integer: `archived_at = NULL` would mean "active", and an UPDATE with
// NULL would still report a changed row.
function archiveTime(at) {
  if (!Number.isSafeInteger(at) || at <= 0) throw new Error(`archive: timestamp must be a positive integer (ms), not ${JSON.stringify(at)}`);
  return at;
}

// Who archives: the human or the auto-archive tick. An unknown reason THROWS — a silent fallback to "user" would
// make a future automatism look like the human's action in the archive.
const ARCHIVE_REASONS_COLUMN = ["user", "auto"];
function archiveReasonCheck(reason) {
  if (!ARCHIVE_REASONS_COLUMN.includes(reason)) throw new Error(`archive: reason must be "user" or "auto", not ${JSON.stringify(reason)}`);
  return reason;
}

/**
 * Archive a chat. `true` only if it was active before — an archived one keeps its old timestamp and its old
 * reason. `reason`: "user" (default, the route) or "auto" (the pass, chats/auto-archive.js).
 */
function archiveChat(id, at = Date.now(), reason = "user") {
  archiveTime(at);
  archiveReasonCheck(reason);
  return db.prepare("UPDATE chats SET archived_at = ?, archive_reason = ? WHERE id = ? AND archived_at IS NULL").run(at, reason, id).changes > 0;
}

/**
 * Restore a chat. `{ changed, folderBack }`: `folderBack` is the folder id if the trigger
 * `chats_active_holt_folder` brought the archived folder back with it, otherwise null. The folder state is read
 * BEFORE the write and confirmed afterwards — the answer says what happened, not what the trigger was supposed to
 * do. An active chat costs one read (the path from doRun).
 * In the same UPDATE the reason falls and `restored_at` = `at` — the auto-archive clock restarts, otherwise the
 * next tick would take it again at once. BOTH restore paths go through here: the route and runs/archive.js
 * fetchBack (doRun).
 */
function fetchChatBack(id, at = Date.now()) {
  archiveTime(at);
  const before = db.prepare(`SELECT c.folder_id AS folderId, f.archived_at AS folderAt FROM chats c
    LEFT JOIN chat_folders f ON f.id = c.folder_id WHERE c.id = ? AND c.archived_at IS NOT NULL`).get(id);
  if (!before) return { changed: false, folderBack: null };
  const changed = db.prepare("UPDATE chats SET archived_at = NULL, archive_reason = NULL, restored_at = ? WHERE id = ? AND archived_at IS NOT NULL").run(at, id).changes > 0;
  const folderBack = changed && before.folderId && before.folderAt != null
    && db.prepare("SELECT archived_at FROM chat_folders WHERE id = ?").get(before.folderId)?.archived_at == null
    ? before.folderId : null;
  return { changed, folderBack };
}

/**
 * The chats of a folder on an archive side, OF WHATEVER KIND. That is exactly the set `archiveFolder` takes into
 * the archive and the trigger `folder_archive_only_without_active` checks — the route's precheck (open work,
 * shells) must run over the SAME set, otherwise a chat of a foreign kind would go into the archive unchecked
 * (`POST /api/chats` does not check the kind of the folder).
 * `listChatsInFolder` stays what it is: the siblings in the kind of the folder, without archive filter.
 */
function chatsInFolder(folderId, { archive = "without" } = {}) {
  return db.prepare(`SELECT * FROM chats WHERE folder_id = ? AND ${archiveSql(archive)} ORDER BY rowid`).all(folderId).map(mapChat);
}

/**
 * Archive a folder with its content, in ONE transaction: first the active chats to `at`, then the folder to `at` —
 * the other way round the trigger `folder_archive_only_without_active` would refuse the folder. Returns the ids
 * of the chats that went into the archive; unknown or already archived folder ⇒ `[]`, nothing changed.
 * ALL chats with this folder_id count, not only those of the folder's kind — the same set the trigger checks.
 * The caller checks open work BEFORE; there is no confirmation here.
 * Only the human archives folders — the chats carry the reason "user".
 */
function archiveFolder(folderId, at = Date.now()) {
  archiveTime(at);
  return inOneTransaction(() => {
    const folder = db.prepare("SELECT archived_at FROM chat_folders WHERE id = ?").get(folderId);
    if (!folder || folder.archived_at != null) return [];
    const ids = db.prepare("SELECT id FROM chats WHERE folder_id = ? AND archived_at IS NULL ORDER BY rowid").all(folderId).map((r) => r.id);
    db.prepare("UPDATE chats SET archived_at = ?, archive_reason = 'user' WHERE folder_id = ? AND archived_at IS NULL").run(at, folderId);
    db.prepare("UPDATE chat_folders SET archived_at = ? WHERE id = ?").run(at, folderId);
    return ids;
  });
}

/**
 * Restore a folder, in ONE transaction. With it come ONLY the chats that went into the archive with it (same
 * timestamp, no new column); a chat archived individually before stays in the archive. Returns the ids of the
 * restored chats; unknown or active folder ⇒ `[]`.
 *
 * THE ORDER IS THE RULE: the timestamp is read into JS BEFORE the first write and compared as a VALUE, never
 * through a subselect on `chat_folders.archived_at`. The trigger `chats_active_holt_folder` sets the folder to
 * NULL already at the FIRST restored chat; that SQLite today collects the rows of an UPDATE before the first
 * write is planner behavior, not a promise. So there is no failing test against the subselect version — only
 * this paragraph.
 * With (3) the reason falls and `restored_at` = `now` — as for the single chat (fetchChatBack).
 */
function fetchFolderBack(folderId, now = Date.now()) {
  archiveTime(now);
  return inOneTransaction(() => {
    // (1) the timestamp of the folder, as a value
    const at = db.prepare("SELECT archived_at FROM chat_folders WHERE id = ?").get(folderId)?.archived_at;
    if (at == null) return [];
    // (2) those that went with it: same timestamp
    const ids = db.prepare("SELECT id FROM chats WHERE folder_id = ? AND archived_at = ? ORDER BY rowid").all(folderId, at).map((r) => r.id);
    // (3) exactly those back — the same value, no subselect
    db.prepare("UPDATE chats SET archived_at = NULL, archive_reason = NULL, restored_at = ? WHERE folder_id = ? AND archived_at = ?").run(now, folderId, at);
    // (4) the folder, even if (3) hit nothing: a folder whose chats all went individually before comes back empty
    db.prepare("UPDATE chat_folders SET archived_at = NULL WHERE id = ?").run(folderId);
    return ids;
  });
}

// ── The sixth effort level is gone ───────────────────────────────────────────
// For a few days a level "ultra" could be stored. It meant something different per provider and has been removed
// from the order (`EFFORT_LEVELS`, workflows.js). A stored legacy value would fall through there as "no level" and
// SILENTLY run with the CLI default. So it becomes `max`.
//
// Two places, two forms:
//   • `chats.effort` is a COLUMN — one UPDATE, on EVERY start. Idempotent (after the first time it hits nothing),
//     and it also catches a row an old release wrote after the migration.
//   • `workflows.run_settings` is JSON — read, PARSED, exactly the field `effort` replaced, rewritten. Never by
//     text pattern: "ultra" may be in a title or a model name and stays there. The word in the text (`instr`) only
//     selects the CANDIDATES; whether to rewrite is decided by the parsed field. In ONE transaction.
// The MARKER (`migration.effort_ultra_max` in app_settings) is set once the JSON migration has rewritten
// something, and keeps every later start from searching again. A store without legacy values gets NONE: nothing
// migrated there, and every start only costs the two prefilters. That is intended — with a marker on every fresh
// store every golden fixture (`fixtures/golden/*/db.json`, which records `app_settings`) would carry one more row.
// Agent definitions have NO effort field — nothing to do there.
const ULTRA_MARKER = "migration.effort_ultra_max";
function ultraGoneInJson(text) {
  const o = parseJson(text, null);
  if (!o || typeof o !== "object" || Array.isArray(o) || o.effort !== "ultra") return null;
  return JSON.stringify({ ...o, effort: "max" });
}
function migrateUltraToMax() {
  const chats = db.prepare("UPDATE chats SET effort = 'max' WHERE effort = 'ultra'").run().changes;
  if (chats) console.log(`[store] effort: ${chats} chat(s) from "ultra" to "max"`);
  if (getSetting(ULTRA_MARKER, "")) return;
  const wfCandidates = db.prepare("SELECT id, run_settings FROM workflows WHERE instr(run_settings, 'ultra') > 0").all();
  if (!wfCandidates.length) return;
  const workflows = inOneTransaction(() => {
    let wf = 0;
    for (const r of wfCandidates) {
      const fresh = ultraGoneInJson(r.run_settings);
      if (fresh !== null) wf += db.prepare("UPDATE workflows SET run_settings = ? WHERE id = ?").run(fresh, r.id).changes;
    }
    if (wf) setSetting(ULTRA_MARKER, `${new Date().toISOString()} · ${wf} Workflow(s)`);
    return wf;
  });
  if (workflows) console.log(`[store] effort: ${workflows} workflow(s) from "ultra" to "max"`);
}

// The chats without a stored level — material of the one-time migration that removed "auto" (`chats/auto-gone.js`).
// Raw: id, provider, model — the migration reads no more; which level results is its decision (it needs the
// provider catalog, which the store does not know).
const RAW_COLUMNS = "id, provider, model";
// Without the kind manager: it is read-only (runs/manager-lock.js).
const chatsWithoutLevel = () =>
  db.prepare(`SELECT ${RAW_COLUMNS} FROM chats WHERE effort = '' AND kind <> 'manager' ORDER BY rowid`).all().map((r) => ({ ...r }));
// Sets the level ONLY if none is stored yet — whatever someone has set since the read wins. `updated_at` stays: a
// migration is not a user change, the chat list does not re-sort. Returns 1 = set.
const setLevelIfEmpty = (id, grad) =>
  db.prepare("UPDATE chats SET effort = ? WHERE id = ? AND effort = ''").run(grad, id).changes;

export { initArchiveSchema, initUpstreamSchema, initChatInstanceSchema, initChatJobSchema, initEffortOwnSchema, initTargetPauseSchema, chatInstance, chatsInInstance, chatInstanceBindings, archiveChat, fetchChatBack, archiveFolder, fetchFolderBack, chatsInFolder, migrateUltraToMax, chatsWithoutLevel, setLevelIfEmpty, chatIdsInProject };

// The fork in one transaction and the chats of a workspace — wrapper, see above.
export { createFork, chatIdsInWorkspace };

// The first user message per chat for overview and search — wrapper, see above.
export { firstUserMessages };

// Auto-archive: schema and candidates — wrapper, see above.
export { initArchiveReasonSchema, autoArchiveCandidates, autoArchiveCandidate };

// The rows observer (see addMessage): connected in server.js.
export { setRowsObserver };

// The role `input` (see listMessages): the look-back of the loop engine and the retry in runs/do-run.js — wrapper.
export { listMessagesWithInputs, deleteInputs };
// The window of the history (chats/log-window.js — the rule is there, the queries here).
export { listMessagesBefore, listMessagesArea, lastLimitUntil, hasMessagesBefore, getMessageRow };
