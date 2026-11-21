// The timeline per project. What REALLY happened in a project: events with evidence (citation), entered solely by
// the timeline agent (outer loop) from its tools and the chat — no mechanical source.
//
// APPEND-ONLY, without exception: five tables, none knows UPDATE or DELETE — the triggers below block both in the
// SQL itself (like the archive, store/chats.js). Collecting is a row in `timeline_parts`, dismissing a row in
// `timeline_dismissals` (the "correction event"). The ONE delete path: the project falls (store/workspaces.js
// deleteProject/deleteWorkspace delete the rows AFTER the project row — before that the trigger blocks). The project
// switch `projects.timeline_off` (opt-out) is state, not timeline: it may change.
//
//   timeline_events      an event; UNIQUE (project_id, citation_kind, citation_ref, citation_of) — a citation
//                        carries at most one event
//   timeline_tags        ≤ 8 per event, lower case, ≤ 40 characters (checked in timeline/check.js)
//   timeline_parts       collective event → part; `part_id` UNIQUE (a part belongs to at most one collective event)
//   timeline_dismissals  `event_id` UNIQUE (once dismissed stays dismissed), by agent|user, justification mandatory
//   timeline_revisions   new versions of title and text: per row the FULL title and text, by agent|human; the most
//                        recent is read (`seq` is the order), the row in timeline_events stays the first version.
//                        Revising is appending, never UPDATE.
//
// The domain rules (kind, citation, anchors, levels) are checked by timeline/check.js; here are only rows and the
// hard limits of the schema. Registration "timeline" at the end of store.js; wrapper export via the facade.
import { db, inOneTransaction } from "./db.js";

const TIMELINE_KINDS = Object.freeze(["code", "git", "test", "communication", "ops", "other"]);
const KINDS_SQL = TIMELINE_KINDS.map((a) => `'${a}'`).join(", ");

function initTimelineSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS timeline_events (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN (${KINDS_SQL})),
      title TEXT NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      at INTEGER NOT NULL,
      citation_kind TEXT NOT NULL CHECK (citation_kind IN ('tool', 'message')),
      citation_ref TEXT NOT NULL,
      citation_of TEXT NOT NULL DEFAULT '',
      chat_id TEXT,
      branch TEXT,
      sha TEXT,
      mr_iid INTEGER,
      agenda_point_id TEXT,
      run_id TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE (project_id, citation_kind, citation_ref, citation_of)
    );
    CREATE INDEX IF NOT EXISTS timeline_events_project ON timeline_events(project_id, at);
    CREATE INDEX IF NOT EXISTS timeline_events_chat ON timeline_events(chat_id);
    CREATE TABLE IF NOT EXISTS timeline_tags (
      event_id TEXT NOT NULL,
      word TEXT NOT NULL,
      PRIMARY KEY (event_id, word)
    );
    CREATE INDEX IF NOT EXISTS timeline_tags_word ON timeline_tags(word);
    CREATE TABLE IF NOT EXISTS timeline_parts (
      collection_id TEXT NOT NULL,
      part_id TEXT NOT NULL UNIQUE,
      at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS timeline_parts_collection ON timeline_parts(collection_id);
    CREATE TABLE IF NOT EXISTS timeline_dismissals (
      event_id TEXT NOT NULL UNIQUE,
      author TEXT NOT NULL CHECK (author IN ('agent', 'user')),
      justification TEXT NOT NULL,
      at INTEGER NOT NULL,
      run_id TEXT
    );
    CREATE TABLE IF NOT EXISTS timeline_revisions (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL,
      title TEXT NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      author TEXT NOT NULL CHECK (author IN ('agent', 'human')),
      justification TEXT NOT NULL DEFAULT '',
      at INTEGER NOT NULL,
      run_id TEXT
    );
    CREATE INDEX IF NOT EXISTS timeline_revisions_event ON timeline_revisions(event_id, seq);

    CREATE TRIGGER IF NOT EXISTS timeline_events_no_update BEFORE UPDATE ON timeline_events
    BEGIN SELECT RAISE(ABORT, 'timeline-only-append'); END;
    CREATE TRIGGER IF NOT EXISTS timeline_events_no_delete BEFORE DELETE ON timeline_events
    WHEN EXISTS (SELECT 1 FROM projects WHERE id = OLD.project_id)
    BEGIN SELECT RAISE(ABORT, 'timeline-only-append'); END;

    CREATE TRIGGER IF NOT EXISTS timeline_tags_no_update BEFORE UPDATE ON timeline_tags
    BEGIN SELECT RAISE(ABORT, 'timeline-only-append'); END;
    CREATE TRIGGER IF NOT EXISTS timeline_tags_no_delete BEFORE DELETE ON timeline_tags
    WHEN EXISTS (SELECT 1 FROM timeline_events e JOIN projects p ON p.id = e.project_id WHERE e.id = OLD.event_id)
    BEGIN SELECT RAISE(ABORT, 'timeline-only-append'); END;

    CREATE TRIGGER IF NOT EXISTS timeline_parts_no_update BEFORE UPDATE ON timeline_parts
    BEGIN SELECT RAISE(ABORT, 'timeline-only-append'); END;
    CREATE TRIGGER IF NOT EXISTS timeline_parts_no_delete BEFORE DELETE ON timeline_parts
    WHEN EXISTS (SELECT 1 FROM timeline_events e JOIN projects p ON p.id = e.project_id WHERE e.id = OLD.part_id)
    BEGIN SELECT RAISE(ABORT, 'timeline-only-append'); END;

    CREATE TRIGGER IF NOT EXISTS timeline_dismissals_no_update BEFORE UPDATE ON timeline_dismissals
    BEGIN SELECT RAISE(ABORT, 'timeline-only-append'); END;
    CREATE TRIGGER IF NOT EXISTS timeline_dismissals_no_delete BEFORE DELETE ON timeline_dismissals
    WHEN EXISTS (SELECT 1 FROM timeline_events e JOIN projects p ON p.id = e.project_id WHERE e.id = OLD.event_id)
    BEGIN SELECT RAISE(ABORT, 'timeline-only-append'); END;

    CREATE TRIGGER IF NOT EXISTS timeline_revisions_no_update BEFORE UPDATE ON timeline_revisions
    BEGIN SELECT RAISE(ABORT, 'timeline-only-append'); END;
    CREATE TRIGGER IF NOT EXISTS timeline_revisions_no_delete BEFORE DELETE ON timeline_revisions
    WHEN EXISTS (SELECT 1 FROM timeline_events e JOIN projects p ON p.id = e.project_id WHERE e.id = OLD.event_id)
    BEGIN SELECT RAISE(ABORT, 'timeline-only-append'); END;
  `);
  const columns = new Set(db.prepare("PRAGMA table_info(projects)").all().map((c) => c.name));
  if (!columns.has("timeline_off")) db.exec("ALTER TABLE projects ADD COLUMN timeline_off INTEGER NOT NULL DEFAULT 0");
}

const textOrNull = (v) => (v === null || v === undefined || v === "" ? null : String(v));

// ── Switch ─────────────────────────────────────────────────────────────────────────────────────────────────────────
/** Is the timeline of the project on? `null` = no such project (not "off"). */
function timelineActive(projectId) {
  const r = db.prepare("SELECT timeline_off FROM projects WHERE id = ?").get(String(projectId ?? ""));
  return r ? Number(r.timeline_off) === 0 : null;
}
/** Set the switch. → the new state (`null` without a project). */
function setTimelineActive(projectId, active) {
  db.prepare("UPDATE projects SET timeline_off = ? WHERE id = ?").run(active ? 0 : 1, String(projectId ?? ""));
  return timelineActive(projectId);
}

// ── Writing (append only) ──────────────────────────────────────────────────────────────────────────────────────────
/**
 * An event with its tags in ONE transaction. `e` in contract names (camelCase). A duplicate citation throws with
 * `code = "DUPLICATE"` and `eventId` (the existing one). → the id.
 */
function enterTimeline(e) {
  const id = String(e.id);
  try {
    inOneTransaction(() => {
      db.prepare(`INSERT INTO timeline_events (id, project_id, workspace_id, kind, title, text, at, citation_kind, citation_ref, citation_of,
          chat_id, branch, sha, mr_iid, agenda_point_id, run_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, String(e.projectId), String(e.workspaceId), String(e.kind), String(e.title), String(e.text ?? ""), Number(e.at),
        String(e.citationKind), String(e.citationRef), String(e.citationOf ?? ""), textOrNull(e.chatId),
        textOrNull(e.branch), textOrNull(e.sha), Number.isSafeInteger(e.mrIid) ? e.mrIid : null, textOrNull(e.agendaItemId),
        textOrNull(e.runId), Number(e.createdAt) || Date.now());
      const st = db.prepare("INSERT INTO timeline_tags (event_id, word) VALUES (?, ?)");
      for (const w of e.tags || []) st.run(id, String(w));
    });
  } catch (err) {
    if (/UNIQUE constraint failed: timeline_events\.project_id/.test(String(err?.message))) {
      const existing = timelineCitationEvent(e.projectId, e.citationKind, e.citationRef, e.citationOf ?? "");
      throw Object.assign(new Error("duplicate citation"), { code: "DUPLICATE", eventId: existing });
    }
    throw err;
  }
  return id;
}

