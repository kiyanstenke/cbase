import SwiftUI
import UIKit

/// The stage of the chat: history (collection) and above it the composer, whose
/// bottom edge hangs on the `keyboardLayoutGuide` by constraint (see
/// `ChatStageController`). SwiftUI gives IT the frame — and that jumps when the
/// keyboard opens by the safe-area swap of the shell (34 pt, rendered as its own
/// ~0.4 s animation). The collection inside keeps its QUIET HEIGHT and is anchored at
/// the top edge: its BOTTOM edge therefore stands fixed in the world, and row position is
/// bottom edge + offset — readers scrolled up stand frame-exact still BY CONSTRUCTION.
/// Every trailing compensation was measurably worse: the immediate
/// model booking jerked 33.6 pt in the commit frame (offset jumps, edge follows smoothly),
/// a frame-by-frame roller on the rendered edge still lagged 8 pt
/// behind (the correction for frame N lands only in frame N+1). The overhang of the
/// collection lies invisible behind the keyboard; the resting position gets it as
/// additional inset (see `collectionDidLayout`).
final class ChatStageView: UIView {
    let collection: ChatTimelineCollectionView
    /// The hosted composer — set by the controller, read by the inset computation.
    weak var composerView: UIView?
    /// After every layout of the stage: recompute the list's inset. Only the guide moves
    /// the composer — the collection does NOT lay out itself in the process, so its hook does
    /// not fire; this one does.
    var onLayout: (() -> Void)?
    /// Window change — the controller then re-ties the composer constraints
    /// (the keyboard guide of the root view belongs to it, see `attachComposer`).
    var onWindowChange: (() -> Void)?
    /// Pull-back of an interactive drag (finger up, keyboard stays): the island
    /// animates back to the announced edge (see `settleKeyboardAfterRelease`).
    var onSettleBack: (() -> Void)?
    /// Stage height WITHOUT keyboard. Frozen while a keyboard is in play — the 34 pt swap
    /// is exactly the difference the list should not follow. Real
    /// size changes (strips appear, short chat) happen without keyboard
    /// and carry it forward.
    private var restingHeight: CGFloat = 0
    /// Bottom edge of the stage in the window + time of its last movement: the
    /// 34 pt swap runs ~0.15 s LONGER than the keyboard is visible — as long as the
    /// edge moves, the resting height stays frozen.
    private var lastBottom: CGFloat = .nan
    private var bottomChangedAt: CFTimeInterval = 0
    /// Bottom edge of the stage on the SCREEN, measured at REST — the floor the island stands on
    /// without keyboard. Counterpart of `restingHeight`: there the
    /// LIST keeps its resting height while the stage frame breathes; the island never had the same
    /// guarantee, it hung on the CURRENT bottom edge.
    ///
    /// In a working chat this never showed — there the edge stands fixed. A conversation inside a
    /// `NavigationStack` that took the keyboard out with `ignoresSafeArea(.keyboard)` had an edge that took
    /// THREE values while the keyboard came in (840, 874, 792). The island
    /// sits on `min(edge, keyboard edge)`, so it sagged 82 pt behind the
    /// bottom bar during the transition and snapped back up on settling.
    private(set) var restingBottomOnScreen: CGFloat = .nan
    /// Set by the controller: is NEITHER a finger NOR a keyboard present right now? Only then
    /// may the resting geometry be carried forward. Deliberately NOT derived from `keyboardOverlap`:
    /// since the island has a resting floor, the overlap carries a value with a grown
    /// stage even without keyboard — the resting values would then freeze forever.
    var keyboardFree = true
    #if DEBUG
    /// Composer top edge at the last layout — every change opens a measuring window
    /// of the trace (keyboard movements without notification would otherwise be invisible).
    private var lastComposerTop: CGFloat = .nan
    #endif

