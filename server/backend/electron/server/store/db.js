// Connection and schema: `let db` (live binding through the export line at the end), `initStore` with every core
// CREATE/ALTER statement and migration.
// Answers: which tables exist, and which migration brought which column.
// `initStore` creates the core and then runs the schemas registered in the schema registry (`runSchemata`); WHICH
// ones is decided by the registration list at the end of the facade `store.js` — `db.js` knows no topic file.

import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runSchemata } from "./schema.js";
import { slugifyTitle } from "./_util.js";

let db;
let skillResRoot = ""; // <dataDir>/skill-resources — folder for references/scripts/assets per skill

export const nowMs = () => Date.now();

// How long a writer (or reader) waits for a FOREIGN lock before giving up with "database is locked". The server has
// ONE connection, so locks only come from outside: a second connection on the same file (a test reading the database
// of a server child process, a human with `sqlite3`). Without the value SQLite gave up at once, and a read of
// milliseconds made a server write fail.
// 5 s, not more: `node:sqlite` is SYNCHRONOUS, and while the busy handler waits the whole event loop stands still.
// Set on EVERY open because it is a property of the connection, not of the file. `CBASE_DB_BUSY_MS` lets tests raise
// it so that no reaction time of the test decides the verdict; read on every call, not at import.
const DB_BUSY_MS = () => {
  const v = Number(process.env.CBASE_DB_BUSY_MS || NaN); // empty is not zero: without a value the default applies
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 5000;
};

// ── One transaction ─────────────────────────────────────────────────────────────────────────────
// `fn` (synchronous) runs as ONE transaction: all or nothing, and one fsync instead of one per statement. As a
// SAVEPOINT, not BEGIN: a transaction inside a transaction is allowed (deleteWorkspace calls helpers that open their
// own), BEGIN inside BEGIN would be "cannot start a transaction within a transaction".
// The rollback is GUARDED: on SQLITE_FULL, IOERR, NOMEM or a RAISE(ROLLBACK) SQLite has already ended the
// transaction itself — an unguarded ROLLBACK then threw "no transaction is active" and REPLACED the real error (disk
// full looked like a programming error). Here that second throw is dropped and the original error propagates.
// The commit itself sits in the guarded part too: if the outermost RELEASE (= COMMIT, e.g. BUSY) fails, the
// transaction would otherwise stay open and every later statement of the connection would silently run inside it
// without ever being committed; ROLLBACK TO + RELEASE then closes it empty.
// Whoever needs a transaction uses this one — no own BEGIN/COMMIT wrapper in a topic file.
let transactionDepth = 0;
function inOneTransaction(fn) {
  const name = `transaction_${++transactionDepth}`;
  try {
    db.exec(`SAVEPOINT ${name}`);
    try {
      const r = fn();
      if (r && typeof r.then === "function") throw new Error("inOneTransaction: synchronous only — an await would tear the transaction apart");
      db.exec(`RELEASE ${name}`);
      return r;
    } catch (e) {
      try { db.exec(`ROLLBACK TO ${name}`); db.exec(`RELEASE ${name}`); } catch { /* SQLite has already rolled back */ }
      throw e;
    }
  } finally {
    transactionDepth -= 1;
  }
}

// A column and its backfill in ONE transaction, decided by the column itself. With ALTER and UPDATE in the same
// swallowing try, a process death in between made the next start's ALTER throw ("duplicate column"), the catch
// swallowed it and the backfill NEVER ran; the same catch also swallowed real errors (BUSY, disk full) — the column
// was then missing and the error surfaced later as "no such column" somewhere else. Now: if the column is missing,
// both run in one transaction (a crash in between rolls both back, the next start redoes both); every other error
// propagates loudly out of initStore. Returns `true` when the column is new.
function columnWithBackfill(table, column, migrationSql, backfill) {
  if (db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column)) return false;
  inOneTransaction(() => { db.exec(migrationSql); if (backfill) db.exec(backfill); });
  return true;
}

// ── Journal: WAL, synchronous NORMAL ────────────────────────────────────────────────────────────
// With SQLite's defaults (rollback journal, synchronous FULL) every write transaction fsyncs the journal AND the database
// file — on the main thread, because `node:sqlite` is synchronous. In the user container each fsync waited 0.5–2 s for the
// ext4 journal commit of the shared host disk; the main thread stood in `jbd2_log_wait_commit` for whole seconds, commits
// in a row added up to event-loop blocks of 20–70 s (logs/eventLoop.jsonl, 20.11.2026), and the gateway answered 503.
// WAL + NORMAL: a commit appends to `automater.db-wal` and does NOT fsync; only a checkpoint (copying the WAL back) does.
// Durability: a process crash loses nothing; a power cut or kernel crash can lose the last commits, never consistency.
// Readers no longer block the writer (and the writer no readers); there is still ONE writer at a time — busy_timeout
// stays the wait for a foreign writer.
// wal_autocheckpoint stays at SQLite's default (1,000 pages ≈ 4 MB): the checkpoint runs on the committing connection, so
// it is the one remaining fsync on the main thread; a larger value makes it rarer but longer and grows what every reader
// has to search in the WAL, a smaller one brings the per-commit fsync back in pieces. Measure before changing it.
// The mode is a property of the FILE (it stays WAL for every later connection, including read-only ones — tools that read
// the database read `-wal` too, see tools/deploy/lib/capabilities.mjs); `synchronous` is one of the connection.
// Whoever copies the database copies it through SQLite (`VACUUM INTO`, `backup()`), never as a file: `automater.db` alone
// misses what is still in `-wal`. Guard: server/backend/test/store-journal.test.js.
export const JOURNAL_MODE = "wal";
export const SYNCHRONOUS_NORMAL = 1;

