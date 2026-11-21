// The run tokens of the coding MCP airlock. A leaf (only node:crypto), in memory: after a backend restart all are gone ⇒ 401
// until the next run (auto-resume writes a new file).
//
// writeMcpConfig (toolchain/mcp-config.js) issues ONE token per run or per agent — `{ chatId, role, agentId, workspaceId,
// setProject }`, WITHOUT a background flag (whether an agent runs in the background is computed live by the route on every
// request). It is passed as `CBASE_AIRLOCK` in the `env` of every wrapper entry (for Codex as `env_vars`, never in argv). A new
// token for the same key (chat + main run, or chat + agent) supersedes the old one: the next turn or the next process of an
// agent rewrites its file.
//
// Expiry: at the end of the run (runs/do-run.js, next to clearChatPermissions) or of the agent (runs/agents.js cleanUpAgent).
// `setProject` is the project the set of coding servers is computed for (like focusedProject), so the route's "server is in
// the set NOW" check uses the same computation; `instance` is the identifier of the run's instance (empty = B) — the route
// forwards an http server from its namespace.
// A subagent or workflow agent also carries `codingChoice` (its coding servers, serverId → null | [tool]) and `fromType` (the
// ids its agent type brings — toolchain/agent-mcp.js); without a computed set `null` and empty.
// Role `outer_loop`: an outer-loop run, `agentId` is the agent of its own core, `outerLoopAgent` the outer-loop agent — the
// route reads that agent's choice (`mcp`) live on every request, not from the token.

import crypto from "node:crypto";

export const ROLES = Object.freeze(["main", "subagent", "workflow", "outer_loop"]);
const TOKEN = new Map(); // token → entry
const KEY = new Map(); // key → token

const keyOf = (chatId, role, agentId) => `${chatId}\u0000${role === "main" ? "main" : `agent:${agentId}`}`;

/** Issue a token; an earlier one for the same run or agent expires. */
export function issue({ chatId, role, agentId = "", workspaceId = "", setProject = null, instance = "", outerLoopAgent = "", codingChoice = null, fromType = [] }) {
  if (!chatId || !ROLES.includes(role)) throw new Error(`airlock token: invalid role ${role}`);
  if (role !== "main" && !agentId) throw new Error("airlock token: an agent needs its id");
  if (role === "outer_loop" && !outerLoopAgent) throw new Error("airlock token: an outer-loop run needs its agent");
  const key = keyOf(chatId, role, agentId);
  const old = KEY.get(key);
  if (old) TOKEN.delete(old);
  const token = crypto.randomBytes(24).toString("base64url");
  TOKEN.set(token, Object.freeze({ chatId: String(chatId), role, agentId: role === "main" ? "" : String(agentId), workspaceId: String(workspaceId || ""), setProject: setProject || null, instance: String(instance || ""), outerLoopAgent: role === "outer_loop" ? String(outerLoopAgent) : "",
    // The coding servers of this agent (runs/agent-set.js codingSet, only subagent/workflow agent with a computed set) and
    // which of them its agent type brings — those pass the airlock even without "Subagents inherit" (airlock-routes.js).
    codingChoice: role !== "main" && role !== "outer_loop" && codingChoice && typeof codingChoice === "object" ? Object.freeze({ ...codingChoice }) : null,
    fromType: role !== "main" && role !== "outer_loop" ? Object.freeze((fromType || []).map(String)) : Object.freeze([]),
    at: Date.now() }));
  KEY.set(key, token);
  return token;
}

/** The entry for a token — `null` if it is unknown or expired. */
export function checkToken(token) {
  return (typeof token === "string" && token && TOKEN.get(token)) || null;
}

/** Expire the token of the main run (agentId empty) or of an agent. */
export function expiry(chatId, agentId = "") {
  const key = agentId ? keyOf(chatId, "subagent", agentId) : keyOf(chatId, "main", "");
  const t = KEY.get(key);
  if (t) TOKEN.delete(t);
  KEY.delete(key);
}

/** Tests only: all tokens gone (as after a restart). */
export function expireAllTokens() {
  TOKEN.clear();
  KEY.clear();
}

export const openToken = () => TOKEN.size;
