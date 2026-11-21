import Foundation

/// The context bar below the composer: denominator, share and the provider of the last reply.
///
/// Twin of `web/src/lib/context-display.ts` (rule spelled out there), bound in
/// `web/test/context-display-binding.test.mjs`: both really run there (`tsc` and `xcrun swift`) over the same cases.
/// That is why this file imports only Foundation and knows nothing of `ChatViewModel`.
///
/// In short: OpenRouter picks the provider anew per request. The bar names the
/// provider of the LAST reply and computes its share on THAT one's window; without a window (0) on the catalog figure, without
/// a provider everything stays as before. COMPUTATION (transcript budget, compaction) happens on the server with the catalog figure; the
/// autocompact marker stays at its threshold and is only positioned on the displayed denominator.
enum ContextDisplay {
    enum Title: String, Equatable {
        case none = ""
        case window
        case unknown
    }

    struct Snapshot: Equatable {
        /// The bar's denominator: the provider's window, else the catalog figure.
        let denominator: Int
        /// The provider of the last reply ("" = none known).
        let provider: String
        /// Tokens / denominator clamped to [0, 1].
        let share: Double
        /// Rounded percent (half up), at most 100.
        let percent: Int
        /// The catalog figure — cbase computes with it.
        let catalogWindow: Int
        let title: Title
    }

    static func compute(tokens: Int, catalogWindow: Int, provider: String, providerWindow: Int) -> Snapshot {
        let name = provider.trimmingCharacters(in: .whitespacesAndNewlines)
        let catalog = max(0, catalogWindow)
        let own = name.isEmpty ? 0 : max(0, providerWindow)
        let denominator = own > 0 ? own : catalog
        let share = denominator > 0 ? min(1, Double(max(0, tokens)) / Double(denominator)) : 0
        let percent = min(100, Int((share * 100).rounded()))
        let title: Title = name.isEmpty ? .none : (own > 0 ? .window : .unknown)
        return Snapshot(denominator: denominator, provider: name, share: share, percent: percent, catalogWindow: catalog, title: title)
    }

    /// The autocompact marker on the displayed denominator: its share ON THE CATALOG, converted; [0, 1].
    static func markerOnDenominator(_ shareOfCatalog: Double, catalogWindow: Int, denominator: Int) -> Double {
        let a = shareOfCatalog.isFinite && shareOfCatalog > 0 ? shareOfCatalog : 0
        let r = catalogWindow > 0 && denominator > 0 ? a * Double(catalogWindow) / Double(denominator) : a
        return max(0, min(1, r))
    }
}
