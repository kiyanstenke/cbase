// Runs (a run = one turn of a chat): active runs, rows waiting at the limit (pendingRow), queue.
// Answers: which chat is waiting for what, and what is in the queue.

import { TS } from "./_util.js";
import { db } from "./db.js";


// ── Active runs (crash persistence + auto-resume) ────────────────────────────
// The column `todos` (active_runs like pending_resumes) is legacy: the DDL stays (store/db.js), it is no longer
// written or read — new rows carry the default 0, old ones are not evaluated.
// `announcements`: the announcements of the inputs the run began with (runs/human-input.js announcementsFrom) — so
// that the resume after a restart carries them again (runs/resume.js). Stored as a JSON list, an empty list as ''.
// The shape is checked by the reader in runs/, not by this layer (store/ is domain-free).
export function setActiveRun(chatId, { kind = "chat", prompt = "", goalDepth = 0, attachments = null, announcements = null, startedAt = Date.now() } = {}) {
  db.prepare(`INSERT INTO active_runs (chat_id, kind, prompt, goal_depth, attachments, announcements, attempts, started_at)
              VALUES (?, ?, ?, ?, ?, ?, 0, ?)
              ON CONFLICT(chat_id) DO UPDATE SET kind=excluded.kind, prompt=excluded.prompt,
                goal_depth=excluded.goal_depth, attachments=excluded.attachments, announcements=excluded.announcements,
                started_at=excluded.started_at`)
    .run(chatId, kind, prompt || "", goalDepth | 0, attachments ? JSON.stringify(attachments) : "",
      Array.isArray(announcements) && announcements.length ? JSON.stringify(announcements) : "", startedAt);
}
export const clearActiveRun = (chatId) => db.prepare("DELETE FROM active_runs WHERE chat_id = ?").run(chatId).changes;
// Broken JSON in `announcements` yields `[]` — the resume then runs without an announcement instead of not at all.
const announcementsRead = (raw) => {
  if (!raw) return [];
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; } catch { return []; }
};
// `session`/`provider`/`model` (schema "active-runs-consumption"): the session the running turn reported — a main
// turn books its consumption only at its end (runs/booking.js); if the process dies before, the restart books the
// turn from this session file afterwards (runs/lateBooking.js), from `started_at`. Without the columns they read
// empty.
export const listActiveRuns = () =>
  db.prepare("SELECT * FROM active_runs")
    .all().map((r) => ({
      chatId: r.chat_id, kind: r.kind, prompt: r.prompt, goalDepth: r.goal_depth, attempts: r.attempts, startedAt: r.started_at,
      attachments: r.attachments ? JSON.parse(r.attachments) : null, announcements: announcementsRead(r.announcements),
      session: r.session || "", provider: r.provider || "", model: r.model || "",
    }));
/**
 * Record the session of the running turn (see listActiveRuns) — a missing row is not created. Returns whether set.
 * `startedAt`: only the row with THIS start (the clearing after a turn is booked, runs/booking.js — the row of a
 * retry with a new `started_at` stays untouched).
 */
const setActiveRunSession = (chatId, { session = "", provider = "", model = "" } = {}, { startedAt = null } = {}) =>
  (startedAt === null
    ? db.prepare("UPDATE active_runs SET session = ?, provider = ?, model = ? WHERE chat_id = ?")
      .run(String(session || ""), String(provider || ""), String(model || ""), chatId)
    : db.prepare("UPDATE active_runs SET session = ?, provider = ?, model = ? WHERE chat_id = ? AND started_at = ?")
      .run(String(session || ""), String(provider || ""), String(model || ""), chatId, Number(startedAt))).changes > 0;
// Rewrite only the prompt of an existing row (the one-off migration of the agent communication,
// channels/migration-communication.js): counters, start time and everything else stay, a missing row is not created.
const setActiveRunPrompt = (chatId, prompt) =>
  db.prepare("UPDATE active_runs SET prompt = ? WHERE chat_id = ?").run(String(prompt ?? ""), chatId).changes;
export const bumpActiveRunAttempts = (chatId) =>
  db.prepare("UPDATE active_runs SET attempts = attempts + 1 WHERE chat_id = ?").run(chatId).changes;

