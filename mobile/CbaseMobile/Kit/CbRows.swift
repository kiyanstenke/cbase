import SwiftUI

// ── Lists without cards: the row language as a kit ───────────────────────────────────────
//
// The building blocks of the subagents page stand here ONCE, so that the next pages do not become copies of it:
//
//  – Rows directly on the page ground (`VStack(spacing: 2)`), no surface, no hairline, no card; pressed, the row lies in
//    `CbColor.marked` (`CbRowPress`).
//  – On the left an SF symbol in a round 34-pt circle on `CbColor.elevated` (`CbSign`): the glyph says the KIND, the tone the
//    ORIGIN (project in the accent, workspace neutral — `OriginKind.characterTone`). A small marker at the bottom right reports
//    what one MUST see (warning, running, pinned).
//  – Name in `CbColor.text`, below it ONE muted short line (`CbListRow`); a paragraph of text only where it really says
//    something (`text:`, at most two lines) — a description one needs for choosing, no explanatory text.
//  – Tapping opens a detail sheet (`CbDetailSheet` + `CbDetailHeader`/`CbDetailField`/`CbMarks`/`CbCodeBox`); edit and delete
//    stand there and in the row's context menu.
//  – The page's explanation stands behind the ⓘ in the header (`CbHeaderInfoButton` → `CbInfoSheet`), not as a subtitle and
//    not as a sentence under a section header.
//
// The lists of Coding use the TILE form (`Kit/CbTile.swift`: `CbTileRow`, `CbTileHeader`, `CbTileEmpty`, `CbSummary`,
// `CbSituation`; the pattern of a whole page at its head, in full in `Code/McpPane.swift`). From here it keeps the press
// (`.cbRowPress()`), the toggle row (`CbToggleRow`), the skeleton (`CbRowSkeleton(tile: true)`), the ⓘ and the detail sheet. The
// language up here (glyph in a circle) is still spoken by the Coding overview and the profiles.
//
// Two sheets in a row (detail → editor or question): close the detail first, then open the next in `onDismiss` — a view cannot
// show two sheets at once (see `McpPane`).
//
// The examples in comments write L(“…”) with typographic quotes: `mobile/tools/loc-audit.sh` also reads comments, and an
// example with straight quotes would count as a used key.

// ── Press ───────────────────────────────────────────────────────────────────

/// Press and selection state of a list row: no surface — selected OR pressed it lies in `CbColor.marked`, rounded like the
/// drawer's rows. Deliberately WITHOUT `contentShape` in the style: the row brings its own hit area (`CbListRow`), and with a
/// shape in the style a long press on the profile row got no context menu in the simulator (`ChatRowStyle`, cause unclear).
struct CbRowPress: ButtonStyle {
    var selected = false

    /// The shape of the surface — also the context menu's preview (`cbRowPress()`), otherwise iOS lifts the transparent row out
    /// as an angular strip.
    static let form = RoundedRectangle(cornerRadius: 12, style: .continuous)

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(selected || configuration.isPressed ? CbColor.marked : Color.clear, in: Self.form)
    }
}

extension View {
    /// On a `Button` with `CbListRow` as its label: the press style and the context-menu preview shape in one go — set it BEFORE
    /// `.contextMenu { … }`.
    func cbRowPress(selected: Bool = false) -> some View {
        buttonStyle(CbRowPress(selected: selected))
            .contentShape(.contextMenuPreview, CbRowPress.form)
    }

    /// An accessibility identifier only if there is one.
    @ViewBuilder
    func cbIdentifier(_ identifier: String?) -> some View {
        if let identifier { accessibilityIdentifier(identifier) } else { self }
    }
}

// ── The glyph ───────────────────────────────────────────────────────────────

extension OriginKind {
    /// The tone of a row's glyph: what is its own (project) in the accent, what is inherited (workspace) neutral.
    var characterTone: Color { self == .project ? .accentColor : CbColor.textSecondary }
}

/// The small marker at the glyph's bottom right — for what one MUST see in the list. It carries its own accessibility label (the
/// glyph itself is mute); the caller passes the label already translated.
struct CbSignMarker {
    enum Kind {
        /// Orange `exclamationmark.triangle.fill` — something is missing, something is broken.
        case warning
        /// A dot in a status color — running (green), starting (orange), stopped (red) …
        case point(Color)
        /// Pinned.
        case pin
    }

    let kind: Kind
    let label: String

