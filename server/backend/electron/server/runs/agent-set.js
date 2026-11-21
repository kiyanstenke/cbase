// A subagent's toolset — ONE computation:
//
//   child's set = set of the parent AGENT ∩ what definition or call require ∩ depth table,
//                 in catalog order.
//
// A child never gets more tools than its parent agent (not the chat): that is how a read-only cut is inherited down
// to the grandchild. The cbase part goes to the MCP server as an EXPLICIT list (CBASE_TOOLS) — if it is missing, the
// server falls back to the named set or the full catalog, and a grandchild would inherit everything. So from depth 2
// on the set is ALWAYS a list, even if the parent agent had no cut (then: the full set of a coding chat, written
// out). Only at depth 1 does "no cut" (`null`) remain if neither the chat nor the call requires one — there the MCP
// server's full catalog is exactly the chat's set.
//
// The tool list of a definition is a factor of THIS computation, not a second cut next to it: a SET list means the
// same on all three paths as in Claude Code — only what is listed, MCP tools and `cbase_*` included. The spelling is
// Claude Code's: one tool `mcp__<server>__<tool>`, a whole server `mcp__<server>` or `mcp__<server>__*`, `*` =
// everything (like no list). cbase tools may also stand bare (`cbase_agent`), and `Skill` is cbase's skill tool
// (`cbase_skill`, which replaces the CLI's own).
//
//   not set (null)  the full set of the path — not set is not empty;
//   []              none of the cuttable tools (builtin, cbase, foreign servers).
//
// What "cuttable" does not cover: the CLI does not take away Codex's builtins (shell, patch, web search); the app
// plumbing `cbase_permission_prompt` (the CLI's --permission-prompt-tool) stays on the server.
//
// A cut of the parent run is the set depth 1 begins with — it is not the server's block list.
//
// A leaf: it imports only the two leaves of the MCP tree (names, table) and the names of the builtins
// (providers/contract.js, without imports), no domain.

import { CATALOG_NAMES } from "../../mcp/catalog.js";
import { ONLY_WITH_RUN_BINDING, ONLY_WITH_OUTER_LOOP_MARKER, STRUCTURE_TOOL, lockedForDepth, lockedForWorkflowAgent } from "../../mcp/visibility.js";
import { BUILTIN_TOOLS } from "../providers/contract.js";

const CATALOG = new Set(CATALOG_NAMES);
const PREFIX = "mcp__cbase__";

// The full set of a coding chat without a cut (what the MCP server offers without CBASE_TOOLS/CBASE_TOOLSET).
// Without the tools that need the outer loop marker (the MCP server never offers them without the marker — listed
// here, every grandchild's explicit list would carry extra names and the golden `spawn.json` would change without
// any change to the offering) and without the tools with run binding (the permission prompt — the MCP server appends
// it via ALWAYS where the run's marker requires it).
const FULL_SET = Object.freeze(CATALOG_NAMES.filter((n) => !ONLY_WITH_OUTER_LOOP_MARKER.includes(n) && !ONLY_WITH_RUN_BINDING.includes(n)));