export function initStore(dataDir) {
  db = new DatabaseSync(path.join(dataDir, "automater.db"));
  db.exec(`PRAGMA busy_timeout = ${DB_BUSY_MS()}`);
  // SQLite answers with the mode it really set and does not throw when it cannot switch (a file system without shared
  // memory): say it, the store still works in the old mode.
  const mode = String(db.prepare(`PRAGMA journal_mode = ${JOURNAL_MODE.toUpperCase()}`).get()?.journal_mode || "").toLowerCase();
  if (mode !== JOURNAL_MODE) console.warn(`[store] journal_mode stays "${mode}" instead of "${JOURNAL_MODE}" — every commit fsyncs on the main thread`);
  db.exec("PRAGMA synchronous = NORMAL");
  skillResRoot = path.join(dataDir, "skill-resources");
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_projects_ws ON projects(workspace_id);

    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      project_id TEXT,
      title TEXT NOT NULL DEFAULT 'New chat',
      profile TEXT NOT NULL DEFAULT 'default',
      claude_session_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chats_ws ON chats(workspace_id);

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id);

    CREATE TABLE IF NOT EXISTS context_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'Other',
      title    TEXT NOT NULL DEFAULT '',
      summary  TEXT NOT NULL DEFAULT '',
      tags     TEXT NOT NULL DEFAULT '',
      body     TEXT NOT NULL,
      source   TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      -- OKF light (workspace knowledge has no repo → no git fields)
      slug TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      owners TEXT NOT NULL DEFAULT '',
      links TEXT NOT NULL DEFAULT '',
      confidence TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_ctx_ws ON context_items(workspace_id);

    -- project_docs was fully replaced by chat-bound file artifacts. By product decision there are no old plans
    -- worth migrating, so the table may go.
    DROP TABLE IF EXISTS project_docs;

    CREATE TABLE IF NOT EXISTS apps (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      workspace_id TEXT,
      project_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_services (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      app_id TEXT NOT NULL,
      name TEXT NOT NULL,
      port INTEGER NOT NULL UNIQUE CHECK (port BETWEEN 1 AND 65535),
      description TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_services_app ON app_services(app_id);

    -- Services found by the service scan (AI agent at project creation) of a
    -- of a project: backend/frontend/DBs/caches/queues/workers incl. port & start.
    CREATE TABLE IF NOT EXISTS project_services (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'other',      -- backend | frontend | db | cache | queue | worker | infra | other
      port INTEGER,                            -- NULL if no port is recognizable
      tech TEXT NOT NULL DEFAULT '',
      dir TEXT NOT NULL DEFAULT '',
      start_command TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_psvc_project ON project_services(project_id);

    -- Start instructions a user stored for the agent start of a service.
    -- Deliberately NOT in project_services — the key is project_id + normalized service name: the instruction follows the
    -- service by its NAME (a re-scan no longer replaces project_services, it reconciles — store/projects.js reconcileScan —,
    -- a matched service keeps id and name; a scan row that is no longer found may drop and come back under the same
    -- name, and then the instruction applies again).
    CREATE TABLE IF NOT EXISTS service_start_instructions (
      project_id TEXT NOT NULL,
      service_key TEXT NOT NULL,
      instructions TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, service_key)
    );

    -- Manually corrected start commands (user/agent via service update). Same pattern
    -- as service_start_instructions: own table with a name key — the correction follows the service by its
    -- name and wins on every re-scan (which reconciles, does not replace; reconcileScan).
    CREATE TABLE IF NOT EXISTS service_start_commands (
      project_id TEXT NOT NULL,
      service_key TEXT NOT NULL,
      start_command TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, service_key)
    );

    -- REPLACED start commands. service_start_commands is an UPSERT and knows only the
    -- current value; whoever overwrites a command has lost the old one. Exactly that
    -- happened: an agent bent the stored command of a registered service for a demo
    -- and then wrote its OWN version back — two writes, so even a single predecessor slot
    -- would not have saved the original. Hence a history with several steps, same name key as
    -- above, so it survives re-scans.
    CREATE TABLE IF NOT EXISTS service_command_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      service_key TEXT NOT NULL,
      start_command TEXT NOT NULL,
      replaced_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_svccmd_hist ON service_command_history(project_id, service_key, replaced_at DESC);

    -- Project context: categorized, durable project knowledge (replaces the
    -- former PROJECT_INFORMATION markdown files). Fixed categories (slug), any number of entries per
    -- category; created_at/updated_at + optional
    -- subject-matter date (valid_as_of).
    CREATE TABLE IF NOT EXISTS project_context (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'overview',
      title TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '',
      valid_as_of TEXT NOT NULL DEFAULT '',
      pinned INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      -- OKF: stable reference, life cycle, assignment, verifiability
      slug TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      superseded_by TEXT NOT NULL DEFAULT '',
      owners TEXT NOT NULL DEFAULT '',
      links TEXT NOT NULL DEFAULT '',
      code_paths TEXT NOT NULL DEFAULT '',
      symbols TEXT NOT NULL DEFAULT '',
      last_verified TEXT NOT NULL DEFAULT '',
      confidence TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_pctx_project ON project_context(project_id);

    -- Suggestions of the post-run curator (small LLM) for the project context.
    -- NOT applied automatically — the user confirms/discards them.
    CREATE TABLE IF NOT EXISTS context_suggestions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      chat_id TEXT,
      op TEXT NOT NULL,                       -- create | update | delete
      target_id INTEGER,                      -- for update/delete: project_context.id
      category TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '',
      valid_as_of TEXT NOT NULL DEFAULT '',
      reason TEXT NOT NULL DEFAULT '',         -- the curator's reason
      status TEXT NOT NULL DEFAULT 'pending',  -- pending | applied | dismissed
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sugg_project ON context_suggestions(project_id, status);

    -- LEGACY: the architecture map is gone. These three tables
    -- (project_architecture, architecture_snapshots and active_arch_scans further down) stay
    -- on purpose — a DROP would be irreversible and buy nothing, while leaving out the
    -- DDL would break every FRESH database: the delete paths in workspaces.js still clear these tables
    -- with the project and would otherwise hit no such table.
    -- Architecture map: an AI agent analyzes the WHOLE project architecture and stores
    -- a graph (nodes/edges as JSON). Exactly one current state per project.
    CREATE TABLE IF NOT EXISTS project_architecture (
      project_id TEXT PRIMARY KEY,
      graph TEXT NOT NULL DEFAULT '',        -- JSON {nodes:[...], edges:[...], coverage:[...]}
      summary TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      generated_at INTEGER NOT NULL
    );

    -- Snapshot cache of the architecture graphs (several states per project). On open, the
    -- snapshot whose file hashes match the current code is chosen (e.g. after a branch switch
    -- back to an already analyzed state) — otherwise the newest one with per-node graying out.
    CREATE TABLE IF NOT EXISTS architecture_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      graph TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      generated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_archsnap_project ON architecture_snapshots(project_id, generated_at);

    -- MCP servers per workspace (as in the Claude desktop app). Enabled servers are mounted into
    -- every chat MCP config of this workspace and their tools are released.
    CREATE TABLE IF NOT EXISTS mcp_servers (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      project_id TEXT,                            -- NULL = workspace server; otherwise bound to a project
      name TEXT NOT NULL,
      transport TEXT NOT NULL DEFAULT 'stdio',  -- 'stdio' | 'http' | 'sse'
      command TEXT NOT NULL DEFAULT '',
      args TEXT NOT NULL DEFAULT '[]',            -- JSON array
      env TEXT NOT NULL DEFAULT '{}',             -- JSON-Object
      url TEXT NOT NULL DEFAULT '',               -- for http/sse
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mcp_ws ON mcp_servers(workspace_id);

    -- Active runs (persisted so they survive a backend/container restart):
    -- while a run runs there is a row here; the finally of doRun clears it.
    -- At start resumeInterruptedWork() finds orphaned rows = interrupted runs and
    -- resumes them. attempts caps crash loops (e.g. when the run triggered an OOM).
    CREATE TABLE IF NOT EXISTS active_runs (
      chat_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'chat',   -- 'chat'
      prompt TEXT NOT NULL DEFAULT '',
      goal_depth INTEGER NOT NULL DEFAULT 0,
      attachments TEXT NOT NULL DEFAULT '',  -- JSON or empty
      attempts INTEGER NOT NULL DEFAULT 0,
      started_at INTEGER NOT NULL
    );

    -- Runs stuck on the provider's USAGE LIMIT, resumed automatically as soon as
    -- the limit is reset (5-hour/weekly window for Claude, primary/secondary for
    -- Codex). Persisted because such a wait can take days and must not lose a restart:
    -- scheduleAutoContinue() reschedules all rows at start.
    -- due_at = time of the next attempt (reset + grace, or probe time for an
    -- unknown reset), resets_at = the reported reset of the blocking window.
    CREATE TABLE IF NOT EXISTS pending_resumes (
      chat_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'run',       -- run = repeat the turn · compact = catch up the compaction · judge = catch up the verdict
      payload TEXT NOT NULL DEFAULT '',       -- JSON: re-entry point of a verdict (see resumeJudge)
      prompt TEXT NOT NULL DEFAULT '',
      goal_depth INTEGER NOT NULL DEFAULT 0,
      attachments TEXT NOT NULL DEFAULT '',   -- JSON or empty
      todos INTEGER NOT NULL DEFAULT 0,       -- legacy: neither written nor read any more (the "create ToDo" switch is gone)
      provider TEXT NOT NULL DEFAULT '',
      limit_group TEXT NOT NULL DEFAULT '',   -- session | weekly | credits | spend
      limit_label TEXT NOT NULL DEFAULT '',   -- language-neutral, e.g. "weekly:Opus"
      reason TEXT NOT NULL DEFAULT '',        -- reset | probe
      evidence TEXT NOT NULL DEFAULT '',      -- excerpt of the message (for display)
      resets_at INTEGER NOT NULL DEFAULT 0,
      due_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      probes INTEGER NOT NULL DEFAULT 0,
      workflow INTEGER NOT NULL DEFAULT 0,    -- the run belongs to a workflow step
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pending_resumes_due ON pending_resumes(due_at);

    -- The queue per chat: messages that arrived during a turn or
    -- behind a parked continuation. They used to live only in a map of the
    -- process — since "parked counts as running" an entry can sit there for HOURS
    -- (days until the reset of a weekly limit), and a restart lost it without a trace.
    -- The map stays the truth in the process, this table is its image: per chat the
    -- whole list is replaced (replaceRunInputs), at start it is read back (listRunInputs).
    -- json is the entry as it stands in the map (id, prompt, display, attachments as
    -- descriptions — the bytes live in the attachment folder —, cause, silent; an old entry still
    -- carries the field todos of the removed "create ToDo" switch and is not evaluated);
    -- seq is the order in the list, nothing more.
    CREATE TABLE IF NOT EXISTS run_inputs (
      chat_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      json TEXT NOT NULL,
      PRIMARY KEY (chat_id, seq)
    );

    -- Active architecture scans (analogous; restartable, as incremental/idempotent).
    -- Third table of the legacy set above; without reader and writer since the teardown.
    CREATE TABLE IF NOT EXISTS active_arch_scans (
      project_id TEXT PRIMARY KEY,
      mode TEXT NOT NULL DEFAULT 'full',
      attempts INTEGER NOT NULL DEFAULT 0,
      started_at INTEGER NOT NULL
    );
  `);
  // The scope-aware unique index (workspace_id, project_id, name) is created only AFTER the project_id migration
  // (below) — otherwise it would reference a column still missing on old databases and crash initStore.
  // Migrations for existing databases (CREATE TABLE IF NOT EXISTS adds no columns).
  try {
    db.exec("ALTER TABLE chats ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
  } catch {
    // Column already exists — ignore.
  }
  // OKF fields on knowledge (project_context full, context_items light — no repo, no git fields).
  for (const [table, col, def] of [
    ["project_context", "slug", "TEXT NOT NULL DEFAULT ''"],
    ["project_context", "status", "TEXT NOT NULL DEFAULT 'active'"],
    ["project_context", "superseded_by", "TEXT NOT NULL DEFAULT ''"],
    ["project_context", "owners", "TEXT NOT NULL DEFAULT ''"],
    ["project_context", "links", "TEXT NOT NULL DEFAULT ''"],
    ["project_context", "code_paths", "TEXT NOT NULL DEFAULT ''"],
    ["project_context", "symbols", "TEXT NOT NULL DEFAULT ''"],
    ["project_context", "last_verified", "TEXT NOT NULL DEFAULT ''"],
    ["project_context", "confidence", "TEXT NOT NULL DEFAULT ''"],
    ["context_items", "slug", "TEXT NOT NULL DEFAULT ''"],
    ["context_items", "status", "TEXT NOT NULL DEFAULT 'active'"],
    ["context_items", "owners", "TEXT NOT NULL DEFAULT ''"],
    ["context_items", "links", "TEXT NOT NULL DEFAULT ''"],
    ["context_items", "confidence", "TEXT NOT NULL DEFAULT ''"],
    ["context_items", "updated_at", "INTEGER NOT NULL DEFAULT 0"],
    // Persistent sentence vector per knowledge entry (retrieval.js). Valid as long as embedding_at >= updated_at AND
    // embedding_model matches the current model — the reader checks both, this only stores.
    ["project_context", "embedding", "BLOB"],
    ["project_context", "embedding_at", "INTEGER NOT NULL DEFAULT 0"],
    ["project_context", "embedding_model", "TEXT NOT NULL DEFAULT ''"],
    ["context_items", "embedding", "BLOB"],
    ["context_items", "embedding_at", "INTEGER NOT NULL DEFAULT 0"],
    ["context_items", "embedding_model", "TEXT NOT NULL DEFAULT ''"],
    // What waits at the limit: a turn ('run') or a compaction ('compact'). Old rows are turns by definition — the
    // default fits, no backfill needed.
    ["pending_resumes", "kind", "TEXT NOT NULL DEFAULT 'run'"],
    ["pending_resumes", "payload", "TEXT NOT NULL DEFAULT ''"],
    // Output length per provider (0 = provider default).
    ["providers", "max_tokens", "INTEGER NOT NULL DEFAULT 0"],
    // Extra fields for every request body of the provider (JSON object) — carries e.g. the OpenRouter provider routing
    // ({provider:{order,sort,…}}) without extending the contract per field.
    ["providers", "extra_body", "TEXT NOT NULL DEFAULT '{}'"],
    // Skill frontmatter: without these columns an imported skill lost its `allowed-tools` on save and could no longer
    // restrict its tools.
    ["skills", "allowed_tools", "TEXT NOT NULL DEFAULT ''"],
    ["skills", "model", "TEXT NOT NULL DEFAULT ''"],
    // Visibility per area. The defaults ARE the migration: an existing skill gets exactly `for_coding = 1` and
    // `for_managing = 0` on ALTER TABLE. Every skill belongs to EXACTLY ONE area (invariant "exactly one marker is 1";
    // both or none: put in order on every start by store/toolchain.js arrangeSkillAreas).
    ["skills", "for_coding", "INTEGER NOT NULL DEFAULT 1"],
    ["skills", "for_managing", "INTEGER NOT NULL DEFAULT 0"],
    // Chat folder (purely logical grouping of the chat list). NULL = no folder.
    ["chats", "folder_id", "TEXT"],
    // Skills of a subagent: comma list of skill names that are loaded IN FULL into its system prompt at start — not
    // just as a catalog line.
    ["agents", "skills", "TEXT NOT NULL DEFAULT ''"],
    // Tool list of a subagent as a JSON list: NULL = not set, '[]' = empty — `tools` (comma list) could not tell the two
    // apart and stays next to it for display. A row with `tools` and NULL here is a definition from before the
    // migration (toolchain/agent-tools.js).
    ["agents", "tool_list", "TEXT"],
    // The Coding MCP servers of an agent type: JSON `{ <serverId>: null | [tool, …] }` — null = the whole server, a list
    // = only these tools; '{}' = none. A subagent of this type gets them even without "subagents inherit"
    // (toolchain/agent-mcp.js, runs/agent-set.js codingSet).
    ["agents", "mcp", "TEXT NOT NULL DEFAULT '{}'"],
  ]) {
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); } catch { /* already exists */ }
  }
  // Slug backfill (idempotent — only touches entries without a slug, including future legacy imports).
  try {
    for (const [table, scopeCol] of [["project_context", "project_id"], ["context_items", "workspace_id"]]) {
      for (const r of db.prepare(`SELECT id, ${scopeCol} AS scope, title FROM ${table} WHERE slug = ''`).all()) {
        const taken = new Set(db.prepare(`SELECT slug FROM ${table} WHERE ${scopeCol} = ? AND slug != ''`).all(r.scope).map((x) => x.slug));
        let base = slugifyTitle(r.title) || `entry-${r.id}`, slug = base;
        for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
        db.prepare(`UPDATE ${table} SET slug = ? WHERE id = ?`).run(slug, r.id);
      }
    }
    db.exec("UPDATE context_items SET updated_at = created_at WHERE updated_at = 0");
  } catch { /* backfill is best effort — never fail the start */ }
  // ── Full-text index (FTS5) for the knowledge read path ──────────────────────
  // External content (content=) → no duplicate storage, bm25() is available, and the initial build is a single
  // 'rebuild'. Tokenizer unicode61 with diacritics folding so that "Läufe" and "laufe" fall on the same term.
  // DELIBERATELY no Porter stemmer: it is English and would degrade German word forms — retrieval.js builds the query
  // stems. The update triggers hang on `UPDATE OF <columns>` so that writing a vector (setContextEmbedding) does not
  // rebuild the index every time.
  for (const [table, cols] of [
    ["project_context", ["title", "summary", "body", "tags", "slug", "owners", "symbols", "code_paths"]],
    ["context_items", ["title", "summary", "body", "tags", "slug", "owners"]],
  ]) {
    const fts = `${table}_fts`;
    const list = cols.join(", ");
    const newVals = cols.map((c) => `new.${c}`).join(", ");
    const oldVals = cols.map((c) => `old.${c}`).join(", ");
    try {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS ${fts} USING fts5(
          ${list}, content='${table}', content_rowid='id',
          tokenize='unicode61 remove_diacritics 2'
        );
        CREATE TRIGGER IF NOT EXISTS ${table}_fts_ai AFTER INSERT ON ${table} BEGIN
          INSERT INTO ${fts}(rowid, ${list}) VALUES (new.id, ${newVals});
        END;
        CREATE TRIGGER IF NOT EXISTS ${table}_fts_ad AFTER DELETE ON ${table} BEGIN
          INSERT INTO ${fts}(${fts}, rowid, ${list}) VALUES ('delete', old.id, ${oldVals});
        END;
        CREATE TRIGGER IF NOT EXISTS ${table}_fts_au AFTER UPDATE OF ${list} ON ${table} BEGIN
          INSERT INTO ${fts}(${fts}, rowid, ${list}) VALUES ('delete', old.id, ${oldVals});
          INSERT INTO ${fts}(rowid, ${list}) VALUES (new.id, ${newVals});
        END;
      `);
      // Migration of existing databases AND self-healing: 'rebuild' creates the index in one go from the content.
      // Idempotent and, for knowledge tables of this size (hundreds of rows, not millions), cheap enough for every
      // start — it saves a state column and repairs an index a direct writer has skewed.
      db.exec(`INSERT INTO ${fts}(${fts}) VALUES('rebuild')`);
    } catch (e) {
      console.error(`[store] FTS5 for ${table} not available — the knowledge search loses the BM25 signal:`,
        String(e?.message || e).slice(0, 200));
    }
  }
  try {
    // Origin of an application: 'manual' (dialog/MCP) or 'scan' (automatically from the service scan).
    db.exec("ALTER TABLE apps ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'");
  } catch {
    // Column already exists — ignore.
  }
  try {
    // Notifications per chat: JSON `{ "<kind>": "on" | "off" }`. A missing kind means the global default — "default"
    // is NOT stored, it is the absence of an entry. A JSON column and not a table of its own: there is nothing one
    // would ever have to search for individually.
    db.exec("ALTER TABLE chats ADD COLUMN notify TEXT NOT NULL DEFAULT '{}'");
  } catch {
    // Column already exists — ignore.
  }
  try {
    // Autocompact per chat: NULL = default (global setting), 0 = off, otherwise a level in percent of the context
    // window (see autocompact.js). Deliberately WITHOUT a default: "default" is the absence of a value, not a stored one.
    db.exec("ALTER TABLE chats ADD COLUMN autocompact INTEGER");
  } catch {
    // Column already exists — ignore.
  }
  // The cap in tokens per chat, three-valued like the share: NULL = default (global cap), 0 = no cap for this chat,
  // otherwise one of the cap levels. Backfill: `autocompact = 0` used to mean "do not compact this chat at all", and
  // the cap was coupled to the same value. With a column of its own such a chat would silently inherit the global
  // cap — so the refusal is written out. Column and backfill in ONE transaction (columnWithBackfill).
  columnWithBackfill("chats", "autocompact_max", "ALTER TABLE chats ADD COLUMN autocompact_max INTEGER",
    "UPDATE chats SET autocompact_max = 0 WHERE autocompact = 0");
  try {
    // The special role of a manager chat (formerly the boolean marker `pipeline`). Since the removal of Managing this is
    // read-only legacy of old stores — the column stays. The marker sits on the CHAT and not on the agent, and it
    // is MULTI-VALUED because there was a second special chat. The default '' IS the migration for every existing row.
    db.exec("ALTER TABLE chats ADD COLUMN specialRole TEXT NOT NULL DEFAULT ''");
  } catch {
    // Column already exists — ignore.
  }
  // Exactly ONE chat per workspace AND role — as an index, not a convention. The second column in the index is the
  // whole point: over the workspace alone a workspace could have only a single special chat.
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS ux_chats_special_role ON chats(workspace_id, specialRole) WHERE specialRole != ''");
  // Chat kind: 'normal' (chat list) or 'conflict' (registration agent — no longer has an agent, old chats stay
  // readable as legacy). The column comes with the DDL of every cbase database; this only adds it to a database
  // without it, where no conflict chat can exist (no backfill).
  columnWithBackfill("chats", "kind", "ALTER TABLE chats ADD COLUMN kind TEXT NOT NULL DEFAULT 'normal'", null);
  try {
    // Origin of a service: 'scan' is replaced on re-scans, 'manual' (UI/MCP/agent) stays.
    // Existing rows deliberately stay 'manual' (default) — re-scans silently skip own ports anyway.
    db.exec("ALTER TABLE app_services ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'");
  } catch {
    // Column already exists — ignore.
  }
  try {
    // File attachments of a message: JSON array [{name, file, mime, size}] or NULL.
    db.exec("ALTER TABLE messages ADD COLUMN attachments TEXT");
  } catch {
    // Column already exists — ignore.
  }
  try {
    // Model per chat ('' = profile/CLI default); selectable in the composer.
    db.exec("ALTER TABLE chats ADD COLUMN model TEXT NOT NULL DEFAULT ''");
  } catch {
    // Column already exists — ignore.
  }
  try {
    // Context window load of the last run (input + cache + output tokens of the last request).
    db.exec("ALTER TABLE chats ADD COLUMN context_tokens INTEGER NOT NULL DEFAULT 0");
  } catch {
    // Column already exists — ignore.
  }
  try {
    // Permission mode per chat ('' = profile default); selectable in the composer.
    db.exec("ALTER TABLE chats ADD COLUMN permission_mode TEXT NOT NULL DEFAULT ''");
  } catch {
    // Column already exists — ignore.
  }
  try {
    // Reasoning effort per chat ('' = provider default; otherwise a level from EFFORT_LEVELS (workflows.js):
    // low|medium|high|xhigh|max; a legacy value from the time of the sixth level migrates to max at start,
    // store/chats.js migrateUltraToMax). What MAY stand here is said by that list; what a model really supports is
    // decided by the clamp at spawn (mapEffort per connector) — the column is the user's choice, not a promise.
    // Chosen in the composer and additionally per workflow run (run_settings.effort).
    db.exec("ALTER TABLE chats ADD COLUMN effort TEXT NOT NULL DEFAULT ''");
  } catch {
    // Column already exists — ignore.
  }
  try {
    // Overall goal of the chat (set by the user via /goal) — appended to every system prompt.
    db.exec("ALTER TABLE chats ADD COLUMN goal TEXT NOT NULL DEFAULT ''");
  } catch {
    // Column already exists — ignore.
  }
  try {
    // Compacted history summary (after /compact): injected once into the next fresh run, then cleared. The old
    // Claude session is discarded.
    db.exec("ALTER TABLE chats ADD COLUMN context_summary TEXT NOT NULL DEFAULT ''");
  } catch {
    // Column already exists — ignore.
  }
  try {
    // Fork marker: if this chat was forked from another, the NEXT run sets --fork-session once (it inherits the
    // origin's claude_session_id and then gets its own).
    db.exec("ALTER TABLE chats ADD COLUMN fork_pending INTEGER NOT NULL DEFAULT 0");
  } catch {
    // Column already exists — ignore.
  }
  // titled=1 once the chat has a real title (automatic OR renamed by hand). Prevents renewed auto-titling. Existing
  // chats are marked as titled once so they are NOT renamed after the fact — with the column in ONE transaction:
  // without the backfill every existing chat would count as untitled and be auto-renamed.
  columnWithBackfill("chats", "titled", "ALTER TABLE chats ADD COLUMN titled INTEGER NOT NULL DEFAULT 0",
    "UPDATE chats SET titled = 1 WHERE title != 'New chat'");
  try {
    // Provider of this chat ('' = global default; otherwise 'claude' | 'codex'). Fixed at creation from the app setting
    // so that a later global switch does not break session resumption (session_id is provider specific) of existing chats.
    db.exec("ALTER TABLE chats ADD COLUMN provider TEXT NOT NULL DEFAULT ''");
  } catch {
    // Column already exists — ignore.
  }
  try {
    // Visibility of the built-in Playwright browser per chat ('' = follows the global setting playwright_headless;
    // 'shown' = visible window; 'hidden' = headless/background).
    db.exec("ALTER TABLE chats ADD COLUMN browser_mode TEXT NOT NULL DEFAULT ''");
  } catch {
    // Column already exists — ignore.
  }
  try {
    // Briefing that is put in front of this chat's system prompt. Unlike `goal` (set by the user via /goal) it holds
    // ONLY for this one chat.
    db.exec("ALTER TABLE chats ADD COLUMN briefing TEXT NOT NULL DEFAULT ''");
  } catch {
    // Column already exists — ignore.
  }
  try {
    // Ultracode: a MODE next to the effort level, not a level — 0 = off, 1 = on. Switching it on sets `effort`
    // (clamped xhigh); only the level goes to the CLI.
    db.exec("ALTER TABLE chats ADD COLUMN ultracode INTEGER NOT NULL DEFAULT 0");
  } catch {
    // Column already exists — ignore.
  }
  // Whose conversation (`agent_id`) and, for a scheduled run, schedule plus run (`schedule_id`, `schedule_run_id`) —
  // the columns of the former manager agents and schedules. They STAY because createChat (store/chats.js) names
  // `agent_id` and `schedule_id` in its INSERT — without them every chat creation on a fresh store would fail. No path
  // of the app writes anything but NULL there any more; values only exist in manager chats of a store from before the
  // removal of Managing. The index stays with them.
  for (const col of ["agent_id TEXT", "schedule_id TEXT", "schedule_run_id INTEGER"]) {
    try { db.exec(`ALTER TABLE chats ADD COLUMN ${col}`); } catch { /* column already exists */ }
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_chats_schedule ON chats(schedule_id)");
  try {
    // Docker container of a service (container_name or Compose service name) — run state/stop then go through
    // docker instead of the (possibly internal-only) port.
    db.exec("ALTER TABLE project_services ADD COLUMN container TEXT NOT NULL DEFAULT ''");
  } catch {
    // Column already exists — ignore.
  }
  try {
    // Origin of a service: 'scan' = created by the service scan, 'hand' = registered by hand (POST
    // /api/project-services, cbase_service_add), NULL = unknown — every row from before. The reconciliation of a
    // re-scan (store/projects.js reconcileScan) removes ONLY a 'scan' row it no longer finds and that neither runs
    // nor is part of an instance's target; it does not overwrite a 'hand' row (it only fills blanks), an unknown one
    // stays as before. Here and not in the schema registry: the table and its first column migration (`container`,
    // above) live in this block — a topic file with an ALTER for a db.js table would split one table's DDL in two.
    db.exec("ALTER TABLE project_services ADD COLUMN origin TEXT CHECK (origin IS NULL OR origin IN ('scan', 'hand'))");
  } catch {
    // Column already exists — ignore.
  }
  // Project-bound MCP servers: project_id NULL = workspace server; otherwise only in this project. Add the column
  // best effort; then replace the old (workspace_id, name) unique index by a scope-aware one (idempotent, also runs
  // when the column already existed).
  try { db.exec("ALTER TABLE mcp_servers ADD COLUMN project_id TEXT"); } catch { /* column already exists */ }
  db.exec("DROP INDEX IF EXISTS idx_mcp_ws_name");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_scope_name ON mcp_servers(workspace_id, IFNULL(project_id, ''), name)");
  // Clean up orphaned scan data of deleted projects (from before deleteProject removed it too).
  db.exec("DELETE FROM project_services WHERE project_id NOT IN (SELECT id FROM projects)");
  // Workspace credentials/variables/links (values local in the DB; MCP access controllable per entry).
  db.exec(`CREATE TABLE IF NOT EXISTS workspace_vars (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id TEXT NOT NULL,
    key TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'variable',
    value TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    mcp_access INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(workspace_id, key)
  )`);
  // Project credentials/variables/links — same structure, but bound to a project.
  // A chat in project focus (CBASE_PROJECT_ID set) sees these via MCP instead of the workspace values.
  db.exec(`CREATE TABLE IF NOT EXISTS project_vars (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    key TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'variable',
    value TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    mcp_access INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(project_id, key)
  )`);
  // Custom subagents (app managed, agent types of cbase_agent; NOT auto-discovered through .claude/agents so that
  // they can be switched on/off per project). project_id NULL = workspace agent; otherwise project bound.
  db.exec(`CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    project_id TEXT,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    tools TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    -- Skills the subagent gets loaded IN FULL into the system prompt at start
    -- (comma list of names; also in the migration list above for existing databases).
    skills TEXT NOT NULL DEFAULT '',
    -- Tool list as JSON: NULL = not set, '[]' = empty (also in the migration list above).
    tool_list TEXT,
    -- Coding MCP servers of the type as JSON { serverId: null | [tool] } (also in the migration list above).
    mcp TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_agents_ws ON agents(workspace_id)");
  // Which WORKSPACE agents are enabled in a project (default: none → off).
  db.exec(`CREATE TABLE IF NOT EXISTS project_agent_enabled (
    project_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    PRIMARY KEY (project_id, agent_id)
  )`);
  // Legacy: which WORKSPACE MCP servers a project had adopted (opt-in). Workspace servers now apply in every project,
  // the exceptions live in `project_mcp_excluded` (store/toolchain.js). This table is no longer read; it only stays
  // for a rollback and is still cleared by the delete paths.
  db.exec(`CREATE TABLE IF NOT EXISTS project_mcp_enabled (
    project_id TEXT NOT NULL,
    mcp_server_id TEXT NOT NULL,
    PRIMARY KEY (project_id, mcp_server_id)
  )`);
  // Workspace credentials are available in EVERY project (default: on) — a new workspace credential shows up in all
  // projects without further action. This table only carries the EXCEPTIONS: workspace vars a project has explicitly
  // hidden (opt-out). A project chat sees via MCP its own project credentials PLUS all workspace credentials not
  // hidden (on equal keys the project wins). A credential one creates should be there; hiding is the exception
  // one makes deliberately.
  db.exec(`CREATE TABLE IF NOT EXISTS project_var_excluded (
    project_id TEXT NOT NULL,
    workspace_var_id INTEGER NOT NULL,
    PRIMARY KEY (project_id, workspace_var_id)
  )`);
  // The old opt-in state is DISCARDED, not translated: the intent is that all workspace credentials become available
  // everywhere. "Hide everything except what was enabled" would have prevented exactly that — and under opt-in "not
  // enabled" could not be told from "deliberately left out" anyway.
  db.exec("DROP TABLE IF EXISTS project_var_enabled");
  // ssh_keys: stored keys for an sshd in the container; replaced by VS Code Remote Tunnels — no sshd, no key needed.
  db.exec("DROP TABLE IF EXISTS ssh_keys");
  // Legacy: which WORKSPACE skills a project had adopted (opt-in, keyed by skill name). RETIRED: a workspace Coding
  // skill applies in every project until the project hides it (`project_skill_excluded`, store/toolchain.js). The
  // table stays ONLY so that a rollback to an older release finds the old adoption — read once by the migration
  // (store/toolchain.js arrangeSkillAreas, only without its marker), never written; the delete paths still clear it.
  db.exec(`CREATE TABLE IF NOT EXISTS project_skill_enabled (
    project_id TEXT NOT NULL,
    skill_name TEXT NOT NULL,
    PRIMARY KEY (project_id, skill_name)
  )`);
  // Which WORKSPACE context CATEGORIES a project adopts (default: none → off). A project chat sees through
  // cbase_context_list its own entries PLUS the entries of the workspace categories adopted here (read-only —
  // maintenance stays at workspace level). Category based (categories are stable keys per workspace).
  db.exec(`CREATE TABLE IF NOT EXISTS project_context_adopt (
    project_id TEXT NOT NULL,
    category   TEXT NOT NULL,
    PRIMARY KEY (project_id, category)
  )`);
  // Provider-agnostic skills (source of truth). Like agents: project_id NULL = workspace skill; otherwise project
  // bound. body = SKILL.md content (without frontmatter). references/scripts/assets live — if present
  // (has_resources) — in the app resource store <dataDir>/skill-resources/<id>. At run time the catalog is in the
  // system prompt and the agent fetches the instructions through `cbase_skill` — the same path for every provider.
  db.exec(`CREATE TABLE IF NOT EXISTS skills (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    project_id TEXT,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    has_resources INTEGER NOT NULL DEFAULT 0,
    -- Frontmatter as in Claude Code: allowed_tools restricts the tools while the skill
    -- is active; model optionally picks another model. (Also in the migration list above — it
    -- runs BEFORE this CREATE and therefore only applies to already existing databases.)
    allowed_tools TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    -- Area (exactly one marker is 1). Same defaults as in the migration list above, so that
    -- a fresh and a migrated database behave alike; createSkill sets both from the area.
    for_coding INTEGER NOT NULL DEFAULT 1,
    for_managing INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_skills_ws ON skills(workspace_id)");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_skills_scope_name ON skills(workspace_id, IFNULL(project_id, ''), name)");
  // Workflows: node/edge graph an agent works through step by step. Scoping like skills/agents (project_id NULL =
  // workspace workflow, otherwise project bound), adoption via project_workflow_enabled. The graph is JSON in ONE
  // column instead of node/edge tables: it is always loaded and saved as a whole (the editor sends the complete
  // graph), there are no partial queries. active = the triggers of this workflow are armed (the poller asks GitLab).
  // Without a trigger node the column is meaningless; a workflow can always be started by hand.
  db.exec(`CREATE TABLE IF NOT EXISTS workflows (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    project_id TEXT,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    graph TEXT NOT NULL DEFAULT '{"nodes":[],"edges":[]}',
    active INTEGER NOT NULL DEFAULT 0,
    lock_scope TEXT NOT NULL DEFAULT 'project',   -- project|workflow|event|custom|off (s. workflow_locks)
    lock_key TEXT NOT NULL DEFAULT '',            -- Template, only at lock_scope = 'custom'
    run_settings TEXT NOT NULL DEFAULT '{}',      -- normalizeRunSettings (workflows.js); one old field todos gets ignored
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  try { db.exec("ALTER TABLE workflows ADD COLUMN active INTEGER NOT NULL DEFAULT 0"); } catch { /* column already exists */ }
  // Concurrency per workflow (see workflow_locks). Default "project": one run per project/repo — a safe default,
  // because two runs in the same repo overwrite each other.
  try { db.exec("ALTER TABLE workflows ADD COLUMN lock_scope TEXT NOT NULL DEFAULT 'project'"); } catch { /* column already exists */ }
  try { db.exec("ALTER TABLE workflows ADD COLUMN lock_key TEXT NOT NULL DEFAULT ''"); } catch { /* column already exists */ }
  // Run settings (provider/model/permissions/effort) — a triggered run has no user choosing them in the composer.
  try { db.exec("ALTER TABLE workflows ADD COLUMN run_settings TEXT NOT NULL DEFAULT '{}'"); } catch { /* column already exists */ }
  db.exec("CREATE INDEX IF NOT EXISTS idx_workflows_ws ON workflows(workspace_id)");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_workflows_scope_name ON workflows(workspace_id, IFNULL(project_id, ''), name)");
  // Which WORKSPACE workflows a project has adopted (default: none → off), name based like project_skill_enabled.
  db.exec(`CREATE TABLE IF NOT EXISTS project_workflow_enabled (
    project_id TEXT NOT NULL,
    workflow_name TEXT NOT NULL,
    PRIMARY KEY (project_id, workflow_name)
  )`);
  // Workflow runs — ONE row PER RUN (key `id`), not per chat: that makes the history a side effect instead of a second
  // table. A chat drives at most one run AT A TIME, but a second run in the same chat must not overwrite the first.
  // cursor carries the complete execution state (current node, loop frames, variables) as JSON and survives backend
  // restarts: the resumed run reads it and continues. workspace_id/project_id are part of the row so that the run
  // list can still filter after the chat was deleted (the history deliberately stays — it IS the evidence).
  db.exec(`CREATE TABLE IF NOT EXISTS workflow_runs (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    workflow_id TEXT NOT NULL,
    workflow_name TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'running',  -- running | waiting | done | failed | cancelled
    cursor TEXT NOT NULL DEFAULT '{}',
    input TEXT NOT NULL DEFAULT '',
    step INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0,
    node_id TEXT NOT NULL DEFAULT '',
    node_title TEXT NOT NULL DEFAULT '',
    question TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    origin TEXT NOT NULL DEFAULT '',         -- '' = started by hand, 'trigger' = from outside
    trigger_event TEXT NOT NULL DEFAULT '',  -- JSON of the triggering event (kind/summary/url)
    workspace_id TEXT NOT NULL DEFAULT '',
    project_id TEXT,
    chat_gone INTEGER NOT NULL DEFAULT 0,    -- chat deleted: the run stays, the reference is dead
    started_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    ended_at INTEGER NOT NULL DEFAULT 0
  )`);
  // Migration of the old version (PRIMARY KEY chat_id, no origin column): SQLite cannot change the key → new table,
  // copy, swap. The existing rows are the LAST runs of their chats and move over completely.
  {
    const cols = db.prepare("PRAGMA table_info(workflow_runs)").all();
    if (cols.length && !cols.some((c) => c.name === "origin")) {
      db.exec("ALTER TABLE workflow_runs RENAME TO workflow_runs_old");
      db.exec(`CREATE TABLE workflow_runs (
        id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, workflow_id TEXT NOT NULL,
        workflow_name TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'running',
        cursor TEXT NOT NULL DEFAULT '{}', input TEXT NOT NULL DEFAULT '',
        step INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0,
        node_id TEXT NOT NULL DEFAULT '', node_title TEXT NOT NULL DEFAULT '',
        question TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
        origin TEXT NOT NULL DEFAULT '', trigger_event TEXT NOT NULL DEFAULT '',
        workspace_id TEXT NOT NULL DEFAULT '', project_id TEXT,
        chat_gone INTEGER NOT NULL DEFAULT 0,
        started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, ended_at INTEGER NOT NULL DEFAULT 0
      )`);
      db.exec(`INSERT OR IGNORE INTO workflow_runs
        (id, chat_id, workflow_id, workflow_name, status, cursor, input, step, total, node_id,
         node_title, question, note, origin, trigger_event, workspace_id, project_id, chat_gone,
         started_at, updated_at, ended_at)
        SELECT o.id, o.chat_id, o.workflow_id, o.workflow_name, o.status, o.cursor, o.input, o.step,
               o.total, o.node_id, o.node_title, o.question, o.note, '', '',
               IFNULL(c.workspace_id, ''), c.project_id, CASE WHEN c.id IS NULL THEN 1 ELSE 0 END,
               o.started_at, o.updated_at,
               CASE WHEN o.status IN ('running','waiting') THEN 0 ELSE o.updated_at END
        FROM workflow_runs_old o LEFT JOIN chats c ON c.id = o.chat_id`);
      db.exec("DROP TABLE workflow_runs_old");
    }
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_wfruns_chat ON workflow_runs(chat_id, started_at DESC)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_wfruns_ws ON workflow_runs(workspace_id, started_at DESC)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_wfruns_wf ON workflow_runs(workflow_id, started_at DESC)");
  // Step log of a run — append ONLY, never changed (except adding duration and result once the turn has ended).
  // `detail` carries what is really missing when debugging: the prompt the agent was sent off with, the result
  // excerpt, the verdict of a condition/list model INCLUDING raw output on failure, and the error text.
  db.exec(`CREATE TABLE IF NOT EXISTS workflow_run_steps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    kind TEXT NOT NULL,                      -- trigger|start|step|decision|loop|ask|skip|end|error
    node_id TEXT NOT NULL DEFAULT '',
    node_title TEXT NOT NULL DEFAULT '',
    step INTEGER NOT NULL DEFAULT 0,
    detail TEXT NOT NULL DEFAULT '{}'
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_wfsteps_run ON workflow_run_steps(run_id, id)");
  // Locks against concurrency: ONE open run per key. The row is valid exactly as long as its run is open — so
  // reapStaleLocks() is enough as cleanup after a crash (a lock without an open run is orphaned by definition).
  db.exec(`CREATE TABLE IF NOT EXISTS workflow_locks (
    key TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    chat_id TEXT NOT NULL DEFAULT '',
    workflow_id TEXT NOT NULL DEFAULT '',
    workflow_name TEXT NOT NULL DEFAULT '',
    workspace_id TEXT NOT NULL DEFAULT '',
    at INTEGER NOT NULL
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_wflocks_run ON workflow_locks(run_id)");
  // Connected GitLab accounts (global, like the provider configurations). The token is a secret: a plain-text
  // column that NEVER goes to the frontend (only hasToken there).
  db.exec(`CREATE TABLE IF NOT EXISTS gitlab_accounts (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL DEFAULT '',
    host TEXT NOT NULL,
    token TEXT NOT NULL DEFAULT '',
    user_name TEXT NOT NULL DEFAULT '',
    user_id INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT '',            -- '' = last in ordering, otherwise the error message
    checked_at INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  // State PER trigger node: up to when was polled and which events were already consumed. Without this row every
  // restart would fire the history again. `seen` is a short ring of the last event keys — GitLab delivers events by
  // day (feed) or by timestamp, both overlap at the edges.
  db.exec(`CREATE TABLE IF NOT EXISTS workflow_trigger_state (
    workflow_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    since INTEGER NOT NULL DEFAULT 0,
    seen TEXT NOT NULL DEFAULT '[]',
    last_poll_at INTEGER NOT NULL DEFAULT 0,
    last_fire_at INTEGER NOT NULL DEFAULT 0,
    last_error TEXT NOT NULL DEFAULT '',
    fires INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (workflow_id, node_id)
  )`);
  // The watermark PER EVENT KIND ({ kind: ms }, JSON). `since` stays the minimum over the kinds; per kind
  // max(since, since_kind[kind]) applies. With ONE watermark it jumped, after one kind failed, past that kind's
  // unread events (the other kind had delivered something newer) — they never came back.
  try { db.exec("ALTER TABLE workflow_trigger_state ADD COLUMN since_kind TEXT NOT NULL DEFAULT '{}'"); } catch { /* column already exists */ }
  // The read pointer PER KIND ({ kind: ms }, JSON) for a backlog of more than 1,000 entries since the watermark — it
  // is read ascending over several ticks, each from the pointer; the watermark stays put meanwhile.
  try { db.exec("ALTER TABLE workflow_trigger_state ADD COLUMN continue_kind TEXT NOT NULL DEFAULT '{}'"); } catch { /* column already exists */ }
  // Additional LLM providers (global). api_key = secret (plain text locally like the vars secrets; NEVER back to the
  // frontend). Today the table only carries the ACCESS to OpenRouter, in exactly one row `openrouter`
  // (store/provider.js); nobody reads the remaining columns any more.
  //
  // `extra_body` is ALSO in the ALTER list further up and still has to be here: that list runs BEFORE this CREATE,
  // on a fresh store against a table that does not exist yet. The error is swallowed there — and the column would be
  // missing forever ("table providers has no column named extra_body" on a fresh installation).
  db.exec(`CREATE TABLE IF NOT EXISTS providers (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL DEFAULT '',
    preset TEXT NOT NULL,
    base_url TEXT NOT NULL DEFAULT '',
    api_key TEXT NOT NULL DEFAULT '',
    models TEXT NOT NULL DEFAULT '[]',
    model_map TEXT NOT NULL DEFAULT '{}',
    headers TEXT NOT NULL DEFAULT '{}',
    caps TEXT NOT NULL DEFAULT '{}',
    max_tokens INTEGER NOT NULL DEFAULT 0,
    extra_body TEXT NOT NULL DEFAULT '{}',
    default_model TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);

  // Git credentials per workspace + host (HTTPS remotes). Secret like providers/vars: plain-text column, NEVER
  // delivered to the frontend (only hasSecret).
  db.exec(`CREATE TABLE IF NOT EXISTS workspace_git_creds (
    workspace_id TEXT NOT NULL,
    host TEXT NOT NULL,
    username TEXT NOT NULL,
    secret TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, host)
  )`);

  // Token consumption per finished run — for ALL providers, including the native CLIs.
  // `billing` separates the two questions that meet here:
  //   metered      — third-party provider, costs per token. Basis of the cost report.
  //   subscription — Claude/Codex on a subscription. Costs no token price but uses up the time-window quota.
  //                  Recorded to see WHERE it goes, and kept out of the cost calculation.
  // `kind` separates the main stream from subagents: subagents cost real tokens but the context count hides them
  // (parent_tool_use_id).
  // chat_id/run_id/step anchor the consumption where it arose — without them an expensive run cannot be traced back
  // to the step that caused it.
  // Cost: the amount reported by OpenRouter (`cost_usd`) together with its origin (`cost_origin`, store/account.js);
  // there is no price table.
  db.exec(`CREATE TABLE IF NOT EXISTS usage_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL,
    model TEXT NOT NULL DEFAULT '',
    input INTEGER NOT NULL DEFAULT 0,
    output INTEGER NOT NULL DEFAULT 0,
    cached INTEGER NOT NULL DEFAULT 0,
    at INTEGER NOT NULL,
    billing TEXT NOT NULL DEFAULT 'metered',
    kind TEXT NOT NULL DEFAULT 'main',
    chat_id TEXT NOT NULL DEFAULT '',
    run_id TEXT NOT NULL DEFAULT '',
    step INTEGER NOT NULL DEFAULT 0,
    secs INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT '',
    agent_id TEXT NOT NULL DEFAULT ''
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_usage_provider ON usage_events(provider)");
  // Retrofit for existing databases. Deliberately HERE and not in the migration block further up: there it would run
  // before the CREATE TABLE and do nothing on a fresh DB. Old rows are all third-party main runs — the defaults fit.
  // The current state is read ONCE instead of letting the ALTER TABLEs run and fail blindly: on a fresh DB all
  // columns already exist, that would be one exception each per start.
  {
    const have = new Set(db.prepare("PRAGMA table_info(usage_events)").all().map((c) => c.name));
    for (const [col, def] of [
      ["billing", "TEXT NOT NULL DEFAULT 'metered'"],
      ["kind", "TEXT NOT NULL DEFAULT 'main'"],
      ["chat_id", "TEXT NOT NULL DEFAULT ''"],
      ["run_id", "TEXT NOT NULL DEFAULT ''"],
      ["step", "INTEGER NOT NULL DEFAULT 0"],
      ["secs", "INTEGER NOT NULL DEFAULT 0"],
      // Where a one-off call comes from (`source`: '' | 'abruf' | 'outer_loop' | 'einmal', allowlist in store/account.js
      // addUsageEvent) and which agent caused it. Old rows: '' — no reader filters by it so far.
      ["source", "TEXT NOT NULL DEFAULT ''"],
      ["agent_id", "TEXT NOT NULL DEFAULT ''"],
    ]) {
      if (!have.has(col)) db.exec(`ALTER TABLE usage_events ADD COLUMN ${col} ${def}`);
    }
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_usage_chat ON usage_events(chat_id, at)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_usage_run ON usage_events(run_id, step)");
  // The ToDo list (`todos`, `todo_chats`, `todo_context`) fell with Managing: a store no longer creates it.
  // Chat folders: a purely logical grouping of the chat list — NO folder is created in the file system. A folder
  // belongs to exactly one workspace and optionally to ONE project; a chat may only go into folders of the same scope
  // (workspace chat → workspace folder, project chat → folder of the same project). Chats of a folder share their
  // artifacts READ-ONLY as long as they are in the same folder.
  db.exec(`CREATE TABLE IF NOT EXISTS chat_folders (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    project_id TEXT,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  // Kind of the folder: 'normal' (Coding chats) or 'manager' (legacy conversations of the manager). SEPARATE stocks,
  // not one mixed tree: the folder context files (_ctx/<id>) are built for Coding chats.
  try { db.exec("ALTER TABLE chat_folders ADD COLUMN kind TEXT NOT NULL DEFAULT 'normal'"); }
  catch { /* column already exists */ }
  db.exec("CREATE INDEX IF NOT EXISTS idx_chat_folders_ws ON chat_folders(workspace_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_chats_folder ON chats(folder_id)");
  // Global app settings as key/value (e.g. the active provider claude|codex).
  db.exec(`CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
  )`);
  try {
    // Legacy: the column carried the create permission of a removed toggle across a restart. The DDL stays so that the
    // schema is unchanged — the column is no longer written or read (store/runs.js).
    db.exec("ALTER TABLE active_runs ADD COLUMN todos INTEGER NOT NULL DEFAULT 0");
  } catch {
    // Column already exists — ignore.
  }
  // The boards of the C4 planner (three tables) are gone: a store no longer creates them. The manager layer
  // (`manager_sources`, `manager_facts`, `manager_project_facts`, `manager_proposals`, `manager_proposal_items`,
  // `manager_docs`) fell with Managing — like the ToDo list above.
  runSchemata();
}

export const isUniqueViolation = (err) => String(err && err.message).includes("UNIQUE constraint failed");

// `columnWithBackfill` is also used by the topic files (store/chats.js initArchiveSchema).
export { db, skillResRoot, inOneTransaction, columnWithBackfill };
