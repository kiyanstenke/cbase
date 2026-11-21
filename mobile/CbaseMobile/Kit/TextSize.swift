import SwiftUI
import UIKit

// ── Text size of the whole app ──────────────────────────────────────────────
//
// The text size from the settings applies to the WHOLE app, but relatively: headings etc. stay somewhat larger. About 750 fixed
// `.system(size:)` fonts used to ignore even the iPhone's own text size.
//
// The way is Dynamic Type for the WHOLE window, in three places:
//
//  1. `TextSize` is an OFFSET in categories from the system size (−2 … +2). "Normal" sets no override — the app then follows the
//     iPhone exactly, including the per-app text size from Control Center.
//  2. `WindowFont` sets the target category as a trait on the window (like `WindowLevel` in `Theme.swift`). A window trait reaches
//     `.sheet`, `.fullScreenCover`, popovers and UIKit children — an environment value did not even reliably reach the sheets here.
//  3. `cbFont(_:)` lets every fixed size follow the curve of its nearest text style (`FixedFont`, read via `@CbMetric`). At
//     category L it yields exactly the old point size — whoever never changes it and has the iPhone at L sees the same characters.
//
// Two rules apply ONLY to these fixed sizes, not to the semantic styles (`.body`, …):
//  – above AX2 they do not grow further (`FixedFont.upperLimit`): beyond it the app breaks on too many fixed frames (bars, pills,
//    cards). The semantic styles follow the iPhone up to AX5 — capping the whole WINDOW at AX2 would make the app look smaller
//    than before for anyone with the iPhone at AX3–AX5, even at "Normal";
//  – below L they follow the curve of Body (factor 0.82 / 0.88 / 0.94 at xS / S / M, like the steps on the web), with the web's
//    lower limit (9 pt): Apple's curve is flat there for small styles (caption2 stays 11 pt), and "Compact" would not have shrunk
//    228 of 559 fixed sizes at all.
//
// "Relative" here means Apple's curve: a heading grows by a smaller percentage than a footnote, but the ORDER of the sizes is kept at
// every step. SF symbols stay fixed (`Font.symbol`), like the SVG symbols on the web — a bar with a fixed height would otherwise
// outgrow its frame with every step.
//
// Guard: `tools/check/ios-font.test.mjs` — `.system(size:` stands only here and on its named exception list. Whoever writes a new
// fixed TEXT size is red; whoever means a symbol writes `.symbol(…)`.

/// The five steps — the same raw values as on the web (`cbase-text-size`) and as the former chat text size
/// (`cbase.mobile.chat-size`), so the old value migrates 1:1.
enum TextSize: String, CaseIterable, Identifiable, Sendable {
    case compact
    case small
    case normal
    case large
    case veryLarge

    var id: String { rawValue }

    /// Categories above (+) or below (−) the iPhone's text size. At system L that gives .small / .medium / L / .xLarge / .xxLarge —
    /// Body 15 / 16 / 17 / 19 / 21 pt, so almost exactly the web's factors (0.87 / 0.94 / 1 / 1.10 / 1.23).
    var offset: Int {
        switch self {
        case .compact: return -2
        case .small: return -1
        case .normal: return 0
        case .large: return 1
        case .veryLarge: return 2
        }
    }

    /// Position on the slider (0 … 4).
    var place: Int { Self.allCases.firstIndex(of: self) ?? 2 }

    init(place: Int) {
        let all = Self.allCases
        self = all[min(max(place, 0), all.count - 1)]
    }

    /// The English UI string IS the translation key. It stands in a property and not as a literal in the call to L — `loc-audit.sh`
    /// does not find it; the five keys are therefore noted explicitly in `LocDEMobile.swift`.
    var displayLabel: String {
        switch self {
        case .compact: return "Compact##adjective"
        case .small: return "Small"
        case .normal: return "Normal"
        case .large: return "Large"
        case .veryLarge: return "Extra large"
        }
    }

    /// The categories in Apple's order. `.unspecified` is not in it and counts as L.
    static let categories: [UIContentSizeCategory] = [
        .extraSmall, .small, .medium, .large, .extraLarge, .extraExtraLarge, .extraExtraExtraLarge,
        .accessibilityMedium, .accessibilityLarge, .accessibilityExtraLarge,
        .accessibilityExtraExtraLarge, .accessibilityExtraExtraExtraLarge,
    ]

    /// System size + offset, clamped to the iPhone's categories (`.extraSmall … AX5`). Pure computation. No upper limit of its own
    /// for the window: "Normal" is thus ALWAYS the iPhone's size, also above AX2 — the limit applies only to the fixed sizes
    /// (`FixedFont`). At the edge of the categories (xS downward, AX5 upward) a step changes nothing any more.
    static func target(system: UIContentSizeCategory, offset: Int) -> UIContentSizeCategory {
        let base = categories.firstIndex(of: system) ?? categories.firstIndex(of: .large)!
        return categories[min(max(base + offset, 0), categories.count - 1)]
    }
}

