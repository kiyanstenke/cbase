// The offering of the cbase MCP server as ONE computation over its environment: which tools a run gets in `tools/list`. The server
// of the backend needs it too: Codex 0.15x shows the model NO MCP tool up front (they are deferred sub-tools of `exec`), and the
// name list in the Codex prefix (server/providers/connectors/codex-prefix.js) must be exactly the set the run has — description
// side = execution side. The entry point computes with THIS function over `process.env`, the server over the `env` of its server
// entry (toolchain/mcp-config.js writeMcpConfig); the same function, no copy.
//
// The stages:
//   BASE    outer-loop run (CBASE_OUTER_LOOP): explicit list + outside, without a list ONLY the analysis tool;
//           otherwise explicit list (CBASE_TOOLS, unreadable = EMPTY) + ALWAYS + outside > named set
//           (CBASE_TOOLSET, unknown = none) + outside > full catalog.
//   then    skillGate (cbase_skill only with skills), messengerGate (StructuredOutput only with a schema), depth resp. marker of the
//           workflow agent (the messenger survives both, an outer-loop run has no depth), outer-loop cut,
//           instance cut (copy tools), fence cut (with token), special run, and the run binding
//           (permission prompt — visibility.js ONLY_WITH_RUN_BINDING).
// The reading of every environment variable is that of lib.js/toolsets.js (STRUCTURE_SCHEMA, TOOL_LIST, TOOLSET, AGENT_DEPTH) —
// guard server/backend/test/codex-prefix.test.js starts the real server with the environment of real runs and holds `tools/list`
// against this computation.

import { CATALOG_NAMES } from "./catalog.js";
import { ONLY_OUTER_LOOP, SKILL_WRITE, STRUCTURE_TOOL, lockedForInstance, lockedForRunBinding, lockedForOuterLoop, lockedForSpecialRun, lockedForDepth, lockedForWorkflowAgent, lockedForFence } from "./visibility.js";
import { ALWAYS, TOOLSETS } from "./toolsets.js";

const jsonList = (raw, unreadable) => {
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v.map(String) : unreadable; } catch { return unreadable; }
};

/** The inputs of the visibility from an environment (`process.env` or the `env` of a server entry). */
export function offeringEnvironment(env = {}) {
  const e = env || {};
  let schema = null;
  try { const v = JSON.parse(e.CBASE_SCHEMA || ""); schema = v && typeof v === "object" && !Array.isArray(v) ? v : null; } catch { schema = null; }
  return {
    // Unreadable = EMPTY list (only the app plumbing), never a silent full catalog (toolsets.js TOOL_LIST).
    toolList: e.CBASE_TOOLS ? jsonList(e.CBASE_TOOLS, []) : null,
    toolset: TOOLSETS[String(e.CBASE_TOOLSET || "")] || null,
    depth: Number(e.CBASE_AGENT_DEPTH) || 0,
    skills: jsonList(e.CBASE_SKILLS || "[]", []),
    schema,
    workflowAgent: String(e.CBASE_WORKFLOW_AGENT || ""),
    outerLoop: String(e.CBASE_OUTER_LOOP || ""),
    instance: e.CBASE_INSTANCE,
    token: e.CBASE_TOKEN,
    // A special run (role "special", toolchain/mcp-config.js): without the tools that only the main run of a coding chat has.
    onlySubagents: e.CBASE_ONLY_SUBAGENTS === "1",
    // The main run of a coding chat with the switch on (toolchain/mcp-config.js): only then cbase_skill_write.
    skillWrite: e.CBASE_SKILL_WRITE === "1",
    // The run binding (visibility.js lockedForRunBinding): a run whose CLI asks for approvals via
    // cbase_permission_prompt.
    runBinding: {
      approval: e.CBASE_APPROVAL === "1",
    },
  };
}

