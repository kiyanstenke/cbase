import PhotosUI
import SwiftUI
import UIKit

/// The most recently ANNOUNCED keyboard position as island edge (`keyboardWillChangeFrame`, screen coordinates, the
/// extension subtracted) — ONE for the whole process, not per stage.
///
/// Why: with an OPEN keyboard in the previous chat, opening another chat (via the left drawer or back + overview)
/// closes the keyboard WITHOUT animation (`willChangeFrame endMinY=874 dur=0.00`), and afterwards the root's
/// `keyboardLayoutGuide` stays at the height of the `KeyboardGripAccessory` — `layoutFrame` 774/100
/// instead of 840/34, although neither keyboard nor extension is in the window and there is no first responder any more.
/// In the old chat this went unnoticed: its own announcement (edge 974 or 874) took precedence over the guide. The stage of the
/// NEW chat had none — the announcement lived in the controller —, fell back to the guide, lifted the island by 66 pt, and
/// because 774 lies below the stage's bottom edge the keyboard counted as present (`keyboardFree = false`): the
/// resting floor stayed unmeasured too. The history then ended directly above the lifted island with empty space below.
///
/// The keyboard belongs to the process, not to a stage. So its announcement lives here, observed from app start
/// (`CbaseAppDelegate`), and every stage reads it — also one created only after the report. The guide only counts
/// as long as no keyboard has been announced in the whole process; then it stands on the dock edge (measured
/// 840/34 after start). Guard: `ChatStageUITests/testComposerSitsAfterChatSwitchWithOpenKeyboardBottom`.
///
/// The SHELL (`frame`, `duration` — `AppShell`, outside a chat) also reads the keyboard only here. The same wedge sits in
/// SwiftUI's keyboard region, which the shell used to follow outside a chat: measured in the simulator, in the NEXT keyboard
/// outside a chat it follows the guide instead of the announcement — announcement `endMinY=539 endH=335`, guide 639/235,
/// SwiftUI region 235 —, and the terminal's input field then lay 46 pt INSIDE the keyboard instead of 54 pt above it. The
/// announcements were right on all 36 paths driven (every close reports `endMinY=874`, every open the real frame). So the
/// shell follows the ANNOUNCEMENT and no longer SwiftUI's region. Guard: `ShellUITests/testTerminalInputStandsAfterKeyboardInChatOverTheKeyboard`.
@MainActor
final class KeyboardAnnouncement: NSObject, ObservableObject {
    static let shared = KeyboardAnnouncement()
    /// `nil` as long as no keyboard has been announced in the process.
    private(set) var islandEdge: CGFloat?
    /// The most recently announced end frame, RAW (screen coordinates, an installed extension included) — for
    /// the shell, which yields to the keyboard outside a chat. `nil` as long as none was announced. Published
    /// only on change: stage and process observer each take in every announcement.
    @Published private(set) var frame: CGRect?
    /// Duration of the movement `frame` announced (0 = without animation) — set BEFORE `frame`, so the shell reads it in the
    /// same pass.
    private(set) var duration: Double = 0
    private var observed = false

    /// Take in every announcement from now on. Calling more than once is harmless.
    func start() {
        guard !observed else { return }
        observed = true
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(notice(_:)),
            name: UIResponder.keyboardWillChangeFrameNotification,
            object: nil
        )
    }

    @objc private func notice(_ notification: Notification) {
        remember(notification)
    }

    /// Takes in an announcement; `false` if it carries no end frame. The stage calls this in its own observer
    /// ITSELF before computing — so its computation does not depend on the order in which the NotificationCenter serves the two
    /// observers; the same announcement twice gives the same edge.
    ///
    /// The reported frame INCLUDES an installed `inputAccessoryView` — when the keyboard is for our
    /// input field, the real edge therefore begins one extension height lower.
    @discardableResult
    func remember(_ notification: Notification) -> Bool {
        guard let end = (notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue else {
            return false
        }
        let ours = ChatInputTextView.activeInput?.isFirstResponder == true
        islandEdge = end.minY + (ours ? KeyboardGripAccessory.height : 0)
        if frame != end {
            duration = notification.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double ?? 0
            frame = end
        }
        return true
    }
}