    static func warning(_ label: String) -> CbSignMarker { CbSignMarker(kind: .warning, label: label) }
    static func point(_ color: Color, _ label: String) -> CbSignMarker { CbSignMarker(kind: .point(color), label: label) }
    static func pin(_ label: String) -> CbSignMarker { CbSignMarker(kind: .pin, label: label) }
}

/// The glyph of a row: an SF symbol in a round circle on `CbColor.elevated` — like the symbols of the Claude sidebar. 34 pt in
/// the list, 48 pt in the header of a detail sheet (`CbDetailHeader` sets that itself).
struct CbSign: View {
    let symbol: String
    var tone: Color = CbColor.textSecondary
    var size: CGFloat = 34
    /// Off: half transparent (a switched-off entry). The marker stays fully visible.
    var active = true
    var marker: CbSignMarker? = nil
    /// Rounded square instead of a circle — the tile of the Coding lists (Kit/CbTile.swift).
    var tile = false

    init(symbol: String, tone: Color = CbColor.textSecondary, size: CGFloat = 34, active: Bool = true, marker: CbSignMarker? = nil, tile: Bool = false) {
        self.symbol = symbol
        self.tone = tone
        self.size = size
        self.active = active
        self.marker = marker
        self.tile = tile
    }

    /// The tone from the origin (`OriginKind.characterTone`).
    init(symbol: String, origin: OriginKind, size: CGFloat = 34, active: Bool = true, marker: CbSignMarker? = nil) {
        self.init(symbol: symbol, tone: origin.characterTone, size: size, active: active, marker: marker)
    }

    var body: some View {
        Image(systemName: symbol)
            .font(.symbol(size * 0.4, weight: .medium))
            .foregroundStyle(tone)
            .frame(width: size, height: size)
            .background(.cbElevated, in: tile ? AnyShape(RoundedRectangle(cornerRadius: (size * 0.265).rounded(), style: .continuous)) : AnyShape(Circle()))
            .opacity(active ? 1 : 0.5)
            .accessibilityHidden(true)
            .overlay(alignment: .bottomTrailing) {
                if let marker { markerView(marker) }
            }
    }

    private func markerView(_ marker: CbSignMarker) -> some View {
        let d = (size * 0.4).rounded()
        return Group {
            switch marker.kind {
            case .warning:
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.symbol(d * 0.55, weight: .bold))
                    .foregroundStyle(Color.orange)
                    .frame(width: d, height: d)
                    .background(.cbElevated, in: Circle())
            case .point(let color):
                Circle()
                    .fill(color)
                    .frame(width: d * 0.7, height: d * 0.7)
                    .frame(width: d, height: d)
            case .pin:
                Image(systemName: "pin.fill")
                    .font(.symbol(d * 0.5, weight: .semibold))
                    .foregroundStyle(CbColor.textSecondary)
                    .frame(width: d, height: d)
                    .background(.cbElevated, in: Circle())
            }
        }
        // The ring in the page ground separates the marker from the circle below.
        .padding(2)
        .background(.cbBase, in: Circle())
        .offset(x: 3, y: 3)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(marker.label)
    }
}

// ── The row ─────────────────────────────────────────────────────────────────

/// A row: glyph, name, ONE muted short line — and only where it really says something, a paragraph of text below. Belongs as the
/// label of a `Button` with `.cbRowPress()`; without a button it stands still (e.g. in `CbToggleRow` without `tap`).
///
///     CbListRow(character: CbSign(symbol: "server.rack", origin: .project, marker: .point(.green, L(“running”))),
///                    title: server.name, titleMono: true,
///                    shortLine: Text("stdio · ") + Text(server.command).monospaced(),
///                    text: server.description)
struct CbListRow<Addition: View>: View {
    let character: CbSign
    let title: String
    /// Fixed-width type for identifiers, paths and commands as names.
    var titleMono = false
    /// The ONE muted line (12.5 pt, single line). A `Text`, so that parts can carry their own font or color (`Text(a) +
    /// Text(b).monospaced()`, `.foregroundStyle(.orange)`); a plain sentence is `Text(s)`.
    var shortLine: Text?
    /// At most this many lines of short line — default ONE. More only where the short line is a whole clause that helps with
    /// choosing and must not be cut off (the Coding overview).
    var shortLineRows = 1
    /// A paragraph of text (13 pt, `CbColor.textSecondary`, at most `textLines` lines) — ONLY where it helps with choosing (a
    /// description). With it the row sits top-aligned instead of centered. In a switched-off row one step quieter (`textMuted`) —
    /// otherwise it would stand lighter than its own muted name.
    var text: String?
    /// At most this many lines of paragraph; `nil` = no cap (a list that must lose nothing — the scan conflicts of the services: if
    /// a conflict flips, a cap would cut the last ones off their count).
    var textLines: Int? = 2
    /// The paragraph in fixed width — for a command as text (projects → services: the start command).
    var textMono = false
    /// Off: glyph half transparent, name muted.
    var active = true
    /// Room on the right for something that lies OVER the row. `CbToggleRow` holds the room for its toggle itself.
    var right: CGFloat = 0
    /// Something quiet at the right edge (a number, a time) — no button: a button inside a button's label gets no touch.
    let addition: Addition

