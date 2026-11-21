// Target `chat:<id>` of cbase_agent_send.
//
// Write permission "free" (the main agent of a coding chat, also the node agent of a graph child chat) by the channel table —
// the MOST RECENT channel of exactly these two chats is looked for, in whatever state:
//   no channel             silently a channel (open, cap 0 = no cap, creator = sender), NO inbox item — only to a coding chat
//   open / paused /        like `channel:<id>` (target-channel.js): delivered or after its turn · "paused — will be delivered
//   closed/rejected        after the channel resumes" · refused WITHOUT a new channel (only the human reopens, in the channel bar)
//   waiting                stored until approval (target-channel.js)
//
// A target the sender may not read (communication/visibility.js — foreign workspace, child chat, special chat) is 403; an
// archived chat 409 (no agent brings a chat back from the archive). All other roles get 403 — and NO item and NO channel
// is created.

import * as store from "../store.js";
import { T } from "../i18n.js";
import { channelCreate } from "../channels/lifecycle.js";
import { resolveChannelFiles } from "../channels/messages.js";
import { writePermissionToChats } from "./sender.js";
import { commonChannels, readableReason } from "./visibility.js";
import { sendToChannelTarget } from "./target-channel.js";

const denied = (status, text) => ({ status, body: { ok: false, state: "denied", error: text, text } });

/** `from` is the sender's chat row, `role` its role (sender.js). → `{ status, body }`. */
export async function sendToChat({ from, role, chatId, text, files, fence = null }) {
  const permission = writePermissionToChats(role);
  if (permission === "no") {
    return denied(403, T("rejected: this run does not write to other chats — cbase_agent_send only reaches your own subagents."));
  }
  const target = chatId ? store.getChat(String(chatId)) : null;
  if (!target) return denied(404, T("rejected: chat not found"));
  if (target.id === from.id) return denied(400, T("rejected: that is your own chat"));
  const reason = readableReason(from, target);
  if (reason) return denied(403, `${T("rejected")}: ${reason}`);
  if (target.archivedAt) return denied(409, T("rejected: the chat is archived — no agent brings it back"));
  const channels = commonChannels(from.id, target.id);
  return sendFree({ from, target, channel: channels[0] || null, text, files, fence });
}

// Write permission "free" (coding main agent): the most recent channel decides — if there is none, one is created silently.
async function sendFree({ from, target, channel, text, files, fence }) {
  if (channel) return sendToChannelTarget({ from, channelId: channel.id, text, files, fence });
  // Only to a coding chat (readableReason lets only those through); the check stays in case the predicate ever widens.
  if (target.kind !== "normal") return denied(403, T("rejected: a new channel only goes to a coding chat."));
  const ws = store.getWorkspace(from.workspaceId);
  if (!ws) return denied(404, T("rejected: workspace not found"));
  // Check the first message's files BEFORE creating: a refusal leaves no empty channel that would count as "most recent" on
  // the next attempt. Reloading and depositing happen only in sendToChannelTarget.
  try { resolveChannelFiles(from, files, { origin: fence?.identifier || null }); }
  catch (e) { return denied(400, String(e?.message || e)); }
  let fresh;
  try { fresh = channelCreate(ws, { participants: [from.id, target.id], status: "open", creatorChatId: from.id, cap: 0 }); }
  catch (e) { return denied(400, String(e?.message || e)); }
  return sendToChannelTarget({ from, channelId: fresh.id, text, files, fence });
}
