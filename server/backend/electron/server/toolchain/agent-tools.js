// The tool list of an agent definition in the store: reading it from a request body, validating it against the registered
// tools, and the one-time migrations of existing definitions. What a list MEANS on which path is computed in runs/agent-set.js.
//
// First migration: a set list used to grant more on the Claude path than it named — all `cbase_*` (if it named none), the
// browser server `playwright` and every MCP server of the workspace. So that the unified reading takes nothing away, every
// existing definition with a set list gets exactly that appended ONCE, in Claude Code spelling: `mcp__cbase` (only if it names
// no cbase tool — if it does, the old Claude path already cut down to those), plus `mcp__playwright` and `mcp__<server>` for
// every MCP server of the workspace (a name that does not occur in a run matches nothing there) — also next to individually
// named tools of a server, because allowedTools granted every server as a whole. A definition without a list stays as it is.
//
// Once: per row, because the migrated row carries its JSON list (a new definition carries it from the start), and per store
// via the marker `migration.tool_list_1zu1` — set after the first start as soon as definitions exist, even if none needed
// migrating. A store without definitions gets no marker.
//
// Second migration: a REMOVED cbase tool drops out of every saved list. If the name stayed, the definition could no longer be
// saved (`unknownInWorkspace` ⇒ 400 at the route). At RUN time nobody checks the names: the bare name would go to Claude
// (`--tools`) and the engine as a "built-in" tool, the long spelling would silently drop — hence the migration. So far one:
// `cbase_project_create`, in both spellings (bare and `mcp__cbase__…`). `null` (not set) stays `null`; a list that carried ONLY
// that tool becomes `[]` — never `null`, which would mean "the full set" (empty is not unknown). Saved dynamic workflows are
// NOT migrated (a call there reports an unknown tool). Once via the marker `migration.without_project_create`, same pattern as
// above. Called from server.js AFTER `migrateToolLists`: its rows then carry their JSON list and are covered here; a row with
// `*` (skipped by the first migration, it keeps its comma list in `tools`) is read by `agentsWithToolList` as well and written
// back as JSON. The first migration counts a REMOVED name as "names a cbase tool": otherwise an old list
// "Read, cbase_project_create" would get `mcp__cbase` — the full catalog — appended, and the second migration would then only
// strike the name; the old Claude path gave it exactly that one tool.
//
// Third migration (coding MCP airlock): a subagent gets a coding MCP server ONLY via the "Subagents inherit" toggle in
// Coding → MCP (or its agent type), with the same choice as the main agent — a tool list only cuts the other servers. Every
// `mcp__<n>` / `mcp__<n>__<t>` whose `<n>` is a coding server of the workspace (or one of its projects) drops ONCE out of
// every saved list; every struck name is logged. A list emptied by this is `[]`, never `null`. Once per store via the marker
// `migration.coding_mcp_from_definitions`; no definition, no marker. Called from server.js after `dropRemovedTools`.
// The editor (`unknownInWorkspace`) no longer accepts coding servers as valid names — the error says where the toggle is.

import * as store from "../store.js";
import { T } from "../i18n.js";
import { readToolList, unknownTool } from "../runs/agent-set.js";

export const TOOL_MIGRATION_MARKER = "migration.tool_list_1to1";
export const REMOVED_MIGRATION_MARKER = "migration.without_project_create";
export const CODING_MCP_MIGRATION_MARKER = "migration.coding_mcp_from_definitions";
// The removed cbase tools, bare — the Claude Code spelling (`mcp__cbase__<name>`) drops along with them.
export const REMOVED_TOOLS = Object.freeze(["cbase_project_create"]);
const REMOVED = new Set(REMOVED_TOOLS.flatMap((n) => [n, `mcp__cbase__${n}`]));

/**
 * The `tools` field of a request body: `undefined` = not sent (unchanged), `null` = not set (empty comma list), otherwise the
 * list — an array may be empty (`[]` = none of the cuttable tools).
 * @throws {Error} for a value that is neither a string nor a list
 */
export function toolListFromBody(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (Array.isArray(value)) return [...new Set(value.map((x) => String(x).trim()).filter(Boolean))];
  if (typeof value === "string") {
    const l = [...new Set(value.split(",").map((x) => x.trim()).filter(Boolean))];
    return l.length ? l : null;
  }
  throw new Error(T("tools must be a comma-separated list or a list"));
}

// The coding MCP servers of the workspace including its projects: all names that can occur in a run of this workspace (the first
// migration counted all of them).
function codingServerOfTheWorkspace(workspaceId) {
  const names = new Set(store.listMcpServers(workspaceId).map((s) => s.name));
  for (const p of store.listProjects(workspaceId)) for (const s of store.listProjectMcpServers(p.id)) names.add(s.name);
  return names;
}
const mcpServerOf = (name) => /^mcp__([A-Za-z0-9_-]+?)(?:__.+)?$/.exec(String(name || "").trim())?.[1] || null;

