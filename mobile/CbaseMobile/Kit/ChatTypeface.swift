import SwiftUI
import UIKit

// The chat's typeface. Chosen under Settings → Appearance; the choice is a device preference like color scheme and text size
// (UserDefaults, no server). It applies to the TEXT of the chat: every history row (`chatFont`, Kit/ChatFont.swift), the
// selectable message text (UIKit, `ChatHighlightableText` in Chat/ChatTextMarker.swift) and the input field (Chat/ChatInput.swift).
// Code stays in the system's monospace font, the rest of the app in the system font.
//
// Only fonts iOS ships itself — nothing is downloaded or bundled. "Default" is the system font, character for character: that
// branch computes exactly as before the choice existed.
//
// The size follows the text size in every branch (Kit/TextSize.swift): semantic styles via Apple's curve (`UIFontMetrics`), fixed
// ones via `CbMetric` — the typeface changes the shape of the characters, never their step.

enum ChatTypeface: String, CaseIterable, Identifiable, Sendable {
    case standard
    case rounded
    case avenir
    case helvetica
    case charter

    var id: String { rawValue }

    /// The name in the list (translated via `L`).
    var displayLabel: String {
        switch self {
        case .standard: return "Default (SF Pro)"
        case .rounded: return "SF Pro Rounded"
        case .avenir: return "Avenir Next"
        case .helvetica: return "Helvetica Neue"
        case .charter: return "Charter"
        }
    }

    /// A sentence on the kind of typeface — under the name in the list.
    var germanHint: String {
        switch self {
        case .standard: return "The iOS system font."
        case .rounded: return "The system font with rounded ends, softer and friendlier."
        case .avenir: return "Open and warm, with plenty of room between the letters."
        case .helvetica: return "The classic, a little more compact than the system font."
        case .charter: return "A calm reading face with serifs."
        }
    }

    /// The system font in one of its forms — `nil` for an own family.
    var systemDesign: Font.Design? {
        switch self {
        case .standard: return .default
        case .rounded: return .rounded
        case .avenir, .helvetica, .charter: return nil
        }
    }

    /// The PostScript name of the cut per weight. Explicitly per cut rather than via a weight trait: what a family calls "semibold"
    /// differs in each (DemiBold, Medium, Bold), and a search via the trait silently landed on the regular. Italic is searched by the
    /// caller via `traitItalic` in the same family.
    private func cut(_ weight: UIFont.Weight) -> String? {
        let stage: Int = weight.rawValue >= UIFont.Weight.bold.rawValue ? 3
            : weight.rawValue >= UIFont.Weight.semibold.rawValue ? 2
            : weight.rawValue >= UIFont.Weight.medium.rawValue ? 1 : 0
        switch self {
        case .standard, .rounded: return nil
        case .avenir: return ["AvenirNext-Regular", "AvenirNext-Medium", "AvenirNext-DemiBold", "AvenirNext-Bold"][stage]
        case .helvetica: return ["HelveticaNew", "HelveticaNew-Medium", "HelveticaNew-Bold", "HelveticaNew-Bold"][stage]
        case .charter: return ["Charter-Roman", "Charter-Roman", "Charter-Bold", "Charter-Bold"][stage]
        }
    }

    /// The UIKit font at exactly this size (already scaled — the caller computes the size). If a cut is missing on the device, it
    /// stays with the system font instead of an empty field.
    func uiFont(size: CGFloat, weight: UIFont.Weight) -> UIFont {
        // The ONE fixed UIKit system font of this block: the size here is always the already scaled one (exception in
        // tools/check/ios-font.test.mjs).
        let system = UIFont.systemFont(ofSize: size, weight: weight)
        if self == .rounded, let round = system.fontDescriptor.withDesign(.rounded) {
            return UIFont(descriptor: round, size: size)
        }
        guard let name = cut(weight), let own = UIFont(name: name, size: size) else { return system }
        return own
    }

    /// The SwiftUI font of an own family (for the system forms `chatFont` computes as before via `.system(…, design:)`). `size`
    /// is already scaled.
    func font(size: CGFloat, weight: Font.Weight?) -> Font {
        Font(uiFont(size: size, weight: Self.uiWeight(weight)) as CTFont)
    }

    /// SwiftUI's weight in UIKit's — `nil` is regular.
    static func uiWeight(_ weight: Font.Weight?) -> UIFont.Weight {
        switch weight {
        case .some(.ultraLight): return .ultraLight
        case .some(.thin): return .thin
        case .some(.light): return .light
        case .some(.medium): return .medium
        case .some(.semibold): return .semibold
        case .some(.bold): return .bold
        case .some(.heavy): return .heavy
        case .some(.black): return .black
        default: return .regular
        }
    }
}

/// The choice on this device. No environment value: the history hangs in UIKit cells (`ChatTimelineStage`), and the root's
/// environment value would not reach them — whoever needs the font observes this store directly.
@MainActor
final class ChatTypefaceStore: ObservableObject {
    static let shared = ChatTypefaceStore()
    private static let key = "cbase.mobile.chat-typeface"

    @Published var choice: ChatTypeface {
        didSet { UserDefaults.standard.set(choice.rawValue, forKey: Self.key) }
    }

    private init() {
        choice = UserDefaults.standard.string(forKey: Self.key).flatMap(ChatTypeface.init(rawValue:)) ?? .standard
    }
}
