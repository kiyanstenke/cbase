import SwiftUI
import UIKit

// ── Appearance: the accent color ─────────────────────────────────────────────────────────
//
// The user picks the accent with a color picker. Without a choice the accent comes from `Assets.xcassets/AccentColor`. A device
// preference like color scheme and text size: UserDefaults, no server.
//
// The DEFAULT on iOS is terracotta #a94c2d (dark #d47353), from the palette in `Kit/CbColor.swift`. The web keeps cobalt, so
// the defaults of the two sides deliberately differ. #a94c2d is exactly the derivation of itself (unclamped in light, dark
// #d47353) — asset and computation agree. Claude's originals (#c96442, #d97757) fail the light rule below (white on them is 3.90
// and 3.12) and would be clamped to ≈ #aa4b2b anyway.
//
// ONE color is chosen; light and dark are DERIVED from it — the same computation as on the web (`web/src/lib/accent.ts`, which has
// the full rationale), number for number. The promise: as text, the accent is never weaker on any surface than cobalt on the same
// one — in light every surface is lighter than it, in dark every one darker, so the promise is a luminance bound:
//   light = the choice; pulled darker (OKLCH L) only when it is lighter than cobalt #1f57f7
//           — white text on it is then as with cobalt (≥ 5.5 : 1)
//   dark  = a quarter of the way toward white, chroma kept, then clamped to the band
//           "never darker than #4d89ff, and white text on it ≥ 3 : 1"
// On the dark surfaces of the palette (`CbColor`) that means on `drawer` #0e0e0d ≥ 5.83 : 1, on `ground` #171716 ≥ 5.41, on
// `surface` #1f1f1d (also the rows of every Form/List, `CbForm`/`CbList`) ≥ 4.98, on `elevated` #272725 ≥ 4.52, on `selection`
// #333330 ≥ 3.82 — in each case cobalt, never below (terracotta: 5.86 / 5.45 / 5.01 / 4.54 / 3.85); on the base level #1c1c1e
// (`ListLevel`, what the system still paints itself in a list) ≥ 5.14, on the elevated #2c2c2e (`WindowLevel`, main window)
// ≥ 4.21. White on terracotta: light 5.59, dark 3.29.
// So every `.foregroundStyle(.white)` on an accent surface (capsules, counters, `.borderedProminent` buttons) stays legible
// without any of those places knowing about it. The app's tinted surfaces are `Color.accentColor.opacity(…)` here — they follow
// by themselves.
//
// It is applied at the root (`cbAccentRoot()`: `.tint` + `.accentColor` + the window tint for UIKit) and at every place that
// does NOT inherit the SwiftUI environment — EVERY own host (`UIHostingController`, `UIHostingConfiguration`) whose content shows
// the accent: hosted cells and composer of the chat stage, the workflow editor and its card surface (`cbAccent()` or
// `CbAccentWrapper`). The stage's jump arrow (`arrowHost`) shows no accent. A new host needs the same.
//
// Without a choice the default applies EXPLICITLY (`defaultDynamic()`, same values as the asset) — at `.tint`, `.accentColor`
// and the window. `.tint(store.color ?? .accentColor)` is the trap: `Color.accentColor` as the tint at the root resolved to iOS
// system blue across the main tree (back arrow, counters, context bar, usage rings), while sheets that miss the root tint showed
// the right color. The tint points to itself there (`Color.accentColor` reads the tint under `.accentColor(nil)`) and falls
// back to the system value; with an explicit color the whole tree is right (simulator, both appearances).

enum AccentColor {
    static let key = "cbase.mobile.accent"
    /// Terracotta — the iOS default (the web keeps cobalt). Choosing it means: no choice.
    static let standard = "#a94c2d"
    /// The values of the `AccentColor` asset (light, dark) — they apply while nothing is chosen.
    /// Exactly `derive(standard)`: no deviation between asset and computation.
    static let defaultValues = (light: "#a94c2d", dark: "#d47353")

