// The channel card as DATA and the pure helper that hooks it into a bubble list, without React or JSX: the streaming reducer
// (components/chat/chatBubbles.ts) calls it, and that is a leaf module that web/test/reducer.test.mjs compiles without a tsconfig
// (like lib/api). ChannelCard.tsx re-exports both under the old path. `lib` rule: no `@/` import (there is none here).

/** What identifies a card as “the same”: a channel message by its `messageId`, a note WITHOUT a message (the archive note at the sender,
 *  `messageId: null`) by its `noteId`. It used to be channelId + seq, but the archive note carries `seq = last`, the same number as the
 *  “out” card the sender already has in its history, and vanished live (iOS compared only `messageId` and swallowed every second note
 *  of the same channel because null is 0 there). A server with neither (old) falls back to seq + direction + systemKind. */
export function channelCardsKey(k: Pick<ChannelCardData, "channelId" | "seq" | "direction"> & { messageId?: number | null; noteId?: string | null; systemKind?: string }): string {
  if (typeof k.messageId === "number" && k.messageId > 0) return `n:${k.channelId}:${k.messageId}`;
  if (k.noteId) return `z:${k.channelId}:${k.noteId}`;
  return `s:${k.channelId}:${k.seq}:${k.direction}:${k.systemKind || ""}`;
}

/** Hook a channel card into the bubble list of a conversation: a still open, empty streaming bubble is dropped (one with content is
 *  closed), and the same card appears only once (`channelCardsKey`). */
export function withChannelCard<B extends { role: string; streaming?: boolean; blocks: { kind: string; text?: string }[]; channel?: ChannelCardData }>(
  prev: B[], card: ChannelCardData, fresh: () => B,
): B[] {
  const copy = [...prev];
  const last = copy[copy.length - 1];
  if (last?.streaming) {
    if (!last.blocks.some((bl) => (bl.kind === "text" && bl.text?.trim()) || bl.kind !== "text")) copy.pop();
    else copy[copy.length - 1] = { ...last, streaming: false };
  }
  const key = channelCardsKey(card);
  if (copy.some((b) => b.role === "channel" && b.channel && channelCardsKey(b.channel) === key)) return copy;
  return [...copy, fresh()];
}

export interface ChannelCardData {
  channelId: string;
  channelName: string;
  /** null for a note that is no channel message (the archive note at the sender); it then carries `noteId`. */
  messageId?: number | null;
  /** Identifier of a note without a message, e.g. `archive:<targetChatId>:<last>`. */
  noteId?: string;
  seq: number;
  direction: "in" | "out" | "log";
  sender: { kind: "chat" | "system"; chatId: string | null; name: string };
  // The counterpart at the sender: a channel also connects two Coding chats, and “sent” alone does not say to whom. Optional: the
  // server writes it only for EXACTLY one counterpart; without it “sent” is shown.
  recipient?: { chatId: string | null; name: string };
  systemKind?: string;
  text: string;
  // Files of the message: name, size, origin. `file` is the name under channel-files/<channel>/ and in the recipient's attachments;
  // the download goes through the channel.
  files?: { name?: string; path?: string; size?: number; origin?: string; file?: string }[];
  at?: number;
}

/** What a channel participant knows about its reason for waiting (`publicChannel`). The server only writes `archived` and
 *  `questionOpen` for new data; if they are MISSING the reason is unknown, not “neither” (empty is not unknown). */
export interface ChannelWaiting { running?: boolean; archived?: boolean; questionOpen?: boolean }

/** Why a participant still has undelivered messages: the title on “{n} waiting”. The cursor also stops at an archived target and at an
 *  open question card, without a run going; what remains is a workflow's gate. Untranslated: the caller sends it through t(); iOS has
 *  the same text in `ChannelParticipant.waitReason` (Chat/ChannelPane.swift, bound in web/test/list-binding.test.mjs). */
export function channelWaitReason(p: ChannelWaiting): string {
  if (p.running) return "Delivered after its turn";
  if (p.archived === true) return "Chat archived — delivered when you restore it";
  if (p.questionOpen === true) return "Waiting for your answer in the chat";
  if (p.archived === false && p.questionOpen === false) return "Waiting for a workflow gate";
  return "Not delivered yet — the run is still going";
}
