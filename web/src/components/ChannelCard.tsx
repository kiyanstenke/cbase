"use client";

// Channel card: a message from a channel between two chats — its own row in the history of BOTH chats (persisted as
// role='channel'). A channel may connect two Coding chats: no assumption that one side is a manager. On the sender it shows "to
// ‹counterpart›" (title of the other chat, `recipient` of the card), on the recipient "from ‹sender›"; a system message
// (hook, cap, pause) carries its marker instead of a sender. It is neither a user message nor an agent reply — hence a card
// in the surface, not left or right.
import { Markdown } from "@/components/Markdown";
import { API_BASE } from "@/lib/api";
import { dateLocale, useT } from "@/lib/i18n";
import { type ChannelCardData } from "@/lib/channel-card";
import { ic } from "@/components/CbKit";
import { CARD, CARDS_HEADER } from "@/components/chat/StatusLine";

/** The mark on a card answer that came through a channel (Coding chat). */
export type OverChannel = { channelId: string; name: string; sender: string };

// `withChannelCard` and `ChannelCardData` live as a leaf module in lib/channel-card.ts (the streaming reducer in
// chat/chatBubbles.ts needs the helper without React) — re-exported here under the old path so no importer moves.
export { withChannelCard } from "@/lib/channel-card";
export type { ChannelCardData } from "@/lib/channel-card";

const ChannelIcon = () => ic(<><path d="M4 6h11a4 4 0 0 1 4 4v1" /><path d="M20 18H9a4 4 0 0 1-4-4v-1" /><path d="M8 3 4 6l4 3" /><path d="m16 15 4 3-4 3" /></>, 14);
const SystemIcon = () => ic(<><circle cx="12" cy="12" r="9" /><path d="M12 8v4" /><path d="M12 16h.01" /></>, 14);
const FileIcon = () => ic(<><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></>, 12);
const size = (n?: number) => (typeof n !== "number" ? "" : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
const ORIGIN: Record<string, string> = {
  // "workspace" is written by the server for every sender (channels/messages.js), also for a Coding chat writing to another
  // Coding chat. An old card with a mark of a removed sender kind shows it raw, like any unknown origin.
  attachment: "attachment of the sender", workspace: "from the sender's working tree",
};

// The system marker in words — the kind comes from the server (hook_ask, hook_end, cap, pause, …). Every kind the server
// writes needs a line here and in `ChannelCard.systemMarker` (iOS) — else "System message" silently shows; the guard is
// web/test/list-binding.test.mjs, which reads the kinds from the server sources.
const SYSTEM_MARKERS: Record<string, string> = {
  hook_ask: "Question in the observed chat",
  hook_end: "Run finished",
  cap: "Cap reached",
  pause: "Paused",
  resumed: "Resumed",
  closed: "Closed",
  rejected: "Rejected",
  // Archive hold on the sender, reopened in the channel bar, a queued message expired at run end.
  archived: "Target archived",
  opened: "Reopened",
  expired: "Expired",
};

/** The system marker in words (untranslated — the caller passes it through t()). */
export const systemMarker = (kind?: string) => SYSTEM_MARKERS[kind || ""] || "System message";

/** The files of a channel message as capsules — each leads through the channel to the download. Shared between the card in
 *  the history and the sidebar log. */
export function ChannelFiles({ channelId, files }: { channelId: string; files: NonNullable<ChannelCardData["files"]> }) {
  const t = useT();
  if (!files.length) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5" data-channel-files>
      {files.map((d, i) => {
        const name = d.name || d.path || d.file || "";
        const title = [d.origin ? t(ORIGIN[d.origin] || d.origin) : "", size(d.size)].filter(Boolean).join(" · ");
        const inner = (
          <>
            <FileIcon />
            <span className="truncate">{name}</span>
            {typeof d.size === "number" && <span className="text-dim">{size(d.size)}</span>}
          </>
        );
        const cls = "inline-flex max-w-full items-center gap-1.5 rounded-xl bg-bg px-2 py-1 text-[11.5px] text-fg";
        return d.file ? (
          <a key={i} href={`${API_BASE}/api/channels/${channelId}/files/${encodeURIComponent(d.file)}`} target="_blank" rel="noreferrer" title={title} className={`${cls} hover:bg-hover`}>{inner}</a>
        ) : (
          <span key={i} title={title} className={cls}>{inner}</span>
        );
      })}
    </div>
  );
}

// The card itself navigates nowhere — a card whose channel was deleted stays in the history and reads like any other.
export function ChannelCard({ card }: { card: ChannelCardData }) {
  const t = useT();
  const system = card.sender.kind === "system";
  const marker = system ? t(systemMarker(card.systemKind)) : null;
  const who = system
    ? null
    : card.direction === "out"
      ? (card.recipient?.name ? t("to {name}", { name: card.recipient.name }) : t("sent"))
      : t("from {name}", { name: card.sender.name || t("unknown") });
  const time = card.at ? new Date(card.at).toLocaleTimeString(dateLocale(), { hour: "2-digit", minute: "2-digit" }) : "";
  return (
    <div className={CARD} data-channel-card={card.channelId} data-seq={card.seq}>
      <div className={CARDS_HEADER}>
        {system ? <SystemIcon /> : <ChannelIcon />}
        <span className="font-medium text-fg">{t("Channel “{name}”", { name: card.channelName })}</span>
        {who && <span>{who}</span>}
        {marker && <span className="rounded-full bg-bg px-2 py-0.5 text-[11px]">{marker}</span>}
        {time && <span className="ml-auto tabular-nums">{time}</span>}
      </div>
      <div className="text-[13px] text-fg">
        <Markdown src={card.text} />
      </div>
      {card.files && card.files.length > 0 && <ChannelFiles channelId={card.channelId} files={card.files} />}
    </div>
  );
}
