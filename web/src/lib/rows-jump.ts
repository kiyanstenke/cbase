// The jump "row in chat" (timeline per project): a click on the finding of a timeline event opens ITS chat and scrolls the history to the
// row (message id of the log, the same `row` as in `cbase_chat_analysis`).
//
// The flow: `openChatRow` stores the request and opens the chat via `cbase-open-chat`, the SAME way as the bell, channel bar and the agent
// jump (ChatPane opens via `openTarget`, the page switches the tab to "Chats"). The stage (components/chat/chatRowsJump.ts, called in
// ChatStage) waits until the chat is open and loaded and scrolls to the bubble that carries the row: every bubble built from the log
// knows its FIRST log row (lib/bubbles-key.ts `rowOfTheBubble`, in the DOM as `data-row` on the `Contained` wrapper); the row lies in the last
// bubble whose first row does not lie behind it (`targetIndex`); a tool call sits in the reply that carries it. A subagent call has no
// place in the history (it appears in the "Background Tasks" bar); the agent jump (lib/agent-jump.ts) leads there, not this one.
//
// A leaf without imports.

export const ROWS_JUMP_EVENT = "cbase-open-row";
/** How long a request waits for its chat; if it does not open (deleted, another workspace), it expires silently. */
export const ROWS_JUMP_VALID_MS = 30_000;

export type RowsWish = { chatId: string; row: number; at: number };

let wish: RowsWish | null = null;

/** Opens the chat and scrolls to the row. */
export function openChatRow(chatId: string, row: number, now = Date.now()): void {
  if (!chatId || !Number.isFinite(row)) return;
  wish = { chatId, row, at: now };
  window.dispatchEvent(new CustomEvent("cbase-open-chat", { detail: chatId }));
  window.dispatchEvent(new CustomEvent(ROWS_JUMP_EVENT));
}

/** The waiting request for this chat (without picking it up); an expired one is discarded. */
export function rowsWish(chatId: string | null, now = Date.now()): RowsWish | null {
  if (!wish) return null;
  if (now - wish.at > ROWS_JUMP_VALID_MS) { wish = null; return null; }
  return chatId && wish.chatId === chatId ? wish : null;
}

/** The request is served. */
export function rowsWishDone(w: RowsWish): void {
  if (wish === w) wish = null;
}

/**
 * The index of the bubble that carries the row: the last one with a known first row ≤ `row`. Bubbles created live (`undefined`) do not
 * count. None fits ⇒ -1.
 */
export function targetIndex(firstRows: ReadonlyArray<number | undefined>, row: number): number {
  let target = -1;
  for (let i = 0; i < firstRows.length; i++) {
    const z = firstRows[i];
    if (z !== undefined && z <= row) target = i;
  }
  return target;
}