    /// The presets. `label` is the `L()` key. Each is its own accent in light (teal, green and rose as the clamp pulls them).
    /// Cobalt, the old default, stays one tap away; "Amber" (#aa4c00) was dropped — barely distinguishable from terracotta. A
    /// stored choice stays valid (it then appears as its own color).
    static let defaults: [(hex: String, label: String)] = [
        (standard, "Default"),
        ("#1f57f7", "Cobalt"), // the former default (and the web's)
        ("#483ce4", "Indigo"), // the former accent
        ("#7c3aed", "Violet"),
        ("#0b746d", "Teal"),
        ("#037836", "Green"),
        ("#d0003d", "Rose"),
        ("#52525b", "Graphite"),
    ]

    struct Derivation: Equatable {
        let base: String
        let light: String
        let dark: String
    }

    /// `#rrggbb` in lowercase, or `nil` for anything but `#rgb`/`#rrggbb` (the `#` may be missing).
    static func norm(_ input: String?) -> String? {
        guard var h = input?.trimmingCharacters(in: .whitespaces).lowercased() else { return nil }
        if h.hasPrefix("#") { h.removeFirst() }
        guard h.count == 3 || h.count == 6, h.allSatisfy({ $0.isHexDigit && $0.isASCII }) else { return nil }
        if h.count == 3 { h = h.map { "\($0)\($0)" }.joined() }
        return "#" + h
    }

    /// The stored choice — `nil` means default (nothing stored, invalid, or terracotta).
    static func saved() -> String? {
        let v = norm(UserDefaults.standard.string(forKey: key))
        return v == standard ? nil : v
    }

    /// What REALLY applies for a choice in both appearances — for the default, the values of the asset.
    static func values(_ hex: String?) -> (light: String, dark: String) {
        guard let a = derive(hex), a.base != standard else { return defaultValues }
        return (a.light, a.dark)
    }

