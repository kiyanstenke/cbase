import SwiftUI

// ── The building blocks of the settings ──
//
// Counterpart of `web/src/components/settings/SettingsKit.tsx`, deliberately named the same (row → CbSettingRow, group →
// CbSettingGroup, ring/bar/preview) so both files can be read side by side. It is built to the HIG, not to the web model: no
// glass, `List`/`Section` instead of own surfaces, and instead of the hover bubble a `.popover` on tap, since the iPhone has
// no hover.
//
// The basic form is the ROW: title, below it UP TO THREE LINES of explanation, the control on the right. The explanatory
// prose was too much, not wrong: zero to three lines, not zero.
//
// Truncation is NEVER silent: if the hint does not fit in three lines, the row MEASURES that itself (the same text a second
// time, invisible and without limit, heights compared) and puts an (i) next to the title that shows the full wording. The (i)
// IS the statement "there is more here"; a truncation you cannot see would be indistinguishable from a complete text. No
// wording is rewritten for it and no dictionary key invented: it is the same string, once clipped and once whole.
//
// What is NOT here: toggle, segments, overline, search field. They come from `Kit/CbKit.swift`; two ways to one building
// block become two building blocks as soon as one of them changes.

/// How many lines a hint shows before it is clipped. One number, one place: row and group must share the same clamp, or one
/// measures what the other shows.
let cbHintRows = 3

// ── The hint that measures its own truncation ──

/// The dimmed explanatory text under a title: at most `rows` lines (`nil`: whole), and the truncation reports back through
/// `trimmed`. Color: `.secondary` in a row; in a group header (`inHeader`) `CbColor.textMuted`, because the header is already
/// tinted secondary and `.secondary` on it would be the secondary level OF that level (measured light #c1c0bf on #faf9f5 ≈
/// 1.7 : 1, dark #5c5c5e on #1e1e1d ≈ 2.7 : 1).
///
/// Measured with the trick of the old text section: the same text a second time, invisible and WITHOUT limit, in a background
/// `GeometryReader`; if it is taller than the clamped version, something is visibly missing. A character count as the threshold
/// would be wrong: the text width depends on the control beside it, the device's font size and the language.
private struct CbHintText: View {
    let text: String
    var rows: Int? = cbHintRows
    var inHeader = false
    @Binding var trimmed: Bool

    private var font: Font { .caption }

    var body: some View {
        Text(text)
            .font(font)
            .foregroundStyle(inHeader ? AnyShapeStyle(CbColor.textMuted) : AnyShapeStyle(.secondary))
            .lineLimit(rows)
            .fixedSize(horizontal: false, vertical: true)
            .background { measurer }
    }

    // The measuring setup hangs in the BACKGROUND and does not affect layout: it is as large as the clamped line, its content may
    // grow beyond it and is cut off.
    private var measurer: some View {
        GeometryReader { visible in
            Text(text)
                .font(font)
                .fixedSize(horizontal: false, vertical: true)
                .hidden()
                .background {
                    GeometryReader { full in
                        Color.clear
                            .onAppear { report(full.size.height, visible.size.height) }
                            .onChange(of: full.size.height) { report(full.size.height, visible.size.height) }
                            .onChange(of: visible.size.height) { report(full.size.height, visible.size.height) }
                    }
                }
        }
        .clipped()
        .accessibilityHidden(true)
    }

    // Write only when the verdict changes: an assignment on every layout pass would be a loop of state and layout. One point of
    // tolerance against rounding.
    private func report(_ full: CGFloat, _ visible: CGFloat) {
        let fresh = full > visible + 1
        if fresh != trimmed { trimmed = fresh }
    }
}

// ── The (i) ──

/// The (i) on a row or a group. The text comes as a property and is NOT translated here; the caller already passes it
/// translated in the parentheses, so the English key sits literally in the source where the localization audit and every reader
/// expect it. (This sentence deliberately does not name the call: the audit also reads comments, and an example call in the
/// explanatory text counts as a used key to it.)
///
/// `.presentationCompactAdaptation(.popover)` is mandatory: without it the iPhone turns every popover into a sheet from below,
/// and a footnote on the title would become a page change.
struct CbInfoButton: View {
    let text: String
    @State private var open = false

