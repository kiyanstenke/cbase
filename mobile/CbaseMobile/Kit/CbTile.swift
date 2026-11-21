import SwiftUI

// ── The tile form of the lists ──────────────────────────────────────────────
//
// The form of the project pages as a kit, used by the lists of Coding: projects, project view, services, containers, subagents
// and outer loop, workflows (lists only), MCP, context, credentials. Twin on the web: `web/src/components/projects/ProjectForm.tsx`.
//
//  – in front of each row a TILE (`ProjectTile`): the SF symbol of the thing in the color of its SITUATION (`CbSituation`: green
//    on/running, orange transitional/waiting/warning, red error, muted off, otherwise quiet neutral) on `CbColor.elevated`, a
//    rounded square — never a system surface;
//  – NO hairlines between the rows: `VStack(spacing: 2)`, pressed the row lies rounded in `CbColor.marked`
//    (`.cbRowPress()`, Kit/CbRows.swift);
//  – above the list the summary ("3 subagents · 2 active", `CbSummary`);
//  – a section has a small tile with the symbol of its category before the title (`CbTileHeader`), a field of a sheet likewise
//    (`ProjectField` instead of `CbDetailField`);
//  – when empty, a row in the same form with a muted tile (`CbTileEmpty`).
//
// The names `ProjectTile`, `ProjectField` (and `projectStateColor` in Code/ProjectForm.swift) are those of the first version;
// they live in the kit now but were not renamed — Code/ is written against exactly these names.
//
// Pattern of a page (in full in `Code/McpPane.swift`):
//
//     ScrollView {
//         VStack(alignment: .leading, spacing: 0) {
//             InlineError(message: error).padding(.horizontal, 8)
//             if loading && list.isEmpty { CbRowSkeleton(tile: true) }
//             else if list.isEmpty { CbTileEmpty(symbol: "…", text: L(“…”), create: { … }) }
//             else {
//                 CbSummary(parts: …, identifier: "…-summary")
//                 CbTileHeader(symbol: "…", title: …, name: project.name, margin: true)
//                 VStack(spacing: 2) {
//                     ForEach(list) { e in
//                         Button { detail = e } label: {
//                             CbTileRow(symbol: "…", situation: .on, title: e.name, shortLine: Text(short(e)), chevron: true)
//                         }
//                         .cbRowPress()
//                         .contextMenu { … }
//                         .accessibilityIdentifier("…-\\(e.id)")
//                     }
//                 }
//             }
//         }
//         .padding(.horizontal, 8)
//         .padding(.bottom, 24)
//     }

// ── The situation ───────────────────────────────────────────────────────────

/// The situation of an entry — the color of its tile. The same language as `projectStateColor` (project container) and the
/// situation of an instance (`ProjectInstancesPage`).
enum CbSituation {
    /// No state that says anything (an entry that is simply there) — neutral.
    case quiet
    /// On, active, running, ready — green.
    case on
    /// Transitional, waiting, a warning (locked, without model) — orange.
    case waiting
    /// An error — red.
    case error
    /// Off, not adopted, already added — muted.
    case off

    var color: Color {
        switch self {
        case .quiet: return CbColor.textSecondary
        case .on: return .green
        case .waiting: return .orange
        case .error: return .red
        case .off: return CbColor.textMuted
        }
    }

    /// On or off — for a toggle (adopted, enabled).
    static func toggle(_ on: Bool) -> CbSituation { on ? .on : .off }
}

/// A state in a row: a small dot in the state's color and a word (already translated) — only while it says something ("Trigger
/// active", "running", "locked for agent").
struct CbState {
    let text: String
    let color: Color

    init(_ text: String, _ color: Color) {
        self.text = text
        self.color = color
    }
}

// ── The tile ────────────────────────────────────────────────────────────────

/// The tile before a row: an SF symbol in the situation's color on `CbColor.elevated`, a rounded square (not the circle of
/// `CbSign` — the tile is the form of the Coding lists). 34 pt in the list, 44 pt in the header, 26 pt before a field's title.
struct ProjectTile: View {
    let symbol: String
    var color: Color = CbColor.textSecondary
    var size: CGFloat = 34

    var body: some View {
        Image(systemName: symbol)
            .font(.symbol((size * 0.44).rounded(), weight: .medium))
            .foregroundStyle(color)
            .frame(width: size, height: size)
            .background(.cbElevated, in: RoundedRectangle(cornerRadius: (size * 0.265).rounded(), style: .continuous))
            .accessibilityHidden(true)
    }
}

// ── Header and field ────────────────────────────────────────────────────────

