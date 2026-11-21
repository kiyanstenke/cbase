// The location of a chat in the chat list: in which copy it WORKS.
//
// A chat row's short info used to show “Copy k1” for the copy the chat CREATED (`stack_copies.chat_id`), and the event `project/copy`
// wrote the state to the row with `msg.chatId`, i.e. to the creator. Now a copy belongs to no chat: a chat may have created several and
// may work in none of them, and a chat that the “Instances” tab started in a copy showed none at all. The binding lives in
// `chats.instance` (`copy-<name>`, NULL = main):
//
//   - the NAME always comes from `instance` (the server delivers it with GET /api/chats and after every switch via `chat_meta`);
//   - the STATE from `copy` (GET /api/chats, chats/routes.js, likewise computed from `chats.instance`) and only if its name matches
//     `instance`: an older server that still delivers the created copy would otherwise paint a foreign state;
//   - the event `project/copy` applies to every row that works in EXACTLY this copy: same project (`projectId`) and `instance`
//     `copy-<name>`, never via `chatId` (that is the creator, which the list does not show).
//
// A leaf module without imports, so web/test/chat-location.test.mjs compiles and runs it under Node without React.

/** What the short info shows of the copy; `state` empty = unknown (no state word). */
export type ChatCopyLocation = { name: string; state: string };

/** What the computation reads of a chat row. */
export type ChatLocationRow = {
  id: string;
  projectId?: string | null;
  instance?: string | null;
  copy?: { name: string; state: string } | null;
};

/** The name of the copy from `chats.instance`: “copy-k1” → “k1”; main, empty and anything else → "". */
export function copyNameFromInstance(instance: string | null | undefined): string {
  const w = typeof instance === "string" ? instance.trim() : "";
  return w.startsWith("copy-") && w.length > "copy-".length ? w.slice("copy-".length) : "";
}

/** The copy the chat works in; null in main. The state only from a `copy` field with the SAME name. */
export function chatCopyLocation(c: ChatLocationRow | null | undefined): ChatCopyLocation | null {
  const name = copyNameFromInstance(c?.instance);
  if (!c || !name) return null;
  const k = c.copy;
  const state = k && k.name === name && typeof k.state === "string" ? k.state : "";
  return { name, state };
}

/** The fields of the event `project/copy` that the list reads (stacks/state.js `report`). */
export type CopyEvent = { projectId?: unknown; name?: unknown; state?: unknown };

/**
 * `project/copy` applied to the chat list: every row that works in this copy gets its state (`removed` stays as a word, as GET
 * /api/chats reports a binding without a live row; the extract itself comes from `chat_meta`). The same list back if nothing changes
 * (React then does not re-render).
 */
export function applyCopyEvent<C extends ChatLocationRow>(chats: C[], msg: CopyEvent): C[] {
  const projectId = typeof msg.projectId === "string" ? msg.projectId : "";
  const name = typeof msg.name === "string" ? msg.name : "";
  const state = typeof msg.state === "string" ? msg.state : "";
  if (!projectId || !name || !state) return chats;
  const hits = (c: C) => c.projectId === projectId && copyNameFromInstance(c.instance) === name;
  const different = (c: C) => hits(c) && (c.copy?.name !== name || c.copy?.state !== state);
  if (!chats.some(different)) return chats;
  return chats.map((c) => (different(c) ? { ...c, copy: { name, state } } : c));
}