/** The names a cbase MCP server with this environment offers in `tools/list` — in catalog order. */
export function offeringNames(env = {}, catalog = CATALOG_NAMES) {
  const u = offeringEnvironment(env);
  // `cbase_skill` stands OUTSIDE the ranking: it is no ability one assigns to an agent, but the access to what is marked for its
  // chat — it depends only on the skills of the run (skillGate below), in a coding chat as in an explicit list, and in neither if the
  // catalog is empty (fresh workspace). The messenger StructuredOutput likewise: no ability, but the way back of an
  // `agent(prompt, {schema})`; it depends only on the schema of the run (messengerGate) and survives every cut.
  const outside = (n) => n === "cbase_skill" || n === STRUCTURE_TOOL;
  // An outer-loop run ALWAYS carries an explicit list (outerloop/set.js); if it is missing anyway, it gets only the analysis tool —
  // never the full catalog (empty is not unknown). With its marker `ALWAYS` (cbase_permission_prompt) does not count: it has no
  // permissionPromptTool.
  const base = u.outerLoop
    ? (u.toolList ? catalog.filter((n) => u.toolList.includes(n) || outside(n)) : catalog.filter((n) => ONLY_OUTER_LOOP.includes(n)))
    : u.toolList ? catalog.filter((n) => u.toolList.includes(n) || ALWAYS.includes(n) || outside(n))
      : u.toolset ? catalog.filter((n) => u.toolset.includes(n) || outside(n))
        : catalog;
  return base
    // Also with an empty catalog if the run may write skills — otherwise a freshly created skill cannot be loaded, and `id`/`version`
    // for changing and deleting come only from this tool.
    .filter((n) => n !== "cbase_skill" || u.skills.length > 0 || u.skillWrite)
    // Writing skills: only by the marker — even an explicit list never names it.
    .filter((n) => n !== SKILL_WRITE || u.skillWrite)
    .filter((n) => n !== STRUCTURE_TOOL || u.schema !== null)
    // The depth table (visibility.js): locked for every subagent what is never its own; the cbase_agent family only at the limit. A
    // workflow agent carries its OWN marker: it replaces the depth table — the set of the chat 1:1 minus delegation, workflows,
    // question, wakeup and monitor, equal at every depth. Likewise an outer-loop run: its marker replaces both — with it
    // OUTER_LOOP_LOCKED applies (filter below), no depth.
    .filter((n) => n === STRUCTURE_TOOL || u.outerLoop || (u.workflowAgent ? !lockedForWorkflowAgent(n) : !lockedForDepth(n, u.depth)))
    // The outer loop (ONLY_OUTER_LOOP, OUTER_LOOP_LOCKED): without the marker the analysis tool is missing for EVERY run (also in an
    // explicit list), with the marker everything chat-bound and the excluded groups are missing.
    .filter((n) => !lockedForOuterLoop(n, u.outerLoop))
    // The copy tools only in a relocated project (marker CBASE_INSTANCE), in a copy without the creating one — for EVERY run, also
    // with an explicit list and as a subagent.
    .filter((n) => !lockedForInstance(n, u.instance))
    // The fence cut: what the API fence of a project container ALWAYS rejects is not offered by a run with a token — not with an
    // explicit list or as a subagent either (FENCE_LOCKED; guard server/backend/test/fence-tools.test.js).
    .filter((n) => !lockedForFence(n, u.token))
    // The agenda: a special run with the full catalog (app-agent chat) writes none — it is no coding chat.
    .filter((n) => !lockedForSpecialRun(n, u.onlySubagents))
    // The run binding: the permission prompt only where the CLI calls it — for EVERY run, also with an explicit list (ALWAYS above
    // included).
    .filter((n) => !lockedForRunBinding(n, u.runBinding));
}

/**
 * The offering of a cbase server ENTRY (`{ env, enabledTools? }` from toolchain/mcp-config.js writeMcpConfig): `offeringNames` of its
 * `env`, cut by `enabledTools` (Codex: `-c mcp_servers.cbase.enabled_tools`). Two readers, one computation: the Codex prefix
 * (server/providers/connectors/codex-prefix.js) and the project focus of a subagent (server/runs/agents.js) — it names only tools
 * from this offering.
 */
export function offeringOfTheEntry(entry) {
  const only = Array.isArray(entry?.enabledTools) ? new Set(entry.enabledTools.map(String)) : null;
  return offeringNames(entry?.env || {}).filter((n) => !only || only.has(n));
}
