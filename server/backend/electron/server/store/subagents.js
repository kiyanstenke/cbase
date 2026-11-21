// The stock of subagents.
//
// A subagent lives in the memory of its core (providers/agent-runtime.js, owner runs/agents.js). What a later
// continuation via cbase_agent_send needs stands HERE — so that it still works after a forced restart (crash, swap
// with --force) and after the idle cleanup of a core: provider, model, session (Claude session, Codex thread,
// engine run), state, plus the origin of the agent as JSON (`data`) and its history (`subagent_history`, one row
// per entry — the loop engine has no real resume, its history IS the session).
//
// States: `running` (also: starting) · `parked` (at the usage limit) · `finished` (the report stands; also failed
// and stopped — `data.status` and `data.stoppedOf` say how) · `orphaned` (was running when the server ended; set by
// the restart hook in runs/agents.js, never reported twice).
//
// Plus the deferred verdicts: if a turn ends while background work is open, compaction, goal gate and "end" do not
// judge yet (runs/do-run.js). What they need stands here — ONE row per chat, taken exactly once (takeVerdict): by
// the transition "background work empty, no turn" or after a restart with orphans; discarded as soon as a turn
// begins (its end judges then).
//
// No foreign keys on `chats`: deletion goes through the ONE closing path (chats/erase.js tidyUp) — a cascade here
// would make it uncheckable (deleted past the closing path ⇒ the rows stay, and exactly that is the guard).
// Registration "subagents" in store.js.
import { db } from "./db.js";

function initSubagentsSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS subagents (
      chat_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      session TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      data TEXT NOT NULL DEFAULT '{}',
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (chat_id, agent_id)
    );
    CREATE INDEX IF NOT EXISTS subagents_state ON subagents(state);
    CREATE TABLE IF NOT EXISTS subagent_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS subagent_history_agent ON subagent_history(chat_id, agent_id, id);
    CREATE TABLE IF NOT EXISTS deferred_verdicts (
      chat_id TEXT PRIMARY KEY,
      data TEXT NOT NULL DEFAULT '{}',
      at INTEGER NOT NULL
    );
  `);
  // The PREVIOUS sessions — see "The sessions on final deletion" at the end of the file. Here because the triggers
  // name both tables (`chats` is created by db.js, `subagents` stands just above) — and without a registration of
  // their own: the same schema "subagents".
  db.exec(`
    CREATE TABLE IF NOT EXISTS previous_sessions (
      chat_id TEXT NOT NULL,
      agent_id TEXT NOT NULL DEFAULT '',
      sid TEXT NOT NULL,
      PRIMARY KEY (chat_id, agent_id, sid)
    );
    CREATE TRIGGER IF NOT EXISTS chats_previous_session AFTER UPDATE OF claude_session_id ON chats
    WHEN OLD.claude_session_id IS NOT NULL AND OLD.claude_session_id <> '' AND NEW.claude_session_id IS NOT OLD.claude_session_id
    BEGIN INSERT OR IGNORE INTO previous_sessions (chat_id, agent_id, sid) VALUES (OLD.id, '', OLD.claude_session_id); END;
    CREATE TRIGGER IF NOT EXISTS subagents_previous_session AFTER UPDATE OF session ON subagents
    WHEN OLD.session IS NOT NULL AND OLD.session <> '' AND NEW.session IS NOT OLD.session
    BEGIN INSERT OR IGNORE INTO previous_sessions (chat_id, agent_id, sid) VALUES (OLD.chat_id, OLD.agent_id, OLD.session); END;
  `);
  initSubagentBookedColumn();
}

// `booked_until`: until when (ms) the consumption of this agent is booked — set with EVERY booking (runs/agents.js
// bookConsumption). If the process dies in the middle of its turn, the restart books the rest from its session file
// afterwards (runs/lateBooking.js), from this state. 0 = never booked (then from its start). PRAGMA-checked ADD
// COLUMN in the same registration "subagents"; `rememberSubagent` never writes it (ON CONFLICT does not name it) —
// the state belongs to the booking, not to the image.
function initSubagentBookedColumn() {
  const have = new Set(db.prepare("PRAGMA table_info(subagents)").all().map((c) => c.name));
  if (!have.has("booked_until")) db.exec("ALTER TABLE subagents ADD COLUMN booked_until INTEGER NOT NULL DEFAULT 0");
}

/** Set the booking state of a subagent (forward only). Returns whether the row carries it. */
const subagentBooked = (chatId, agentId, untilMs) =>
  db.prepare("UPDATE subagents SET booked_until = MAX(booked_until, ?) WHERE chat_id = ? AND agent_id = ?")
    .run(Math.max(0, Math.round(Number(untilMs) || 0)), String(chatId), String(agentId)).changes > 0;

const STATES = new Set(["running", "parked", "finished", "orphaned"]);

/** Store the state of a subagent (new or overwrite). `image` from agent-runtime.js (pasteboardImage). */
function rememberSubagent(chatId, image, { at = Date.now() } = {}) {
  const state = String(image?.state || "");
  if (!STATES.has(state)) throw new Error(`rememberSubagent: unknown state "${state}"`);
  const { agentId, provider = "", model = "", sessionId = "", name = "", ...data } = image;
  delete data.state;
  db.prepare(`INSERT INTO subagents (chat_id, agent_id, provider, model, session, state, name, data, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (chat_id, agent_id) DO UPDATE SET provider = excluded.provider, model = excluded.model,
      session = excluded.session, state = excluded.state, name = excluded.name, data = excluded.data,
      updated_at = excluded.updated_at`)
    .run(String(chatId), String(agentId), String(provider || ""), String(model || ""), String(sessionId || ""), state,
      String(name || ""), JSON.stringify(data), at);
}

/** Append a row to the history of a subagent ({ role, text }). */
function subagentRow(chatId, agentId, row) {
  db.prepare("INSERT INTO subagent_history (chat_id, agent_id, role, text) VALUES (?, ?, ?, ?)")
    .run(String(chatId), String(agentId), String(row?.role || ""), String(row?.text ?? ""));
}

const asImage = (r) => {
  if (!r) return null;
  let data = {};
  try { data = JSON.parse(r.data || "{}"); } catch { /* a broken row is one without origin */ }
  return { ...data, agentId: r.agent_id, provider: r.provider, model: r.model, sessionId: r.session, name: r.name, state: r.state, chatId: r.chat_id,
    bookedUntil: Number(r.booked_until) || 0 };
};

/**
 * A subagent of a chat like readSubagent, but WITHOUT history: for questions about id, name, parent, state or
 * instance (runs/agents.js) — those ran on every send/output/stop and read along the whole transcript, which a
 * polling cbase_agent_output discarded again at once.
 * @returns {null | Object}
 */
function subagentHeader(chatId, idOrName) {
  const key = String(idOrName || "").trim();
  if (!key) return null;
  const r = db.prepare("SELECT * FROM subagents WHERE chat_id = ? AND agent_id = ?").get(String(chatId), key)
    || db.prepare("SELECT * FROM subagents WHERE chat_id = ? AND name = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1").get(String(chatId), key);
  return asImage(r);
}

/**
 * A subagent of a chat — via its id or (like find() in the core) its name, most recent first. With history.
 * @returns {null | Object}
 */
function readSubagent(chatId, idOrName) {
  const image = subagentHeader(chatId, idOrName);
  if (!image) return null;
  image.rows = db.prepare("SELECT role AS role, text FROM subagent_history WHERE chat_id = ? AND agent_id = ? ORDER BY id")
    .all(String(chatId), image.agentId).map((z) => ({ role: z.role, text: z.text }));
  return image;
}

/** All subagents still kept as running or parked — across all chats (restart). */
const runningSubagents = () =>
  db.prepare("SELECT * FROM subagents WHERE state IN ('running', 'parked') ORDER BY rowid").all().map(asImage);

/** Mark one still kept as running as orphaned. Returns whether it was (never twice). */
const orphanSubagent = (chatId, agentId, { at = Date.now() } = {}) =>
  db.prepare("UPDATE subagents SET state = 'orphaned', updated_at = ? WHERE chat_id = ? AND agent_id = ? AND state IN ('running', 'parked')")
    .run(at, String(chatId), String(agentId)).changes > 0;

/** The subagents of a chat (without history), oldest first — for guards and information. */
const subagentsOf = (chatId) =>
  db.prepare("SELECT * FROM subagents WHERE chat_id = ? ORDER BY rowid").all(String(chatId)).map(asImage);

/** The subagents for agent ids, across all chats (without history), oldest first — for the git overview: a branch
 *  `cbase/agent-<id>` only names the id, not the chat. Empty list ⇒ empty. */
function subagentsWithIds(agentIds) {
  const ids = [...new Set((agentIds || []).map(String).filter(Boolean))];
  if (!ids.length) return [];
  return db.prepare(`SELECT * FROM subagents WHERE agent_id IN (${ids.map(() => "?").join(", ")}) ORDER BY rowid`).all(...ids).map(asImage);
}

/** Remove everything of a chat — called by the closing path (chats/erase.js), by nobody else. */
function deleteSubagents(chatId) {
  const n = db.prepare("DELETE FROM subagents WHERE chat_id = ?").run(String(chatId)).changes;
  db.prepare("DELETE FROM subagent_history WHERE chat_id = ?").run(String(chatId));
  db.prepare("DELETE FROM deferred_verdicts WHERE chat_id = ?").run(String(chatId));
  return n;
}

/** Store a deferred verdict (a later one replaces an earlier one — it belongs to the more recent turn). */
function deferVerdict(chatId, data, { at = Date.now() } = {}) {
  db.prepare(`INSERT INTO deferred_verdicts (chat_id, data, at) VALUES (?, ?, ?)
    ON CONFLICT (chat_id) DO UPDATE SET data = excluded.data, at = excluded.at`).run(String(chatId), JSON.stringify(data || {}), at);
}

/** TAKE the deferred verdict of a chat — read and deleted in one transaction; null if none is pending. */
function takeVerdict(chatId) {
  const r = db.prepare("DELETE FROM deferred_verdicts WHERE chat_id = ? RETURNING data").get(String(chatId));
  if (!r) return null;
  try { return JSON.parse(r.data || "{}"); } catch { return {}; }
}

/** A turn begins: its end judges — the deferred one lapses. Returns whether one was pending. */
const dismissVerdict = (chatId) => db.prepare("DELETE FROM deferred_verdicts WHERE chat_id = ?").run(String(chatId)).changes > 0;

/** Is a verdict pending for this chat? (Guard, restart.) */
const verdictStands = (chatId) => Boolean(db.prepare("SELECT 1 FROM deferred_verdicts WHERE chat_id = ?").get(String(chatId)));

export { initSubagentsSchema, subagentBooked, rememberSubagent, subagentRow, readSubagent, subagentHeader, runningSubagents, orphanSubagent, subagentsOf, subagentsWithIds, deleteSubagents, deferVerdict, takeVerdict, dismissVerdict, verdictStands };

// ── The relocation (projectbox/relocation/data.js) ────────────────────────────────────────────────────────────────────
// It moves worktrees into the runtime folder of the project and rewrites `cwd`/`worktree` (and `instance`) in the
// image of the affected subagents — and on the return path back to the old values.

/** Working folder and worktree of every subagent that carries one of the two: `[{ chatId, agentId, cwd, worktreeDir }]`. */
function subagentsLocations() {
  // Plus `worktreeRepo` (the place from which a continuation creates a fresh worktree) — a subagent without cwd and
  // without worktree but with this field counts too (the layout carries it along).
  return db.prepare(`SELECT chat_id, agent_id, json_extract(data, '$.cwd') AS cwd, json_extract(data, '$.worktree.dir') AS wt,
    json_extract(data, '$.worktreeRepo') AS wr FROM subagents ORDER BY rowid`).all()
    .filter((r) => typeof r.cwd === "string" || typeof r.wt === "string" || typeof r.wr === "string")
    .map((r) => ({ chatId: r.chat_id, agentId: r.agent_id, cwd: typeof r.cwd === "string" ? r.cwd : null, worktreeDir: typeof r.wt === "string" ? r.wt : null }));
}

/** Fields from the image of a subagent: `{ cwd, worktree, instance, worktreeRepo }` each with a flag whether the key
 *  stood in the image (`hasCwd`, `hasWorktree`, `hasInstance`, `hasWorktreeRepo` — the return path of the relocation
 *  makes the image byte-equal with them) — null without a (readable) row. */
function readSubagentLocation(chatId, agentId) {
  const r = db.prepare("SELECT data FROM subagents WHERE chat_id = ? AND agent_id = ?").get(String(chatId), String(agentId));
  if (!r) return null;
  let d;
  try { d = JSON.parse(r.data || "{}"); } catch { return null; }
  return {
    cwd: d.cwd ?? null, worktree: d.worktree ?? null, hasCwd: Object.hasOwn(d, "cwd"), hasWorktree: Object.hasOwn(d, "worktree"),
    hasInstance: Object.hasOwn(d, "instance"), instance: d.instance ?? null,
    worktreeRepo: d.worktreeRepo ?? null, hasWorktreeRepo: Object.hasOwn(d, "worktreeRepo"), // for the layout
  };
}

/**
 * Set fields in the image of a subagent (`undefined` removes the field): the others keep their order, an existing
 * field its place, a new one stands at the end — that is how the return path makes the image byte-equal again.
 * `updated_at` stays. Returns whether the row existed.
 */
function setSubagentFields(chatId, agentId, fields = {}) {
  const r = db.prepare("SELECT data FROM subagents WHERE chat_id = ? AND agent_id = ?").get(String(chatId), String(agentId));
  if (!r) return false;
  const d = JSON.parse(r.data || "{}");
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) delete d[k];
    else d[k] = v;
  }
  db.prepare("UPDATE subagents SET data = ? WHERE chat_id = ? AND agent_id = ?").run(JSON.stringify(d), String(chatId), String(agentId));
  return true;
}

export { setSubagentFields, readSubagentLocation, subagentsLocations };

// ── The sessions on final deletion (chats/sessions.js) ───────────────────────────────────────────────────────────────
// Exactly two columns CARRY a CLI session: `chats.claude_session_id` (Claude session or Codex thread of the chat)
// and `subagents.session`. Both questions stand HERE, next to the stock of subagents — ONE place knows who carries a
// session.
//
// Plus the PREVIOUS ones: both columns are overwritten in the ordinary course — `/clear`, `/compact` and the
// autocompact, the provider switch of a chat, the switch or deletion of the global provider
// (clearGlobalProviderChatSessions/clearSessionsForProvider), a lost session, a fork after its first run, for a
// subagent a restart without resume. The transcript from before stays in the CLI homes, with the whole history
// before the cut — readable for every process in the project container after the chat is deleted. Hence
// `previous_sessions` holds every id a chat (`agent_id` '') or one of its subagents ever carried and no longer
// carries. Written at ONE place per column: two triggers (initSubagentsSchema) — every write path, a future one and
// a raw UPDATE too, goes through them. Deleted ONLY by the closing path (chats/erase.js tidyUp, like the stock — no
// cascade, see head). Legacy: an id that was overwritten BEFORE the server started with table and triggers stands
// nowhere and cannot be restored — its transcript stays.
// `sessionCarried` only asks the CARRYING columns: an id somebody only keeps as a previous one is needed by nobody.

/**
 * The sessions of every chat: `Map<chatId, sid[]>` — the carried one first, then the previous ones (oldest first).
 * Read BEFORE the rows are deleted (the workspace path only learns its chats from the report of the store). `ids`
 * null ⇒ all chats, otherwise only these. The previous sessions of its subagents come from
 * `previousSubagentSessions`.
 */
function chatSessions(ids = null) {
  const list = ids === null ? null : [...new Set((ids || []).map(String))];
  if (list && !list.length) return new Map();
  const only = (column) => (list ? ` AND ${column} IN (${list.map(() => "?").join(", ")})` : "");
  const out = new Map();
  const take = (id, sid) => {
    const k = String(id), s = String(sid);
    if (!out.has(k)) out.set(k, []);
    if (!out.get(k).includes(s)) out.get(k).push(s);
  };
  for (const r of db.prepare(`SELECT id, claude_session_id AS sid FROM chats WHERE claude_session_id IS NOT NULL AND claude_session_id <> ''${only("id")}`).all(...(list || []))) take(r.id, r.sid);
  for (const r of db.prepare(`SELECT chat_id AS id, sid FROM previous_sessions WHERE agent_id = ''${only("chat_id")} ORDER BY rowid`).all(...(list || []))) take(r.id, r.sid);
  return out;
}

/** The previous sessions of the subagents of a chat: `[{ agentId, sid }]`, oldest first — BEFORE `deletePreviousSessions`. */
const previousSubagentSessions = (chatId) =>
  db.prepare("SELECT agent_id AS agentId, sid FROM previous_sessions WHERE chat_id = ? AND agent_id <> '' ORDER BY rowid")
    .all(String(chatId)).map((r) => ({ agentId: String(r.agentId), sid: String(r.sid) }));

/** Remove the previous sessions of a chat and its subagents — called by the closing path (chats/erase.js), by nobody else. */
const deletePreviousSessions = (chatId) =>
  db.prepare("DELETE FROM previous_sessions WHERE chat_id = ?").run(String(chatId)).changes;

/** Does a chat or a subagent still carry this session? (the fork exception — a fork inherits the session of its original) */
const sessionCarried = (sid) => Boolean(String(sid || "") && db.prepare(
  "SELECT 1 FROM chats WHERE claude_session_id = ? UNION ALL SELECT 1 FROM subagents WHERE session = ? LIMIT 1",
).get(String(sid), String(sid)));

export { chatSessions, previousSubagentSessions, deletePreviousSessions, sessionCarried };
