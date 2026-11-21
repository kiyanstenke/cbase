// cbase_agent_send: ONE path for every message of an agent — POST /api/chats/:id/agent/send (runs/routes.js) delegates here.
// The sender is the chat in the path; the markers (`ofProfile`, `workflowAgent`) are set by the run's MCP server AFTER the
// model's arguments.
//
// Order: originator (`from`, required) → address (address.js) → role of the sender (sender.js) → allowlist per kind → handler.
//   subagent (no prefix)    every run with the tool — its own children or the chat's subagents
//   channel:<id>            a participant whose role is in sender.js WRITES_CHANNEL (main agent of a coding chat);
//                           subagents, workflow agents and special chats 403
//   chat:<id>               by the role's write permission (sender.js): the coding main agent freely, otherwise 403
//   wf:<runId>:<n>          an agent of a running dynamic workflow (target-wf.js): the main agent and the human
//   graph:<startId>         the node agent of a graph workflow in the background of this chat (target-graph.js): the main
//                           agent (role in WRITES_CHANNEL), otherwise 403
// Without a prefix the subagent resolution applies first; agentId and unambiguous label of a WORKFLOW agent are aliases of
// wf: — if a name matches both kinds, that is a 400 with candidates from both. The aliases count only for those who may
// write to wf: (the human, role in WRITES_CHANNEL); a subagent lands at its child. The subagent side of the check resolves
// like the subagent path itself — from a project network only within the token's instance, otherwise the 400 would name
// the agentIds of a foreign instance.
// An outer-loop run (role "outer_loop", marker `outerLoop` from the MCP server): BEFORE every address kind — only `chat:<id>`
// ⇒ target-outer-loop.js (checks the marker against the run), everything else 403; `from: "human"` with a marker 400. An
// address `outerloop:<id>` is a 400 for EVERY sender: an outer-loop agent accepts no messages (one-way).
// The human (`from: "human"`): writes without a running turn to a subagent (resolved like the stop, over all open cores of
// the chat, without "own children only", without approval) or to a workflow agent; never from a project network (403).
// The response is uniformly `{ ok, state, text, … }`, `state` ∈ STATES; the subagent path also keeps the core's fields
// (status, agentId, note …). A refusal is a status ≠ 2xx with `error` = `text` — the MCP server turns it into an error
// result.

import { T } from "../i18n.js";
import { readAddress } from "./address.js";
import { WRITES_CHANNEL, senderOf } from "./sender.js";
import { sendToSubagent, subagentHelper } from "./target-subagent.js";
import { sendToChannelTarget } from "./target-channel.js";
import { sendToChat } from "./target-chat.js";
import { sendToWorkflowAgent } from "./target-wf.js";
import { resolveAgent, agentFromProfile, agentsOf } from "../runs/agents.js";
import { messageText, workflowAliasHits } from "../dynworkflows/message.js";
import { sendToGraph } from "./target-graph.js";
import { sendAsOuterLoop } from "./target-outer-loop.js";
import { MAIN, sendToMain } from "./target-main.js";

export const STATES = Object.freeze(["delivered", "after_turn", "earmarked", "approval", "paused", "parked", "denied"]);

const denied = (status, text, extra = {}) => ({ status, body: { ok: false, state: "denied", error: text, text, ...extra } });

// The human to a subagent: WITHOUT a running turn — resolved like the stop over all open cores of the chat (runs/agents.js
// resolveAgent: a living one before a known one, ambiguous ⇒ 400 with candidates), without "own children only", without
// approval of the gate (`overruled: false`; continuing a finished one asks it like a start). The sender stands before the text.
async function sendToSubagentAsHuman({ chatId, named, body }) {
  const message = String(body.message ?? body.text ?? "").trim();
  if (!message) return denied(400, T("message missing"));
  let target = null;
  try { target = resolveAgent(chatId, named, {}); }
  catch (e) { return denied(Number(e?.status) || 400, String(e?.message || e), e?.candidates ? { candidates: e.candidates } : {}); }
  if (!target) return denied(404, T`No subagent "${named}" in this chat.`);
  const ctl = target.core || agentsOf(chatId);
  if (!ctl) return denied(409, T("No open agent core in this chat — the subagent is gone."));
  try {
    const r = await ctl.send({ ...body, agentId: target.agentId, message: messageText("human", message) }, { overruled: false });
    const state = r?.afterEnd ? "after_turn" : "delivered";
    return { status: 200, body: { ...r, ok: true, state, text: String(r?.note || "") } };
  } catch (e) {
    return denied(400, String(e?.message || e));
  }
}

