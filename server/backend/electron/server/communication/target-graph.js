// Target `graph:<startId>` of cbase_agent_send — the node agent of a graph workflow in the background. Here only WHO may
// write, and the shape of the response; resolution and delivery (running node turn or the run's noted-messages store) are
// workflow logic (workflows/graph-message.js).
//
// Who may: the main agent of the parent chat (role in WRITES_CHANNEL, without ofProfile, without workflow marker).
// Subagents, workflow agents and special chats ⇒ 403. The human never arrives here: send.js refuses `from: "human"` to
// every target except subagent and `wf:` with 400. No return channel to the sender: what the node agent makes of it is in
// its result; it can reply through a channel.
//
// `graph:<startId>:<agentId|label>`: a LIVING subagent of the child chat while the run is open — resolved in the child chat
// (runs/agents.js resolveAgent, without "own children only": the sender is not their parent agent; ambiguous 400 with
// candidates), delivered through its core in the same framed form as for the node agent. An address of its own instead of
// an alias of one's own subagents: a name would otherwise match two kinds. The summary (graphRunsSummary) names it per
// subagent. The start id (`gs-<uuid>`) carries no colon — the first one separates.

import { T } from "../i18n.js";
import { WRITES_CHANNEL as WRITES_GRAPH } from "./sender.js";
import { graphResponseText, graphTarget, messageToChildSubagent, messageFromParent } from "../workflows/graph-message.js";
import { resolveAgent, agentsOf } from "../runs/agents.js";
import { subagentHelper, FOREIGN_INSTANCE } from "./target-subagent.js";

const denied = (status, text, extra = {}) => ({ status, body: { ok: false, state: "denied", error: text, text, ...extra } });

/** `graph:<startId>[:<agent>]` → `{ startId, agent }` (agent empty ⇒ the node agent). */
export function graphAddress(startIdRaw) {
  const raw = String(startIdRaw || "").trim();
  const i = raw.indexOf(":");
  return i < 0 ? { startId: raw, agent: "" } : { startId: raw.slice(0, i).trim(), agent: raw.slice(i + 1).trim() };
}

// A subagent of the child chat of an open run.
async function sendToChildSubagent({ chat, target, named, message, fence }) {
  const childId = target.child.id;
  let hits = null;
  try { hits = resolveAgent(childId, named, fence ? { onlyInstance: fence.identifier ?? null } : {}); }
  catch (e) { return denied(Number(e?.status) || 400, String(e?.message || e), e?.candidates ? { candidates: e.candidates.map((a) => `graph:${target.row.id}:${a}`) } : {}); }
  const ctl = hits ? hits.core || agentsOf(childId) : null;
  if (!hits || !ctl?.alive?.(hits.agentId)) {
    return denied(404, T`No living subagent "${named}" in the graph workflow "${target.row.workflowName}" — the addresses are in the overview of cbase_agents_list.`);
  }
  if (subagentHelper(childId, fence).agentInForeignInstance(ctl, hits.agentId)) return denied(403, FOREIGN_INSTANCE);
  try {
    const r = await ctl.send({ agentId: hits.agentId, message: messageToChildSubagent(chat, message) }, { overruled: false });
    const state = r?.afterEnd ? "after_turn" : "delivered";
    return { status: 200, body: { ...r, ok: true, state, text: String(r?.note || graphResponseText(state)), address: `graph:${target.row.id}:${hits.agentId}`, startId: target.row.id } };
  } catch (e) {
    return denied(400, String(e?.message || e));
  }
}

/** `chat` = the sender (parent chat), `address` = `{kind:"graph", startId}`, `role` from sender.js, `fence` = ctx.fence. → `{ status, body }`. */
export async function sendToGraph({ chat, address, text, role, fence = null }) {
  if (!WRITES_GRAPH.has(role)) {
    return denied(403, T("rejected: only the main agent of the chat that started it writes to the node agent of a graph workflow."));
  }
  const message = String(text ?? "").trim();
  if (!message) return denied(400, T("message missing"));
  const { startId, agent } = graphAddress(address.startId);
  const target = graphTarget(chat.id, startId);
  if (target.error) return target.error;
  if (agent) return sendToChildSubagent({ chat, target, named: agent, message, fence });
  const state = messageFromParent(chat, target, message);
  return { status: 200, body: { ok: true, state, text: graphResponseText(state), address: `graph:${target.row.id}`, startId: target.row.id } };
}
