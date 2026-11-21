// The data layer of the outer loop. Registration "outer-loop" at the end of store.js, AFTER "chat-search".
//
// FIVE TABLES, one FTS:
//   outer_loop_agents    the agents — origin workspace (project_id and chat_id NULL), project (project_id) or chat
//                         (chat_id); `summarizer` = 1 at most once per workspace (partial UNIQUE index), never with
//                         project or chat; likewise `agenda_keeper` = 1 (agenda keeper), never together with
//                         `summarizer`; `upkeep_mark` is its toggle "mark changes".
//                         `aborting_turn`: the toggle "abort on new message" of every agent — on: a turn in the
//                         observed chat aborts its open runs there; off: the run continues, a trigger meanwhile
//                         queues a follow-up run (outerloop/abort.js outerLoopTurnStart).
//   outer_loop_takeover  a workspace agent in a project: NO row means taken over, `deselected` = 1 means deselected.
//   outer_loop_active    an agent on a chat: three-valued with "no row" — the activation is COMPUTED
//                         (outerloop/activation.js), only what the human toggles per chat is written.
//   outer_loop_runs      one row per run: running · finished · parked · aborted · error; the watermark of the next
//                         run is `until_message_id` of the last FINISHED one (messages.id — timestamps are not
//                         unique per ms). `stage` (only a gapless agent): the track of the run was 2^-stage of the
//                         full one (outerloop/track.js) — the stage of the next is computed from the last.
//   outer_loop_notes     the output: one note per finished run, immutable, unbounded.
//   outer_loop_notes_fts full text ONLY over notes of a summarizer — contentless FTS5, insert trigger with WHEN on
//                         the agent row; without FTS5 or `contentless_delete` it is logged and the note search is
//                         gone (`outerLoopNoteSearchAvailable`). The name ends in `_fts`: the golden print skips it.
//
// No foreign keys: deletion goes through the close path (chats/erase.js tidyUp → deleteOuterLoopChat), the two
// delete lists in store/workspaces.js (deleteProject, deleteWorkspace — guard "delete lists ↔ schema" in
// schema-register.test.js) and the agent route (deleteOuterLoopAgent). Domain free like every topic file: what
// "active", "effective" or "target chat" means is computed by outerloop/ — here are only rows.
//
// DDL RULE: every TEXT column with a CHECK carries a DEFAULT — the delete-list guard seeds every scope table
// generically (NOT NULL without DEFAULT gets a seed string a CHECK would reject).
//
// The states of a run only change rows that are still OPEN (`running`, `parked`): a run aborted by deleting an
// agent (outerloop/abort.js) does not come back to life through a late writer — `outerLoopRunState` then returns
// null, `outerLoopRunEnd` false, as for a row that is gone.
import { db, inOneTransaction } from "./db.js";
import { chatSearchWords } from "./chat-search.js";

const STATES_OPEN = Object.freeze(["running", "parked"]);
const STATES_END = Object.freeze(["finished", "aborted", "error"]);
const list = (xs) => xs.map(() => "?").join(", ");
const json = (s, preset) => { try { const v = JSON.parse(s); return v ?? preset; } catch { return preset; } };
const countOrNull = (v) => (v === null || v === undefined ? null : Number(v));

let noteSearchAvailable = false;

// The two columns of the agenda keeper — ONE definition for the CREATE of a fresh table and the ALTER of an old one.
// The check "never with the summarizer, never with project or chat" therefore sits on the COLUMN (an ALTER cannot
// append a table check; SQLite checks a column check on append against every existing row, and it may read other
// columns).
const COLUMN_AGENDA_KEEPER = "agenda_keeper INTEGER NOT NULL DEFAULT 0 CHECK (agenda_keeper IN (0, 1) "
  + "AND (agenda_keeper = 0 OR (summarizer = 0 AND project_id IS NULL AND chat_id IS NULL)))";
const COLUMN_UPKEEP_MARK = "upkeep_mark INTEGER NOT NULL DEFAULT 1 CHECK (upkeep_mark IN (0, 1))";
// The toggle "abort on new message" — the same rule: ONE definition for CREATE and ALTER.
const COLUMN_ABORTING_TURN = "aborting_turn INTEGER NOT NULL DEFAULT 0 CHECK (aborting_turn IN (0, 1))";
const COLUMN_STAGE = "stage INTEGER NOT NULL DEFAULT 0 CHECK (stage >= 0)";

function initOuterLoopSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS outer_loop_agents (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      project_id TEXT,
      chat_id TEXT,
      name TEXT NOT NULL,
      job TEXT NOT NULL DEFAULT '',
      trigger TEXT NOT NULL DEFAULT '[]',
      area TEXT NOT NULL DEFAULT 'coding' CHECK (area IN ('coding', 'managing')),
      provider TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      effort TEXT NOT NULL DEFAULT '',
      default_new INTEGER NOT NULL DEFAULT 0 CHECK (default_new IN (0, 1)),
      default_new_since INTEGER,
      tools TEXT NOT NULL DEFAULT '[]',
      builtin TEXT NOT NULL DEFAULT '[]',
      mcp TEXT NOT NULL DEFAULT '{}',
      summarizer INTEGER NOT NULL DEFAULT 0 CHECK (summarizer IN (0, 1)),
      template_revision INTEGER,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      ${COLUMN_AGENDA_KEEPER},
      ${COLUMN_UPKEEP_MARK},
      ${COLUMN_ABORTING_TURN},
      CHECK (project_id IS NULL OR chat_id IS NULL),
      CHECK (summarizer = 0 OR (project_id IS NULL AND chat_id IS NULL))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS outer_loop_summarizer_per_ws ON outer_loop_agents(workspace_id) WHERE summarizer = 1;
    CREATE INDEX IF NOT EXISTS outer_loop_agents_ws ON outer_loop_agents(workspace_id);
    CREATE INDEX IF NOT EXISTS outer_loop_agents_project ON outer_loop_agents(project_id) WHERE project_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS outer_loop_agents_chat ON outer_loop_agents(chat_id) WHERE chat_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS outer_loop_takeover (
      agent_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      deselected INTEGER NOT NULL CHECK (deselected IN (0, 1)),
      changed_at INTEGER NOT NULL,
      PRIMARY KEY (agent_id, project_id)
    );

    CREATE TABLE IF NOT EXISTS outer_loop_active (
      agent_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      since INTEGER NOT NULL,
      PRIMARY KEY (agent_id, chat_id)
    );
    CREATE INDEX IF NOT EXISTS outer_loop_active_chat ON outer_loop_active(chat_id);

    CREATE TABLE IF NOT EXISTS outer_loop_runs (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      trigger TEXT NOT NULL DEFAULT 'quiet' CHECK (trigger IN ('quiet', 'interval', 'run_end', 'clockTime', 'afterRun')),
      state TEXT NOT NULL DEFAULT 'running' CHECK (state IN ('running', 'finished', 'parked', 'aborted', 'error')),
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      parked_until INTEGER,
      attempts INTEGER NOT NULL DEFAULT 1,
      from_message_id INTEGER NOT NULL DEFAULT 0,
      until_message_id INTEGER NOT NULL DEFAULT 0,
      item_set TEXT NOT NULL DEFAULT '{}',
      error TEXT NOT NULL DEFAULT '',
      provider TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      billing TEXT NOT NULL DEFAULT '',
      input INTEGER NOT NULL DEFAULT 0,
      output INTEGER NOT NULL DEFAULT 0,
      cached INTEGER NOT NULL DEFAULT 0,
      cost REAL,
      session_id TEXT NOT NULL DEFAULT '',
      ${COLUMN_STAGE}
    );
    CREATE INDEX IF NOT EXISTS outer_loop_runs_agent ON outer_loop_runs(agent_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS outer_loop_runs_chat ON outer_loop_runs(chat_id, agent_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS outer_loop_runs_open ON outer_loop_runs(state) WHERE state IN ('running', 'parked');

    CREATE TABLE IF NOT EXISTS outer_loop_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS outer_loop_notes_chat ON outer_loop_notes(chat_id, agent_id, id DESC);
  `);
  // The agenda keeper columns on an older store: the same definition as in the CREATE above, appended (a fresh table
  // carries them in the same place — at the end —, the column order is the same in both). The index only afterwards:
  // in the old table the column would not exist before.
  const columns = new Set(db.prepare("PRAGMA table_info(outer_loop_agents)").all().map((c) => c.name));
  if (!columns.has("agenda_keeper")) db.exec(`ALTER TABLE outer_loop_agents ADD COLUMN ${COLUMN_AGENDA_KEEPER}`);
  if (!columns.has("upkeep_mark")) db.exec(`ALTER TABLE outer_loop_agents ADD COLUMN ${COLUMN_UPKEEP_MARK}`);
  // The toggle on an older store: the agenda keeper keeps what was fixed until then (abort on turn); every other
  // agent — the timeline agent too — queues from now on.
  if (!columns.has("aborting_turn")) {
    inOneTransaction(() => {
      db.exec(`ALTER TABLE outer_loop_agents ADD COLUMN ${COLUMN_ABORTING_TURN}`);
      db.exec("UPDATE outer_loop_agents SET aborting_turn = 1 WHERE agenda_keeper = 1");
    });
  }
  const runColumns = new Set(db.prepare("PRAGMA table_info(outer_loop_runs)").all().map((c) => c.name));
  if (!runColumns.has("stage")) db.exec(`ALTER TABLE outer_loop_runs ADD COLUMN ${COLUMN_STAGE}`);
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS outer_loop_agenda_keeper_je_ws ON outer_loop_agents(workspace_id) WHERE agenda_keeper = 1");
  // The FTS in ONE transaction with its triggers: no index, no triggers — a trigger on a missing table would
  // otherwise fail every note insert ("no such table"), even without search.
  try {
    inOneTransaction(() => {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS outer_loop_notes_fts USING fts5(
          text, content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 2');
        CREATE TRIGGER IF NOT EXISTS outer_loop_notes_fts_ai AFTER INSERT ON outer_loop_notes
          WHEN (SELECT summarizer FROM outer_loop_agents WHERE id = new.agent_id) = 1
          BEGIN INSERT INTO outer_loop_notes_fts(rowid, text) VALUES (new.id, new.text); END;
        CREATE TRIGGER IF NOT EXISTS outer_loop_notes_fts_ad AFTER DELETE ON outer_loop_notes
          BEGIN DELETE FROM outer_loop_notes_fts WHERE rowid = old.id; END;
      `);
    });
    noteSearchAvailable = true;
  } catch (e) {
    noteSearchAvailable = false;
    console.error("[store] FTS5 for the summarizer notes not available — the note search is gone:",
      String(e?.message || e).slice(0, 200));
  }
}

// ── Shapes ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const originOf = (r) => (r.chat_id ? "chat" : r.project_id ? "project" : "workspace");

function agentFrom(r) {
  if (!r) return null;
  return {
    id: r.id, workspaceId: r.workspace_id, projectId: r.project_id ?? null, chatId: r.chat_id ?? null, origin: originOf(r),
    name: r.name, job: r.job,
    trigger: (() => { const v = json(r.trigger, []); return Array.isArray(v) ? v : []; })(),
    area: r.area, provider: r.provider, model: r.model, effort: r.effort,
    defaultNew: r.default_new === 1, defaultNewSince: countOrNull(r.default_new_since),
    tools: (() => { const v = json(r.tools, []); return Array.isArray(v) ? v : []; })(),
    builtin: (() => { const v = json(r.builtin, []); return Array.isArray(v) ? v : []; })(),
    mcp: (() => { const v = json(r.mcp, {}); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; })(),
    summarizer: r.summarizer === 1, templateRevision: countOrNull(r.template_revision), enabled: r.enabled === 1,
    agendaKeeper: r.agenda_keeper === 1, markUpkeep: r.upkeep_mark !== 0, abortingTurn: r.aborting_turn === 1,
    // The timeline agent: NO column — recognized by its fixed id `<wid>-71e11e` (deterministic like the keeper's; an
    // agent's own id is a UUID and never has this form). `gapless` is a trait of its template, not a toggle: only it
    // reads shortened tracks from the start (outerloop/input.js, run.js).
    timeline: r.id === outerLoopTimelineAgentId(r.workspace_id), gapless: r.id === outerLoopTimelineAgentId(r.workspace_id),
    createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
  };
}

