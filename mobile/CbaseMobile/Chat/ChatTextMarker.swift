import SwiftUI
import UIKit

// ── Text marker (partial selection in the timeline) ────────────────────────────────────
//
// System selection stays disabled in the mirrored timeline — instead there is a marker of our own: a long press on the
// TEXT of a message puts a blue highlight under the word at the finger, dragging extends it word by word, and on release
// the view reports selection + rectangle (window coordinates) outward via the environment. The menu ("Reply / Copy") is
// shown by the chat root OUTSIDE the scroll view — same pattern as image viewer and copy dialog.
//
// Implemented as a UITextView (TextKit 1): only that gives character geometry (point → index, selection → rectangle).
// Editing/system selection stay OFF — their loupe and handles would be wrong in the mirrored coordinate space;
// `convert(_:to: nil)` on the other hand accounts for both flips (collection + cell) correctly in window coordinates.

/// A finished highlight: the text, its rectangle in the WINDOW and the way to remove the highlight again once the menu
/// closes.
struct ChatTextSelection {
    let text: String
    let rect: CGRect
    let clear: () -> Void
}

/// Where the marker menu belongs while the highlight STAYS. After lifting the finger the timeline may keep scrolling —
/// the highlighted text moves with it, so the marker view updates its position here live. An object of its own, because
/// the notification comes from UIKit (scroll observation) and SwiftUI only needs the result.
@MainActor final class ChatSelectionTracker: ObservableObject {
    static let shared = ChatSelectionTracker()

    enum Placement: Equatable {
        /// Highlight visible — menu at this window rectangle.
        case at(CGRect)
        /// Highlight is outside the view (scrolled away): menu off, selection kept.
        case hidden
        /// Highlight is gone (new session, cell recycled, menu used) — close the menu.
        case gone
    }

    @Published var placement: Placement = .gone

    private init() {}
}

/// Set per cell of the inverted list (like `chatMessageAction`). Only where the receiver exists does
/// `ChatHighlightableText` render the marker version — everywhere else (context pages) it stays the usual SwiftUI text.
struct ChatTextHighlightKey: EnvironmentKey {
    static let defaultValue: ((ChatTextSelection) -> Void)? = nil
}

/// Base size of the running text in Markdown (info rows: 15 instead of 17). As an environment value, because it has to be
/// passed through nested blocks (lists, quotes).
struct ChatMarkdownBaseSizeKey: EnvironmentKey {
    static let defaultValue: CGFloat = 17
}

/// Quote blocks tint their content secondary — the marker text cannot inherit SwiftUI's `foregroundStyle` and reads this
/// flag instead.
struct ChatMarkdownSecondaryKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    var chatTextHighlight: ((ChatTextSelection) -> Void)? {
        get { self[ChatTextHighlightKey.self] }
        set { self[ChatTextHighlightKey.self] = newValue }
    }
    var chatMarkdownBaseSize: CGFloat {
        get { self[ChatMarkdownBaseSizeKey.self] }
        set { self[ChatMarkdownBaseSizeKey.self] = newValue }
    }
    var chatMarkdownSecondaryText: Bool {
        get { self[ChatMarkdownSecondaryKey.self] }
        set { self[ChatMarkdownSecondaryKey.self] = newValue }
    }
}

/// How the UIKit font of the marker text follows the text size: via the curve of ONE text style, for an EXPLICITLY named
/// category. Explicitly, because the text is built in a cell before it hangs in the window — `scaledFont(for:)` without
/// a trait would then take the app's category, not the window's (cbase's text size is a trait on the window,
/// Kit/TextSize.swift).
struct ChatInlineScaling {
    let style: UIFont.TextStyle
    let category: UIContentSizeCategory
    /// A FIXED base size (heading, `fontSize`): the same computation as `cbFont` in the SwiftUI branch (`FixedFont` — not
    /// beyond AX2, below L on the curve of Body). Otherwise running text on Apple's curve of the style, like the semantic
    /// font of the SwiftUI branch.
    var fixed = false

    func scale(_ font: UIFont) -> UIFont {
        if fixed {
            return font.withSize(FixedFont.size(font.pointSize, style: style, category: category))
        }
        return UIFontMetrics(forTextStyle: style).scaledFont(
            for: font,
            compatibleWith: UITraitCollection(preferredContentSizeCategory: category)
        )
    }
}

/// Inline Markdown → NSAttributedString. The same Foundation layer as `Text(init(markdown:))`, but the intents are resolved
/// into UIFonts here — `NSAttributedString(AttributedString)` would leave bold/italic/code unresolved.
enum ChatInlineText {
    @MainActor
    static func attributed(
        _ source: String,
        markdown: Bool,
        size: CGFloat,
        weight: UIFont.Weight,
        scaling: ChatInlineScaling,
        color: UIColor,
        typeface: ChatTypeface = .standard
    ) -> NSAttributedString {
        #if DEBUG
        if PerfProbe.isOn {
            let start = CACurrentMediaTime()
            defer { PerfProbe.shared.add("inline.attr", CACurrentMediaTime() - start) }
            return build(source, markdown, size, weight, scaling, color, typeface)
        }
        #endif
        return build(source, markdown, size, weight, scaling, color, typeface)
    }

    private static func build(
        _ source: String,
        _ markdown: Bool,
        _ size: CGFloat,
        _ weight: UIFont.Weight,
        _ scaling: ChatInlineScaling,
        _ color: UIColor,
        _ typeface: ChatTypeface
    ) -> NSAttributedString {
        func scaled(_ font: UIFont) -> UIFont { scaling.scale(font) }
        func italicized(_ font: UIFont) -> UIFont {
            let traits = font.fontDescriptor.symbolicTraits.union(.traitItalic)
            guard let descriptor = font.fontDescriptor.withSymbolicTraits(traits) else { return font }
            return UIFont(descriptor: descriptor, size: font.pointSize)
        }
        // Bold INSIDE an already semibold heading keeps its weight — only regular running text jumps to `bold` (like
        // SwiftUI's `**…**`).
        let boldWeight: UIFont.Weight = weight.rawValue < UIFont.Weight.semibold.rawValue ? .bold : weight
        // The chat's typeface (Kit/ChatTypeface.swift) — code stays monospace.
        let base = scaled(typeface.uiFont(size: size, weight: weight))

        guard markdown else {
            return NSAttributedString(string: source, attributes: [.font: base, .foregroundColor: color])
        }
        // The marker text cannot draw images any more than `Text` can — as a link.
        let prepared = source.replacingOccurrences(
            of: "!\\[([^\\]]*)\\]\\(",
            with: "[$1](",
            options: .regularExpression
        )
        guard let parsed = try? AttributedString(
            markdown: prepared,
            options: .init(
                interpretedSyntax: .inlineOnlyPreservingWhitespace,
                failurePolicy: .returnPartiallyParsedIfPossible
            )
        ) else {
            return NSAttributedString(string: source, attributes: [.font: base, .foregroundColor: color])
        }

        let out = NSMutableAttributedString()
        for run in parsed.runs {
            let text = String(parsed.characters[run.range])
            let intent = run.inlinePresentationIntent ?? []
            let bold = intent.contains(.stronglyEmphasized)
            let italic = intent.contains(.emphasized)
            var font: UIFont
            if intent.contains(.code) {
                font = UIFont.monospacedSystemFont(ofSize: size, weight: bold ? .semibold : .regular)
            } else {
                font = typeface.uiFont(size: size, weight: bold ? boldWeight : weight)
            }
            if italic { font = italicized(font) }
            var attributes: [NSAttributedString.Key: Any] = [
                .font: scaled(font),
                .foregroundColor: color,
            ]
            if intent.contains(.strikethrough) {
                attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue
            }
            if let link = run.link {
                // Set the colour explicitly: with system selection off the `linkTextAttributes` of the UITextView do not
                // apply reliably.
                attributes[.link] = link
                attributes[.foregroundColor] = UIColor.tintColor
            }
            out.append(NSAttributedString(string: text, attributes: attributes))
        }
        return out
    }
}

