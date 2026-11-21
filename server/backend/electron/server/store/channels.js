// Channels (chat ↔ chat): CHANNEL_STATUS, initChannelSchema.
// Answers: which channel connects which two chats, and in which status is it.

import { db } from "./db.js";
import { parseJson } from "./_util.js";


// ── Channels ─────────────────────────────────────────────────────────────────
// A channel is a conversation object BETWEEN chats: participants (n:m, currently exactly two), consecutively
// numbered messages, one read cursor per participant. The number per channel (`seq`) is the order — not the
// timestamp: two messages in the same millisecond could otherwise not be sorted, and the cursor needs a number that
// only grows. The status carries the semantics of the delivery:
//   waiting  — proposed, not yet approved (messages are buffered)
//   open     — both sides are woken on new messages
//   paused   — halted by the user (buffered), or at the cap (agents_since_human)
//   closed   — over; sending is an error
//   rejected — the user rejected the proposal; sending is an error
export const CHANNEL_STATUS = Object.freeze(["waiting", "open", "paused", "closed", "rejected"]);
function initChannelSchema() {
  db.exec(`CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open',
    mode TEXT NOT NULL DEFAULT 'free',
    cap INTEGER NOT NULL DEFAULT 8,
    agents_since_human INTEGER NOT NULL DEFAULT 0,
    pause_reason TEXT NOT NULL DEFAULT '',
    creator_chat_id TEXT,
    proposal_item_id INTEGER,
    last_seq INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    closed_at INTEGER NOT NULL DEFAULT 0
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_channels_ws ON channels(workspace_id, status, updated_at)");
  // Read mark of the USER: up to where they have seen the log in the sidebar — something different from the cursor
  // of a participant (which says what has been delivered to the AGENT).
  try { db.exec("ALTER TABLE channels ADD COLUMN read_seq INTEGER NOT NULL DEFAULT 0"); } catch { /* column exists */ }
  db.exec(`CREATE TABLE IF NOT EXISTS channel_participants (
    channel_id TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'chat',
    chat_id TEXT NOT NULL,
    cursor_seq INTEGER NOT NULL DEFAULT 0,
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (channel_id, kind, chat_id)
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_kteil_chat ON channel_participants(chat_id)");
  db.exec(`CREATE TABLE IF NOT EXISTS channel_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    sender_kind TEXT NOT NULL DEFAULT 'chat',
    sender_chat_id TEXT,
    system_kind TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL DEFAULT '',
    files TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    UNIQUE (channel_id, seq)
  )`);
}
const mapChannel = (r) => r && {
  id: r.id, workspaceId: r.workspace_id, name: r.name, status: r.status, mode: r.mode || "free",
  cap: r.cap | 0, agentsSinceHuman: r.agents_since_human | 0, pauseReason: r.pause_reason || "",
  creatorChatId: r.creator_chat_id || null, proposalItemId: r.proposal_item_id == null ? null : (r.proposal_item_id | 0),
  lastSeq: r.last_seq | 0, readSeq: r.read_seq | 0, createdAt: r.created_at, updatedAt: r.updated_at, closedAt: r.closed_at || 0,
};
const mapChannelParticipants = (r) => r && { channelId: r.channel_id, kind: r.kind, chatId: r.chat_id, cursor: r.cursor_seq | 0, joinedAt: r.joined_at };
const mapChannelMessage = (r) => r && {
  id: r.id, channelId: r.channel_id, seq: r.seq | 0,
  sender: { kind: r.sender_kind, chatId: r.sender_chat_id || null },
  systemKind: r.system_kind || "", text: r.text, files: parseJson(r.files, []), createdAt: r.created_at,
};
export function createChannel({ id, workspaceId, name = "", status = "open", mode = "free", cap = 8, creatorChatId = null, proposalItemId = null, createdAt = Date.now() }) {
  db.prepare("INSERT INTO channels (id, workspace_id, name, status, mode, cap, creator_chat_id, proposal_item_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, workspaceId, name, status, mode, cap | 0, creatorChatId, proposalItemId, createdAt, createdAt);
  return getChannel(id);
}
export const getChannel = (id) => mapChannel(db.prepare("SELECT * FROM channels WHERE id = ?").get(id));
export function updateChannel(id, fields = {}) {
  const map = { name: "name", status: "status", cap: "cap", agentsSinceHuman: "agents_since_human", pauseReason: "pause_reason", proposalItemId: "proposal_item_id", closedAt: "closed_at" };
  const sets = []; const vals = [];
  for (const [k, col] of Object.entries(map)) if (k in fields) { sets.push(`${col} = ?`); vals.push(fields[k]); }
  if (!sets.length) return getChannel(id);
  sets.push("updated_at = ?"); vals.push(Date.now());
  vals.push(id);
  db.prepare(`UPDATE channels SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  return getChannel(id);
}
/** Read mark of the user: only moves FORWARD and at most to the end; `updated_at` stays — reading is no movement in
 *  the channel and must not re-sort the list. */
export function setChannelRead(id, seq) {
  db.prepare("UPDATE channels SET read_seq = MAX(read_seq, MIN(?, last_seq)) WHERE id = ?").run(Math.max(0, seq | 0), id);
  return getChannel(id);
}
/** All open channels (across workspaces) — for the delivery pass after a restart. */
export const listOpenChannels = () =>
  db.prepare("SELECT * FROM channels WHERE status = 'open' ORDER BY updated_at ASC").all().map(mapChannel);
export const listChannels = (workspaceId) =>
  db.prepare("SELECT * FROM channels WHERE workspace_id = ? ORDER BY updated_at DESC, created_at DESC").all(workspaceId).map(mapChannel);
/** All channels a chat takes part in (every kind), most recently moved first. */
export const listChannelsOfChat = (chatId) =>
  db.prepare("SELECT k.* FROM channels k JOIN channel_participants t ON t.channel_id = k.id WHERE t.chat_id = ? ORDER BY k.updated_at DESC, k.created_at DESC").all(chatId).map(mapChannel);
export function addChannelParticipants(channelId, { chatId, kind = "chat", joinedAt = Date.now() }) {
  db.prepare("INSERT OR IGNORE INTO channel_participants (channel_id, kind, chat_id, cursor_seq, joined_at) VALUES (?, ?, ?, 0, ?)").run(channelId, kind, chatId, joinedAt);
}
export const listChannelParticipants = (channelId) =>
  db.prepare("SELECT * FROM channel_participants WHERE channel_id = ? ORDER BY joined_at ASC, chat_id ASC").all(channelId).map(mapChannelParticipants);
export const getChannelParticipants = (channelId, chatId) =>
  mapChannelParticipants(db.prepare("SELECT * FROM channel_participants WHERE channel_id = ? AND chat_id = ?").get(channelId, chatId));
/** Advance the cursor of a participant — never back (a late delivery must not make read things unread again). */
export function setChannelCursor(channelId, chatId, seq) {
  db.prepare("UPDATE channel_participants SET cursor_seq = MAX(cursor_seq, ?) WHERE channel_id = ? AND chat_id = ?").run(seq | 0, channelId, chatId);
}
/** Append a message: the number is the next of the channel; `updated_at` of the channel moves along. */
export function addChannelMessage({ channelId, senderKind = "chat", senderChatId = null, systemKind = "", text = "", files = [], createdAt = Date.now() }) {
  const k = db.prepare("SELECT last_seq FROM channels WHERE id = ?").get(channelId);
  if (!k) return null;
  const seq = (k.last_seq | 0) + 1;
  const info = db.prepare("INSERT INTO channel_messages (channel_id, seq, sender_kind, sender_chat_id, system_kind, text, files, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(channelId, seq, senderKind, senderChatId, systemKind, text, JSON.stringify(files || []), createdAt);
  db.prepare("UPDATE channels SET last_seq = ?, updated_at = ? WHERE id = ?").run(seq, createdAt, channelId);
  return getChannelMessage(Number(info.lastInsertRowid));
}
export const getChannelMessage = (id) => mapChannelMessage(db.prepare("SELECT * FROM channel_messages WHERE id = ?").get(id));
export const getChannelMessageBySeq = (channelId, seq) => mapChannelMessage(db.prepare("SELECT * FROM channel_messages WHERE channel_id = ? AND seq = ?").get(channelId, seq | 0));
/** Replace the text of a message — for the first message of a channel, which the user changes when approving. */
export function updateChannelMessageText(id, text) {
  db.prepare("UPDATE channel_messages SET text = ? WHERE id = ?").run(String(text ?? ""), id);
  return getChannelMessage(id);
}
/** Messages of a channel, ascending; `since` = only those with a higher number, `sinceTime` = only those from this
 *  point in time (epoch ms) — both are allowed. */
export const listChannelMessages = (channelId, { since = 0, sinceTime = 0, limit = 500 } = {}) =>
  db.prepare("SELECT * FROM channel_messages WHERE channel_id = ? AND seq > ? AND created_at >= ? ORDER BY seq ASC LIMIT ?")
    .all(channelId, since | 0, Math.max(0, Number(sinceTime) || 0), Math.max(1, limit | 0)).map(mapChannelMessage);
/** Unread of a participant: the ONE way of counting (last number minus cursor) — the numbers are gapless, so this
 *  is the same number as a COUNT over seq > cursor, without a second query. */
export const channelUnreadOf = (channel, cursor) => Math.max(0, (channel?.lastSeq | 0) - (cursor | 0));
export function channelUnread(channelId, chatId) {
  const t = getChannelParticipants(channelId, chatId);
  return t ? channelUnreadOf(getChannel(channelId), t.cursor) : 0;
}
/** Does the history of `chatId` already hold a channel card with this `noteId`? The archive note at the sender
 *  (channels/delivery.js channelArchiveHold) exactly once per channel, target and state — across restarts too; ONE
 *  query, asked only in the hold. */
const channelNoteStands = (chatId, noteId) => Boolean(db.prepare("SELECT 1 FROM messages WHERE chat_id = ? AND role = 'channel' AND instr(text, ?) > 0 LIMIT 1")
  .get(String(chatId), `"noteId":${JSON.stringify(String(noteId))}`));
export function removeChannelParticipants(channelId, chatId) {
  return db.prepare("DELETE FROM channel_participants WHERE channel_id = ? AND chat_id = ?").run(channelId, chatId).changes > 0;
}

export { initChannelSchema, channelNoteStands };