// Builtin names a list may carry: the canonical set (contract.js) and the Claude CLI's task tools, which are
// deliberately missing there (the engine has TodoWrite).
const BUILTIN = new Set([...BUILTIN_TOOLS, "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "TaskOutput"]);

/** A required name, read as a cbase tool (`mcp__cbase__x`, bare `cbase_x`, `Skill`) — otherwise `null`. */
function cbaseName(name) {
  const n = String(name || "").trim();
  if (n === "Skill") return "cbase_skill";
  const bare = n.startsWith(PREFIX) ? n.slice(PREFIX.length) : n;
  return CATALOG.has(bare) ? bare : null;
}

/** `mcp__server`, `mcp__server__*`, `mcp__server__tool` → {server, tool|null}; otherwise null. */
function mcpParts(name) {
  const m = /^mcp__([A-Za-z0-9_-]+?)(?:__(.+))?$/.exec(String(name || "").trim());
  if (!m) return null;
  return { server: m[1], tool: m[2] && m[2] !== "*" ? m[2] : null };
}

/**
 * The list of a definition or a call, read: `null` = not set (also `*`, as in Claude Code), otherwise its three
 * parts. An unreadable value (neither list nor null) is not set — the routes let no other through.
 * @returns {null | {cbaseWhole: boolean, cbase: Set<string>, builtin: string[], extern: Object<string, string[]|null>}}
 */
export function readToolList(required) {
  if (!Array.isArray(required)) return null;
  const list = required.map((x) => String(x).trim()).filter(Boolean);
  if (list.includes("*")) return null;
  const part = { cbaseWhole: false, cbase: new Set(), builtin: [], extern: {} };
  for (const n of list) {
    const hex = cbaseName(n);
    if (hex) { part.cbase.add(hex); continue; }
    const mcp = mcpParts(n);
    if (!mcp) { part.builtin.push(n); continue; }
    if (mcp.server === "cbase") { if (!mcp.tool) part.cbaseWhole = true; continue; }
    const soFar = part.extern[mcp.server];
    if (!mcp.tool) part.extern[mcp.server] = null;
    else if (soFar !== null) part.extern[mcp.server] = [...new Set([...(soFar || []), mcp.tool])];
  }
  return part;
}

// Intersection of two external allowances (null = no cut; per server null = whole server, list = only these tools).
function externIntersection(a, b) {
  if (!a) return b;
  if (!b) return a;
  const out = {};
  for (const [server, wa] of Object.entries(a)) {
    if (!Object.hasOwn(b, server)) continue;
    const wb = b[server];
    out[server] = wa === null ? wb : wb === null ? wa : wa.filter((w) => wb.includes(w));
  }
  return out;
}

/**
 * @param {Object} a
 * @param {{cbase: string[]|null, builtin: string[]|null, extern?: Object|null, skill?: boolean}} [a.parent]  set of
 *        the parent agent; at depth 1 the set the chat gives its subagents (`cbase` = read-only cut or `null` = no
 *        cut; `builtin` null = the run's builtin tools; `extern` null = all foreign MCP servers of the run)
 * @param {string[]|null} [a.required]  tool list from call or definition — `null`/omitted = not set, `[]` = empty
 *        (these are two statements)
 * @param {number} a.depth  depth of the child (1 = directly below the chat)
 * @returns {{cbase: string[]|null, builtin: string[]|null, extern: Object|null, skill: boolean}}
 *        `extern`: null = all foreign servers of the run, otherwise {server: null (whole) | [tool…]};
 *        `skill`: whether `cbase_skill` (and with it the skill catalog in the prompt) belongs to the set
 */
export function agentToolset({ parent = { cbase: null, builtin: null }, required = null, depth }) {
  const t = Number(depth) || 1;
  const list = readToolList(required);
  const parentHex = Array.isArray(parent?.cbase) ? parent.cbase.map(String) : null;

  // ── cbase part ── A set list without a cbase entry gives NO cbase tool. A whole server (`mcp__cbase`) is like
  // no list for this part.
  const cut = list && !list.cbaseWhole ? list.cbase : null;
  let cbase;
  if (t <= 1 && !parentHex && !cut) {
    cbase = null; // depth 1 without any cut: the server's full catalog IS the chat's set.
  } else {
    const base = new Set(parentHex || FULL_SET);
    cbase = CATALOG_NAMES.filter((n) => base.has(n) && (!cut || cut.has(n)) && !lockedForDepth(n, t));
  }

  // ── Builtin tools ── (null = those of the run; a list = this agent's allowlist). A list that carries only MCP
  // names leaves NO builtin ones.
  const parentBuiltin = Array.isArray(parent?.builtin) ? parent.builtin.map(String) : null;
  let builtin;
  if (!list) builtin = parentBuiltin;
  else if (!parentBuiltin) builtin = list.builtin;
  else builtin = list.builtin.filter((n) => parentBuiltin.includes(n));

  // ── Foreign MCP servers ── only what the list names; a child never more than its parent agent.
  const extern = externIntersection(parent?.extern ?? null, list ? list.extern : null);

  // ── Skill tool ── belongs to the set as long as no list excludes it; it is inherited like the rest. Only a list
  // cuts it — a read-only parent set without it keeps it anyway (the server offers it next to every explicit list
  // as long as the run has skills).
  const skill = parent?.skill !== false && (!list || list.cbaseWhole || list.cbase.has("cbase_skill"));

  return { cbase, builtin, extern, skill };
}

/**
 * A workflow agent's set: the chat's 1:1 (including browser, captures, channels) MINUS delegation, workflows,
 * question, wakeup and monitor — cut via ITS marker (lockedForWorkflowAgent), never via the depth table. Builtins,
 * foreign servers and skill as for a direct subagent.
 * `cbase` stays `null` if neither chat nor call cut: then the MCP server cuts via the marker alone.
 */
export function workflowAgentSet({ parent = { cbase: null, builtin: null }, required = null } = {}) {
  const set = agentToolset({ parent, required, depth: 1 });
  const list = readToolList(required);
  const cut = list && !list.cbaseWhole ? list.cbase : null;
  const parentHex = Array.isArray(parent?.cbase) ? parent.cbase.map(String) : null;
  if (!parentHex && !cut) return { ...set, cbase: null };
  const base = new Set(parentHex || FULL_SET);
  return { ...set, cbase: CATALOG_NAMES.filter((n) => base.has(n) && (!cut || cut.has(n)) && !lockedForWorkflowAgent(n)) };
}

/**
 * The coding MCP servers of a subagent or workflow agent (toolchain/agent-mcp.js) — ONE computation for the MCP file
 * (toolchain/mcp-config.js `codingChoice`), the allowlist (runs/agents.js), the airlock token and the set this agent
 * passes on to its children (`parentSet.coding`):
 *
 *   per coding server of the run that the PARENT has (a child never more than its parent):
 *     the type names it             ⇒ type ∩ parent (null ∩ x = x; list ∩ list = the common tools) — also without
 *                                     "subagents inherit";
 *     otherwise "subagents inherit" ⇒ what the parent has;
 *     otherwise                     ⇒ not.
 *
 * @param {{parent?: Object|null, type?: Object|null, server?: {id: string, subagentsInherit?: boolean}[]}} a
 *        `parent`: null = the chat's main run (every coding server of the run as a whole — the airlock checks its
 *        choice on the server), otherwise the parent agent's map; `type`: the definition's choice (`agents.mcp`) or
 *        null; `server`: the coding servers of the run.
 * @returns {Object<string, null|string[]>}  serverId → null (whole) | [tool…]; a server missing = not
 */
export function codingSet({ parent = null, type = null, server = [] } = {}) {
  const out = {};
  for (const s of server || []) {
    const id = String(s?.id ?? "");
    if (!id) continue;
    const e = parent === null ? null : Object.hasOwn(parent, id) ? parent[id] : undefined;
    if (e === undefined) continue; // the parent does not have it
    if (type && Object.hasOwn(type, id)) {
      const t = type[id];
      const w = t === null ? e : e === null ? [...t] : t.filter((x) => e.includes(x));
      if (w === null || w.length) out[id] = w === null ? null : [...w];
      continue;
    }
    if (s.subagentsInherit !== false) out[id] = e === null ? null : [...e];
  }
  return out;
}

/** May a run with this external allowance use the server `server` (or its tool `tool`)? */
export function externAllowed(extern, server, tool = null) {
  if (!extern) return true;
  if (!Object.hasOwn(extern, server)) return false;
  const w = extern[server];
  return w === null || tool === null || w.includes(tool);
}

/**
 * The loop engine's allowlist (`spec.agentTools`) from a set — only if the builtins are cut (otherwise `null`: then
 * the engine offers the run's set). The cbase names are written out where the set cuts them (so the plumbing stays
 * outside), otherwise as `mcp__cbase__*`; a whole foreign server stands as `mcp__<server>__*`.
 * `bote`: the start carries a schema — the messenger tool StructuredOutput survives this cut too (the MCP server
 * offers it next to every list; without it here the engine would take it away again).
 */
export function engineAllowlist(set, { bote = false } = {}) {
  if (!Array.isArray(set?.builtin)) return null;
  const out = [...set.builtin, ...(set.cbase === null ? [`${PREFIX}*`] : set.cbase.map((n) => `${PREFIX}${n}`))];
  if (bote && set.cbase !== null && !set.cbase.includes(STRUCTURE_TOOL)) out.push(`${PREFIX}${STRUCTURE_TOOL}`);
  if (set.extern === null) out.push("mcp__*");
  else for (const [server, w] of Object.entries(set.extern)) out.push(...(w === null ? [`mcp__${server}__*`] : w.map((x) => `mcp__${server}__${x}`)));
  return out;
}

/**
 * The first name of a list that is not a registered tool — otherwise `null` (on save an error with the name instead
 * of silently vanishing). Registered are: the builtins (also with a rule `Bash(git *)`), the cbase tools of the
 * catalog (also bare), the cbase server as a whole, `*`, and the foreign servers in `server` (cbase knows their
 * individual tools only at the running server — the server name is checked).
 * @param {string[]} list
 * @param {{server?: Iterable<string>}} [o]  known foreign MCP servers (workspace, projects)
 */
export function unknownTool(list, { server = [] } = {}) {
  const known = new Set(["playwright", ...server]);
  for (const raw of list || []) {
    const n = String(raw).trim();
    if (!n || n === "*" || cbaseName(n)) continue;
    const mcp = mcpParts(n);
    if (mcp) {
      if (mcp.server === "cbase" ? !mcp.tool : known.has(mcp.server)) continue;
      return n;
    }
    if (BUILTIN.has(n.replace(/\(.*\)$/s, "").trim())) continue;
    return n;
  }
  return null;
}
