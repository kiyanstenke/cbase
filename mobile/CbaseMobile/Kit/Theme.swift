import SwiftUI
import UIKit

// Theme switch like in the desktop client: Automatic (system), Light, Dark. The choice lives in UserDefaults and takes effect
// via `preferredColorScheme` on the whole app.

enum ThemePreference: String, CaseIterable, Identifiable, Sendable {
    case system
    case light
    case dark

    var id: String { rawValue }

    var displayLabel: String {
        switch self {
        case .system: return "Automatic"
        case .light: return "Light"
        case .dark: return "Dark"
        }
    }

    var symbol: String {
        switch self {
        case .system: return "circle.lefthalf.filled"
        case .light: return "sun.max"
        case .dark: return "moon"
        }
    }

    var colorScheme: ColorScheme? {
        switch self {
        case .system: return nil
        case .light: return .light
        case .dark: return .dark
        }
    }
}

@MainActor
final class ThemeStore: ObservableObject {
    private static let key = "cbase.mobile.theme"

    @Published var preference: ThemePreference {
        didSet { UserDefaults.standard.set(preference.rawValue, forKey: Self.key) }
    }

    init() {
        preference = ThemePreference(rawValue: UserDefaults.standard.string(forKey: Self.key) ?? "system") ?? .system
    }

    func cycle() {
        switch preference {
        case .system: preference = .light
        case .light: preference = .dark
        case .dark: preference = .system
        }
    }
}

// ── The elevated level for the parts of the main window painted by the SYSTEM ────
// The app's surfaces come from `CbColor` (`Kit/CbColor.swift`, warm, light and dark) — a system color cannot do a warm tone. This
// trait on the window still holds the other parts the system paints IN THE MAIN WINDOW (e.g. `.roundedBorder` fields in chat
// cards) at the elevated step. Measured in the simulator with the level off: the form rows in SHEETS stay #2c2c2e without it — a
// sheet sets itself to the elevated step, the override on the window does not reach it —, and menus in the main window are
// pixel-identical (glass over the ground). The rows of every Form/List are painted by the palette (`CbForm`/`CbList`,
// Kit/CbColor.swift), their remaining inside is set by `ListLevel` (below) to the BASE. Dark only; light stays at the base.
// `traitOverrides` exists since iOS 17 (target 18).
struct WindowLevel: UIViewRepresentable {
    func makeUIView(context: Context) -> LevelsView { LevelsView() }
    func updateUIView(_ uiView: LevelsView, context: Context) { uiView.place() }

    final class LevelsView: UIView {
        override init(frame: CGRect) {
            super.init(frame: frame)
            isUserInteractionEnabled = false
            // When the appearance changes (switch or system), the level follows — the step belongs only to dark.
            registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (view: LevelsView, _: UITraitCollection) in
                view.place()
            }
        }
        required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

        override func didMoveToWindow() {
            super.didMoveToWindow()
            place()
        }

        // NEVER READ `window.traitOverrides.userInterfaceLevel`: without a set override UIKit throws ("Can't return value for trait
        // UserInterfaceLevel that has no override") — that crashed the app at start. The EFFECTIVE level is compared, removal goes via
        // `contains`.
        func place() {
            guard let window else { return }
            if window.traitCollection.userInterfaceStyle == .dark {
                if window.traitCollection.userInterfaceLevel != .elevated { window.traitOverrides.userInterfaceLevel = .elevated }
            } else if window.traitOverrides.contains(UITraitUserInterfaceLevel.self) {
                window.traitOverrides.remove(UITraitUserInterfaceLevel.self)
            }
        }
    }
}

// ── The base level inside every Form/List (`CbForm`/`CbList`) ────────────
// The lightest large surfaces of the app were the form rows: #2c2c2e, lighter than every palette surface except `elevated`.
// The system painted them, and almost all 72 containers stand in sheets that set THEMSELVES to the elevated step (see
// `WindowLevel`). In dark the palette now paints the ROWS (`surface` via `CbForm`/`CbList` and `RowsReason` below,
// Kit/CbColor.swift — values and measurement there); this level sets the list underneath to the BASE, so that whatever the
// system still paints in it (a row the palette ground does not reach) does not jump to #2c2c2e but stays at #1c1c1e — between
// `ground` #171716 and `surface` #1f1f1d. In light both levels are equal (white).
// Trap: a PLAIN list (`.listStyle(.plain)`) paints its rows without a ground of their own with the system's page ground, and on
// the base that is BLACK — the only one (`Chat/ChatArtifactSheets.swift`) therefore carries `.cbRows(.ground)`.
// It is set on the list's `UICollectionView`, not on the controller: the override applies exactly there and dies with it — on the
// controller it would stay after the list (in the main window: on the whole tree). The list is a SIBLING of this background, not
// an ancestor; the search goes from the ancestors downward for the tightest collection view that contains our frame. As with
// `WindowLevel`: NEVER read the override, the effective level is compared.
struct ListLevel: UIViewRepresentable {
    func makeUIView(context: Context) -> SearchView { SearchView() }
    func updateUIView(_ uiView: SearchView, context: Context) { uiView.place() }

    final class SearchView: UIView {
        private weak var list: UICollectionView?
        private var followedUp = false

        override init(frame: CGRect) {
            super.init(frame: frame)
            isUserInteractionEnabled = false
        }
        required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

        override func didMoveToWindow() {
            super.didMoveToWindow()
            followedUp = false
            place()
        }

