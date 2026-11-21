// DEBUG-only frame-by-frame traces (new-row entrance, keyboard motion) written as CSV for the UI probes.
import SwiftUI
import UIKit

#if DEBUG
/// Frame-by-frame trace of a new row ENTERING — DEBUG only, active only with a file path in CBASE_ENTRANCE_TRACE.
/// Without it the animation cannot be verified: XCUITest reads the accessibility frame, which comes from the MODEL —
/// there the new row sits in its final place from the first moment, whether it slid in or flashed in. So the
/// PRESENTATION is measured (`layer.presentation()`): opacity and position of the new row and of the row above it,
/// which moves up in the same step.
@MainActor
final class ChatEntranceTrace {
    static let shared = ChatEntranceTrace()
    private static let path = ProcessInfo.processInfo.environment["CBASE_ENTRANCE_TRACE"]
    /// Optional filter (CBASE_ENTRANCE_TRACE_KIND): only an entrance whose note contains this text is followed. One sent
    /// message triggers several entrances in quick succession (run indicator, user row, answer row) — without the
    /// filter the columns of a trace would mix different cells.
    private static let kindFilter = ProcessInfo.processInfo.environment["CBASE_ENTRANCE_TRACE_KIND"]
    static var isOn: Bool { path != nil }

    private var lines = ["kind,t,opacity,enterY,aboveY,note,screenY,offset,inset,content"]
    /// The trace as text — for the accessibility outlet "expand-trace" (device runs where the file path in
    /// CBASE_ENTRANCE_TRACE is not writable).
    var csv: String { lines.joined(separator: "\n") }

    /// Free diagnostic mark — a row kind of its own, "M": the "E" rows are BURST LIMITS of the entrance evaluation
    /// (`entranceScreenSegments`); a mark in the middle of a burst would chop its segments.
    func mark(_ note: String) {
        guard Self.path != nil else { return }
        lines.append("M,\(stamp()),,,,\"\(note)\"")
    }
    private var link: CADisplayLink?
    private var until = Date.distantPast
    private weak var entering: UIView?
    private weak var above: UIView?
    /// Extra columns re-evaluated every frame (see `Coordinator.traceSample`). They resolve the followed row via its
    /// IDENTIFIER — a held cell reference does not survive several updates because the collection recycles its cells.
    private var extra: (() -> String)?
    private let started = Date()

    /// `entering` is the new row, `above` the row that was the bottom one before it — both as cells of the mirrored
    /// collection. In this world a larger y means HIGHER on the screen.
    func run(
        entering: UIView?, above: UIView?, extra: (() -> String)? = nil, note: String,
        duration: TimeInterval = 2.4
    ) {
        guard Self.path != nil else { return }
        // The mark is ALWAYS written, even for a filtered-out burst: it SEPARATES the sections of the trace, and a
        // per-burst bound needs exactly these boundaries. Measured over all bursts together the distance would be the sum
        // and a jump of a third of a single burst would no longer stand out.
        lines.append("E,\(stamp()),,,,\"\(note)\"")
        // If a trace is already running it stays with ITS cells: switching mid-recording would write two movements into
        // the same columns. The filter only chooses WHICH cells are followed — not whether a burst is noted.
        guard link == nil, Self.kindFilter.map({ note.contains($0) }) ?? true else { return }
        self.entering = entering
        self.above = above
        self.extra = extra
        // Long enough for the WHOLE send: entrance, server echo, first tool call and the start of the answer. Each of
        // these rounds moves the timeline, and only together do they make what the user sees as one movement.
        until = Date().addingTimeInterval(duration)
        sample()
        let link = CADisplayLink(target: self, selector: #selector(tick))
        link.add(to: .main, forMode: .common)
        self.link = link
    }

    @objc private func tick() {
        sample()
        guard Date() > until else { return }
        link?.invalidate()
        link = nil
        flush()
    }

    private func sample() {
        guard Self.path != nil else { return }
        let enterLayer = entering.map { $0.layer.presentation() ?? $0.layer }
        let aboveLayer = above.map { $0.layer.presentation() ?? $0.layer }
        // The position comes from the FRAME of the presentation layer: it carries both the shift from rows moving up and
        // the entrance transform.
        lines.append([
            "S", stamp(),
            enterLayer.map { String(format: "%.3f", $0.opacity) } ?? "",
            enterLayer.map { f($0.frame.minY) } ?? "",
            aboveLayer.map { f($0.frame.minY) } ?? "",
            "",
            extra?() ?? ""
        ].joined(separator: ","))
    }

    private func stamp() -> String { String(format: "%.4f", Date().timeIntervalSince(started)) }
    private func f(_ value: CGFloat) -> String { String(format: "%.2f", value) }

    private func flush() {
        guard let path = Self.path else { return }
        try? lines.joined(separator: "\n").appending("\n")
            .write(toFile: path, atomically: true, encoding: .utf8)
    }
}
#endif

#if DEBUG
/// Numeric diagnostics of the keyboard motion — DEBUG only, active only with a file path in CBASE_KEYBOARD_TRACE. Writes,
/// per frame, the visible position of the timeline content in the window plus all control values (lift, scroll offset,
/// insets, frames, anchors) as CSV. Videos cannot be read by machine; this trace turns "the timeline moves slightly"
/// into a series of numbers.
@MainActor
final class KeyboardTrace: NSObject {
    static let shared = KeyboardTrace()
    fileprivate static let path = ProcessInfo.processInfo.environment["CBASE_KEYBOARD_TRACE"]