/// Carries stage and composer hosting as a REAL view controller: the hosted
/// SwiftUI tree thus gets the full lifecycle (sheets, PhotosPicker, .task, focus).
///
/// The one load-bearing line is the constraint `composer.bottom == keyboardLayoutGuide.top`:
/// UIKit thereby moves the composer in the SAME layout transaction as the keyboard —
/// with animated open/close as part of the same CA animation (zero frames
/// of offset), with interactive dragging in the same layout pass as the finger.
/// Intermediate states that are never rendered (the guide briefly docks back MODEL-side
/// on release of a swipe gesture before the close animation takes over)
/// constructively do not reach the screen: only what a transaction commits is rendered.
/// The former machinery — DisplayLink reads the displayed edge, writes SwiftUI state,
/// offset takes effect a frame later — was ALWAYS at least one frame behind the keyboard
/// (the visible trailing of the input field), and every read time was a race against
/// UIKit's intermediate states ("composer flashes at full height").
/// Readout element of the diagnostic probe (see `startComposerTrace`): the
/// accessibility value is computed only ON QUERY — XCUITest thus reads the
/// statistics over the just-ended animation window without the app having to
/// push anything.
private final class ComposerTraceReadout: UIView {
    var valueProvider: () -> String = { "" }
    override var accessibilityValue: String? {
        get { valueProvider() }
        set {}
    }
}

final class ChatStageController: UIViewController {
    let stage: ChatStageView
    let composerHost: UIHostingController<ChatComposerRoot>
    /// Mini hosting for the jump arrow, cut tightly around the button (see
    /// `ChatArrowOverlay`): so the area next to/above the arrow belongs to the history —
    /// a wide strip in the composer hosting would be a dead band (hosting swallows
    /// even empty space). Without a visible arrow the interaction is switched off
    /// (`updateUIViewController`), so not even its small rectangle eats taps
    /// or drags.
    let arrowHost: UIHostingController<ChatArrowOverlay>

