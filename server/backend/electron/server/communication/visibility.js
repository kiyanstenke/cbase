// What a chat may read of other chats — the ONE visibility predicate for list, reading, channel and summary; search and
// notes use the same (communication/read.js chatsView with `search`). Two versions of the same rule (one in the list, one
// on reading) would be the familiar error: the list shows what reading then refuses, or the other way round.
//
// A chat is readable for a reader if
//   · both lie in the same workspace, and
//   · it is a coding chat (kind normal, without a special role) and NOT a child chat of a graph workflow (that appears only
//     under its run, chats/genus.js isChildChat).
// Everything else — manager chats, app-agent chats — is not readable.
// From a project network the fence applies in addition (routes.js/read.js through ctx.fence) — it is no matter of this predicate.

import * as store from "../store.js";
import { T } from "../i18n.js";
import { isChildChat } from "../chats/genus.js";

/** All channels two chats share (in whatever state), the most recent first. */
export function commonChannels(aId, bId) {
  if (!aId || !bId) return [];
  const channels = store.listChannelsOfChat(aId).filter((k) => store.getChannelParticipants(k.id, bId));
  channels.sort((x, y) => (Number(y.createdAt) || 0) - (Number(x.createdAt) || 0));
  return channels;
}

/** Do two chats share a channel (in whatever state)? → the most recent, otherwise null. */
export const commonChannel = (aId, bId) => commonChannels(aId, bId)[0] || null;

/** → `null` (readable) or the reason why not. `target` is a chat row (or null). */
export function readableReason(reader, target) {
  if (!reader || !target) return T("Chat not found");
  if (target.workspaceId !== reader.workspaceId) return T("This chat belongs to another workspace.");
  if (target.kind === "normal" && !target.specialRole) {
    return isChildChat(target)
      ? T("A graph workflow's child chat is only readable through its run.")
      : null;
  }
  return T("Not a readable chat (no coding chat).");
}

/** The predicate as a boolean. */
export const readable = (reader, target) => readableReason(reader, target) === null;