        override func layoutSubviews() {
            super.layoutSubviews()
            place()
        }

        func place() {
            guard let window, !bounds.isEmpty else { return }
            if list?.window !== window { list = search(in: window) }
            guard let list else {
                // The collection view may hang in the tree only after this pass — catch up once.
                if !followedUp {
                    followedUp = true
                    DispatchQueue.main.async { [weak self] in self?.place() }
                }
                return
            }
            if list.traitCollection.userInterfaceLevel != .base { list.traitOverrides.userInterfaceLevel = .base }
        }

        private func search(in window: UIWindow) -> UICollectionView? {
            let target = convert(bounds, to: window)
            var ancestor = superview
            for _ in 0..<8 {
                guard let v = ancestor else { return nil }
                var candidates: [(list: UICollectionView, surface: CGFloat)] = []
                collect(in: v, target: target, window: window, depth: 6, candidates: &candidates)
                if let narrowest = candidates.min(by: { $0.surface < $1.surface }) { return narrowest.list }
                ancestor = v.superview
            }
            return nil
        }

        // A hit is a collection view that CONTAINS our frame (±1 pt), the smallest of several. Equal width would be too strict: the
        // collection view reaches under the safe area, our frame does not — in landscape ≈ 59 pt are missing on each side, and the list
        // stayed at the elevated level (#2c2c2e, measured). The frame via `superview.convert(frame)`: the `bounds` of a scroll view
        // start at the offset, not at 0.
        private func collect(
            in v: UIView, target: CGRect, window: UIWindow, depth: Int,
            candidates: inout [(list: UICollectionView, surface: CGFloat)]
        ) {
            if let collection = v as? UICollectionView {
                guard let top = collection.superview else { return }
                let r = top.convert(collection.frame, to: window)
                if r.insetBy(dx: -1, dy: -1).contains(target) { candidates.append((collection, r.width * r.height)) }
                return
            }
            guard depth > 0 else { return }
            for kind in v.subviews where kind !== self {
                collect(in: kind, target: target, window: window, depth: depth - 1, candidates: &candidates)
            }
        }
    }
}

// ── The row ground in dark, WITH pressed state (`cbRows()`) ──
// A color as `.listRowBackground` replaces the system's row ground including its feedback: pressed, the system lifts a row to
// #3a3a3c (measured, Settings → "Models" held), a color stays put — no sign that the finger hit. This layer finds the cell it lies
// in and follows its `isHighlighted`/`isSelected` (KVO, the collection view sets both via the setters): otherwise the role,
// pressed or selected `selection` #333330 (against `surface` ΔL* 9.5, 1.30 : 1; the system: ΔL* 14.1). The row text stands on it;
// `textMuted` holds 4.40 there — accepted for the moment of the press.
struct RowsReason: UIViewRepresentable {
    let role: CbColor.Role
    /// In the glass sheet (`cbSheet`): light and dark one step INTO glass — `CbGlass.inside`, pressed `CbGlass.selected` (black resp.
    /// white at 7 % / 13 %, like `Color.primary.opacity`) — instead of the palette surface.
    var glass = false

    func makeUIView(context: Context) -> ReasonView { ReasonView(role: role, glass: glass) }
    func updateUIView(_ uiView: ReasonView, context: Context) {
        uiView.glass = glass
        uiView.role = role
    }

    final class ReasonView: UIView {
        var role: CbColor.Role { didSet { place() } }
        var glass: Bool { didSet { if glass != oldValue { place() } } }
        private weak var cell: UICollectionViewCell?
        private var observer: [NSKeyValueObservation] = []

        init(role: CbColor.Role, glass: Bool) {
            self.role = role
            self.glass = glass
            super.init(frame: .zero)
            isUserInteractionEnabled = false
            place()
        }
        required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

        override func didMoveToWindow() {
            super.didMoveToWindow()
            var v = superview
            while let s = v, !(s is UICollectionViewCell) { v = s.superview }
            let fresh = v as? UICollectionViewCell
            if fresh !== cell {
                cell = fresh
                observer = fresh.map { z in
                    [\UICollectionViewCell.isHighlighted, \UICollectionViewCell.isSelected].map { path in
                        z.observe(path, options: [.new]) { [weak self] _, _ in
                            MainActor.assumeIsolated { self?.place() }
                        }
                    }
                } ?? []
            }
            place()
        }

        private func place() {
            let pressed = cell.map { $0.isHighlighted || $0.isSelected } ?? false
            if glass {
                // A PLAIN list (role `ground`, rows across the full width) stands in the glass without a step — only the press shows.
                let coverage: CGFloat = pressed ? 0.13 : (role == .ground ? 0 : 0.07)
                backgroundColor = UIColor { $0.userInterfaceStyle == .dark ? UIColor.white.withAlphaComponent(coverage) : UIColor.black.withAlphaComponent(coverage) }
            } else {
                backgroundColor = CbColor.ui(pressed ? .selection : role)
            }
        }
    }
}

// ── Shared measures of the mobile shell ─────────────────────────────────────
enum Metrics {
    static let topBarHeight: CGFloat = 42
    static let drawerMaxWidth: CGFloat = 330
    static let drawerWidthFactor: CGFloat = 0.82
    /// Corner radius of the raised shell card (`Shell/AppShell.swift`) — from iPhone 12 mini on the screen radius is ≥ 44 pt, so the
    /// rounding is invisible at the first pixel.
    static let cardsRadius: CGFloat = 44
}
