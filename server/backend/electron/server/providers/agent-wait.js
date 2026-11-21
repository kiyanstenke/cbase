// agent-wait.js — how long a call waits for a subagent: the edge of an MCP call, the foreground deadline and the rule
// "the main agent never waits". A leaf without imports; providers/agent-runtime.js reads it and passes the names on
// (importers stay with agent-runtime.js).

// The edge of a waiting MCP call: Node cuts a request to the cbase MCP server off at ≈ 300 s (measured). Whatever waits
// for a subagent stays below it — the foreground (FOREGROUND_DEFAULT_MS) and the wait of cbase_agent_output (parameter
// `timeout`). ONE number for both.
export const MCP_WAIT_EDGE_MS = 240_000;
// cbase_agent_output: default and cap are the edge; schema and description (mcp/tools/agents.js) name the same number,
// bound in mcp-schema.test.js.
export const OUTPUT_WAIT_MAX_MS = MCP_WAIT_EDGE_MS;

// ── Foreground deadline ────────────────────────────────────────────────────────────────────────────────────────
// A foreground agent (`run_in_background: false`, also with cbase_agent_send) blocks its tool call at most this long;
// after that it moves to the background ON ITS OWN: the call returns with "continues in the background", its end arrives
// as a completion notice. Reason, measured: the call runs over MCP, and Node cuts a waiting request off at ≈ 300 s.
// `wait_ms` therefore no longer exists; a call that still carries it is not rejected, it just has no effect. The knob
// `CBASE_AGENT_FOREGROUND_MS` is product configuration (and injectable in tests).
export const FOREGROUND_DEFAULT_MS = MCP_WAIT_EDGE_MS;
export function foregroundDeadline() {
  const n = Number(process.env.CBASE_AGENT_FOREGROUND_MS);
  return Number.isFinite(n) && n > 0 ? n : FOREGROUND_DEFAULT_MS;
}
// The open foreground deadlines of ALL cores of the process — test seam only: a test counts the deadline instead of
// waiting for it (model: `wakeParkedNow` in runs/agents.js).
export const foregroundDeadlines = new Set();
/** Test seam: every open foreground deadline expires NOW. Returns the number of agents moved to the background. */
export function foregroundDeadlinesNow() {
  let n = 0;
  for (const changeover of [...foregroundDeadlines]) if (changeover("deadline")) n += 1;
  return n;
}
// ── The main agent never waits ─────────────────────────────────────────────────────────────────────────────────
// A subagent started by the MAIN AGENT of a chat always runs in the background right away — even with
// `run_in_background: false` —, and cbase_agent_output does not wait for the main agent: its turn ends normally, the
// chat shows no working indicator above a waiting call, the report arrives as a completion notice.
// Foreground and deadline (above) remain for a subagent that delegates itself: an agent waits for its child, not the
// chat. Main agent means: no parent agent (`meta.parentAgent`, from the profile of its MCP server, runs/routes.js) —
// the same boundary at which the MCP server cuts description and schema (depth 0, mcp/tools/agents.js).
// The knob (mainAgentWaitMs below) caps how long the main agent waits (default 0 = never). Only the gate points it the
// other way (tools/check/targets/check.mjs, like the stall deadline): most agent tests fetch the report in the call
// because they measure something else; what holds in the product is kept by
// server/backend/test/main-agent-waiting-never.test.js WITHOUT the knob.
export const MAIN_AGENT_WAIT_DEFAULT_MS = 0;
// Read on every call (never at load time): a test sets the knob at the top of its file.
export function mainAgentWaitMs() {
  return Number(process.env.CBASE_MAIN_AGENT_WAIT_MS) > 0 ? Number(process.env.CBASE_MAIN_AGENT_WAIT_MS) : MAIN_AGENT_WAIT_DEFAULT_MS;
}