/// The store — built like `ThemeStore`, a singleton for the same reason as the former `ChatFontStore`: the settings live in a
/// sheet, and an `@EnvironmentObject` that does not arrive there is no build-time error but a runtime crash.
@MainActor
final class TextSizeStore: ObservableObject {
    static let shared = TextSizeStore()

    static let key = "cbase.mobile.textSize"
    /// The key of the former chat text size — read only while the new one is missing. It stays until a cleanup follow-up deletes it
    /// (a way back to the old build thus keeps its choice).
    static let oldKey = "cbase.mobile.chat-size"

    @Published var size: TextSize {
        didSet { UserDefaults.standard.set(size.rawValue, forKey: Self.key) }
    }

    private init() {
        size = Self.read(UserDefaults.standard)
    }

    /// Migration: if the new key is missing, the old one applies (same raw values) and is carried over. Whoever had "Large"
    /// (factor 1.10) in the chat now gets .xLarge — Body 17 → 19 pt (× 1.12), almost the same, only in the whole app.
    static func read(_ defaults: UserDefaults) -> TextSize {
        if let raw = defaults.string(forKey: key) {
            return TextSize(rawValue: raw) ?? .normal
        }
        if let old = defaults.string(forKey: oldKey), let stage = TextSize(rawValue: old) {
            defaults.set(stage.rawValue, forKey: key)
            return stage
        }
        return .normal
    }
}

/// Sets the target category as a trait on the window — mounted in `CbaseMobileApp` beside `WindowLevel`, by the same pattern.
struct WindowFont: UIViewRepresentable {
    @ObservedObject private var inventory = TextSizeStore.shared

    func makeUIView(context: Context) -> FontView { FontView() }

    func updateUIView(_ uiView: FontView, context: Context) {
        uiView.offset = inventory.size.offset
        uiView.place()
    }

    final class FontView: UIView {
        var offset = 0

        override init(frame: CGRect) {
            super.init(frame: frame)
            isUserInteractionEnabled = false
            // System size or per-app text size (Control Center) changed: the offset is computed from the NEW base. Via a selector —
            // NotificationCenter unregisters it itself when the view is torn down.
            NotificationCenter.default.addObserver(
                self, selector: #selector(systemSizeChanged),
                name: UIContentSizeCategory.didChangeNotification, object: nil
            )
        }
        required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

        @objc private func systemSizeChanged() { place() }

        override func didMoveToWindow() {
            super.didMoveToWindow()
            place()
        }

        // The BASE is the app's size (`UIApplication.preferredContentSizeCategory`), never the window's trait: after the first set it
        // carries our own override, and every step would then compute from the previous one. Under the override the app's value
        // stays put (measured).
        //
        // NEVER READ `window.traitOverrides.preferredContentSizeCategory`: without a set override UIKit throws — the same trap that
        // crashed the app with `userInterfaceLevel` (`WindowLevel`). The EFFECTIVE category is compared, removal goes via `contains`.
        func place() {
            guard let window else { return }
            let system = UIApplication.shared.preferredContentSizeCategory
            let target = TextSize.target(system: system, offset: offset)
            if target == system {
                if window.traitOverrides.contains(UITraitPreferredContentSizeCategory.self) {
                    window.traitOverrides.remove(UITraitPreferredContentSizeCategory.self)
                }
            } else if window.traitCollection.preferredContentSizeCategory != target {
                window.traitOverrides.preferredContentSizeCategory = target
            }
        }
    }
}

/// The smallest text style whose size at L is at least `pt` — a fixed size follows its curve. So a 13-pt row grows like
/// `.footnote` and a 20-pt heading like `.title3`.
func cbTextStyle(_ pt: CGFloat) -> Font.TextStyle {
    switch pt {
    case ...11: return .caption2
    case ...12: return .caption
    case ...13: return .footnote
    case ...15: return .subheadline
    case ...16: return .callout
    case ...17: return .body
    case ...20: return .title3
    case ...22: return .title2
    case ...28: return .title
    default: return .largeTitle
    }
}

/// The same mapping for UIKit (`UIFontMetrics`).
func cbUITextStyle(_ pt: CGFloat) -> UIFont.TextStyle {
    uiTextStyle(cbTextStyle(pt))
}

/// A semantic SwiftUI style as a UIKit style.
func uiTextStyle(_ style: Font.TextStyle) -> UIFont.TextStyle {
    switch style {
    case .largeTitle: return .largeTitle
    case .title: return .title1
    case .title2: return .title2
    case .title3: return .title3
    case .headline: return .headline
    case .subheadline: return .subheadline
    case .body: return .body
    case .callout: return .callout
    case .footnote: return .footnote
    case .caption: return .caption1
    case .caption2: return .caption2
    @unknown default: return .body
    }
}

/// The computation of every FIXED base size (`cbFont`, `@CbMetric`, headings in the marker text). Pure computation over
/// `UIFontMetrics`; the two rules stand at the top of the file.
enum FixedFont {
    /// Above AX2 fixed sizes do not grow further.
    static let upperLimit: UIContentSizeCategory = .accessibilityLarge
    /// Lower limit when shrinking — the same number as `TEXT_LOWER_LIMIT` on the web. What already lies below stays as it is.
    static let lowerLimit: CGFloat = 9

