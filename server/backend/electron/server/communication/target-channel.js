// Target `channel:<id>` of cbase_agent_send: every participant writes into its channel, including files
// (channels/messages.js resolveChannelFiles/reloadChannelFiles, caps on bytes and number). The sender is the chat in the path.
//
//   open              deliver                                 "delivered" or "after its turn"
//   waiting           stored                                  "awaiting approval"
//   paused            stored, delivered after resuming        "paused — will be delivered after the channel resumes"
//   closed/rejected   refused, NO new channel                 "rejected: channel closed"
// An archived participant ⇒ 409. The child chat of an ENDED graph run ⇒ 409 "The workflow "…" is no longer running."
// (child-chat-end.js); if the delivery takes the node path of an open run, the response says that path's state
// (workflows/graph-message.js graphResponseText). If an open question card on the other side holds the delivery, the
// response says "noted" (channels/delivery.js deliverChannel).
// If the message reaches the channel's cap, the channel pauses (channels/messages.js sendToChannel) — the response then says "paused".

import * as store from "../store.js";
import { T } from "../i18n.js";
import { resolveChannelFiles, reloadChannelFiles, sendToChannel } from "../channels/messages.js";
import { running } from "../runs/state.js";
import { openAskOf } from "../runs/ask.js";

import { channelOfEndedChildChat, runningNotMore } from "./child-chat-end.js";
import { graphResponseText } from "../workflows/graph-message.js";

const denied = (status, text) => ({ status, body: { ok: false, state: "denied", error: text, text } });

/** The state after storing, from the sender's point of view. */
export function stateAfterSend(channel, senderId) {
  if (channel.status === "paused") return { state: "paused", text: T("paused — will be delivered after the channel resumes") };
  if (channel.status === "waiting") return { state: "approval", text: T("awaiting approval — delivered once a human approves the channel") };
  const other = store.listChannelParticipants(channel.id).filter((t) => t.chatId !== senderId);
  // An open question card on the other side holds the delivery like a gate (channels/delivery.js deliverChannel) — it comes
  // as soon as the human has answered.
  if (other.some((t) => openAskOf(t.chatId))) {
    return { state: "earmarked", text: T("noted — the other side is waiting for a human's answer to a question; delivered afterwards") };
  }
  if (other.some((t) => running.has(t.chatId))) {
    return { state: "after_turn", text: T("will be delivered after its current turn — the other side reads it as a turn of its own") };
  }
  return { state: "delivered", text: T("delivered — the other side reads it as a turn of its own") };
}

/**
 * `from` is the sender's chat row, `fence` the fence context of the request (it resolves a copy's files through the token's
 * identifier, like POST /api/channels/:id/messages). → `{ status, body }`.
 */
export async function sendToChannelTarget({ from, channelId, text, files, fence = null }) {
  const channel = channelId ? store.getChannel(String(channelId)) : null;
  if (!channel) return denied(404, T("rejected: channel not found"));
  if (!store.getChannelParticipants(channel.id, from.id)) return denied(403, T("rejected: this chat is not a participant of the channel"));
  if (channel.status === "closed" || channel.status === "rejected") {
    return denied(409, T`rejected: channel ${channel.status} — only a human can reopen it in the channel sidebar`);
  }
  // No agent writes to an archived chat — it is readable, but no agent brings it back.
  const archived = store.listChannelParticipants(channel.id).map((t) => (t.chatId !== from.id ? store.getChat(t.chatId) : null)).find((c) => c?.archivedAt);
  if (archived) {
    return denied(409, T`rejected: "${archived.title || archived.id}" is archived — no agent brings a chat back from the archive`);
  }
  const ended = channelOfEndedChildChat(channel.id, from.id);
  if (ended) return denied(409, runningNotMore(ended.workflowName));
  let resolved;
  try { resolved = resolveChannelFiles(from, files, { origin: fence?.identifier || null }); await reloadChannelFiles(resolved); }
  catch (e) { return denied(400, String(e?.message || e)); }
  let message;
  try { message = sendToChannel(channel, { ofChatId: from.id, text, files: resolved }); }
  catch (e) { return denied(409, String(e?.message || e)); }
  const after = store.getChannel(channel.id);
  // The node path of a child chat reports its state itself (channels/messages.js sendToChannel `deliveries`) — the source is
  // the result of the delivery, not a second computation.
  const graphWay = message.deliveries?.find((z) => z.graph);
  const state = graphWay ? { state: graphWay.graph, text: graphResponseText(graphWay.graph) } : stateAfterSend(after, from.id);
  return {
    status: 200,
    body: {
      ok: true, ...state, channelId: channel.id, seq: message.seq, at: message.createdAt,
      ...(message.files?.length ? { files: message.files.map((d) => ({ name: d.name, size: d.size, origin: d.origin })) } : {}),
    },
  };
}
