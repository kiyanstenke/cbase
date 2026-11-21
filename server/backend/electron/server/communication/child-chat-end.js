// A message to the child chat of an ENDED graph run in the background is refused — 409 "The workflow "…" is no longer
// running.", nothing is delivered, the cursor stays, and no turn of its own begins in the former child chat (never a turn
// outside the driver; its worktree may already be cleared). The question and its sentence live ONLY here;
// workflows/graph-message.js (graphTarget, the follow-up run) imports them:
//
//   childChatEnd(chatId)                      the background row whose child chat this is and whose run is NO LONGER open — otherwise null
//   channelOfEndedChildChat(channelId, from)  the row of the first OTHER participant that is such a child chat — otherwise null
//   runningNotMore(name)                     the refusal's sentence — ONE version, also for graphTarget and the follow-up run
//
// Who asks: channels/delivery.js deliverChannel (holds BEFORE the node path: no card, no cursor, no turn),
// channels/messages.js sendToChannel (throws for a chat sender ⇒ 409 on both send routes) and
// communication/target-channel.js sendToChannelTarget (refuses before files are loaded). Open means the same as everywhere:
// store.graphRunsOpenOf (waiting, or started with an open run).
//
// Leaf: data layer and language only.

import * as store from "../store.js";
import { T } from "../i18n.js";

/** The background row whose child chat is `chatId`, if its run has ended — otherwise `null` (no child chat, run open). */
export function childChatEnd(chatId) {
  if (!chatId) return null;
  const z = store.graphStartOfChild(chatId);
  if (!z || !z.background || !z.childChatId) return null;
  return store.graphRunsOpenOf(z.chatId).some((o) => o.id === z.id) ? null : z;
}

/** The first participant of the channel other than `exceptChatId` that is the child chat of an ended run → its row, otherwise `null`. */
export function channelOfEndedChildChat(channelId, exceptChatId = null) {
  for (const t of store.listChannelParticipants(channelId)) {
    if (!t.chatId || t.chatId === exceptChatId) continue;
    const z = childChatEnd(t.chatId);
    if (z) return z;
  }
  return null;
}

/** The refusal's sentence — for `graph:` (graphTarget) and for channel paths. */
export const runningNotMore = (name) => T`The workflow "${name}" is no longer running.`;