    init(
        character: CbSign,
        title: String,
        titleMono: Bool = false,
        shortLine: Text? = nil,
        shortLineRows: Int = 1,
        text: String? = nil,
        textLines: Int? = 2,
        textMono: Bool = false,
        active: Bool = true,
        right: CGFloat = 0,
        @ViewBuilder addition: () -> Addition
    ) {
        self.character = character
        self.title = title
        self.titleMono = titleMono
        self.shortLine = shortLine
        self.shortLineRows = shortLineRows
        self.text = text
        self.textLines = textLines
        self.textMono = textMono
        self.active = active
        self.right = right
        self.addition = addition()
    }

    private var paragraph: String? {
        guard let text else { return nil }
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? nil : t
    }

    var body: some View {
        HStack(alignment: paragraph == nil ? .center : .top, spacing: 12) {
            characterView
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .cbFont(15, weight: .medium, design: titleMono ? .monospaced : nil)
                    .foregroundStyle(active ? CbColor.text : CbColor.textMuted)
                    .lineLimit(1)
                if let shortLine {
                    shortLine
                        .cbFont(12.5)
                        .foregroundStyle(CbColor.textMuted)
                        .lineLimit(shortLineRows)
                        .multilineTextAlignment(.leading)
                }
                if let paragraph {
                    Text(paragraph)
                        .cbFont(13, design: textMono ? .monospaced : nil)
                        // One step below the name, like the short line: at `textSecondary`, off `textMuted`.
                        .foregroundStyle(active ? CbColor.textSecondary : CbColor.textMuted)
                        .lineLimit(textLines)
                        .multilineTextAlignment(.leading)
                        .padding(.top, 2)
                }
            }
            Spacer(minLength: 0)
            addition
        }
        .padding(.leading, 8)
        .padding(.trailing, 8 + right)
        .padding(.vertical, 7)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }

    private var characterView: CbSign {
        var z = character
        z.active = character.active && active
        return z
    }
}

extension CbListRow where Addition == EmptyView {
    init(
        character: CbSign,
        title: String,
        titleMono: Bool = false,
        shortLine: Text? = nil,
        shortLineRows: Int = 1,
        text: String? = nil,
        textLines: Int? = 2,
        textMono: Bool = false,
        active: Bool = true,
        right: CGFloat = 0
    ) {
        self.init(
            character: character, title: title, titleMono: titleMono, shortLine: shortLine, shortLineRows: shortLineRows, text: text,
            textLines: textLines, textMono: textMono, active: active, right: right, addition: { EmptyView() }
        )
    }
}

/// A row with a toggle (adopting into a project, on/off). The toggle lies OVER the row, not beside it — so the pressed backing
/// takes the whole width; this block holds the room on the right itself (`slot`), so the row inside it goes WITHOUT `right:`.
/// Without `tap` the row stands still, only the toggle reacts.
///
///     CbToggleRow(isOn: a.enabled == true, disabled: toggling == a.id, toggleLabel: a.name,
///                      toggleIdentifier: "agent-toggle-\\(a.id)", toggle: { Task { await toggle(a) } },
///                      tap: { detail = a }) {
///         CbListRow(character: …, title: a.name, shortLine: …, active: a.enabled == true)
///     }
struct CbToggleRow<Row: View>: View {
    let isOn: Bool
    var disabled = false
    /// The accessibility label of the toggle (mostly the entry's name).
    let toggleLabel: String
    let toggleIdentifier: String
    let toggle: () -> Void
    var tap: (() -> Void)? = nil
    /// Identifier of the tappable row (only with `tap`).
    var identifier: String? = nil
    @ViewBuilder let row: () -> Row

