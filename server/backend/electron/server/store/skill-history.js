// History, trash and deletion requests of the skills. The data layer — what a mutation may do and in which order it
// writes is computed by the ONE mutation path `toolchain/skill-change.js`; here are only the shape of the data and
// the conditions no route can bypass:
//   · `skill_history` holds EVERY change (human and agent, UI and tool) with the state before and after; the row
//     stays after the skill is deleted (no foreign key). An undo happens exactly once — the condition is in the
//     UPDATE (`reverted_at IS NULL`), not in a value read beforehand.
//   · `skill_deletion_requests`: an agent never deletes itself, it requests. The request hangs on skill AND version;
//     it is decided exactly once as well (`status = 'open'` in the UPDATE).
//   · The switch per workspace is in `app_settings` under `skills.agents_write.<workspaceId>`: if it is missing,
//     "on" applies — only an explicit "off" turns it off (empty here explicitly means the default).
//   · The trash of the resources: `<data>/skill-trash/<historyId>/` — next to `<data>/skill-resources`; the path is
//     in store/toolchain.js (`skillTrashDir`), because the delete paths of workspace and project clear it too.
//   · A second request for the same skill is merged — its chat then stands in `additional_chats` (JSON list
//     `[{id, title}]`) and learns the decision just like the first.
// Registration "skill-history" in store.js.
import { db, inOneTransaction } from "./db.js";
import { getSetting, setSetting } from "./workspaces.js";

const SKILL_HISTORY_KINDS = Object.freeze(["create", "change", "erase"]);
const SKILL_REQUEST_STATUS = Object.freeze(["open", "approved", "rejected", "expired"]);

function initSkillHistorySchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS skill_history (
      id TEXT PRIMARY KEY,
      skill_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      project_id TEXT,
      kind TEXT NOT NULL CHECK (kind IN ('create', 'change', 'erase')),
      who TEXT NOT NULL CHECK (who IN ('human', 'agent')),
      chat_id TEXT,
      chat_title TEXT,
      prior TEXT,
      after TEXT,
      trash INTEGER NOT NULL DEFAULT 0,
      request_id TEXT,
      at INTEGER NOT NULL,
      reverted_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_skill_history_skill ON skill_history(skill_id, at);
    CREATE INDEX IF NOT EXISTS idx_skill_history_ws ON skill_history(workspace_id, at);
    CREATE TABLE IF NOT EXISTS skill_deletion_requests (
      id TEXT PRIMARY KEY,
      skill_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      project_id TEXT,
      version TEXT NOT NULL,
      skill_name TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      chat_title TEXT,
      reason TEXT,
      additional_chats TEXT,
      status TEXT NOT NULL CHECK (status IN ('open', 'approved', 'rejected', 'expired')),
      at INTEGER NOT NULL,
      decided_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_skill_requests_skill ON skill_deletion_requests(skill_id, status);
    CREATE INDEX IF NOT EXISTS idx_skill_requests_ws ON skill_deletion_requests(workspace_id, status, at);
  `);
}

const json = (v) => (v == null ? null : JSON.stringify(v));
const fromJson = (s) => {
  if (s == null) return null;
  try { return JSON.parse(s); } catch { return null; }
};

const mapEntry = (r) => r && {
  id: r.id, skillId: r.skill_id, workspaceId: r.workspace_id, projectId: r.project_id || null,
  kind: r.kind, who: r.who, chatId: r.chat_id || null, chatTitle: r.chat_title ?? null,
  prior: fromJson(r.prior), after: fromJson(r.after), trash: Boolean(r.trash),
  requestId: r.request_id || null, at: r.at, revertedAt: r.reverted_at ?? null,
};
const mapRequest = (r) => r && {
  id: r.id, skillId: r.skill_id, workspaceId: r.workspace_id, projectId: r.project_id || null, version: r.version,
  skillName: r.skill_name, chatId: r.chat_id, chatTitle: r.chat_title ?? null, reason: r.reason ?? null,
  additionalChats: Array.isArray(fromJson(r.additional_chats)) ? fromJson(r.additional_chats) : [],
  status: r.status, at: r.at, decidedAt: r.decided_at ?? null,
};

/** A history entry (within the transaction of the mutation path). `prior`/`after` are states (object) or null. */
function createSkillHistory({ id, skillId, workspaceId, projectId = null, kind, who, chatId = null, chatTitle = null, prior = null, after = null, trash = false, requestId = null, at = Date.now() }) {
  if (!SKILL_HISTORY_KINDS.includes(kind)) throw new Error(`createSkillHistory: unknown kind "${kind}"`);
  db.prepare(`INSERT INTO skill_history (id, skill_id, workspace_id, project_id, kind, who, chat_id, chat_title, prior, after, trash, request_id, at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, skillId, workspaceId, projectId, kind, who, chatId, chatTitle, json(prior), json(after), trash ? 1 : 0, requestId, at);
  return skillHistoryEntry(id);
}
const skillHistoryEntry = (id) => mapEntry(db.prepare("SELECT * FROM skill_history WHERE id = ?").get(String(id)));
/** The entries of a workspace (optionally of one skill), newest first — capped (`limit`, 1–500). */
function skillHistoryList(workspaceId, { skillId = "", limit = 50 } = {}) {
  const n = Math.min(500, Math.max(1, Number(limit) || 50));
  const rows = skillId
    ? db.prepare("SELECT * FROM skill_history WHERE workspace_id = ? AND skill_id = ? ORDER BY at DESC, rowid DESC LIMIT ?").all(workspaceId, skillId, n)
    : db.prepare("SELECT * FROM skill_history WHERE workspace_id = ? ORDER BY at DESC, rowid DESC LIMIT ?").all(workspaceId, n);
  return rows.map(mapEntry);
}
/** "Recently deleted": delete entries, not reverted, whose skill (id) is missing — newest first. */
const skillDeletedEntries = (workspaceId, limit = 100) =>
  db.prepare(`SELECT v.* FROM skill_history v WHERE v.workspace_id = ? AND v.kind = 'erase' AND v.reverted_at IS NULL
              AND NOT EXISTS (SELECT 1 FROM skills s WHERE s.id = v.skill_id) ORDER BY v.at DESC, v.rowid DESC LIMIT ?`).all(workspaceId, limit).map(mapEntry);
/** Exactly once: true only for the call that sets the marker. */
const revertSkillHistory = (id, at = Date.now()) =>
  db.prepare("UPDATE skill_history SET reverted_at = ? WHERE id = ? AND reverted_at IS NULL").run(at, id).changes === 1;
const skillHistoryTrash = (id, trash) =>
  db.prepare("UPDATE skill_history SET trash = ? WHERE id = ?").run(trash ? 1 : 0, id);
/**
 * Per EXISTING skill of the workspace the most recent entry NOT reverted — only `{ who, chatId, chatTitle, at }`
 * (for the last change on the lists and the marker in the catalog). Without the states: every list and every turn
 * reads this, and `prior`/`after` carry whole instructions.
 */
function lastSkillChanges(workspaceId) {
  const out = new Map();
  const rows = db.prepare(`SELECT skill_id, who, chat_id, chat_title, at FROM skill_history
                           WHERE workspace_id = ? AND reverted_at IS NULL AND skill_id IN (SELECT id FROM skills WHERE workspace_id = ?)
                           ORDER BY at DESC, rowid DESC`).all(workspaceId, workspaceId);
  for (const r of rows) {
    if (!out.has(r.skill_id)) out.set(r.skill_id, { who: r.who, chatId: r.chat_id || null, chatTitle: r.chat_title ?? null, at: r.at });
  }
  return out;
}

// ── Deletion requests ───────────────────────────────────────────────────────────────────────────────────────
function createSkillRequest({ id, skillId, workspaceId, projectId = null, version, skillName, chatId, chatTitle = null, reason = null, at = Date.now() }) {
  db.prepare(`INSERT INTO skill_deletion_requests (id, skill_id, workspace_id, project_id, version, skill_name, chat_id, chat_title, reason, status, at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`).run(id, skillId, workspaceId, projectId, version, skillName, chatId, chatTitle, reason, at);
  return skillRequest(id);
}
const skillRequest = (id) => mapRequest(db.prepare("SELECT * FROM skill_deletion_requests WHERE id = ?").get(String(id)));
/** Merge: the chat of a second request learns the decision as well — once per chat, never that of the first. */
function skillRequestChatAdd(id, chatId, chatTitle = null) {
  const a = skillRequest(id);
  if (!a || a.status !== "open" || !chatId || a.chatId === chatId || a.additionalChats.some((c) => c.id === chatId)) return a;
  db.prepare("UPDATE skill_deletion_requests SET additional_chats = ? WHERE id = ? AND status = 'open'")
    .run(JSON.stringify([...a.additionalChats, { id: chatId, title: chatTitle ?? null }]), id);
  return skillRequest(id);
}
const openSkillRequest = (skillId) =>
  mapRequest(db.prepare("SELECT * FROM skill_deletion_requests WHERE skill_id = ? AND status = 'open' ORDER BY at, rowid LIMIT 1").get(skillId));
/** The requests of a workspace, newest first; `status` (one of the four) filters, empty = all. */
function skillRequestsList(workspaceId, status = "") {
  const rows = status
    ? db.prepare("SELECT * FROM skill_deletion_requests WHERE workspace_id = ? AND status = ? ORDER BY at DESC, rowid DESC LIMIT 200").all(workspaceId, status)
    : db.prepare("SELECT * FROM skill_deletion_requests WHERE workspace_id = ? ORDER BY at DESC, rowid DESC LIMIT 200").all(workspaceId);
  return rows.map(mapRequest);
}
/** Per skill of the workspace the open request. */
function openSkillRequests(workspaceId) {
  const out = new Map();
  for (const r of db.prepare("SELECT * FROM skill_deletion_requests WHERE workspace_id = ? AND status = 'open' ORDER BY at, rowid").all(workspaceId)) {
    if (!out.has(r.skill_id)) out.set(r.skill_id, mapRequest(r));
  }
  return out;
}
/**
 * Let open requests of a skill expire — those whose version is not (or no longer) `version` (`version` null ⇒ all),
 * without the one given as `except`. Returns the expired requests (for the hints to their chats).
 */
function expireSkillRequests(skillId, { version = null, except = "", at = Date.now() } = {}) {
  const rows = db.prepare(`UPDATE skill_deletion_requests SET status = 'expired', decided_at = ?
                           WHERE skill_id = ? AND status = 'open' AND id <> ? AND (? IS NULL OR version <> ?) RETURNING *`)
    .all(at, skillId, String(except || ""), version, version);
  return rows.map(mapRequest);
}
/** Exactly once: sets `status` only on an open request; true only for the call that decided. */
function decideSkillRequest(id, status, at = Date.now()) {
  if (!SKILL_REQUEST_STATUS.includes(status) || status === "open") throw new Error(`decideSkillRequest: unknown status "${status}"`);
  return db.prepare("UPDATE skill_deletion_requests SET status = ?, decided_at = ? WHERE id = ? AND status = 'open'").run(status, at, id).changes === 1;
}

// ── Switch ──────────────────────────────────────────────────────────────────────────────────────────────────
const toggleKey = (workspaceId) => `skills.agents_write.${workspaceId}`;
/** May the Coding main agents of this workspace write skills? If the value is missing, "on" applies. */
const skillAgentsWrite = (workspaceId) => getSetting(toggleKey(workspaceId), "on") !== "off";
function setSkillAgentsWrite(workspaceId, enabled) {
  setSetting(toggleKey(workspaceId), enabled ? "on" : "off");
  return skillAgentsWrite(workspaceId);
}

/** One transaction for the mutation path (skill + history entry + expired requests together or not at all). Synchronous only. */
const skillTransaction = (fn) => inOneTransaction(fn);

export {
  initSkillHistorySchema, SKILL_HISTORY_KINDS, SKILL_REQUEST_STATUS,
  createSkillHistory, skillHistoryEntry, skillHistoryList, skillDeletedEntries, revertSkillHistory, skillHistoryTrash,
  lastSkillChanges,
  createSkillRequest, skillRequest, skillRequestChatAdd, openSkillRequest, skillRequestsList, openSkillRequests, expireSkillRequests, decideSkillRequest,
  skillAgentsWrite, setSkillAgentsWrite, skillTransaction,
};
