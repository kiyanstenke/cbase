// The runs of dynamic workflows and their journal.
//
// `dyn_workflow_runs`: one run per tool call `cbase_dynamic_workflow` — run id in the format of the upstream tool
// (`wf_…`), task id, chat, name and meta from the script, path of the script file, status. "running" is the
// statement the run hub reads (`/api/runs/active`): via THIS table, never via an import of the domain. A run that an
// earlier server process left as "running" becomes "interrupted" at start (interruptDynRuns); the restart picks it
// up again (pickUpDynRun) or abandons it after the attempt cap (abandonDynRun).
//
// `dyn_workflow_journal`: per `agent()` call the entries launched · started · result · failed, with the key `v2:…`
// (dynworkflows/journal.js). `seq` is the write order; the call order is in `n`.
//
// The phase stands on EVERY journal entry (column `phase`); `dyn_workflow_agent_history` carries the STRUCTURED
// transcript per agent (call `n` of the run: job, text, thinking, tool call, tool result — the row shapes of the
// subagents in the chat history); `dyn_workflow_events` the `phase()`/`log()` lines and failures of the script in
// script order; `dyn_workflow_agent_todos` was the ToDo list per workflow agent — LEGACY: the read and write
// functions and the route are gone. The DDL stays (the schema registry stays unchanged, as with the architecture
// tables in store/db.js), as does the deletion with the chat (deleteDynRuns) — old rows thus go with their chat.
// The progress tree reads from the other tables.
//
// Domain-free: written by dynworkflows/run.js and dynworkflows/routes.js. Registration "dyn-workflow-runs" in
// store.js.
import { db } from "./db.js";

// The expression of the agent id of a journal entry — literally the same in the index and in the query (SQLite only
// uses an expression index for the same expression).
const AGENT_EXPRESSION = "json_extract(entry, '$.agentId')";

function initDynWorkflowRunSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dyn_workflow_runs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      meta TEXT NOT NULL DEFAULT '{}',
      script_path TEXT NOT NULL DEFAULT '',
      output_path TEXT NOT NULL DEFAULT '',
      call_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'running',
      error TEXT NOT NULL DEFAULT '',
      stopped_of TEXT NOT NULL DEFAULT '',
      returnValue TEXT,
      agent_count INTEGER NOT NULL DEFAULT 0,
      started_at INTEGER NOT NULL,
      ended_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS dyn_workflow_runs_chat ON dyn_workflow_runs(chat_id, status);
    CREATE TABLE IF NOT EXISTS dyn_workflow_journal (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      n INTEGER NOT NULL,
      kind TEXT NOT NULL,
      key TEXT NOT NULL,
      entry TEXT NOT NULL DEFAULT '{}',
      at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS dyn_workflow_journal_run ON dyn_workflow_journal(run_id, seq);
    CREATE TABLE IF NOT EXISTS dyn_workflow_agent_history (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      n INTEGER NOT NULL,
      kind TEXT NOT NULL,
      row TEXT NOT NULL DEFAULT '{}',
      at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS dyn_workflow_agent_history_run ON dyn_workflow_agent_history(run_id, n, seq);
    CREATE TABLE IF NOT EXISTS dyn_workflow_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      phase TEXT,
      at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS dyn_workflow_events_run ON dyn_workflow_events(run_id, seq);
    -- Legacy data (the own to-do list of a workflow agent is gone): no longer written, still read.
    CREATE TABLE IF NOT EXISTS dyn_workflow_agent_todos (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      parent_id TEXT,
      title TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      due_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      done_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS dyn_workflow_agent_todos_agent ON dyn_workflow_agent_todos(chat_id, agent_id, created_at);
  `);
  // The phase on every journal entry — added later in a database that already has the journal.
  const columns = db.prepare("PRAGMA table_info(dyn_workflow_journal)").all();
  if (!columns.some((c) => c.name === "phase")) db.exec("ALTER TABLE dyn_workflow_journal ADD COLUMN phase TEXT");
  // Who stopped ("human" | "agent", empty = not stopped) — added later for an existing table.
  if (!db.prepare("PRAGMA table_info(dyn_workflow_runs)").all().some((c) => c.name === "stopped_of")) {
    db.exec("ALTER TABLE dyn_workflow_runs ADD COLUMN stopped_of TEXT NOT NULL DEFAULT ''");
  }
  // Resume: the `args` of the run (a restart runs the script with the same), the attempt counter of the restart (it
  // survives the restart because it stands HERE) and the run from which `resumeFromRunId` continued.
  const runColumns = db.prepare("PRAGMA table_info(dyn_workflow_runs)").all().map((c) => c.name);
  if (!runColumns.includes("args")) db.exec("ALTER TABLE dyn_workflow_runs ADD COLUMN args TEXT");
  if (!runColumns.includes("attempts")) db.exec("ALTER TABLE dyn_workflow_runs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0");
  if (!runColumns.includes("resume_of")) db.exec("ALTER TABLE dyn_workflow_runs ADD COLUMN resume_of TEXT NOT NULL DEFAULT ''");
  // Budget: the target of the turn (NULL = none) and what its pot had last consumed — a restart continues the run
  // with the same upper limit instead of losing it with the restart.
  if (!runColumns.includes("budget_total")) db.exec("ALTER TABLE dyn_workflow_runs ADD COLUMN budget_total INTEGER");
  if (!runColumns.includes("budget_consumed")) db.exec("ALTER TABLE dyn_workflow_runs ADD COLUMN budget_consumed INTEGER NOT NULL DEFAULT 0");
  // The identifier `<project>/<instance>` of the instance in which the run began — the restart opens its core there,
  // not in the current instance of the chat. NULL = none (a run from before the column or begun without an instance:
  // then the current one of the chat, dynworkflows/run.js identifierTheRow).
  if (!runColumns.includes("instance_identifier")) db.exec("ALTER TABLE dyn_workflow_runs ADD COLUMN instance_identifier TEXT");
  // The boundary of the RUNNING attempt (the progress tree across a restart) — how many journal and event rows of the
  // run were written before the most recent restart (pickUpDynRun). The restart continues the same journal; what
  // stands before belongs to an aborted attempt (dynworkflows/tree.js). A number in READ ORDER (seq), not a journal
  // kind: the journal stays in the upstream shape. 0 = no restart. Rows of a run are never deleted individually.
  if (!runColumns.includes("attempt_from_journal")) db.exec("ALTER TABLE dyn_workflow_runs ADD COLUMN attempt_from_journal INTEGER NOT NULL DEFAULT 0");
  if (!runColumns.includes("attempt_from_event")) db.exec("ALTER TABLE dyn_workflow_runs ADD COLUMN attempt_from_event INTEGER NOT NULL DEFAULT 0");
  // Was the most recent interruption an ORDERLY server end (1) or not (0: crash — interruptDynRuns at the next start
  // —, failed continuation)? An orderly one does not count as an attempt at the restart (pickUpDynRun) and does not
  // abandon the run (dynworkflows/run.js dynWorkflowsRestartGrace) — otherwise every deploy would cost one of the two
  // continuation attempts. Set only by endDynRun with `ordered`, back to 0 with every pick-up: a row "running" always
  // carries 0, hence also the one a crash leaves behind.
  if (!runColumns.includes("end_ordered")) db.exec("ALTER TABLE dyn_workflow_runs ADD COLUMN end_ordered INTEGER NOT NULL DEFAULT 0");
  // Git overview: the workflow agents for agent ids (dynWorkflowAgentsWithIds) are asked by the tick of the clients
  // for EVERY branch `cbase/agent-*` without a `subagents` row — without an index a full scan with json_extract over
  // the whole journal. ONE index instead of a memo: a memo would have to expire on every `started` write and at the
  // end of every run, and a forgotten expiry would silently show a wrong state; the index is always exact. A PARTIAL
  // INDEX over the expression of only the `started` rows (the query names `kind = 'started'` and the same expression
  // literally, otherwise SQLite does not use it — guard: EXPLAIN QUERY PLAN in
  // server/backend/test/git-view-user.test.js). Cost when writing: one json_extract per `started`. A further CREATE
  // INDEX IF NOT EXISTS in the same registration is idempotent and needs no new registry row.
  db.exec(`CREATE INDEX IF NOT EXISTS dyn_workflow_journal_agent ON dyn_workflow_journal(${AGENT_EXPRESSION}) WHERE kind = 'started'`);
}

const read = (raw, preset) => { try { return raw == null ? preset : JSON.parse(raw); } catch { return preset; } };
const mapRun = (r) => (!r ? null : {
  runId: r.id, taskId: r.task_id, chatId: r.chat_id, name: r.name, meta: read(r.meta, {}), scriptPath: r.script_path,
  outputPath: r.output_path, callId: r.call_id, status: r.status, error: r.error, stoppedOf: r.stopped_of || "", returnValue: read(r.returnValue, null),
  agentCount: r.agent_count, startedAt: r.started_at, endedAt: r.ended_at ?? null,
  args: read(r.args, undefined), attempts: Number(r.attempts) || 0, resumeOf: r.resume_of || "",
  budgetTotal: r.budget_total ?? null, budgetConsumed: Number(r.budget_consumed) || 0, instanceIdentifier: r.instance_identifier || null,
  attemptFrom: { journal: Number(r.attempt_from_journal) || 0, events: Number(r.attempt_from_event) || 0 },
  endOrdered: Number(r.end_ordered) === 1,
});

function createDynRun({ runId, taskId, chatId, name, meta, scriptPath, outputPath, callId = "", args, resumeOf = "", budgetTotal = null, instanceIdentifier = null }) {
  db.prepare(`INSERT INTO dyn_workflow_runs (id, task_id, chat_id, name, meta, script_path, output_path, call_id, status, started_at, args, resume_of, budget_total, instance_identifier)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)`)
    .run(runId, taskId, chatId, String(name || ""), JSON.stringify(meta || {}), scriptPath, outputPath, String(callId || ""), Date.now(),
      args === undefined ? null : JSON.stringify(args), String(resumeOf || ""), Number.isSafeInteger(budgetTotal) && budgetTotal > 0 ? budgetTotal : null,
      typeof instanceIdentifier === "string" && instanceIdentifier ? instanceIdentifier : null);
  return readDynRun(runId);
}

/** The state of the budget pot of a run — after every agent end, for the restart. */
function dynRunBudgetStatus(runId, consumed) {
  db.prepare("UPDATE dyn_workflow_runs SET budget_consumed = ? WHERE id = ?").run(Math.max(0, Math.floor(Number(consumed) || 0)), runId);
}

/**
 * Complete a run: `status` ∈ finished · failed · stopped · interrupted; `stoppedOf` ("human" | "agent") only for a
 * stop; `ordered` only with "interrupted" — the orderly server end (column `end_ordered`, see schema). Only a
 * running run is completed — `true` if THIS call did it.
 */
function endDynRun(runId, { status, error = "", returnValue = null, agentCount = 0, stoppedOf = "", ordered = false }) {
  return db.prepare("UPDATE dyn_workflow_runs SET status = ?, error = ?, returnValue = ?, agent_count = ?, stopped_of = ?, end_ordered = ?, ended_at = ? WHERE id = ? AND status = 'running'")
    .run(status, String(error || ""), returnValue === null || returnValue === undefined ? null : JSON.stringify(returnValue), Number(agentCount) || 0, String(stoppedOf || ""),
      status === "interrupted" && ordered === true ? 1 : 0, Date.now(), runId).changes > 0;
}

const readDynRun = (runId) => mapRun(db.prepare("SELECT * FROM dyn_workflow_runs WHERE id = ?").get(runId));
/** A run via run id OR task id, only in this chat. */
const dynRunInChat = (chatId, id) => mapRun(db.prepare("SELECT * FROM dyn_workflow_runs WHERE chat_id = ? AND (id = ? OR task_id = ?)").get(chatId, id, id));
/** The running ones (status "running") — with `chatId` only those of this chat. */
function dynRunsOpen(chatId = "") {
  const rows = chatId
    ? db.prepare("SELECT * FROM dyn_workflow_runs WHERE status = 'running' AND chat_id = ? ORDER BY started_at").all(chatId)
    : db.prepare("SELECT * FROM dyn_workflow_runs WHERE status = 'running' ORDER BY started_at").all();
  return rows.map(mapRun);
}
/** The state of a running run for the displays before a swap (/api/runs/active, /api/active-runs): the most recent
 *  `phase()` line (`null` = none yet), how many `agent()` calls have begun and how many have ended. */
function dynRunStatus(runId) {
  const phase = db.prepare("SELECT text FROM dyn_workflow_events WHERE run_id = ? AND kind = 'phase' ORDER BY seq DESC LIMIT 1").get(runId)?.text ?? null;
  const z = db.prepare(`SELECT COUNT(DISTINCT CASE WHEN kind = 'launched' THEN n END) AS agents,
    COUNT(DISTINCT CASE WHEN kind IN ('result', 'failed') THEN n END) AS finished FROM dyn_workflow_journal WHERE run_id = ?`).get(runId) || {};
  return { phase, agents: Number(z.agents) || 0, finished: Number(z.finished) || 0 };
}
/** The runs of a chat for the progress tree: the most recent `limit`, newest first, and how many there are in total
 *  — whoever truncates must be able to say so. */
function dynRunsInChat(chatId, limit) {
  const runs = db.prepare("SELECT * FROM dyn_workflow_runs WHERE chat_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?").all(chatId, Number(limit) || 0).map(mapRun);
  const total = Number(db.prepare("SELECT COUNT(*) AS n FROM dyn_workflow_runs WHERE chat_id = ?").get(chatId)?.n) || 0;
  return { runs, total };
}
/** What an earlier server process left as "running" is interrupted — a crash: `end_ordered` stays 0 (a row "running"
 *  never carries 1, see schema), the restart counts the attempt. Returns the number. */
function interruptDynRuns(reason) {
  return Number(db.prepare("UPDATE dyn_workflow_runs SET status = 'interrupted', error = ?, ended_at = ? WHERE status = 'running'")
    .run(String(reason || ""), Date.now()).changes) || 0;
}
/** What the restart continues: the interrupted runs, oldest first. */
const dynRunsInterrupted = () => db.prepare("SELECT * FROM dyn_workflow_runs WHERE status = 'interrupted' ORDER BY started_at").all().map(mapRun);
/** Pick up an interrupted run again and count the attempt — `true` if THIS call did it. Counting only happens after
 *  an end that was NOT orderly (`end_ordered`, see schema): a deploy costs no attempt, a crash does; the marker
 *  falls in the same statement (the new attempt has no end yet). Likewise the boundary of the new attempt
 *  (`attempt_ab_*`, see schema): what stands in the journal up to now, the restart reads as old journal. */
const pickUpDynRun = (runId) => db.prepare(`UPDATE dyn_workflow_runs SET status = 'running', attempts = attempts + CASE WHEN end_ordered = 1 THEN 0 ELSE 1 END,
    end_ordered = 0, error = '', ended_at = NULL,
    attempt_from_journal = (SELECT COUNT(*) FROM dyn_workflow_journal WHERE run_id = ?),
    attempt_from_event = (SELECT COUNT(*) FROM dyn_workflow_events WHERE run_id = ?)
  WHERE id = ? AND status = 'interrupted'`)
  .run(runId, runId, runId).changes > 0;
/** Abandon an interrupted run (attempt cap, chat gone, superseded via resumeFromRunId) — `true` if THIS call did it. */
const abandonDynRun = (runId, error) => db.prepare("UPDATE dyn_workflow_runs SET status = 'failed', error = ?, ended_at = ? WHERE id = ? AND status = 'interrupted'")
  .run(String(error || ""), Date.now(), runId).changes > 0;
/** The runs of a deleted chat with journal, transcripts, events and the (legacy) ToDo lists of its agents. */
function deleteDynRuns(chatId) {
  for (const t of ["dyn_workflow_journal", "dyn_workflow_agent_history", "dyn_workflow_events"]) {
    db.prepare(`DELETE FROM ${t} WHERE run_id IN (SELECT id FROM dyn_workflow_runs WHERE chat_id = ?)`).run(chatId);
  }
  db.prepare("DELETE FROM dyn_workflow_agent_todos WHERE chat_id = ?").run(chatId);
  db.prepare("DELETE FROM dyn_workflow_runs WHERE chat_id = ?").run(chatId);
}

/** The plan of the query of dynWorkflowAgentsWithIds (EXPLAIN QUERY PLAN, `detail` per step) — only for the guard of the index. */
function dynWorkflowAgentsPlan(count = 1) {
  return db.prepare(`EXPLAIN QUERY PLAN ${agentsSql(Math.max(1, Number(count) || 1))}`).all(...Array.from({ length: Math.max(1, Number(count) || 1) }, (_, i) => `x${i}`)).map((r) => String(r.detail));
}

// `phase` stands as a column on EVERY entry — that of the agent() call (opts.phase or the running phase()).
function writeDynJournal(runId, { kind, n, key, phase = null, ...rest }) {
  db.prepare("INSERT INTO dyn_workflow_journal (run_id, n, kind, key, entry, phase, at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(runId, Number(n) || 0, kind, String(key || ""), JSON.stringify(rest), phase === null || phase === undefined ? null : String(phase), Date.now());
}
const readDynJournal = (runId) => db.prepare("SELECT * FROM dyn_workflow_journal WHERE run_id = ? ORDER BY seq").all(runId)
  .map((r) => ({ kind: r.kind, n: r.n, key: r.key, ...read(r.entry, {}), phase: r.phase ?? null, at: r.at }));

/**
 * The workflow agents for agent ids (git overview): a workflow agent NEVER writes into `subagents` (its own
 * storage), its branch `cbase/agent-<id>` only names the id. The id stands in the journal on the entry `started`
 * (JSON `entry.agentId`), the label on the `launched` of the SAME call `n` — hence no new column.
 * → `[{ agentId, runId, chatId, n, label, runName, status }]`, per id the most recent entry; empty list ⇒ empty.
 */
// The query by agent ids — ONE version for the query and its plan (dynWorkflowAgentsPlan, guard of the index).
const agentsSql = (count) => `SELECT j.run_id, j.n, ${AGENT_EXPRESSION.replace("entry", "j.entry")} AS agent_id, l.chat_id, l.name, l.status,
      (SELECT json_extract(x.entry, '$.label') FROM dyn_workflow_journal x WHERE x.run_id = j.run_id AND x.n = j.n AND x.kind = 'launched'
        ORDER BY x.seq DESC LIMIT 1) AS label
    FROM dyn_workflow_journal j JOIN dyn_workflow_runs l ON l.id = j.run_id
    WHERE j.kind = 'started' AND ${AGENT_EXPRESSION.replace("entry", "j.entry")} IN (${Array.from({ length: count }, () => "?").join(", ")})
    ORDER BY j.seq`;
function dynWorkflowAgentsWithIds(agentIds) {
  const ids = [...new Set((agentIds || []).map(String).filter(Boolean))];
  if (!ids.length) return [];
  const rows = db.prepare(agentsSql(ids.length)).all(...ids);
  const byKey = new Map();
  for (const r of rows) {
    byKey.set(String(r.agent_id), { agentId: String(r.agent_id), runId: r.run_id, chatId: r.chat_id, n: Number(r.n) || 0,
      label: typeof r.label === "string" ? r.label : "", runName: r.name || "", status: r.status });
  }
  return [...byKey.values()];
}

// ── Transcript per agent ── `kind`: job · text · thinking · tool · tool result · message ({id, text, from, state,
// reason?}); `row` the fields.
function writeDynAgentRow(runId, n, kind, row = {}) {
  db.prepare("INSERT INTO dyn_workflow_agent_history (run_id, n, kind, row, at) VALUES (?, ?, ?, ?, ?)")
    .run(runId, Number(n) || 0, String(kind), JSON.stringify(row || {}), Date.now());
}
/**
 * Rewrite the transcript row of a message (kind `message`) in place — a message that only later becomes "not
 * delivered" (gate, end) stays ONE row with its last state. Found via the identifier `id` in the body of the row;
 * `fields` are merged into the body. → whether a row was hit.
 */
function markDynAgentMessage(runId, n, id, fields = {}) {
  const rows = db.prepare("SELECT seq, row FROM dyn_workflow_agent_history WHERE run_id = ? AND n = ? AND kind = 'message' ORDER BY seq").all(runId, Number(n) || 0);
  const r = rows.find((x) => read(x.row, {}).id === id);
  if (!r) return false;
  db.prepare("UPDATE dyn_workflow_agent_history SET row = ? WHERE seq = ?").run(JSON.stringify({ ...read(r.row, {}), ...fields }), r.seq);
  return true;
}
/** The transcript of a run — with `n` only that of the agent() call `n`. */
function readDynAgentHistory(runId, n = null) {
  const rows = n === null || n === undefined
    ? db.prepare("SELECT * FROM dyn_workflow_agent_history WHERE run_id = ? ORDER BY seq").all(runId)
    : db.prepare("SELECT * FROM dyn_workflow_agent_history WHERE run_id = ? AND n = ? ORDER BY seq").all(runId, Number(n) || 0);
  return rows.map((r) => ({ n: r.n, kind: r.kind, ...read(r.row, {}), at: r.at }));
}

// ── Script events ── `kind`: phase · log · failure; `phase` = the phase() running at that moment.
function writeDynEvent(runId, { kind, text = "", phase = null }) {
  db.prepare("INSERT INTO dyn_workflow_events (run_id, kind, text, phase, at) VALUES (?, ?, ?, ?, ?)")
    .run(runId, String(kind), String(text ?? ""), phase === null || phase === undefined ? null : String(phase), Date.now());
}
const readDynEvents = (runId) => db.prepare("SELECT * FROM dyn_workflow_events WHERE run_id = ? ORDER BY seq").all(runId)
  .map((r) => ({ kind: r.kind, text: r.text, phase: r.phase ?? null, at: r.at }));

export {
  initDynWorkflowRunSchema, createDynRun, dynRunBudgetStatus, endDynRun, readDynRun, dynRunInChat, dynRunsOpen, dynRunStatus, dynRunsInChat, interruptDynRuns,
  dynRunsInterrupted, pickUpDynRun, abandonDynRun, deleteDynRuns, writeDynJournal, readDynJournal, dynWorkflowAgentsWithIds, dynWorkflowAgentsPlan, writeDynAgentRow, markDynAgentMessage, readDynAgentHistory, writeDynEvent,
  readDynEvents,
};