/// The UITextView behind the marker. Editing and system selection are off; a long press (0.5 s, own trigger via raw
/// touches — see `pressTimer`) highlights LIVE under the finger — also across block and message boundaries — and reports
/// the result on release. The view on which the gesture begins (the anchor) drives the whole session: it finds the other
/// marker texts via the registry and distributes the highlight.
final class MarkerTextUIView: UITextView, UIGestureRecognizerDelegate {
    /// Is a marker gesture running? The whole-message dialog (long press on the bubble, `chatMessageActions`) checks this
    /// and keeps still — otherwise it would pop up in the middle of the running highlight (SwiftUI's gesture on the
    /// container fires at 0.58 s independently of this one; it MUST lie above the marker's 0.5 s so the session is already
    /// running when it checks). The drawer gesture (`HorizontalPanReader`) checks the flag too: as soon as the marker owns
    /// the touch, sideways dragging extends the highlight instead of opening the drawer.
    @MainActor private(set) static var markerSessionActive = false

    /// All marker texts in the window, held weakly — the anchor has to find its neighbours so the selection can grow across
    /// block and message boundaries.
    @MainActor private static let registry = NSHashTable<MarkerTextUIView>.weakObjects()
    /// Views with an active highlight of the running session, in document order.
    @MainActor private static var involved: [MarkerTextUIView] = []
    /// The view under the finger at the last update — the menu appears at its selection rectangle.
    @MainActor private static weak var focus: MarkerTextUIView?
    /// Visible marker texts WITH their window frame, measured once per session. Otherwise each finger movement ran a
    /// `convert(bounds, to: nil)` per view — several in the sort comparison — plus the same again for the target search.
    /// A long message has dozens of blocks in the window; that was the noticeable lag in big chats. During the session the
    /// timeline stands still (`suspendCompeting`), so the frames are fixed — if a view does lose its window, it is
    /// re-measured.
    @MainActor private static var sessionLayout: [(view: MarkerTextUIView, frame: CGRect)] = []
    /// Preview chip above the finger. The thumb COVERS the highlighted word — on the device the session start therefore
    /// looked like "nothing happens" (measured: `.began` and highlight came at +0.5 s, just invisibly under the thumb; the
    /// simulator does not show it because the synthetic finger covers nothing). The chip shows the end of the selection
    /// live above the touch.
    @MainActor private static var peekChip: MarkerPeekChip?

    var onHighlight: ((ChatTextSelection) -> Void)?

    /// Word range under the finger at gesture start. Only the anchor carries it — it is also the ownership marker of the
    /// session (cancellations of foreign views must not clear a running session).
    private var markerAnchorRange: NSRange? {
        didSet {
            Self.trace("markerAnchorRange didSet \(String(describing: markerAnchorRange)) stack=\(Thread.callStackSymbols.prefix(10).joined(separator: " | "))")
        }
    }
    /// Where the finger LANDED. The anchor arises here, not at the position at session start: until the 0.5 s have passed
    /// (+ allowed drift) a real finger — and the synthetic one of the UI tests too — creeps pixels further.
    private var markerTouchDownPoint: CGPoint?
    private var markerHighlightedRange: NSRange?
    /// Gestures of the environment that are switched off for the duration of the highlight (see `suspendCompeting`) — at
    /// the end re-enable exactly these.
    private var suspendedGestures: [UIGestureRecognizer] = []
    /// The timeline this view hangs in. Needed for auto-scrolling at the edge and to see whether a standing highlight is
    /// still in view. `weak`, so tearing down a cell mid-gesture holds nothing.
    private weak var timelineScroll: UIScrollView?

    // ── Standing highlight (menu open, timeline scrollable again) ──────
    /// Views whose highlight STANDS after lifting (the menu points at them).
    @MainActor private static var retained: [MarkerTextUIView] = []
    /// The view at whose range the menu hangs — it tracks the position while scrolling.
    @MainActor private static weak var retainedAnchor: MarkerTextUIView?
    private var retainedRange: NSRange?
    private var retainedObservation: NSKeyValueObservation?

    // ── Auto-scroll at the screen edge during the highlight ─────────────────
    private var edgeScrollLink: CADisplayLink?
    /// Last finger position (window) — the auto-scroll step keeps highlighting with it.
    private var lastGlobalPoint: CGPoint = .zero
    /// Minimum distance to the edge from which scrolling follows.
    private static let edgeZone: CGFloat = 96
    /// Top speed in points per SECOND (reached at the edge itself).
    ///
    /// Deliberately time-based, not per frame: with a fixed distance per frame the speed depended on the frame rate, and
    /// that collapses exactly here — MEASURED, only 17 frames per second ran during edge scrolling instead of 60 to 120.
    /// Scrolling then became not merely janky but DIFFERENTLY FAST: the same finger position crawled on the loaded device and
    /// shot away on the calm one. 840 pt/s corresponds to the previous value at a clean 60 Hz.
    private static let edgeSpeedMax: CGFloat = 840
    /// Timestamp of the last scroll step — basis of the distance (see `stepEdgeScroll`).
    private var lastEdgeStep: CFTimeInterval = 0
    private let selectionTick = UISelectionFeedbackGenerator()
    /// Time of the last tick feedback — basis of the throttling in `updateSession`.
    private var lastTick: CFTimeInterval = 0

