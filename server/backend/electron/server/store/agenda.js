// The agenda per Coding chat, managed by the LLM in the chat. The data layer: ONE row per chat that ever wrote an
// agenda — title, description (Markdown: goal, plan, context) and the ordered list of steps as JSON. What an
// operation may do (caps, status, order) is computed by `agenda/operations.js`; who may write is checked by
// `agenda/routes.js` (only the main agent of the chat). Here are only the shape of the data and the invariants no
// route can bypass:
//   · an agenda belongs only to a Coding chat (kind normal, without special role) — `chatKeepsAgenda`, the same
//     question for route, prompt sentence and turn block (runs/agenda-block.js);
//   · an archived chat is read-only — checked in the same transaction as the write (agendaChange reads the chat row
//     fresh, after the lock BEFORE the body in chats/routes.js). Deliberately NO trigger on this table: it would
//     read chats.archived_at from a foreign table and couple every future rebuild of `chats` to it (a DROP COLUMN
//     archived_at failed on it).
//
// A SEPARATE table instead of columns on `chats` (like `ultracode_reminder`): a chat without an agenda leaves
// nothing behind — not in the golden fixtures either, which record every non-empty table. The row falls with the
// chat (chats/erase.js tidyUp), a fork copies it (runs/routes.js /fork; without the marks of the agenda keeper).
// Registration "chat-agenda" in store.js.
//
// A point (the agenda is a TREE): `{ id, parent, text, note, status, projectId, createdAt, changedAt, doneAt }`.
// Stored is ONE flat list in PREORDER — every point stands immediately before its subtree, siblings in their order.
// `parent` null = top level (a legacy row without the field is thus a flat top-level point, no rewrite needed);
// `projectId` only at the top level. The stored `status` of a point WITH subitems is meaningless — it is computed
// from the leaves (`agendaTree`, the ONE version) and holds again once all subitems are gone. The id is short and
// stable ("s1", "s2", …) and is NEVER reused — `next_seq` keeps counting, across deleted points too (a reader that
// remembered "s3" never hits a different point).
import { db, inOneTransaction } from "./db.js";

/** The three states of a step, in the order in which the work passes through them. */
const AGENDA_STATUS = Object.freeze(["open", "in_work", "done"]);

/** Does this chat keep an agenda? Only a Coding chat (kind normal, without special role) — the ONE version of the question. */
function chatKeepsAgenda(chat) {
  return Boolean(chat) && chat.kind === "normal" && !chat.specialRole;
}

function initAgendaSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_agenda (
      chat_id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      steps TEXT NOT NULL DEFAULT '[]',
      next_seq INTEGER NOT NULL DEFAULT 1,
      version INTEGER NOT NULL DEFAULT 0,
      changed_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chat_agenda_archive (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      root_id TEXT NOT NULL,
      parent_id TEXT,
      after_id TEXT,
      text TEXT NOT NULL DEFAULT '',
      points TEXT NOT NULL DEFAULT '[]',
      leaves INTEGER NOT NULL DEFAULT 0,
      done_at INTEGER,
      archived_at INTEGER NOT NULL,
      by TEXT NOT NULL DEFAULT 'main'
    );
    CREATE INDEX IF NOT EXISTS chat_agenda_archive_chat ON chat_agenda_archive (chat_id, id);
  `);
}

// ── The archive ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
// A finished subtree leaves the active tree (agenda/operations.js `archive`, by the main agent or the hourly sweep,
// agenda/auto-archive.js) and becomes ONE row here: its points in preorder as in `chat_agenda`, the place it came from
// (`parent_id`, `after_id` = the sibling before it) for `restore`. Ids are never reused, so a restored subtree never collides.
// Unbounded per chat; falls with the chat (deleteAgenda), goes along on a fork (copyAgenda). Written only inside the
// transaction of agendaChange (the `archive`/`restore` lists of the computation) — never on its own.
const AGENDA_ARCHIVE_BY = Object.freeze(["main", "auto"]);

function archiveRowToEntry(r) {
  return {
    id: Number(r.id), chatId: r.chat_id, rootId: r.root_id, parentId: r.parent_id || null, afterId: r.after_id || null,
    text: r.text || "", points: stepsFrom(r.points), leaves: Number(r.leaves) || 0, doneAt: Number(r.done_at) || null,
    archivedAt: Number(r.archived_at) || 0, by: AGENDA_ARCHIVE_BY.includes(r.by) ? r.by : "main",
  };
}

/** The archive entries of a chat, newest first — `before` = an entry id (paging), `limit` (default all). */
function agendaArchive(chatId, { before = null, limit = null } = {}) {
  const b = Number(before);
  const rows = db.prepare(`SELECT * FROM chat_agenda_archive WHERE chat_id = ? ${Number.isInteger(b) && b > 0 ? "AND id < ?" : ""}
    ORDER BY id DESC ${Number.isInteger(limit) && limit > 0 ? `LIMIT ${limit}` : ""}`)
    .all(...[String(chatId), ...(Number.isInteger(b) && b > 0 ? [b] : [])]);
  return rows.map(archiveRowToEntry);
}

/** How many archive entries a chat has (the clients show "Archive (n)"). */
function agendaArchiveCount(chatId) {
  return Number(db.prepare("SELECT COUNT(*) AS n FROM chat_agenda_archive WHERE chat_id = ?").get(String(chatId))?.n) || 0;
}

/** The archive entry whose subtree holds point `pointId` — or null. */
function agendaArchiveEntryOf(chatId, pointId) {
  const id = String(pointId || "");
  if (!id) return null;
  const root = db.prepare("SELECT * FROM chat_agenda_archive WHERE chat_id = ? AND root_id = ? ORDER BY id DESC LIMIT 1").get(String(chatId), id);
  if (root) return archiveRowToEntry(root);
  for (const e of agendaArchive(chatId)) if (e.points.some((p) => p.id === id)) return e;
  return null;
}

// The mark of the agenda keeper on a point (display only): `{ agentId, runId, at, kind: "fresh" | "status", prior }`
// — what does not fit falls away entirely (rather no mark than half a one; `prior` is a stage for `status`,
// otherwise null).
const UPKEEP_MARKERS_KINDS = Object.freeze(["fresh", "status"]);
function upkeepFrom(m) {
  if (!m || typeof m !== "object" || Array.isArray(m)) return null;
  if (typeof m.agentId !== "string" || !m.agentId || typeof m.runId !== "string" || !m.runId) return null;
  if (!UPKEEP_MARKERS_KINDS.includes(m.kind) || !Number.isFinite(Number(m.at)) || !Number(m.at)) return null;
  const prior = m.kind === "status" && AGENDA_STATUS.includes(m.prior) ? m.prior : null;
  return { agentId: m.agentId, runId: m.runId, at: Number(m.at), kind: m.kind, prior };
}

// A point from the row — what is missing or does not fit gets its default (a status outside the three reads as
// "open": rather one open point too many than one silently vanished; a missing `parent` is the top level).
// The two fields of the agenda keeper only stand if they are set and fit: `upkeep` (the mark, upkeepFrom) and
// `upkeepLock` (the stage the keeper may not set again — an unknown status falls away). If they are missing, the key
// is missing too: an agenda without a keeper keeps its stored form byte for byte (the equality check in
// agendaChange).
function stepFrom(s) {
  if (!s || typeof s !== "object" || typeof s.id !== "string" || !s.id) return null;
  const status = AGENDA_STATUS.includes(s.status) ? s.status : "open";
  const upkeep = upkeepFrom(s.upkeep);
  const upkeepLock = AGENDA_STATUS.includes(s.upkeepLock) ? s.upkeepLock : null;
  // `restoredAt`: the point came back from the archive (operation `restore`) — the sweep leaves it alone for a while
  // (agenda/auto-archive.js). Like the keeper's fields only present when set.
  const restoredAt = Number(s.restoredAt) || 0;
  return {
    id: s.id,
    parent: typeof s.parent === "string" && s.parent ? s.parent : null,
    text: String(s.text ?? ""),
    note: String(s.note ?? ""),
    status,
    projectId: typeof s.projectId === "string" && s.projectId ? s.projectId : null,
    createdAt: Number(s.createdAt) || 0,
    changedAt: Number(s.changedAt) || Number(s.createdAt) || 0,
    doneAt: status === "done" ? (Number(s.doneAt) || null) : null,
    ...(upkeep ? { upkeep } : {}),
    ...(upkeepLock ? { upkeepLock } : {}),
    ...(restoredAt ? { restoredAt } : {}),
  };
}

/**
 * The preorder of a point list — ONE rule for the reader (repairs) and for `agenda/operations.js` (checks after
 * every operation; a defect there is an error, nothing written). It walks with the PATH (the ancestors of the
 * previous point including itself): a point hangs on a point of this path or at the top level — otherwise its
 * `parent` is unknown, stands behind it or is not an ancestor of the predecessor (the subtree would be torn).
 * Repair happens without re-sorting: such a point becomes a top-level point (rather one top-level point too many
 * than one silently vanished), a duplicate id falls (the first counts), a project below the top level falls. There
 * are no cycles afterwards — they would need a forward reference.
 * Returns `{ points, defects }`; `defects` names the id and the reason per defect.
 */
function agendaPreorder(list) {
  const points = [];
  const defects = [];
  const seen = new Set();
  const path = [];
  for (const p of list || []) {
    if (seen.has(p.id)) { defects.push(`${p.id}: duplicate id`); continue; }
    seen.add(p.id);
    let parent = p.parent ?? null;
    if (parent !== null) {
      const k = path.lastIndexOf(parent);
      if (k < 0) {
        defects.push(`${p.id}: parent "${parent}" does not stand immediately above its subtree`);
        parent = null;
      } else path.length = k + 1;
    }
    if (parent === null) path.length = 0;
    path.push(p.id);
    let projectId = p.projectId ?? null;
    if (parent !== null && projectId !== null) { defects.push(`${p.id}: project below the top level`); projectId = null; }
    points.push(parent === (p.parent ?? null) && projectId === (p.projectId ?? null) ? p : { ...p, parent, projectId });
  }
  return { points, defects };
}

function stepsFrom(json) {
  let raw = [];
  try { raw = JSON.parse(json || "[]"); } catch { raw = []; }
  return agendaPreorder((Array.isArray(raw) ? raw : []).map(stepFrom).filter(Boolean)).points;
}

/**
 * The tree of a point list in preorder — the ONE computation of the computed status (route, stream, tool and turn
 * block read it, the clients do NOT recompute). Per point, in the same order:
 *   depth        0 = top level
 *   subitems     number of direct children
 *   done, total  done and all LEAVES in the subtree — without subitems 0/0
 *   status       leaf: its own; with subitems computed: all leaves done ⇒ done, at least one in_work or done ⇒
 *                in_work, otherwise open
 *   doneAt       leaf: its own; with subitems: the latest of the leaves if the point is done, otherwise null
 */
function agendaTree(points) {
  const list = points || [];
  const byId = new Map(list.map((p, i) => [p.id, i]));
  const info = list.map(() => ({ depth: 0, subitems: 0, open: 0, in_work: 0, done: 0, atLatest: 0 }));
  const parentIndex = list.map((p) => (p.parent == null ? -1 : (byId.get(p.parent) ?? -1)));
  list.forEach((_, i) => {
    const e = parentIndex[i];
    if (e >= 0 && e < i) { info[i].depth = info[e].depth + 1; info[e].subitems += 1; }
  });
  // Backward: the children stand behind their parents, so every subtree is fully counted before its parent's turn.
  for (let i = list.length - 1; i >= 0; i--) {
    const b = info[i];
    const p = list[i];
    if (!b.subitems) {
      const st = AGENDA_STATUS.includes(p.status) ? p.status : "open";
      b[st] += 1;
      if (st === "done") b.atLatest = Number(p.doneAt) || 0;
    }
    const e = parentIndex[i];
    if (e >= 0 && e < i) {
      for (const k of AGENDA_STATUS) info[e][k] += b[k];
      info[e].atLatest = Math.max(info[e].atLatest, b.atLatest);
    }
  }
  return list.map((p, i) => {
    const b = info[i];
    if (!b.subitems) {
      const st = AGENDA_STATUS.includes(p.status) ? p.status : "open";
      return { depth: b.depth, subitems: 0, done: 0, total: 0, status: st, doneAt: st === "done" ? (Number(p.doneAt) || null) : null };
    }
    const total = b.open + b.in_work + b.done;
    const status = total > 0 && b.done === total ? "done" : (b.in_work + b.done > 0 ? "in_work" : "open");
    return { depth: b.depth, subitems: b.subitems, done: b.done, total, status, doneAt: status === "done" ? (b.atLatest || null) : null };
  });
}

/** The agenda without a row: the same shape, empty, `version` 0 and `changedAt` null (never written — not "0 ms ago"). */
function emptyAgenda(chatId) {
  return { chatId: String(chatId), title: "", description: "", steps: [], nextSeq: 1, version: 0, changedAt: null };
}

function rowToAgenda(r) {
  return {
    chatId: r.chat_id,
    title: r.title || "",
    description: r.description || "",
    steps: stepsFrom(r.steps),
    nextSeq: Math.max(1, Number(r.next_seq) || 1),
    version: Number(r.version) || 0,
    changedAt: Number(r.changed_at) || null,
  };
}

/** The agenda of a chat — without a row the empty shape (never null). */
function readAgenda(chatId) {
  const r = db.prepare("SELECT * FROM chat_agenda WHERE chat_id = ?").get(String(chatId));
  return r ? rowToAgenda(r) : emptyAgenda(chatId);
}

/** Is the agenda empty (no title, no description, no point — not even a top-level point without subitems)? An empty
 *  one is neither shown nor put into a turn (the golden runs stay byte-equal); a project filter makes no agenda
 *  empty. */
function agendaIsEmpty(a) {
  return !a || (!String(a.title || "").trim() && !String(a.description || "").trim() && !(a.steps || []).length);
}

// An error of the data layer with a code the route translates into a status (409 archived, 409 no agenda, 404).
function dataError(code, text) {
  return Object.assign(new Error(text), { code });
}

/**
 * Change the agenda of a chat — in ONE transaction: read, let `change(alt)` compute, write. `change` is synchronous
 * and returns `{ title, description, steps, nextSeq }` or throws (then nothing is written). Before that the
 * transaction checks the chat row: it exists (`chat_missing`), it keeps an agenda (`no_agenda`), it is not archived
 * (`archived`). Returns the new agenda (`version` + 1, `changedAt` = now) — or, if the computation yielded the same
 * state, the old one with `unchanged: true` (nothing written).
 */
function agendaChange(chatId, change, { now = Date.now() } = {}) {
  const id = String(chatId);
  return inOneTransaction(() => {
    const c = db.prepare("SELECT kind, specialRole, archived_at FROM chats WHERE id = ?").get(id);
    if (!c) throw dataError("chat_missing", "chat not found");
    if (!chatKeepsAgenda({ kind: c.kind, specialRole: c.specialRole || "" })) throw dataError("no_agenda", "chat keeps no agenda");
    if (c.archived_at != null) throw dataError("archived", "chat archived");
    const old = readAgenda(id);
    const fresh = change(old);
    // Same state ⇒ write nothing (no version, no timestamp, no row for an empty agenda) — the caller sees `unchanged`
    // and sends no event.
    const equal = String(fresh.title ?? "") === old.title && String(fresh.description ?? "") === old.description
      && JSON.stringify(fresh.steps || []) === JSON.stringify(old.steps) && Math.max(1, Number(fresh.nextSeq) || 1) === old.nextSeq;
    // `newRevision` (agenda/change.js): the state is the same, but what a ring of the agenda keeper explains has
    // changed — a new version nevertheless, otherwise every client would keep the old explanation.
    if (equal && fresh.newRevision !== true) return { ...old, unchanged: true };
    const version = old.version + 1;
    // The archive moves in the SAME transaction (agenda/operations.js `archive` / `restore`): a subtree is never in both
    // places, nor in neither.
    for (const e of fresh.archive || []) {
      db.prepare(`INSERT INTO chat_agenda_archive (chat_id, root_id, parent_id, after_id, text, points, leaves, done_at, archived_at, by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, String(e.rootId), e.parentId ?? null, e.afterId ?? null, String(e.text ?? ""),
        JSON.stringify(e.points || []), Number(e.leaves) || 0, Number(e.doneAt) || null, now, AGENDA_ARCHIVE_BY.includes(e.by) ? e.by : "main");
    }
    for (const entryId of fresh.restore || []) db.prepare("DELETE FROM chat_agenda_archive WHERE chat_id = ? AND id = ?").run(id, Number(entryId));
    db.prepare(`INSERT INTO chat_agenda (chat_id, title, description, steps, next_seq, version, changed_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET title = excluded.title, description = excluded.description, steps = excluded.steps,
        next_seq = excluded.next_seq, version = excluded.version, changed_at = excluded.changed_at`)
      .run(id, String(fresh.title ?? ""), String(fresh.description ?? ""), JSON.stringify(fresh.steps || []), Math.max(1, Number(fresh.nextSeq) || 1), version, now);
    return readAgenda(id);
  });
}

