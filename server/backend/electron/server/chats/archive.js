// The ONE archive path of a chat: the route `PUT /api/chats/:id/archive` (./routes.js archiveChatRoutes) and the tick of the
// auto-archive (./auto-archive.js) call the SAME function — check open work, write, end the shells of the chat rail, send
// the `chat_archive` event. A second path beside it would be the one that misses the next reason for open work.
//
// SYNCHRONOUS, no await: there is no gap between `openWork` and the write in which a run could start. The genus questions
// (archivable, child chat) are the caller's — the route answers them with 400 in its own wording, the cycle never admits
// such chats.
//
// Shells of the chat rail: archiving by hand ends them (the pre-check `GET …/archive` counts them first, `terminals`, and
// the person sees the number in the confirmation). The AUTOMATIC path asks nobody: there an open terminal is open work
// (reason "terminal", counted with the same function as the pre-check, `countTerminalsByTag`) and the chat stays until the
// next tick. Otherwise the tick would silently end a shell in which someone left a service running.

import * as store from "../store.js";
import { T } from "../i18n.js";
import { countTerminalsByTag, killTerminalsByTag } from "../terminal.js";
import { closeChatBrowser } from "../devtools/user-browser.js";
import { reportArchive, openWork } from "../runs/archive.js";
import { dismissAsk } from "../runs/ask.js";


/**
 * Archive an active chat. `reason`: "user" (the route) or "auto" (the cycle) — it ends up in `chats.archive_reason` and in
 * the event. `dismissQuestion` (route ONLY): if the open ask is the ONLY reason, it is dismissed (`dismissAsk` — empty
 * answer, `ask_resolved`, no run) and the chat archived in the same step; any further reason holds as without the field.
 * The cycle never passes it: an ask is NEVER dismissed automatically.
 *
 * With `reason: "auto"` an open terminal of the chat rail counts as open work (reason "terminal") — the route ends it.
 *
 * Returns, always with `open` (list of `{ reason, text }`):
 *   { archived: true,  open: [], terminalsEnded } — archived, event sent;
 *   { archived: false, open: [ … ] }              — open work, nothing changed;
 *   { archived: false, open: [] }                 — unknown or already archived, nothing changed, no event.
 */
export function chatArchive(chatId, { reason = "user", dismissQuestion = false } = {}) {
  const now = store.getChat(chatId); // fresh — a passed-in object could carry a stale state
  if (!now || now.archivedAt) return { archived: false, open: [] };
  const open = openWork(chatId);
  if (reason === "auto") {
    const shells = countTerminalsByTag(`chat:${chatId}`);
    if (shells) {
      open.push({ reason: "terminal", text: shells === 1
        ? T("A terminal of this chat is open")
        : T`${shells} terminals of this chat are open` });
    }
  }
  if (open.length) {
    const onlyQuestion = open.length === 1 && open[0].reason === "question";
    if (!(dismissQuestion === true && onlyQuestion)) return { archived: false, open };
    dismissAsk(chatId, "archive");
  }
  if (!store.archiveChat(chatId, Date.now(), reason)) return { archived: false, open: [] };
  const terminalsEnded = killTerminalsByTag(`chat:${chatId}`); // the shells of the chat rail (none on the auto path)
  void closeChatBrowser(chatId); // the chat's browser (profile and tabs stay — restoring reopens it as before)
  // `kind` as genus (folder value) — the clients sort the event by it.
  reportArchive({ workspaceId: now.workspaceId, kind: "normal", chatIds: [chatId], folderIds: [], archived: true, reason });
  return { archived: true, open: [], terminalsEnded };
}
