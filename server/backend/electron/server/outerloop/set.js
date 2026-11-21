// The toolset of ONE outer loop run. ONE computation for the execution (MCP list CBASE_TOOLS, allowlist of the built-ins,
// coding servers as wrappers of the airlock — runs/agents.js agentSpecFactory with `outerLoop`), the description (tool
// primer in the frame, input.js) and the run display (column `set`):
//
//   cbase   = CATALOG order( selection ∩ OUTER_LOOP_SELECTABLE ∖ approval marks ∖ (withToken ? FENCE_LOCKED : ∅)
//                                    ∪ cbase_chat_analysis ∪ (agenda keeper ? AGENDA_KEEPER_TOOLS : ∅)
//                                    ∪ (timeline agent ? TIMELINE_TOOLS : ∅) )
//   builtin = selection ∩ OUTER_LOOP_BUILTIN        (empty = none; Claude "--tools ''")
//   extern  = the selected CODING MCP servers in the set of the observed chat (store.effectiveMcpServers with its project —
//             the same computation as the airlock), per server the selected tools without marked ones and without those
//             deselected at the server
//   dropped = { fence: [...], approval: [...], locked: [...], genus: [] }
//                                                    what the selection names but the run does not have — the primer says so
//
// External servers run through the coding MCP airlock (toolchain/airlock-routes.js, token role `outer_loop`): the MCP file
// holds only the wrapper with a run token, never a credential of the real server — so they are not dropped in the project
// container. The airlock checks every call live against the same selection and answers a marked tool with a sentence
// instead of a card. On the chat of a project the selected servers are the coding servers of THAT project (including
// project-owned ones): a run with them needs the location of the chat (`needsProject`) — the wrapper of a stdio server
// starts where the CLI runs (header of mcp/airlock.js), an http server is addressed from the namespace of the instance, as
// in the coding chat. `genus` stays empty — the clients still read the field.
//
// Tools with an approval mark are MISSING from the set: an offered tool that every call rejects would violate
// "description = execution". The fence cut only with a token: a run with tools in an instance goes through the API fence
// (mcp/visibility.js FENCE_LOCKED — the MCP server does not offer them there anyway, nor should the primer).
// Without any selection (neither cbase, built-in nor MCP) the run is sandboxed — only the analysis tool, in the empty
// folder in the backend, never in the project container.
//
// The agenda keeper ALWAYS gets cbase_agenda (read) and cbase_agenda_maintain (catch up) on top — fixed, not selectable,
// like the analysis tool. No other outer loop agent gets them: the agenda group is not in OUTER_LOOP_SELECTABLE, and the
// MCP server offers cbase_agenda_maintain to nobody without the outer loop marker (mcp/visibility.js ONLY_AGENDA_KEEPER).
// They run via the API, not in the project — `needsProject` stays unchanged, a keeper without a selection runs sandboxed
// in the backend. The order is that of the catalog: the agenda group comes AFTER the outer loop group there
// (cbase_chat_analysis, cbase_agenda, cbase_agenda_maintain).
//
// The timeline agent likewise: ALWAYS cbase_timeline and cbase_timeline_write (mcp/visibility.js ONLY_TIMELINE_AGENT —
// locked for every run without the outer loop marker), no other agent, selectable for nobody. They run via the API;
// `needsProject` stays unchanged.

import { CATALOG_NAMES } from "../../mcp/catalog.js";
import { ONLY_AGENDA_KEEPER, ONLY_OUTER_LOOP, ONLY_TIMELINE_AGENT, FENCE_LOCKED } from "../../mcp/visibility.js";
import { approvalMarks } from "../toolchain/approval-marks.js";
import * as store from "../store.js";
import { focusedProject } from "../runs/system-prompt.js";
import { RESERVED_MCP_NAMES, isValidMcpName, mcpServerToConfigEntry } from "../toolchain/mcp-config.js";
import { verdict } from "../toolchain/mcp-tools.js";
import { OUTER_LOOP_BUILTIN, OUTER_LOOP_SELECTABLE } from "./catalog.js";

const SELECTABLE = new Set(OUTER_LOOP_SELECTABLE);

/** The two fixed tools of the agenda keeper, in catalog order — also read by the frame (input.js). */
export const AGENDA_KEEPER_TOOLS = Object.freeze(["cbase_agenda", ...ONLY_AGENDA_KEEPER]);

/** The two fixed tools of the timeline agent (read, write), in catalog order. */
export const TIMELINE_TOOLS = Object.freeze([...ONLY_TIMELINE_AGENT]);

/**
 * Does the run need the location of its chat (cwd of the project, instance)? With selected cbase or built-in tools — they
 * work on the project — and on the chat of a project also with a selected coding server in the chat's set: those are the
 * project's servers, and wrapper and forwarding belong in its instance as in the coding chat. Without a project external
 * servers run in the backend — like a workspace chat. Without any selection never.
 */
