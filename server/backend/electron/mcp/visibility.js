// Visibility of the cbase tools by depth — a leaf WITHOUT environment and without imports. It applies in three places:
// in the MCP server (cbase-mcp.js, depth from CBASE_AGENT_DEPTH), in the CLI block list and the frame of the subagent
// specification (server/runs/agents.js) and in the marker of the loop engine (server/providers/engine.js). All three read
// THIS number.
//
// The depth counts the levels below the chat: 0 = the chat itself (main agent), 1 = its subagent, 2 = its child,
// 3 = the last allowed level. Visibility is a table with two columns instead of a block set with a fixed condition:
//
//   alwaysLocked   for EVERY subagent at every depth: question (the main agent holds the conversation), wakeup and
//                  monitor (they act on the root chat — a subagent would otherwise set the chat's wakeups and monitors),
//                  the library of the dynamic workflows (`cbase_dynamic_workflow_list`/`_save`), the run
//                  (`cbase_dynamic_workflow`/`_stop`) and the graph workflows (`cbase_workflow_start`/`_status`/`_stop`).
//   onlyAtTheLimit the family `cbase_agent*` without `cbase_agents_list` (that one only reads): at depth 1 and 2 it is there,
//                  at depth 3 it is missing.

export const AGENT_DEPTH_MAX = 3;

export const VIEW_BY_DEPTH = Object.freeze({
  alwaysLocked: Object.freeze([
    "cbase_ask",
    "cbase_wakeup",
    "cbase_monitor",
    "cbase_monitor_stop",
    // (What a subagent may write to a channel or chat is decided by the server, communication/sender.js.)
    // The library of the dynamic workflows belongs to the chat, never to a subagent.
    "cbase_dynamic_workflow_list",
    "cbase_dynamic_workflow_save",
    // The run: a workflow starts only from the chat, never from a subagent.
    "cbase_dynamic_workflow",
    "cbase_dynamic_workflow_stop",
    // Graph workflows: only the main agent of the chat starts, observes and stops them — the announcement /workflow: is meant
    // for the chat, and a foreground run occupies it.
    "cbase_workflow_start",
    "cbase_workflow_status",
    "cbase_workflow_stop",
    // The agenda is the chat's plan, and its main agent keeps it — a subagent READS it (cbase_agenda is open to it) and reports in
    // its report what should change. The server checks the same (agenda/routes.js, 403).
    "cbase_agenda_write",
    // Writing skills: only the main agent of a coding chat — a subagent READS them (cbase_skill). The server checks the same
    // (toolchain/skill-routes.js, 403); mcp-config.js never writes the marker CBASE_SKILL_WRITE for a subagent.
    "cbase_skill_write",
  ]),
  onlyAtTheLimit: Object.freeze([
    "cbase_agent",
    "cbase_agent_send",
    "cbase_agent_output",
    "cbase_agent_stop",
    // cbase_agents_list is also there at depth 3: it READS (chats, channels, the own subagents) — subagents of every depth may
    // read. Workflow agents stay without the family (WORKFLOW_AGENT_FAMILIES below).
  ]),
});

// Workflow agents: the agents of a dynamic workflow have the tools of the chat 1:1 (browser and captures included) MINUS these
// families — through a marker of the MCP server of its OWN (CBASE_WORKFLOW_AGENT, the agent id), not through the depth: the depth
// table above loosens with every level that is allowed, and through it a workflow agent would inherit `cbase_agent`. Families as
// a prefix, so that a new member (say another cbase_agent_*) is missing by itself.
// Also "cbase_workflow" (graph workflows _start/_status/_stop) — a workflow agent has no turn that a wakeup could continue.
export const WORKFLOW_AGENT_FAMILIES = Object.freeze(["cbase_agent", "cbase_dynamic_workflow", "cbase_monitor", "cbase_workflow"]);
// Three of the four copy tools are locked INDIVIDUALLY instead of as the family "cbase_copy_stack": the prefix would also lock
// `cbase_copy_stack_list`, and a workflow agent may call that (it sees whether a copy lives without creating, fetching or removing
// one: an inset in the middle of a workflow would split its agents across two instances). Likewise cbase_switch_instance — switching
// the chat's instance mid-workflow would split its agents across two instances just the same.
// The agenda: a workflow agent reads the agenda of its chat (cbase_agenda), the main agent writes it.
export const WORKFLOW_AGENT_INDIVIDUAL = Object.freeze(["cbase_ask", "cbase_wakeup", "cbase_copy_stack", "cbase_copy_stack_fetch", "cbase_copy_stack_remove", "cbase_switch_instance", "cbase_agenda_write", "cbase_skill_write"]);

