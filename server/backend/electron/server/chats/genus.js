// The genus of a chat: only the coding chat (`kind = 'normal'`) is left — and what hangs on it: archivable, placeable in
// a folder, forkable. Manager conversations (`kind = 'manager'`) are read-only (runs/manager-lock.js) and belong to no
// genus. A leaf module with two readers: `chats/routes.js` (archive, folders, PATCH folderId) and `runs/routes.js`
// (`/fork`). An import from `chats/routes.js` into `runs/routes.js` would close a cycle (`chats/routes.js` carries
// `runChatRoutes` in its sub-table) — so ONE place for the rule, two readers.

import * as store from "../store.js";
import { T } from "../i18n.js";

// The child chat of a background graph workflow: `kind = 'normal'`, the link lives in `graph_starts.child_chat_id`. It
// follows its orchestrator — not archived on its own, in no folder, not forked.
export const isChildChat = (chat) => Boolean(store.graphStartOfChild(chat.id));

// Archivable are coding chats — never an app agent or a manager conversation, and never a child chat of a background
// run. The same set is that of the chats allowed in a folder and that can be forked.
export const archivable = (chat) => chat.kind === "normal" && !chat.specialRole && !isChildChat(chat);

// The KIND of a non-archivable chat in words: it appears in no list, so the sentence has to say WHAT it is.
export function chatKind(c) {
  if (c.kind === "manager") return T("manager conversation (read-only)");
  return T`app agent (${c.kind || "?"})`;
}

// Why a chat can NOT be forked — `null` if it can. A fork takes over the genus of its original and stays in its folder;
// that only works for coding chats. Otherwise an app agent with history and CLI session would become a new coding chat,
// and a child chat a loose chat in the list, past its orchestrator.
export function forkRefusal(chat) {
  if (isChildChat(chat)) {
    return T("A background run is not forked — fork the chat that started it.");
  }
  if (!archivable(chat)) {
    return T`Cannot be forked: ${chatKind(chat)} — only coding chats can be forked.`;
  }
  return null;
}
