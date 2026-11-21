# `store/` — the data layer (SQLite)

**What lives here:** everything that reads or writes `automater.db` — schema and migrations of the core (`db.js`), the
schema registry (`schema.js`, a leaf with ZERO imports), and ONE topic file per subject. Every topic file imports `{ db }`
from `db.js` (live binding) and otherwise only siblings and `_util.js`.

**What does NOT live here:** routes, runs, prompts, tools. No domain code is called from here, and `store/` imports no
domain folder (`server/backend/test/import-direction.test.js`). `../store.js` is the facade (`export *` over the topic
files) and it is MANDATORY: outside `store/` only `store.js` imports from `store/<topic>.js` (same guard, test "store
facade"). `db` and `skillResRoot` are invisible outside `store/`. What "active", "effective" or "allowed" means is computed
by the domain folders — here are only rows.

## Terms → file

| Subject | File |
|---|---|
| Connection, core tables, core migrations, the ONE transaction (`inOneTransaction`), `columnWithBackfill` | `db.js` |
| Schema registry (`registerSchema`, `runSchemata`) | `schema.js` |
| Workspaces, app settings (`app_settings`), git credentials, variables/credentials, the two delete lists (`deleteWorkspace`, `deleteProject`) | `workspaces.js` |
| Projects, project services (scan reconciliation `reconcileScan`), project context, ports and THE conflict calculation (`portConflicts(converted, claims?)`, `projectPortConflicts(converted)` — the set of converted projects is mandatory and comes from `projectbox/network-targets.js:convertedProjects`) | `projects.js` |
| Toolchain: subagent definitions (`agents`; the tool list is JSON in `agents.tool_list`, `NULL` = not set, `[]` = nothing, `tools` is only the comma list written from it for display), MCP servers with the airlock columns, skills and their areas | `toolchain.js` |
| Chats and chat folders, messages, archive (`archived_at`, the three triggers of the folder rule, archive side `without`/`only`/`including`), auto-archive candidates, instance binding (`chats.instance`), job binding (`chats.job_id`) | `chats.js` |
| Full-text search over chat messages (`messages_fts`, contentless FTS5, catch-up state `messages_fts_state`; registered as "chat-search") | `chat-search.js` |
| Runs (one turn), rows waiting at the limit, the persisted queue, silent hints to the next turn (`chat_hints`) | `runs.js` |
| Subagents that survive a restart (`subagents`, `subagent_history`) | `subagents.js` |
| Context/knowledge with FTS and vectors | `context.js` |
| Workflows, triggers, locks, workflow runs | `workflows.js` |
| Library of dynamic workflows (`dyn_workflows`, adoption per project) | `dynworkflows.js` |
| Runs and journal of dynamic workflows (`dyn_workflow_runs`, `dyn_workflow_journal`, `dyn_workflow_agent_history`, `dyn_workflow_events`) | `dynworkflow-runs.js` |
| Starts of graph workflows from the chat (`graph_starts`, child chat `child_chat_id`, queued messages `graph_messages`) | `graph-starts.js` |
| Ultracode reminder state per chat | `ultracode-reminder.js` |
| Agenda per Coding chat (`chat_agenda`), log of the agenda keeper (`agenda_upkeep`) | `agenda.js`, `agenda-upkeep.js` |
| Skill history, trash and deletion requests | `skill-history.js` |
| Instructions for agents (sections per workspace/project) | `instructions.js` |
| Outer loop: agents, takeover, activation, runs, notes with FTS | `outer-loop.js` |
| Channels | `channels.js` |
| Scheduled: jobs (`scheduled_jobs`), job runs (`scheduled_runs`) | `scheduled.js` |
| Timeline (append-only) | `timeline.js` |
| Account, usage events (`usage_events`: source, agent, cost and its origin), provider access (the one row `openrouter` in `providers`), model migration | `account.js`, `provider.js`, `model-migration.js` |
| Project containers: instances (`project_instances`), relocation journal (`project_relocations`), setup of a new project (four tables), layout, stack copies (`stack_copies`), preview links | `project-instances.js`, `project-relocations.js`, `project-setup.js`, `project-layout.js`, `stack-copies.js`, `preview-links.js` |

## The most frequent questions

- **Where is a table created, where does a migration run?** → `db.js:initStore` (core) and the registrations of the topic
  files.
- **How is a NEW schema added?** → in its topic file, registered in the registration list at the end of `../store.js`
  (`registerSchema("<name>", <fn>)`); `db.js` only calls `runSchemata()` at the end of `initStore`. The list is ONE place —
  no module registers itself, otherwise the execution order would be the import order. Count on the list
  (`grep -a '^registerSchema' ../store.js | wc -l`), not in any prose. Whoever does not write DDL as a literal (built from
  a template or variable) must register by hand: the gate guard `schemaRegistry` reads text.
- **Why does a write fail with "database is locked"?** → a FOREIGN connection holds the WRITE lock (the server itself has
  only one connection; under WAL readers no longer block it). `db.js:initStore` sets `PRAGMA busy_timeout` on every open
  (5 s — `node:sqlite` is synchronous, longer would stall the event loop; `CBASE_DB_BUSY_MS` for tests); the guard is
  `server/backend/test/db-lock.test.js`.
- **Why WAL, and what does it cost?** → `db.js:initStore` sets `journal_mode = WAL` and `synchronous = NORMAL`: a commit no
  longer fsyncs on the main thread (with the rollback journal every commit waited for the host disk — event-loop blocks of
  20–70 s). The last commits live in `automater.db-wal` until a checkpoint: copy the database only through SQLite
  (`VACUUM INTO`, `backup()`), never as a file; read-only readers on a read-only mount open it as
  `tools/deploy/lib/capabilities.mjs` does. Guards: `server/backend/test/store-journal.test.js`,
  `tools/deploy/reader-wal.test.mjs`.
- **Where is the transaction, and what holds the delete lists?** → `db.js:inOneTransaction` is the ONE transaction of all
  topic files: a SAVEPOINT (nesting allowed), synchronous, guarded rollback — if SQLite has already rolled back itself
  (SQLITE_FULL, IOERR, `RAISE(ROLLBACK)`), the ORIGINAL error propagates; the commit is in the guarded part too. New
  migrations of the form "column + backfill" go through `db.js:columnWithBackfill` (both in one transaction, decided by
  the column; any other error propagates loudly out of `initStore`). `workspaces.js:deleteWorkspace` and `deleteProject`
  run in one transaction and are hand-written lists without foreign keys: EVERY table with `workspace_id`/`project_id`
  must fall there, lose its reference, or be exempted with a reason in `server/backend/test/schema-register.test.js`
  ("delete lists ↔ schema", `EXCEPTIONS_WORKSPACE`/`EXCEPTIONS_PROJECT`) — a new table without an entry makes it fail. A
  project takes the `project_id` from its chats (they survive it as chats without a project).
- **Which runs are active or parked right now?** → `runs.js:listActiveRuns` / `setActiveRun` (resumption after a restart:
  `setPendingResume`, `listPendingResumes`).
- **Where does "archived" live, and who keeps the folder rule?** → `chats.js:initArchiveSchema`: the column `archived_at`
  (ms, `NULL` = active) on `chats` and `chat_folders` is the only truth, and the rule "no active chat in an archived
  folder" lives as THREE triggers in the database, not in the callers — `chats_active_holt_folder_new` (AFTER INSERT) and
  `chats_active_holt_folder` (AFTER UPDATE OF `archived_at`, `folder_id`) bring back the folder of an active chat,
  `folder_archive_only_without_active` (BEFORE UPDATE) raises `folder-has-active-chats`. The trigger names are a contract
  (the guards look for them in `sqlite_master`). Writes go through `archiveChat`, `fetchChatBack`, `archiveFolder` and
  `fetchFolderBack`; with a folder only the chats with ITS timestamp come back, and the timestamp is read as a value
  first, never through a subselect. Archiving and restoring change neither `updated_at` nor `pinned`. The lists filter
  through `{ archive: "without" | "only" | "including" }`; an unknown value THROWS (`archiveSql`). Guard:
  `server/backend/test/archive-store.test.js`.
- **Where do stored levels from the time of the sixth effort level migrate?** → `chats.js:migrateUltraToMax`
  (registration "effort-ultra-max"): `chats.effort` by UPDATE on every start, the JSON of `workflows.run_settings` by
  `instr` prefilter + parsing (never by text pattern). The marker `migration.effort_ultra_max` is only set once something
  was rewritten there. Guard `server/backend/test/ultra-gone.test.js`.
- **What of a subagent survives a restart, and who clears it?** → `subagents.js`: the restart-grace hook in
  `../runs/agents.js` marks running/parked ones as orphaned, `cbase_agent_send` picks an agent from this stock up again.
  No foreign keys on `chats` — deletion only goes through the close path (`../chats/erase.js:tidyUp`).
- **Where is a dynamic workflow, and what of it survives a restart?** → `dynworkflow-runs.js`: `createDynRun`,
  `endDynRun` (writes ONLY out of the running state and returns a boolean, so a double stop reports nothing twice). At
  start `interruptDynRuns` marks every running run of an earlier server process as interrupted; the restart grace picks a
  run up again with `pickUpDynRun` or gives it up after the attempt cap with `abandonDynRun`. Read: `dynRunsOpen`
  (`/api/runs/active` field `dynWorkflows`, NOT `busy`), `dynRunStatus`, `dynRunsInChat`. Everything is deleted with the
  chat (hook "chatClosed").
- **Where does a row in `usage_events` come from, and which agent caused it?** → `account.js:addUsageEvent`: `source`
  with an allowlist, `agentId` → column `agent_id`; `cost_usd` is the amount reported by OpenRouter (NULL = unknown,
  never 0), `cost_origin` says where the amount comes from.
- **Where are the scheduled jobs, and who writes them?** → `scheduled.js`; the binding to the chat is `chats.job_id`.
  What a run may do is computed by `../scheduled/` — here is only the shape.

## Rules

- A value written to the database, a table, column, index or trigger name is a contract with existing stores: changing
  it needs a migration. The schema registry test (`server/backend/test/schema-register.test.js`) binds the names.
- Topic files are domain free: no import from a domain folder, markers of other modules appear as literals and are bound
  by a test.
- New names of the facade are exported through an `export { … };` line (`server/backend/test/store-facade.test.js`).