    // ── Two sources, one session: own 0.5 s trigger + long-press recognizer ──
    //
    // The START runs via raw touches + an own timer, NOT via the recognizer: a UILongPressGestureRecognizer hangs in the
    // gesture graph on DYNAMIC failure requirements — partly ours (drawer pan), above all foreign ones (SwiftUI delegates,
    // UIKit-internal `_UIRelationshipGestureRecognizer`) — and its `.began` came, measured, depending on the graph build, at
    // +0.5 s, or only at the first movement, or only on LIFTING ("it only highlights when I drag"). The timer ALWAYS fires
    // exactly 0.5 s after the physical touch-down, as long as the finger rests (movement > `allowableMovement` before that
    // cancels it).
    //
    // The recognizer stays anyway — as a cancellation-proof event supplier: as soon as a FOREIGN recognizer strikes
    // (SwiftUI's bubble long press recognizes while resolving its failure requirement and cuts the view touches with
    // `cancelsTouchesInView`), the raw touch stream dies — recognizers follow the touch unaffected and deliver
    // `.changed`/`.ended` to the end. Both sources feed the same session idempotently.
    private var pressTimer: DispatchWorkItem?
    private weak var trackedTouch: UITouch?
    /// Watchdog over a handover from the raw touches to the recognizer (see `startHandoverWatchdog`).
    private var handoverWatchdog: DispatchWorkItem?
    private static let allowableMovement: CGFloat = 10
    private lazy var press: UILongPressGestureRecognizer = {
        let recognizer = UILongPressGestureRecognizer(target: self, action: #selector(handlePress(_:)))
        recognizer.minimumPressDuration = 0.5
        // Do NOT cut the view's own touches — they are the primary event source.
        recognizer.cancelsTouchesInView = false
        // The delegate allows simultaneity (see below): without it this gesture would wait for the failure of the COMPETING
        // ones (SwiftUI long press of the bubble, pan of the list) — and that is only decided on LIFTING.
        recognizer.delegate = self
        return recognizer
    }()

    func setup() {
        isEditable = false
        isSelectable = false
        isScrollEnabled = false
        backgroundColor = .clear
        textContainerInset = .zero
        textContainer.lineFragmentPadding = 0
        adjustsFontForContentSizeCategory = true
        watchContentSizeCategory()
        addGestureRecognizer(press)
        let tap = UITapGestureRecognizer(target: self, action: #selector(handleTap(_:)))
        // The tap must yield to the marker. Measured (CBASE_MARKER_TRACE): UIKit recognizes the tap even after ONE SECOND of
        // holding — it fired right after every highlight and tore the just created selection away. For the same reason a
        // long press on a link opened that link.
        tap.require(toFail: press)
        addGestureRecognizer(tap)
    }

    // Outwardly like a label, not like an input field: VoiceOver reads the text as a caption, and the UI tests keep finding
    // the paragraphs under `staticTexts` (SwiftUI's `Text` appeared there the same way).
    override var isAccessibilityElement: Bool {
        get { true }
        set {}
    }
    override var accessibilityTraits: UIAccessibilityTraits {
        get { .staticText }
        set {}
    }
    override var accessibilityLabel: String? {
        get { textStorage.string }
        set {}
    }
    override var accessibilityValue: String? {
        get { nil }
        set {}
    }

    /// The own long press may run SIMULTANEOUSLY with everything else — otherwise it would wait for the others to fail. The
    /// accidental double grip is covered: `markerSessionActive` holds the dialog still, `suspendCompeting` stops the
    /// timeline.
    func gestureRecognizer(
        _ gestureRecognizer: UIGestureRecognizer,
        shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
    ) -> Bool {
        gestureRecognizer === press
    }

    /// Remove this view's highlight (menu closed or new text).
    func clearHighlight() {
        if let range = markerHighlightedRange, range.upperBound <= textStorage.length {
            textStorage.removeAttribute(.backgroundColor, range: range)
        }
        markerHighlightedRange = nil
    }

    // ── Height measurement: measure exactly ONCE per text and width ──────────
    //
    // MEASURED (CBASE_PERF_PROBE, long Markdown chat in the simulator): SwiftUI asks this view's `sizeThatFits` about 1,100
    // times per self-sizing of a cell — the nested structure (blocks in list items in blocks, plus alignment to the first
    // text line) multiplies the requests across the levels, and for a `UIViewRepresentable` SwiftUI itself keeps NOTHING of
    // it. Each request was a real TextKit cycle: 152,000 measurements and 4.6 s of compute in a scroll session of just under
    // a minute, a cell sizing 8.5 ms on average and 130 ms in the worst case — the jolt while scrolling.
    //
    // The height is a FUNCTION of text and width; neither changes between the requests. So measure once and keep it. Widths
    // are NOT rounded: half a point of difference can flip the line break, and a reported height that is too small swallows
    // the last line (the same trap as with `fixedSize`).
    private var fitCache: [CGFloat: CGFloat] = [:]

    /// Measured height for this width. Text changes and font-size changes clear the stock (see `setMarkerText`,
    /// `traitCollectionDidChange`).
    func markerHeight(forWidth width: CGFloat) -> CGFloat {
        if let cached = fitCache[width] { return cached }
        #if DEBUG
        let start = CACurrentMediaTime()
        #endif
        let height = ceil(sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height)
        #if DEBUG
        PerfProbe.shared.add("marker.sizeFitsMiss", CACurrentMediaTime() - start)
        #endif
        // More than a handful of widths means: the view is being measured in changing frames. Then better start over than
        // collect without bound.
        if fitCache.count > 8 { fitCache.removeAll() }
        fitCache[width] = height
        return height
    }

    /// Set new text — the only way to change this view's `attributedText`, so the measurement stock does not outlive what
    /// it no longer applies to.
    func setMarkerText(_ attributed: NSAttributedString) {
        fitCache.removeAll()
        attributedText = attributed
    }

    /// Dynamic type size changed → the measured heights no longer apply. (`registerForTraitChanges` instead of the
    /// superseded `traitCollectionDidChange`.)
    private func watchContentSizeCategory() {
        registerForTraitChanges([UITraitPreferredContentSizeCategory.self]) {
            (view: MarkerTextUIView, _: UITraitCollection) in
            view.fitCache.removeAll()
        }
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window != nil {
            Self.registry.add(self)
        } else {
            Self.registry.remove(self)
        }
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        if trackedTouch == nil, touches.count == 1, let touch = touches.first {
            trackedTouch = touch
            let start = touch.location(in: self)
            markerTouchDownPoint = start
            Self.trace("touchDown ptr=\(Unmanaged.passUnretained(self).toOpaque()) local=\(start) eventTs=\(touch.timestamp) uptime=\(ProcessInfo.processInfo.systemUptime)")
            // The scroll view can delay delivery (delaysContentTouches) — the 0.5 s count from the PHYSICAL touch-down
            // (event timestamp).
            let elapsed = ProcessInfo.processInfo.systemUptime - touch.timestamp
            let work = DispatchWorkItem { [weak self] in self?.beginSessionFromTimer() }
            pressTimer = work
            DispatchQueue.main.asyncAfter(deadline: .now() + max(0.05, 0.5 - elapsed), execute: work)
        }
        super.touchesBegan(touches, with: event)
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
        if let touch = trackedTouch, touches.contains(touch) {
            if markerAnchorRange != nil {
                updateSession(at: touch.location(in: nil), notify: true)
            } else if pressTimer != nil, let start = markerTouchDownPoint {
                let point = touch.location(in: self)
                if hypot(point.x - start.x, point.y - start.y) > Self.allowableMovement {
                    // The finger is on the move (scrolling or drawer swipe) — this touch no longer belongs to the marker.
                    Self.trace("timer cancelled: movement before expiry")
                    cancelPressTimer()
                }
            }
        }
        super.touchesMoved(touches, with: event)
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
        if let touch = trackedTouch, touches.contains(touch) {
            cancelPressTimer()
            trackedTouch = nil
            if markerAnchorRange != nil {
                Self.trace("touch ended — finish")
                finishSession()
            }
        }
        super.touchesEnded(touches, with: event)
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
        Self.trace("touchesCancelled ptr=\(Unmanaged.passUnretained(self).toOpaque()) tracked=\(trackedTouch != nil) anchor=\(markerAnchorRange != nil) press=\(press.state.rawValue)")
        if let touch = trackedTouch, touches.contains(touch) {
            cancelPressTimer()
            trackedTouch = nil
            if markerAnchorRange == nil {
                // No session yet: the touch is gone, none should start any more.
            } else if press.state == .ended || press.state == .cancelled || press.state == .failed {
                Self.trace("touch cancelled without a live recognizer — abort")
                endSession(clearing: true)
            } else {
                // A FOREIGN recognizer cut the view touches (SwiftUI's long press on the bubble does that on recognizing,
                // ~0.08 s after our start). Do NOT abort the session — otherwise the highlight only flashes and disappears
                // again, which looked on the device like "highlights only when dragging". The own recognizer follows the same
                // finger on; the watchdog steps in if it does not take the lead after all.
                Self.trace("touch cancelled — handover to the recognizer")
                startHandoverWatchdog()
            }
        }
        super.touchesCancelled(touches, with: event)
    }

    /// If the anchor leaves the window mid-gesture (row removed), the session is ended cleanly — otherwise the timeline
    /// would stay scroll-locked for good.
    override func willMove(toWindow newWindow: UIWindow?) {
        super.willMove(toWindow: newWindow)
        if newWindow == nil {
            cancelPressTimer()
            trackedTouch = nil
            if markerAnchorRange != nil {
                Self.trace("willMove(nil) with an active session — abort")
                endSession(clearing: true)
            } else {
                cancelHandoverWatchdog()
            }
            // Reset the recognizer: if the view leaves the window mid-gesture it would otherwise hang in `.began`/`.changed`
            // and the watchdog would consider it alive.
            press.isEnabled = false
            press.isEnabled = true
        }
    }

    private func cancelPressTimer() {
        pressTimer?.cancel()
        pressTimer = nil
    }

    /// The 0.5 s trigger: the finger still rests on the text — start the session and highlight the word under the finger at
    /// once.
    private func beginSessionFromTimer() {
        pressTimer = nil
        Self.trace("timer feuert: ptr=\(Unmanaged.passUnretained(self).toOpaque()) touch=\(trackedTouch != nil) anchor=\(String(describing: markerAnchorRange)) session=\(Self.markerSessionActive) window=\(window != nil) start=\(markerTouchDownPoint.map(String.init(describing:)) ?? "nil")")
        guard let touch = trackedTouch else {
            Self.trace("timer: no touch left")
            return
        }
        beginSession(globalPoint: touch.location(in: nil), fallbackLocal: nil, source: "timer")
    }

    /// Session start, shared by BOTH sources (timer and recognizer) and deliberately idempotent: whoever comes first sets
    /// the anchor; the second finds it and leaves the running session untouched.
    private func beginSession(globalPoint: CGPoint, fallbackLocal: CGPoint?, source: String) {
        guard markerAnchorRange == nil, window != nil else {
            Self.trace("\(source): session already running or no window")
            return
        }
        // The anchor sits at the TOUCH-DOWN point (the finger has drifted by now); only if the raw touches never arrived
        // does the recognizer's position count.
        guard let anchorPoint = markerTouchDownPoint ?? fallbackLocal else {
            Self.trace("\(source): no anchor point")
            return
        }
        guard let range = wordRange(at: anchorPoint) else {
            Self.trace("\(source): no wordRange")
            return
        }
        // A new selection replaces the standing one of the last (with its menu) — otherwise two highlights would stay in
        // the timeline.
        Self.dropRetained()
        Self.markerSessionActive = true
        markerAnchorRange = range
        Self.trace("\(source): anchor set range=\(range)")
        // From now on the timeline stands still — so the frames of the visible marker texts are fixed for the whole session
        // and measured ONCE.
        suspendCompeting(true)
        Self.rebuildSessionLayout()
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        selectionTick.prepare()
        updateSession(at: globalPoint, notify: false)
        Self.trace("\(source): updateSession done")
    }

    /// Second event source of the same session (see the comment at `press`): if a FOREIGN recognizer cuts the view touches —
    /// SwiftUI's bubble long press does exactly that as soon as it recognizes — only these callbacks keep running. They keep
    /// the highlight at the finger and end the session cleanly.
    @objc private func handlePress(_ recognizer: UILongPressGestureRecognizer) {
        let global = recognizer.location(in: nil)
        switch recognizer.state {
        case .began:
            cancelHandoverWatchdog()
            beginSession(globalPoint: global, fallbackLocal: recognizer.location(in: self), source: "press")
        case .changed:
            cancelHandoverWatchdog()
            if markerAnchorRange != nil { updateSession(at: global, notify: true) }
        case .ended:
            cancelHandoverWatchdog()
            if markerAnchorRange != nil {
                Self.trace("press ended — finish")
                finishSession()
            }
        case .cancelled, .failed:
            cancelHandoverWatchdog()
            if markerAnchorRange != nil {
                Self.trace("press \(recognizer.state == .cancelled ? "cancelled" : "failed") — abort")
                endSession(clearing: true)
            }
        default:
            break
        }
    }

    /// After a handover (raw touches cut, session continues) the recognizer must take the lead. If it does not, the session
    /// ends here — otherwise the timeline would stay locked: the transition `.possible → .failed` sends NO action, so a
    /// silently failed recognizer would never end the session.
    private func startHandoverWatchdog() {
        cancelHandoverWatchdog()
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            handoverWatchdog = nil
            guard markerAnchorRange != nil else { return }
            if press.state == .began || press.state == .changed { return }
            Self.trace("handover expired (press=\(press.state.rawValue)) — abort")
            endSession(clearing: true)
        }
        handoverWatchdog = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35, execute: work)
    }

