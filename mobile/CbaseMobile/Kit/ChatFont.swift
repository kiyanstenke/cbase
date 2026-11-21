import SwiftUI
import UIKit

// The type steps of the chat history — the counterpart of the `cb-cs-*` classes on the web.
//
// The text size applies to the WHOLE app (`Kit/TextSize.swift`: an offset in Dynamic Type categories, as a trait on the window), so
// this file only names the steps: `chatFont(.caption)` yields the semantic style (character-identical to `.font(.caption)`),
// `.fixed(N)` the same computation as `cbFont(N)` — both follow the text size without the history computing anything of its own.
// (A factor branch computing `.system(size: base × factor)` would lose the Dynamic Type curve, since that does not grow with the
// system size.)
//
// Every step carries the chat's TYPEFACE (Settings → Appearance, Kit/ChatTypeface.swift); with "Default" everything is as before.

/// `base` is the point size at Dynamic Type category L, exactly what SwiftUI's semantic styles yield there.
enum ChatFontStyle {
    case caption2
    case caption
    case footnote
    case subheadline
    case callout
    case body
    case headline
    /// Fixed point size (code block, cards, headings) — follows the curve of its nearest text style (`cbTextStyle`).
    case fixed(CGFloat)

    var base: CGFloat {
        switch self {
        case .caption2: return 11
        case .caption: return 12
        case .footnote: return 13
        case .subheadline: return 15
        case .callout: return 16
        case .body: return 17
        case .headline: return 17
        case .fixed(let size): return size
        }
    }

    /// The semantic style; `nil` for `.fixed`.
    var textStyle: Font.TextStyle? {
        switch self {
        case .caption2: return .caption2
        case .caption: return .caption
        case .footnote: return .footnote
        case .subheadline: return .subheadline
        case .callout: return .callout
        case .body: return .body
        case .headline: return .headline
        case .fixed: return nil
        }
    }
}

private struct ChatFontModifier: ViewModifier {
    let style: ChatFontStyle
    let weight: Font.Weight?
    let design: Font.Design?
    let digitsEqual: Bool
    /// An explicitly named typeface (the rows of the choice in settings) — otherwise the chosen one.
    let overwritten: ChatTypeface?
    /// Read only for `.fixed` — the same computation as `cbFont`.
    @CbMetric private var fixedSize: CGFloat
    /// The chat's typeface (Settings → Appearance, Kit/ChatTypeface.swift).
    @ObservedObject private var typeface = ChatTypefaceStore.shared
    /// Read only for an own family with a semantic style: its size is recomputed here along Apple's curve.
    @Environment(\.dynamicTypeSize) private var stage

    init(style: ChatFontStyle, weight: Font.Weight?, design: Font.Design?, digitsEqual: Bool, typeface: ChatTypeface?) {
        self.style = style
        self.weight = weight
        self.design = design
        self.digitsEqual = digitsEqual
        overwritten = typeface
        _fixedSize = CbMetric(wrappedValue: style.base)
    }

    func body(content: Content) -> some View {
        content.font(font)
    }

    private var font: Font {
        // Code stays in the system's monospace font; everything else follows the chosen typeface — also a line that names
        // `design: .default` (a list's number: it should not inherit the container's font but carry the same family as the
        // paragraph beside it).
        let kind = overwritten ?? typeface.choice
        let systemDesign: Font.Design? = design == .monospaced ? .monospaced : kind.systemDesign
        var f: Font
        if let systemDesign {
            // The semantic style brings its curve and — for `.headline` — its semibold itself; an extra weight only if the caller
            // names one.
            if let textStyle = style.textStyle {
                f = .system(textStyle, design: systemDesign)
                if let weight { f = f.weight(weight) }
            } else {
                f = .scaled(_fixedSize, weight: weight, design: systemDesign)
            }
        } else {
            // An own family: the size as in the system branch (Apple's curve of the style resp. `CbMetric`), the semibold of
            // `.headline` explicitly.
            let size: CGFloat
            if let textStyle = style.textStyle {
                size = UIFontMetrics(forTextStyle: uiTextStyle(textStyle)).scaledValue(
                    for: style.base,
                    compatibleWith: UITraitCollection(preferredContentSizeCategory: UIContentSizeCategory(stage))
                )
            } else {
                size = fixedSize
            }
            f = kind.font(size: size, weight: weight ?? (style.textStyle == .headline ? .semibold : nil))
        }
        if digitsEqual { f = f.monospacedDigit() }
        return f
    }
}

extension View {
    /// Font of a history row. It is no special computation any more, only the naming of the step — the size follows the same
    /// Dynamic Type curve everywhere.
    func chatFont(
        _ style: ChatFontStyle,
        weight: Font.Weight? = nil,
        design: Font.Design? = nil,
        monospacedDigit: Bool = false,
        typeface: ChatTypeface? = nil
    ) -> some View {
        modifier(ChatFontModifier(style: style, weight: weight, design: design, digitsEqual: monospacedDigit, typeface: typeface))
    }
}

// The page "Settings → Appearance" lives in `Settings/AppearanceSettings.swift`, the text size itself (steps, store, window
// trait) in `Kit/TextSize.swift`.
