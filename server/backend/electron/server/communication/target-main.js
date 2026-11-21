// The address "main": a subagent or workflow agent of a CODING chat writes to the main agent of its chat — the way to a
// coding MCP server it does not inherit ("only the main agent has server Y — write to it with cbase_agent_send to
// "main""). For every other sender "main" is what it was before: a subagent id or a label (address.js; send.js checks the
// role).
//
// Delivery through the ONE place (runs/queue.js deliverUserPrompt, cause "message", `toolLimit: true`) in the form of the
// agent message (runs/message-marker.js buildMessage, kind "agent", `address` = agentId or `wf:<runId>:<n>`). Effect per
// provider: Claude sees the request at the next tool boundary, Codex and the loop engine only after the running turn (they
// queue until the `result`); a resting chat is woken. No cap.

import { T } from "../i18n.js";
import { deliverUserPrompt } from "../runs/queue.js";
import { buildMessage } from "../runs/message-marker.js";
import { resolveAgent } from "../runs/agents.js";
import { workflowAliasHits } from "../dynworkflows/message.js";

export const MAIN = "main";
const denied = (status, text) => ({ status, body: { ok: false, state: "denied", error: text, text } });

// Who writes: name and return address of the sender — a subagent with its agentId, a workflow agent with its run address.
function sender(chat, { role, agentId }) {
  if (role === "workflow") {
    const t = workflowAliasHits(chat.id, agentId);
    if (t.length === 1) return { from: t[0].label || t[0].address, address: t[0].address };
    return { from: `workflow-agent ${agentId}`, address: agentId };
  }
  let name = "";
  try {
    const r = resolveAgent(chat.id, agentId, {});
    const rec = r?.core?.get?.(r.agentId);
    name = String(rec?.name || rec?.description || "").trim();
  } catch { /* ambiguous/unknown: the id suffices */ }
  return { from: name || `Subagent ${agentId}`, address: agentId };
}

/** A subagent (`role` "subagent") or workflow agent ("workflow") of a coding chat to its main agent. → `{ status, body }`. */
export function sendToMain({ chat, role, agentId, text }) {
  if (!text) return denied(400, T("message missing"));
  const { from, address } = sender(chat, { role, agentId: String(agentId || "") });
  const block = buildMessage({ from, kind: "agent", address, text });
  const r = deliverUserPrompt(chat, { prompt: block, display: block, cause: "message", toolLimit: true });
  if (r?.archived || r?.onlyReadable) return denied(409, String(r.error || T("The chat no longer accepts anything.")));
  if (!r?.ok) return denied(409, String(r?.error || T("not delivered")));
  if (r.injected || !r.queued) {
    return { status: 200, body: { ok: true, state: "delivered", text: T("Delivered — the main agent reads it in its running or now started turn.") } };
  }
  if (r.parked) {
    return { status: 200, body: { ok: true, state: "parked", text: T("The chat is waiting (limit/credit) — the message goes with its next turn.") } };
  }
  return { status: 200, body: { ok: true, state: "after_turn", text: T("Queued — the main agent reads it after its running turn.") } };
}
