import SwiftUI
import UIKit

// ── The app's palette: warm and almost colorless ─────────────────────────────────────────
//
// A cream-colored resp. warm-dark ground, the drawer one step darker than the card above it, rows without cards, a light primary
// button. The SEMANTIC system colors cannot do this: in dark they carry a blue cast (#1c1c1e, #2c2c2e, #3a3a3c) and cannot be
// warmed through any trait. Hence this ONE table of own roles.
//
// Dark is one step darker than the system: ground, surface, elevated, selection ≈ 3.2–3.5 L* deeper, drawer 2.3, edge 2.8 — as much
// as one palette step. The gaps ground → surface → elevated → selection stay (3.98 / 3.88 / 5.58 L*); the drawer stays the darkest,
// its gap shrinks to 3.76 L* — it should go no deeper than #0e0e0d, or it reads as black. Light is unchanged, and so are the
// texts: on darker surfaces every contrast rises.
//
// Rules:
//  – Paint new surfaces, edges and texts ONLY with `CbColor.*`, never with the system surfaces (`system…Background`,
//    `…SystemFill`) or the system edge (`separator`) — a new system surface would stand out as a cold patch in the warm picture
//    (no guard catches this, the rule is here).
//  – The values are warm: blue ≤ red in every value. The hierarchy comes from lightness steps, not from color; color is
//    carried only by the accent (`Kit/AccentColor.swift`).
//  – `textMuted` reaches ≥ 4.5 : 1 on `ground`, `surface` and `elevated` in both appearances, on `selection` (dark) it does not —
//    only primary text goes there.
//  – Every role exists as a `Color` (`CbColor.ground`) and as a dynamic `UIColor` (`CbColor.ui(.ground)`). Both follow ONLY
//    `userInterfaceStyle`, not the level — the level affects only the parts the system paints: `ListLevel` sets the inside of
//    every Form/List to the base, `WindowLevel` the rest of the main window to the elevated step (both `Kit/Theme.swift`).
//  – Every Form/List is `CbForm`/`CbList` (below): ground `ground`, rows `surface` in dark (the system's white in light) — never
//    `Form`/`List` alone, or the system also paints the rows in dark (cold #1c1c1e resp. #2c2c2e). An own row color only via
//    `.cbRows(_:)`, never `.listRowBackground(Color)`: that loses the pressed feedback.
//  – System colors stay where they measure neutral: `.primary`/`.secondary`/`.tertiary` as text,
//    `Color.secondary/primary.opacity(…)`, `Divider()`, the status colors.
enum CbColor {
    enum Role: CaseIterable {
        /// Both drawers and the ground under the shell card.
        case drawer
        /// Shell card, pages, chat stage, headers, bars, sheet and form ground.
        case ground
        /// Cards and list surfaces (`CbPane`, `PaneCard`), in dark the rows of every Form/List (`CbForm`/`CbList`), composer
        /// island, search field.
        case surface
        /// One step on a surface: plus circle, chips, segment rail, code and tool boxes, strip stack, user bubble.
        case elevated
        /// The sliding thumb of the segment bars — only primary text on it; in dark also the pressed row of a Form/List
        /// (`RowsReason`, Kit/Theme.swift).
        case selection
        /// The selected row in drawer and lists (instead of the accent with opacity).
        case marked
        /// Hairline edges on cards, island, shell card and bars.
        case edge
        /// Primary text of new views, text in the user bubble and in the input field.
        case text
        /// Greeting, quiet headers, workspace-row glyphs, paragraph text in list rows.
        case textSecondary
        /// Section headers, placeholders, inactive tabs, scope row.
        case textMuted
        /// The primary button (light on dark resp. dark on light).
        case primaryButton
        /// The text on the primary button.
        case primaryButtonText

        /// (light, dark) — the ONE table. Contrasts computed with WCAG luminance; the accent promise against these surfaces is
        /// checked by `web/test/accent.test.mjs` (`SURFACES`).
        var values: (light: String, dark: String) {
            switch self {
            case .drawer: return ("#f5f4ed", "#0e0e0d")
            case .ground: return ("#faf9f5", "#171716")
            case .surface: return ("#ffffff", "#1f1f1d")
            case .elevated: return ("#f0eee6", "#272725")
            case .selection: return ("#ffffff", "#333330")
            case .marked: return ("#ebe9df", "#272725")
            case .edge: return ("#e5e3da", "#2c2c2a")
            case .text: return ("#141413", "#ececea")
            case .textSecondary: return ("#3d3d3a", "#b5b3ad")
            case .textMuted: return ("#696862", "#9a9893")
            case .primaryButton: return ("#1f1e1d", "#ecebe6")
            case .primaryButtonText: return ("#faf9f5", "#1a1a19")
            }
        }
    }