/** `chat` = the sender (chat row from the path), `body` = the request body, `fence` = `ctx.fence`. → `{ status, body }`. */
export async function sendMessage({ chat, body = {}, fence = null }) {
  const { ofProfile, workflowAgent, outerLoop, from, ...b } = body && typeof body === "object" ? body : {};
  // A missing field is no statement: who writes is said explicitly by the caller — the MCP server sets "agent".
  if (from !== "agent" && from !== "human") return denied(400, T("from required: \"agent\" or \"human\""));
  const marker = typeof outerLoop === "string" ? outerLoop.trim() : "";
  if (from === "human" && marker) return denied(400, T("a human does not write with the mark of an outer-loop run"));
  // A human never comes through the fence — the fence checks the same on the body (projectbox/fence.js agentSendInScope).
  if (from === "human" && fence) return denied(403, T("no human writes from a project network"));
  const to = String(b.to || b.agentId || b.name || "").trim();
  if (!to) return denied(400, T("to required: agentId/label of a subagent, channel:<id> or chat:<id>"));
  const address = readAddress(to);
  if (address.kind === "outerloop") return denied(400, T("rejected: an outer-loop agent accepts no messages"));
  // The workflow marker: the MCP server of a workflow agent sends it along (CBASE_WORKFLOW_AGENT); likewise the outer-loop
  // marker (CBASE_OUTER_LOOP).
  const role = senderOf(chat, { ofProfile, workflowAgent: typeof workflowAgent === "string" ? workflowAgent : "", outerLoop: marker });
  const text = String(b.message ?? b.text ?? "").trim();
  if (role === "outer_loop") {
    if (address.kind !== "chat") {
      return denied(403, T("rejected: an outer-loop agent writes only to chats (to = chat:<id>) — no subagents, channels or workflows."));
    }
    return sendAsOuterLoop({ chat, marker, chatId: address.chatId, text, files: b.files });
  }
  // "main" (target-main.js): ONLY a subagent or workflow agent of a coding chat reaches the main agent of its chat with
  // it — for every other sender it stays a subagent id or a label.
  if (address.kind === "subagent" && address.id === MAIN && from === "agent" && (role === "subagent" || role === "workflow") && senderOf(chat) === "coding") {
    const agentId = role === "workflow" ? String(workflowAgent) : agentFromProfile(chat.id, ofProfile)?.id || "";
    return sendToMain({ chat, role, agentId, text });
  }
  if (address.kind === "subagent") {
    const { to: _to, ...rest } = b;
    const wf = from === "human" || WRITES_CHANNEL.has(role) ? workflowAliasHits(chat.id, address.id) : [];
    if (wf.length) {
      // If the name ALSO matches a subagent (or several), it is ambiguous across both kinds — counted as on the subagent
      // path: from a project network only agents of the token's instance (a hit in a foreign instance does not count).
      const h = subagentHelper(chat.id, fence);
      let sub = [];
      try {
        const z = resolveAgent(chat.id, address.id, h.onlyInstanceOfTheFence());
        if (z && !h.agentInForeignInstance(z.core || agentsOf(chat.id), z.agentId)) sub = [z.agentId];
      } catch (e) { sub = Array.isArray(e?.candidates) ? e.candidates : []; }
      if (sub.length) {
        const candidates = [...sub, ...wf.map((x) => x.address)];
        return denied(400, T`The name "${address.id}" is ambiguous — it matches subagents and workflow agents. Give the agentId or the run address: ${candidates.join(", ")}`, { candidates });
      }
      return sendToWorkflowAgent({ chat, address, text, from, role });
    }
    if (from === "human") return sendToSubagentAsHuman({ chatId: chat.id, named: address.id, body: rest });
    return sendToSubagent({ chatId: chat.id, fence, named: address.id, ofProfile, body: { ...rest, agentId: address.id } });
  }
  if (address.kind === "wf") return sendToWorkflowAgent({ chat, address, text, from, role });
  if (from === "human") {
    return denied(400, T("here the human writes only to agents: a subagent (agentId) or a workflow agent (wf:<runId>:<n>)."));
  }
  if (address.kind === "graph") return sendToGraph({ chat, address, text, role, fence });
  if (!text) return denied(400, T("message missing"));
  if (address.kind === "channel") {
    if (!WRITES_CHANNEL.has(role)) {
      if (role === "subagent") return denied(403, T("rejected: a subagent writes to no channel — the main agent of its chat does."));
      if (role === "workflow") return denied(403, T("rejected: a workflow agent writes to no channel — the main agent of its chat does."));
      return denied(403, T("rejected: this run writes to no channel — cbase_agent_send only reaches your own subagents."));
    }
    return sendToChannelTarget({ from: chat, channelId: address.channelId, text, files: b.files, fence });
  }
  return sendToChat({ from: chat, role, chatId: address.chatId, text, files: b.files, fence });
}
