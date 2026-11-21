// The tools that are no evidence — ONE computation for the tool index (tool-index.js: they stay out) and the check
// (check.js: 400 ONLY_READING or 400 NO_PROOF). Two lists:
//
//   READ_TOOLS    whoever only read changed nothing in the world — a read is no evidence for an event.
//   INTERN_TOOLS  bookkeeping and control of cbase itself: maintaining agenda and task list, asking the user, planning,
//                 STARTING or stopping a subagent or workflow, wakeups, monitors, subscriptions, screenshots. They change
//                 nothing in the project or outside — "started" is no event, and a subagent's work sits in the index with
//                 its own citation (`from`).
//
// DELIBERATELY NOT in the lists (a false alarm would weigh more than a case let through): `Bash` (a command can do anything;
// nobody knows whether it only read), `Write`/`Edit` (also to a status file — no name tells whether a file is project
// content or a note; the frame settles that in words), `cbase_agent_send` (a message to another chat is a message sent),
// the copy/instance tools and `cbase_skill_write` (they create something that stays), `TaskStop`/`KillShell` (they also
// end a service the chat runs — that can be ops).
//
// Canonical names (providers/contract.js BUILTIN_TOOLS — Codex and the engine carry the same); an MCP name
// `mcp__<server>__<tool>` counts by its tool part. Exact names only, no prefixes: a new tool is evidence until it is listed here.
export const READ_TOOLS = Object.freeze([
  "Read", "Glob", "Grep", "LS", "NotebookRead", "BashOutput", "WebFetch", "WebSearch", "ToolSearch", "ListMcpResources", "ReadMcpResource",
  "LSP", "TaskList", "TaskGet", "TaskOutput",
  "cbase_projects_list", "cbase_context_list", "cbase_context_get", "cbase_context_categories", "cbase_context_dump",
  "cbase_artifacts_list", "cbase_artifacts_read", "cbase_folder_context_list", "cbase_folder_context_read", "cbase_ports_list",
  "cbase_ports_running", "cbase_ports_free", "cbase_service_log", "cbase_service_command_history", "cbase_agent_output",
  "cbase_agents_list", "cbase_vars_list", "cbase_vars_get", "cbase_workspace_context_search", "cbase_lsp",
  "cbase_skill", "cbase_dynamic_workflow_list", "cbase_workflow_status", "cbase_copy_stack_list", "cbase_chat_analysis",
  "cbase_agenda", "cbase_timeline",
]);
export const INTERN_TOOLS = Object.freeze([
  // the agent's agenda and task list ("done" in the agenda is no evidence)
  "cbase_agenda_write", "cbase_agenda_maintain", "TodoWrite", "TaskCreate", "TaskUpdate",
  // asking the user, planning
  "cbase_ask", "AskUserQuestion", "ExitPlanMode", "EnterPlanMode",
  // starting and stopping — "started" is no event
  "Task", "cbase_agent", "cbase_agent_stop", "cbase_dynamic_workflow", "cbase_dynamic_workflow_stop",
  "cbase_dynamic_workflow_save", "cbase_workflow_start", "cbase_workflow_stop",
  // wakeups, monitors, subscriptions, screenshots
  "ScheduleWakeup", "Monitor", "cbase_wakeup", "cbase_monitor", "cbase_monitor_stop",
  "cbase_screenshot", "cbase_recording_start", "cbase_recording_stop",
  // plumbing of the runs and the timeline itself
  "Skill", "SlashCommand", "StructuredOutput", "cbase_permission_prompt", "cbase_timeline_write",
]);
const READ = new Set(READ_TOOLS);
const INTERN = new Set(INTERN_TOOLS);

/** The tool part of a name (`mcp__cbase__cbase_agenda` → `cbase_agenda`). */
export const toolCore = (name) => {
  const s = String(name ?? "");
  const m = s.match(/^mcp__.+?__(.+)$/);
  return m ? m[1] : s;
};

/** Is this a pure read tool? */
export const isReadTool = (name) => READ.has(toolCore(name));
/** Is this a tool of cbase's own bookkeeping (see above)? */
export const isInternalTool = (name) => INTERN.has(toolCore(name));
/** Is a call of this tool excluded as evidence (index and check)? */
export const isNoProof = (name) => isReadTool(name) || isInternalTool(name);