    private func cancelHandoverWatchdog() {
        handoverWatchdog?.cancel()
        handoverWatchdog = nil
    }

    // ── Diagnostics (DEBUG only, only with CBASE_MARKER_TRACE set) ─────────
    // Pattern like CBASE_CELL_DIAG: gesture states with points and highlight ranges per event — that is how the "anchor
    // jumps to the text end" bug showed itself in a run (see `characterIndex(at:)`).

    /// On the DEVICE an absolute Mac path like /tmp is not writable — a value without a leading "/" (e.g. `TMP`) therefore
    /// lands in the app container's tmp and can be fetched via `devicectl device copy from`.
    private static let tracePath: String? = {
        guard let raw = ProcessInfo.processInfo.environment["CBASE_MARKER_TRACE"],
              !raw.isEmpty else { return nil }
        if raw.hasPrefix("/") { return raw }
        return NSTemporaryDirectory() + (raw == "TMP" ? "cbase-marker-trace.log" : raw)
    }()

    static func trace(_ line: @autoclosure () -> String) {
        #if DEBUG
        guard let path = tracePath else { return }
        let stamp = String(format: "%.3f", CACurrentMediaTime())
        guard let data = (stamp + " " + line() + "\n").data(using: .utf8) else { return }
        if let handle = FileHandle(forWritingAtPath: path) {
            handle.seekToEndOfFile()
            handle.write(data)
            try? handle.close()
        } else {
            try? data.write(to: URL(fileURLWithPath: path))
        }
        #endif
    }

    /// Links stay tappable even without system selection. A tap into the text is also the way to get rid of a standing
    /// highlight with its menu (the menu's backdrop must not take that over — it would block scrolling).
    @objc private func handleTap(_ recognizer: UITapGestureRecognizer) {
        Self.dropRetained()
        guard let index = characterIndex(at: recognizer.location(in: self)) else { return }
        let value = textStorage.attribute(.link, at: index, effectiveRange: nil)
        let url = value as? URL ?? (value as? String).flatMap(URL.init(string:))
        if let url { UIApplication.shared.open(url) }
    }

    // ── Session logic (only the anchor calls it) ──────────────────────────────