    var body: some View {
        Button {
            open = true
        } label: {
            Image(systemName: "info.circle")
                .font(.symbol(13.5, weight: .semibold))
                // Palette instead of `.secondary`: in a group header `.secondary` would be the secondary level of the already secondary header
                // (see `CbHintText`); in a row it is the same brightness.
                .foregroundStyle(CbColor.textMuted)
                // 26 points of hit area on a 13-point glyph: the HIG target size is 44; this is as close as a footnote on the title gets
                // without stretching the row.
                .frame(width: 26, height: 26)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(L("Explanation"))
        .popover(isPresented: $open) {
            ScrollView {
                Text(text)
                    .cbFont(13)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(14)
            }
            // Fixed width, capped height: the longest hint in the settings (the 99 % threshold on the usage page) is nine lines long;
            // without a cap the popover would grow beyond the device, without a scroll view its end would be cut off.
            .frame(width: 300)
            .frame(maxHeight: 420)
            .presentationCompactAdaptation(.popover)
        }
    }
}

// ── The row ──

/// The basic form of every setting: title, below it the hint (up to three lines), the control on the right.
///
/// `hint` is the visible explanatory text. If it runs beyond that, the row clips it and shows the (i): measured, not guessed.
/// `info` overrides what this (i) shows and ALWAYS shows it (for when the full text lives elsewhere than the clipped one); same
/// rule as on the web.
///
/// `symbol` is the only addition to the web version: a row that leads to a subpage carries its SF Symbol on the iPhone.
///
/// `withInfo: false` turns the (i) off. This is not cosmetic: in the label of a `NavigationLink` a button NEVER gets the tap,
/// the whole cell is the button. An (i) that only navigates onward there would be a lie, so it does not show there.
struct CbSettingRow<Control: View>: View {
    let title: String
    var hint: String? = nil
    var info: String? = nil
    var symbol: String? = nil
    var withInfo = true
    @ViewBuilder var control: () -> Control

    @State private var trimmed = false

    /// The (i) shows when an own text was passed or the hint is really clipped, and only if the row can receive the tap.
    private var infoText: String? {
        guard withInfo else { return nil }
        if let info { return info }
        return trimmed ? hint : nil
    }

    var body: some View {
        HStack(spacing: 11) {
            if let symbol {
                Image(systemName: symbol)
                    .font(.symbol(15))
                    .foregroundStyle(.tint)
                    .frame(width: 24)
            }
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 2) {
                    Text(title)
                        .font(.subheadline.weight(.medium))
                        .fixedSize(horizontal: false, vertical: true)
                    if let infoText {
                        CbInfoButton(text: infoText)
                            // The glyph sits close to the title, not at the right edge: it belongs to IT, not to the row; at the edge it would read as a
                            // second control next to the toggle.
                            .padding(.leading, 1)
                    }
                    Spacer(minLength: 0)
                }
                if let hint, !hint.isEmpty {
                    CbHintText(text: hint, trimmed: $trimmed)
                }
            }
            Spacer(minLength: 8)
            control()
        }
        .padding(.vertical, 1)
    }
}

extension CbSettingRow where Control == EmptyView {
    /// The row without an own control, for a row that is itself the button (`NavigationLink`, `Button`) or whose value on the
    /// right comes from the system.
    init(title: String, hint: String? = nil, info: String? = nil, symbol: String? = nil, withInfo: Bool = true) {
        self.init(title: title, hint: hint, info: info, symbol: symbol, withInfo: withInfo) { EmptyView() }
    }
}

// ── The group ──

/// A section of the settings: `Section` with the title in the header and, when something applies to the whole group and fits
/// no single row, the group hint below, with the SAME clamp and the same (i) as a row. Otherwise the wall of text would just
/// move from the rows into the header.
///
/// `.textCase(nil)` is needed because `List` uppercases headers on its own, which would also hit the hint below, and an
/// uppercased running sentence is no longer one.
struct CbSettingGroup<Content: View>: View {
    var title: String? = nil
    var hint: String? = nil
    /// Show the hint WHOLE instead of clipping it after `cbHintRows` with an (i), for a group whose hint makes the choice below
    /// understandable in the first place (accent color: what it tints and what not).
    var hintWhole = false
    @ViewBuilder var content: () -> Content