function runFrom(r) {
  if (!r) return null;
  return {
    id: r.id, agentId: r.agent_id, chatId: r.chat_id, trigger: r.trigger, state: r.state,
    startedAt: Number(r.started_at), endedAt: countOrNull(r.ended_at), parkedUntil: countOrNull(r.parked_until),
    attempts: Number(r.attempts) || 0, fromMessageId: Number(r.from_message_id) || 0, untilMessageId: Number(r.until_message_id) || 0,
    set: (() => { const v = json(r.item_set, {}); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; })(),
    error: r.error, provider: r.provider, model: r.model, billing: r.billing,
    input: Number(r.input) || 0, output: Number(r.output) || 0, cached: Number(r.cached) || 0,
    cost: r.cost === null || r.cost === undefined ? null : Number(r.cost), sessionId: r.session_id, stage: Number(r.stage) || 0,
  };
}

const noteFrom = (r) => (r ? { id: Number(r.id), agentId: r.agent_id, chatId: r.chat_id, runId: r.run_id, text: r.text, at: Number(r.created_at) } : null);

// ── Agents ──────────────────────────────────────────────────────────────────────────────────────────────────────────

// The columns changeOuterLoopAgent accepts (camelCase → column, encoding). Origin (workspace, project, chat), role
// (`summarizer`, `agendaKeeper`) and `createdAt` are changed by nobody: an agent does not change its origin, it is
// created anew. `markUpkeep` only makes sense for the agenda keeper — the route checks that (outerloop/routes.js,
// 400), not the row.
const CHANGEABLE = Object.freeze({
  name: ["name", (v) => String(v)],
  job: ["job", (v) => String(v)],
  trigger: ["trigger", (v) => JSON.stringify(Array.isArray(v) ? v : [])],
  area: ["area", (v) => String(v)],
  provider: ["provider", (v) => String(v ?? "")],
  model: ["model", (v) => String(v ?? "")],
  effort: ["effort", (v) => String(v ?? "")],
  defaultNew: ["default_new", (v) => (v ? 1 : 0)],
  defaultNewSince: ["default_new_since", (v) => (v === null || v === undefined ? null : Number(v))],
  tools: ["tools", (v) => JSON.stringify(Array.isArray(v) ? v : [])],
  builtin: ["builtin", (v) => JSON.stringify(Array.isArray(v) ? v : [])],
  mcp: ["mcp", (v) => JSON.stringify(v && typeof v === "object" && !Array.isArray(v) ? v : {})],
  templateRevision: ["template_revision", (v) => (v === null || v === undefined ? null : Number(v))],
  enabled: ["enabled", (v) => (v ? 1 : 0)],
  markUpkeep: ["upkeep_mark", (v) => (v ? 1 : 0)],
  abortingTurn: ["aborting_turn", (v) => (v ? 1 : 0)],
});

