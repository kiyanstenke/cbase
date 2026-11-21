// Who writes? The sender's role and its write permission on other chats. ONE computation for two sides: the send route
// (send.js) checks with it, and toolchain/mcp-config.js writes from it the marker CBASE_WRITE_PERMISSION, from which the MCP
// server builds the description of cbase_agent_send — description side = execution side. Imports only the store
// (mcp-config.js lies in the import graph of runs/agents.js; more here would mean a cycle).
//
// The check relies on what the MCP server states (`ofProfile`, workflow marker, outer-loop marker): it catches
// misconfiguration, it is NO boundary against an agent with Bash.

import * as store from "../store.js";

// (A manager chat is read-only and writes to nobody; it counts as "special".)
export const ROLES = Object.freeze(["coding", "outer_loop", "subagent", "workflow", "special"]);
export const WRITE_PERMISSIONS = Object.freeze(["free", "no"]);

// The coding main agent writes to other chats FREELY: without approval, through a silent channel (target-chat.js).
export const WRITE_PERMISSION_CODING = "free";

/**
 * The sender's role. `chat` is the chat row or its id (the sender is the chat in the route's path); the markers come from
 * the run's MCP server: `ofProfile` (only a subagent carries a profile), `workflowAgent` (agent of a dynamic workflow),
 * `outerLoop` (the marker `<agentId>:<runId>` of an outer-loop run, toolchain/mcp-config.js CBASE_OUTER_LOOP — send.js
 * routes the role BEFORE every address kind to target-outer-loop.js, which checks it against the run).
 *   coding     kind normal, without a special role, without ofProfile — also the node agent of a graph child chat
 *   special     everything else: app-agent chats, every manager chat (read-only)
 */
export function senderOf(chat, { ofProfile = "", workflowAgent = "", outerLoop = "" } = {}) {
  const c = typeof chat === "string" ? store.getChat(chat) : chat;
  if (workflowAgent) return "workflow";
  if (outerLoop) return "outer_loop";
  if (ofProfile) return "subagent";
  if (!c) return "special";
  if (c.kind === "normal" && !c.specialRole) return "coding";
  return "special";
}

// Who writes into a channel (`channel:<id>`) and reaches agents of a workflow (`wf:`): the main agent of a coding chat (an
// outer-loop run never: it writes only to chats). Subagents and workflow agents lead only their own children; app-agent
// chats and manager chats ("special") reach only their own subagents — also as participants of a channel that someone
// created through the workspace route. The same set cuts the description of cbase_agent_send: for "special",
// toolchain/mcp-config.js sets CBASE_ONLY_SUBAGENTS.
export const WRITES_CHANNEL = Object.freeze(new Set(["coding"]));

/** Write permission on OTHER chats (`chat:<id>`): free | no. `channel:<id>` checks participation. */
export function writePermissionToChats(role) {
  if (role === "coding") return WRITE_PERMISSION_CODING;
  return "no";
}

/**
 * What a run's MCP config says about cbase_agent_send (toolchain/mcp-config.js): the write permission on chats and whether
 * the run reaches only its own subagents (role "special"). `onlySubagents` only with a chat row: without it "special" is not
 * a finding but ignorance.
 */
export function sendPermissionsOfTheRun(chatId, markers = {}) {
  const chat = store.getChat(chatId);
  const role = senderOf(chat || chatId, markers);
  return { writePermission: writePermissionToChats(role), onlySubagents: Boolean(chat) && role === "special" };
}