// ── Runs waiting at the usage limit (auto-continue) ──────────────────────────
// One row per chat: a chat cannot have more than one waiting run (a chat only ever runs one turn). A new wait state
// overwrites the old one but keeps the counters — otherwise a chat could start over without limit.
const PENDING_COLS = `chat_id AS chatId, kind, payload, prompt, goal_depth AS goalDepth, attachments,
  provider, limit_group AS limitGroup, limit_label AS limitLabel, reason, evidence,
  resets_at AS resetsAt, due_at AS dueAt, attempts, probes, workflow,
  created_at AS createdAt, updated_at AS updatedAt`;
const pendingRow = (r) => (r ? {
  ...r,
  workflow: !!r.workflow,
  attachments: r.attachments ? JSON.parse(r.attachments) : null,
  // A broken payload must not make a waiting row unreadable — it is only the re-entry.
  payload: (() => { try { return r.payload ? JSON.parse(r.payload) : null; } catch { return null; } })(),
} : null);

export function setPendingResume(chatId, {
  kind = "run", payload = null, prompt = "", goalDepth = 0, attachments = null, provider = "",
  limitGroup = "", limitLabel = "", reason = "reset", evidence = "",
  resetsAt = 0, dueAt = Date.now(), workflow = false, now = Date.now(),
} = {}) {
  db.prepare(`INSERT INTO pending_resumes (chat_id, kind, payload, prompt, goal_depth, attachments, provider,
                limit_group, limit_label, reason, evidence, resets_at, due_at, attempts, probes,
                workflow, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)
              ON CONFLICT(chat_id) DO UPDATE SET kind=excluded.kind, payload=excluded.payload,
                prompt=excluded.prompt, goal_depth=excluded.goal_depth,
                attachments=excluded.attachments, provider=excluded.provider,
                limit_group=excluded.limit_group, limit_label=excluded.limit_label,
                reason=excluded.reason, evidence=excluded.evidence, resets_at=excluded.resets_at,
                due_at=excluded.due_at, workflow=excluded.workflow, updated_at=excluded.updated_at`)
    .run(chatId, kind || "run", payload ? JSON.stringify(payload) : "", prompt || "", goalDepth | 0,
      attachments ? JSON.stringify(attachments) : "",
      provider || "", limitGroup || "", limitLabel || "", reason || "reset",
      String(evidence || "").slice(0, 200), TS(resetsAt), TS(dueAt), workflow ? 1 : 0, TS(now), TS(now));
  return getPendingResume(chatId);
}
export const getPendingResume = (chatId) =>
  pendingRow(db.prepare(`SELECT ${PENDING_COLS} FROM pending_resumes WHERE chat_id = ?`).get(chatId));
export const listPendingResumes = () =>
  db.prepare(`SELECT ${PENDING_COLS} FROM pending_resumes ORDER BY due_at`).all().map(pendingRow);
// Like setActiveRunPrompt: only the prompt, counters and due time stay (the migration of the agent communication).
const setPendingResumePrompt = (chatId, prompt) =>
  db.prepare("UPDATE pending_resumes SET prompt = ? WHERE chat_id = ?").run(String(prompt ?? ""), chatId).changes;
export const clearPendingResume = (chatId) =>
  db.prepare("DELETE FROM pending_resumes WHERE chat_id = ?").run(chatId).changes;
// Next attempt postponed (the limit still stood when it became due, or the reset was unknown).
export function reschedulePendingResume(chatId, { dueAt, resetsAt = null, reason = null, limitGroup = null, limitLabel = null, probe = false, now = Date.now() }) {
  return db.prepare(`UPDATE pending_resumes SET due_at = ?, updated_at = ?,
      resets_at = COALESCE(?, resets_at), reason = COALESCE(?, reason),
      limit_group = COALESCE(?, limit_group), limit_label = COALESCE(?, limit_label),
      probes = probes + ?
    WHERE chat_id = ?`)
    .run(TS(dueAt), TS(now), resetsAt == null ? null : TS(resetsAt), reason, limitGroup, limitLabel, probe ? 1 : 0, chatId).changes;
}
export const bumpPendingResumeAttempts = (chatId) =>
  db.prepare("UPDATE pending_resumes SET attempts = attempts + 1, updated_at = ? WHERE chat_id = ?")
    .run(Date.now(), chatId).changes;