/** Is `name` locked for a workflow agent? Independent of any depth. */
export function lockedForWorkflowAgent(name) {
  const n = String(name || "");
  return WORKFLOW_AGENT_INDIVIDUAL.includes(n) || WORKFLOW_AGENT_FAMILIES.some((f) => n === f || n.startsWith(`${f}_`) || n.startsWith(`${f}s_`));
}

// The messenger of an `agent(prompt, {schema})`: the tool through which a workflow agent delivers its result as an object. It
// stands OUTSIDE every cut (explicit list, named set, depth, marker) and depends only on whether the run carries a schema
// (CBASE_SCHEMA) — like `cbase_skill` on its catalog. The name as in Claude Code.
export const STRUCTURE_TOOL = "StructuredOutput";

// No human in the run: an approval request of a workflow agent is rejected without a card — the wording the agent gets as a tool
// result (MCP cbase_permission_prompt and the loop engine, runs/agents.js).
export const WORKFLOW_AGENT_REJECTION = "Rejected without a question: you are an agent of a dynamic workflow, and in this run there is no human who could grant an approval."
  + " Do the task without this tool or name in your result what would need an approval.";

const ALWAYS = new Set(VIEW_BY_DEPTH.alwaysLocked);
const LIMIT = new Set(VIEW_BY_DEPTH.onlyAtTheLimit);

/** Is `name` locked for an agent at `depth`? Depth 0 (the chat itself) locks nothing. */
export function lockedForDepth(name, depth) {
  const t = Number(depth) || 0;
  if (t <= 0) return false;
  if (ALWAYS.has(name)) return true;
  return t >= AGENT_DEPTH_MAX && LIMIT.has(name);
}

// The copy tools: a filter by PROJECT STATE. They belong in the catalog (order and names, agent-set.js), but are offered only to a
// run in a RELOCATED project — its instance identifier "<projectId>/<instance>" stands in `CBASE_INSTANCE` (toolchain/mcp-config.js
// writes it only with an instance). Without an identifier all of them are missing (no copy of a project that was not relocated —
// the route would answer 409, the tool would be a promise without fulfilment); in a COPY `cbase_copy_stack` is missing (nothing is
// created from a copy — the fence answers 409 there too, projectbox/fence-table.js `onlyFromMain`; a copy FROM a copy arises via
// `baseInstance` from the main), the other three stay. Applies besides every other cut, also besides an explicit list
// (CBASE_TOOLS) and the depth — the list of a subagent names them (FULL_SET), the server decides.
// Also cbase_switch_instance — instances exist only in a relocated project (without the marker it is missing like the four), in
// a copy it stays (back to the main). The group is the tools of the instances of a project, in catalog order.
export const COPY_TOOLS = Object.freeze(["cbase_copy_stack", "cbase_copy_stack_list", "cbase_copy_stack_fetch", "cbase_copy_stack_remove", "cbase_switch_instance"]);
const COPY_CREATE = "cbase_copy_stack";

/** Is `name` locked for a run with this instance identifier (`CBASE_INSTANCE`; empty/missing = no instance)? */
export function lockedForInstance(name, instanceIdentifier) {
  if (!COPY_TOOLS.includes(name)) return false;
  const identifier = String(instanceIdentifier || "");
  if (!identifier) return true;
  return name === COPY_CREATE && /\/copy-/.test(identifier);
}

// The fence cut. Tools whose route the API fence (server/projectbox/fence-table.js) ALWAYS rejects are not offered by the MCP
// server to a run for which the fence applies — description side = execution side (a tool in the offering of a coding chat in a
// project container that failed on every call sent the agent looking for raw tokens through cbase_vars_get). For whom it applies the token (`CBASE_TOKEN`) says: the fence judges by the token (fence.js fenceVerdict), and
// toolchain/mcp-config.js writes it only for a run in an instance (runs/backend-access.js) — main agent, every subagent (also
// with an explicit list, FULL_SET in runs/agent-set.js names it, the server decides) and every workflow agent. Without a token (B)
// everything stays as usual.
// Per tool the row (`family`) that rejects it. Bound in BOTH directions to the table and the tools (server/backend/test/fence-tools.test.js): an offered
// tool with a rejected route is red, so is an entry that its row no longer rejects — the list grows only with the fence.
export const FENCE_LOCKED = Object.freeze({
  // Only the human deletes the own project from the container. There is no tool for CREATING one at all (the row
  // "project-setup" stands in the table with `withoutMcp`).
  cbase_project_delete: "project-delete",
  // The row lets the PATCH through, but its body checker `withoutProjectSwitch` rejects EVERY body with `projectId` — and the tool
  // always sends one (also `null` for removing).
  cbase_chat_set_project: "chat-change",
});