    /// Distribute the highlight from the anchor word to the finger position. The finger may leave its own block: blocks
    /// between anchor and target are highlighted entirely, in the target block the selection ends at the word under the
    /// finger. The target is the marker text under the point, otherwise the vertically nearest (finger in the gap between
    /// paragraphs or over non-markable lines such as tables).
    private func updateSession(at globalPoint: CGPoint, notify: Bool) {
        let updateStart = CACurrentMediaTime()
        defer {
            Self.trace("update dt=\(String(format: "%.2f", (CACurrentMediaTime() - updateStart) * 1000))ms")
            #if DEBUG
            PerfProbe.shared.add("marker.update", CACurrentMediaTime() - updateStart)
            #endif
        }
        guard let anchor = markerAnchorRange else { return }
        lastGlobalPoint = globalPoint
        updateEdgeScrolling()
        let ordered = Self.sessionViews()
        guard let selfIndex = ordered.firstIndex(where: { $0.view === self }) else { return }
        let (target, targetIndex) = Self.target(at: globalPoint, in: ordered) ?? (self, selfIndex)

        var marks: [(view: MarkerTextUIView, range: NSRange, index: Int)] = []
        if target === self {
            let current = wordRange(at: convert(globalPoint, from: nil)) ?? anchor
            let lower = min(anchor.location, current.location)
            let upper = max(anchor.upperBound, current.upperBound)
            marks.append((self, NSRange(location: lower, length: upper - lower), selfIndex))
        } else if targetIndex > selfIndex {
            marks.append((
                self,
                NSRange(location: anchor.location, length: textStorage.length - anchor.location),
                selfIndex
            ))
            for index in (selfIndex + 1)..<targetIndex {
                let view = ordered[index].view
                marks.append((view, NSRange(location: 0, length: view.textStorage.length), index))
            }
            let word = target.wordRange(at: target.convert(globalPoint, from: nil))
            let upper = word?.upperBound ?? target.textStorage.length
            marks.append((target, NSRange(location: 0, length: upper), targetIndex))
        } else {
            let word = target.wordRange(at: target.convert(globalPoint, from: nil))
            let start = word?.location ?? 0
            marks.append((
                target,
                NSRange(location: start, length: target.textStorage.length - start),
                targetIndex
            ))
            for index in (targetIndex + 1)..<selfIndex {
                let view = ordered[index].view
                marks.append((view, NSRange(location: 0, length: view.textStorage.length), index))
            }
            marks.append((self, NSRange(location: 0, length: anchor.upperBound), selfIndex))
        }
        marks.sort { $0.index < $1.index }
        Self.trace("update self=\(selfIndex) target=\(targetIndex) marks=\(marks.map { "\($0.index):\($0.range)" }.joined(separator: " "))")

        // Clear views no longer involved — the selection may also shrink.
        let views = marks.map(\.view)
        for view in Self.involved where !views.contains(where: { $0 === view }) {
            view.clearHighlight()
        }
        var changed = false
        for mark in marks {
            if mark.view.applyHighlight(mark.range) { changed = true }
        }
        Self.involved = views
        Self.focus = target
        updatePeek(at: globalPoint, target: target)
        // The tick accompanies the growth of the selection — but throttled. With auto-scrolling at the edge it grows in EVERY
        // frame, and unthrottled that would be up to 120 tick signals per second: the accompaniment would become a constant
        // buzz.
        if notify, changed {
            let now = CACurrentMediaTime()
            if now - lastTick > 0.05 {
                lastTick = now
                selectionTick.selectionChanged()
            }
        }
    }

    /// Update the chip above the finger — shows the end of the selection in the target block (where it is growing), so the
    /// state is visible despite the thumb.
    private func updatePeek(at globalPoint: CGPoint, target: MarkerTextUIView) {
        guard let window else { return }
        guard let range = target.markerHighlightedRange,
              range.upperBound <= target.textStorage.length else { return }
        // Fetch ONLY the end of the selection. Previously the whole highlighted range was copied per finger movement (a
        // whole block is quickly thousands of characters) and cut to 80 afterwards — part of the lag in long messages.
        let tailLength = min(80, range.length)
        let tail = NSRange(location: range.upperBound - tailLength, length: tailLength)
        let text = (target.textStorage.string as NSString).substring(with: tail)
        let chip = Self.peekChip ?? MarkerPeekChip()
        Self.peekChip = chip
        chip.update(text: text, above: globalPoint, in: window)
    }

    /// Release: collect the selection (document order, blocks joined with a line break) and report it outward. The highlight
    /// stays until the menu closes via `clear`.
    private func finishSession() {
        let marked: [(view: MarkerTextUIView, range: NSRange)] = Self.involved.compactMap { view in
            guard let range = view.markerHighlightedRange, range.length > 0,
                  range.upperBound <= view.textStorage.length else { return nil }
            return (view, range)
        }
        let focus = Self.focus
        endSession(clearing: false)
        guard !marked.isEmpty else { return }
        let text = marked
            .map { (($0.view.textStorage.string as NSString)).substring(with: $0.range) }
            .joined(separator: "\n")
        let anchorMark = marked.first(where: { $0.view === focus }) ?? marked[marked.count - 1]
        let views = marked.map(\.view)
        // The highlight stays and the menu hangs on it — both now also survive scrolling (the position is tracked).
        anchorMark.view.beginRetaining(range: anchorMark.range, views: views)
        onHighlight?(ChatTextSelection(
            text: text,
            rect: anchorMark.view.windowRect(of: anchorMark.range),
            clear: { MarkerTextUIView.dropRetained() }
        ))
    }

    // ── Standing highlight: menu stays, timeline scrollable again ─────────

    /// After lifting, the highlight stays and the menu points at it. The timeline is freely scrollable again from now on (the
    /// gestures are re-enabled) — the highlighted text then moves, so the menu position is tracked via the scrolling.
    private func beginRetaining(range: NSRange, views: [MarkerTextUIView]) {
        Self.retained = views
        Self.retainedAnchor = self
        retainedRange = range
        let scroll = timelineScroll ?? ancestorScroll()
        timelineScroll = scroll
        publishRetainedPlacement()
        retainedObservation = scroll?.observe(\.contentOffset, options: [.new]) { [weak self] _, _ in
            MainActor.assumeIsolated { self?.publishRetainedPlacement() }
        }
    }

    /// Report the current position of the standing highlight — or that it no longer holds.
    private func publishRetainedPlacement() {
        guard let range = retainedRange, window != nil, range.upperBound <= textStorage.length else {
            // Cell recycled or text swapped: the highlight no longer belongs to this content, the menu must close.
            Self.dropRetained()
            return
        }
        let rect = windowRect(of: range)
        let visible = timelineScroll?.convert(timelineScroll!.bounds, to: nil)
        Self.trace("retain publish rect=\(rect) visible=\(visible.map(String.init(describing:)) ?? "nil")")
        if let visible, rect.maxY < visible.minY + 4 || rect.minY > visible.maxY - 4 {
            ChatSelectionTracker.shared.placement = .hidden
            return
        }
        ChatSelectionTracker.shared.placement = .at(rect)
    }

    private func stopRetainedTracking() {
        retainedObservation?.invalidate()
        retainedObservation = nil
        retainedRange = nil
    }

    /// Give up the standing highlight: colour gone, observation off, close the menu. Called by every place that ends the
    /// selection (menu action, tap into the text, new session).
    @MainActor static func dropRetained() {
        trace("dropRetained retained=\(retained.count)")
        guard !retained.isEmpty || retainedAnchor != nil else {
            if ChatSelectionTracker.shared.placement != .gone {
                ChatSelectionTracker.shared.placement = .gone
            }
            return
        }
        retainedAnchor?.stopRetainedTracking()
        retained.forEach { $0.clearHighlight() }
        retained = []
        retainedAnchor = nil
        ChatSelectionTracker.shared.placement = .gone
    }

    // ── Auto-scroll at the edge ──────────────────────────────────────────────────