/** The id of the event at this citation or null. */
function timelineCitationEvent(projectId, kind, ref, from = "") {
  return db.prepare(`SELECT id FROM timeline_events WHERE project_id = ? AND citation_kind = ? AND citation_ref = ? AND citation_of = ?`)
    .get(String(projectId), String(kind), String(ref), String(from ?? ""))?.id ?? null;
}

/** Append parts to a collective event — all or none (a part already collected throws `code = "ALREADY_COLLECTED"`). */
function appendTimelineParts(collectionId, partIds, at = Date.now()) {
  try {
    inOneTransaction(() => {
      const st = db.prepare("INSERT INTO timeline_parts (collection_id, part_id, at) VALUES (?, ?, ?)");
      for (const t of partIds) st.run(String(collectionId), String(t), Number(at));
    });
  } catch (err) {
    if (/UNIQUE constraint failed: timeline_parts\.part_id/.test(String(err?.message))) throw Object.assign(new Error("already collected"), { code: "ALREADY_COLLECTED" });
    throw err;
  }
}

/** Dismiss an event. Already dismissed throws `code = "ALREADY_DISMISSED"`. */
function dismissTimeline({ eventId, from, justification, at = Date.now(), runId = null }) {
  try {
    db.prepare("INSERT INTO timeline_dismissals (event_id, author, justification, at, run_id) VALUES (?, ?, ?, ?, ?)")
      .run(String(eventId), String(from), String(justification), Number(at), textOrNull(runId));
  } catch (err) {
    if (/UNIQUE constraint failed: timeline_dismissals\.event_id/.test(String(err?.message))) throw Object.assign(new Error("already dismissed"), { code: "ALREADY_DISMISSED" });
    throw err;
  }
}

/**
 * Append a new version of title and text. `from` agent|human. Whether the event is dismissed, whether anything
 * changes and the caps are checked by timeline/revisions.js — here only the row. → the running number.
 */
