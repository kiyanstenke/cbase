// Frozen channels: the kind manager is read-only, so a channel with a participant of kind manager accepts no message,
// delivers nothing, changes no status and writes no system note — not even when its coding participant is deleted. Without
// a manager there is no second side, and every delivery would start a coding turn out of a dead channel.
//
// Asked through the participant ROWS and the chat (runs/manager-lock.js).
// Readers: channels/delivery.js (deliver, restart grace, follow-up delivery, status, note, deletion cascade, human
// involvement), channels/messages.js (send), channels/routes.js (every writing channel route), channels/lifecycle.js (create).
// Guard: server/backend/test/manager-lock.test.js.

import * as store from "../store.js";
import { managerLocked, managerLockText } from "../runs/manager-lock.js";

/** Does the channel have a participant of kind manager? An unknown channel does not. */
export function channelFrozen(channelId) {
  if (!channelId) return false;
  return store.listChannelParticipants(channelId).some((t) => managerLocked(store.getChat(t.chatId)));
}

/** The error of a path that touches a frozen channel — `status: 409` for the routes. */
export function channelFrozenError() {
  const e = new Error(managerLockText());
  e.status = 409;
  e.managerLocked = true;
  return e;
}