    /// The derivation — line for line the web's (`deriveAccent`).
    static func derive(_ input: String?) -> Derivation? {
        guard let base = norm(input), let n = Int(base.dropFirst(), radix: 16) else { return nil }
        func lin(_ c: Double) -> Double { c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4) }
        func gam(_ c: Double) -> Double { c <= 0.0031308 ? 12.92 * c : 1.055 * pow(c, 1 / 2.4) - 0.055 }
        func channel(_ x: Int, _ s: Int) -> Double { Double((x >> s) & 255) / 255 }
        func lum(_ hx: String) -> Double {
            let x = Int(hx.dropFirst(), radix: 16) ?? 0
            return 0.2126 * lin(channel(x, 16)) + 0.7152 * lin(channel(x, 8)) + 0.0722 * lin(channel(x, 0))
        }
        // sRGB → OKLab (Björn Ottosson)
        let r = lin(channel(n, 16)), g = lin(channel(n, 8)), b = lin(channel(n, 0))
        let l1 = cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
        let m1 = cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
        let s1 = cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
        let L0 = 0.2104542553 * l1 + 0.793617785 * m1 - 0.0040720468 * s1
        let A0 = 1.9779984951 * l1 - 2.428592205 * m1 + 0.4505937099 * s1
        let B0 = 0.0259040371 * l1 + 0.7827717662 * m1 - 0.808675766 * s1
        var C0 = (A0 * A0 + B0 * B0).squareRoot()
        if C0 < 0.002 { C0 = 0 } // gray: the hue would be noise
        let hue = atan2(B0, A0)
        func linRgb(_ L: Double, _ C: Double) -> [Double] {
            let a = C * cos(hue), bb = C * sin(hue)
            let l = pow(L + 0.3963377774 * a + 0.2158037573 * bb, 3)
            let m = pow(L - 0.1055613458 * a - 0.0638541728 * bb, 3)
            let s = pow(L - 0.0894841775 * a - 1.291485548 * bb, 3)
            return [
                4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
                -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
                -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
            ]
        }
        func inside(_ v: [Double]) -> Bool { v.allSatisfy { $0 >= -1e-7 && $0 <= 1 + 1e-7 } }
        // The color at L and C — outside sRGB the chroma is pulled back.
        func color(_ L: Double, _ C: Double) -> [Double] {
            let v = linRgb(L, C)
            if inside(v) { return v }
            var lo = 0.0, hi = C
            for _ in 0..<22 {
                let mid = (lo + hi) / 2
                if inside(linRgb(L, mid)) { lo = mid } else { hi = mid }
            }
            return linRgb(L, lo)
        }
        func hex(_ v: [Double]) -> String {
            "#" + v.map { c -> String in
                let k = Int((min(1, max(0, gam(min(1, max(0, c))))) * 255).rounded())
                return String(format: "%02x", k)
            }.joined()
        }
        // Shift L until the luminance of the ROUNDED value lies in the band (bisection) —
        // the shipped value is what gets compared, so the edges need no margin.
        func clamp(_ L: Double, _ C: Double, _ bottom: Double, _ top: Double) -> String {
            let x = hex(color(L, C)), y = lum(x)
            if y > top {
                var lo = 0.0, hi = L
                for _ in 0..<26 { let mid = (lo + hi) / 2; if lum(hex(color(mid, C))) > top { hi = mid } else { lo = mid } }
                return hex(color(lo, C))
            }
            if y < bottom {
                var lo = L, hi = 1.0
                for _ in 0..<26 { let mid = (lo + hi) / 2; if lum(hex(color(mid, C))) < bottom { lo = mid } else { hi = mid } }
                return hex(color(hi, C))
            }
            return x
        }
        // The limits are cobalt's (= globals.css on the web) — the yardstick of the promise, not the asset (which now carries
        // terracotta). So the computation stays the number-for-number twin of `web/src/lib/accent.ts`.
        let kLight = lum("#1f57f7"), kDark = lum("#4d89ff")
        // 0.295: white text on the dark accent ≥ 3 : 1 (⇔ ≤ 0.30), with margin.
        return Derivation(
            base: base,
            light: lum(base) <= kLight ? base : clamp(L0, C0, 0, kLight),
            dark: clamp(L0 + (1 - L0) * 0.25, C0, kDark, 0.295)
        )
    }

    static func uiColor(hex: String) -> UIColor {
        let x = Int(hex.dropFirst(), radix: 16) ?? 0
        return UIColor(
            red: CGFloat((x >> 16) & 255) / 255, green: CGFloat((x >> 8) & 255) / 255,
            blue: CGFloat(x & 255) / 255, alpha: 1
        )
    }

    /// The default (`defaultValues`) as a dynamic color — without a choice the accent at root, hosts and window (see the header:
    /// `Color.accentColor` as the tint fell back to system blue).
    static func defaultDynamic(alpha: CGFloat = 1) -> UIColor {
        let light = uiColor(hex: defaultValues.light).withAlphaComponent(alpha)
        let dark = uiColor(hex: defaultValues.dark).withAlphaComponent(alpha)
        return UIColor { $0.userInterfaceStyle == .dark ? dark : light }
    }

    /// The accent of a choice as a dynamic color (light/dark by the view's appearance).
    /// `nil` without a choice — then the default applies (`defaultDynamic`).
    static func dynamic(_ hex: String?, alpha: CGFloat = 1) -> UIColor? {
        guard let a = derive(hex), a.base != standard else { return nil }
        let light = uiColor(hex: a.light).withAlphaComponent(alpha)
        let dark = uiColor(hex: a.dark).withAlphaComponent(alpha)
        return UIColor { $0.userInterfaceStyle == .dark ? dark : light }
    }

    /// A `Color` (from the ColorPicker) as `#rrggbb` in sRGB.
    static func hex(from color: Color) -> String? {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        guard UIColor(color).getRed(&r, green: &g, blue: &b, alpha: &a) else { return nil }
        let k = { (c: CGFloat) in Int((min(1, max(0, c)) * 255).rounded()) }
        return String(format: "#%02x%02x%02x", k(r), k(g), k(b))
    }
}

