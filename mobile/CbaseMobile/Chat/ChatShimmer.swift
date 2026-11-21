import SwiftUI

// The light effect of a RUNNING history row — the iOS counterpart of the `cb-shimmer` class on the
// web. There is no spinner column in front of the group row; the text starts at the history edge,
// and what is running shows as a band sweeping across the sentence itself.
//
// Whether a row is running is NOT decided by this modifier but by `HistoryState.groupRunning`
// (same computation as on the web, bound by `web/test/history-binding.test.mjs`). This file only
// holds how "running" looks.
//
// Three rules, each for a reason:
//  · The animation is flipped ONCE in `.onAppear` (pattern of `RunIndicator`) and then keeps
//    running in Core Animation. History cells are reconfigured on every token — if the animation
//    hung on a value that changes then, the band would restart on every token. For the same
//    reason NO `TimelineView`: it re-evaluated the body on every frame.
//  · Reduce Motion: no band, the sentence stays `.primary` — otherwise a half-lit, frozen
//    sentence would remain and "running" would only show in the VoiceOver value.
//  · The band lies OVER the sentence and is masked with it; it catches no touch
//    (`allowsHitTesting(false)`), the button underneath stays the button.
//
// Limit of the guarantee: when a cell is rebuilt (roles, recycling) the band starts over. What
// is measurable is that the row carries the value "running", not that the band runs evenly.
struct ChatShimmer: ViewModifier {
    let active: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// Flipped once, then left alone — see above.
    @State private var phase = false

    /// Band width as a share of the row, and the duration of one pass (as on the web, 2.2 s).
    static let bandShare: CGFloat = 0.35
    static let duration: Double = 2.2

    func body(content: Content) -> some View {
        if !active {
            content
        } else if reduceMotion {
            content.foregroundStyle(.primary)
        } else {
            content
                .overlay {
                    GeometryReader { geo in
                        let width = geo.size.width
                        let band = max(1, width * Self.bandShare)
                        LinearGradient(colors: [.clear, .primary, .clear], startPoint: .leading, endPoint: .trailing)
                            .frame(width: band, height: geo.size.height)
                            // From fully outside on the left to fully outside on the right: a pass
                            // starts and ends without a visible band.
                            .offset(x: phase ? width : -band)
                            .animation(.linear(duration: Self.duration).repeatForever(autoreverses: false), value: phase)
                    }
                    .mask(content)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
                }
                .onAppear { if !reduceMotion { phase = true } }
                // Back to the start as soon as the row stops running: `phase` survives the branch
                // switch, and flipping to the same value again would start NO animation — the next
                // running phase of the same row would stay dark.
                .onDisappear { phase = false }
        }
    }
}

extension View {
    /// Light effect of a running history row (see `ChatShimmer`).
    func chatShimmer(_ active: Bool) -> some View { modifier(ChatShimmer(active: active)) }
}
