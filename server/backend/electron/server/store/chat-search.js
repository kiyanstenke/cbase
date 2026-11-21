// The full-text search over chat messages. Read by communication/read.js (view `chats` with a search), caught up by
// communication/search.js. Registration "chat-search" at the end of store.js.
//
// WHAT IS IN THE INDEX: user and answer texts — `messages` with role 'assistant' and role 'user' WITHOUT what stands
// under the role user but was not written by a human. Two paths, one rule (`belongsIn`):
//   - the KIND of the row: a turn whose cause is not in CHAT_SEARCH_CAUSES (event, channel, agent, message, …)
//     carries its message id in `messages_fts_exempt` — written by store/chats.js addMessage (parameter `cause`, set
//     by runs/queue.js) via `exemptChatSearch`. Without it (legacy rows, direct writers) the row counts as human.
//     The kind is deliberately NOT a column on `messages`: the golden imprint reads every column of the data tables,
//     a table `…_fts_…` is exempt (golden-harness.mjs);
//   - the two markers in the text (for legacy rows without a kind): the completion notice of a subagent
//     (`<task-notification>`, runs/completionNotice.js FINISHED_MARKER) and the message of another agent
//     (`<cbase-message`, runs/message-marker.js MESSAGE_MARKER).
// Tool outputs and thinking blocks have their own roles and thus fall out. Guards:
// server/backend/test/communication-chat.test.js binds CHAT_SEARCH_EXEMPT to both markers,
// server/backend/test/communication-search.test.js binds the causes to runs/state.js.
//
// THE SHAPE: an FTS5 table WITHOUT content (`content=''`, `contentless_delete=1`): it holds only the index, no second
// copy of the texts — the search reads the text and the chat via rowid = messages.id. Three triggers: insert, update
// and delete, each only for rows that belong in — a row that never stood in the index (the tool rows, the majority)
// is not touched by the index on delete at all. Deleting a chat (`DELETE FROM messages WHERE chat_id = ?`) thus
// clears its index and the kinds.
//
// THE EXISTING DATA: on the first start with this file all old messages are not yet in the index. The boundary is
// the largest messages.id when the triggers are created (in the SAME transaction): above it the triggers write,
// below it communication/search.js catches up in batches (`chatSearchStack`), ascending, with the marker `until` —
// not blocking at start. Until `until` reaches the boundary the index is incomplete, and the view says so
// (`chatSearchComplete`).
//
// THE VERSION OF THE RULE: `messages_fts_state.rule` carries a hash of the wording of index and triggers
// (`CHAT_SEARCH_RULE`). If it differs at start (or a trigger or the index is missing), everything is recreated in ONE
// transaction: triggers and index gone, new, boundary = largest id, `until` = 0 — the rest is done by the existing
// catch-up. Whoever changes CHAT_SEARCH_EXEMPT, the causes, the tokenization or `belongsIn` thereby migrates
// automatically; there is no rule that would only hold in new databases.
//
// `messages_fts_state` (one row) carries the state; the name deliberately ends in `_fts_…`: the golden imprint of
// the database exempts FTS tables with their shadows (golden-harness.mjs) — their content is a function of the data
// tables, and so is this one. If FTS5 is missing (or `contentless_delete`, SQLite < 3.43), that is in the log, and
// the search falls back to title and first user message (`chatSearchAvailable`).

import crypto from "node:crypto";
import { db, inOneTransaction } from "./db.js";

/** The beginnings of the kinds under the role user that do not belong in the index (legacy rows carry no kind). */
const CHAT_SEARCH_EXEMPT = Object.freeze(["<task-notification>", "<cbase-message"]);
/** The causes of a turn whose user row belongs in the index: the human types (user) or has scheduled it (schedule). */
const CHAT_SEARCH_CAUSES = Object.freeze(["user", "schedule"]);
/** Maximum number of search words — a longer request is not a search but a text; the view says when it truncates. */
const CHAT_SEARCH_WORDS_MAX = 12;

const sqlText = (s) => `'${String(s).replace(/'/g, "''")}'`;
// The condition "belongs in the index" for a row `x` (new or old in the trigger, m in the query).
const belongsIn = (x) => `(${x}.role = 'assistant' OR (${x}.role = 'user' AND ${CHAT_SEARCH_EXEMPT
  .map((m) => `substr(${x}.text, 1, ${m.length}) <> ${sqlText(m)}`).join(" AND ")}
  AND NOT EXISTS (SELECT 1 FROM messages_fts_exempt a WHERE a.id = ${x}.id)))`;

// The wording of index and triggers — its hash is the version of the rule (CHAT_SEARCH_RULE).
const DDL_INDEX = `CREATE VIRTUAL TABLE messages_fts USING fts5(
          text, content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 2'
        )`;