/** Is `name` locked for a run with this token (`CBASE_TOKEN`; empty/missing = the fence does not apply)? */
export function lockedForFence(name, token) {
  return Boolean(String(token || "")) && Object.hasOwn(FENCE_LOCKED, name);
}

/** How many levels BELOW an agent at `depth` are still allowed (depth 1 ⇒ 2, depth 3 ⇒ 0). */
export function remainingDepth(depth) {
  return Math.max(0, AGENT_DEPTH_MAX - (Number(depth) || 0));
}

// ── The outer loop ──────────────────────
// An outer-loop run carries a marker of its OWN (`CBASE_OUTER_LOOP=<agentId>:<runId>`, toolchain/mcp-config.js): it is neither the
// main agent of the observed chat nor a subagent nor a workflow agent. The marker replaces the depth and the workflow filter in
// the MCP server (cbase-mcp.js) — like that of a workflow agent.
//   ONLY_OUTER_LOOP        the analysis tool: every run has it (outerloop/set.js appends it), NOBODY else — without the marker it is
//                          locked, also in an explicit list and in the full catalog of a coding chat (runs/agent-set.js FULL_SET
//                          excludes it, otherwise it would stand in the list of every grandchild).
//   OUTER_LOOP_LOCKED      locked with the marker: the tools of the groups of the former manager catalog that are still in the catalog
//                          (question, artifacts, agendas) and what a run without a turn cannot have: delegation (cbase_agent with output
//                          and stop — sending and list stay selectable), dynamic and graph workflows, wakeup, monitor, recordings and
//                          the app plumbing `cbase_permission_prompt` (no permissionPromptTool, so no ALWAYS either). Bound in both
//                          directions in server/backend/test/outerloop-visibility.test.js.
//   ONLY_AGENDA_KEEPER     the write tool of the agenda keeper: without the outer-loop marker locked like ONLY_OUTER_LOOP — main agent
//                          (it does not get it, it keeps cbase_agenda_write), subagents of every depth, workflow agents and special
//                          runs never see it, also not in an explicit list, and no named set names it. WITH the marker the set of the
//                          run alone decides (outerloop/set.js appends it only for the keeper), the server checks the same
//                          (agenda/upkeep.js, 403). `cbase_agenda` (read) is NOT in OUTER_LOOP_LOCKED: no outer-loop agent can select
//                          it (the agenda group is not in the outer-loop slice), so only the keeper has it.
export const ONLY_OUTER_LOOP = Object.freeze(["cbase_chat_analysis"]);
export const ONLY_AGENDA_KEEPER = Object.freeze(["cbase_agenda_maintain"]);
//   ONLY_TIMELINE_AGENT    the two tools of the timeline agent: reading and writing the project timeline. Without the outer-loop marker
//                          locked like ONLY_AGENDA_KEEPER — no coding chat, no subagent, no workflow agent reads the timeline (only the
//                          timeline agent and the user); WITH the marker the set decides (outerloop/set.js appends them only to it),
//                          the server checks the same (run marker, 403).
export const ONLY_TIMELINE_AGENT = Object.freeze(["cbase_timeline", "cbase_timeline_write"]);
/** Everything a run has only with the outer-loop marker — the full set of a coding chat (runs/agent-set.js FULL_SET) excludes it. */
export const ONLY_WITH_OUTER_LOOP_MARKER = Object.freeze([...ONLY_OUTER_LOOP, ...ONLY_AGENDA_KEEPER, ...ONLY_TIMELINE_AGENT]);
export const OUTER_LOOP_LOCKED = Object.freeze([
  "cbase_ask",
  "cbase_artifacts_list", "cbase_artifacts_read",
  // chat-bound, or it would need a turn that an outer-loop run does not have
  "cbase_agent", "cbase_agent_output", "cbase_agent_stop",
  "cbase_dynamic_workflow", "cbase_dynamic_workflow_stop", "cbase_dynamic_workflow_list", "cbase_dynamic_workflow_save",
  "cbase_workflow_start", "cbase_workflow_status", "cbase_workflow_stop",
  "cbase_wakeup", "cbase_monitor", "cbase_monitor_stop",
  "cbase_screenshot", "cbase_recording_start", "cbase_recording_stop",
  "cbase_permission_prompt",
  // The agenda is written by the main agent of the chat — the agenda keeper only follows it up, with its own tool
  // (ONLY_AGENDA_KEEPER).
  "cbase_agenda_write",
  // Writing skills is done only by the main agent of a coding chat; reading (cbase_skill) stays as it is.
  "cbase_skill_write",
]);
const OUTER_LOOP_LOCK = new Set(OUTER_LOOP_LOCKED);