/// The header of a section or field: a small tile (26 pt) with the category's symbol, title, "· name" muted, optionally a figure
/// on the right. `margin`: in a list — flush with the tiles of the rows below (10 pt in the page's 8-pt margin), with some air above
/// and below. Without `margin` (in the field, `ProjectField`) the caller brings the spacing.
struct CbTileHeader: View {
    let symbol: String
    let title: String
    var name: String? = nil
    var right: String? = nil
    var symbolColor: Color = CbColor.textSecondary
    var margin = false

    init(symbol: String, title: String, name: String? = nil, right: String? = nil, symbolColor: Color = CbColor.textSecondary, margin: Bool = false) {
        self.symbol = symbol
        self.title = title
        self.name = name
        self.right = right
        self.symbolColor = symbolColor
        self.margin = margin
    }

    /// The header of an origin: "[folder] Project · Name" resp. "[stack] Workspace · Name" (glyph and word from `OriginKind`).
    init(origin: OriginKind, name: String? = nil, right: String? = nil, margin: Bool = false) {
        self.init(symbol: origin.symbol, title: origin.word, name: name, right: right, margin: margin)
    }

    var body: some View {
        HStack(spacing: 10) {
            ProjectTile(symbol: symbol, color: symbolColor, size: 26)
            Text(title)
                .cbFont(14.5, weight: .semibold)
                .foregroundStyle(CbColor.text)
                .lineLimit(1)
                .layoutPriority(1)
            if let name, !name.isEmpty {
                Text("· " + name)
                    .cbFont(14.5)
                    .foregroundStyle(CbColor.textMuted)
                    .lineLimit(1)
            }
            Spacer(minLength: 6)
            if let right {
                Text(right)
                    .cbFont(12.5, digitsEqual: true)
                    .foregroundStyle(CbColor.textMuted)
                    .lineLimit(1)
            }
        }
        .padding(.horizontal, margin ? 10 : 0)
        .padding(.top, margin ? 6 : 0)
        .padding(.bottom, margin ? 4 : 0)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

/// A field of a page or sheet: the header (`CbTileHeader` — small tile with the category's symbol, title, optionally a figure on
/// the right), below it the content. Replaces `CbDetailField` (small muted mark) — the tile is the anchor by which one recognizes
/// the category.
struct ProjectField<Content: View>: View {
    let title: String
    let symbol: String
    var right: String? = nil
    var symbolColor: Color = CbColor.textSecondary
    @ViewBuilder let content: () -> Content

    init(_ title: String, symbol: String, right: String? = nil, symbolColor: Color = CbColor.textSecondary, @ViewBuilder content: @escaping () -> Content) {
        self.title = title
        self.symbol = symbol
        self.right = right
        self.symbolColor = symbolColor
        self.content = content
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            CbTileHeader(symbol: symbol, title: title, right: right, symbolColor: symbolColor)
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// ── Summary ─────────────────────────────────────────────────────────────────

/// The summary above a list ("4 projects · 3 ready"): muted, equal-width digits, flush with the text of the project list
/// (`ProjectsPane`). `parts` without empty ones, joined by " · "; the identifier on the text.
struct CbSummary: View {
    let parts: [String]
    var identifier: String? = nil

    var body: some View {
        Text(verbatim: parts.filter { !$0.isEmpty }.joined(separator: " · "))
            .cbFont(13, digitsEqual: true)
            .foregroundStyle(CbColor.textMuted)
            .lineLimit(2)
            .padding(.horizontal, 14)
            .padding(.top, 4)
            .padding(.bottom, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
            .cbIdentifier(identifier)
    }
}

// ── The row ─────────────────────────────────────────────────────────────────

/// A row: tile (symbol in the situation's color), name, optionally the state as a dot plus word, ONE muted short line and a
/// paragraph of text only where it helps with choosing — like the row of the project list (`ProjectsPane`). Belongs as the label of
/// a `Button` with `.cbRowPress()` (then with `chevron: true` where tapping opens something) or quietly in a `CbToggleRow`.
///
///     Button { … } label: {
///         CbTileRow(symbol: "bolt.fill", situation: .on, title: flow.name, state: CbState(L(“Trigger active”), .green),
///                        shortLine: Text(short), text: flow.description, chevron: true)
///     }
///     .cbRowPress()
struct CbTileRow<Addition: View>: View {
    let symbol: String
    var situation: CbSituation = .quiet
    let title: String
    /// Fixed-width type for identifiers and commands as names.
    var titleMono = false
    var state: CbState?
    /// The ONE muted line (13 pt, single line, equal-width digits). A `Text`, so that parts can carry their own colors.
    var shortLine: Text?
    /// A paragraph (13.5 pt, `textSecondary`) — ONLY where it helps with choosing (a description).
    var text: String?
    var textLines: Int? = 2
    /// Off (not adopted, switched off, already added): name and paragraph muted, the tile in the situation `.off`.
    var active = true
    /// The discreet chevron at the end — the row opens something (sheet, editor).
    var chevron = false
    /// Room on the right for something that lies OVER the row. `CbToggleRow` holds the room for its toggle itself.
    var right: CGFloat = 0
    /// Something quiet before the chevron (a number, a quiet plus) — no button.
    let addition: Addition

    init(
        symbol: String,
        situation: CbSituation = .quiet,
        title: String,
        titleMono: Bool = false,
        state: CbState? = nil,
        shortLine: Text? = nil,
        text: String? = nil,
        textLines: Int? = 2,
        active: Bool = true,
        chevron: Bool = false,
        right: CGFloat = 0,
        @ViewBuilder addition: () -> Addition
    ) {
        self.symbol = symbol
        self.situation = situation
        self.title = title
        self.titleMono = titleMono
        self.state = state
        self.shortLine = shortLine
        self.text = text
        self.textLines = textLines
        self.active = active
        self.chevron = chevron
        self.right = right
        self.addition = addition()
    }

    private var paragraph: String? {
        guard let text else { return nil }
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? nil : t
    }

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            // The tile top-aligned with the name; a short entry stands centered beside it (`minHeight` = tile).
            HStack(alignment: .top, spacing: 12) {
                ProjectTile(symbol: symbol, color: (active ? situation : .off).color)
                VStack(alignment: .leading, spacing: 4) {
                    Text(title)
                        .tracking(-0.2)
                        .cbFont(16, weight: .medium, design: titleMono ? .monospaced : nil)
                        .foregroundStyle(active ? CbColor.text : CbColor.textMuted)
                        .lineLimit(1)
                    if let state {
                        HStack(spacing: 7) {
                            Circle().fill(state.color).frame(width: 6, height: 6)
                            Text(state.text)
                                .cbFont(13)
                                .foregroundStyle(CbColor.textSecondary)
                                .lineLimit(2)
                        }
                    }
                    if let shortLine {
                        shortLine
                            .cbFont(13, digitsEqual: true)
                            .foregroundStyle(CbColor.textMuted)
                            .lineLimit(1)
                    }
                    if let paragraph {
                        Text(paragraph)
                            .cbFont(13.5)
                            .foregroundStyle(active ? CbColor.textSecondary : CbColor.textMuted)
                            .lineLimit(textLines)
                            .multilineTextAlignment(.leading)
                            .padding(.top, 1)
                    }
                }
                .frame(minHeight: 34)
            }
            Spacer(minLength: 0)
            addition
            if chevron {
                Image(systemName: "chevron.right")
                    .font(.symbol(12, weight: .semibold))
                    .foregroundStyle(CbColor.textMuted)
                    .accessibilityHidden(true)
            }
        }
        .padding(.leading, 10)
        .padding(.trailing, 14 + right)
        .padding(.vertical, 11)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }
}

extension CbTileRow where Addition == EmptyView {
    init(
        symbol: String,
        situation: CbSituation = .quiet,
        title: String,
        titleMono: Bool = false,
        state: CbState? = nil,
        shortLine: Text? = nil,
        text: String? = nil,
        textLines: Int? = 2,
        active: Bool = true,
        chevron: Bool = false,
        right: CGFloat = 0
    ) {
        self.init(
            symbol: symbol, situation: situation, title: title, titleMono: titleMono, state: state, shortLine: shortLine, text: text,
            textLines: textLines, active: active, chevron: chevron, right: right, addition: { EmptyView() }
        )
    }
}

// ── Empty ───────────────────────────────────────────────────────────────────

/// The empty list in the form of a row: a muted tile with the list's symbol, a muted sentence, on the right — if there is one —
/// the quiet way to create. No surface, no hairlines. `identifier` stands on the SENTENCE (an identifier on the stack would override
/// the children), `buttonIdentifier` on the button.
struct CbTileEmpty: View {
    let symbol: String
    let text: String
    var identifier: String? = nil
    /// Label of the button; without a setting "Create".
    var button: String? = nil
    var buttonIdentifier: String? = nil
    var create: (() -> Void)? = nil

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            ProjectTile(symbol: symbol, color: CbSituation.off.color)
            Text(text)
                .cbFont(14.5)
                .foregroundStyle(CbColor.textMuted)
                .fixedSize(horizontal: false, vertical: true)
                .cbIdentifier(identifier)
            Spacer(minLength: 8)
            if let create {
                CbTextButton(title: button ?? L("Create"), action: create)
                    .cbIdentifier(buttonIdentifier)
            }
        }
        .padding(.leading, 10)
        .padding(.trailing, 6)
        .padding(.vertical, 11)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