    /// Width of the toggle including its margin.
    static var slot: CGFloat { 50 }

    var body: some View {
        ZStack(alignment: .trailing) {
            if let tap {
                Button(action: tap) { withSpace }
                    .cbRowPress()
                    .cbIdentifier(identifier)
            } else {
                withSpace
            }
            CbToggle(isOn: isOn, disabled: disabled, action: toggle)
                .accessibilityLabel(toggleLabel)
                // The state belongs on the toggle (VoiceOver; `dynwf-toggle-<name>` reads it in the UI test).
                .accessibilityValue(isOn ? L("on") : L("off"))
                .accessibilityIdentifier(toggleIdentifier)
                .padding(.trailing, 8)
        }
    }

    private var withSpace: some View {
        row()
            .padding(.trailing, Self.slot)
            .contentShape(Rectangle())
    }
}

// ── Section, empty list, loading ────────────────────────────────────────────

/// The header of a section in the row language: with origin "[glyph] Project · Name" (project in the accent), without origin a
/// plain header in the same form. No sentence below — the explanation stands in the ⓘ sheet. The caller sets the spacing to a
/// section above (`.padding(.top, 14)`). The lists in the tile form take `CbTileHeader` (Kit/CbTile.swift).
struct CbSectionHeader: View {
    var origin: OriginKind? = nil
    /// Without a title the word of the origin stands ("Project", "Workspace").
    var title: String? = nil
    var name: String? = nil
    var count: Int? = nil

    var body: some View {
        HStack(spacing: 6) {
            if let origin {
                Image(systemName: origin.symbol)
                    .font(.symbol(11, weight: .semibold))
                    .foregroundStyle(origin == .project ? Color.accentColor : CbColor.textMuted)
            }
            Text(title ?? origin?.word ?? "")
                .cbFont(13, weight: .medium)
                .foregroundStyle(CbColor.textSecondary)
            if let name, !name.isEmpty {
                Text("· " + name)
                    .cbFont(13)
                    .foregroundStyle(CbColor.textMuted)
                    .lineLimit(1)
            }
            if let count {
                Text(String(count))
                    .cbFont(13, digitsEqual: true)
                    .foregroundStyle(CbColor.textMuted)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 8)
        .padding(.top, 4)
        .padding(.bottom, 6)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

/// The empty list: a glyph in a circle, a sentence and — if there is one — the way to create; in the middle of the ground,
/// without a surface. `identifier` stands on the SENTENCE (an identifier on the stack would override the children).
struct CbEmpty: View {
    var symbol = "sparkle"
    let text: String
    var identifier: String? = nil
    /// Label of the button; without a setting "Create".
    var button: String? = nil
    var buttonIdentifier: String? = nil
    var create: (() -> Void)? = nil

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: symbol)
                .font(.symbol(17, weight: .medium))
                .foregroundStyle(CbColor.textMuted)
                .frame(width: 44, height: 44)
                .background(.cbElevated, in: Circle())
                .accessibilityHidden(true)
            Text(text)
                .cbFont(14)
                .foregroundStyle(CbColor.textMuted)
                .multilineTextAlignment(.center)
                .cbIdentifier(identifier)
            if let create {
                CbTextButton(title: button ?? L("Create"), action: create)
                    .cbIdentifier(buttonIdentifier)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 36)
    }
}

/// Placeholder at the first load: the same row as a circle and two strokes, without cards (instead of `ListLoadingSkeleton`).
struct CbRowSkeleton: View {
    var rows = 4
    /// The tile form (Kit/CbTile.swift): rounded square instead of a circle, padding like `CbTileRow`.
    var tile = false
    private let widths: [CGFloat] = [150, 116, 170, 132]