    init(collection: ChatTimelineCollectionView) {
        self.collection = collection
        super.init(frame: .zero)
        addSubview(collection)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    /// How far the keyboard currently overlaps the stage — derived from the
    /// CONSTRAINT solution: without keyboard the resting equation pulls the composer to the
    /// stage's bottom edge (distance 0), with keyboard its inequality holds it above.
    /// Deliberately not the stage's own `keyboardLayoutGuide`: it ran measurably
    /// 104 pt off the real edge (see `attachComposer`).
    var keyboardOverlap: CGFloat {
        guard let composer = composerView, composer.frame.height > 0 else { return 0 }
        return max(0, bounds.maxY - composer.frame.maxY)
    }

    /// Highest overlap of the running keyboard session — reference for the question whether
    /// the keyboard is "on its way down" when a drag is released.
    private var peakOverlap: CGFloat = 0

    /// Has the running keyboard session already REPORTED a position? Only then may
    /// `peakOverlap` learn. Before the first report `syncKeyboardOverlap` takes the
    /// keyboard guide, and that carries the 100 pt of the `KeyboardGripAccessory`: a
    /// layout pass with overlap 353 instead of 253 wrote a phantom maximum, and
    /// afterwards `settleKeyboardAfterRelease` saw 253 < 353 − 20 — every drag in the
    /// history closed the keyboard on release without it ever having moved along.
    /// Reset together with the overlap, so anew per session.
    ///
    /// Trace of a drag that NEVER touched the keyboard:
    ///   `sync edge=539.0 … overlap=253.0 … announced=nan`
    ///   `peak 253.0 -> 353.0 (overlap=353.0)`      ← guide lead, announced still nan
    ///   `willChangeFrame endMinY=439.0 edge=539.0` ← FIRST report, 7 ms later
    ///   `settle overlap=253.0 peak=353.0 fingerTravel=0.0 threshold=333.0 decision=endEditing`
    /// With this marker the same line reads `peak=253.0 threshold=233.0
    /// decision=settleBack` — the keyboard stays. The decision rule itself,
    /// the 20 pt threshold and the `fingerTravel` branch are untouched; only
    /// WHEN the maximum starts learning changes.
    var keyboardReported = false

    /// Release of an interactive drag: if the keyboard hangs halfway,
    /// the app side FREEZES ON THE DEVICE — completion animates the
    /// keyboard window outside the process, guide and accessory stand
    /// still model-side until the (late) close report, and the island would hang
    /// visibly in the air while the keyboard moves away below it. (Invisible in the simulator:
    /// there the frames keep running in-process.) An immediate
    /// `endEditing` forces the announced close animation NOW, and the
    /// island finishes in the same transaction. The 20 pt threshold leaves
    /// the pull-back alone: whoever pushes back (almost) all the way up and
    /// releases keeps the keyboard.
    ///
    /// `fingerTravel` is the finger's way DOWNWARD. It belongs in THIS decision
    /// because otherwise there are two: the drag zone also sent the keyboard away itself
    /// once the finger had covered more than 40 pt (its safety net for the
    /// case that the interactive attach does not engage at all). If the two contradict —
    /// finger traveled far, overlap hardly followed — exactly the reported symptom ran:
    /// first the pull-back drags the island in 0.25 s up to full keyboard height,
    /// then it retracts again with the `endEditing`. One gesture, one decision, both signals.
    /// From the HISTORY comes `fingerTravel: 0` — there the way is a scroll movement and no
    /// statement about the keyboard.
    func settleKeyboardAfterRelease(fingerTravel: CGFloat = 0) {
        let overlap = keyboardOverlap
        // The ONE line that says who closed the keyboard: if it stands BEFORE
        // a `willChangeFrame … dur=0.00`, it was this `endEditing`; if it stands
        // after, iOS finished the gesture itself. Without it one cannot tell from outside
        // (video, frames) which of the two ways ran.
        #if DEBUG
        KeyboardTrace.shared.note(String(
            format: "settle overlap=%.1f peak=%.1f fingerTravel=%.1f threshold=%.1f decision=%@",
            overlap, peakOverlap, fingerTravel, peakOverlap - 20,
            overlap <= 0.5
                ? "off(no overlap)"
                : ((overlap < peakOverlap - 20 || fingerTravel > 40) ? "endEditing" : "settleBack")
        ))
        #endif
        guard overlap > 0.5 else { return }
        if overlap < peakOverlap - 20 || fingerTravel > 40 {
            endEditing(true)
        } else {
            // Pull-back: the keyboard docks again by itself (on the device
            // outside the process, without a message reliably coming) —
            // the island actively animates back to the last announced edge.
            onSettleBack?()
        }
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        onWindowChange?()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let bottom = window.map { convert(bounds, to: $0).maxY } ?? bounds.maxY
        let now = CACurrentMediaTime()
        if bottom != lastBottom {
            #if DEBUG
            if !lastBottom.isNaN {
                KeyboardTrace.shared.note(String(format: "stageBottom %.2f -> %.2f", lastBottom, bottom))
                KeyboardTrace.shared.run(stage: self, for: 1.0)
            }
            #endif
            lastBottom = bottom
            bottomChangedAt = now
        }
        #if DEBUG
        if let composer = composerView, composer.frame.minY != lastComposerTop {
            lastComposerTop = composer.frame.minY
            KeyboardTrace.shared.run(stage: self, for: 1.0)
        }
        #endif
        // Take the resting height only from RESTING geometry: no keyboard in play and
        // the bottom edge unmoved for a quarter second. If the takeover is
        // still pending, a later layout is triggered — otherwise an old value would remain after a
        // rotation or the swap's aftermath.
        let settled = now - bottomChangedAt > 0.25
        if keyboardFree {
            if settled || restingHeight == 0 {
                restingHeight = bounds.height
                if let window {
                    restingBottomOnScreen = convert(
                        CGPoint(x: 0, y: bounds.maxY), to: window.screen.coordinateSpace
                    ).y
                }
            } else {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
                    self?.setNeedsLayout()
                }
            }
        }
        // During a keyboard session the list keeps its QUIET height — even when the
        // stage frame GROWS in the process. `max(…)` sufficed as long as the stage could only shrink
        // (the shell's 34 pt safe-area swap). A conversation inside a
        // `NavigationStack` passes the keyboard to its children as an inset, so it
        // took it out with `ignoresSafeArea(.keyboard)` — and the frame grew
        // by the height of the bottom bar (measured 48 pt). With `max` the list grew
        // along, `extra` stayed 0 and `composerArea` carried the 48 pt: the history of a
        // reader scrolled up moved by exactly that amount.
        let listHeight = keyboardOverlap > 0.5 && restingHeight > 0
            ? restingHeight
            : max(bounds.height, restingHeight)
        let frame = CGRect(x: 0, y: 0, width: bounds.width, height: listHeight)
        if collection.frame != frame { collection.frame = frame }
        // Maintain the session maximum of the overlap (see `settleKeyboardAfterRelease`)
        // — only from the first reported position (see `keyboardReported`).
        let overlap = keyboardOverlap
        #if DEBUG
        let peakPrior = peakOverlap
        #endif
        if overlap <= 0.5 {
            peakOverlap = 0
            keyboardReported = false
        } else if keyboardReported {
            peakOverlap = max(peakOverlap, overlap)
        }
        #if DEBUG
        if peakOverlap != peakPrior {
            KeyboardTrace.shared.note(String(
                format: "peak %.1f -> %.1f (overlap=%.1f)", peakPrior, peakOverlap, overlap
            ))
        }
        #endif
        onLayout?()
    }
}

/// Invisible companion on the keyboard guide of its superview: its layout fires
/// whenever the guide moves — also in the middle of the keyboard transaction and
/// per frame during interactive dragging.
final class KeyboardFollowerView: UIView {
    var onLayout: (() -> Void)?

    override func layoutSubviews() {
        super.layoutSubviews()
        onLayout?()
    }
}
