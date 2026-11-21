// Target "own subagent" of cbase_agent_send — and the resolution that start, message and output of a subagent share.
// runs/routes.js takes the helpers from here for /agent, /agent/output and /agent/stop — ONE version of the resolution, not two.
//
// Like monitor and wakeup, only during an active run of THIS chat: a subagent writes into its event stream, is kept open by
// it and dies with it. If a SUBAGENT calls (`ofProfile`, set by its run's MCP server), ITS core applies — the one it lives
// in, also without a running turn — and it is the parent agent; otherwise the chat's owner, only in a run. If the main agent
// names an existing agent (send, output), the core that knows it applies — it may have been started in an earlier turn
// (subagents belong to the chat); a new agent starts in the chat's own.
// `caller`: the core of the CALLING turn (the subagent's, or the running turn's) — its approval ("start anyway") carries a
// continuation through the credit gate like a start.
// WHICH agent a name means is told by ONE resolution for send, output and stop (runs/agents.js resolveAgent): the caller's
// own children first, a living one before a known one; ambiguous it throws with status 400 and the candidates (the
// dispatcher answers with the status). The hit's core is the operation's core, and its EXACT id goes on to send/output.
// From a project network a name counts only among the agents of the token's instance (`onlyInstance`).

import { resolveAgent, agentsOf, callerOf, instanceOfTheTarget, isChildOf } from "../runs/agents.js";
import { running } from "../runs/state.js";

// The three wordings are English plain text (they are read by the agent that called the tool; runs/routes.js imports the constants).
export const FOREIGN_CHILD = "This subagent is not one of your subagents — you only control those you started yourself.";
export const FOREIGN_INSTANCE = "This subagent lives in an instance other than this token's.";
export const NO_RUN = "No active run — a subagent needs a running turn.";

/** The helpers of a request to `/api/chats/<id>/agent*` — `fence` is `ctx.fence` (null outside a project network). */
export function subagentHelper(id, fence = null) {
  const onlyInstanceOfTheFence = () => (fence ? { onlyInstance: fence.identifier ?? null } : {});
  const agentsCore = (b, targetId = "") => {
    const a = callerOf(id, b.ofProfile);
    if (!a && !running.has(id)) return { ctl: null, parent: "", caller: null, target: null };
    const target = targetId ? resolveAgent(id, targetId, { parentAgent: a ? a.parentAgent : "", ...onlyInstanceOfTheFence() }) : null;
    if (a) return { ctl: a.core ? target?.core || a.core : null, parent: a.parentAgent, caller: a.core, target };
    return { ctl: target?.core || agentsOf(id), parent: "", caller: agentsOf(id), target };
  };
  const withTarget = (b, target) => (target ? { ...b, agentId: target.agentId } : b);
  const onlyOwnChildren = (ctl, parent, targetId) => !parent || isChildOf(ctl, targetId, parent);
  // From a project network (`fence`) the agent named must live in the TOKEN's instance — the instance of the agent itself
  // is asked, on EXACTLY the path send/output take (runs/agents.js instanceOfTheTarget). Without `targetId` (start) the
  // core's instance. Without a fence (B itself, the UI) no check.
  const agentInForeignInstance = (ctl, targetId) => {
    if (!fence) return false;
    if (!targetId) return Boolean(ctl) && (ctl.instance || null) !== fence.identifier;
    const identifier = instanceOfTheTarget(id, ctl, targetId);
    return identifier !== undefined && identifier !== fence.identifier;
  };
  // The START: a new child lives in the core `ctl` and inherits its instance — from a project network the core must
  // therefore lie in the token's instance AND, if a subagent calls through `ofProfile`, so must the parent agent named.
  const startInForeignInstance = (ctl, parent) => agentInForeignInstance(ctl, parent) || agentInForeignInstance(ctl, "");
  return { onlyInstanceOfTheFence, agentsCore, withTarget, onlyOwnChildren, agentInForeignInstance, startInForeignInstance };
}

/**
 * A message to one's own subagent (the body of POST /agent/send). `named` is agentId or label, `body` the rest of the tool
 * call (message …). → `{ status, body }`; the core's report additionally gets `ok`, `state` and `text` of the uniform
 * response (send.js).
 */
export async function sendToSubagent({ chatId, fence = null, named, ofProfile, body }) {
  const h = subagentHelper(chatId, fence);
  const { ctl, parent, caller, target } = h.agentsCore({ ofProfile }, named);
  if (!ctl) return { status: 409, body: { error: NO_RUN } };
  if (h.agentInForeignInstance(ctl, target?.agentId || named)) return { status: 403, body: { error: FOREIGN_INSTANCE } };
  if (!h.onlyOwnChildren(ctl, parent, target?.agentId || String(body.agentId || ""))) return { status: 400, body: { error: FOREIGN_CHILD } };
  try {
    const r = await ctl.send(h.withTarget(body, target), { overruled: caller?.approval?.() === true, parentAgent: parent || "" });
    const state = r?.afterEnd ? "after_turn" : "delivered";
    return { status: 200, body: { ...r, ok: true, state, text: String(r?.note || "") } };
  } catch (e) {
    return { status: 400, body: { error: String(e?.message || e) } };
  }
}