    var body: some View {
        VStack(spacing: 2) {
            ForEach(0..<max(rows, 1), id: \.self) { i in
                let width = widths[i % widths.count]
                HStack(spacing: 12) {
                    if tile {
                        RoundedRectangle(cornerRadius: 9, style: .continuous).fill(.cbElevated).frame(width: 34, height: 34)
                    } else {
                        Circle().fill(.cbElevated).frame(width: 34, height: 34)
                    }
                    VStack(alignment: .leading, spacing: 7) {
                        Capsule().fill(.cbElevated).frame(width: width, height: 10)
                        Capsule().fill(.cbElevated).frame(width: width * 0.6, height: 8)
                    }
                    Spacer(minLength: 0)
                }
                .padding(.leading, tile ? 10 : 8)
                .padding(.trailing, tile ? 14 : 8)
                .padding(.vertical, tile ? 11 : 7)
            }
        }
        .shimmering()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(L("Loading…"))
    }
}

// ── ⓘ: the page's explanation ───────────────────────────────────────────────

/// The ⓘ in a page's header — opens its `CbInfoSheet`. Not to be confused with `CbInfoButton` (`Settings/SettingsKit.swift`):
/// that is the footnote on a settings row, a popover with one sentence.
struct CbHeaderInfoButton: View {
    /// Accessibility label, e.g. "About subagents" (translated).
    let label: String
    let identifier: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "info.circle")
                .font(.symbol(17))
                .foregroundStyle(CbColor.textMuted)
                .frame(width: 30, height: 30)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityIdentifier(identifier)
    }
}

/// A point in the ⓘ sheet: glyph in a small circle, a word, a sentence.
struct CbInfoDot {
    let symbol: String
    var tone: Color = CbColor.textSecondary
    let word: String
    let text: String

    init(symbol: String, tone: Color = CbColor.textSecondary, word: String, text: String) {
        self.symbol = symbol
        self.tone = tone
        self.word = word
        self.text = text
    }

    /// A point about an origin: its glyph, its tone, its word.
    init(origin: OriginKind, text: String) {
        self.init(symbol: origin.symbol, tone: origin.characterTone, word: origin.word, text: text)
    }
}

/// A page's explanations that would otherwise stand as a subtitle and under every section header — as a sheet behind the ⓘ: an
/// introductory sentence, points, a quiet foot.
struct CbInfoSheet: View {
    let title: String
    let intro: String
    var points: [CbInfoDot] = []
    var footnote: String? = nil
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    Text(intro)
                        .cbFont(15)
                        .foregroundStyle(CbColor.text)
                        .fixedSize(horizontal: false, vertical: true)
                    if !points.isEmpty {
                        VStack(alignment: .leading, spacing: 14) {
                            ForEach(Array(points.enumerated()), id: \.offset) { _, p in point(p) }
                        }
                    }
                    if let footnote, !footnote.isEmpty {
                        Text(footnote)
                            .cbFont(12.5)
                            .foregroundStyle(CbColor.textMuted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(18)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .cbSheetBase()
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { SheetClose { dismiss() } }
        }
    }

    private func point(_ p: CbInfoDot) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: p.symbol)
                .font(.symbol(12, weight: .semibold))
                .foregroundStyle(p.tone)
                .frame(width: 28, height: 28)
                .background(.cbElevated, in: Circle())
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(p.word).cbFont(13.5, weight: .semibold)
                Text(p.text)
                    .cbFont(13)
                    .foregroundStyle(CbColor.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

// ── The detail on tap ───────────────────────────────────────────────────────

/// An action of a detail sheet: label (translated), test-rig identifier, action. `symbol` and `destructive` apply only to the
/// end action (`CbDetailSheet.erase`): the default is real deleting — red, trash can, `role: .destructive`. An end action that
/// deletes NOTHING (dismissing a proposal) takes its own glyph and `destructive: false` and then stands quietly in
/// `CbColor.textSecondary`: red with a trash can belongs only to deleting.
struct CbSheetAction {
    let title: String
    let identifier: String
    var symbol = "trash"
    var destructive = true
    let action: () -> Void

    init(title: String, identifier: String, symbol: String = "trash", destructive: Bool = true, action: @escaping () -> Void) {
        self.title = title
        self.identifier = identifier
        self.symbol = symbol
        self.destructive = destructive
        self.action = action
    }
}

/// The sheet behind a row: what the row lacks, stacked without surfaces. The ✕ at the left of the bar, the primary action
/// (mostly "Edit") at the right; "Delete" in red at the end (a non-deleting end action quiet, see `CbSheetAction.destructive`).
/// `hint` stands quietly at the end — e.g. "Edit at workspace level." where the entry is not editable here.
///
///     .sheet(item: $detail, onDismiss: afterTheDetail) { e in
///         CbDetailSheet(primaer: CbSheetAction(title: L(“Edit”), identifier: "x-detail-edit") { … },
///                        closeIdentifier: "x-detail-close",
///                        erase: CbSheetAction(title: L(“Delete”), identifier: "x-detail-delete") { … }) {
///             CbDetailHeader(character: CbSign(symbol: "…", tone: …), title: e.name) {
///                 CbOriginRow(kind: .project)
///             }
///             CbDetailDescription(text: e.description, empty: L(“(no description)”))
///             CbDetailField(L(“Command”)) { CbCodeBox(text: e.command, horizontal: true) }
///         }
///         .cbSheet(.half)
///     }
struct CbDetailSheet<Content: View>: View {
    var primary: CbSheetAction? = nil
    let closeIdentifier: String
    var erase: CbSheetAction? = nil
    var hint: String? = nil
    @ViewBuilder let content: () -> Content
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    content()
                    if let erase {
                        Button(role: erase.destructive ? .destructive : nil, action: erase.action) {
                            Label(erase.title, systemImage: erase.symbol)
                                .cbFont(14, weight: .medium)
                                .foregroundStyle(erase.destructive ? Color.red : CbColor.textSecondary)
                                .padding(.vertical, 6)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier(erase.identifier)
                    }
                    if let hint, !hint.isEmpty {
                        Text(hint)
                            .cbFont(12.5)
                            .foregroundStyle(CbColor.textMuted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 18)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .cbSheetBase()
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                SheetClose(identifier: closeIdentifier) { dismiss() }
                if let primary {
                    ToolbarItem(placement: .confirmationAction) {
                        Button(primary.title, action: primary.action)
                            .accessibilityIdentifier(primary.identifier)
                    }
                }
            }
        }
    }
}