const TRIGGER = Object.freeze(["messages_fts_ai", "messages_fts_ad", "messages_fts_au"]);
const DDL_TRIGGER = `
        CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages WHEN ${belongsIn("new")} BEGIN
          INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
        END;
        CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN
          DELETE FROM messages_fts WHERE rowid = old.id AND ${belongsIn("old")};
          DELETE FROM messages_fts_exempt WHERE id = old.id;
        END;
        CREATE TRIGGER messages_fts_au AFTER UPDATE OF text, role ON messages BEGIN
          DELETE FROM messages_fts WHERE rowid = old.id AND ${belongsIn("old")};
          INSERT INTO messages_fts(rowid, text) SELECT new.id, new.text WHERE ${belongsIn("new")}
            AND (new.id > (SELECT boundary FROM messages_fts_state WHERE id = 1) OR new.id <= (SELECT until FROM messages_fts_state WHERE id = 1));
        END;`;
const CHAT_SEARCH_RULE = crypto.createHash("sha256").update(`${DDL_INDEX}\n${DDL_TRIGGER}`).digest("hex").slice(0, 16);

let available = false;

function initChatSearchSchema() {
  // The kind stands even without FTS5 — it is a datum, not an index (a later start with FTS5 reads it).
  db.exec("CREATE TABLE IF NOT EXISTS messages_fts_exempt (id INTEGER PRIMARY KEY)");
  try {
    inOneTransaction(() => {
      db.exec(`CREATE TABLE IF NOT EXISTS messages_fts_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          boundary INTEGER NOT NULL,
          until INTEGER NOT NULL,
          rule TEXT
        )`);
      if (!db.prepare("PRAGMA table_info(messages_fts_state)").all().some((c) => c.name === "rule")) {
        db.exec("ALTER TABLE messages_fts_state ADD COLUMN rule TEXT");
      }
      const state = db.prepare("SELECT rule FROM messages_fts_state WHERE id = 1").get();
      const trigger = Number(db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name IN (${TRIGGER.map(sqlText).join(", ")})`).get()?.n);
      const index = Number(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'messages_fts'").get()?.n);
      if (state?.rule === CHAT_SEARCH_RULE && trigger === TRIGGER.length && index === 1) return;
      // Recreate — first start, or the rule has changed: triggers and index gone, new; the existing data is caught up.
      // The boundary in the SAME transaction as the triggers: what comes after, they write; what lay before, the catch-up.
      for (const t of TRIGGER) db.exec(`DROP TRIGGER IF EXISTS ${t}`);
      db.exec("DROP TABLE IF EXISTS messages_fts");
      db.exec(DDL_INDEX);
      db.exec(DDL_TRIGGER);
      db.prepare(`INSERT INTO messages_fts_state (id, boundary, until, rule) SELECT 1, COALESCE(MAX(id), 0), 0, ? FROM messages WHERE true
        ON CONFLICT(id) DO UPDATE SET boundary = excluded.boundary, until = 0, rule = excluded.rule`).run(CHAT_SEARCH_RULE);
    });
    available = true;
  } catch (e) {
    available = false;
    console.error("[store] FTS5 for messages not available — the chat search falls back to title and first user message:",
      String(e?.message || e).slice(0, 200));
  }
}

/** Does the user row of a turn with this cause belong in the index? Without a cause yes (legacy rows, direct writers). */
const chatSearchCauseBelongsIn = (cause) => cause === undefined || cause === null || cause === "" || CHAT_SEARCH_CAUSES.includes(cause);

/**
 * The message `id` does not belong in the index (its turn had a cause outside CHAT_SEARCH_CAUSES): remember the kind
 * and remove the entry the insert trigger just wrote. Called by store/chats.js addMessage in the same transaction.
 */
function exemptChatSearch(id) {
  const n = Number(id);
  if (!n) return;
  db.prepare("INSERT OR IGNORE INTO messages_fts_exempt (id) VALUES (?)").run(n);
  if (available) db.prepare("DELETE FROM messages_fts WHERE rowid = ?").run(n);
}

/** Is the full-text search available? */
const chatSearchAvailable = () => available;

/** The state of the catch-up: `{ limit, until }` — complete when `until >= limit`. */
function chatSearchStatus() {
  if (!available) return { limit: 0, until: 0 };
  const r = db.prepare("SELECT boundary, until FROM messages_fts_state WHERE id = 1").get();
  return { limit: Number(r?.boundary) || 0, until: Number(r?.until) || 0 };
}
const chatSearchComplete = () => { const s = chatSearchStatus(); return s.until >= s.limit; };

/**
 * One batch of the catch-up: the next `stack` message ids above `until` (up to the boundary) into the index, `until`
 * forward. Per row first deleted, then inserted — a row the update trigger already wrote thus never stands twice.
 * → `{ finished, until, limit }`.
 */
function chatSearchStack(stack = 500) {
  if (!available) return { finished: true, until: 0, limit: 0 };
  const n = Math.max(1, Math.min(10_000, Math.floor(Number(stack) || 500)));
  const { limit, until } = chatSearchStatus();
  if (until >= limit) return { finished: true, until, limit };
  const ids = db.prepare("SELECT id FROM messages WHERE id > ? AND id <= ? ORDER BY id LIMIT ?").all(until, limit, n).map((r) => r.id);
  const newUntil = ids.length ? ids[ids.length - 1] : limit;
  inOneTransaction(() => {
    if (ids.length) {
      const del = db.prepare("DELETE FROM messages_fts WHERE rowid = ?");
      for (const id of ids) del.run(id);
      db.prepare(`INSERT INTO messages_fts(rowid, text) SELECT m.id, m.text FROM messages m
        WHERE m.id > ? AND m.id <= ? AND ${belongsIn("m")}`).run(until, newUntil);
    }
    db.prepare("UPDATE messages_fts_state SET until = ? WHERE id = 1").run(ids.length < n ? limit : newUntil);
  });
  const s = chatSearchStatus();
  return { finished: s.until >= s.limit, ...s };
}

// The search words of a request: words of two characters or more, each as a phrase with prefix ("word"*), all must
// occur in the SAME message (implicit AND). → `{ words, ignored }` — at most CHAT_SEARCH_WORDS_MAX, `ignored` counts
// what was dropped.
function chatSearchRequest(request) {
  const all = [...new Set(String(request || "").toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) || [])];
  return { words: all.slice(0, CHAT_SEARCH_WORDS_MAX), ignored: Math.max(0, all.length - CHAT_SEARCH_WORDS_MAX) };
}
const chatSearchWords = (request) => chatSearchRequest(request).words;

// The MATCH expression and the chat ids as JSON — or null if there is nothing to search.
function searchParameter(request, chatIds) {
  const words = chatSearchWords(request);
  const ids = Array.isArray(chatIds) ? chatIds.map(String).filter(Boolean) : [];
  if (!available || !words.length || !ids.length) return null;
  return { expression: words.map((w) => `"${w.replace(/"/g, "")}"*`).join(" "), ids: JSON.stringify(ids) };
}

/**
 * Which of the chats `chatIds` (which the caller may read — the data layer checks nothing) match, and how often:
 * `Map<chatId, number of matching messages>`. WITHOUT a cap — this is the membership in the list; no chat with many
 * hits displaces another. Reads only rowid and chat_id, never the text.
 */
function chatSearchChats(request, chatIds) {
  const p = searchParameter(request, chatIds);
  if (!p) return new Map();
  return new Map(db.prepare(`SELECT m.chat_id AS chatId, COUNT(*) AS n
      FROM messages_fts f JOIN messages m ON m.id = f.rowid
     WHERE messages_fts MATCH ? AND m.chat_id IN (SELECT value FROM json_each(?))
     GROUP BY m.chat_id`).all(p.expression, p.ids).map((r) => [r.chatId, Number(r.n) || 0]));
}

/**
 * The best `perChat` hits (1–20, default 3) in EACH of the chats `chatIds`, best first per chat. Sorting only uses
 * id, chat and rank; the query reads the text only for the chosen rows. → `[{ id, chatId, role, text, ts }]`; empty
 * if the search is not available or no word remains.
 */
function chatSearchHits(request, chatIds, { perChat = 3 } = {}) {
  const p = searchParameter(request, chatIds);
  if (!p) return [];
  const n = Math.max(1, Math.min(20, Math.floor(Number(perChat) || 3)));
  return db.prepare(`SELECT m.id AS id, m.chat_id AS chatId, m.role AS role, m.text AS text, m.created_at AS ts
      FROM (SELECT id, chat_id, ROW_NUMBER() OVER (PARTITION BY chat_id ORDER BY rang, id) AS seq
              FROM (SELECT f.rowid AS id, m2.chat_id AS chat_id, bm25(messages_fts) AS rang
                      FROM messages_fts f JOIN messages m2 ON m2.id = f.rowid
                     WHERE messages_fts MATCH ? AND m2.chat_id IN (SELECT value FROM json_each(?)))) x
      JOIN messages m ON m.id = x.id
     WHERE x.seq <= ?
     ORDER BY x.chat_id, x.seq`).all(p.expression, p.ids, n)
    .map((r) => ({ id: r.id, chatId: r.chatId, role: r.role, text: r.text, ts: r.ts }));
}

/** Tests only: put the existing data back to "not caught up" (clear the index of the old rows, boundary = largest id, `until` = 0). */
function chatSearchResetForTest() {
  if (!available) return;
  inOneTransaction(() => {
    const max = Number(db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM messages").get()?.m) || 0;
    const del = db.prepare("DELETE FROM messages_fts WHERE rowid = ?");
    for (const r of db.prepare("SELECT id FROM messages").all()) del.run(r.id);
    db.prepare("UPDATE messages_fts_state SET boundary = ?, until = 0 WHERE id = 1").run(max);
  });
}

export {
  CHAT_SEARCH_CAUSES, CHAT_SEARCH_EXEMPT, CHAT_SEARCH_RULE, CHAT_SEARCH_WORDS_MAX, chatSearchRequest, chatSearchCauseBelongsIn,
  exemptChatSearch, chatSearchChats, chatSearchStatus, chatSearchStack, chatSearchHits, chatSearchAvailable, chatSearchComplete,
  chatSearchWords, chatSearchResetForTest, initChatSearchSchema,
};