/** Create an agent. Throws on UNIQUE (a second summarizer or agenda keeper in the workspace) and on a violated CHECK. */
function createOuterLoopAgent({
  id, workspaceId, projectId = null, chatId = null, name, job = "", trigger = [], area = "coding", provider = "", model = "",
  effort = "", defaultNew = false, defaultNewSince = null, tools = [], builtin = [], mcp = {}, summarizer = false,
  templateRevision = null, enabled = true, agendaKeeper = false, markUpkeep = true, abortingTurn = false, at = Date.now(),
}) {
  db.prepare(`INSERT INTO outer_loop_agents (id, workspace_id, project_id, chat_id, name, job, trigger, area, provider, model,
      effort, default_new, default_new_since, tools, builtin, mcp, summarizer, template_revision, enabled, created_at, updated_at,
      agenda_keeper, upkeep_mark, aborting_turn)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    String(id), String(workspaceId), projectId ? String(projectId) : null, chatId ? String(chatId) : null, String(name), String(job ?? ""),
    CHANGEABLE.trigger[1](trigger), String(area || "coding"), String(provider ?? ""), String(model ?? ""), String(effort ?? ""),
    defaultNew ? 1 : 0, defaultNewSince === null || defaultNewSince === undefined ? null : Number(defaultNewSince),
    CHANGEABLE.tools[1](tools), CHANGEABLE.builtin[1](builtin), CHANGEABLE.mcp[1](mcp), summarizer ? 1 : 0,
    templateRevision === null || templateRevision === undefined ? null : Number(templateRevision), enabled ? 1 : 0, Number(at), Number(at),
    agendaKeeper ? 1 : 0, markUpkeep ? 1 : 0, abortingTurn ? 1 : 0,
  );
  return outerLoopAgent(id);
}

const outerLoopAgent = (id) => agentFrom(db.prepare("SELECT * FROM outer_loop_agents WHERE id = ?").get(String(id ?? "")));

const GROUP = { summarizer: 0, keeper: 1, timeline: 2, workspace: 3, project: 4, chat: 5 };
const groupOf = (a) => (a.summarizer ? GROUP.summarizer : a.agendaKeeper ? GROUP.keeper : a.timeline ? GROUP.timeline : GROUP[a.origin]);

/** All agents of a workspace: summarizer, agenda keeper, timeline, workspace, project, chat — by name within each group. */
function outerLoopAgentsOf(workspaceId) {
  return db.prepare("SELECT * FROM outer_loop_agents WHERE workspace_id = ?").all(String(workspaceId ?? "")).map(agentFrom)
    .sort((x, y) => groupOf(x) - groupOf(y) || x.name.localeCompare(y.name, "de") || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
}

/** The chat-owned agents of a chat (origin chat), by name. */
const outerLoopAgentsOfTheChat = (chatId) =>
  db.prepare("SELECT * FROM outer_loop_agents WHERE chat_id = ?").all(String(chatId ?? "")).map(agentFrom)
    .sort((x, y) => x.name.localeCompare(y.name, "de") || (x.id < y.id ? -1 : 1));

const outerLoopSummarizer = (workspaceId) =>
  agentFrom(db.prepare("SELECT * FROM outer_loop_agents WHERE workspace_id = ? AND summarizer = 1").get(String(workspaceId ?? "")));

/** The id of the timeline agent of a workspace — hex digits and dashes like the keeper's. */
const outerLoopTimelineAgentId = (workspaceId) => `${workspaceId}-71e11e`;

/** The timeline agent of a workspace — at most one (its id is fixed), otherwise null. */
const outerLoopTimelineAgent = (workspaceId) => (workspaceId ? outerLoopAgent(outerLoopTimelineAgentId(workspaceId)) : null);

/** The agenda keeper of a workspace — at most one, otherwise null. */
const outerLoopAgendaKeeper = (workspaceId) =>
  agentFrom(db.prepare("SELECT * FROM outer_loop_agents WHERE workspace_id = ? AND agenda_keeper = 1").get(String(workspaceId ?? "")));

/**
 * Change only the passed fields (keys from CHANGEABLE; `at` sets `updated_at`, default now). An unknown key THROWS —
 * a silent omission would mean reporting a change as "saved" that never arrived. → agent | null (unknown id).
 */
function changeOuterLoopAgent(id, fields = {}) {
  const { at = Date.now(), ...rest } = fields || {};
  const unknown = Object.keys(rest).filter((k) => !Object.hasOwn(CHANGEABLE, k));
  if (unknown.length) throw new Error(`changeOuterLoopAgent: not changeable: ${unknown.join(", ")}`);
  const columns = []; const values = [];
  for (const [k, v] of Object.entries(rest)) {
    if (v === undefined) continue;
    const [column, encode] = CHANGEABLE[k];
    columns.push(`${column} = ?`); values.push(encode(v));
  }
  columns.push("updated_at = ?"); values.push(Number(at));
  const n = db.prepare(`UPDATE outer_loop_agents SET ${columns.join(", ")} WHERE id = ?`).run(...values, String(id ?? "")).changes;
  return n ? outerLoopAgent(id) : null;
}

/**
 * Remove an agent with its takeover, activation, notes and runs — in ONE transaction, plus its agenda upkeep log
 * (`agenda_upkeep`, store/agenda-upkeep.js — through SQL here, a topic file imports no other; the table exists
 * once the store is initialized). Checks (summarizer, agenda keeper, run) are done by the route.
 */
function deleteOuterLoopAgent(id) {
  const aid = String(id ?? "");
  return inOneTransaction(() => {
    db.prepare("DELETE FROM agenda_upkeep WHERE agent_id = ?").run(aid);
    db.prepare("DELETE FROM outer_loop_takeover WHERE agent_id = ?").run(aid);
    db.prepare("DELETE FROM outer_loop_active WHERE agent_id = ?").run(aid);
    db.prepare("DELETE FROM outer_loop_notes WHERE agent_id = ?").run(aid);
    db.prepare("DELETE FROM outer_loop_runs WHERE agent_id = ?").run(aid);
    return db.prepare("DELETE FROM outer_loop_agents WHERE id = ?").run(aid).changes > 0;
  });
}

/**
 * Strike the choice of deleted Coding MCP servers from every agent — called by the delete paths of a server
 * (store/toolchain.js deleteMcpServer, store/workspaces.js deleteProject). The choice belongs to the server.
 * Without this the id would stay, the editor would send it back on every save, and every save would be a 400
 * "unknown MCP server" — the agent could no longer be changed. A server that is only SWITCHED OFF keeps its choice
 * (outerloop/catalog.js normalizeMcpChoice still knows it). → number of changed agents.
 */
function dropOuterLoopMcpChoice(serverIds, at = Date.now()) {
  const ids = new Set([...(serverIds || [])].map(String));
  if (!ids.size) return 0;
  let n = 0;
  for (const r of db.prepare("SELECT id, mcp FROM outer_loop_agents WHERE mcp IS NOT NULL AND mcp <> '{}'").all()) {
    let mcp = null;
    try { mcp = JSON.parse(r.mcp); } catch { continue; }
    if (!mcp || typeof mcp !== "object" || Array.isArray(mcp) || !Object.keys(mcp).some((k) => ids.has(k))) continue;
    const rest = Object.fromEntries(Object.entries(mcp).filter(([k]) => !ids.has(k)));
    db.prepare("UPDATE outer_loop_agents SET mcp = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(rest), Number(at), r.id);
    n++;
  }
  return n;
}

// ── Takeover per project (workspace agents) ─────────────────────────────────────────────────────────────────────────

function setOuterLoopTakeover(agentId, projectId, takenOver, at = Date.now()) {
  db.prepare(`INSERT INTO outer_loop_takeover (agent_id, project_id, deselected, changed_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(agent_id, project_id) DO UPDATE SET deselected = excluded.deselected, changed_at = excluded.changed_at`)
    .run(String(agentId), String(projectId), takenOver ? 0 : 1, Number(at));
}

/** Taken over? No row means yes. */
const outerLoopTakenOver = (agentId, projectId) =>
  db.prepare("SELECT deselected FROM outer_loop_takeover WHERE agent_id = ? AND project_id = ?").get(String(agentId ?? ""), String(projectId ?? ""))?.deselected !== 1;

/** The projects in which a workspace agent is deselected. */
const outerLoopNotTakenOver = (agentId) =>
  db.prepare("SELECT project_id AS p FROM outer_loop_takeover WHERE agent_id = ? AND deselected = 1 ORDER BY project_id").all(String(agentId ?? "")).map((r) => r.p);

// ── Activation per chat (three-valued with "no row") ────────────────────────────────────────────────────────────────

function setOuterLoopActive(agentId, chatId, enabled, at = Date.now()) {
  db.prepare(`INSERT INTO outer_loop_active (agent_id, chat_id, enabled, since) VALUES (?, ?, ?, ?)
    ON CONFLICT(agent_id, chat_id) DO UPDATE SET enabled = excluded.enabled, since = excluded.since`)
    .run(String(agentId), String(chatId), enabled ? 1 : 0, Number(at));
  return { enabled: Boolean(enabled), since: Number(at) };
}

function outerLoopActiveRow(agentId, chatId) {
  const r = db.prepare("SELECT enabled, since FROM outer_loop_active WHERE agent_id = ? AND chat_id = ?").get(String(agentId ?? ""), String(chatId ?? ""));
  return r ? { enabled: r.enabled === 1, since: Number(r.since) } : null;
}

/** Map agentId → { enabled, since } — all rows of a chat in ONE query (the chat info computes per agent). */
const outerLoopActiveRowsOfTheChat = (chatId) =>
  new Map(db.prepare("SELECT agent_id, enabled, since FROM outer_loop_active WHERE chat_id = ?").all(String(chatId ?? ""))
    .map((r) => [r.agent_id, { enabled: r.enabled === 1, since: Number(r.since) }]));

// ── Runs ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Create a run (`running`, `attempts` 1). `provider`/`model` may already be set at start (otherwise only at the end). */
function createOuterLoopRun({ id, agentId, chatId, trigger, fromMessageId = 0, set = {}, provider = "", model = "", stage = 0, startedAt = Date.now() }) {
  db.prepare(`INSERT INTO outer_loop_runs (id, agent_id, chat_id, trigger, state, started_at, attempts, from_message_id, item_set, provider, model, stage)
    VALUES (?, ?, ?, ?, 'running', ?, 1, ?, ?, ?, ?, ?)`).run(
    String(id), String(agentId), String(chatId), String(trigger), Number(startedAt), Number(fromMessageId) || 0,
    JSON.stringify(set && typeof set === "object" ? set : {}), String(provider ?? ""), String(model ?? ""), Math.max(0, Math.floor(Number(stage) || 0)));
  return outerLoopRun(id);
}

const outerLoopRun = (id) => runFrom(db.prepare("SELECT * FROM outer_loop_runs WHERE id = ?").get(String(id ?? "")));

/**
 * Set the state of an OPEN run. An end state (finished/aborted/error) sets `ended_at`; `parked` carries
 * `parkedUntil`, every other state clears it. → run | null (null: row gone OR already ended — the caller writes
 * nothing further).
 */
function outerLoopRunState(id, state, { parkedUntil = null, error = "", increaseAttempts = false, set, at = Date.now() } = {}) {
  const end = STATES_END.includes(state);
  const n = db.prepare(`UPDATE outer_loop_runs SET state = ?, parked_until = ?, error = ?, attempts = attempts + ?,
      item_set = COALESCE(?, item_set), ended_at = CASE WHEN ? THEN ? ELSE NULL END
    WHERE id = ? AND state IN (${list(STATES_OPEN)})`).run(
    String(state), state === "parked" && parkedUntil !== null && parkedUntil !== undefined ? Number(parkedUntil) : null, String(error ?? ""),
    increaseAttempts ? 1 : 0, set === undefined ? null : JSON.stringify(set && typeof set === "object" ? set : {}),
    end ? 1 : 0, Number(at), String(id ?? ""), ...STATES_OPEN).changes;
  return n ? outerLoopRun(id) : null;
}

/**
 * The end of an OPEN run: state, watermark, consumption, session. Fields that are missing (undefined) stay as
 * they are. → bool (false: row gone or already ended).
 */
function outerLoopRunEnd(id, { state, error = "", untilMessageId, provider, model, billing, input, output, cached, cost, sessionId, endedAt = Date.now() } = {}) {
  const set = ["state = ?", "error = ?", "ended_at = ?", "parked_until = NULL"];
  const values = [String(state), String(error ?? ""), Number(endedAt)];
  const opt = { until_message_id: untilMessageId, provider, model, billing, input, output, cached, session_id: sessionId };
  for (const [column, v] of Object.entries(opt)) {
    if (v === undefined) continue;
    set.push(`${column} = ?`);
    values.push(["until_message_id", "input", "output", "cached"].includes(column) ? Number(v) || 0 : String(v ?? ""));
  }
  if (cost !== undefined) { set.push("cost = ?"); values.push(cost === null ? null : Number(cost)); }
  return db.prepare(`UPDATE outer_loop_runs SET ${set.join(", ")} WHERE id = ? AND state IN (${list(STATES_OPEN)})`)
    .run(...values, String(id ?? ""), ...STATES_OPEN).changes > 0;
}

/** Does the run still apply? Row there, open (`running`|`parked`), its agent and its chat exist. */
const outerLoopRunApplies = (id) => Boolean(db.prepare(`SELECT 1 FROM outer_loop_runs l
    JOIN outer_loop_agents a ON a.id = l.agent_id JOIN chats c ON c.id = l.chat_id
   WHERE l.id = ? AND l.state IN (${list(STATES_OPEN)})`).get(String(id ?? ""), ...STATES_OPEN));

const outerLoopRunsOpen = () =>
  db.prepare("SELECT id, agent_id, chat_id, started_at FROM outer_loop_runs WHERE state = 'running' ORDER BY started_at, rowid").all()
    .map((r) => ({ id: r.id, agentId: r.agent_id, chatId: r.chat_id, startedAt: Number(r.started_at) }));

const outerLoopRunsParked = () =>
  db.prepare("SELECT id, agent_id, chat_id, trigger, parked_until, attempts FROM outer_loop_runs WHERE state = 'parked' ORDER BY parked_until, rowid").all()
    .map((r) => ({ id: r.id, agentId: r.agent_id, chatId: r.chat_id, trigger: r.trigger, parkedUntil: countOrNull(r.parked_until), attempts: Number(r.attempts) || 0 }));

/** At start: every `running` of a dead process becomes `aborted` — `parked` stays. → count. */
const abortOuterLoopRuns = (reason, at = Date.now()) =>
  db.prepare("UPDATE outer_loop_runs SET state = 'aborted', error = ?, ended_at = ? WHERE state = 'running'").run(String(reason ?? ""), Number(at)).changes;

/**
 * Abort the OPEN runs (`running` AND `parked`) of these agents — the path of outerloop/abort.js when an agent,
 * project or workspace is deleted: a parked run would otherwise have a wakeup for a deleted agent. → count.
 */
function outerLoopRunsAbortOf(agentIds, reason, at = Date.now()) {
  const ids = [...new Set((Array.isArray(agentIds) ? agentIds : []).map(String).filter(Boolean))];
  if (!ids.length) return 0;
  return db.prepare(`UPDATE outer_loop_runs SET state = 'aborted', error = ?, ended_at = ?, parked_until = NULL
     WHERE agent_id IN (SELECT value FROM json_each(?)) AND state IN (${list(STATES_OPEN)})`)
    .run(String(reason ?? ""), Number(at), JSON.stringify(ids), ...STATES_OPEN).changes;
}

/**
 * The runs of an agent, newest first (`started_at DESC, rowid DESC`). Paging uses `after` = the id of the LAST run
 * of the previous page: resolved to (started_at, rowid) and continued with
 * `(started_at < ? OR (started_at = ? AND rowid < ?))` — a cursor over `startedAt` alone loses runs of the same
 * millisecond at the page boundary (a tick starts several chats synchronously in a row). → `{ items, additional }`,
 * or `null` if `after` is not a run of THIS agent (the route answers 400 — an unknown cursor is not an empty page).
 */
function outerLoopRunsOfAgent(agentId, { limit = 50, after: to = null } = {}) {
  const n = Math.max(1, Math.min(500, Math.floor(Number(limit) || 50)));
  const aid = String(agentId ?? "");
  let cursor = null;
  if (to !== null && to !== undefined && to !== "") {
    cursor = db.prepare("SELECT started_at AS s, rowid AS r FROM outer_loop_runs WHERE id = ? AND agent_id = ?").get(String(to), aid);
    if (!cursor) return null;
  }
  const rows = cursor
    ? db.prepare(`SELECT * FROM outer_loop_runs WHERE agent_id = ? AND (started_at < ? OR (started_at = ? AND rowid < ?))
        ORDER BY started_at DESC, rowid DESC LIMIT ?`).all(aid, cursor.s, cursor.s, cursor.r, n + 1)
    : db.prepare("SELECT * FROM outer_loop_runs WHERE agent_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?").all(aid, n + 1);
  return { items: rows.slice(0, n).map(runFrom), additional: rows.length > n };
}

/** The most recent run of an agent on ONE chat, in any state (the chat info: "last run …") — through the index per pair. */
const outerLoopLastRunOn = (agentId, chatId) =>
  runFrom(db.prepare(`SELECT * FROM outer_loop_runs WHERE chat_id = ? AND agent_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1`)
    .get(String(chatId ?? ""), String(agentId ?? "")));

/**
 * The last start per chat of an agent — over ALL its runs on these chats, not over a window of the most recent
 * (with a window a chat whose last start lay behind it counted as "never started", and interval and clock time
 * fired early). ONE grouped query over the index (chat_id, agent_id, started_at).
 * → Map chatId → { all: ms|null, clock: ms|null } (`clock`: the last with trigger `clockTime`); a chat without a
 * run is missing.
 */
function outerLoopLastStarts(agentId, chatIds) {
  const ids = [...new Set((Array.isArray(chatIds) ? chatIds : []).map(String))];
  const out = new Map();
  if (!ids.length) return out;
  const rows = db.prepare(`SELECT chat_id AS c, MAX(started_at) AS "all",
      MAX(CASE WHEN trigger = 'clockTime' THEN started_at END) AS clock
    FROM outer_loop_runs WHERE agent_id = ? AND chat_id IN (SELECT value FROM json_each(?)) GROUP BY chat_id`)
    .all(String(agentId ?? ""), JSON.stringify(ids));
  for (const r of rows) out.set(r.c, { all: countOrNull(r.all), clock: countOrNull(r.clock) });
  return out;
}

/**
 * Write the CLI session of an OPEN run as soon as it is known (the first sign of life with `sessionId`) — not only
 * at the finished end: a run that is aborted (chat deleted, agent deleted, server end) would otherwise leave its
 * transcript behind, because the close path (chats/sessions.js through outerLoopSessionsOf) only finds rows with a
 * session. Only an empty session is set (the first one counts). → bool.
 */
const outerLoopRunSession = (id, sessionId) => Boolean(sessionId) && db.prepare(`UPDATE outer_loop_runs SET session_id = ?
    WHERE id = ? AND state IN (${list(STATES_OPEN)}) AND session_id = ''`).run(String(sessionId), String(id ?? ""), ...STATES_OPEN).changes > 0;

/** Abort specific OPEN runs (deleting a project: only the runs working there, not all of their agents'). → count. */
function outerLoopRunsAbortIds(runIds, reason, at = Date.now()) {
  const ids = [...new Set((Array.isArray(runIds) ? runIds : []).map(String).filter(Boolean))];
  if (!ids.length) return 0;
  return db.prepare(`UPDATE outer_loop_runs SET state = 'aborted', error = ?, ended_at = ?, parked_until = NULL
     WHERE id IN (SELECT value FROM json_each(?)) AND state IN (${list(STATES_OPEN)})`)
    .run(String(reason ?? ""), Number(at), JSON.stringify(ids), ...STATES_OPEN).changes;
}

/** Sum over all runs of an agent; `cost` is the sum of the priced ones (null if none carried a price). */
function outerLoopRunSum(agentId) {
  const r = db.prepare(`SELECT COUNT(*) AS runs, COALESCE(SUM(input), 0) AS input, COALESCE(SUM(output), 0) AS output,
      COALESCE(SUM(cached), 0) AS cached, SUM(cost) AS cost FROM outer_loop_runs WHERE agent_id = ?`).get(String(agentId ?? ""));
  return { runs: Number(r.runs) || 0, input: Number(r.input) || 0, output: Number(r.output) || 0, cached: Number(r.cached) || 0,
    cost: r.cost === null || r.cost === undefined ? null : Number(r.cost) };
}

const outerLoopLastFinishedRun = (agentId, chatId) =>
  runFrom(db.prepare(`SELECT * FROM outer_loop_runs WHERE agent_id = ? AND chat_id = ? AND state = 'finished'
    ORDER BY started_at DESC, rowid DESC LIMIT 1`).get(String(agentId ?? ""), String(chatId ?? "")));

// The last run of this pair that says something about its track (outerloop/track.js): `finished`, or `error` after
// the core has worked (`input` > 0 — a start that failed at the gate, spawn or provider says nothing about the track).
const outerLoopLastTrackRun = (agentId, chatId) =>
  runFrom(db.prepare(`SELECT * FROM outer_loop_runs WHERE agent_id = ? AND chat_id = ? AND (state = 'finished' OR (state = 'error' AND input > 0))
    ORDER BY started_at DESC, rowid DESC LIMIT 1`).get(String(agentId ?? ""), String(chatId ?? "")));

const outerLoopRunningOn = (agentId, chatId) =>
  Boolean(db.prepare("SELECT 1 FROM outer_loop_runs WHERE agent_id = ? AND chat_id = ? AND state = 'running'").get(String(agentId ?? ""), String(chatId ?? "")));

const outerLoopRunningCount = (agentId) =>
  Number(db.prepare("SELECT COUNT(*) AS n FROM outer_loop_runs WHERE agent_id = ? AND state = 'running'").get(String(agentId ?? ""))?.n) || 0;

// ── Notes ───────────────────────────────────────────────────────────────────────────────────────────────────────────

function createOuterLoopNote({ agentId, chatId, runId, text, at = Date.now() }) {
  const r = db.prepare("INSERT INTO outer_loop_notes (agent_id, chat_id, run_id, text, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(String(agentId), String(chatId), String(runId), String(text ?? ""), Number(at));
  return noteFrom(db.prepare("SELECT * FROM outer_loop_notes WHERE id = ?").get(Number(r.lastInsertRowid)));
}

/** The notes on a chat (optionally of one agent only), newest first; `before` = note id (strictly smaller) for paging. */
function outerLoopNotes(chatId, { agentId = null, limit = 20, before = null } = {}) {
  const n = Math.max(1, Math.min(500, Math.floor(Number(limit) || 20)));
  const v = before === null || before === undefined || before === "" ? null : Number(before);
  const a = agentId === null || agentId === undefined || agentId === "" ? null : String(agentId);
  const rows = db.prepare(`SELECT * FROM outer_loop_notes WHERE chat_id = ? AND (? IS NULL OR agent_id = ?) AND (? IS NULL OR id < ?)
    ORDER BY id DESC LIMIT ?`).all(String(chatId ?? ""), a, a, v, v, n + 1);
  return { items: rows.slice(0, n).map(noteFrom), additional: rows.length > n };
}

const outerLoopLastNote = (agentId, chatId) =>
  noteFrom(db.prepare("SELECT * FROM outer_loop_notes WHERE agent_id = ? AND chat_id = ? ORDER BY id DESC LIMIT 1").get(String(agentId ?? ""), String(chatId ?? "")));

/** Per chat the newest note of the summarizer of ITS workspace (cbase_agents_list). → Map chatId → note. */
function summarizerNotesNewest(chatIds) {
  const ids = [...new Set((Array.isArray(chatIds) ? chatIds : []).map(String).filter(Boolean))];
  if (!ids.length) return new Map();
  const rows = db.prepare(`SELECT n.* FROM (
      SELECT n.id AS id, ROW_NUMBER() OVER (PARTITION BY n.chat_id ORDER BY n.id DESC) AS seq
        FROM outer_loop_notes n
        JOIN outer_loop_agents a ON a.id = n.agent_id AND a.summarizer = 1
        JOIN chats c ON c.id = n.chat_id AND c.workspace_id = a.workspace_id
       WHERE n.chat_id IN (SELECT value FROM json_each(?))) x
    JOIN outer_loop_notes n ON n.id = x.id WHERE x.seq = 1`).all(JSON.stringify(ids));
  return new Map(rows.map((r) => [r.chat_id, noteFrom(r)]));
}

const outerLoopNoteSearchAvailable = () => noteSearchAvailable;

/**
 * Full text over the summarizer notes in the chats `chatIds` (which the caller may read — nothing is checked here).
 * Words like the chat search (`chatSearchWords`: from two characters, each a prefix, all in the same note).
 * → `[{ id, chatId, text, at }]` by bm25; empty if the search is missing or no word remains.
 */
function outerLoopNoteSearch(request, chatIds, { limit = 200 } = {}) {
  const words = chatSearchWords(request);
  const ids = [...new Set((Array.isArray(chatIds) ? chatIds : []).map(String).filter(Boolean))];
  if (!noteSearchAvailable || !words.length || !ids.length) return [];
  const n = Math.max(1, Math.min(1000, Math.floor(Number(limit) || 200)));
  return db.prepare(`SELECT n.id AS id, n.chat_id AS chatId, n.text AS text, n.created_at AS at
      FROM outer_loop_notes_fts f JOIN outer_loop_notes n ON n.id = f.rowid
     WHERE outer_loop_notes_fts MATCH ? AND n.chat_id IN (SELECT value FROM json_each(?))
     ORDER BY bm25(outer_loop_notes_fts), n.id DESC LIMIT ?`)
    .all(words.map((w) => `"${w.replace(/"/g, "")}"*`).join(" "), JSON.stringify(ids), n)
    .map((r) => ({ id: Number(r.id), chatId: r.chatId, text: r.text, at: Number(r.at) }));
}