/** Is `name` locked for a run with this outer-loop marker (`CBASE_OUTER_LOOP`; empty = no outer-loop run)? */
export function lockedForOuterLoop(name, marker) {
  return String(marker || "") ? OUTER_LOOP_LOCK.has(name) : ONLY_WITH_OUTER_LOOP_MARKER.includes(name);
}

// No human in the run: the permission request of an outer-loop run is rejected without a card — the wording the loop engine gives
// the agent as a tool result (runs/agents.js). The Claude CLI does not even ask (no permissionPromptTool: in `-p` it rejects by
// itself what is not in --allowedTools).
export const OUTER_LOOP_REJECTION = "Rejected without a question: you are an outer-loop agent, and in your run there is no human who could grant an approval."
  + " Do the task without this tool or name in your note what would need an approval.";

// ── The agenda is written only by the main run of a coding chat ──────────────────────────────────────────────────────────────
// Depth (alwaysLocked), workflow marker (WORKFLOW_AGENT_INDIVIDUAL) and outer loop (OUTER_LOOP_LOCKED) cut above; named sets do not
// know the name. What remains are the special runs with the FULL catalog at depth 0: the app-agent chats — their chat is no coding
// chat, the route answered 409. Recognised by the same marker with which cbase_agent_send restricts them to their own subagents
// (CBASE_ONLY_SUBAGENTS, toolchain/mcp-config.js from communication/sender.js: role "special"). Description side = execution side.
export const ONLY_CODING_MAIN_RUN = Object.freeze(["cbase_agenda_write", "cbase_skill_write"]);

// Writing skills: the tool additionally depends on the marker CBASE_SKILL_WRITE (offering.js) — toolchain/mcp-config.js writes it
// only for the main run of a coding chat with the switch on.
export const SKILL_WRITE = "cbase_skill_write";

/** Is `name` locked for a special run (marker `CBASE_ONLY_SUBAGENTS`) because only the main run of a coding chat has it? */
export function lockedForSpecialRun(name, onlySubagents) {
  return Boolean(onlySubagents) && ONLY_CODING_MAIN_RUN.includes(name);
}

// ── Tools bound to ONE run ──────────────────────────────────────────
// Used to stand in the full catalog of every coding chat (and in the written-out list of every grandchild, runs/agent-set.js
// FULL_SET) and failed there on EVERY call — description side ≠ execution side:
//   APPROVAL_TOOL   cbase_permission_prompt: called only by the Claude CLI via --permission-prompt-tool. A run without that flag
//                   (Codex, loop engine, mode bypassPermissions, outer loop) would be offered it as “do NOT call directly”.
//                   Marker CBASE_APPROVAL (toolchain/mcp-config.js approvalOverMcp — the same computation as
//                   spec.permissionPromptTool of the Claude connector).
// Applies besides every other cut, also besides an explicit list (CBASE_TOOLS) — like the instance and the fence cut.
export const APPROVAL_TOOL = "cbase_permission_prompt";
/** Everything only a specific run has — the full set of a coding chat (runs/agent-set.js FULL_SET) excludes it. */
export const ONLY_WITH_RUN_BINDING = Object.freeze([APPROVAL_TOOL]);

/**
 * Is `name` locked for this run because it belongs to another run? `approval` = CBASE_APPROVAL === "1".
 */
export function lockedForRunBinding(name, { approval = false } = {}) {
  if (name === APPROVAL_TOOL) return !approval;
  return false;
}