/** The first unregistered name of the list (for the routes' 400) — otherwise `null`. A coding server does not count. */
export function unknownInWorkspace(list) {
  if (!Array.isArray(list) || !list.length) return null;
  return unknownTool(list);
}

/** The text of the 400 for an unknown name — with the way to go if it is a coding server. */
export function unknownText(name, workspaceId) {
  const server = mcpServerOf(name);
  if (server && codingServerOfTheWorkspace(workspaceId).has(server)) {
    return T`"${name}" is a coding MCP server — a subagent gets it via the MCP servers of its agent type (field mcp) or the "Subagents inherit" switch in Coding → MCP, not via the tool list.`;
  }
  return T`Unknown tool in the list: "${name}"`;
}

/**
 * The one-time migration (see header). Called from server.js at startup, before any run.
 * @returns {{definitions: number} | null}  null = did not run (marker was set, or there is no definition)
 */
export function migrateToolLists() {
  if (store.getSetting(TOOL_MIGRATION_MARKER, "") || !store.agentsExist()) return null;
  let definitions = 0;
  for (const a of store.agentsBeforeToolMigration()) {
    const list = a.toolList || [];
    const part = readToolList(list);
    if (!part) continue; // `*`: was and stays "everything"
    const alongside = [];
    // A removed name is a NAMED cbase tool for the old Claude path (see header) — otherwise the full catalog.
    const namesRemoved = list.some((n) => REMOVED.has(String(n).trim()));
    if (!part.cbaseWhole && !part.cbase.size && !namesRemoved) alongside.push("mcp__cbase");
    for (const server of ["playwright", ...[...codingServerOfTheWorkspace(a.workspaceId)].sort()]) {
      // Also next to individually named tools: the old Claude path granted the WHOLE server.
      if (part.extern[server] !== null) alongside.push(`mcp__${server}`);
    }
    store.updateAgent(a.id, { toolList: [...list, ...alongside] });
    definitions++;
  }
  store.setSetting(TOOL_MIGRATION_MARKER, new Date().toISOString());
  if (definitions) console.log(`[store] tool lists: ${definitions} definition(s) extended by the previous Claude grants`);
  return { definitions };
}

/**
 * The one-time migration of removed tools (see header). Called from server.js at startup, after `migrateToolLists`, before any
 * run. The count is logged — also a zero, to tell "ran, nothing to do" from "did not run".
 * @returns {{definitions: number} | null}  null = did not run (marker was set, or there is no definition)
 */
export function dropRemovedTools() {
  if (store.getSetting(REMOVED_MIGRATION_MARKER, "") || !store.agentsExist()) return null;
  let definitions = 0;
  for (const a of store.agentsWithToolList()) {
    if (!Array.isArray(a.toolList)) continue; // not set stays not set
    const rest = a.toolList.filter((n) => !REMOVED.has(String(n).trim()));
    if (rest.length === a.toolList.length) continue;
    store.updateAgent(a.id, { toolList: rest }); // [] stays [] — never null
    definitions++;
  }
  store.setSetting(REMOVED_MIGRATION_MARKER, new Date().toISOString());
  console.log(`[store] tool lists: ${definitions} definition(s) without ${REMOVED_TOOLS.join(", ")}`);
  return { definitions };
}

/**
 * The one-time migration of the coding servers out of the tool lists (see header). Called from server.js after
 * `dropRemovedTools`, before any run.
 * @returns {{definitions: number, struck: string[]} | null}  null = did not run (marker was set, or no definition)
 */
export function dropCodingServer() {
  if (store.getSetting(CODING_MCP_MIGRATION_MARKER, "") || !store.agentsExist()) return null;
  let definitions = 0;
  const allStruck = [];
  for (const a of store.agentsWithToolList()) {
    if (!Array.isArray(a.toolList)) continue; // not set stays not set
    const coding = codingServerOfTheWorkspace(a.workspaceId);
    const struck = [];
    const rest = a.toolList.filter((n) => {
      const server = mcpServerOf(n);
      if (!server || !coding.has(server)) return true;
      struck.push(n);
      return false;
    });
    if (!struck.length) continue;
    store.updateAgent(a.id, { toolList: rest }); // [] stays [] — never null
    allStruck.push(`${a.name || a.id}: ${struck.join(", ")}`);
    definitions++;
  }
  store.setSetting(CODING_MCP_MIGRATION_MARKER, new Date().toISOString());
  console.log(`[store] tool lists: ${definitions} definition(s) without coding MCP servers${allStruck.length ? ` — struck: ${allStruck.join("; ")}` : ""}`);
  return { definitions, struck: allStruck };
}
