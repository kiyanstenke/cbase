import SwiftUI

// The form of the status messages in the history. Twin of web/src/components/chat/StatusLine.tsx, three building
// blocks and no others:
//
//   • `StatusRow`: every event without a decision: target gate, monitor, workflow driver, usage limit, completion notice and
//     workflow marker (tone and symbol: `SeparatorTone`, Chat/CompletionNotice.swift). Muted, without color and without
//     bold; the head one step brighter than the rest after "·"; the state is in the word and the symbol, not in the tone.
//   • `SeparatorRow`: boundaries in the history (compaction, clearing, hint): the same type, left-aligned, followed by a
//     hairline to the edge.
//   • the card (`.cbCard()`, `CardsHeader`, `CardsButtonStyle`): everything the human answers or reads: question,
//     approval (history and `PermissionCard`), workflow approval, channel, agent message, upload. Surface `elevated`
//     without border and without tint, muted symbol, the main button `primaryButton` instead of accent.
//
// A new status message takes one of these blocks, not a color of its own.

struct StatusRow: View {
    let symbol: String
    let header: String
    /// The rest after "·".
    var rest: String = ""
    /// nil: the rest IS the content (question, error reason) and wraps fully; otherwise at most this many lines.
    var rows: Int? = 2
    /// The identifier on the TEXT (never on the stack, it would overwrite the children), e.g. `chat-workflow-marker-<phase>`.
    var identifier: String = ""

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 7) {
            Image(systemName: symbol)
                .font(.symbol(11))
                .foregroundStyle(CbColor.textMuted)
                .frame(width: 14)
                .accessibilityHidden(true)
            // Set only WITH an identifier: an empty one on the text would override the one callers set on the stack (limit, workflow row).
            if identifier.isEmpty { row } else { row.accessibilityIdentifier(identifier) }
            Spacer(minLength: 0)
        }
        .chatFont(.caption)
        .padding(.vertical, 3)
    }

    private var row: some View {
        (Text(header).foregroundStyle(CbColor.textSecondary)
            + Text(rest.isEmpty ? "" : " · \(rest)").foregroundStyle(CbColor.textMuted))
            .lineLimit(rows)
            .fixedSize(horizontal: false, vertical: true)
    }
}

struct SeparatorRow<Addition: View>: View {
    /// nil: without symbol (hint; like on the web only compaction and clearing carry a symbol).
    let symbol: String?
    let text: String
    /// The identifier on the TEXT (never on the stack, it would overwrite the children).
    var identifier: String = ""
    @ViewBuilder var addition: () -> Addition
    @Environment(\.displayScale) private var displayScale

    var body: some View {
        HStack(alignment: .center, spacing: 7) {
            if let symbol {
                Image(systemName: symbol)
                    .font(.symbol(11))
                    .foregroundStyle(CbColor.textMuted)
                    .accessibilityHidden(true)
            }
            Text(text)
                .chatFont(.caption)
                .foregroundStyle(CbColor.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
                // The text takes what it needs, the line gets the rest (at least 24 pt), like `flex-1` on the web. Without
                // priority the HStack would split the width roughly in half between text and line: a long hint
                // sat squeezed in the left half with half a line beside it.
                .layoutPriority(1)
                .accessibilityIdentifier(identifier)
            addition()
            Rectangle()
                .fill(CbColor.edge)
                .frame(minWidth: 24, maxWidth: .infinity)
                .frame(height: 1 / max(displayScale, 1))
                .accessibilityHidden(true)
        }
        .padding(.vertical, 6)
    }
}

extension SeparatorRow where Addition == EmptyView {
    init(symbol: String?, text: String, identifier: String = "") {
        self.init(symbol: symbol, text: text, identifier: identifier) { EmptyView() }
    }
}

/// The head of a card: muted symbol, title in text color, muted details after it (`right`).
struct CardsHeader<Right: View>: View {
    let symbol: String
    let title: String
    /// The identifier on the TITLE; on a stack it would overwrite the children's identifiers.
    var identifier: String = ""
    @ViewBuilder var right: () -> Right

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: symbol)
                .chatFont(.fixed(11), weight: .medium)
                .foregroundStyle(CbColor.textMuted)
                .accessibilityHidden(true)
            Text(title)
                .chatFont(.fixed(12.5), weight: .medium)
                .foregroundStyle(CbColor.text)
                .lineLimit(1)
                .accessibilityIdentifier(identifier)
            right()
                .chatFont(.fixed(11.5))
                .foregroundStyle(CbColor.textMuted)
        }
    }
}

extension CardsHeader where Right == EmptyView {
    init(symbol: String, title: String, identifier: String = "") {
        self.init(symbol: symbol, title: title, identifier: identifier) { EmptyView() }
    }
}

extension View {
    /// The surface of every card in the history: `elevated`, without border and without tint.
    func cbCard() -> some View {
        padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.cbElevated, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

/// The buttons of a card: `main` = light on dark or dark on light (`primaryButton`), otherwise a capsule with a quiet
/// outline. No accent, no red, not even "Reject" (the role `.destructive` stays for accessibility).
struct CardsButtonStyle: ButtonStyle {
    var main = false

    func makeBody(configuration: Configuration) -> some View {
        CardsButtonBody(configuration: configuration, main: main)
    }
}

private struct CardsButtonBody: View {
    let configuration: ButtonStyleConfiguration
    let main: Bool
    @Environment(\.isEnabled) private var active

    var body: some View {
        configuration.label
            .chatFont(.fixed(13), weight: .medium)
            .lineLimit(1)
            .padding(.horizontal, 14)
            .padding(.vertical, 7)
            .foregroundStyle(main ? CbColor.primaryButtonText : CbColor.text)
            .background {
                if main {
                    Capsule().fill(CbColor.primaryButton)
                } else {
                    Capsule().strokeBorder(Color.secondary.opacity(0.3), lineWidth: 1)
                }
            }
            .contentShape(Capsule())
            .opacity(active ? (configuration.isPressed ? 0.7 : 1) : 0.45)
    }
}
