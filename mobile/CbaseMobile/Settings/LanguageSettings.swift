import SwiftUI

// ── Language ────────────────────────────────────────────────────────────────
//
// Two choice cards instead of two list rows — and in EACH card the same real sentence from the UI, once German, once
// English. "Switch language" is the only setting whose effect you see only after it has happened; whoever cannot read the
// foreign language cannot find the way back out of it. The card therefore answers the question BEFORE the tap instead of
// describing it.
//
// The sample is no invented example but a dictionary entry: the English UI string is the key, `LocDE` supplies its German
// translation. It is word for word the same sentence as on the web (`web/src/components/settings/LanguageSettings.tsx`) —
// two samples would be two statements about the same thing, and one could be changed without seeing the other.
//
// The card is built to the HIG, not after the web model: surface colour and radius of a list card, the checkmark as the
// main signal, no glass. It carries its surface itself and therefore lies on a list row WITHOUT background — a group-list
// card under its own card would be two surfaces for one content.
//
// The explanatory sentence applies to both cards and is the hint of the GROUP — same wording, same key.

/// A status line from the chat: short enough for a card, long enough to show sentence structure rather than a single
/// word. It MUST be in the dictionary — otherwise the German card would fall back to the English key and show the same
/// twice.
///
/// Deliberately NOT called through translation: here the chosen language is not to translate, but each card is to show its
/// own. The audit sees only literal translation calls, so the key is not reported — it has always been in the dictionary
/// (the status line uses it). This comment therefore deliberately does not spell out the call: the audit reads comments
/// too, and an example in one would count as a used key.
private let languageProbe = "The agent is reading the project folder…"

struct LanguageSettingsView: View {
    @EnvironmentObject private var session: SessionStore
    @State private var current = Loc.lang

    /// At the accessibility text sizes the cards stand one below the other. Two columns would leave the sample sentence a
    /// handful of characters per line there — and it is exactly the reason for the card.
    @Environment(\.dynamicTypeSize) private var textSize

    var body: some View {
        CbList {
            CbSettingGroup(
                title: L("Interface language"),
                hint: L("Applies to the entire interface and server-side messages. The agent still replies in whatever language you write in.")
            ) {
                cards
                    // Without row background and without row inset the cards take exactly the surface an ordinary row of the
                    // group would take. The row's inset would otherwise add to their own padding and push them in against the
                    // heading above.
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
                    .listRowSeparator(.hidden)
            }
        }
        .navigationTitle(L("Language"))
        .navigationBarTitleDisplayMode(.inline)
    }

    /// Side by side, because the comparison is the point: the same sentence twice, one glance.
    @ViewBuilder private var cards: some View {
        if textSize.isAccessibilitySize {
            VStack(spacing: 10) {
                ForEach(AppLang.allCases, id: \.rawValue) { card($0) }
            }
        } else {
            HStack(alignment: .top, spacing: 10) {
                ForEach(AppLang.allCases, id: \.rawValue) { card($0) }
            }
        }
    }

    private func card(_ lang: AppLang) -> some View {
        let selected = current == lang
        return Button {
            apply(lang)
        } label: {
            VStack(alignment: .leading, spacing: 9) {
                HStack(alignment: .top, spacing: 8) {
                    VStack(alignment: .leading, spacing: 1) {
                        // The name in its own language first: whoever cannot read the UI right now still recognises
                        // "English".
                        Text(lang.nativeName)
                            .font(.subheadline.weight(.semibold))
                        Text(L(lang.displayLabel))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 0)
                    Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                        .font(.symbol(17))
                        .foregroundStyle(selected ? Color.accentColor : Color.secondary.opacity(0.4))
                }
                Text(probe(lang))
                    .cbFont(12)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 9)
                    .padding(.vertical, 7)
                    .background(Color.secondary.opacity(0.1), in: RoundedRectangle(cornerRadius: 10))
            }
            // `maxHeight` evens out the two cards: the German sentence breaks one line later than the English one, and two
            // cards of different height side by side read as a ranking.
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .padding(12)
            .background(.cbSurface, in: RoundedRectangle(cornerRadius: 16))
            .overlay {
                RoundedRectangle(cornerRadius: 16)
                    .strokeBorder(selected ? Color.accentColor : Color.clear, lineWidth: 1.5)
            }
            // Without a hit area of its own only the card's text reacts, not its surface.
            .contentShape(RoundedRectangle(cornerRadius: 16))
        }
        .buttonStyle(.plain)
        // The identifier hangs on the button, not on the stack inside: an identifier on the stack moves to every child and
        // makes the cell unfindable. The names are those from before — SettingsUITests looks for the buttons language-de and
        // language-en.
        .accessibilityIdentifier("language-\(lang.rawValue)")
        // The checkmark is a colour and a shape; for VoiceOver it is nothing without this trait.
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }

    /// The sample in the language of the CARD, not in the chosen one.
    private func probe(_ lang: AppLang) -> String {
        lang == .de ? (LocDE[languageProbe] ?? languageProbe) : languageProbe
    }

    private func apply(_ lang: AppLang) {
        guard lang != Loc.lang else { return }
        Loc.persist(lang)
        current = lang
        if let client = session.client {
            struct Body: Encodable { let lang: String }
            Task { _ = try? await client.send("/api/ui-lang", method: .put, body: Body(lang: lang.rawValue)) }
        }
        // The app root carries `.id(Loc.lang)` — this signal rebuilds the UI.
        NotificationCenter.default.post(name: .cbaseLanguageChanged, object: nil)
    }
}

extension Notification.Name {
    static let cbaseLanguageChanged = Notification.Name("cbase.language.changed")
}