/** Delete the row of a chat (its closing path, chats/erase.js). */
function deleteAgenda(chatId) {
  db.prepare("DELETE FROM chat_agenda WHERE chat_id = ?").run(String(chatId));
  db.prepare("DELETE FROM chat_agenda_archive WHERE chat_id = ?").run(String(chatId));
}

/**
 * The agenda of the original as a copy to the fork (runs/routes.js /fork) — without a row at the original nothing.
 * State and ids go along. The agenda keeper: the mark `upkeep` falls on every point — the log
 * (store/agenda-upkeep.js) does not move along, in the fork it could neither be closed nor evaluated, and it would
 * point to a run of another chat. `upkeepLock` STAYS: the undo of the main agent keeps holding in the fork (it
 * belongs to the state). In the ORIGINAL the ring stays after every other writer — in the fork it falls anyway: its
 * explanation reads from the log what happened afterwards (agenda/operations.js), and without rows in the fork it
 * would stay "unknown" forever.
 */
function copyAgenda(ofChatId, byChatId) {
  const r = db.prepare("SELECT * FROM chat_agenda WHERE chat_id = ?").get(String(ofChatId));
  if (!r) return;
  let steps = r.steps;
  const marked = (s) => Boolean(s) && typeof s === "object" && !Array.isArray(s) && Object.hasOwn(s, "upkeep");
  const withoutMark = (s) => {
    if (!marked(s)) return s;
    const { upkeep: _marking, ...without } = s;
    return without;
  };
  try {
    const raw = JSON.parse(r.steps || "[]");
    // Only rewrite if a mark is there — otherwise the row goes along byte for byte.
    if (Array.isArray(raw) && raw.some(marked)) steps = JSON.stringify(raw.map(withoutMark));
  } catch { /* unreadable: as it is — the reader repairs (stepsFrom), as with the original */ }
  const copied = db.prepare(`INSERT INTO chat_agenda (chat_id, title, description, steps, next_seq, version, changed_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(chat_id) DO NOTHING`).run(String(byChatId), r.title, r.description, steps, r.next_seq, r.version, r.changed_at);
  // The archive goes along (a restore in the fork needs it), in its order — only with a fresh copy (a repeated one would double
  // it) and, like the active points, without the keeper's marks.
  if (!Number(copied?.changes)) return;
  for (const e of db.prepare("SELECT * FROM chat_agenda_archive WHERE chat_id = ? ORDER BY id").all(String(ofChatId))) {
    let points = e.points;
    try {
      const raw = JSON.parse(e.points || "[]");
      if (Array.isArray(raw) && raw.some(marked)) points = JSON.stringify(raw.map(withoutMark));
    } catch { /* unreadable: as it is */ }
    db.prepare(`INSERT INTO chat_agenda_archive (chat_id, root_id, parent_id, after_id, text, points, leaves, done_at, archived_at, by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(String(byChatId), e.root_id, e.parent_id, e.after_id, e.text, points, e.leaves, e.done_at, e.archived_at, e.by);
  }
}

/** The chats that have an agenda row (the sweep, agenda/auto-archive.js). */
function agendaChatIds() {
  return db.prepare("SELECT chat_id FROM chat_agenda ORDER BY chat_id").all().map((r) => r.chat_id);
}

/** All agendas of the chats of a workspace, most recently changed first — for the overview. */
function agendasInWorkspace(workspaceId) {
  return db.prepare(`SELECT a.* FROM chat_agenda a JOIN chats c ON c.id = a.chat_id
    WHERE c.workspace_id = ? ORDER BY a.changed_at DESC, a.chat_id`).all(String(workspaceId)).map(rowToAgenda);
}

// Wrapper export: via the facade (store.js `export *`), never imported directly (import-direction.test.js).
export { AGENDA_STATUS, chatKeepsAgenda, initAgendaSchema, readAgenda, agendaIsEmpty, agendaChange, deleteAgenda, copyAgenda, agendasInWorkspace,
  agendaPreorder, agendaTree, AGENDA_ARCHIVE_BY, agendaArchive, agendaArchiveCount, agendaArchiveEntryOf, agendaChatIds };
