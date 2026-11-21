import SwiftUI

// ── Settings → Appearance ───────────────────────────────────────────────────
//
// The folder follows the PLACE where the user opens the view — and that is the settings list, not the kit.
//
// Colour scheme, text size and the chat's typeface are device preferences: no save button, no server call, the effect is
// immediate. That is why this page, alone among the ten, has neither a loading state nor an error path — there is
// nothing that could fail to arrive.
//
// The text size applies to the WHOLE app (Kit/TextSize.swift). The app itself is thus the preview: every step re-wraps
// the whole page. The form follows from that:
//  – the step bar is the FIRST row of the page: above it there is only the navigation bar (fixed height), and it has
//    fixed geometry itself (symbols and dots, no text) — it stands at the same point on every step. Title, hint and
//    step name stand BELOW it;
//  – tap instead of drag: small A, five detent dots, large A (the iOS form, Settings → Display & Brightness → Text
//    Size), one step per tap, a dot selects its step directly;
//  – the step name on the right, NO percentage: Apple's curve is not linear (a footnote grows more than a headline), a
//    number would promise something untrue.
//
// A `Slider` below the title row was dropped: measured in the simulator (iOS 26.5), every step re-wrapped the row above
// it, the control drifted down 25 pt while dragging from Normal to Very large, a drag across two steps landed one short
// twice — and a drag with a short hold before it triggered the iOS 26 back gesture (swipe from anywhere), the page
// jumped back. A tap is not such a gesture.

struct AppearanceSettingsView: View {
    @EnvironmentObject private var theme: ThemeStore
    /// No `@EnvironmentObject`: this page is pushed from a sheet, and a sheet gets its objects in this app handed in
    /// explicitly (see `TextSizeStore.shared`). `@ObservedObject` on the shared store re-evaluates the view on every
    /// change just the same.
    @ObservedObject private var font = TextSizeStore.shared
    /// The chat's typeface (Kit/ChatTypeface.swift) — shared for the same reason instead of an environment object.
    @ObservedObject private var typeface = ChatTypefaceStore.shared

    var body: some View {
        CbList {
            // No group title: it would stand word for word next to the row below — and it would grow with every step and
            // push the bar below it away.
            CbSettingGroup {
                TextSizeBar(font: font)

                CbSettingRow(
                    title: L("Text size"),
                    hint: L("Applies to the whole app. Normal follows your iPhone’s text size; each step is one size above or below.")
                ) {
                    // Value and "Default" ONE BELOW THE OTHER, each on one line at its natural width: side by side, the
                    // button broke mid-word at "Very large" ("Defau/lt"), the value took two lines, and the hint next to it
                    // was cut to one word.
                    VStack(alignment: .trailing, spacing: 0) {
                        Text(L(font.size.displayLabel))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .fixedSize()
                            .accessibilityIdentifier("settings-text-size-value")
                        if font.size != .normal {
                            CbTextButton(title: L("Default")) { font.size = .normal }
                                .lineLimit(1)
                                .fixedSize()
                                .padding(.trailing, -8)
                                .accessibilityIdentifier("settings-text-size-default")
                        }
                    }
                }

                // Real styles instead of a replica: a heading, a paragraph, a muted meta line and a paragraph of the
                // history. That way "relative" is visible at a glance — they grow together, their spacing to each other
                // stays. No `.environment` any more: the step acts via the window trait on this page like on any other.
                CbPreview {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(L("Heading"))
                            .font(.headline)
                        Text(L("Paragraphs, lists and menus grow in the same proportion."))
                            .font(.body)
                        Text(L("Meta line · stays smaller"))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        MarkdownView(source: previewSource)
                    }
                    // The identifier sits on a block WITHOUT buttons: on a stack with buttons it moved to every child and
                    // made it unfindable.
                    .accessibilityIdentifier("settings-text-size-preview")
                }
            }

            // The chat's typeface. Each row stands IN its typeface, below it a piece of history in the chosen one — message
            // and reply as they stand in the chat. Applies only to the chat's text, not to the rest of the app.
            CbSettingGroup(
                title: L("Chat font"),
                hint: L("Applies to messages, replies and the input field. Code stays monospaced, the rest of the app uses the system font.")
            ) {
                Picker(L("Chat font"), selection: Binding(
                    get: { typeface.choice },
                    set: { typeface.choice = $0 }
                )) {
                    ForEach(ChatTypeface.allCases) { kind in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(L(kind.displayLabel))
                                .chatFont(.body, typeface: kind)
                            Text(L(kind.germanHint))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        .tag(kind)
                        .accessibilityIdentifier("settings-typeface-\(kind.rawValue)")
                    }
                }
                .pickerStyle(.inline)
                .labelsHidden()
                .accessibilityIdentifier("settings-typeface")

                CbPreview {
                    VStack(alignment: .leading, spacing: 10) {
                        Text(L("Can you briefly explain what the build error was?"))
                            .chatFont(.body)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 8)
                            .background(.cbElevated, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                            .frame(maxWidth: .infinity, alignment: .trailing)
                        Text(markdown: L("The build failed because a file was registered **twice**. I removed the duplicate entry — `npm run build` runs through again."))
                            .chatFont(.body)
                    }
                    .accessibilityIdentifier("settings-typeface-preview")
                }
            }

            // The explanatory sentence applies to ALL settings of the page and therefore sits on a group, not on a row — it
            // is the only place that says nothing here goes to the server.
            CbSettingGroup(
                title: L("Theme"),
                hint: L("Color scheme, text size and font apply to this device — they are stored here, not on the server.")
            ) {
                Picker(L("Appearance"), selection: Binding(
                    get: { theme.preference },
                    set: { theme.preference = $0 }
                )) {
                    ForEach(ThemePreference.allCases) { preference in
                        Label(L(preference.displayLabel), systemImage: preference.symbol).tag(preference)
                    }
                }
                // Three rows with checkmarks instead of a menu: the three options ARE the statement of this group, a menu
                // would show only the chosen one.
                .pickerStyle(.inline)
                .accessibilityIdentifier("settings-theme")
            }

            // Accent colour — choice, preview and computation in AccentColorSection / Kit/AccentColor.swift.
            AccentColorSection()
        }
        .navigationTitle(L("Appearance"))
        .navigationBarTitleDisplayMode(.inline)
    }

    /// Prose with inline code. A FENCED code block would be the more honest excerpt (it grows along), but brings its copy
    /// button — and an identifier on the container moves to every child and would take away its own.
    private var previewSource: String {
        L("This is how a reply reads in the conversation — paragraphs, lists and quotes at this size, plus `npm run build` as inline code.")
    }
}