    /// If the finger with a running highlight moves into the edge zone, the timeline scrolls along — otherwise the
    /// selection ends at the screen edge. During the session the timeline is cut off from the user's hand
    /// (`suspendCompeting`), so the offset is set here itself.
    private func updateEdgeScrolling() {
        guard markerAnchorRange != nil, edgeSpeed() != 0 else {
            stopEdgeScrolling()
            return
        }
        guard edgeScrollLink == nil else { return }
        lastEdgeStep = CACurrentMediaTime()
        let link = CADisplayLink(target: self, selector: #selector(stepEdgeScroll))
        link.add(to: .main, forMode: .common)
        edgeScrollLink = link
    }

    private func stopEdgeScrolling() {
        edgeScrollLink?.invalidate()
        edgeScrollLink = nil
    }

    /// How fast and where? Positive means: push content VISIBLY downward, i.e. fetch what lies above. The speed rises with
    /// the depth in the edge zone.
    private func edgeSpeed() -> CGFloat {
        guard let scroll = timelineScroll, window != nil else { return 0 }
        let area = scroll.convert(scroll.bounds, to: nil)
        let fromTop = lastGlobalPoint.y - area.minY
        if fromTop < Self.edgeZone {
            return min(1, max(0, (Self.edgeZone - fromTop) / Self.edgeZone)) * Self.edgeSpeedMax
        }
        let fromBottom = area.maxY - lastGlobalPoint.y
        if fromBottom < Self.edgeZone {
            return -min(1, max(0, (Self.edgeZone - fromBottom) / Self.edgeZone)) * Self.edgeSpeedMax
        }
        return 0
    }

    @objc private func stepEdgeScroll() {
        #if DEBUG
        let stepStart = CACurrentMediaTime()
        defer { PerfProbe.shared.add("edge.step", CACurrentMediaTime() - stepStart) }
        #endif
        let speed = edgeSpeed()
        guard speed != 0, markerAnchorRange != nil, let scroll = timelineScroll else {
            stopEdgeScrolling()
            return
        }
        // Distance = speed × time. The time step is capped: after a long frame (cell sizing) the list should not jump but
        // simply take the next step.
        let now = CACurrentMediaTime()
        let elapsed = min(max(now - lastEdgeStep, 0), 1.0 / 20)
        lastEdgeStep = now
        // The chat list is mirrored (`scaleY: -1`): there a LARGER offset pushes the content visibly downward, in a normal
        // scroll view a smaller one.
        let flipped = scroll.transform.d < 0
        let step = speed * elapsed
        let delta = flipped ? step : -step
        let lower = -scroll.adjustedContentInset.top
        let upper = max(lower, scroll.contentSize.height - scroll.bounds.height + scroll.adjustedContentInset.bottom)
        let before = scroll.contentOffset.y
        let after = min(max(before + delta, lower), upper)
        guard after != before else { return } // end of the timeline reached
        scroll.contentOffset.y = after
        // Everything moved by the same amount — carry the measured frames along instead of re-collecting them (newly arrived
        // blocks are noticed by `sessionViews` itself).
        Self.shiftSessionLayout(by: flipped ? after - before : before - after)
        updateSession(at: lastGlobalPoint, notify: true)
    }

    private func endSession(clearing: Bool) {
        if clearing {
            Self.involved.forEach { $0.clearHighlight() }
        }
        stopEdgeScrolling()
        cancelHandoverWatchdog()
        Self.involved = []
        Self.focus = nil
        Self.sessionLayout = []
        Self.peekChip?.removeFromSuperview()
        Self.peekChip = nil
        markerAnchorRange = nil
        Self.markerSessionActive = false
        suspendCompeting(false)
    }

    /// With a chosen accent colour (Settings → Appearance) the marker highlights in it, without a choice in the default accent
    /// (`Akzentfarbe.defaultDynamic`, terracotta). Read per highlight, not once at start (a choice applies from the next
    /// move); the derivation runs only if the choice changed.
    private static var markerColor: (hex: String?, color: UIColor)?
    private static var highlightColor: UIColor {
        let hex = AccentStore.shared.hex
        if let f = markerColor, f.hex == hex { return f.color }
        let color = AccentColor.dynamic(hex, alpha: 0.32) ?? AccentColor.defaultDynamic(alpha: 0.32)
        markerColor = (hex, color)
        return color
    }

    /// Touch only the DIFFERENCE to the existing highlight. Previously the complete old range was removed and the complete new
    /// one set per finger movement — TextKit then invalidates the WHOLE range, and with large blocks the whole block was
    /// redrawn on every move (felt on the device as "the highlight lags behind"). With the difference the invalidation stays
    /// with the few characters by which the selection grows or shrinks per move.
    @discardableResult
    private func applyHighlight(_ range: NSRange) -> Bool {
        guard range.length > 0, range.upperBound <= textStorage.length,
              range != markerHighlightedRange else { return false }
        textStorage.beginEditing()
        if let old = markerHighlightedRange, old.upperBound <= textStorage.length,
           NSIntersectionRange(old, range).length > 0 {
            let overlap = NSIntersectionRange(old, range)
            if old.location < overlap.location {
                textStorage.removeAttribute(
                    .backgroundColor,
                    range: NSRange(location: old.location, length: overlap.location - old.location)
                )
            }
            if old.upperBound > overlap.upperBound {
                textStorage.removeAttribute(
                    .backgroundColor,
                    range: NSRange(location: overlap.upperBound, length: old.upperBound - overlap.upperBound)
                )
            }
            if range.location < overlap.location {
                textStorage.addAttribute(
                    .backgroundColor,
                    value: Self.highlightColor,
                    range: NSRange(location: range.location, length: overlap.location - range.location)
                )
            }
            if range.upperBound > overlap.upperBound {
                textStorage.addAttribute(
                    .backgroundColor,
                    value: Self.highlightColor,
                    range: NSRange(location: overlap.upperBound, length: range.upperBound - overlap.upperBound)
                )
            }
        } else {
            if let old = markerHighlightedRange, old.upperBound <= textStorage.length {
                textStorage.removeAttribute(.backgroundColor, range: old)
            }
            textStorage.addAttribute(.backgroundColor, value: Self.highlightColor, range: range)
        }
        textStorage.endEditing()
        markerHighlightedRange = range
        return true
    }

    // ── Geometry ────────────────────────────────────────────────────────────

    /// Visible marker texts in document order. The window frames are upright thanks to the double mirroring (collection +
    /// cell) — top is really top.
    @MainActor private static func rebuildSessionLayout() {
        #if DEBUG
        let start = CACurrentMediaTime()
        defer { PerfProbe.shared.add("marker.relayout", CACurrentMediaTime() - start) }
        #endif
        // Determine the frame ONCE per view and sort afterwards — not in the comparison (a new conversion would arise per
        // comparison).
        sessionLayout = registry.allObjects
            .filter { $0.window != nil }
            .map { (view: $0, frame: $0.convert($0.bounds, to: nil)) }
            .sorted { a, b in
                if abs(a.frame.minY - b.frame.minY) > 0.5 { return a.frame.minY < b.frame.minY }
                return a.frame.minX < b.frame.minX
            }
        trace("sessionLayout re-measured: \(sessionLayout.count) views")
    }

    /// The measured views of the running session. Re-measured only if the stock no longer holds: empty, a view lost its
    /// window, or auto-scrolling brought a new block in (count differs). The comparison costs just one pass over the
    /// registry — no conversion per view.
    @MainActor private static func sessionViews() -> [(view: MarkerTextUIView, frame: CGRect)] {
        let visible = registry.allObjects.reduce(into: 0) { count, view in
            if view.window != nil { count += 1 }
        }
        if sessionLayout.isEmpty || sessionLayout.count != visible
            || sessionLayout.contains(where: { $0.view.window == nil }) {
            rebuildSessionLayout()
        }
        return sessionLayout
    }

    /// During auto-scrolling ALL blocks move by the same amount — carrying the measured frames along is cheaper than
    /// re-collecting per frame.
    @MainActor private static func shiftSessionLayout(by dy: CGFloat) {
        guard dy != 0 else { return }
        for index in sessionLayout.indices {
            sessionLayout[index].frame.origin.y += dy
        }
    }

    /// The marker text under the point — or the one with the smallest vertical distance.
    @MainActor private static func target(
        at point: CGPoint, in layout: [(view: MarkerTextUIView, frame: CGRect)]
    ) -> (MarkerTextUIView, Int)? {
        var best: (view: MarkerTextUIView, index: Int, distance: CGFloat)?
        for (index, entry) in layout.enumerated() {
            let frame = entry.frame
            let distance: CGFloat
            if point.y < frame.minY {
                distance = frame.minY - point.y
            } else if point.y > frame.maxY {
                distance = point.y - frame.maxY
            } else {
                distance = 0
            }
            if best == nil || distance < best!.distance {
                best = (entry.view, index, distance)
            }
        }
        return best.map { ($0.view, $0.index) }
    }

    private func characterIndex(at point: CGPoint) -> Int? {
        guard textStorage.length > 0 else { return nil }
        // Clamp the point into the USED text area: just 0.1 pt below the last line `characterIndex` jumps to the TEXT END
        // instead of the x-matching character of the line (measured: anchor "leeren." instead of "Wichtig" — the press point
        // lay exactly one line height low). Clamped, a finger in the gap between blocks also hits the right spot of the
        // edge line.
        let used = layoutManager.usedRect(for: textContainer)
        let clamped = CGPoint(
            x: min(max(point.x, used.minX), max(used.minX, used.maxX - 0.5)),
            y: min(max(point.y, used.minY), max(used.minY, used.maxY - 0.5))
        )
        var fraction: CGFloat = 0
        let index = layoutManager.characterIndex(
            for: clamped, in: textContainer, fractionOfDistanceBetweenInsertionPoints: &fraction
        )
        return min(index, textStorage.length - 1)
    }

    /// Word boundaries via the tokenizer (knows language and punctuation); on whitespace between words the selection falls
    /// back to the single character — so dragging grows the highlight without gaps.
    private func wordRange(at point: CGPoint) -> NSRange? {
        guard let index = characterIndex(at: point) else { return nil }
        guard let position = position(from: beginningOfDocument, offset: index) else {
            return NSRange(location: index, length: 1)
        }
        for direction in [UITextDirection.storage(.forward), .storage(.backward)] {
            if let range = tokenizer.rangeEnclosingPosition(position, with: .word, inDirection: direction) {
                let location = offset(from: beginningOfDocument, to: range.start)
                let length = offset(from: range.start, to: range.end)
                if length > 0 { return NSRange(location: location, length: length) }
            }
        }
        return NSRange(location: index, length: 1)
    }

    private func windowRect(of range: NSRange) -> CGRect {
        let glyphs = layoutManager.glyphRange(forCharacterRange: range, actualCharacterRange: nil)
        let rect = layoutManager.boundingRect(forGlyphRange: glyphs, in: textContainer)
        return convert(rect, to: nil)
    }

    /// While the marker follows the finger, no gesture of the environment may cut in. Two disturbers, both measured:
    ///
    /// 1. The pan of the timeline — the simultaneity release above would let it scroll along.
    /// 2. Every foreign recognizer with `cancelsTouchesInView` — namely SwiftUI's long press for the whole-message dialog. It
    ///    recognizes about 0.08 s AFTER our start and cuts this view's touch stream. The session survives that by now
    ///    (handover to the own recognizer), but it is cleaner to switch the disturber off for the duration of the session:
    ///    then the primary event source stays alive.
    ///
    /// The walk deliberately begins at the SUPERVIEW — the recognizers of this view (our own and the built-in ones of the
    /// UITextView) stay untouched.
    private func suspendCompeting(_ suspend: Bool) {
        if suspend {
            var view = superview
            var found: [UIGestureRecognizer] = []
            while let current = view {
                for recognizer in current.gestureRecognizers ?? []
                where recognizer.isEnabled && (recognizer.cancelsTouchesInView || recognizer is UIPanGestureRecognizer) {
                    recognizer.isEnabled = false
                    found.append(recognizer)
                }
                if timelineScroll == nil, let scroll = current as? UIScrollView { timelineScroll = scroll }
                view = current.superview
            }
            suspendedGestures = found
            Self.trace("competing gestures disabled: \(found.count)")
        } else {
            suspendedGestures.forEach { $0.isEnabled = true }
            suspendedGestures = []
        }
    }

    /// The timeline this view hangs in — for the standing highlight (scroll observation), if `suspendCompeting` has not
    /// already found it.
    private func ancestorScroll() -> UIScrollView? {
        var view = superview
        while let current = view {
            if let scroll = current as? UIScrollView { return scroll }
            view = current.superview
        }
        return nil
    }
}

/// Preview chip of the text marker: floats above the finger and shows the end of the selection live (see
/// `MarkerTextUIView.peekChip` — the thumb covers the highlighted part itself). Deliberately no accessibility element:
/// VoiceOver and UI tests keep seeing only the message text.
private final class MarkerPeekChip: UIView {
    private let label = UILabel()

