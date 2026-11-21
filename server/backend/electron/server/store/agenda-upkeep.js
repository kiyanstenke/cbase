// The log of the agenda keeper. ONE row per change the keeper wrote to an agenda — independent of the switch "mark
// changes" — with its later outcome:
//   open       it stands (nobody else has touched the point since)
//   confirmed  the main agent worked on the point afterwards without undoing it
//   corrected  the main agent undid it (status below the stage that was set, created point deleted, title or
//              description changed afterwards)
// The outcome holds per ROW (two runs on the same point have two outcomes), the first one counts. "Standing" = open
// or confirmed: from these rows the main agent computes the lock when lowering a status — except from an OUTDATED
// one (`outdated_at`): if the main agent itself set the point to its stage or further, the stage is its own
// decision, no longer the keeper's (otherwise an old confirmed row would lock anew on EVERY later reopening).
// Outdated does not change the outcome. The rules WHEN an outcome falls and when a row is outdated are computed by
// agenda/operations.js (bringAlongWriter); here are only rows. Writing always happens within the transaction of the
// agenda change (store/agenda.js agendaChange → agenda/change.js): the rows and the state of the agenda come into
// being together or not at all.
//
// `point_id` is empty ("") for `title`/`description`. `prior`/`after`: for `status` the stages, for `fresh` prior
// NULL and after the text of the point (that is how the keeper's frame tells it which point not to create again),
// for `title`/`description` the old and new value. `stage` = the stage at which the keeper left the point (for
// `status` = after, for `fresh` the status of the new point, otherwise NULL) — the main agent measures outcome and
// lock against it, never against the state of the agenda (the server may have set that in between). `outdated_at` =
// when the main agent itself set the point to `stage` or further (NULL = the row counts for the lock).
//
// Delete paths (no foreign keys): with the chat (chats/erase.js tidyUp → deleteAgendaUpkeepChat), with the workspace
// (store/workspaces.js deleteWorkspace), with the agent (store/outer-loop.js deleteOuterLoopAgent). A fork copies no
// row (store/agenda.js copyAgenda therefore strips the marks of the copied points, the locks stay). The agenda
// response reads the outcome of the row that belongs to the mark of a point (agendaUpkeepHistory): the mark stays
// after every other writer, its explanation says from THIS table what happened afterwards.
// Registration "agenda-upkeep" at the end of store.js.
import { db } from "./db.js";

const UPKEEP_KINDS = Object.freeze(["fresh", "status", "title", "description"]);
const UPKEEP_OUTCOMES = Object.freeze(["open", "confirmed", "corrected"]);
const list = (xs) => xs.map(() => "?").join(", ");

function initAgendaUpkeepSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agenda_upkeep (
      id INTEGER PRIMARY KEY,
      chat_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      point_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('fresh', 'status', 'title', 'description')),
      prior TEXT,
      after TEXT,
      stage TEXT,
      at INTEGER NOT NULL,
      outcome TEXT NOT NULL DEFAULT 'open' CHECK (outcome IN ('open', 'confirmed', 'corrected')),
      outcome_at INTEGER,
      outdated_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS agenda_upkeep_point ON agenda_upkeep(chat_id, point_id);
    CREATE INDEX IF NOT EXISTS agenda_upkeep_agent ON agenda_upkeep(agent_id);
    CREATE INDEX IF NOT EXISTS agenda_upkeep_run ON agenda_upkeep(run_id);
  `);
}

const textOrNull = (v) => (v === null || v === undefined ? null : String(v));

/**
 * Several rows in ONE call — called from within the write transaction (agenda/change.js), hence without its own.
 * `rows` = `[{ chatId, workspaceId, agentId, runId, pointId, kind, prior, after, stage, at }]`. An unknown kind
 * throws (CHECK). → number of rows.
 */
function enterAgendaUpkeep(rows) {
  const st = db.prepare(`INSERT INTO agenda_upkeep (chat_id, workspace_id, agent_id, run_id, point_id, kind, prior, after, stage, at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  let n = 0;
  for (const r of rows || []) {
    st.run(String(r.chatId), String(r.workspaceId), String(r.agentId), String(r.runId), String(r.pointId ?? ""), String(r.kind),
      textOrNull(r.prior), textOrNull(r.after), textOrNull(r.stage), Number(r.at) || Date.now());
    n += 1;
  }
  return n;
}

/**
 * Set the outcome of OPEN rows — `touched` = `[{ id, outcome }]` per row (the write path of the main agent,
 * agenda/operations.js bringAlongWriter) or `[{ pointId, outcome, kind? }]` for all open rows of a point (`kind`
 * narrows; with `pointId` "" to title or description). A closed row stays as it is (the FIRST outcome counts).
 * `outdated` = the ids of the rows whose stage the main agent has just reached itself — from now on they count for
 * no lock (only a row not yet outdated is set; the outcome stays as it is). Without its own transaction — called
 * within the transaction of the agenda change. → number of changed rows (outcome and outdated together).
 */