/// The step bar: [A−]  ●──●──●──○──○  [A+]. Fixed geometry — symbols (`.symbol`) and dots, no text, 44 pt high — so it
/// stands still on every step while the page re-wraps around it. Operated by tap: A− / A+ one step each, a dot its step
/// directly.
///
/// Accessibility: A− and A+ are separate buttons; for VoiceOver the dots are ONE control (`Slider` as presentation) with
/// the step name as value — swiping up/down goes one step further. The identifiers (`settings-text-size`, `-smaller`,
/// `-larger`) are carried by the UI tests (`selectTextSize` taps).
private struct TextSizeBar: View {
    @ObservedObject var font: TextSizeStore

    private var i: Int { font.size.place }
    private static let stages = TextSize.allCases

    var body: some View {
        HStack(spacing: 0) {
            button("textformat.size.smaller", pt: 14, label: L("Smaller text"), identifier: "settings-text-size-smaller", disabled: i == 0) {
                select(i - 1)
            }
            lane
            button("textformat.size.larger", pt: 20, label: L("Larger text"), identifier: "settings-text-size-larger", disabled: i == Self.stages.count - 1) {
                select(i + 1)
            }
        }
        .frame(height: 44)
        .sensoryFeedback(.selection, trigger: font.size)
    }

    private func select(_ place: Int) {
        let target = TextSize(place: place)
        if target != font.size { font.size = target }
    }

    private func button(_ symbol: String, pt: CGFloat, label: String, identifier: String, disabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.symbol(pt, weight: .medium))
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(disabled ? Color(.tertiaryLabel) : Color.secondary)
        .disabled(disabled)
        .accessibilityLabel(label)
        .accessibilityIdentifier(identifier)
    }

    /// Five equal-width cells, one dot in the middle each; behind them the track from the first to the last centre, up to
    /// the chosen one in the accent. The chosen dot is the knob (white, shadow — like a slider).
    private var lane: some View {
        HStack(spacing: 0) {
            ForEach(Self.stages) { s in
                Button { select(s.place) } label: {
                    point(s.place)
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .background {
            GeometryReader { g in
                let cell = g.size.width / CGFloat(Self.stages.count)
                let beginning = cell / 2
                let whole = g.size.width - cell
                let until = cell * CGFloat(i)
                ZStack(alignment: .leading) {
                    Capsule().fill(Color(.systemFill)).frame(width: max(0, whole), height: 4)
                    Capsule().fill(.tint).frame(width: max(0, until), height: 4)
                }
                .offset(x: beginning)
                .frame(height: g.size.height)
            }
        }
        .animation(.snappy(duration: 0.18), value: i)
        .accessibilityRepresentation {
            Slider(
                value: Binding(
                    get: { Double(i) },
                    set: { select(Int($0.rounded())) }
                ),
                in: 0...Double(Self.stages.count - 1),
                step: 1
            )
        }
        .accessibilityLabel(L("Text size"))
        .accessibilityValue(L(font.size.displayLabel))
        .accessibilityIdentifier("settings-text-size")
    }

    @ViewBuilder
    private func point(_ place: Int) -> some View {
        if place == i {
            Circle()
                .fill(Color.white)
                .frame(width: 22, height: 22)
                .shadow(color: .black.opacity(0.18), radius: 2, y: 1)
                .overlay(Circle().strokeBorder(Color.black.opacity(0.06)))
        } else {
            Circle()
                .fill(place < i ? AnyShapeStyle(.tint) : AnyShapeStyle(Color(.tertiaryLabel)))
                .frame(width: 8, height: 8)
        }
    }
}