/// The store — a singleton like `ChatFontStore`: the settings live in a sheet, and root, hosted cells and the settings page
/// reach the same value through `shared`.
@MainActor
final class AccentStore: ObservableObject {
    static let shared = AccentStore()

    /// `nil` = default (terracotta).
    @Published private(set) var hex: String?
    /// The EFFECTIVE accent — the default without a choice, never `nil` (see the header). Built once per choice, not per
    /// evaluation: a fresh `Color` would be a different tint to SwiftUI every time, and every cell would re-render. The default is
    /// likewise ONE object (`standardUI`).
    private(set) var color: Color
    private(set) var uiColor: UIColor

    private static let standardUI = AccentColor.defaultDynamic()
    private static let defaultColor = Color(uiColor: standardUI)

    private init() {
        let choice = AccentColor.saved()
        hex = choice
        (uiColor, color) = Self.effective(choice)
    }

    private static func effective(_ choice: String?) -> (UIColor, Color) {
        guard let ui = AccentColor.dynamic(choice) else { return (standardUI, defaultColor) }
        return (ui, Color(uiColor: ui))
    }

    /// Save + apply. `nil`, invalid or the default means: back to the default.
    func set(_ input: String?) {
        let v = AccentColor.norm(input)
        let choice = v == AccentColor.standard ? nil : v
        if let choice { UserDefaults.standard.set(choice, forKey: AccentColor.key) }
        else { UserDefaults.standard.removeObject(forKey: AccentColor.key) }
        guard hex != choice else { return }
        (uiColor, color) = Self.effective(choice)
        hex = choice
    }
}

/// `.tint` and `.accentColor` from the choice — ONE expression without `if`, so switching between default and custom color
/// does not change the identity of the tree below (the whole app would lose its state). Without a choice the default
/// explicitly, never `Color.accentColor` (see the header).
private struct AccentModifier: ViewModifier {
    @ObservedObject private var store = AccentStore.shared
    func body(content: Content) -> some View {
        content
            .tint(store.color)
            .accentColor(store.color)
    }
}

/// The root also tints the WINDOW: UIKit parts (text views with `UIColor.tintColor`, system sheets) read the accent there, not
/// from the SwiftUI environment.
private struct AccentRootModifier: ViewModifier {
    @ObservedObject private var store = AccentStore.shared
    func body(content: Content) -> some View {
        content
            .modifier(AccentModifier())
            .background(AccentWindow(color: store.uiColor))
    }
}

extension View {
    /// Accent from the setting — for trees that do NOT inherit the root's environment (hosted cells, own `UIHostingController`).
    func cbAccent() -> some View { modifier(AccentModifier()) }
    /// Only at the app root: like `cbAccent()`, plus the window tint.
    func cbAccentRoot() -> some View { modifier(AccentRootModifier()) }
}

/// `cbAccent()` as a named TYPE — for a `UIHostingController<…>` whose root type is fixed in the generic (no `some View`
/// there). The environment does not cross a hosting controller's boundary: without this wrapper a custom choice would go unnoticed there.
struct CbAccentWrapper<Content: View>: View {
    let content: Content
    var body: some View { content.cbAccent() }
}

/// Sets `window.tintColor` to the effective accent — even without a choice, so UIKit parts (caret, `UIColor.tintColor`) read the
/// same value as the SwiftUI tree instead of relying on a resolution that once landed on system blue.
private struct AccentWindow: UIViewRepresentable {
    let color: UIColor

    func makeUIView(context: Context) -> WindowView { WindowView() }
    func updateUIView(_ view: WindowView, context: Context) {
        view.color = color
        view.place()
    }

    final class WindowView: UIView {
        /// `nil` only between construction and the first `updateUIView`.
        var color: UIColor?

        override init(frame: CGRect) {
            super.init(frame: frame)
            isUserInteractionEnabled = false
        }
        required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

        override func didMoveToWindow() {
            super.didMoveToWindow()
            place()
        }

        func place() {
            guard let window, let color, window.tintColor !== color else { return }
            window.tintColor = color
        }
    }
}
