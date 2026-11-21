// The coding MCP servers of an agent type: the field `mcp` of an agent definition (table `agents`), so that one type can carry
// e.g. the Teams tools without every subagent inheriting them.
//
//   { <serverId>: null | [tool, …] }   null = the whole server (as the choice at the server allows it), list = only these tools;
//                                       `{}` = none. Same shape as the choice of an outer-loop agent (outerloop/catalog.js
//                                       normalizeMcpChoice, key = server id), plus `null` for "all tools" — including those
//                                       the server gains later.
//
// Only reading and validating a request body lives here (routes workspaces/routes.js, projects/routes.js). What a subagent gets
// from it (type ∩ parent, "Subagents inherit" for all others) is computed in runs/agent-set.js `codingSet`; the MCP file is
// written by toolchain/mcp-config.js (`codingChoice`), the airlock checks every call (toolchain/airlock-routes.js, token field
// `fromType`).
//
// Selectable are the coding servers the UI offers: for a workspace type the servers of the workspace, for a project type also
// those of the project — including a disabled one (its choice survives disabling, otherwise the type could not be saved while
// the server is off; the run does not see it then). A deleted server drops out of every choice (store/toolchain.js
// dropAgentMcpChoice).

import * as store from "../store.js";
import { T } from "../i18n.js";

const TOOL_NAME = /^[A-Za-z0-9_.-]{1,120}$/;

/** The coding servers a type can choose at this place (workspace type: `projectId` null). */
export function selectableCodingServer(workspaceId, projectId = null) {
  return [...store.listMcpServers(workspaceId), ...(projectId ? store.listProjectMcpServers(projectId) : [])];
}

/**
 * The `mcp` field of a body, validated: `{ value: undefined }` = not sent (unchanged), `{ value }` = the choice,
 * `{ error }` = 400 with plain text. An empty tool list drops out (the server then brings nothing). A tool the server's cache
 * does not know is an error once the cache is loaded — a never-loaded server accepts any valid name (empty is not unknown).
 */
export function agentMcpFromBody(raw, { workspaceId, projectId = null }) {
  if (raw === undefined) return { value: undefined };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: T("mcp: object { serverId: null | [tools] } required") };
  }
  const server = new Map(selectableCodingServer(workspaceId, projectId).map((s) => [s.id, s]));
  const value = {};
  for (const [id, list] of Object.entries(raw)) {
    const s = server.get(id);
    if (!s) return { error: projectId
      ? T`Unknown MCP server: ${id} — selectable are the coding MCP servers of this project and its workspace.`
      : T`Unknown MCP server: ${id} — selectable are the coding MCP servers of this workspace.` };
    if (list === null) { value[id] = null; continue; }
    if (!Array.isArray(list)) return { error: T`mcp.${s.name}: null (all tools) or a list of tool names` };
    const names = [...new Set(list.map((x) => String(x).trim()).filter(Boolean))];
    const wrong = names.find((n) => !TOOL_NAME.test(n));
    if (wrong !== undefined) return { error: T`Invalid tool name for ${s.name}: "${wrong}"` };
    const cache = Array.isArray(s.tools) ? s.tools : [];
    if (Number(s.toolsAt) > 0) {
      const unknown = names.find((n) => !cache.some((w) => w?.name === n));
      if (unknown) return { error: T`${s.name} has no tool "${unknown}" (as of the last load in Coding → MCP).` };
    }
    if (names.length) value[id] = names;
  }
  return { value };
}

/**
 * For display to the main agent (cbase_agents_list, view "start"): what a type brings, with NAMES instead of ids — only servers
 * in this run's set (`set` = the coding servers of the chat, store.effectiveMcpServers); what the chat does not have, the
 * subagent does not get either (runs/agent-set.js codingSet). → `[{ server, tools: "all" | [..] }]`, empty = nothing.
 */
export function mcpOfTheTypeForDisplay(choice, set) {
  if (!choice || typeof choice !== "object") return [];
  return (set || []).filter((s) => Object.hasOwn(choice, s.id)).map((s) => ({ server: s.name, tools: choice[s.id] === null ? "all" : [...choice[s.id]] }));
}