    /// The role as a dynamic `UIColor` (light/dark by the view's appearance).
    static func ui(_ r: Role) -> UIColor {
        let h = AccentColor.uiColor(hex: r.values.light), d = AccentColor.uiColor(hex: r.values.dark)
        return UIColor { $0.userInterfaceStyle == .dark ? d : h }
    }

    // One `Color` per role, built once — a new `Color` per evaluation would be a different color to SwiftUI every time.
    static let drawer = Color(uiColor: ui(.drawer))
    static let ground = Color(uiColor: ui(.ground))
    static let surface = Color(uiColor: ui(.surface))
    static let elevated = Color(uiColor: ui(.elevated))
    static let selection = Color(uiColor: ui(.selection))
    static let marked = Color(uiColor: ui(.marked))
    static let edge = Color(uiColor: ui(.edge))
    static let text = Color(uiColor: ui(.text))
    static let textSecondary = Color(uiColor: ui(.textSecondary))
    static let textMuted = Color(uiColor: ui(.textMuted))
    static let primaryButton = Color(uiColor: ui(.primaryButton))
    static let primaryButtonText = Color(uiColor: ui(.primaryButtonText))
}

// ── Form and List in the palette ─────────────────────────────────────────────────────────
// `CbForm { … }` instead of `Form { … }`, `CbList { … }` instead of `List { … }` — for EVERY Form/List of the app. Ground `ground`,
// rows `surface` in dark: #1f1f1d on #171716, one palette step (ΔL* 3.98, 1.087 : 1; `textMuted` on it 5.73; the accent is held
// by `web/test/accent.test.mjs`, where `surface` is in `SURFACES`). In light the system keeps painting the rows (white =
// `surface` light).
// Why: left to the system, the dark rows were cold (#2c2c2e, too light; via `ListLevel` #1c1c1e, only 2.64 L* above the
// ground, 1.054 : 1) and the groups were barely visible on the device. Warm works only through `.listRowBackground`, and that
// takes effect on a `Section` or a `Group` of rows, not on the container itself (measured) — so the building block wraps the
// content ONCE in a `Group`. Measured in the simulator: it reaches sections, also in own views (`CbSettingGroup`), `ForEach`
// and the rows of an `.inline` picker. A row with its OWN `.listRowBackground` (e.g. `Color.clear` under cards or a primary
// button) keeps it — the inner value wins.
// `ListLevel` (Kit/Theme.swift) stays underneath: it sets the list to the base level so that whatever the system still paints
// in it does not jump to a sheet's elevated level.
// In a glass sheet (`cbSheet` in Kit/CbGlass.swift sets `cbGlassSheet`) the building block paints no ground (`cbSheetBase()`),
// and the rows are one step INTO glass in light and dark (`RowsReason(glass:)`: black resp. white at 7 %, pressed 13 %) —
// otherwise every group would stand as an opaque card on the glass. Outside a sheet unchanged.
struct CbForm<Content: View>: View {
    private let content: Content
    init(@ViewBuilder _ content: () -> Content) { self.content = content() }
    var body: some View {
        Form { Group { content }.cbRows() }.cbList()
    }
}

struct CbList<Content: View>: View {
    private let content: Content
    init(@ViewBuilder _ content: () -> Content) { self.content = content() }
    var body: some View {
        List { Group { content }.cbRows() }.cbList()
    }
}

extension View {
    /// Row ground of a Form/List: in dark the role (default `surface`; a PLAIN list takes `ground`, its rows span the full width)
    /// with the pressed state (`RowsReason`, Kit/Theme.swift), in light the system's. An own `.listRowBackground` (color) loses the
    /// pressed feedback — measured: the system lifts a pressed row to #3a3a3c, a color as row ground stays put.
    func cbRows(_ role: CbColor.Role = .surface) -> some View {
        modifier(CbRows(role: role))
    }
}

private struct CbRows: ViewModifier {
    let role: CbColor.Role
    @Environment(\.colorScheme) private var schema
    @Environment(\.cbGlassSheet) private var glassSheet

    func body(content: Content) -> some View {
        // In a glass sheet (`cbSheet`) one step INTO glass in light and dark (`CbGlass.inside`, pressed `CbGlass.selected`)
        // instead of an opaque row — otherwise every group would stand as a card on the glass.
        if glassSheet {
            content.listRowBackground(RowsReason(role: role, glass: true))
        } else {
            content.listRowBackground(schema == .dark ? RowsReason(role: role) : nil)
        }
    }
}

private extension View {
    /// Ground of the list in the palette and `ListLevel` — only for `CbForm`/`CbList` (private: a bare
    /// `Form { … }.cbList()` would leave the rows with the system again).
    func cbList() -> some View {
        scrollContentBackground(.hidden).cbSheetBase().background(ListLevel())
    }
}