function appendTimelineRevision({ eventId, title, text = "", from, justification = "", at = Date.now(), runId = null }) {
  const r = db.prepare("INSERT INTO timeline_revisions (event_id, title, text, author, justification, at, run_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(String(eventId), String(title), String(text ?? ""), String(from), String(justification ?? ""), Number(at), textOrNull(runId));
  return Number(r.lastInsertRowid);
}

/** The later versions per event → Map id → rows (oldest first). */
function timelineRevisionsOf(ids) {
  const list = [...new Set((ids || []).map(String))];
  const out = new Map();
  if (!list.length) return out;
  for (const r of db.prepare("SELECT * FROM timeline_revisions WHERE event_id IN (SELECT value FROM json_each(?)) ORDER BY seq")
    .all(JSON.stringify(list))) {
    if (!out.has(r.event_id)) out.set(r.event_id, []);
    out.get(r.event_id).push({ seq: Number(r.seq), title: r.title, text: r.text, from: r.author, justification: r.justification, at: Number(r.at), runId: r.run_id ?? null });
  }
  return out;
}

// ── Reading ────────────────────────────────────────────────────────────────────────────────────────────────────────
const rowFrom = (r) => r && {
  id: r.id, projectId: r.project_id, workspaceId: r.workspace_id, kind: r.kind, title: r.title, text: r.text, at: Number(r.at),
  citationKind: r.citation_kind, citationRef: r.citation_ref, citationOf: r.citation_of, chatId: r.chat_id ?? null,
  branch: r.branch ?? null, sha: r.sha ?? null, mrIid: r.mr_iid === null || r.mr_iid === undefined ? null : Number(r.mr_iid),
  agendaItemId: r.agenda_point_id ?? null, runId: r.run_id ?? null, createdAt: Number(r.created_at),
};

/** An event (raw row in camelCase) or null. */
function timelineRow(id) {
  return rowFrom(db.prepare("SELECT * FROM timeline_events WHERE id = ?").get(String(id ?? "")));
}

/**
 * Events of a project, newest first. `top` = only the top-level ones (not part of a collective event). Filters (all
 * optional): `until` (at < until; with `untilId` the cursor (at, created, id) — before the event `untilId` in the
 * order of the list, so that equal `at` at the page boundary do not drop out; an unknown `untilId` ⇒ like `until`
 * alone), `from` (at ≥ from), `kind`, `chat`, `word`, `sha`/`branch`/`mrIid` (anchors), `q` (text in title/text,
 * every version), `withAgendaPoint` (only events with an agenda point — the evidence of the agenda, useful with
 * `top: false`), `limit`. A filter on kind/chat/tag with `top` also matches a collective event whose PART matches.
 */
function timelineRows(projectId, { top = true, until = null, untilId = null, from = null, kind = null, chat = null, word = null, sha = null, branch = null, mrIid = null, q = null, withAgendaPoint = false, limit = 50 } = {}) {
  const w = ["e.project_id = ?"];
  const v = [String(projectId)];
  if (top) w.push("NOT EXISTS (SELECT 1 FROM timeline_parts t WHERE t.part_id = e.id)");
  if (withAgendaPoint) w.push("e.agenda_point_id IS NOT NULL");
  if (Number.isFinite(until) && untilId) {
    // The same key as ORDER BY below: everything that stands BEHIND the cursor in the order.
    w.push(`(e.at < ? OR (e.at = ? AND EXISTS (SELECT 1 FROM timeline_events c WHERE c.id = ? AND c.at = e.at
      AND (e.created_at < c.created_at OR (e.created_at = c.created_at AND e.id < c.id)))))`);
    v.push(until, until, String(untilId));
  } else if (Number.isFinite(until)) { w.push("e.at < ?"); v.push(until); }
  if (Number.isFinite(from)) { w.push("e.at >= ?"); v.push(from); }
  // Itself or a part (with `top`): the same condition via `x`.
  const selfOrPart = (bed, ...values) => {
    if (!top) { w.push(bed("e")); v.push(...values); return; }
    w.push(`(${bed("e")} OR EXISTS (SELECT 1 FROM timeline_parts t JOIN timeline_events x ON x.id = t.part_id WHERE t.collection_id = e.id AND ${bed("x")}))`);
    v.push(...values, ...values);
  };
  if (kind) selfOrPart((a) => `${a}.kind = ?`, String(kind));
  if (chat) selfOrPart((a) => `${a}.chat_id = ?`, String(chat));
  if (word) selfOrPart((a) => `EXISTS (SELECT 1 FROM timeline_tags s WHERE s.event_id = ${a}.id AND s.word = ?)`, String(word).toLowerCase());
  if (sha) selfOrPart((a) => `${a}.sha LIKE ?`, `${String(sha).toLowerCase()}%`);
  if (branch) selfOrPart((a) => `${a}.branch = ?`, String(branch));
  if (Number.isSafeInteger(mrIid)) selfOrPart((a) => `${a}.mr_iid = ?`, mrIid);
  // Text: the first version AND every later one (timeline_revisions) — whoever searches for the old wording finds the event too.
  if (q) {
    const k = String(q).toLowerCase();
    selfOrPart((a) => `(instr(lower(${a}.title), ?) > 0 OR instr(lower(${a}.text), ?) > 0 OR EXISTS (SELECT 1 FROM timeline_revisions f
      WHERE f.event_id = ${a}.id AND (instr(lower(f.title), ?) > 0 OR instr(lower(f.text), ?) > 0)))`, k, k, k, k);
  }
  const n = Math.max(1, Math.min(1000, Number(limit) || 50));
  return db.prepare(`SELECT e.* FROM timeline_events e WHERE ${w.join(" AND ")} ORDER BY e.at DESC, e.created_at DESC, e.id DESC LIMIT ?`)
    .all(...v, n).map(rowFrom);
}

/** Parts per collective event → Map collectionId → rows (oldest first; at the same `at` in the order they were recorded — the
 *  random id as tie-breaker made two parts of one millisecond swap places, timeline.test.js (3)). */
function timelinePartsOf(collectionIds) {
  const ids = [...new Set((collectionIds || []).map(String))];
  const out = new Map();
  if (!ids.length) return out;
  for (const r of db.prepare(`SELECT t.collection_id AS collection, e.* FROM timeline_parts t JOIN timeline_events e ON e.id = t.part_id
      WHERE t.collection_id IN (SELECT value FROM json_each(?)) ORDER BY e.at ASC, e.rowid ASC`).all(JSON.stringify(ids))) {
    if (!out.has(r.collection)) out.set(r.collection, []);
    out.get(r.collection).push(rowFrom(r));
  }
  return out;
}

/** The collective event of a part or null. */
const timelineCollectionOf = (partId) => db.prepare("SELECT collection_id FROM timeline_parts WHERE part_id = ?").get(String(partId ?? ""))?.collection_id ?? null;
/** Does the event have parts? */
const timelineHasParts = (id) => Boolean(db.prepare("SELECT 1 FROM timeline_parts WHERE collection_id = ? LIMIT 1").get(String(id ?? "")));

/** Tags per event → Map id → [tag] (alphabetical). */
function timelineTagsOf(ids) {
  const list = [...new Set((ids || []).map(String))];
  const out = new Map();
  if (!list.length) return out;
  for (const r of db.prepare("SELECT event_id, word FROM timeline_tags WHERE event_id IN (SELECT value FROM json_each(?)) ORDER BY word")
    .all(JSON.stringify(list))) {
    if (!out.has(r.event_id)) out.set(r.event_id, []);
    out.get(r.event_id).push(r.word);
  }
  return out;
}

/** Dismissals per event → Map id → { from, justification, at }. */
function timelineDismissalsOf(ids) {
  const list = [...new Set((ids || []).map(String))];
  const out = new Map();
  if (!list.length) return out;
  for (const r of db.prepare("SELECT * FROM timeline_dismissals WHERE event_id IN (SELECT value FROM json_each(?))").all(JSON.stringify(list))) {
    out.set(r.event_id, { from: r.author, justification: r.justification, at: Number(r.at) });
  }
  return out;
}

// ── The chat as source (citations, tool index) ─────────────────────────────────────────────────────────────────────
/** A row from `messages` → `{ id, chatId, role, text, ts }` or null. */
function timelineMessage(id) {
  const r = db.prepare("SELECT id, chat_id, role, text, created_at AS ts FROM messages WHERE id = ? AND role <> 'input'").get(Number(id) || 0);
  return r ? { id: Number(r.id), chatId: r.chat_id, role: r.role, text: r.text, ts: Number(r.ts) } : null;
}
/**
 * The `tool` rows of a chat in the stretch (`fromId` exclusive, `untilId` inclusive, `since` = created_at ≥ since;
 * each optional), oldest first.
 */
function timelineToolRows(chatId, { fromId = null, untilId = null, since = 0 } = {}) {
  return db.prepare(`SELECT id, text, created_at AS ts FROM messages WHERE chat_id = ? AND role = 'tool' AND id > ? AND (? IS NULL OR id <= ?) AND created_at >= ? ORDER BY id`)
    .all(String(chatId), Number(fromId) || 0, untilId ?? null, untilId ?? null, Number(since) || 0).map((r) => ({ id: Number(r.id), text: r.text, ts: Number(r.ts) }));
}
/**
 * The rows of a role (`tool` or `tool_result`) of a chat whose block id (`$.id` in the JSON) is one of the `ids`,
 * oldest first — across the whole chat (the pairing needs the competition before and behind a stretch,
 * timeline/tool-index.js).
 */
function timelineBlockRows(chatId, ids, role) {
  const list = [...new Set((ids || []).map(String))];
  if (!list.length || !["tool", "tool_result"].includes(role)) return [];
  return db.prepare(`SELECT id, text FROM messages WHERE chat_id = ? AND role = ? AND json_valid(text)
      AND CAST(json_extract(text, '$.id') AS TEXT) IN (SELECT value FROM json_each(?)) ORDER BY id`)
    .all(String(chatId), role, JSON.stringify(list)).map((r) => ({ id: Number(r.id), text: r.text }));
}
/** The subagent of a call block (`parent` of a row): its id or null (the stock remembers `parentToolUseId`, store/subagents.js). */
function timelineSubagentOfBlock(chatId, block) {
  return db.prepare(`SELECT agent_id FROM subagents WHERE chat_id = ? AND json_valid(data) AND json_extract(data, '$.parentToolUseId') = ?
    ORDER BY updated_at DESC LIMIT 1`).get(String(chatId), String(block ?? ""))?.agent_id ?? null;
}

// Wrapper export: via the facade (store.js `export *`), never imported directly (import-direction.test.js).
export {
  TIMELINE_KINDS, initTimelineSchema, timelineActive, setTimelineActive, enterTimeline, timelineCitationEvent, appendTimelineParts, dismissTimeline,
  appendTimelineRevision, timelineRevisionsOf,
  timelineRow, timelineRows, timelinePartsOf, timelineCollectionOf, timelineHasParts, timelineTagsOf, timelineDismissalsOf,
  timelineMessage, timelineToolRows, timelineBlockRows, timelineSubagentOfBlock,
};