export function needsProject(agent, chat = null) {
  if ((agent?.tools || []).some((t) => SELECTABLE.has(t))) return true;
  if ((agent?.builtin || []).some((t) => OUTER_LOOP_BUILTIN.includes(t))) return true;
  return Boolean(chat && focusedProject(chat)) && selectedCodingServer(agent, chat).length > 0;
}

/**
 * The selected coding servers of an agent in the set of the observed chat — `{ server, choice }` per server, in the order
 * of the set. Only servers writeMcpConfig would write too (valid, non-reserved name, startable entry): otherwise the
 * primer would name tools the run does not have.
 */
export function selectedCodingServer(agent, chat) {
  const choice = agent?.mcp || {};
  if (!Object.values(choice).some((l) => Array.isArray(l) && l.length)) return [];
  const wid = chat?.workspaceId || agent?.workspaceId || "";
  let set = [];
  try { set = store.effectiveMcpServers(wid, chat ? focusedProject(chat)?.id ?? null : null); } catch { set = []; }
  return set
    .filter((s) => Array.isArray(choice[s.id]) && choice[s.id].length)
    .filter((s) => !RESERVED_MCP_NAMES.has(s.name) && isValidMcpName(s.name) && mcpServerToConfigEntry(s))
    .map((s) => ({ server: s, choice: choice[s.id] }));
}

/**
 * @param {object} agent  store.outerLoopAgent shape
 * @param {object} chat   the observed chat (for workspace, project and the marks)
 * @param {{ withToken?: boolean }} [opts]  `withToken`: the run goes through the API fence (with tools AND an instance)
 * @returns {{ cbase: string[], builtin: string[], extern: object[], dropped: { fence: string[], approval: string[], locked: string[], genus: string[] } }}
 *          `extern`: `{ server: { id, key, name }, tools: [{ name, description, writing }], source }` — `source` is the
 *          coding server (store shape) for writeMcpConfig, never written to the row
 */
export function outerLoopSet(agent, chat, { withToken = false } = {}) {
  const wid = agent?.workspaceId || chat?.workspaceId || "";
  const marked = new Set(approvalMarks(wid, SELECTABLE));
  const selected = new Set((agent?.tools || []).filter((t) => SELECTABLE.has(t)));
  const fence = [];
  const approval = [];
  const locked = [];
  const cbase = [];
  // The fixed tools of this run: the analysis tool of every run, the keeper's or timeline agent's two — no approval mark
  // and no fence cuts them (they are not a selection, and the fence admits their routes).
  const fixed = new Set([...ONLY_OUTER_LOOP, ...(agent?.agendaKeeper ? AGENDA_KEEPER_TOOLS : []), ...(agent?.timeline ? TIMELINE_TOOLS : [])]);
  for (const t of CATALOG_NAMES) {
    if (fixed.has(t)) { cbase.push(t); continue; }
    if (!selected.has(t)) continue;
    if (marked.has(t)) { approval.push(t); continue; }
    if (withToken && Object.hasOwn(FENCE_LOCKED, t)) { fence.push(t); continue; }
    cbase.push(t);
  }
  const builtin = OUTER_LOOP_BUILTIN.filter((t) => (agent?.builtin || []).includes(t));
  const extern = [];
  for (const { server, choice } of selectedCodingServer(agent, chat)) {
    const known = new Map((server.tools || []).map((w) => [w.name, w]));
    const tools = [];
    for (const name of choice) {
      const u = verdict(server, name);
      // Deselected for coding at the server (Coding → MCP): the airlock would reject every call.
      if (u === "locked") { locked.push(`mcp__${server.name}__${name}`); continue; }
      if (u === "card") { approval.push(`mcp__${server.name}__${name}`); continue; }
      // A selection the cache does not know (yet) stays — its effect is undetermined.
      const w = known.get(name);
      tools.push({ name, description: w?.description || "", writing: w ? w.writing ?? null : null });
    }
    if (tools.length) extern.push({ server: { id: server.id, key: server.name, name: server.name }, tools, source: server });
  }
  return { cbase, builtin, extern, dropped: { fence, approval, locked, genus: [] } };
}

/** The set for the run row (`outer_loop_runs.item_set`): names, without the servers themselves. */
export function setRow(set) {
  return {
    cbase: [...set.cbase],
    builtin: [...set.builtin],
    extern: set.extern.map((x) => ({ key: x.server.key, name: x.server.name, tools: x.tools.map((t) => t.name) })),
    dropped: { fence: [...set.dropped.fence], approval: [...set.dropped.approval], locked: [...(set.dropped.locked || [])], genus: [...(set.dropped.genus || [])] },
  };
}

/** The full names of the external tools of a set (`mcp__<server>__<tool>`) — the allowlist of the engine. */
export const externalNames = (set) => set.extern.flatMap((x) => x.tools.map((t) => `mcp__${x.server.key}__${t.name}`));
