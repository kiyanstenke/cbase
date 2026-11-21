// Facade of the data layer. The code lives in `store/<topic>.js`; this file keeps the old names reachable under "./store.js" so
// no importer (server.js, providers/index.js, retrieval.js, the tests) had to be touched. `db` and `skillResRoot` stay invisible:
// they are the live binding from `store/db.js`, which only the topic files read.
// `store/_util.js` (pure helpers) is NOT re-exported, but explicitly IMPORTED for the moved `slugifyTitle` (it is in the frozen
// list and would otherwise no longer arrive on the facade). New code imports `store/<topic>.js` directly; the facade should shrink.
// `export *` swallows name collisions silently; the guard against that is server/backend/test/store-facade.test.js (frozen names,
// no name in two files).
export { initStore, nowMs, isUniqueViolation } from "./store/db.js";
export * from "./store/workspaces.js";
export * from "./store/toolchain.js";
export * from "./store/chats.js";
export * from "./store/workflows.js";
export * from "./store/runs.js";
export * from "./store/context.js";
export * from "./store/projects.js";
export * from "./store/account.js";
export * from "./store/provider.js";
export * from "./store/channels.js";
export * from "./store/subagents.js";
export * from "./store/dynworkflows.js";
export * from "./store/dynworkflow-runs.js";
export * from "./store/ultracode-reminder.js";
export * from "./store/graph-starts.js";
export * from "./store/project-instances.js";
export * from "./store/project-relocations.js";
export * from "./store/stack-copies.js";
export * from "./store/project-setup.js";
export * from "./store/project-layout.js";
export * from "./store/chat-search.js";
export * from "./store/outer-loop.js";
export * from "./store/preview-links.js";
export * from "./store/model-migration.js";
export * from "./store/agenda.js";
export * from "./store/skill-history.js";
export * from "./store/scheduled.js";
export * from "./store/agenda-upkeep.js";
export * from "./store/timeline.js";
export * from "./store/instructions.js";
export { slugifyTitle } from "./store/_util.js";

// ── The registration list of the schemas ─────────────────────────────────────────────────────────
// It lives HERE because the facade is the only place every initStore caller goes through: `server.js` calls
// `store.initStore(DIRS.data)` long before the hook registration list begins, and the pure store tests among the callers start no
// server at all and still need exactly these tables. `store/db.js` calls only `runSchemata()` at the end of `initStore` and
// knows no topic file any more.
//
// The order IS the call order and is the historical one, character for character. No guard watches it, so do not reorder. Where an
// entry says "AFTER x", a trigger, index or backfill reads what x creates.
import { registerSchema } from "./store/schema.js";
import { initChannelSchema } from "./store/channels.js";
import { initArchiveReasonSchema, initArchiveSchema, initChatJobSchema, initChatInstanceSchema, initEffortOwnSchema, initUpstreamSchema, initTargetPauseSchema, migrateUltraToMax } from "./store/chats.js";
import { initActiveRunConsumptionSchema, initAnnouncementsSchema, initHintSchema } from "./store/runs.js";
import { initSubagentsSchema } from "./store/subagents.js";
import { initDynWorkflowSchema } from "./store/dynworkflows.js";
import { initDynWorkflowRunSchema } from "./store/dynworkflow-runs.js";
import { initUltracodeReminderSchema } from "./store/ultracode-reminder.js";
import { initGraphStartSchema } from "./store/graph-starts.js";
import { initProjectInstanceSchema } from "./store/project-instances.js";
import { initProjectRelocationSchema } from "./store/project-relocations.js";
import { initStackCopiesSchema } from "./store/stack-copies.js";
import { initProjectSetupSchema } from "./store/project-setup.js";
import { initProjectLayoutSchema } from "./store/project-layout.js";
import { initMcpHiddenSchema, initMcpAirlockSchema, initSkillAreaSchema, initWsAgentsSchema } from "./store/toolchain.js";
import { initChatSearchSchema } from "./store/chat-search.js";
import { initOuterLoopSchema } from "./store/outer-loop.js";
import { initPreviewLinksSchema } from "./store/preview-links.js";
import { initUsageBreakdownSchema, initUsageCostSchema } from "./store/account.js";
import { initAgendaSchema } from "./store/agenda.js";
import { initSkillHistorySchema } from "./store/skill-history.js";
import { initScheduledSchema } from "./store/scheduled.js";
import { initAgendaUpkeepSchema } from "./store/agenda-upkeep.js";
import { initTimelineSchema } from "./store/timeline.js";
import { initInstructionsSchema } from "./store/instructions.js";