    init(collection: ChatTimelineCollectionView, composer: ChatComposerRoot, arrow: ChatArrowOverlay) {
        stage = ChatStageView(collection: collection)
        composerHost = UIHostingController(rootView: composer)
        arrowHost = UIHostingController(rootView: arrow)
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func loadView() { view = stage }

    /// Bottom edge of the composer relative to the stage. The keyboard travels solely into the
    /// CONSTANT (−overlap) — the constraint itself stays hierarchy-local.
    private var composerBottom: NSLayoutConstraint?
    /// Unsichtbarer Begleiter am Keyboard-Guide des Wirts (siehe `attachComposer`).
    private var follower: KeyboardFollowerView?
    /// Island edge of the most recently ANNOUNCED keyboard position (`keyboardWillChangeFrame`,
    /// screen coordinates, extension already subtracted). Without a finger on
    /// a drag surface IT is the truth: the announcement carries the final
    /// target position before the keyboard window animates outside the process —
    /// the guide and accessory MODELS demonstrably freeze on the device meanwhile
    /// (the island stayed in the middle of the screen or parked 100 pt above the keyboard
    /// when tapping the field, depending on which of the two sources lied).
    ///
    /// It belongs to the PROCESS (`KeyboardAnnouncement`), not to this stage: a stage created after the
    /// last announcement (chat switch) otherwise knew none and computed with the guide — which stayed
    /// 66 pt too high after a close without animation.
    private var announcedKeyboardEdge: CGFloat? { KeyboardAnnouncement.shared.islandEdge }
    /// Edge last measured AT THE FINGER, HELD beyond lifting off.
    ///
    /// Symptom: swipe the island down with the thumb, release — it
    /// snapped up briefly to full keyboard height and only THEN went down with the
    /// keyboard. The cause is the order: on lifting off
    /// `fingerDown` is immediately false, but the close announcement comes only a
    /// moment later. In this window the translation fell back to the last
    /// ANNOUNCED edge — and that was the edge of the open keyboard. A
    /// layout of the guide (UIKit docks back model-side briefly on release)
    /// rendered it, because `syncKeyboardOverlap` explicitly lays out immediately.
    ///
    /// So: the measured edge stays until one of three resolutions replaces it —
    /// new keyboard announcement, animated pull-back (`onSettleBack`) or
    /// the fallback timer. It is never held without one of them taking effect.
    private var fingerEdge: CGFloat?
    private var fingerEdgeFallback: DispatchWorkItem?

    override func viewDidLoad() {
        super.viewDidLoad()
        composerHost.view.backgroundColor = .clear
        // The height is determined by the SwiftUI content (multi-line field, action board,
        // attachments): Auto Layout reads it from the intrinsic size. IMPORTANT for
        // animated height changes: the intrinsic size only follows frame by
        // frame if the animation lays out in the MODEL tree — a plain
        // animated .frame(height:) is interpolated render-side, the intrinsic
        // size then jumps to the end value in ONE frame and the input row visibly
        // rides along (measured with the action board: +168 pt jump, field
        // displaced 84 pt). So the board height runs through an
        // Animatable modifier (`AnimatedHeightMask`) that forces real layout
        // per frame.
        composerHost.sizingOptions = .intrinsicContentSize
        // The hosting controller must NOT avoid the keyboard itself — the
        // constraint IS the avoiding movement.
        composerHost.safeAreaRegions.subtract(.keyboard)
        addChild(composerHost)
        stage.addSubview(composerHost.view)
        composerHost.didMove(toParent: self)
        composerHost.view.translatesAutoresizingMaskIntoConstraints = false
        stage.composerView = composerHost.view
        // Jump arrow: hangs with its bottom edge on the composer's top edge (the
        // overlay's bottom padding keeps the visual gap) and so travels in the same
        // transaction with the keyboard as the composer itself.
        arrowHost.view.backgroundColor = .clear
        arrowHost.sizingOptions = .intrinsicContentSize
        arrowHost.safeAreaRegions.subtract(.keyboard)
        arrowHost.view.isUserInteractionEnabled = false
        addChild(arrowHost)
        stage.addSubview(arrowHost.view)
        arrowHost.didMove(toParent: self)
        arrowHost.view.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            arrowHost.view.centerXAnchor.constraint(equalTo: stage.centerXAnchor),
            arrowHost.view.bottomAnchor.constraint(equalTo: composerHost.view.topAnchor),
        ])
        stage.onWindowChange = { [weak self] in self?.attachComposer() }
        stage.onSettleBack = { [weak self] in
            self?.releaseFingerEdge()
            UIView.animate(withDuration: 0.25, delay: 0, options: [.curveEaseOut, .allowUserInteraction]) {
                self?.syncKeyboardOverlap()
            }
        }
        // The announcement is started at app start (`CbaseAppDelegate`); here only for a stage created without that start
        // (preview, other entry) — a second call does nothing.
        KeyboardAnnouncement.shared.start()
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(keyboardWillChangeFrame(_:)),
            name: UIResponder.keyboardWillChangeFrameNotification,
            object: nil
        )
        if ProcessInfo.processInfo.environment["CBASE_COMPOSER_TRACE"] == "1" {
            startComposerTrace()
        }
        #if DEBUG
        // Outlet of the expand trace for DEVICE runs: there the app cannot write to /tmp
        // — the test reads the CSV as accessibilityValue instead.
        if ChatEntranceTrace.isOn {
            let readout = ComposerTraceReadout()
            readout.isAccessibilityElement = true
            readout.accessibilityIdentifier = "expand-trace"
            readout.accessibilityLabel = "expand-trace"
            readout.isUserInteractionEnabled = false
            readout.frame = CGRect(x: 2, y: 0, width: 2, height: 2)
            readout.valueProvider = { ChatEntranceTrace.shared.csv }
            stage.addSubview(readout)
        }
        #endif
    }

    // ── Diagnostic probe (UI tests only, CBASE_COMPOSER_TRACE=1) ────────────
    // Records the position of the input row frame by frame (CADisplayLink) and exposes
    // the statistics of the last four seconds as an accessibility value. Needed
    // because XCUITest waits for app idle before EVERY frame query — movement DURING
    // an animation is invisible from outside (the steadiness test was green, the field
    // wandered anyway). The DisplayLink deliberately keeps the controller
    // alive — the probe exists only in test runs.

    private struct ComposerTraceSample {
        var time: CFTimeInterval
        var fieldMaxY: CGFloat
        var hostTop: CGFloat
        var hostHeight: CGFloat
    }

    private var traceLink: CADisplayLink?
    private var traceSamples: [ComposerTraceSample] = []
    private var traceDecisions: [String] = []
    private weak var traceField: UIView?

    private func startComposerTrace() {
        let readout = ComposerTraceReadout()
        readout.isAccessibilityElement = true
        readout.accessibilityIdentifier = "composer-trace"
        readout.accessibilityLabel = "composer-trace"
        readout.isUserInteractionEnabled = false
        readout.frame = CGRect(x: 0, y: 0, width: 2, height: 2)
        readout.valueProvider = { [weak self] in self?.traceSummary() ?? "off" }
        stage.addSubview(readout)
        let link = CADisplayLink(target: self, selector: #selector(traceTick))
        link.add(to: .main, forMode: .common)
        traceLink = link
    }

    @objc private func traceTick() {
        guard let window = stage.window else { return }
        if traceField == nil || traceField?.window == nil {
            traceField = Self.findTextView(in: composerHost.view)
        }
        guard let field = traceField else { return }
        traceSamples.append(ComposerTraceSample(
            time: CACurrentMediaTime(),
            fieldMaxY: field.convert(field.bounds, to: window).maxY,
            hostTop: composerHost.view.frame.minY,
            hostHeight: composerHost.view.frame.height))
        if traceSamples.count > 800 {
            traceSamples.removeFirst(traceSamples.count - 800)
        }
    }

    private static func findTextView(in root: UIView) -> UIView? {
        if root is UITextView { return root }
        for sub in root.subviews {
            if let hit = findTextView(in: sub) { return hit }
        }
        return nil
    }

    private func traceSummary() -> String {
        let now = CACurrentMediaTime()
        let recent = traceSamples.filter { now - $0.time < 4 }
        guard !recent.isEmpty else { return "empty" }
        let fieldMin = recent.map(\.fieldMaxY).min() ?? 0
        let fieldMax = recent.map(\.fieldMaxY).max() ?? 0
        let topMin = recent.map(\.hostTop).min() ?? 0
        let topMax = recent.map(\.hostTop).max() ?? 0
        // History (every 3rd sample) for reading off the trajectory: jump, following
        // along or oscillating look different.
        let series = recent.enumerated().filter { $0.offset % 3 == 0 }.map(\.element)
        let fieldSeries = series.map { String(Int($0.fieldMaxY.rounded())) }.joined(separator: " ")
        let topSeries = series.map { String(Int($0.hostTop.rounded())) }.joined(separator: " ")
        let last = recent[recent.count - 1]
        // Largest step UPWARD between two frames. The jump on releasing a
        // swipe gesture looks exactly like this: the island covers the whole remaining distance in ONE frame,
        // while every real keyboard ride spreads it over ~0.25 s (at 60 Hz
        // at most a good 20 pt per frame). The span `field=` does not find it — it
        // contains the resting position before the drag anyway.
        //
        // `onTotal` catches what `onMax` by construction does NOT see: an ANIMATED ride
        // upward. The pull-back moves the island back in 0.25 s, so at roughly 13 pt per
        // frame — every single step stays under any sensible jump threshold, the sum
        // does not. After releasing a drag downward no
        // upward movement belongs at all; steps under 1 pt are rounding and do not count.
        var onMax: CGFloat = 0
        var onTotal: CGFloat = 0
        for i in 1..<recent.count {
            let on = recent[i - 1].fieldMaxY - recent[i].fieldMaxY
            onMax = max(onMax, on)
            if on > 1 { onTotal += on }
        }
        return String(
            format: "field=%.1f..%.1f host=%.1f..%.1f hostH=%.1f hostEnd=%.1f onMax=%.1f onTotal=%.1f n=%d | f: %@ | t: %@",
            fieldMin, fieldMax, topMin, topMax,
            last.hostHeight, last.hostTop + last.hostHeight, onMax, onTotal,
            recent.count, fieldSeries, topSeries)
            + " | d: " + traceDecisions.joined(separator: " ; ")
    }

    /// Anchors the composer — in TWO deliberately separate worlds:
    ///
    /// 1. The composer constraints are HIERARCHY-LOCAL (composer ↔ stage). A
    ///    direct constraint to a keyboard guide across the SwiftUI boundary
    ///    is systematically wrong: SwiftUI positions its intermediate views OUTSIDE
    ///    of Auto Layout, so the engine computes with a wrong stage origin.
    ///    Measured: guide anchor correct at 539, composer still landed
    ///    "constraint-faithful" at 643 — exactly the 104 pt that SwiftUI shifts past the
    ///    engine; no unsatisfiability log, because the engine's algebra
    ///    is self-consistent. The same held for the stage's own guide.
    ///
    /// 2. The keyboard edge is delivered by an invisible FOLLOWER in the view of the HOST
    ///    (root view or topmost presented controller): there the
    ///    keyboard guide is hierarchy-local and demonstrably exact (539 = notification).
    ///    Its layout fires INSIDE the keyboard transaction — `syncKeyboardOverlap`
    ///    translates its edge via `convert` (real view geometry, also sees
    ///    SwiftUI's shifts) into the constant of the local constraint. Because this
    ///    happens in the same animation block, the composer animates with the ORIGINAL
    ///    keyboard curve; with interactive dragging the same path comes per frame in the same
    ///    layout pass — no trailing, no SwiftUI state in between.
    private func attachComposer() {
        if composerBottom == nil {
            let bottom = composerHost.view.bottomAnchor.constraint(equalTo: stage.bottomAnchor)
            NSLayoutConstraint.activate([
                composerHost.view.leadingAnchor.constraint(equalTo: stage.leadingAnchor),
                composerHost.view.trailingAnchor.constraint(equalTo: stage.trailingAnchor),
                bottom,
            ])
            composerBottom = bottom
        }
        let host = keyboardHostView()
        // Already at the right host? Then touch nothing — so this call may come from
        // any layout and any keyboard announcement (self-healing, see
        // `keyboardHostView`) without re-tying the follower on every frame.
        if let follower, follower.superview === host, follower.window != nil { return }
        follower?.removeFromSuperview()
        follower = nil
        guard let hostView = host else { return }
        let follower = KeyboardFollowerView()
        follower.alpha = 0
        follower.isUserInteractionEnabled = false
        follower.translatesAutoresizingMaskIntoConstraints = false
        hostView.addSubview(follower)
        NSLayoutConstraint.activate([
            follower.topAnchor.constraint(equalTo: hostView.keyboardLayoutGuide.topAnchor),
            follower.leadingAnchor.constraint(equalTo: hostView.leadingAnchor),
            follower.trailingAnchor.constraint(equalTo: hostView.trailingAnchor),
            follower.bottomAnchor.constraint(equalTo: hostView.bottomAnchor),
        ])
        follower.onLayout = { [weak self] in self?.syncKeyboardOverlap() }
        self.follower = follower
        syncKeyboardOverlap()
    }

    /// Translates the follower edge into the constant of the composer constraint. Runs in the
    /// layout pass of the follower (= inside the keyboard transaction) and after
    /// every stage layout (the stage moves with the 34 pt safe-area swap).
    fileprivate func syncKeyboardOverlap() {
        guard let follower, follower.window != nil, let stageWindow = stage.window else { return }
        let screen = stageWindow.screen.coordinateSpace
        let stageBottom = stage.convert(CGPoint(x: 0, y: stage.bounds.maxY), to: screen).y
        // Two truths, strictly separated at the finger:
        //
        // • FINGER ON A DRAG SURFACE (history or zone): the directly measured
        //   bottom edge of the invisible extension (`KeyboardGripAccessory`, lives
        //   in the keyboard window). Only it travels along frame by frame during
        //   interactive dragging — the guide meanwhile switches to the real edge (without
        //   the correction the island sagged 100 pt behind the keyboard on grabbing). The `min` against
        //   the guide catches its phantom position right after installation
        //   (measured: 974 instead of 539).
        //
        // • WITHOUT FINGER: the most recently ANNOUNCED edge (`keyboardWillChangeFrame`).
        //   Announced animations and the completion after release
        //   run on the device OUTSIDE the process — guide and accessory
        //   model freeze meanwhile, and any arithmetic over them
        //   pinned the island (stuck in the middle of the screen; parked 100 pt
        //   above the keyboard when tapping the field). The announcement carries
        //   the final target position in screen coordinate space before anyone
        //   animates. Before the first announcement IN THE PROCESS (keyboard never there)
        //   the guide counts — it then stands on the dock edge, overlap 0. Only then:
        //   after a close without animation it stayed 66 pt too high, and
        //   a fresh stage without its own announcement lifted the island by exactly that much
        //   (see `KeyboardAnnouncement`).
        let guideTop = follower.convert(follower.bounds, to: screen).minY
        let keyboardEdge: CGFloat
        let accessory = KeyboardGripAccessory.shared
        let fingerDown = stage.collection.isTracking || KeyboardDismissGrip.anyGripTracking
        if fingerDown, let accessoryWindow = accessory.window {
            let measured = accessory.convert(
                CGPoint(x: 0, y: accessory.bounds.maxY),
                to: accessoryWindow.screen.coordinateSpace
            ).y
            keyboardEdge = min(measured, guideTop + KeyboardGripAccessory.height)
            fingerEdge = keyboardEdge
            fingerEdgeFallback?.cancel()
            fingerEdgeFallback = nil
        } else if let held = fingerEdge {
            keyboardEdge = held
            armFingerEdgeFallback()
        } else {
            keyboardEdge = announcedKeyboardEdge ?? guideTop
        }
        // The island sits on `min(floor, keyboard edge)` — and the FLOOR is the RESTING
        // bottom edge of the stage, not its current one (see `restingBottomOnScreen`).
        // Otherwise the island inherits every breathing of the frame:
        // inside a navigation stack it sagged 82 pt behind the bottom bar in the transition and
        // snapped back on settling. In a working chat both edges are identical —
        // there the line changes nothing by construction.
        stage.keyboardFree = !fingerDown && keyboardEdge >= stageBottom - 0.5
        let floorY = stage.restingBottomOnScreen
        let overlap = max(0, stageBottom - (floorY.isNaN ? keyboardEdge : min(floorY, keyboardEdge)))
        if traceLink != nil {
            let source = fingerDown ? "finger" : (fingerEdge != nil ? "held" : (announcedKeyboardEdge != nil ? "ann" : "guide"))
            traceDecisions.append(String(
                format: "%@ e=%.0f sb=%.0f rb=%.0f g=%.0f a=%.0f o=%.0f",
                source, keyboardEdge, stageBottom, stage.restingBottomOnScreen,
                guideTop, announcedKeyboardEdge ?? .nan, overlap))
            if traceDecisions.count > 30 { traceDecisions.removeFirst() }
        }
        guard let composerBottom, abs(composerBottom.constant + overlap) > 0.5 else { return }
        #if DEBUG
        KeyboardTrace.shared.note(String(
            format: "sync edge=%.1f stageBottom=%.1f overlap=%.1f finger=%d announced=%.1f",
            keyboardEdge, stageBottom, overlap, fingerDown ? 1 : 0,
            announcedKeyboardEdge ?? .nan
        ))
        #endif
        composerBottom.constant = -overlap
        // Lay out immediately: inside an animation block that is exactly what makes the
        // movement part of the keyboard animation.
        stage.setNeedsLayout()
        stage.layoutIfNeeded()
    }

    /// End holding the finger edge. It is resolved by the next
    /// keyboard announcement, by the pull-back — and in the worst case by the timer below.
    private func releaseFingerEdge() {
        fingerEdgeFallback?.cancel()
        fingerEdgeFallback = nil
        fingerEdge = nil
    }

    /// Safety net: if both fail to appear (no `settleKeyboardAfterRelease`, no
    /// announcement), the island would stand on the intermediate position forever. The timer resolves the
    /// hold ANIMATED — a jump would be exactly the fault at issue here.
    private func armFingerEdgeFallback() {
        guard fingerEdgeFallback == nil else { return }
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.fingerEdge != nil else { return }
            self.releaseFingerEdge()
            UIView.animate(withDuration: 0.2, delay: 0, options: [.curveEaseOut, .allowUserInteraction]) {
                self.syncKeyboardOverlap()
            }
        }
        fingerEdgeFallback = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4, execute: work)
    }

    /// The host of the follower: the outermost controller view that REALLY
    /// CONTAINS the stage. In the normal chat that is the root (measured correct over months), in a
    /// full-screen overlay the overlay itself — there the root view can be taken out of the
    /// hierarchy.
    ///
    /// The containment check is the core: "simply the topmost presented controller"
    /// missed as soon as a FOREIGN sheet still lay on top when entering the window.
    /// That is exactly how a new chat arises: `NewChatSheet` calls `openChat` BEFORE `dismiss()`,
    /// so the stage enters the window behind the still-presented sheet. The
    /// follower landed in the sheet and, when it disappeared, hung windowless in the
    /// air forever — `syncKeyboardOverlap` bailed out at its `window` guard, the
    /// constant stayed 0, and the input field simply stood still when the keyboard opened
    /// (trace: `willChangeFrame edge=539` arrived, then `followerTopWin=0.0
    /// constant=-0.0`, not a single `sync`). And because only a FRESHLY created chat
    /// takes this path, every chat opened via the list was fine.
    private func keyboardHostView() -> UIView? {
        guard stage.window != nil else { return nil }
        var host = stage.window?.rootViewController
        while let presented = host?.presentedViewController,
              let view = presented.viewIfLoaded, stage.isDescendant(of: view) {
            host = presented
        }
        guard let view = host?.viewIfLoaded, stage.isDescendant(of: view) else { return nil }
        return view
    }

    /// The stage moved (safe-area swap, strips, rotation) — translate the
    /// overlap anew. Converges in one pass: `syncKeyboardOverlap`
    /// touches the constraint only when the constant really changes.
    ///
    /// The follower's self-healing also hangs here: the stage's `didMoveToWindow`
    /// does NOT fire when the presentation above it changes (a sheet comes in or
    /// out). The host can thus move away under the follower — `attachComposer`
    /// checks this and re-ties only on a real change.
    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        attachComposer()
        syncKeyboardOverlap()
    }

    /// Announced keyboard movement: the END situation from the announcement is the
    /// reliable resting truth (see `announcedKeyboardEdge`; the edge including the
    /// subtracted extension is computed by `KeyboardAnnouncement.merke`). The translation
    /// runs in the animation block with the announcement's duration and curve: the island travels with
    /// the ORIGINAL keyboard curve.
    @objc private func keyboardWillChangeFrame(_ notification: Notification) {
        let duration = notification.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double ?? 0.25
        let curveRaw = notification.userInfo?[UIResponder.keyboardAnimationCurveUserInfoKey] as? UInt
            ?? UIView.AnimationCurve.easeInOut.rawValue.magnitude
        // Take in the announcement ITSELF before computing — do not rely on its own observer having been called before this one.
        if KeyboardAnnouncement.shared.remember(notification) {
            // From NOW the stage may learn its session maximum (see
            // `ChatStageView.keyboardReported`): the guide lead-in before it carries
            // the extension and would write too high a maximum.
            stage.keyboardReported = true
        }
        // A fresh announcement beats the held finger edge: it carries the
        // final target position, and the island travels there right below IN this block
        // with the original keyboard curve.
        releaseFingerEdge()
        let options: UIView.AnimationOptions = [
            UIView.AnimationOptions(rawValue: curveRaw << 16), .allowUserInteraction,
        ]
        UIView.animate(withDuration: max(duration, 0), delay: 0, options: options) {
            // Second place of self-healing (see `keyboardHostView`): here there is
            // guaranteed something to do, and a follower re-tied here travels in
            // THIS block with the original keyboard curve.
            self.attachComposer()
            self.syncKeyboardOverlap()
        }
        #if DEBUG
        let end = (notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue
        KeyboardTrace.shared.note(String(
            format: "willChangeFrame endMinY=%.1f edge=%.1f dur=%.2f",
            end?.minY ?? .nan, announcedKeyboardEdge ?? .nan, duration
        ))
        // Delayed check: after the animation ends, the model positions.
        DispatchQueue.main.asyncAfter(deadline: .now() + duration + 0.3) { [weak self] in
            guard let self else { return }
            let composerBottomWindow = self.stage.convert(
                CGPoint(x: 0, y: self.composerHost.view.frame.maxY), to: nil
            ).y
            let followerTop = self.follower.map { $0.convert($0.bounds, to: nil).minY } ?? .nan
            KeyboardTrace.shared.note(String(
                format: "settled composerBottomWin=%.1f followerTopWin=%.1f stageBottomWin=%.1f constant=%.1f",
                composerBottomWindow, followerTop,
                self.stage.convert(CGPoint(x: 0, y: self.stage.bounds.maxY), to: nil).y,
                self.composerBottom?.constant ?? .nan
            ))
        }
        KeyboardTrace.shared.run(stage: stage, for: max(duration, 0.25) + 1.0)
        #endif
    }
}