    @State private var trimmed = false

    var body: some View {
        Section {
            content()
        } header: {
            if title != nil || hint != nil {
                VStack(alignment: .leading, spacing: 3) {
                    if let title {
                        HStack(spacing: 2) {
                            Text(title)
                                .font(.footnote.weight(.semibold))
                                // Palette, not `.secondary` (see `CbHintText`): ≥ 4.5 : 1 on the ground color.
                                .foregroundStyle(CbColor.textMuted)
                            if trimmed, let hint {
                                CbInfoButton(text: hint)
                            }
                            Spacer(minLength: 0)
                        }
                    }
                    if let hint, !hint.isEmpty {
                        CbHintText(
                            text: hint, rows: hintWhole ? nil : cbHintRows, inHeader: true,
                            trimmed: $trimmed
                        )
                    }
                }
                .textCase(nil)
                .padding(.bottom, 2)
            }
        }
    }
}

// ── Numbers: ring and bar ──

/// Load → color. The same thresholds (70/90) as `UsageRingView` in the header and as `toneFor` in the web kit: the same
/// number must not give three colors in three places.
func cbToneFor(_ percent: Double) -> Color {
    percent >= 90 ? .red : percent >= 70 ? .orange : .accentColor
}

/// A NaN or a number beyond the scale from a not yet loaded answer would otherwise be a bar width that does not exist: the
/// bar would stand empty and look like "nothing used".
private func cbClamp(_ percent: Double) -> Double {
    guard percent.isFinite else { return 0 }
    return max(0, min(100, percent))
}

/// Percent ring. The same statement as `CbProgressBar`, only for a card instead of a list: on a provider card the ring is the
/// first thing you see, a bar would be one row among three others.
///
/// `tone` forces the color, needed where the number does not speak for itself (an exhausted window without a percentage is
/// red although it reports 0).
struct CbRing: View {
    let percent: Double
    var label: String? = nil
    var tone: Color? = nil
    var size: CGFloat = 44

    private var value: Double { cbClamp(percent) }
    private var color: Color { tone ?? cbToneFor(value) }

    var body: some View {
        VStack(spacing: 4) {
            ZStack {
                Circle()
                    .stroke(Color.secondary.opacity(0.22), lineWidth: size * 0.1)
                Circle()
                    .trim(from: 0, to: value / 100)
                    .stroke(color, style: StrokeStyle(lineWidth: size * 0.1, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                    .animation(.easeOut(duration: 0.6), value: value)
                // Fixed: the number sits INSIDE a ring of fixed size and is computed from it; with the text size it would grow over the stroke.
                Text(verbatim: "\(Int(value.rounded())) %")
                    .font(.system(size: max(9, size * 0.24), weight: .semibold))
                    .monospacedDigit()
            }
            .frame(width: size, height: size)
            if let label {
                Text(label)
                    .cbFont(11)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
        }
        // One element: otherwise number and label appear separately in the accessibility structure, same rule as on the header's usage ring.
        .accessibilityElement(children: .combine)
    }
}

/// The same value as a flat bar, for lists where several stand below each other.
///
/// Drawn with `GeometryReader` + `Capsule`, like the usage page's bars have always been: a `Gauge` would bring its own scale,
/// its own colors and, on the iPhone, a shape that would look foreign next to the existing bars.
struct CbProgressBar: View {
    let percent: Double
    var tone: Color? = nil
    var height: CGFloat = 7

    private var value: Double { cbClamp(percent) }

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.secondary.opacity(0.18))
                Capsule()
                    .fill(tone ?? cbToneFor(value))
                    .frame(width: proxy.size.width * value / 100)
                    .animation(.easeOut(duration: 0.6), value: value)
            }
        }
        .frame(height: height)
        .accessibilityHidden(true)
    }
}

// ── Preview ──

/// A framed box with the "Preview" mark. It shows what a setting DOES, with the same building blocks as the real thing, not as
/// a re-creation with its own calculation; otherwise the preview eventually shows something other than the application.
struct CbPreview<Content: View>: View {
    var title: String? = nil
    @ViewBuilder var content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            CbOverline(title ?? L("Preview"))
            content()
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 2)
    }
}
