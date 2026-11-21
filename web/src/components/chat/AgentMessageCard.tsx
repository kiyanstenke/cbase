"use client";

// A message from an agent to this chat: the third kind under the role `user` (lib/agents-message.ts). Neither a user
// bubble nor an agent reply — so, like the channel card (ChannelCard.tsx), a card on the surface: header "Message from
// <from>" (Outer Loop: "Outer Loop <from>"), then the text. The text is foreign text; it is shown here as data.
// Building block of the coding chat (ChatBubbleRow).
import { Markdown } from "@/components/Markdown";
import { ic } from "@/components/CbKit";
import { CARD, CARDS_HEADER } from "@/components/chat/StatusLine";
import { useT } from "@/lib/i18n";
import { messageHeader, type InboundAgentMessage } from "@/lib/agents-message";

const MessageIcon = () => ic(<><path d="M4 5h16v11H8l-4 4z" /><path d="M8 9h8" /><path d="M8 12h5" /></>, 14);

export function AgentMessageCard({ message }: { message: InboundAgentMessage }) {
  const t = useT();
  const header = messageHeader(message);
  return (
    <div className={CARD} data-agent-message={message.kind || "agent"}>
      <div className={CARDS_HEADER}>
        <MessageIcon />
        <span className="min-w-0 truncate font-medium text-fg">{t(header.label, header.labelParams)}</span>
        {message.address && <span className="ml-auto min-w-0 truncate" title={t("Sender's reply address")}>{message.address}</span>}
      </div>
      <div className="text-[13px] text-fg">
        <Markdown src={message.text} />
      </div>
    </div>
  );
}
