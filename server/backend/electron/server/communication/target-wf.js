// Target `wf:<runId>:<n>` of cbase_agent_send — an agent of a running dynamic workflow of this chat. Here only WHO may write,
// and the shape of the response; resolution, delivery, journal and transcript are workflow logic (dynworkflows/message.js).
//
// Who may: the main agent of the chat (role coding, without ofProfile) and the human (`from: "human"`, without a turn).
// Subagents, workflow agents and special chats (app agents, the read-only manager chats) ⇒ 403. No return channel.

import { T } from "../i18n.js";
import { messageAhead, responseText, messageToAgent, workflowTarget } from "../dynworkflows/message.js";
// Who writes to `wf:` is the same set as for `channel:` — the main agent of a coding chat. ONE list in sender.js.
import { WRITES_CHANNEL as WRITES_WF } from "./sender.js";

/**
 * `address` = `{kind:"wf", runId, n}` (or `{kind:"subagent", id}` for an alias), `from` = "agent" | "human", `role` from
 * sender.js (for `from: "agent"`). → `{ status, body }` with `{ ok, state, text, address }`.
 */
export async function sendToWorkflowAgent({ chat, address, text, from, role }) {
  if (from !== "human" && !WRITES_WF.has(role)) {
    const t = T("rejected: only the main agent of this chat and the human write to the agents of a workflow.");
    return { status: 403, body: { ok: false, state: "denied", error: t, text: t } };
  }
  if (!text) { const t = T("message missing"); return { status: 400, body: { ok: false, state: "denied", error: t, text: t } }; }
  const target = workflowTarget(chat.id, address);
  if (target.error) return target.error;
  if (target.ahead) {
    // An agent the script has not called yet (dynworkflows/message.js messageAhead): noted for its job.
    const r = messageAhead(target.run, target.ahead, text, from);
    const address = target.ahead === "*" ? `wf:${target.run.runId}` : `wf:${target.run.runId}:${target.ahead}`;
    return { status: 200, body: { ok: true, state: r.state, text: r.text, address, runId: target.run.runId } };
  }
  const r = await messageToAgent(target.run, target.n, text, from);
  if (r.error) return r.error;
  return { status: 200, body: { ok: true, state: r.state, text: responseText(r.state), address: `wf:${target.run.runId}:${target.n}`, runId: target.run.runId, n: target.n } };
}
