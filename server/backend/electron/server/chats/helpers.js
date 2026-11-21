// Chat helpers without a run: artifactSiblings, folderContextChanged, artifactSource.

import * as store from "../store.js";
import { sse } from "../runtime/sse.js";


// Chats a chat shares its artifacts with: all OTHER chats of the same chat folder. Without a folder there are no
// siblings — and sharing ends the moment one of the two leaves the folder (nothing is copied, only read along).
// Sharing is deliberately READ-ONLY: writing and deleting always happen in the own chat, otherwise an agent could
// overwrite the files of another chat.
function artifactSiblings(chat) {
  if (!chat?.folderId) return [];
  return store.listChatsInFolder(chat.folderId).filter((c) => c.id !== chat.id);
}
// Context files of a folder have many viewers: every open chat of the folder shows them (and may read them). A change
// therefore goes to all chats of the folder — the folder view itself hangs on the event stream of its open chat or
// reloads on open.
function folderContextChanged(folderId, payload) {
  for (const c of store.listChatsInFolder(folderId)) {
    sse(c.id, { type: "harness", subtype: "folder_context_changed", folderId, ...payload });
  }
}

// Resolve the source chat of an artifact access: without chatId the own chat, else a sibling chat from the same folder.
// Anything else is off limits.
function artifactSource(chat, wanted) {
  const from = String(wanted || "") || chat.id;
  if (from === chat.id) return { id: from, own: true };
  const sibling = artifactSiblings(chat).find((c) => c.id === from);
  if (!sibling) return null;
  return { id: sibling.id, title: sibling.title, own: false };
}

export { artifactSiblings, artifactSource, folderContextChanged };