    init() {
        super.init(frame: .zero)
        isUserInteractionEnabled = false
        accessibilityElementsHidden = true
        backgroundColor = CbColor.ui(.elevated)
        layer.cornerRadius = 10
        layer.cornerCurve = .continuous
        layer.borderWidth = 1 / UIScreen.main.scale
        layer.borderColor = UIColor.separator.cgColor
        layer.shadowColor = UIColor.black.cgColor
        layer.shadowOpacity = 0.18
        layer.shadowRadius = 10
        layer.shadowOffset = CGSize(width: 0, height: 4)
        label.font = .preferredFont(forTextStyle: .footnote)
        // Follows the trait of the window the chip hangs on — cbase's text size is a trait on the window (Kit/TextSize.swift),
        // `preferredFont` alone would read the iPhone's.
        label.adjustsFontForContentSizeCategory = true
        label.textColor = .label
        // The END of the selection is the information (that is where the finger is extending right now); excess length
        // therefore drops off at the front.
        label.lineBreakMode = .byTruncatingHead
        addSubview(label)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    func update(text: String, above point: CGPoint, in window: UIWindow) {
        if superview !== window { window.addSubview(self) }
        label.text = text
        let maxWidth = min(280, window.bounds.width - 24)
        let fit = label.sizeThatFits(CGSize(width: maxWidth - 20, height: 44))
        let width = min(maxWidth, fit.width + 20)
        let height = fit.height + 12
        var x = point.x - width / 2
        x = max(12, min(x, window.bounds.width - width - 12))
        // Above the finger, with air for the thumb; directly under the header bar dodge to BELOW the touch instead.
        var y = point.y - 64 - height
        if y < window.safeAreaInsets.top + 52 { y = point.y + 44 }
        frame = CGRect(x: x, y: y, width: width, height: height)
        label.frame = CGRect(x: 10, y: 6, width: width - 20, height: height - 12)
    }
}

/// SwiftUI shell of the marker text. Sizing as in `ChatInputTextView`: TextKit measures and draws with the same machinery —
/// measured and rendered height cannot diverge (the phantom-height trap of the hosting cells).
private struct MarkerTextView: UIViewRepresentable {
    let attributed: NSAttributedString
    /// Cheap comparison for `updateUIView` — source + style, instead of an attribute comparison.
    let key: String
    let onHighlight: (ChatTextSelection) -> Void

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> MarkerTextUIView {
        // TextKit 1 explicitly (`layoutManager` carries the point ↔ character geometry) — but via the DESIGNATED init with a
        // container of our own. NEVER `MarkerTextUIView(usingTextLayoutManager: false)`: that is a UIKit FACTORY, which does
        // not initialize the stored Swift properties of the SUBCLASS. Measured: `markerAnchorRange` (Optional<NSRange>) read
        // on the fresh instance as `.some({0, 0})` instead of `nil` (zero memory = Some tag), and the haptic generator was a
        // msgSend-on-nil mock — the 0.5 s trigger therefore considered the session "already active" and never started.
        let storage = NSTextStorage()
        let manager = NSLayoutManager()
        let container = NSTextContainer(size: CGSize(width: 0, height: CGFloat.greatestFiniteMagnitude))
        container.widthTracksTextView = true
        storage.addLayoutManager(manager)
        manager.addTextContainer(container)
        let view = MarkerTextUIView(frame: .zero, textContainer: container)
        view.setup()
        view.setMarkerText(attributed)
        context.coordinator.key = key
        return view
    }

