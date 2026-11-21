import SwiftUI

/// The card of an agent message in the timeline (role `.nachricht`): heading "Message from <from>" (outer loop: "Outer Loop
/// <from>"), below it the text. In the shape of the channel card (`Chat/ChannelPane.swift`, `ChannelCardView`) — neither a
/// user bubble nor an agent reply, hence a full-width surface. The reading lives in `InboundAgentMessage.swift` (without
/// SwiftUI, so the binding can run it alone); web counterpart: `web/src/components/chat/AgentMessageCard.tsx`.
struct AgentMessageCardView: View {
    let message: InboundAgentMessage

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                // Card shape of the timeline (Chat/StatusForm.swift): symbol muted instead of accent.
                Image(systemName: "text.bubble")
                    .chatFont(.fixed(11), weight: .medium)
                    .foregroundStyle(CbColor.textMuted)
                Text(message.header)
                    .chatFont(.fixed(12.5), weight: .medium)
                    .foregroundStyle(CbColor.text)
                    .lineLimit(1)
                    .accessibilityIdentifier("chat-agent-message")
                Spacer(minLength: 4)
                if !message.address.isEmpty {
                    Text(message.address)
                        .chatFont(.fixed(11))
                        .foregroundStyle(CbColor.textMuted)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
            // Same pairing as in the channel card: the first spec picks the card's font, the second reaches the paragraph drawn
            // as UIKit text (rationale at `ChannelCardView`).
            MarkdownView(source: message.text)
                .chatFont(.subheadline)
                .environment(\.chatMarkdownBaseSize, 15)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(CbColor.elevated, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}