function agendaUpkeepOutcome(chatId, { touched = [], outdated = [], at = Date.now() } = {}) {
  let n = 0;
  for (const id of outdated || []) {
    n += db.prepare("UPDATE agenda_upkeep SET outdated_at = ? WHERE id = ? AND chat_id = ? AND outdated_at IS NULL")
      .run(Number(at), Number(id), String(chatId)).changes;
  }
  for (const b of touched || []) {
    if (!UPKEEP_OUTCOMES.includes(b?.outcome) || b.outcome === "open") continue;
    if (b.id !== undefined && b.id !== null) {
      n += db.prepare("UPDATE agenda_upkeep SET outcome = ?, outcome_at = ? WHERE id = ? AND chat_id = ? AND outcome = 'open'")
        .run(b.outcome, Number(at), Number(b.id), String(chatId)).changes;
      continue;
    }
    const kindFilter = b.kind ? " AND kind = ?" : "";
    n += db.prepare(`UPDATE agenda_upkeep SET outcome = ?, outcome_at = ?
      WHERE chat_id = ? AND point_id = ? AND outcome = 'open'${kindFilter}`)
      .run(b.outcome, Number(at), String(chatId), String(b.pointId ?? ""), ...(b.kind ? [String(b.kind)] : [])).changes;
  }
  return n;
}

/**
 * The STANDING rows of a chat (outcome open or confirmed) — `[{ id, pointId, kind, after, stage, outcome, outdated }]`,
 * oldest first. The write path of the main agent computes with them: outcome of the open ones, lock from all
 * standing ones that are not `outdated`.
 */
function agendaUpkeepStanding(chatId) {
  return db.prepare(`SELECT id, point_id, kind, after, stage, outcome, outdated_at FROM agenda_upkeep
    WHERE chat_id = ? AND outcome IN ('open', 'confirmed') ORDER BY id`)
    .all(String(chatId ?? ""))
    .map((r) => ({
      id: Number(r.id), pointId: r.point_id, kind: r.kind, after: r.after ?? null, stage: r.stage ?? null, outcome: r.outcome,
      outdated: r.outdated_at !== null && r.outdated_at !== undefined,
    }));
}

/**
 * The rows of a chat for POINTS (without title/description), every outcome —
 * `[{ runId, pointId, kind, at, outcome, outdated }]`, oldest first. From this the agenda response reads what
 * happened after the mark of a point (agenda/operations.js) — read only if a point carries a mark (agenda/change.js
 * agendaView).
 */
function agendaUpkeepHistory(chatId) {
  return db.prepare(`SELECT run_id, point_id, kind, at, outcome, outdated_at FROM agenda_upkeep
    WHERE chat_id = ? AND point_id <> '' ORDER BY id`)
    .all(String(chatId ?? ""))
    .map((r) => ({
      runId: r.run_id, pointId: r.point_id, kind: r.kind, at: Number(r.at), outcome: r.outcome,
      outdated: r.outdated_at !== null && r.outdated_at !== undefined,
    }));
}

/**
 * The tally — `{ agentId }` ⇒ `{ changes, open, confirmed, corrected }` over all runs of the agent; `{ runIds }` ⇒
 * a Map runId → `{ changes, corrected }`, EVERY named id with an entry (a run without a change carries zeros).
 */
function agendaUpkeepTally({ agentId, runIds } = {}) {
  if (Array.isArray(runIds)) {
    const ids = [...new Set(runIds.map(String))];
    const out = new Map(ids.map((id) => [id, { changes: 0, corrected: 0 }]));
    if (!ids.length) return out;
    for (const r of db.prepare(`SELECT run_id, COUNT(*) AS n, SUM(outcome = 'corrected') AS k FROM agenda_upkeep
        WHERE run_id IN (${list(ids)}) GROUP BY run_id`).all(...ids)) {
      out.set(r.run_id, { changes: Number(r.n) || 0, corrected: Number(r.k) || 0 });
    }
    return out;
  }
  const r = db.prepare(`SELECT COUNT(*) AS n, SUM(outcome = 'open') AS o, SUM(outcome = 'confirmed') AS b, SUM(outcome = 'corrected') AS k
    FROM agenda_upkeep WHERE agent_id = ?`).get(String(agentId ?? ""));
  return { changes: Number(r?.n) || 0, open: Number(r?.o) || 0, confirmed: Number(r?.b) || 0, corrected: Number(r?.k) || 0 };
}

/** The most recent corrected rows of a chat (for the keeper's frame) — `[{ pointId, kind, prior, after, at }]`. */
function agendaUpkeepCorrections(chatId, limit = 10) {
  const n = Math.max(0, Math.min(100, Number(limit) || 0));
  if (!n) return [];
  return db.prepare(`SELECT point_id, kind, prior, after, at FROM agenda_upkeep WHERE chat_id = ? AND outcome = 'corrected'
    ORDER BY COALESCE(outcome_at, at) DESC, id DESC LIMIT ?`).all(String(chatId ?? ""), n)
    .map((r) => ({ pointId: r.point_id, kind: r.kind, prior: r.prior ?? null, after: r.after ?? null, at: Number(r.at) }));
}

/** Remove the rows of a chat (its closing path, chats/erase.js). */
function deleteAgendaUpkeepChat(chatId) {
  return db.prepare("DELETE FROM agenda_upkeep WHERE chat_id = ?").run(String(chatId ?? "")).changes;
}

// Wrapper export: via the facade (store.js `export *`), never imported directly (import-direction.test.js).
export {
  UPKEEP_KINDS, UPKEEP_OUTCOMES, initAgendaUpkeepSchema, enterAgendaUpkeep, agendaUpkeepOutcome, agendaUpkeepStanding, agendaUpkeepHistory,
  agendaUpkeepTally, agendaUpkeepCorrections, deleteAgendaUpkeepChat,
};
