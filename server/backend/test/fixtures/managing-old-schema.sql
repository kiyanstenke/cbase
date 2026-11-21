-- The frozen old-schema seed: a store from before the removal of Managing.
-- The DDL of all Managing tables (the list of the removed teardown), with indexes, FTS tables and triggers, read from
-- sqlite_master of a fresh store at the last state of the removed Managing code — with IF NOT EXISTS. Do not edit by hand: the
-- guards of the start migrations that must not touch these rows and of the episode axis seed from it (managing-old-seed.mjs),
-- since the store no longer creates the tables. Only the comments were translated to English afterwards; table and column names
-- are the recorded ones.
-- todos
CREATE TABLE IF NOT EXISTS todos (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    project_id TEXT,
    parent_id TEXT,
    chat_id TEXT,
    title TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open',      -- open | done
    created_by TEXT NOT NULL DEFAULT 'agent', -- agent | user
    category TEXT NOT NULL DEFAULT '',        -- free category (e.g. "Bug", "Feature")
    due_at INTEGER,                           -- due date (ms) or NULL
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    done_at INTEGER
  );
CREATE INDEX IF NOT EXISTS idx_todos_ws ON todos(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_todos_chat ON todos(chat_id);
CREATE INDEX IF NOT EXISTS idx_todos_parent ON todos(parent_id);
-- todo_chats
CREATE TABLE IF NOT EXISTS todo_chats (
    todo_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (todo_id, chat_id)
  );
-- todo_context
CREATE TABLE IF NOT EXISTS todo_context (
    todo_id TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'project',
    context_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (todo_id, scope, context_id)
  );
-- manager_sources
CREATE TABLE IF NOT EXISTS manager_sources (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'transcript',   -- transcript | teams | note
    title TEXT NOT NULL DEFAULT '',
    raw TEXT NOT NULL DEFAULT '',
    source_date TEXT NOT NULL,                 -- ISO date (required; anchor for resolving relative dates)
    status TEXT NOT NULL DEFAULT 'fresh',        -- fresh | running | done | error | deleted
    error TEXT,
    fact_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    ingested_at INTEGER
  );
CREATE INDEX IF NOT EXISTS idx_msources_ws ON manager_sources(workspace_id, created_at);
-- manager_facts
CREATE TABLE IF NOT EXISTS manager_facts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id TEXT NOT NULL,
    kind TEXT NOT NULL,                        -- decision|deadline|priority|responsibility|status|question|preference
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    project_id TEXT,
    person TEXT,
    event_at TEXT,                             -- absolute ISO date/time or NULL
    valid_until TEXT,
    status TEXT NOT NULL DEFAULT 'active',     -- active|superseded|expired
    superseded_by INTEGER,
    source_id TEXT,
    confidence REAL,
    created_by TEXT NOT NULL DEFAULT 'ingest', -- ingest|manager|keeper|user
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    embedding BLOB,
    embedding_at INTEGER NOT NULL DEFAULT 0,
    embedding_model TEXT NOT NULL DEFAULT ''
  , episode_id TEXT, created_by_agent TEXT);
CREATE INDEX IF NOT EXISTS idx_mfacts_ws ON manager_facts(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_mfacts_episode ON manager_facts(episode_id);
-- manager_project_facts
CREATE TABLE IF NOT EXISTS manager_project_facts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '',             -- free, comma-separated, normalized to lower case
    pinned INTEGER NOT NULL DEFAULT 0,         -- belongs in the short summary of the manager prompt
    status TEXT NOT NULL DEFAULT 'active',     -- active | superseded
    superseded_by INTEGER,
    source_id TEXT,                            -- the source the knowledge came from
    proof_facts TEXT NOT NULL DEFAULT '',     -- JSON list of the fact ids the entry rests on
    confidence REAL,
    created_by TEXT NOT NULL DEFAULT 'manager',-- manager | keeper | user
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  , created_by_agent TEXT);
CREATE INDEX IF NOT EXISTS idx_mpfacts_proj ON manager_project_facts(project_id, status);
CREATE INDEX IF NOT EXISTS idx_mpfacts_ws ON manager_project_facts(workspace_id, status);
-- manager_proposals
CREATE TABLE IF NOT EXISTS manager_proposals (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    chat_id TEXT,                              -- manager chat
    source_id TEXT,
    kind TEXT NOT NULL DEFAULT 'dispatch',     -- dispatch | digest
    title TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open',      -- open | done | withdrawn
    created_at INTEGER NOT NULL,
    decided_at INTEGER
  , withdraw_note TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS idx_mprops_ws ON manager_proposals(workspace_id, status);
-- manager_proposal_items
CREATE TABLE IF NOT EXISTS manager_proposal_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    proposal_id TEXT NOT NULL,
    op TEXT NOT NULL,                          -- todo_create|todo_update|todo_done|chat_create|workflow_start|chat_message
    payload TEXT NOT NULL DEFAULT '{}',        -- JSON (shapes: spec §2.4)
    justification TEXT NOT NULL DEFAULT '',
    fact_ids TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'open',      -- open|approved|changed|rejected|withdrawn
    result TEXT,                               -- JSON: created ids / outcome
    decided_at INTEGER
  );