    override init() {
        super.init()
        guard Self.path != nil else { return }
        // Also record large offset jumps with their cause (call stack): the "offset hard to 0" reset happens in a layout
        // storm gap in which the display link does not fire — only the setter itself sees it.
        Self.swizzle(#selector(setter: UIScrollView.bounds), with: #selector(UIScrollView.kbTraceSetBounds(_:)))
        Self.swizzle(#selector(UIScrollView.setContentOffset(_:animated:)), with: #selector(UIScrollView.kbTraceSetContentOffset(_:animated:)))
    }

    private static func swizzle(_ original: Selector, with replacement: Selector) {
        guard let a = class_getInstanceMethod(UIScrollView.self, original),
              let b = class_getInstanceMethod(UIScrollView.self, replacement)
        else { return }
        method_exchangeImplementations(a, b)
    }
    private var lines = [
        "kind,t,lift,offset,offsetPres,insetTop,insetBottom,frameMinY,frameMaxY,contentY,ridesUp,contentPos,contentPosPres,contentH,readerBottom,readerBottomPres,note"
    ]
    private var link: CADisplayLink?
    private var until = Date.distantPast
    private weak var stage: ChatStageView?
    private let started = Date()

    func note(_ text: String) {
        guard Self.path != nil else { return }
        lines.append("E,\(stamp()),,,,,,,,,,,,,,,\"\(text)\"")
        flush()
    }

    /// Starts (or extends) the frame-by-frame recording.
    func run(stage: ChatStageView, for duration: TimeInterval) {
        guard Self.path != nil else { return }
        self.stage = stage
        until = max(until, Date().addingTimeInterval(duration))
        sample()
        guard link == nil else { return }
        let link = CADisplayLink(target: self, selector: #selector(tick))
        link.add(to: .main, forMode: .common)
        self.link = link
    }

    @objc private func tick() {
        sample()
        if Date() > until {
            link?.invalidate()
            link = nil
            flush()
        }
    }

    private func sample() {
        guard let stage, let window = stage.window else { return }
        let scroll = stage.collection
        // "lift" is the RENDERED keyboard overlap: distance between the presented composer bottom edge and the bottom
        // edge of the COLLECTION, both in stage coordinates. The composer hangs on the keyboard guide — that edge IS the
        // keyboard edge, and the presentation layer shows what is really on screen. Two metric traps: (1) before the
        // first composer layout its layer frame is 0 and "reference minus 0" would write a phantom maximum into the
        // trace; then the column stays empty. (2) The reference must NOT be the stage extent: during the 34 pt safe-area
        // swap the stage HEIGHT animates as a presentation while the composer stands still in stage coordinates (and on
        // screen) — "stage minus composer" reported 20–36 pt of phantom wobble. The collection's bottom edge is
        // world-fixed (rest-height buffer) and IS the composer's visible resting position.
        var lift = ""
        if let composer = stage.composerView {
            let composerLayer = composer.layer.presentation() ?? composer.layer
            if composerLayer.frame.height > 1 {
                lift = f(max(0, stage.collection.frame.maxY - composerLayer.frame.maxY))
            }
        }
        // Window position of the content origin (content coordinate 0 = edge of the newest message) — via the
        // PRESENTATION layers, because what is rendered counts.
        let contentY: CGFloat
        if let scrollPres = scroll.layer.presentation() {
            contentY = scrollPres.convert(CGPoint.zero, to: window.layer.presentation() ?? window.layer).y
        } else {
            contentY = scroll.convert(CGPoint.zero, to: window).y
        }
        // Largest visible cell — for the rebase columns (model and presentation positions run in pairs when a movement is
        // pure bookkeeping).
        let content = scroll.subviews.max(by: { $0.bounds.height < $1.bounds.height })
        let frame = scroll.convert(scroll.bounds, to: window)
        let offsetPres = scroll.layer.presentation()?.bounds.origin.y ?? .nan
        let contentPos = content?.layer.position.y ?? .nan
        let contentPosPres = content?.layer.presentation()?.position.y ?? .nan
        // Stage bottom edge (model + presented) — separates layout movements of the shell from keyboard/scroll movements.
        let stageBottom = stage.convert(stage.bounds, to: window).maxY
        var stageBottomPres = CGFloat.nan
        if let pres = stage.layer.presentation(), let host = stage.superview {
            stageBottomPres = host.convert(pres.frame, to: window).maxY
        }
        lines.append([
            "S", stamp(),
            lift, f(scroll.contentOffset.y), f(offsetPres),
            f(scroll.adjustedContentInset.top), f(scroll.adjustedContentInset.bottom),
            f(frame.minY), f(frame.maxY), f(contentY),
            // In the ridesUp column (free since the constraint rebuild): the MODEL position of the top edge of the ROOT
            // guide in window coordinates — shows whether the guide follows the keyboard (the stage guide provably did not).
            f(window.rootViewController?.view.keyboardLayoutGuide.layoutFrame.minY ?? .nan),
            f(contentPos), f(contentPosPres),
            f(scroll.contentSize.height), f(stageBottom), f(stageBottomPres), ""
        ].joined(separator: ","))
    }

    private func stamp() -> String { String(format: "%.4f", Date().timeIntervalSince(started)) }
    private func f(_ value: CGFloat) -> String { String(format: "%.2f", value) }

    private func flush() {
        guard let path = Self.path else { return }
        try? lines.joined(separator: "\n").appending("\n")
            .write(toFile: path, atomically: true, encoding: .utf8)
    }
}

extension UIScrollView {
    /// Only the chat timeline matters — it is the only one that is mirrored-large and known via the locator; roughly
    /// filtered by content height.
    private var kbTraceRelevant: Bool { contentSize.height > 2000 }

    @objc fileprivate func kbTraceSetBounds(_ value: CGRect) {
        if kbTraceRelevant, abs(value.origin.y - bounds.origin.y) > 300 {
            KeyboardTrace.shared.note(
                "setBounds \(Int(bounds.origin.y)) -> \(Int(value.origin.y)) | "
                + Thread.callStackSymbols.dropFirst(2).prefix(16).joined(separator: " | ")
            )
        }
        kbTraceSetBounds(value)
    }

    @objc fileprivate func kbTraceSetContentOffset(_ value: CGPoint, animated: Bool) {
        if kbTraceRelevant, abs(value.y - contentOffset.y) > 300 {
            KeyboardTrace.shared.note(
                "setContentOffset \(Int(contentOffset.y)) -> \(Int(value.y)) animated=\(animated) | "
                + Thread.callStackSymbols.dropFirst(2).prefix(16).joined(separator: " | ")
            )
        }
        kbTraceSetContentOffset(value, animated: animated)
    }
}
#endif
