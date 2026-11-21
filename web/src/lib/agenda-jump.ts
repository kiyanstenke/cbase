// The jump "agenda point in the chat": the detail card of a timeline event names the agenda point it
// refers to; a click opens ITS chat, switches the right bar there to "Agenda" and highlights the point.
//
// Same pattern as lib/rows-jump.ts: `openAgendaPoint` remembers the wish and opens the chat via
// `cbase-open-chat`; the hook components/chat/chatAgendaJump.ts switches the bar once the chat is
// open and loaded; AgendaPanel.tsx picks the point up (`agendaWish`) and scrolls it into view. A
// wish that nobody serves within VALID_MS lapses silently.
//
// Leaf module without imports.

export const AGENDA_JUMP_EVENT = "cbase-open-agenda";
export const AGENDA_JUMP_VALID_MS = 30_000;

export type AgendaWish = { chatId: string; pointId: string; at: number };

let wish: AgendaWish | null = null;

/** Opens the chat, the "Agenda" bar and highlights the point. */
export function openAgendaPoint(chatId: string, pointId: string, now = Date.now()): void {
  if (!chatId || !pointId) return;
  wish = { chatId, pointId, at: now };
  window.dispatchEvent(new CustomEvent("cbase-open-chat", { detail: chatId }));
  window.dispatchEvent(new CustomEvent(AGENDA_JUMP_EVENT));
}

/** The waiting wish for this chat (without picking it up) — a lapsed one is discarded. */
export function agendaWish(chatId: string | null, now = Date.now()): AgendaWish | null {
  if (!wish) return null;
  if (now - wish.at > AGENDA_JUMP_VALID_MS) { wish = null; return null; }
  return chatId && wish.chatId === chatId ? wish : null;
}

/** The wish is served (the point stands highlighted in the bar). */
export function agendaWishDone(w: AgendaWish): void {
  if (wish === w) wish = null;
}
