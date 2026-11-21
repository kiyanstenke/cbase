// Toolsets and filter inputs of the cbase MCP server: ALWAYS, TOOLSETS (currently empty), TOOLSET (from CBASE_TOOLSET),
// AGENT_DEPTH, TOOL_LIST (from CBASE_TOOLS). Only names and environment; the filtering itself (VISIBLE_TOOLS) lives in the
// entry point because it needs the assembled TOOLS.

import process from "node:process";

// ── Toolsets: a run may be restricted to a subset ──────
// Some chats are cut to ONE task; showing them the full catalog costs context and invites detours (reading files, touching
// ports) that do not belong there. CBASE_TOOLSET therefore selects a named set: the name comes from writeMcpConfig, the list
// is HERE so that tools/list and tools/call use the same source.
// `cbase_permission_prompt` belongs in every set: it is app plumbing (Claude Code calls it via --permission-prompt-tool), not
// an ability of the agent. It is offered only with the marker CBASE_APPROVAL (visibility.js lockedForRunBinding); a run
// without the CLI flag never calls it.
const ALWAYS = ["cbase_permission_prompt"];
const TOOLSETS = {
};
// Unknown name = no set (full catalog) instead of a silently empty server.
const TOOLSET = TOOLSETS[String(process.env.CBASE_TOOLSET || "")] || null;
// If this server runs FOR A SUBAGENT (CBASE_AGENT_DEPTH, set by writeMcpConfig), the depth table from visibility.js applies:
// what belongs to the main agent (question, wakeup, monitor, capture sending) is always locked, the cbase_agent family only at
// the limit (depth 3). A tool the subagent should not see is not offered at all; otherwise it would call it and just get an
// error.
const AGENT_DEPTH = Number(process.env.CBASE_AGENT_DEPTH) || 0;
// Explicit tool list: the tools of the run (a subagent, an outer-loop run) as JSON in CBASE_TOOLS. It takes precedence over
// the named set. Unreadable = no filter would be a silent FULL catalog for a restricted chat, so it becomes an EMPTY list (only
// the app plumbing) and the error shows immediately.
const TOOL_LIST = (() => {
  if (!process.env.CBASE_TOOLS) return null;
  try { const v = JSON.parse(process.env.CBASE_TOOLS); return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
})();

export { AGENT_DEPTH, ALWAYS, TOOLSET, TOOLSETS, TOOL_LIST };