    /// `pt` at L → the size at `category`, on the curve of `style`.
    static func size(_ pt: CGFloat, style: UIFont.TextStyle, category: UIContentSizeCategory) -> CGFloat {
        let k = category == .unspecified ? UIContentSizeCategory.large : min(category, upperLimit)
        if k < .large {
            return max(min(pt, lowerLimit), pt * factor(.body, k))
        }
        return pt * factor(style, k)
    }

    /// Factor of the style at the category, relative to L. Cached per pair: `cbFont` stands at about 570 places, and each computes on
    /// every rebuild of its view. Read only from the main thread (view `body`).
    private static var remembered: [String: CGFloat] = [:]
    private static func factor(_ style: UIFont.TextStyle, _ k: UIContentSizeCategory) -> CGFloat {
        if k == .large { return 1 }
        let key = style.rawValue + "|" + k.rawValue
        if let f = remembered[key] { return f }
        let f = UIFontMetrics(forTextStyle: style).scaledValue(
            for: 100, compatibleWith: UITraitCollection(preferredContentSizeCategory: k)
        ) / 100
        remembered[key] = f
        return f
    }
}

/// Like `@ScaledMetric(relativeTo:)`, but by the rules of the fixed sizes (`FixedFont`): a number that must grow with fixed texts —
/// line height and number column of the code editor, the terminal's character grid. Reads the category from the environment (so the
/// window's trait).
@propertyWrapper
struct CbMetric: DynamicProperty {
    @Environment(\.dynamicTypeSize) private var stage
    private let base: CGFloat
    private let style: UIFont.TextStyle

    /// On the curve of the nearest text style of the base size (like `cbFont`).
    init(wrappedValue: CGFloat) {
        base = wrappedValue
        style = cbUITextStyle(wrappedValue)
    }

    /// On the curve of a named style (a line height follows its font, not its own number).
    init(wrappedValue: CGFloat, relativeTo style: Font.TextStyle) {
        base = wrappedValue
        self.style = uiTextStyle(style)
    }

    var wrappedValue: CGFloat {
        FixedFont.size(base, style: style, category: UIContentSizeCategory(stage))
    }
}

private struct CbFontModifier: ViewModifier {
    @CbMetric private var size: CGFloat
    let weight: Font.Weight?
    let design: Font.Design?
    let digitsEqual: Bool

    init(pt: CGFloat, weight: Font.Weight?, design: Font.Design?, digitsEqual: Bool) {
        _size = CbMetric(wrappedValue: pt)
        self.weight = weight
        self.design = design
        self.digitsEqual = digitsEqual
    }

    func body(content: Content) -> some View {
        var f = Font.system(size: size, weight: weight, design: design)
        if digitsEqual { f = f.monospacedDigit() }
        return content.font(f)
    }
}

extension View {
    /// Font with a fixed base size that follows the text size (see above). Replaces `.font(.system(size:weight:design:))` for TEXT.
    func cbFont(
        _ pt: CGFloat,
        weight: Font.Weight? = nil,
        design: Font.Design? = nil,
        digitsEqual: Bool = false
    ) -> some View {
        modifier(CbFontModifier(pt: pt, weight: weight, design: design, digitsEqual: digitsEqual))
    }

    /// The app's title steps — in the SYSTEM FONT. The hierarchy is carried by WEIGHT, not by typeface. Goes through `cbFont`, so it
    /// follows the text size like any other fixed size.
    func cbTitle(_ stage: CbTitle, mono: Bool = false) -> some View {
        cbFont(stage.size, weight: stage.weight, design: mono ? .monospaced : nil)
    }
}

/// The steps of `cbTitle(_:)`.
enum CbTitle {
    /// Page title in the header of every page (`PaneScaffold`).
    case page
    /// Titles of both drawers.
    case drawer
    /// Greeting in the empty Coding chat.
    case greeting
    /// Name in the header of a detail sheet (`CbDetailHeader`).
    case sheet

    var size: CGFloat {
        switch self {
        case .page: return 22
        case .drawer: return 24
        case .greeting: return 26
        case .sheet: return 20
        }
    }

    var weight: Font.Weight {
        switch self {
        case .page, .drawer: return .bold
        case .greeting, .sheet: return .semibold
        }
    }
}

extension Font {
    /// Explicitly FIXED size for SF symbols — they do not grow with the text size, like the SVG symbols on the web.
    static func symbol(_ pt: CGFloat, weight: Font.Weight? = nil, design: Font.Design? = nil) -> Font {
        .system(size: pt, weight: weight, design: design)
    }

    /// Font from an already scaled size — for the places where a modifier does not work (`Text + Text` demands `Text`) or the same
    /// number is needed elsewhere (the terminal's character grid). The type demands the `@CbMetric` itself (`_name`), not its value:
    /// a bare number would not get through here, and so no unscaled one either.
    static func scaled(_ metric: CbMetric, weight: Font.Weight? = nil, design: Font.Design? = nil) -> Font {
        .system(size: metric.wrappedValue, weight: weight, design: design)
    }
}