/// The header of a detail sheet: the glyph large (48 pt), the name in the sheets' title step, below a quiet line (12.5 pt, muted —
/// e.g. `CbOriginRow`).
struct CbDetailHeader<Under: View>: View {
    let character: CbSign
    let title: String
    var titleMono = false
    var titleIdentifier: String? = nil
    let subline: Under

    init(
        character: CbSign,
        title: String,
        titleMono: Bool = false,
        titleIdentifier: String? = nil,
        @ViewBuilder subline: () -> Under
    ) {
        self.character = character
        self.title = title
        self.titleMono = titleMono
        self.titleIdentifier = titleIdentifier
        self.subline = subline()
    }

    var body: some View {
        HStack(spacing: 14) {
            large
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .cbTitle(.sheet, mono: titleMono)
                    .foregroundStyle(CbColor.text)
                    .lineLimit(2)
                    .cbIdentifier(titleIdentifier)
                subline
                    .cbFont(12.5)
                    .foregroundStyle(CbColor.textMuted)
            }
            Spacer(minLength: 0)
        }
    }

    private var large: CbSign {
        var z = character
        z.size = 48
        return z
    }
}

extension CbDetailHeader where Under == EmptyView {
    init(character: CbSign, title: String, titleMono: Bool = false, titleIdentifier: String? = nil) {
        self.init(character: character, title: title, titleMono: titleMono, titleIdentifier: titleIdentifier) { EmptyView() }
    }
}

/// The quiet line under the name in the detail header: glyph and word of the origin, then "· …" per addition ("Active",
/// "stdio", …).
struct CbOriginRow: View {
    let kind: OriginKind
    var addition: [String] = []

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: kind.symbol)
                .font(.symbol(10, weight: .semibold))
            Text(kind.word)
                .cbFont(12.5)
            ForEach(Array(addition.enumerated()), id: \.offset) { _, z in
                Text("·").cbFont(12.5)
                Text(z).cbFont(12.5)
            }
        }
        .foregroundStyle(CbColor.textMuted)
        .accessibilityElement(children: .combine)
    }
}

/// The description at the top of the detail: 15 pt, selectable; when empty, `empty` stands muted.
struct CbDetailDescription: View {
    let text: String
    let empty: String

    var body: some View {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        Text(t.isEmpty ? empty : t)
            .cbFont(15)
            .foregroundStyle(t.isEmpty ? CbColor.textMuted : CbColor.text)
            .fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled)
    }
}

/// A field in the detail: the mark small and muted above it (`CbOverline`), the value below — without a surface.
struct CbDetailField<Content: View>: View {
    let marker: String
    @ViewBuilder let content: () -> Content