// Removed with Managing: "aufnahme" (store/ingest-schema.js), "managing" (store/managing.js; the chat columns `agent_id`,
// `schedule_id`, `schedule_run_id` its ALTER carried are created by the chat schema in store/db.js since), "channel-hooks-cleared"
// and "manager-mode-default". A store creates no managing table.
registerSchema("channels", initChannelSchema);
// Archive: column `archived_at` on chat and folder, three triggers.
// LAST: the triggers name chats.folder_id and chat_folders; db.js creates both tables.
registerSchema("chat-archive", initArchiveSchema);
// The sixth effort grade is gone: stored `ultra` in chats and the workflows' run settings become `max` (the column at every
// start, the JSON until the first migration that rewrote something, then a marker; a store without old values gets none).
// Without this line nothing would give way, it would only go silent: an old value would run silently without a grade.
registerSchema("effort-ultra-max", migrateUltraToMax);
// Silent hints to the next turn: table `chat_hints`. Without this line a hint would store nothing (no such table), and no turn would carry it.
registerSchema("chat-hints", initHintSchema);
// The subagent stock: tables `subagents` and `subagent_history` (store/subagents.js). Without this line no core would store its
// agents (no such table, silently caught), and after a restart nobody would know the orphaned ones.
registerSchema("subagents", initSubagentsSchema);
// The dynamic workflow library: tables `dyn_workflows` and `project_dyn_workflow_enabled` (store/dynworkflows.js). Without this line
// `cbase_dynamic_workflow_save` would store nothing (no such table) and no list would show anything.
registerSchema("dyn-workflows", initDynWorkflowSchema);
// The dynamic workflow runs and their journal: tables `dyn_workflow_runs` and `dyn_workflow_journal` (store/dynworkflow-runs.js).
// Without this line `cbase_dynamic_workflow` would start nothing.
registerSchema("dyn-workflow-runs", initDynWorkflowRunSchema);
// The state of the ultracode reminders per chat: table `ultracode_reminder` (store/ultracode-reminder.js). Without this line no turn
// would get a reminder (no such table, silently caught).
registerSchema("ultracode-reminder", initUltracodeReminderSchema);
// The provider behind a router that delivered the last answer, and its window: columns `upstream_provider` and `upstream_window`
// on `chats` (store/chats.js). Without this line runs/do-run.js would write into the void (no such column, silently caught) and the
// context bar would never name a provider.
registerSchema("chat-upstream", initUpstreamSchema);
// The announcements of an active run: column `announcements` on `active_runs` (store/runs.js). Without this line every setActiveRun would
// fail (no such column, silently caught): no run would survive a restart, announcement or not.
registerSchema("active-runs-announcements", initAnnouncementsSchema);
// The session of the running turn: columns `session`, `provider`, `model` on `active_runs` (store/runs.js); a main turn that dies
// with the process is booked afterwards from it (runs/lateBooking.js). Without this line holding it would fail silently and the
// turn would stay unbooked.
registerSchema("active-runs-consumption", initActiveRunConsumptionSchema);
// The graph workflow starts from the chat: table `graph_starts` with three indexes (store/graph-starts.js). Without this line
// `cbase_workflow_start` would accept nothing (no such table), and no start would be visible in list, stop or event.
registerSchema("graph-starts", initGraphStartSchema);
// The state of the project containers: table `project_instances` with an index (store/project-instances.js). Without this line
// /api/runs/active would read into the void (no such table), and no project could ever be relocated, since the row IS the switch.
registerSchema("project-instances", initProjectInstanceSchema);
// The relocation journal: table `project_relocations` with the partial index "one open relocation per project"
// (store/project-relocations.js). Without this line a relocation would write its journal into the void (no such table), and no
// restart would find a half relocation to roll back or continue.
registerSchema("project-relocations", initProjectRelocationSchema);
// The stack copies: table `stack_copies` with two partial indexes "one living copy per chat, one name per project"
// (store/stack-copies.js). Without this line no copy request would be accepted (no such table), and the delete lock would find no
// living copy.
registerSchema("stack-copies", initStackCopiesSchema);
// The default of the workspace agents per project: column `ws_agents_default` on `projects` (DEFAULT 'off', so every existing
// project stays opt-in) and table `project_agent_excluded` (the exceptions of a project that adopts them; store/toolchain.js).
// Without this line every addProject would fail (no such column) and no project could be created any more.
registerSchema("ws-agents-default", initWsAgentsSchema);
// The setup of new projects: tables `project_setup`, `project_setup_source`, `project_archive` and `project_upload`
// (store/project-setup.js). BEFORE "chat-search". Without this line POST .../projects would create no project in operation (no
// such table, the switch throws before the answer), and no delete path would find the rows it should take along.
registerSchema("project-setup", initProjectSetupSchema);
// The layout of existing projects: tables `project_layout` (the job, at most one per project) and `project_superseded` (the old
// containers of renamed stacks) in store/project-layout.js. BEFORE "chat-search". Without this line POST .../layout/adopt would
// answer 500 (no such table), the upload reader (setup/status.js layoutStatus) "unknown" (every upload 409), and no delete path
// would find the rows it should take along.
registerSchema("project-layout", initProjectLayoutSchema);
// The full-text search over chat messages: FTS5 table `messages_fts` (contentless) with three triggers on `messages` and the
// backfill state `messages_fts_state` (store/chat-search.js). AFTER all others: the backfill's boundary is the largest messages.id
// when the triggers are created. Without this line the `chats` view with `search` would find only titles and the first user
// message, silently, since the search then falls back.
registerSchema("chat-search", initChatSearchSchema);
// The outer loop: tables `outer_loop_agents`, `outer_loop_takeover`, `outer_loop_active`, `outer_loop_runs`, `outer_loop_notes`
// with indexes and the full-text search of the summarizer's notes `outer_loop_notes_fts` with two triggers (store/outer-loop.js).
// AFTER "chat-search". Without this line no workspace would seed its summarizer (no such table, thrown at start and on creation),
// and no delete path would find the rows it should take along.
registerSchema("outer-loop", initOuterLoopSchema);
// The preview links for project containers: tables `ngrok_access` (exactly one row, the access values, which never go back) and
// `preview_links` (store/preview-links.js). AFTER "outer-loop". Without this line every route under /api/preview-links and
// /api/integrations/ngrok would answer 500 (no such table), and the restart would find no link to reopen under its name.
registerSchema("preview-links", initPreviewLinksSchema);
// A chat's instance: column `instance` on `chats` (store/chats.js, NULL = main). Without this line the binding would read into the
// void (no such column): every turn of a chat in a relocated project would fail at the instance question, and no chat would ever
// get into a copy.
registerSchema("chat-instance", initChatInstanceSchema);
// The reported cost per usage row (OpenRouter `usage.cost`): columns `cost_usd` (NULL = not reported) and `upstream_provider` on
// `usage_events` (store/account.js). Without this line every booking would fail (no such column, silently caught): the usage tab
// would stay empty and no run would have costs any more.
registerSchema("usage-cost", initUsageCostSchema);
// The cache split (read/write), the generation ids of OpenRouter responses and the origin of an amount: columns
// `cache_read`/`cache_write` (NULL = before the split), `generation_id`, `cost_origin` on `usage_events` (store/account.js), plus two
// idempotent backfills. AFTER "usage-cost" (the backfill reads `cost_usd`). Without this line every booking would fail (no such
// column, silently caught): usage would stay empty.
registerSchema("usage-breakdown", initUsageBreakdownSchema);
// The area per skill and hiding per project: table `project_skill_excluded` (the workspace coding skills a project hides; opt-out
// like the credentials) and, in the SAME registration, the one-time migration there (marker `migration.skills_area_optout`: both
// markers => coding plus a managing copy, no marker => coding, project managing => workspace level, opt-in => hidings;
// store/toolchain.js). AFTER "usage-cost". Without this line every run of a project chat would answer 500 (no such table,
// effectiveSkills), and an existing project would, without the migration, see every workspace skill it never adopted.
registerSchema("skills-area", initSkillAreaSchema);
// The coding MCP airlock: headers, tool cache, choice, marks, "subagents inherit" and the baseline marker on `mcp_servers`
// (store/toolchain.js initMcpAirlockSchema; store/db.js creates the table). Without this line every list of MCP servers would
// fail (no such column): Coding -> MCP would stay empty and no run would get a server.
registerSchema("mcp-airlock", initMcpAirlockSchema);
// Auto-archive: columns `archive_reason` (who archived; existing rows in the same step 'nutzer') and `restored_at` on `chats`
// (store/chats.js). AFTER "chat-archive" (the table and its triggers stand then); the order to the others does not matter (only
// ADD COLUMN). Without this line every archiving and restoring would fail (no such column): no chat would reach the archive any
// more, and the auto-archive tick would find no candidate.
registerSchema("chat-archive-reason", initArchiveReasonSchema);
// The chat's effort choice: column `effort_own` on `chats` (store/chats.js; the grade is the human's choice in this chat,
// existing rows 0). Without this line every write of the choice would fail (no such column in PATCH and in the fork).
registerSchema("chat-effort-own", initEffortOwnSchema);
// Pause a goal: column `goal_paused` on `chats` (store/chats.js; the set goal rests: not in the system prompt, no verdict, no
// continuation; existing rows 0). AFTER "chat-effort-own"; the order does not matter (only ADD COLUMN). Without this line every
// write of a goal would fail (no such column in the UPDATE; updateChat takes the pause back with every `goal`): /goal would stop
// working, and the judge could not clear an achieved goal.
registerSchema("chat-target-pause", initTargetPauseSchema);
// "chat-browser-user" (column `chats.browser_user`, the switch "agent uses my browser") stood here for a day and fell with the
// switch: since then without effect; nothing reads or writes the column; where it already exists it stays (SQLite, no DROP), a new
// database no longer gets it.
// The agenda per coding chat: table `chat_agenda` (store/agenda.js), bound to no order (only CREATE TABLE).
// Without this line every agenda route would answer 500 (no such table), no turn would carry the agenda block, and a chat's
// closing path (chats/erase.js) would throw while cleaning up.
registerSchema("chat-agenda", initAgendaSchema);
// History, trash and deletion requests of the skills: tables `skill_history` and `skill_deletion_requests`
// (store/skill-history.js), bound to no order (only CREATE TABLE). Without this line EVERY skill mutation would fail (no such
// table in the mutation path toolchain/skill-change.js), including creation in the UI, and no coding agent could write a skill.
registerSchema("skill-history", initSkillHistorySchema);
// Workspace MCP servers apply in every project: table `project_mcp_excluded` (the workspace servers a project hides; opt-out
// like credentials and coding skills; store/toolchain.js), bound to no order (only CREATE TABLE). Without this line every run of a
// project chat would answer 500 (no such table in effectiveMcpServers), and a project's Coding -> MCP would stay empty.
registerSchema("mcp-hidden", initMcpHiddenSchema);
// Scheduled jobs in Coding: the column `job_id` on `chats` with a unique partial index (store/chats.js; the ONE binding chat <->
// job) and the tables `scheduled_jobs` and `scheduled_runs` (store/scheduled.js), both bound to no
// order (only ADD COLUMN and CREATE). Without the first line EVERY chat list would fail (no such column in
// WITH_MESSAGE_OR_QUEUED_SQL): Coding -> Chats would stay empty; without the second every read of a job would answer 500.
registerSchema("chat-job", initChatJobSchema);
registerSchema("scheduled", initScheduledSchema);
// The agenda keeper's log: table `agenda_upkeep` (store/agenda-upkeep.js), bound to no order (only CREATE TABLE; an outer loop
// agent's delete step reads it only at run time). Without this line EVERY keeper change would fail (no such table in
// agenda/change.js) and every write path of the main agent (it reads the open rows in the same step): the agenda would be
// unwritable for everyone; the delete paths of chat, workspace and outer loop agent would also throw.
registerSchema("agenda-upkeep", initAgendaUpkeepSchema);
// The timeline per project: tables `timeline_events`, `timeline_tags`, `timeline_parts`, `timeline_dismissals`, `timeline_revisions`
// with their lock triggers (append-only) and the column `projects.timeline_off` (store/timeline.js). AFTER the base schema (the
// trigger names `projects`), otherwise bound to no order. Without this line every timeline route would answer 500 (no such table),
// and EVERY deletion of a project or workspace would throw (store/workspaces.js deletes the timeline too).
registerSchema("timeline", initTimelineSchema);
// Instructions for agents per workspace and project: `agents_sections`, `agents_sections_from`, `agents_sections_history`
// (store/instructions.js). Without this line the block would be missing in EVERY run (no such table when building the prompt), and
// deleting a project or workspace would throw (store/workspaces.js cleans them up).
registerSchema("instructions", initInstructionsSchema);