// ── The observed chat (input, tick, analysis) ───────────────────────────────────────────────────────────────────────

const rolesList = (roles) => [...new Set((roles instanceof Set ? [...roles] : Array.isArray(roles) ? roles : []).map(String))];

/** New rows above the watermark: `id > fromId AND created_at >= since AND role IN roles`. → `{ count, untilId }` (untilId = fromId if none). */
function outerLoopNewRows(chatId, { fromId = 0, since = 0, roles } = {}) {
  const r = rolesList(roles);
  if (!r.length) return { count: 0, untilId: Number(fromId) || 0 };
  const z = db.prepare(`SELECT COUNT(*) AS n, MAX(id) AS until FROM messages WHERE chat_id = ? AND id > ? AND created_at >= ? AND role IN (${list(r)})`)
    .get(String(chatId ?? ""), Number(fromId) || 0, Number(since) || 0, ...r);
  return { count: Number(z?.n) || 0, untilId: z?.until === null || z?.until === undefined ? Number(fromId) || 0 : Number(z.until) };
}

/**
 * Prefilter of the tick: the chats of the workspace with a row of these roles above the watermark of the last
 * FINISHED run of this agent (without a finished run: any row). Whether the agent is active there is computed by
 * the caller. → `[chatId]`.
 */
function outerLoopChatsWithNew(workspaceId, agentId, roles) {
  const r = rolesList(roles);
  if (!r.length) return [];
  return db.prepare(`SELECT c.id AS id FROM chats c WHERE c.workspace_id = ? AND EXISTS (
      SELECT 1 FROM messages m WHERE m.chat_id = c.id AND m.role IN (${list(r)}) AND m.id > COALESCE((
        SELECT MAX(l.until_message_id) FROM outer_loop_runs l WHERE l.agent_id = ? AND l.chat_id = c.id AND l.state = 'finished'), 0))
    ORDER BY c.id`).all(String(workspaceId ?? ""), ...r, String(agentId ?? "")).map((x) => x.id);
}