    func updateUIView(_ uiView: MarkerTextUIView, context: Context) {
        uiView.onHighlight = onHighlight
        guard context.coordinator.key != key else { return }
        context.coordinator.key = key
        // FIRST clear the old highlight — its range belongs to the old text.
        uiView.clearHighlight()
        uiView.setMarkerText(attributed)
    }

    func sizeThatFits(
        _ proposal: ProposedViewSize, uiView: MarkerTextUIView, context: Context
    ) -> CGSize? {
        let width = proposal.width ?? 320
        guard width > 0 else { return nil }
        #if DEBUG
        let start = CACurrentMediaTime()
        defer { PerfProbe.shared.add("marker.sizeFits", CACurrentMediaTime() - start) }
        #endif
        return CGSize(width: width, height: uiView.markerHeight(forWidth: width))
    }

    final class Coordinator {
        var key = ""
    }
}

/// Message text that can be highlighted — but ONLY where the environment registers a receiver for the selection (the cells
/// of the inverted list). Everywhere else it renders exactly as before as a SwiftUI `Text`.
struct ChatHighlightableText: View {
    let source: String
    var markdown = true
    /// Fixed font size (headings). nil = running text at the environment's base size.
    var fontSize: CGFloat?
    var fontWeight: UIFont.Weight = .regular
    var textColor: UIColor?

    @Environment(\.chatTextHighlight) private var highlight
    /// The running-text size of this environment — and the ONLY way it arrives here. The marker branch below builds a UIKit
    /// text; that cannot inherit a SwiftUI font, not even one a container explicitly chose. Whoever overrides the font of a
    /// `MarkdownView` must therefore set THIS value too — see the call sites at the info row and the channel card.
    @Environment(\.chatMarkdownBaseSize) private var baseSize
    @Environment(\.chatMarkdownSecondaryText) private var secondaryText
    /// Text size (Settings → Appearance, for the whole app): the UIKit branch cannot inherit it from SwiftUI and therefore
    /// recomputes it explicitly — running text on the curve of `.body`, headings (fixed size) on that of their text style,
    /// the same computation as `cbFont` in the SwiftUI branch below.
    @Environment(\.dynamicTypeSize) private var textSize
    /// The chat's typeface (Settings → Appearance) — the UIKit branch cannot inherit that either.
    @ObservedObject private var typeface = ChatTypefaceStore.shared

    var body: some View {
        if let highlight {
            let size = fontSize ?? baseSize
            let color = textColor ?? (secondaryText ? .secondaryLabel : .label)
            let scaling = ChatInlineScaling(
                style: fontSize.map(cbUITextStyle) ?? .body,
                category: UIContentSizeCategory(textSize),
                fixed: fontSize != nil
            )
            let font = scaling.scale(typeface.choice.uiFont(size: size, weight: fontWeight))
            MarkerTextView(
                attributed: ChatInlineText.attributed(
                    source,
                    markdown: markdown,
                    size: size,
                    weight: fontWeight,
                    scaling: scaling,
                    color: color,
                    typeface: typeface.choice
                ),
                // Text size and typeface belong in the key: a new key resets the text and throws away the view's measurement
                // stock (see `ChatTimelineStage.setTextSize`).
                key: "\(size)|\(textSize)|\(typeface.choice.rawValue)|\(fontWeight.rawValue)|\(secondaryText)|\(textColor != nil)|\(source)",
                onHighlight: highlight
            )
            // List bullets align their glyph to the FIRST text line; a bare UIKit view reports its bottom edge as baseline —
            // the glyph would then sit at the last line of the paragraph.
            .alignmentGuide(.firstTextBaseline) { _ in font.ascender }
        } else if let fontSize {
            // `chatFont(.fest)` instead of `cbFont`: the same computation, plus the chat's typeface.
            text
                .chatFont(.fixed(fontSize), weight: swiftUIWeight)
                .fixedSize(horizontal: false, vertical: true)
        } else {
            text
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var text: Text {
        markdown ? Text(markdown: source) : Text(source)
    }

    private var swiftUIWeight: Font.Weight {
        switch fontWeight {
        case .bold: return .bold
        case .semibold: return .semibold
        default: return .regular
        }
    }
}

/// The small menu on the marker: "Reply / Copy". It positions itself at the reported selection rectangle — preferably
/// above, otherwise below.
///
/// DELIBERATELY WITHOUT a backdrop: a screen-sized, tappable surface above the chat used to catch every tap beside it as
/// "close" — and with it every scroll movement, so the timeline was nailed down while the menu was open. Now only the menu
/// itself is touchable, everything else goes to the list. It closes via a menu action, a tap into the text
/// (`MarkerTextUIView.handleTap`) or the next highlight.
struct ChatSelectionMenuOverlay: View {
    let selection: ChatTextSelection
    /// Current position in the window — moves with the highlighted text while scrolling.
    let rect: CGRect
    /// "Reply" puts a quote above the input — without a receiver the entry is missing. An ARCHIVED chat gives none: there
    /// is no input, and the text would land invisibly in the draft.
    let onAsk: (() -> Void)?
    let onCopy: () -> Void
    /// "Adjust": have the selection reworded according to an instruction — the root opens the sheet, the result lands in the
    /// clipboard. Without a receiver the entry is missing.
    var onAdjust: (() -> Void)? = nil

    @State private var menuSize = CGSize(width: 240, height: 44)

    var body: some View {
        GeometryReader { geo in
            let frame = geo.frame(in: .global)
            let local = rect.offsetBy(dx: -frame.minX, dy: -frame.minY)
            menu
                .onGeometryChange(for: CGSize.self, of: \.size) { menuSize = $0 }
                .position(position(in: geo.size, around: local))
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("chat-selection-menu")
    }

    private var menu: some View {
        HStack(spacing: 0) {
            if let onAsk {
                button(L("Reply"), icon: "arrowshape.turn.up.left", id: "ask", action: onAsk)
                Divider().frame(height: 24)
            }
            button(L("Copy"), icon: "doc.on.doc", id: "copy", action: onCopy)
            if let onAdjust {
                Divider().frame(height: 24)
                button(L("Adjust"), icon: "wand.and.stars", id: "adjust", action: onAdjust)
            }
        }
        .background(CbColor.surface, in: Capsule())
        .overlay(Capsule().strokeBorder(CbColor.edge))
        .shadow(color: .black.opacity(0.18), radius: 10, y: 3)
    }

    private func button(_ title: String, icon: String, id: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: icon)
                    .font(.symbol(13, weight: .medium))
                Text(title)
                    .cbFont(14, weight: .medium)
                    // Symbol and word in ONE line — a word that wraps onto two lines looked broken.
                    .lineLimit(1)
                    .fixedSize()
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 11)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("chat-selection-\(id)")
    }

    private func position(in size: CGSize, around rect: CGRect) -> CGPoint {
        let x = min(max(rect.midX, menuSize.width / 2 + 10), size.width - menuSize.width / 2 - 10)
        var y = rect.minY - menuSize.height / 2 - 12
        if y < menuSize.height / 2 + 8 { y = rect.maxY + menuSize.height / 2 + 12 }
        y = min(y, size.height - menuSize.height / 2 - 8)
        return CGPoint(x: x, y: y)
    }
}