// ── The queue per chat ───────────────────────────────────────────────────────
// Image of the in-memory queue (`pendingRunInputs` in server.js), contract see table.
// All chats at once, in list order — the caller fills its map from it at start.
export function listRunInputs() {
  const out = new Map();
  for (const r of db.prepare("SELECT chat_id AS chatId, seq, json FROM run_inputs ORDER BY chat_id, seq").all()) {
    let entry;
    // A broken row must not make the whole queue unreadable — it falls alone.
    try { entry = JSON.parse(r.json); } catch { continue; }
    if (!entry || typeof entry !== "object") continue;
    if (!out.has(r.chatId)) out.set(r.chatId, []);
    out.get(r.chatId).push(entry);
  }
  return [...out].map(([chatId, entries]) => ({ chatId, entries }));
}
// Replace the list of ONE chat — DELETE plus INSERT in one transaction, so that a crash in between does not leave
// half a list. An empty list is a delete.
export function replaceRunInputs(chatId, entries) {
  const del = db.prepare("DELETE FROM run_inputs WHERE chat_id = ?");
  if (!entries?.length) return del.run(chatId).changes;
  const intoThe = db.prepare("INSERT INTO run_inputs (chat_id, seq, json) VALUES (?, ?, ?)");
  db.exec("BEGIN");
  try {
    del.run(chatId);
    entries.forEach((entry, seq) => intoThe.run(chatId, seq, JSON.stringify(entry)));
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    throw e;
  }
  return entries.length;
}
export const clearRunInputs = (chatId) =>
  db.prepare("DELETE FROM run_inputs WHERE chat_id = ?").run(chatId).changes;

// ── Silent hints to the next turn ────────────────────────────────────────────
// A hint wakes nothing: it lies here until the NEXT turn of the chat starts (whatever the cause), travels along
// there once, fenced, before the input and is deleted afterwards (runs/hints.js). In the database, not in the
// process: a deploy (restart) must not swallow the very notice about orphans that it produces itself. No history
// row — a hint is not a message. Registration "chat-hints" in store.js.
function initHintSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_hints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT '',
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS chat_hints_chat ON chat_hints(chat_id, id);
  `);
}
// The announcements of an active run: column `active_runs.announcements` (see setActiveRun). Registration
// "active-runs-announcements" in store.js — without it every setActiveRun would fail (no such column, silently
// caught in do-run.js), and no run would survive a restart.
function initAnnouncementsSchema() {
  try { db.exec("ALTER TABLE active_runs ADD COLUMN announcements TEXT NOT NULL DEFAULT ''"); } catch { /* column already exists */ }
}
// The session of the running turn (registration "active-runs-consumption" in store.js): PRAGMA-checked ADD COLUMN,
// idempotent. Without the columns setActiveRunSession would fail (silently caught) and a crashed turn would stay
// unbooked.
function initActiveRunConsumptionSchema() {
  const have = new Set(db.prepare("PRAGMA table_info(active_runs)").all().map((c) => c.name));
  for (const col of ["session", "provider", "model"]) {
    if (!have.has(col)) db.exec(`ALTER TABLE active_runs ADD COLUMN ${col} TEXT NOT NULL DEFAULT ''`);
  }
}
function createHint(chatId, text, { source = "", at = Date.now() } = {}) {
  return Number(db.prepare("INSERT INTO chat_hints (chat_id, source, text, created_at) VALUES (?, ?, ?, ?)")
    .run(chatId, String(source || ""), String(text), at).lastInsertRowid);
}
// The open hints of ONE chat in the order of their arrival (the id grows, the clock not reliably).
const openHints = (chatId) =>
  db.prepare("SELECT id, source, text, created_at AS createdAt FROM chat_hints WHERE chat_id = ? ORDER BY id").all(chatId);
// Exactly THESE hints (the ones a turn carried) — one that arrived in the meantime stays for the next.
function deleteHints(ids) {
  const del = db.prepare("DELETE FROM chat_hints WHERE id = ?");
  let n = 0;
  for (const id of ids || []) n += del.run(id).changes;
  return n;
}
const deleteChatHints = (chatId) =>
  db.prepare("DELETE FROM chat_hints WHERE chat_id = ?").run(chatId).changes;
export { initAnnouncementsSchema, initActiveRunConsumptionSchema, setActiveRunSession, initHintSchema, createHint, openHints, deleteHints, deleteChatHints, setActiveRunPrompt, setPendingResumePrompt };