CREATE INDEX IF NOT EXISTS idx_mpropitems_prop ON manager_proposal_items(proposal_id);
-- manager_docs
CREATE TABLE IF NOT EXISTS manager_docs (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    path TEXT NOT NULL,                        -- path in the manager store (without a leading /)
    name TEXT NOT NULL,                        -- display name = last path part
    mime TEXT NOT NULL DEFAULT '',
    size INTEGER NOT NULL DEFAULT 0,
    sha256 TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL DEFAULT '',             -- extracted full text (empty for binary files)
    text_status TEXT NOT NULL DEFAULT 'ok',    -- ok | empty | binary | error
    text_note TEXT NOT NULL DEFAULT '',        -- why there is no text (scan, encrypted, …)
    note TEXT NOT NULL DEFAULT '',             -- note of the manager/user on the document
    source_id TEXT NOT NULL DEFAULT '',        -- source the document came in with ('' = single)
    created_by TEXT NOT NULL DEFAULT 'user',   -- user | manager
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
CREATE UNIQUE INDEX IF NOT EXISTS idx_mdocs_path ON manager_docs(workspace_id, path);
-- manager_agents
CREATE TABLE IF NOT EXISTS manager_agents (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT '',
    addition TEXT NOT NULL DEFAULT '',
    tools TEXT NOT NULL DEFAULT '[]',
    provider TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  , mcp TEXT NOT NULL DEFAULT '{}', memory TEXT NOT NULL DEFAULT '', memory_at INTEGER NOT NULL DEFAULT 0, effort TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS idx_magents_ws ON manager_agents(workspace_id, created_at);
-- manager_schedules
CREATE TABLE IF NOT EXISTS manager_schedules (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    name TEXT NOT NULL,
    job TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'cron',
    cron TEXT NOT NULL DEFAULT '',
    one_time_at INTEGER NOT NULL DEFAULT 0,
    timeZone TEXT NOT NULL DEFAULT 'UTC',
    stage TEXT NOT NULL DEFAULT 'cron',
    plan TEXT NOT NULL DEFAULT '{}',
    provider TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    next_at INTEGER NOT NULL DEFAULT 0,
    retry_at INTEGER NOT NULL DEFAULT 0,
    last_run_at INTEGER NOT NULL DEFAULT 0,
    last_status TEXT NOT NULL DEFAULT '',
    last_error TEXT NOT NULL DEFAULT '',
    folder_id TEXT,
    created_by TEXT NOT NULL DEFAULT 'user',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  , notify TEXT NOT NULL DEFAULT '{}');
CREATE INDEX IF NOT EXISTS idx_mschedules_ws ON manager_schedules(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_mschedules_next ON manager_schedules(status, next_at);
-- manager_schedule_runs
CREATE TABLE IF NOT EXISTS manager_schedule_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    schedule_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    chat_id TEXT,
    cause TEXT NOT NULL DEFAULT 'tick',
    scheduled_at INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER NOT NULL,
    ended_at INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'running',
    error TEXT NOT NULL DEFAULT '',
    short TEXT NOT NULL DEFAULT '',
    suggestions INTEGER NOT NULL DEFAULT 0,
    question INTEGER NOT NULL DEFAULT 0
  );
CREATE INDEX IF NOT EXISTS idx_msruns_schedule ON manager_schedule_runs(schedule_id, started_at);
-- manager_mcp_servers
CREATE TABLE IF NOT EXISTS manager_mcp_servers (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    token TEXT NOT NULL DEFAULT '',
    tools_cache TEXT NOT NULL DEFAULT '[]',
    tools_at INTEGER NOT NULL DEFAULT 0,
    error TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  , approval TEXT NOT NULL DEFAULT '[]');
CREATE UNIQUE INDEX IF NOT EXISTS ux_mmcp_key ON manager_mcp_servers(workspace_id, key);
-- ingest_landing
CREATE TABLE IF NOT EXISTS ingest_landing (
    id TEXT PRIMARY KEY,
    system TEXT NOT NULL,                      -- teams | portal | mail | …
    external_id TEXT NOT NULL,                 -- assigned by the source, stable
    payload TEXT NOT NULL,                     -- the body, verbatim as received
    payload_sha256 TEXT NOT NULL,
    received_at INTEGER NOT NULL
  );
CREATE UNIQUE INDEX IF NOT EXISTS ux_landing_dedupe ON ingest_landing(system, external_id, payload_sha256);
CREATE INDEX IF NOT EXISTS idx_landing_ext ON ingest_landing(system, external_id, received_at);
-- episodes
CREATE TABLE IF NOT EXISTS episodes (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,                -- required since 28.08.2026: the sender names it on intake
    landing_id TEXT NOT NULL,                  -- reference into the raw store
    system TEXT NOT NULL,
    external_id TEXT NOT NULL,
    channel TEXT NOT NULL,                       -- meeting | chat_thread | mail | document
    treue TEXT NOT NULL,                       -- transcript | minutes | reconstruction | original
    -- The label under which the excerpt ran at the source (meeting title, chat subject,
    -- file name). It is decoration, not content: the canonicalization never relies on it, and
    -- a source without one stays valid — then the list carries the participants.
    title TEXT NOT NULL DEFAULT '',
    -- With channel='document': the external_id of the carrier episode. An attachment is a document
    -- by content, not a message — so it becomes an episode of its OWN and keeps only the
    -- reference to the message it hung on.
    carrier_external_id TEXT NOT NULL DEFAULT '',
    time_of TEXT NOT NULL,                    -- ISO; for point events == time_until
    time_until TEXT NOT NULL,
    beteiligte TEXT NOT NULL DEFAULT '[]',     -- JSON array of named persons
    own_teilnahme INTEGER NOT NULL DEFAULT 0,
    text TEXT NOT NULL DEFAULT '',             -- rendered plain text ("Speaker: content")
    provisional INTEGER NOT NULL DEFAULT 0,     -- conversation still running (maturing time not reached)
    version INTEGER NOT NULL DEFAULT 1,        -- rises when the source changes
    categorization TEXT NOT NULL DEFAULT 'open',  -- assigned | company-wide | open  (stage 3)
    selektion TEXT NOT NULL DEFAULT 'open',   -- relevant | discarded | open     (stage 4)
    verwurf_reason TEXT NOT NULL DEFAULT '',
    rule_version TEXT NOT NULL DEFAULT '',    -- canonicalization: deterministic, versioned
    model_version TEXT NOT NULL DEFAULT '',   -- classification/selection: a model, NOT reproducible
    attributes TEXT NOT NULL DEFAULT '{}',       -- source-specific details (flat, sorted; ingest.js)
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
CREATE UNIQUE INDEX IF NOT EXISTS ux_episodes_ws_ext ON episodes(workspace_id, system, external_id);
CREATE INDEX IF NOT EXISTS idx_episodes_time ON episodes(time_of DESC);
CREATE INDEX IF NOT EXISTS idx_episodes_work ON episodes(categorization, selektion);
-- ingest_dateien
CREATE TABLE IF NOT EXISTS ingest_files (
    id TEXT PRIMARY KEY,
    episode_id TEXT NOT NULL,
    name TEXT NOT NULL,
    mime TEXT NOT NULL DEFAULT '',
    size INTEGER NOT NULL DEFAULT 0,
    sha256 TEXT NOT NULL,
    text_status TEXT NOT NULL DEFAULT 'ok',    -- ok | empty | binary | error
    text_note TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
CREATE INDEX IF NOT EXISTS idx_ingest_files_ep ON ingest_files(episode_id);
CREATE INDEX IF NOT EXISTS idx_ingest_files_sha ON ingest_files(sha256);
-- manager_scopes
CREATE TABLE IF NOT EXISTS manager_scopes (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,                         -- project | customer | area | person | company-wide
    name TEXT NOT NULL,
    parent_id TEXT,                            -- a customer stands ABOVE its projects
    project_id TEXT,                           -- with kind='project': the cbase project
    description TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL DEFAULT 'model', -- model | user
    created_at INTEGER NOT NULL
  , workspace_id TEXT NOT NULL DEFAULT '');
CREATE UNIQUE INDEX IF NOT EXISTS ux_scopes_ws_name ON manager_scopes(workspace_id, kind, name);
CREATE INDEX IF NOT EXISTS idx_scopes_parent ON manager_scopes(parent_id);
CREATE INDEX IF NOT EXISTS idx_scopes_project ON manager_scopes(project_id);
CREATE INDEX IF NOT EXISTS idx_scopes_ws ON manager_scopes(workspace_id);
-- episode_scopes
CREATE TABLE IF NOT EXISTS episode_scopes (
    episode_id TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    origin TEXT NOT NULL DEFAULT 'model',   -- rule | model | rework
    konfidenz REAL,
    PRIMARY KEY (episode_id, scope_id)
  );
CREATE INDEX IF NOT EXISTS idx_epscopes_scope ON episode_scopes(scope_id);
-- ablage_laeufe
CREATE TABLE IF NOT EXISTS deposit_runs (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    at INTEGER NOT NULL,                       -- start of the run (the clock of the tick)
    reason TEXT NOT NULL DEFAULT 'tick',        -- tick | manual | immediate
    episodes INTEGER NOT NULL DEFAULT 0,
    facts INTEGER NOT NULL DEFAULT 0,
    dismissed INTEGER NOT NULL DEFAULT 0,
    error INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    systeme TEXT NOT NULL DEFAULT '[]',        -- JSON array of the origins of this run
    -- Consecutive IDLE RUNS are counted here instead of being written as rows of their own.
    -- Bundling them on display would be cosmetic: the smallest tick (5 min) makes 288 runs a
    -- day, and they would have eaten the retention limit within hours and pushed the real
    -- runs out. The field at then carries the idle run observed LAST.
    empty_runs INTEGER NOT NULL DEFAULT 0,
    -- How much was still waiting after the run. A full run takes at most
    -- ABLAGE_SCHUB_MAX × ABLAGE_RUNDEN_MAX episodes; if more is there, the rest stays.
    -- Without this number a balance would not tell whether the run finished
    -- or merely ran out — and the queue number at the top of the page applies to NOW,
    -- not to the run of the day before yesterday.
    rest_waiting INTEGER NOT NULL DEFAULT 0,
    -- 0 only for the ONE row taken over from the old last run: its
    -- episode list is not missing, it was never collected. Without the mark the row would read like
    -- a run that lost its episodes.
    episodes_known INTEGER NOT NULL DEFAULT 1,
    -- Why the run ended, if not because it was done. '' = regular, 'limit' = stopped at
    -- the provider's usage limit. Without the field an aborted run would look
    -- like a normal one that happened to get little done — and rest_wartet would give no
    -- hint that nothing more comes until the window springs back.
    abort TEXT NOT NULL DEFAULT '',
    abort_text TEXT NOT NULL DEFAULT '',     -- the provider's evidence text, shortened
    abort_reset_at INTEGER NOT NULL DEFAULT 0 -- 0 = unknown, otherwise when the window is free
  );
CREATE INDEX IF NOT EXISTS idx_deposit_runs_ws ON deposit_runs(workspace_id, at DESC);
-- verwalter_laeufe
CREATE TABLE IF NOT EXISTS administrator_runs (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    at INTEGER NOT NULL,                       -- start of the run (the clock of the tick)
    cause TEXT NOT NULL DEFAULT 'tick',       -- tick | manual | user
    -- 0 = the clock was due, yet it did not run. That is exactly what reason is for:
    -- "nothing came" and "it was stopped" cannot be told apart without it.
    run INTEGER NOT NULL DEFAULT 0,
    reason TEXT NOT NULL DEFAULT '',            -- new-facts | stale | both | manual | user | idle | question
    -- The two triggers as a number, so the row is readable without recomputing.
    new_facts INTEGER NOT NULL DEFAULT 0,
    stale_facts INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0
  );
CREATE INDEX IF NOT EXISTS idx_administrator_runs_ws ON administrator_runs(workspace_id, at DESC);
-- verwalter_audit
CREATE TABLE IF NOT EXISTS administrator_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,                         -- fact | pfact
    op TEXT NOT NULL,                          -- create | update | delete
    target_id INTEGER NOT NULL,
    title TEXT NOT NULL DEFAULT '',            -- snapshot, no join
    origin TEXT NOT NULL DEFAULT '',         -- snapshot of the origin of the target
    prior TEXT NOT NULL DEFAULT '',           -- JSON, '' on create
    after TEXT NOT NULL DEFAULT '',          -- JSON, '' on delete
    rang INTEGER NOT NULL DEFAULT 0,
    -- When taken back (0 = not). Undo exactly ONCE hangs on this column, and
    -- as a CONDITION in the UPDATE, not as a pre-check in the code.
    back_at INTEGER NOT NULL DEFAULT 0
  );
CREATE INDEX IF NOT EXISTS idx_administrator_audit_run ON administrator_audit(run_id, rang);
CREATE INDEX IF NOT EXISTS idx_administrator_audit_target ON administrator_audit(workspace_id, kind, target_id, id DESC);
-- ablage_lauf_episoden
CREATE TABLE IF NOT EXISTS deposit_run_episodes (
    run_id TEXT NOT NULL,
    episode_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    system TEXT NOT NULL DEFAULT '',
    channel TEXT NOT NULL DEFAULT '',
    result TEXT NOT NULL DEFAULT 'eingeordnet', -- classified | discarded | error
    facts INTEGER NOT NULL DEFAULT 0,
    -- With result='error': the shortened cause. Until then it only went to console.error,
    -- so for a user to nowhere — a red number without a connection.
    error_text TEXT NOT NULL DEFAULT '',
    rang INTEGER NOT NULL DEFAULT 0,              -- order of processing in the run
    PRIMARY KEY (run_id, episode_id)
  );
CREATE INDEX IF NOT EXISTS idx_deposit_run_ep ON deposit_run_episodes(run_id, rang);
-- kanal_hooks
CREATE TABLE IF NOT EXISTS channel_hooks (
    chat_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    manager_chat_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (chat_id, kind, manager_chat_id)
  );
CREATE INDEX IF NOT EXISTS idx_khooks_manager ON channel_hooks(manager_chat_id);
-- manager_facts_fts (FTS, SQLite creates the shadow tables itself)
CREATE VIRTUAL TABLE IF NOT EXISTS manager_facts_fts USING fts5(
        title, body, content='manager_facts', content_rowid='id',
        tokenize='unicode61 remove_diacritics 2'
      );
-- manager_project_facts_fts (FTS, SQLite creates the shadow tables itself)
CREATE VIRTUAL TABLE IF NOT EXISTS manager_project_facts_fts USING fts5(
        title, body, tags, content='manager_project_facts', content_rowid='id',
        tokenize='unicode61 remove_diacritics 2'
      );
-- episodes_fts (FTS, SQLite creates the shadow tables itself)
CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(
        text, content='episodes', content_rowid='rowid',
        tokenize='unicode61 remove_diacritics 2'
      );
CREATE TRIGGER IF NOT EXISTS manager_facts_fts_ai AFTER INSERT ON manager_facts BEGIN
        INSERT INTO manager_facts_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
      END;
CREATE TRIGGER IF NOT EXISTS manager_facts_fts_ad AFTER DELETE ON manager_facts BEGIN
        INSERT INTO manager_facts_fts(manager_facts_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
      END;
CREATE TRIGGER IF NOT EXISTS manager_facts_fts_au AFTER UPDATE OF title, body ON manager_facts BEGIN
        INSERT INTO manager_facts_fts(manager_facts_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
        INSERT INTO manager_facts_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
      END;
CREATE TRIGGER IF NOT EXISTS manager_project_facts_fts_ai AFTER INSERT ON manager_project_facts BEGIN
        INSERT INTO manager_project_facts_fts(rowid, title, body, tags) VALUES (new.id, new.title, new.body, new.tags);
      END;
CREATE TRIGGER IF NOT EXISTS manager_project_facts_fts_ad AFTER DELETE ON manager_project_facts BEGIN
        INSERT INTO manager_project_facts_fts(manager_project_facts_fts, rowid, title, body, tags) VALUES ('delete', old.id, old.title, old.body, old.tags);
      END;
CREATE TRIGGER IF NOT EXISTS manager_project_facts_fts_au AFTER UPDATE OF title, body, tags ON manager_project_facts BEGIN
        INSERT INTO manager_project_facts_fts(manager_project_facts_fts, rowid, title, body, tags) VALUES ('delete', old.id, old.title, old.body, old.tags);
        INSERT INTO manager_project_facts_fts(rowid, title, body, tags) VALUES (new.id, new.title, new.body, new.tags);
      END;
CREATE TRIGGER IF NOT EXISTS episodes_fts_ai AFTER INSERT ON episodes BEGIN
        INSERT INTO episodes_fts(rowid, text) VALUES (new.rowid, new.text);
      END;
CREATE TRIGGER IF NOT EXISTS episodes_fts_ad AFTER DELETE ON episodes BEGIN
        INSERT INTO episodes_fts(episodes_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
      END;
CREATE TRIGGER IF NOT EXISTS episodes_fts_au AFTER UPDATE OF text ON episodes BEGIN
        INSERT INTO episodes_fts(episodes_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
        INSERT INTO episodes_fts(rowid, text) VALUES (new.rowid, new.text);
      END;
