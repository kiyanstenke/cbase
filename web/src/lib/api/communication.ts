// Agent communication: the HUMAN writes to a live agent — a subagent (address = its agentId) or a
// workflow agent (run address `wf:<runId>:<n>`, valid also while it is still waiting). Same path as the
// main agent (`cbase_agent_send`), sender "human", without a running turn. Leaf module of the facade:
// imports nothing outside lib/api/ (README there).

import { api } from "./core.js";

/** What the server says about the delivery (communication/send.js `STATES`). The UI shows `text`, not the word. */
export type MessageState = "delivered" | "after_turn" | "earmarked" | "approval" | "paused" | "denied";

export type MessageResponse = { ok: boolean; state: MessageState | string; text: string };

/** The body of `POST /api/chats/:id/agent/send` — `from` is required (a missing field is no statement). */
export type MessageBody = { to: string; message: string; from: "human" };

/** The run address of a workflow agent: agent n of run runId — the same form as `dynwf:<runId>:<n>` on the call. */
export function workflowAgentAddress(runId: string, n: number): string {
  return `wf:${runId}:${n}`;
}

/** Sends the message to the agent `to`. Never throws: a rejection (status ≠ 2xx with `{ok:false, state:"denied",
 *  text}`) and a network error come back as `ok: false` with the sentence the UI shows. */
export async function messageToAgent(chatId: string, to: string, message: string): Promise<MessageResponse> {
  const body: MessageBody = { to, message, from: "human" };
  try {
    const a = await api<Partial<MessageResponse>>(`/api/chats/${encodeURIComponent(chatId)}/agent/send`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    return { ok: a?.ok !== false, state: String(a?.state ?? ""), text: String(a?.text ?? "") };
  } catch (e) {
    // `api()` attaches the fields of the error body to the error (core.ts) — `text` is the server's sentence.
    const f = e as Error & Partial<MessageResponse>;
    return { ok: false, state: "denied", text: String(f?.text || f?.message || e) };
  }
}