/** Text in the chat, ALL roles, case insensitive (ASCII, like SQLite `lower`), newest first. */
function outerLoopChatSearch(chatId, text, { limit = 20 } = {}) {
  const needle = String(text ?? "").trim().toLowerCase();
  if (!needle) return [];
  const n = Math.max(1, Math.min(500, Math.floor(Number(limit) || 20)));
  const pattern = `%${needle.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  return db.prepare(`SELECT id, role, text, created_at AS ts FROM messages WHERE chat_id = ? AND lower(text) LIKE ? ESCAPE '\\'
    ORDER BY id DESC LIMIT ?`).all(String(chatId ?? ""), pattern, n)
    .map((r) => ({ id: Number(r.id), role: r.role, text: r.text, ts: Number(r.ts) }));
}

const blockOf = (text) => { const o = json(text, null); return o && typeof o === "object" && !Array.isArray(o) ? o : null; };

/**
 * A tool call with its result. `row` is the messages.id of a `tool` row of THIS chat. The result is the next
 * `tool_result` row with the same block id AFTER it — and BEFORE the next call with the same block id: Codex
 * restarts its item ids per process (`item_0` in every turn), a search by id alone would hit the result of a
 * foreign call.
 * → `{ call: { id, blockId, ts, name, detail, input }, result: { id, ts, text, isError } | null }` | null.
 */
function outerLoopCall(chatId, row) {
  const cid = String(chatId ?? "");
  const z = db.prepare("SELECT id, text, created_at AS ts FROM messages WHERE chat_id = ? AND id = ? AND role = 'tool'").get(cid, Number(row) || 0);
  if (!z) return null;
  const b = blockOf(z.text) || {};
  const blockId = b.id === undefined || b.id === null ? "" : String(b.id);
  const call = { id: Number(z.id), blockId, ts: Number(z.ts), name: String(b.name || ""), detail: String(b.detail || ""), input: b.input ?? null };
  if (!blockId) return { call, result: null };
  const idOf = "CASE WHEN json_valid(text) THEN json_extract(text, '$.id') END";
  const limit = db.prepare(`SELECT MIN(id) AS g FROM messages WHERE chat_id = ? AND role = 'tool' AND id > ? AND ${idOf} = ?`).get(cid, call.id, blockId)?.g;
  const e = db.prepare(`SELECT id, text, created_at AS ts FROM messages WHERE chat_id = ? AND role = 'tool_result' AND id > ? AND (? IS NULL OR id < ?)
      AND ${idOf} = ? ORDER BY id LIMIT 1`).get(cid, call.id, limit ?? null, limit ?? null, blockId);
  if (!e) return { call, result: null };
  const o = blockOf(e.text) || {};
  return { call, result: { id: Number(e.id), ts: Number(e.ts), text: typeof o.result === "string" ? o.result : JSON.stringify(o.result ?? ""), isError: Boolean(o.isError) } };
}

/** The CLI sessions of the runs — on the chat and of the chat-owned agents — per chat (`null` ⇒ all chats). → Map chatId → sid[]. */
function outerLoopSessionsOf(chatIds = null) {
  const ids = chatIds === null ? null : [...new Set((chatIds || []).map(String).filter(Boolean))];
  if (ids && !ids.length) return new Map();
  const only = (column) => (ids ? ` AND ${column} IN (SELECT value FROM json_each(?))` : "");
  const arg = ids ? [JSON.stringify(ids)] : [];
  const out = new Map();
  const take = (id, sid) => {
    const k = String(id); const s = String(sid);
    if (!out.has(k)) out.set(k, []);
    if (!out.get(k).includes(s)) out.get(k).push(s);
  };
  for (const r of db.prepare(`SELECT chat_id AS id, session_id AS sid FROM outer_loop_runs WHERE session_id <> ''${only("chat_id")} ORDER BY rowid`).all(...arg)) take(r.id, r.sid);
  for (const r of db.prepare(`SELECT a.chat_id AS id, l.session_id AS sid FROM outer_loop_runs l JOIN outer_loop_agents a ON a.id = l.agent_id
      WHERE a.chat_id IS NOT NULL AND l.session_id <> ''${only("a.chat_id")} ORDER BY l.rowid`).all(...arg)) take(r.id, r.sid);
  return out;
}

/**
 * Remove what hangs on the chat — in ONE transaction, called ONLY from the close path (chats/erase.js tidyUp): the
 * chat-owned agents with their rows, plus runs, notes and activation of ALL agents on this chat.
 * → `{ agents, runs, notes, active }`.
 */
function deleteOuterLoopChat(chatId) {
  const cid = String(chatId ?? "");
  return inOneTransaction(() => {
    const own = db.prepare("SELECT id FROM outer_loop_agents WHERE chat_id = ?").all(cid).map((r) => r.id);
    const e = JSON.stringify(own);
    const ofOwn = "agent_id IN (SELECT value FROM json_each(?))";
    const runs = db.prepare(`DELETE FROM outer_loop_runs WHERE chat_id = ? OR ${ofOwn}`).run(cid, e).changes;
    const notes = db.prepare(`DELETE FROM outer_loop_notes WHERE chat_id = ? OR ${ofOwn}`).run(cid, e).changes;
    const active = db.prepare(`DELETE FROM outer_loop_active WHERE chat_id = ? OR ${ofOwn}`).run(cid, e).changes;
    db.prepare(`DELETE FROM outer_loop_takeover WHERE ${ofOwn}`).run(e);
    const agents = db.prepare("DELETE FROM outer_loop_agents WHERE chat_id = ?").run(cid).changes;
    return { agents, runs, notes, active };
  });
}

export {
  initOuterLoopSchema, outerLoopAgent, changeOuterLoopAgent, createOuterLoopAgent, outerLoopAgentsOfTheChat, outerLoopAgentsOf,
  outerLoopAgendaKeeper, deleteOuterLoopAgent, setOuterLoopActive, outerLoopActiveRow, outerLoopActiveRowsOfTheChat, outerLoopCall, deleteOuterLoopChat,
  outerLoopChatsWithNew, outerLoopChatSearch, abortOuterLoopRuns, outerLoopRunsAbortIds, outerLoopRunsAbortOf,
  outerLoopRunsParked, outerLoopRunsOpen, outerLoopRunsOfAgent, outerLoopRunningOn, outerLoopRunningCount, outerLoopRun,
  createOuterLoopRun, outerLoopRunEnd, outerLoopRunApplies, outerLoopRunSession, outerLoopRunSum, outerLoopRunState,
  outerLoopLastNote, outerLoopLastStarts, outerLoopLastFinishedRun, outerLoopLastRunOn, outerLoopLastTrackRun, dropOuterLoopMcpChoice,
  outerLoopNewRows, outerLoopNotTakenOver, createOuterLoopNote, outerLoopNotes, outerLoopNoteSearch, outerLoopNoteSearchAvailable,
  outerLoopSessionsOf, outerLoopTimelineAgent, outerLoopTimelineAgentId, setOuterLoopTakeover, outerLoopTakenOver, outerLoopSummarizer, summarizerNotesNewest,
};
