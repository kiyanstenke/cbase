// The state of the Ultracode reminders per chat. Written and read by dynworkflows/reminder.js.
//
// `ultracode_reminder`: one row per chat that ever got a reminder — `reported` is the mode the model was last told
// (1 = "on" via the full or the short reminder, 0 = the off notice), `turns` the number of user turns since the last
// "on" reminder (the turn of the full one counts as 0). A chat without a row never got one (like "reported 0"). A
// SEPARATE table instead of two columns on `chats`: a chat that never carried Ultracode leaves nothing behind — not
// in the golden fixtures either, which record every non-empty table. The row is deleted with the chat (hook
// "chatClosed", dynworkflows/reminder.js). Registration "ultracode-reminder" in store.js.
import { db } from "./db.js";

function initUltracodeReminderSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ultracode_reminder (
      chat_id TEXT PRIMARY KEY,
      reported INTEGER NOT NULL DEFAULT 0,
      turns INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
  `);
}

/** The state of a chat: `{ reported: 0|1, turns }` — without a row `{ reported: 0, turns: 0 }`. */
function readUltracodeReminder(chatId) {
  const r = db.prepare("SELECT reported, turns FROM ultracode_reminder WHERE chat_id = ?").get(String(chatId));
  return { reported: r?.reported ? 1 : 0, turns: Number(r?.turns) || 0 };
}

function setUltracodeReminder(chatId, { reported, turns }) {
  db.prepare(`INSERT INTO ultracode_reminder (chat_id, reported, turns, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET reported = excluded.reported, turns = excluded.turns, updated_at = excluded.updated_at`)
    .run(String(chatId), reported ? 1 : 0, Math.max(0, Math.floor(Number(turns) || 0)), Date.now());
}

function deleteUltracodeReminder(chatId) {
  db.prepare("DELETE FROM ultracode_reminder WHERE chat_id = ?").run(String(chatId));
}

export { initUltracodeReminderSchema, readUltracodeReminder, setUltracodeReminder, deleteUltracodeReminder };