    init(_ marker: String, @ViewBuilder content: @escaping () -> Content) {
        self.marker = marker
        self.content = content
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            CbOverline(marker)
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Names (tools, skills, environment variables) as wrapping marks — capsules on `CbColor.elevated`.
struct CbMarks: View {
    let names: [String]
    /// Fixed-width type for identifiers (default); words in the text font with `mono: false`.
    var mono = true

    var body: some View {
        ChipFlow(spacing: 6, lineSpacing: 6) {
            ForEach(Array(names.enumerated()), id: \.offset) { _, name in
                Text(name)
                    .cbFont(12, design: mono ? .monospaced : nil)
                    .foregroundStyle(CbColor.text)
                    .lineLimit(1)
                    .padding(.horizontal, 9)
                    .padding(.vertical, 4)
                    .background(.cbElevated, in: Capsule())
            }
        }
    }
}

/// A box of fixed-width text (system prompt, command, content), selectable. `horizontal`: a long line does not wrap but scrolls
/// (commands, paths, URLs).
struct CbCodeBox: View {
    let text: String
    var horizontal = false
    var identifier: String? = nil

    var body: some View {
        Group {
            if horizontal {
                ScrollView(.horizontal, showsIndicators: false) {
                    rows.fixedSize()
                }
            } else {
                rows.fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.cbElevated, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private var rows: some View {
        Text(text)
            .cbFont(12.5, design: .monospaced)
            .foregroundStyle(CbColor.text)
            .textSelection(.enabled)
            .cbIdentifier(identifier)
    }
}

// ── Split out of Managing ───────────────────────────────────────────────────────────────

// ── Small marker in a row (running · error · model) ─────────────────────────
struct AgentMarker: View {
    enum Tone { case neutral, accent, warn, ok, danger }
    let text: String
    var tone: Tone = .neutral

    init(_ text: String, tone: Tone = .neutral) {
        self.text = text
        self.tone = tone
    }

    private var color: Color {
        switch tone {
        case .neutral: return .secondary
        case .accent: return .accentColor
        case .warn: return .orange
        case .ok: return .green
        case .danger: return .red
        }
    }

    var body: some View {
        Text(text)
            .cbFont(10, weight: .semibold)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .foregroundStyle(color)
            .background(color.opacity(0.14), in: Capsule())
            .lineLimit(1)
    }
}

/// A wrapping chip row: lays the children side by side and starts a new line as soon as the width no longer suffices. SwiftUI
/// brings nothing for this — `HStack` never wraps, `LazyVGrid` demands fixed columns and would tear apart the differently wide tabs.
struct ChipFlow: Layout {
    var spacing: CGFloat = 6
    var lineSpacing: CGFloat = 6

    /// Compute the line breaks ONCE — sizeThatFits and placeSubviews must see exactly the same result, otherwise the reported
    /// height differs from the drawn one.
    private func lines(_ subviews: Subviews, width: CGFloat) -> [[(index: Int, size: CGSize)]] {
        var out: [[(index: Int, size: CGSize)]] = [[]]
        var x: CGFloat = 0
        for (i, sub) in subviews.enumerated() {
            let size = sub.sizeThatFits(.unspecified)
            if !out[out.count - 1].isEmpty && x + size.width > width {
                out.append([])
                x = 0
            }
            out[out.count - 1].append((i, size))
            x += size.width + spacing
        }
        return out
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        let rows = lines(subviews, width: width)
        // Deliberately loops and not a reduce/map chain: the type checker needed "unreasonable time" on the chain and aborted the
        // build.
        var height: CGFloat = 0
        var widest: CGFloat = 0
        for (i, row) in rows.enumerated() {
            var rowHeight: CGFloat = 0
            var rowWidth: CGFloat = 0
            for item in row {
                rowHeight = max(rowHeight, item.size.height)
                rowWidth += item.size.width
            }
            rowWidth += spacing * CGFloat(max(0, row.count - 1))
            widest = max(widest, rowWidth)
            height += rowHeight
            if i > 0 { height += lineSpacing }
        }
        return CGSize(width: min(widest, width), height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in lines(subviews, width: bounds.width) {
            var x = bounds.minX
            var rowHeight: CGFloat = 0
            for item in row { rowHeight = max(rowHeight, item.size.height) }
            for item in row {
                subviews[item.index].place(
                    at: CGPoint(x: x, y: y + (rowHeight - item.size.height) / 2),
                    proposal: ProposedViewSize(item.size))
                x += item.size.width + spacing
            }
            y += rowHeight + lineSpacing
        }
    }
}
