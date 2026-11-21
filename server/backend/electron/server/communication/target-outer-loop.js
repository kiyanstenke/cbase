// Sending from an outer-loop run (outer-loop messages are one-way). An outer-loop agent writes freely — as ITSELF, never
// under the name of the observed chat —, only to chats, without a channel and without a reply path: it has no turn a reply
// could wake.
//
// Called by send.js as soon as the sender's role is "outer_loop" (the marker `<agentId>:<runId>` is set by the run's MCP
// server AFTER the model's arguments, mcp/tools/agents.js) — BEFORE every other address kind; everything except `chat:` is
// already 403 there. The sender in the path is the OBSERVED chat (the MCP server runs with CBASE_CHAT_ID = observed chat).
//
//   Marker    the run IS RUNNING, belongs to the agent named, sits on the chat in the path, and `cbase_agent_send` is
//             selected (in the agent's selection AND in the run's set — an approval mark takes it out of the set) —
//             otherwise 403. A boundary against misconfiguration, none against an agent with Bash.
//   Target    every chat the observed chat may read (visibility.js readableReason), plus the observed one itself; otherwise
//             403 (404 without a chat); archived ⇒ 409; an open question card in the target ⇒ 409 (a held card would have
//             no channel to carry it — one-way without a buffer). No `files` (400).
//   Delivery  buildMessage({ from: <agent's name>, kind: "outer_loop", address: "outerloop:<agentId>" }) through
//             deliverUserPrompt with cause "message" and WITHOUT `toolLimit` — after the target's running turn; the UIs put
//             "Outer Loop" before the name (web/src/lib/agents-message.ts). No channel, no item. Response `{ ok, state, text }`.
// The self-wake lock lies with the trigger "after every run end" (outerloop/trigger.js): the turn this card triggers in the
// observed chat wakes no outer loop.

import * as store from "../store.js";
import { T } from "../i18n.js";
import { deliverUserPrompt } from "../runs/queue.js";
import { openAskOf } from "../runs/ask.js";
import { buildMessage } from "../runs/message-marker.js";
import { readableReason } from "./visibility.js";

const denied = (status, text) => ({ status, body: { ok: false, state: "denied", error: text, text } });
const SEND = "cbase_agent_send";

/** Check the marker against the run. → `{ agent, run }` or `{ error }` (403). */
export function checkSendMarker(chat, marker) {
  const s = String(marker ?? "").trim();
  const i = s.indexOf(":");
  const no = { error: denied(403, T("rejected: no running outer-loop run on this chat — sending only works within its own run.")) };
  if (i <= 0 || i === s.length - 1) return no;
  const agentId = s.slice(0, i);
  const run = store.outerLoopRun(s.slice(i + 1));
  if (!run || run.state !== "running" || run.agentId !== agentId || run.chatId !== chat.id) return no;
  const agent = store.outerLoopAgent(agentId);
  if (!agent) return no;
  const inSet = Array.isArray(run.set?.cbase) ? run.set.cbase.includes(SEND) : false;
  if (!(agent.tools || []).includes(SEND) || !inSet) {
    return { error: denied(403, T("rejected: this outer-loop agent does not write to chats — cbase_agent_send is not selected (or carries an approval mark).")) };
  }
  return { agent, run };
}

/**
 * @param {{ chat: object, marker: string, chatId: string, text: string, files?: any }} o  `chat` = the observed chat (path)
 * @returns {{ status: number, body: object }}
 */
export function sendAsOuterLoop({ chat, marker, chatId, text, files }) {
  const m = checkSendMarker(chat, marker);
  if (m.error) return m.error;
  if (files !== undefined && files !== null && !(Array.isArray(files) && !files.length)) {
    return denied(400, T("rejected: an outer-loop agent attaches no files"));
  }
  const content = String(text ?? "").trim();
  if (!content) return denied(400, T("message missing"));
  const target = chatId ? store.getChat(String(chatId)) : null;
  if (!target) return denied(404, T("rejected: chat not found"));
  if (target.id !== chat.id) {
    const reason = readableReason(chat, target);
    if (reason) return denied(403, `${T("rejected")}: ${reason}`);
  }
  if (target.archivedAt) return denied(409, T("rejected: the chat is archived — no agent brings it back"));
  if (openAskOf(target.id)) {
    return denied(409, T("rejected: the chat is waiting for a human's answer to a question — an outer-loop message has no way to be held"));
  }
  const prompt = buildMessage({ from: m.agent.name, kind: "outer_loop", address: `outerloop:${m.agent.id}`, text: content });
  const r = deliverUserPrompt(target, { prompt, display: prompt, cause: "message" });
  if (!r?.ok) {
    if (r?.archived || r?.onlyReadable) return denied(409, String(r.error || T("rejected: the chat accepts nothing")));
    return denied(400, String(r?.error || T("rejected: not delivered")));
  }
  const state = r.queued ? "after_turn" : "delivered";
  return {
    status: 200,
    body: {
      ok: true, state,
      text: state === "after_turn"
        ? T("delivered after its current turn — no reply comes back")
        : T("delivered — no reply comes back"),
    },
  };
}
