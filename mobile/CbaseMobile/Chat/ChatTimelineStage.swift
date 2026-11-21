import SwiftUI
import UIKit

// ── Inverted UIKit list of the timeline ────────────────────────────────────

/// A timeline row — approval cards, run indicator and error row are rows of the list too. `Hashable`, so the diff can decide
/// per row: same identifier + same content = cell untouched, same identifier + new content = reconfigure only that cell
/// (the streaming path: a token changes exactly ONE cell, never the list).
enum ChatTimelineRowKind: Hashable, Identifiable {
    case permission(PermissionRequest)
    case run(ChatRunRowState)
    case item(TimelineItem)
    /// The day separator above the row `before` (Chat/DaySeparator.swift).
    case day(DayMarker, before: String)
    case error(String)
    // There is no `hero` row: the coding chat greets behind the stage (`MobileChatView.emptyGreeting`), not as a row.

    /// STABLE identifier — it is the identity in the diffable snapshot. Timeline rows carry their TimelineItem identifiers
    /// (see there, "row-…"/"live-…"), the other rows fixed names; collisions are ruled out by the prefixes.
    var id: String {
        switch self {
        case .permission(let request): return "permission-\(request.id)"
        case .run: return "run-indicator"
        case .item(let item): return item.id
        case .day(_, let before): return "day-\(before)"
        case .error: return "inline-error"
        }
    }
}

/// Frozen state of the run indicator — as a value, so the row is Hashable and changes (token counter, wait reason) run as a
/// reconfiguration of exactly this cell.
struct ChatRunRowState: Hashable {
    var waiting: Bool
    var monitors: [String]
    var agents: [String]
    var tasks: [String]
    var wakeupAt: Date?
    var startedAt: Date?
    var inputTokens: Int
    var outputTokens: Int
    /// Is work running (`HistoryState.runRowVisible`)? Without it the row stands only for the pill.
    var running: Bool = true
    /// The running tasks for the pill — a new count reconfigures exactly this cell.
    var runningTasks: RunningTasks.Result = .empty
}

/// Handle from outside onto the list (jump to the end) — a class in the chat's `@State`: it survives body evaluations
/// without the body observing the list.
@MainActor
final class ChatTimelineHandle {
    fileprivate weak var coordinator: ChatTimelineStage.Coordinator?

    /// To the visible end of the chat — in the inverted list the rest position (offset = −top inset), which is fixed
    /// without any height estimate. The path goes through the coordinator, because an ANIMATED ride has to be corrected
    /// afterwards: its target is fixed at the start, but the inset can still change on the way.
    func scrollToLatest(animated: Bool = true) {
        coordinator?.scrollToLatest(animated: animated)
    }
}

/// UICollectionView with a layout hook: after every layout the coordinator checks the fill inset (a short timeline starts
/// at the TOP) and clamps an offset that has become invalid. A subclass of its own, because UIScrollView offers no layout
/// callbacks.
final class ChatTimelineCollectionView: UICollectionView {
    var onLayout: (() -> Void)?
    /// During an expand pin (see `expandPin`) the list lays out WITHOUT implicit animations: otherwise UIKit runs contextual
    /// self-sizing updates over the cell frames with its own ~0.45 s curve while the pin sets the offset at once —
    /// measured, that pushed the timeline 1813 pt away and back ("the chat remounts"). Height snap + offset pin in ONE
    /// transaction stand still.
    var freezeLayoutAnimations = false

    /// The list knows no safe area. With glass it reaches under the status bar (`headerOverhang`), and UIKit would give every
    /// cell that scrolls into the strip a new safe-area inset: its `UIHostingConfiguration` content would be re-measured, the
    /// list would re-query all heights — scrolling over status rows janked (measured: layout 3.3 s instead of 0.6 s, peaks
    /// 257 ms). A negative extra inset on the `ChatStageController` did not work (the cells still got 32–62 pt); only this
    /// value keeps the cells at zero. It is needed nowhere else: the list's insets are set explicitly
    /// (`contentInsetAdjustmentBehavior = .never`, `topInset`), the keyboard follows the stage.
    override var safeAreaInsets: UIEdgeInsets { .zero }

    override func layoutSubviews() {
        #if DEBUG
        let start = CACurrentMediaTime()
        defer { PerfProbe.shared.add("collection.layout", CACurrentMediaTime() - start) }
        #endif
        if freezeLayoutAnimations {
            UIView.performWithoutAnimation { super.layoutSubviews() }
        } else {
            super.layoutSubviews()
        }
        onLayout?()
    }
}

/// Cell of the timeline. It carries the SECOND mirroring (the first sits on the collection, doubly mirrored = upright) —
/// and it asserts it in `layoutSubviews`, not on configuring.
///
/// Reason: `contentConfiguration` REPLACES the `contentView` with a new instance from the configuration, so a mirroring
/// set beforehand is gone. Visible as "some messages are upside down": on the FIRST configuration of a cell the
/// contentView is swapped (row mirrored = upside down), on every further one UIKit sees that the existing contentView
/// carries the configuration and updates it in place (mirroring survives = right way up). Freshly built cells were
/// upside down, recycled ones not.
///
/// The mirroring belongs on the contentView and not on the cell itself: the collection's layout attributes overwrite
/// `cell.transform`.
final class ChatTimelineCell: UICollectionViewCell {
    private static let inversion = CGAffineTransform(scaleX: 1, y: -1)

    /// Called right after configuring, so the row is right in the very first frame; `layoutSubviews` keeps asserting it.
    func applyInversion() {
        if contentView.transform != Self.inversion { contentView.transform = Self.inversion }
    }

    /// An entering row starts transparent (see `Coordinator.hide`). If it is recycled mid-fade the opacity MUST go back to 1 —
    /// otherwise some other message later inherits the invisibility.
    override func prepareForReuse() {
        super.prepareForReuse()
        alpha = 1
    }

    override func layoutSubviews() {
        #if DEBUG
        let start = CACurrentMediaTime()
        defer { PerfProbe.shared.add("cell.layout", CACurrentMediaTime() - start) }
        #endif
        super.layoutSubviews()
        applyInversion()
        #if DEBUG
        if Self.diagPath != nil {
            let fitted = contentView.systemLayoutSizeFitting(
                CGSize(width: bounds.width, height: UIView.layoutFittingCompressedSize.height),
                withHorizontalFittingPriority: .required,
                verticalFittingPriority: .fittingSizeLevel
            ).height
            Self.diag(String(format: "layout bounds=%.1f fitted=%.1f", bounds.height, fitted))
        }
        #endif
    }

    #if DEBUG
    /// Measurement diagnostics (only with a CBASE_CELL_DIAG path): per self-sizing pass write down the proposed and the
    /// delivered height.
    static let diagPath = ProcessInfo.processInfo.environment["CBASE_CELL_DIAG"]
    static func diag(_ line: String) {
        guard let path = diagPath else { return }
        let stamp = String(format: "%.3f", CACurrentMediaTime())
        let data = (stamp + " " + line + "\n").data(using: .utf8)!
        if let handle = FileHandle(forWritingAtPath: path) {
            handle.seekToEndOfFile()
            handle.write(data)
            try? handle.close()
        } else {
            try? data.write(to: URL(fileURLWithPath: path))
        }
    }

    override func preferredLayoutAttributesFitting(
        _ layoutAttributes: UICollectionViewLayoutAttributes
    ) -> UICollectionViewLayoutAttributes {
        let start = CACurrentMediaTime()
        let attributes = super.preferredLayoutAttributesFitting(layoutAttributes)
        PerfProbe.shared.add("cell.preferredFit", CACurrentMediaTime() - start)
        if Self.diagPath != nil {
            Self.diag(String(
                format: "fit item=%d proposed=%.1f -> %.1f",
                layoutAttributes.indexPath.item,
                layoutAttributes.size.height,
                attributes.size.height
            ))
        }
        return attributes
    }
    #endif
}

/// The inverted list plus composer on ONE stage: collection and cell contents are each mirrored once (doubly mirrored =
/// upright), element 0 sits at offset 0 — the newest message, directly above the composer. The data source is a
/// UICollectionViewDiffableDataSource over the stable row identifiers; the cells render the existing SwiftUI rows via
/// UIHostingConfiguration. The composer hangs on the `keyboardLayoutGuide` (see `ChatStageController`).
///
/// A rebuild of its own (SwiftUI ScrollView plus TextField) had exactly the faults that were measured out and fixed here
/// over weeks.
struct ChatTimelineStage: UIViewControllerRepresentable {
    let rows: [ChatTimelineRowKind]
    let handle: ChatTimelineHandle
    let colorScheme: ColorScheme
    /// First load: hide only the list (the skeleton lies behind it), the composer stays visible.
    let listHidden: Bool
    @Binding var awayFromLatest: Bool
    @Binding var showingFiles: Bool
    /// The "Chat settings" sheet — the model button next to the context bar opens it.
    @Binding var showingSettings: Bool
    let chatId: String
    let model: ChatViewModel
    let state: AppState
    let loadAttachment: (Attachment) async throws -> Data
    let onAnswerAsk: (String, [AskAnswer]) -> Void
    let onDecidePermission: (PermissionRequest, Bool, String, String) -> Void
    /// Approval card of a tool with an approval marker: requestId, approve, reason, parameters.
    let onDecideApproval: (String, Bool, String, JSONValue?) -> Void
    let onMessageAction: (String) -> Void
    let onTextHighlight: (ChatTextSelection) -> Void
    let onViewImage: (UIImage) -> Void
    let onPlayVideo: (URL) -> Void
    /// Thinking or tool calls of a row as a sheet from below (see `ChatDetailRequest`) — presented from the chat's root, not
    /// from the cell.
    var onShowDetail: ((ChatDetailRequest) -> Void)?
    /// Subagent sheet, selected on the tapped call (argument: its block id). If missing (`ChatView` always sets it), the mark
    /// in the timeline falls back to the call sheet.
    var onShowAgents: ((String) -> Void)?
    /// Sheet of the running tasks (tap on the pill of the run row) — presented from the chat's root.
    var onShowTasks: (() -> Void)?
    /// Inset at the TOP of the timeline: the header lies above the stage, the timeline runs beneath it — it starts lower by
    /// its height. Mirrored this is the `contentInset.bottom` of the collection.
    var topInset: CGFloat = 0
    /// Text size (Settings → Appearance, for the whole app): it arrives as a trait on the window and reaches the cells through
    /// UIKit by itself. It is read here only so the stage re-measures ALL rows on a change (`setTextSize`).
    @Environment(\.dynamicTypeSize) private var textSize
    /// The chat's typeface (Settings → Appearance, Kit/ChatTypeface.swift) — read for the same reason: another font wraps
    /// every row differently.
    @ObservedObject private var typeface = ChatTypefaceStore.shared

    func makeCoordinator() -> Coordinator { Coordinator() }

    /// The hosted composer tree. Reassigned on every update — the bindings and the `model` reference stay identical, so
    /// SwiftUI diffs only content.
    private var composerRoot: ChatComposerRoot {
        ChatComposerRoot(
            model: model,
            state: state,
            showingFiles: $showingFiles,
            showingSettings: $showingSettings
        )
    }

    /// The floating arrow to the chat end (own mini-hosting, see `ChatStageController.arrowHost`).
    private var arrowOverlay: ChatArrowOverlay {
        ChatArrowOverlay(away: awayFromLatest, handle: handle)
    }

    func makeUIViewController(context: Context) -> ChatStageController {
        let coordinator = context.coordinator
        let collection = ChatTimelineCollectionView(frame: .zero, collectionViewLayout: Self.makeLayout())
        collection.backgroundColor = .clear
        // The inversion: once the collection, once every cell (see registration).
        collection.transform = CGAffineTransform(scaleX: 1, y: -1)
        // Insets stay entirely in our own hands: top/bottom are swapped in the mirrored world, and the stage handles the
        // keyboard itself — an automatic safe-area adjustment would mix up both.
        collection.contentInsetAdjustmentBehavior = .never
        collection.alwaysBounceVertical = true
        collection.allowsSelection = false
        // If the finger moves toward the keyboard, it attaches and follows — thanks to the `KeyboardGripAccessory` already
        // from the island's top edge, not only at the real keyboard edge. `.interactiveWithAccessory` is MANDATORY: plain
        // `.interactive` decouples the accessory from the keyboard at gesture start — the guide jumps by its height, and the
        // island visibly sank behind the keyboard ("input field disappears on touch").
        collection.keyboardDismissMode = .interactiveWithAccessory
        collection.accessibilityIdentifier = "chat-timeline"
        collection.contentInset = UIEdgeInsets(
            top: Coordinator.basePadding, left: 0,
            bottom: Coordinator.basePadding, right: 0
        )
        collection.contentOffset = CGPoint(x: 0, y: -Coordinator.basePadding)
        collection.delegate = coordinator
        collection.onLayout = { [weak coordinator] in coordinator?.collectionDidLayout() }
        let controller = ChatStageController(
            collection: collection, composer: composerRoot, arrow: arrowOverlay
        )
        coordinator.install(controller.stage)
        coordinator.setTopInset(topInset)
        // If ONLY the guide moves (keyboard), the collection does not lay out — the stage hook then recomputes the inset.
        controller.stage.onLayout = { [weak coordinator] in coordinator?.collectionDidLayout() }
        handle.coordinator = coordinator
        return controller
    }

    func updateUIViewController(_ controller: ChatStageController, context: Context) {
        context.coordinator.parent = self
        context.coordinator.setTopInset(topInset)
        // Cells and hosted composer do not inherit SwiftUI's environment — the effective colour scheme arrives as a UIKit
        // override, otherwise the stage would ignore the theme switch.
        controller.stage.overrideUserInterfaceStyle = colorScheme == .dark ? .dark : .light
        controller.composerHost.rootView = composerRoot
        controller.arrowHost.rootView = arrowOverlay
        // Hidden arrow: its small hosting rectangle must not eat taps or drags either — the timeline behind should get them.
        controller.arrowHost.view.isUserInteractionEnabled = awayFromLatest
        controller.stage.collection.alpha = listHidden ? 0 : 1
        // BEFORE `apply`: a changed text size leaves the row list untouched, so `apply` would bail out at once with an
        // unchanged state.
        context.coordinator.setTextSize(textSize, typeface: typeface.choice)
        context.coordinator.apply(rows)
    }

    /// One column, height self-sized per row. 13 pt side margin and 11 pt row spacing.
    private static func makeLayout() -> UICollectionViewCompositionalLayout {
        let size = NSCollectionLayoutSize(
            widthDimension: .fractionalWidth(1),
            heightDimension: .estimated(80)
        )
        let item = NSCollectionLayoutItem(layoutSize: size)
        let group = NSCollectionLayoutGroup.vertical(layoutSize: size, subitems: [item])
        let section = NSCollectionLayoutSection(group: group)
        section.interGroupSpacing = 11
        section.contentInsets = NSDirectionalEdgeInsets(top: 0, leading: 13, bottom: 0, trailing: 13)
        return UICollectionViewCompositionalLayout(section: section)
    }

    @MainActor
    final class Coordinator: NSObject, UICollectionViewDelegate {
        /// Vertical padding of the list. Mirrored: `contentInset.top` is the visible padding at the BOTTOM at the composer,
        /// `.bottom` the padding at the TOP at the start of the timeline.
        static let basePadding: CGFloat = 12
        /// Inset at the top (header above the stage) — see `ChatTimelineStage.topInset`.
        private(set) var topInset: CGFloat = 0
        /// Last applied text size — see `setTextSize`. `nil`: none seen yet.
        private var textSize: DynamicTypeSize?
        /// Last applied typeface — same way as the text size.
        private var typeface: ChatTypeface?
        var parent: ChatTimelineStage?

        /// The way into the subagent sheet, or nil if this stage offers none. Nil means "there is none" — the mark in the
        /// timeline then falls back to the ordinary call sheet instead of tapping into the void.
        private var agentPresenter: ((String) -> Void)? {
            guard let handler = parent?.onShowAgents else { return nil }
            return { blockId in handler(blockId) }
        }
        private weak var stage: ChatStageView?
        private weak var collection: ChatTimelineCollectionView?
        private var dataSource: UICollectionViewDiffableDataSource<Int, String>?
        private var rowsById: [String: ChatTimelineRowKind] = [:]
        private var orderedIds: [String] = []
        private var lastRows: [ChatTimelineRowKind] = []
        /// The answer row that is currently "running": the newest assistant row while the run runs (`busy`), otherwise nil. It
        /// is NOT in the row itself (nobody sets `streaming` when a running chat is opened), but has to get into the cell —
        /// and because `apply` only reconfigures cells whose ROW VALUE changed, a change of this identifier is explicitly
        /// counted as a change there. Otherwise the spinner would keep spinning on the last call although the run is long over.
        private(set) var liveId: String?
        /// State of this chat's subagents (`ChatViewModel.agentStates`) as `apply` last read it. It is NOT in the row value: a
        /// background agent the stream no longer drives changes no timeline row — only its mark. `apply` therefore explicitly
        /// counts every row that carries a changed agent as a change (as with `liveId`); otherwise the mark would carry
        /// "running" until the cell happens to be recycled.
        private(set) var agentStates: [String: String] = [:]
        /// An animated ride to the chat end is still running. Its target was computed at the start — it has to be corrected at
        /// the end (see `scrollToLatest`).
        private var pendingLatest = false
        /// Fill remainder of the last layout computation (see `collectionDidLayout`). > 0 means: the timeline is SHORTER than
        /// the window and starts at the top — then a new row shifts nothing, and the entrance is limited to fading in.
        private var lastFill: CGFloat = 0
        /// At most this many rows enter together. More at once is not "something is coming" but a reload — it belongs in the
        /// picture at once and calmly.
        private static let maxEntering = 4
        /// The spring of the follow-up (see `pushUp`). `omega` deliberately smaller than for the drawers: sending moves the
        /// timeline about 95 pt and it should glide, not snap — at 20 rad/s that is about 0.35 s to standstill. The time-step
        /// cap stands at ONE frame: the pass that kicks off the movement also builds the new cells (measured 59–79 ms of
        /// standstill), and with the drawers' larger cap the first frame would bring a third of that time at once — visible
        /// as a start jolt of 14 instead of 4 pt.
        private let slide = SettleSpring(omega: 20, maxStep: 1.0 / 60)
        /// Is a follow-up running? Then the scroll offset belongs to the spring: the list is DELIBERATELY shifted out of the
        /// rest position, and everything that would otherwise read this state as "the reader scrolled up" (anchor, jump arrow,
        /// the clamp in `collectionDidLayout`) must stay out of it. The pinning itself counts too: between re-sorting and the
        /// start of the spring the offset is already shifted, and `scrollViewDidScroll` fires.
        private var pinning = false
        private var sliding: Bool { slide.isRunning || pinning }
        /// Tap-expand (tool call, thinking block, approval details): the visual TOP EDGE of the row should survive the
        /// announced height change — in the mirrored world `frame.maxY` is the visual top edge. Without the pin the row would
        /// grow UPWARD (the bottom edge is the layout fixed point) and push the timeline away over itself. The pin is
        /// EVENT-DRIVEN, not wall-clock-driven: first ARMED (waits for the actual height change — the SwiftUI build of a large
        /// output takes many frames on the device, a fixed short deadline expired there before the jump even landed), from the
        /// first change FOLLOWING (holds the top edge per layout pass until the self-sizing has settled).
        private struct ExpandPin {
            let id: String
            /// Distance top edge ↔ offset at the moment of the tap; refreshed per pass in the armed state, so legitimate offset
            /// corrections (keyboard, composer growth) are not misread as an expand push.
            var gapTop: CGFloat
            /// Last seen row height — the reference by which changes are detected.
            var height: CGFloat
            let armedAt: CFTimeInterval
            /// Time of the LAST observed height change (nil = still armed). The pin lives until 0.6 s AFTER the last change, not
            /// after the first: the offset jump brings older, only ESTIMATED rows into the window, whose realisation triggers a
            /// further layout correction fractions later — if the pin (and with it the animation freeze) dies before, exactly
            /// that correction runs as a visible, animated slide of the whole timeline.
            var lastChangeAt: CFTimeInterval?
        }
        private var expandPin: ExpandPin? {
            // As long as the pin lives the list lays out without animation — every clear point (drag, structure update, ride to
            // the end, expiry) thaws it automatically.
            didSet { collection?.freezeLayoutAnimations = expandPin != nil }
        }
        /// Composer area of the last layout pass (< 0 = never measured) — the guard that drops the pin on keyboard/composer
        /// movement.
        private var lastComposerArea: CGFloat = -1
        /// Content height of the last layout pass (< 0 = never measured) — basis of the surcharge for late height reports (see
        /// `collectionDidLayout`).
        private var lastContentHeight: CGFloat = -1
        /// Expanding is NOT scrolling: the pin compensation pushes the offset out of the rest position by the expand height,
        /// and from 200 pt the jump arrow popped up — with a spring animation RIGHT above the tapped row (in the usual case,
        /// the last turn, it sticks to the composer). That was the "the row remounts" flash, and the next tap on the row hit
        /// the arrow instead of it (animated ride to the end — "the whole chat remounts"). As long as the distance to the rest
        /// position comes only from expanding, the arrow therefore stays away; real scrolling, new rows or the return to the
        /// rest position lift the hold.
        private var awayHeldByExpansion = false

        /// To the chat end, but GUARANTEED all the way. `setContentOffset(animated:)` freezes its target at the start; if the top
        /// inset changes on the way (fill remainder in a short timeline, keyboard, new rows), the ride ends beside it — that was
        /// "the arrow sometimes does not scroll all the way down". So the target is set exactly once more after the animation
        /// ends.
        func scrollToLatest(animated: Bool = true) {
            guard let collection else { return }
            #if DEBUG
            // Diagnostic mark (cheap — NO Thread.callStackSymbols: its symbolication cost ~50 ms in the hot path and made the
            // first push frame a jump). That is how it was convicted: the "ghostly" ride to the rest position after expanding was
            // a tap on the jump arrow that had popped up through the expanding.
            if ChatEntranceTrace.isOn {
                ChatEntranceTrace.shared.mark("scrollToLatest animated=\(animated)")
            }
            #endif
            // The ride to the chat end wins against a running expand pin.
            expandPin = nil
            awayHeldByExpansion = false
            // If the timeline is already following (see `pushUp`), it is on the same way — a second ride there would only run over
            // the spring. The call comes along when sending: the own message brings the reader back to the end.
            if sliding, animated { return }
            let target = CGPoint(x: 0, y: -collection.adjustedContentInset.top)
            guard animated, abs(collection.contentOffset.y - target.y) > 0.5 else {
                pendingLatest = false
                collection.setContentOffset(target, animated: false)
                updateAway()
                return
            }
            pendingLatest = true
            collection.setContentOffset(target, animated: true)
        }

        /// End of the animated ride: set exactly to the CURRENT rest position.
        func scrollViewDidEndScrollingAnimation(_ scrollView: UIScrollView) {
            guard pendingLatest else { return }
            pendingLatest = false
            let rest = -scrollView.adjustedContentInset.top
            if abs(scrollView.contentOffset.y - rest) > 0.5 {
                scrollView.setContentOffset(CGPoint(x: 0, y: rest), animated: false)
            }
            updateAway()
        }

        /// If the finger intervenes, the list belongs to it — the post-correction is dropped, and a running follow-up aborts.
        /// Without the abort the spring would write against the drag gesture every frame.
        func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
            pendingLatest = false
            expandPin = nil
            awayHeldByExpansion = false
            slide.stop()
        }

        /// Mirrored, `.bottom` is the visible padding at the TOP. Fill inset and rest position are recomputed by
        /// `collectionDidLayout` on the next layout, which this change triggers.
        func setTopInset(_ inset: CGFloat) {
            guard abs(inset - topInset) > 0.5 else { return }
            topInset = inset
            guard let collection else { return }
            collection.contentInset.bottom = Self.basePadding + inset
            collection.verticalScrollIndicatorInsets.bottom = inset
        }

        /// Text size changed (Settings → Appearance or iPhone). Unlike with new rows NOTHING changes in the row list —
        /// `apply(_:)` bails out at an unchanged state, and the already configured cells would keep their old SwiftUI tree,
        /// their measured row heights (`MarkerTextUIView.fitCache`) and their old frames. Visible: nothing changes until a cell
        /// is recycled by chance — then old and new size would stand mixed in the timeline, with clipped last lines. So
        /// explicitly re-measure everything.
        func setTextSize(_ size: DynamicTypeSize, typeface kind: ChatTypeface) {
            guard size != textSize || kind != typeface else { return }
            let first = textSize == nil
            textSize = size
            typeface = kind
            guard !first, let collection, let dataSource, !orderedIds.isEmpty else { return }
            // An open expand pin would write against the re-measurement (as with the structure update in `apply`).
            expandPin = nil
            let anchor = visibleAnchor()
            var snapshot = dataSource.snapshot()
            // Reconfiguring is the way the new text size reaches every cell safely — and at the same time the one that clears the
            // measurement stock of every MarkerTextUIView: its `key` carries the text size, a changed key calls `setMarkerText`,
            // and that throws `fitCache` away. A second cleanup path would be a second mechanism for the same thing.
            snapshot.reconfigureItems(orderedIds)
            UIView.performWithoutAnimation {
                dataSource.apply(snapshot, animatingDifferences: false)
                collection.collectionViewLayout.invalidateLayout()
                // ONE layoutIfNeeded is not enough — the reason is at `settleLayout`. Only after this rest is the total height
                // right that `restore` clamps to.
                settleLayout(collection)
                restore(anchor, shrinkingContent: true)
            }
        }

        func install(_ stage: ChatStageView) {
            self.stage = stage
            let collection = stage.collection
            self.collection = collection
            #if DEBUG
            // The probe's frame guard separates "normal scrolling" from "highlight running" — the second phase is the one with
            // auto-scrolling at the edge.
            PerfProbe.shared.isMarking = { MarkerTextUIView.markerSessionActive }
            PerfProbe.shared.startFrameWatch()
            #endif
            let registration = UICollectionView.CellRegistration<ChatTimelineCell, String> {
                [weak self] cell, _, id in
                guard let self, let row = self.rowsById[id] else { return }
                #if DEBUG
                let start = CACurrentMediaTime()
                defer { PerfProbe.shared.add("cell.configure", CACurrentMediaTime() - start) }
                #endif
                cell.contentConfiguration = UIHostingConfiguration { self.rowView(row) }
                    .margins(.all, 0)
                    .background(.clear)
                // FIRST configure, THEN mirror: the assignment above swaps the contentView (see `ChatTimelineCell`).
                cell.applyInversion()
            }
            dataSource = UICollectionViewDiffableDataSource<Int, String>(collectionView: collection) {
                collection, indexPath, id in
                collection.dequeueConfiguredReusableCell(using: registration, for: indexPath, item: id)
            }
        }

        /// The newest answer row (element 0 sits at the composer, so the FIRST in the array) while a run is running — see
        /// `liveId`. If a USER row lies before it there is none: between sending and the first row of the new answer the
        /// PREVIOUS answer would otherwise be "live", and its aborted calls would shimmer once more for the duration of the
        /// latency. The rule itself lives ONCE in `HistoryState.runningResponseId`; its second reader is
        /// `ChatViewModel.runningResponseId` (the state of the subagents).
        private static func liveItemId(_ rows: [ChatTimelineRowKind], busy: Bool) -> String? {
            guard busy else { return nil }
            var newestFirst: [(role: String, id: String)] = []
            for row in rows {
                guard case .item(let item) = row else { continue }
                newestFirst.append((role: item.role.rawValue, id: item.id))
                if item.role == .user || item.role == .assistant { break }
            }
            return HistoryState.runningResponseId(newestFirst: newestFirst, busy: busy)
        }

        /// Does this row carry the mark of one of the named subagent calls? (Marks only appear at the top level of an answer,
        /// see `groupToolCalls`.)
        private static func carriesAgents(_ row: ChatTimelineRowKind?, _ blockIds: Set<String>) -> Bool {
            guard !blockIds.isEmpty, case .item(let item)? = row, item.role == .assistant else { return false }
            return item.blocks.contains { blockIds.contains($0.id) }
        }

        /// SwiftUI content of a row. The environment is set here PER CELL: UIHostingConfiguration inherits nothing from the
        /// surrounding SwiftUI tree — without the two values a long press would run into the system menu (which inherited the
        /// mirroring) and text selection would tear the gesture away.
        @ViewBuilder
        private func rowView(_ row: ChatTimelineRowKind) -> some View {
            let parent = self.parent
            Group {
                switch row {
                case .permission(let request):
                    PermissionCard(request: request) { allow, reason, remember in
                        parent?.onDecidePermission(request, allow, reason, remember)
                    }
                case .run(let run):
                    RunIndicator(
                        waiting: run.waiting,
                        monitors: run.monitors,
                        agents: run.agents,
                        tasks: run.tasks,
                        wakeupAt: run.wakeupAt,
                        startedAt: run.startedAt,
                        inputTokens: run.inputTokens,
                        outputTokens: run.outputTokens,
                        runningTasks: run.runningTasks,
                        running: run.running,
                        onPill: { parent?.onShowTasks?() }
                    )
                case .item(let item):
                    TimelineRow(
                        item: item,
                        chatId: parent?.chatId ?? "",
                        loadAttachment: parent?.loadAttachment ?? { _ in Data() },
                        onAnswerAsk: { requestId, answers in parent?.onAnswerAsk(requestId, answers) },
                        loadCaptureFile: parent?.model.captureFileData,
                        captureFileURL: parent?.model.captureFileURL,
                        onDecideApproval: { requestId, allow, reason, input in parent?.onDecideApproval(requestId, allow, reason, input) },
                        // The card of a dynamic workflow talks to the model directly (no detour via ChatView).
                        onWorkflowApproval: { requestId, accept in
                            guard let model = parent?.model else { return }
                            Task { await model.decideWorkflowApproval(requestId: requestId, accept: accept) }
                        },
                        // "Running" applies only to the newest answer row of a running turn — `streaming` knows the row itself,
                        // `busy` only the stage (see `liveId`).
                        live: item.streaming || item.id == liveId
                    )
                    .opacity(item.dimmed ? 0.48 : 1)
                case .day(let marker, _):
                    DaySeparatorRow(marker: marker)
                case .error(let message):
                    // The form of the notices: red symbol, no red surface.
                    ChatErrorRow(message: message)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .environment(\.chatMessageAction, { text in parent?.onMessageAction(text) })
            .environment(\.chatTextHighlight, { selection in parent?.onTextHighlight(selection) })
            // Read aloud: the client comes from the model, the speaking state from the service.
            .environment(\.chatSpeak, { key, text in
                guard let client = parent?.model.client else { return }
                Task { await SpeechService.shared.toggle(key: key, text: text, client: client) }
            })
            .environment(\.chatImageViewer, { image in parent?.onViewImage(image) })
            .environment(\.chatVideoViewer, { url in parent?.onPlayVideo(url) })
            .environment(\.chatDetailPresenter, { request in parent?.onShowDetail?(request) })
            // The tool block of `cbase_skill_write` asks the server itself (undo, request card).
            .environment(\.chatSkillContext, parent.map { SkillChatContext(client: $0.model.client, workspaceId: $0.model.workspace.id) })
            // Set only if the stage really offers one — otherwise the mark's fallback to the call sheet would be dead. `parent`
            // is set here (the stage sets it on every update, see `parent?.chatId` above in the same function).
            .environment(\.chatAgentPresenter, agentPresenter)
            // The state of every subagent, computed ONCE — the mark reads it here instead of computing itself. Set from the state
            // `apply` last saw: only then does it agree with the decision which cells are reconfigured.
            .environment(\.chatAgentStates, agentStates)
            .environment(\.chatTextSelectable, false)
            // Announce expanding in this row (tool call & co.): the row's top edge is held across the following height change,
            // see `expandPin`.
            .environment(\.chatRowExpansionWillChange, { [weak self] in
                self?.pinExpandingRow(id: row.id)
            })
            // Accent from Settings → Appearance — the cell does not inherit the tint either.
            .cbAccent()
        }

        /// Apply a new row state. An unchanged structure with changed content (streaming!) is ONLY reconfigured — one cell, no
        /// list diff. If the structure changes, an anchor holds readers scrolled up at their visible row: new rows arise at
        /// element 0, so BELOW the visible window, and would otherwise push everything visible up by their height.
        ///
        /// If a row is ADDED at the chat end while the reader stands there, it PUSHES the timeline softly upward instead of
        /// re-sorting it (the own message is the main case) — see `pushUp`.
        func apply(_ rows: [ChatTimelineRowKind]) {
            let live = Self.liveItemId(rows, busy: parent?.model.busy == true)
            let liveSwitch: Set<String> = live == liveId ? [] : Set([liveId, live].compactMap { $0 })
            let states = parent?.model.agentStates ?? [:]
            let stateSwitch = Set(states.keys).union(agentStates.keys)
                .filter { states[$0] != agentStates[$0] }
            guard rows != lastRows || !liveSwitch.isEmpty || !stateSwitch.isEmpty else { return }
            liveId = live
            agentStates = states
            let previous = rowsById
            lastRows = rows
            var byId = [String: ChatTimelineRowKind](minimumCapacity: rows.count)
            var ids: [String] = []
            ids.reserveCapacity(rows.count)
            for row in rows {
                let id = row.id
                // Duplicate identifier: keep only the first row. The earlier ForEach only warned on duplicates — the diffable
                // data source crashes.
                guard byId[id] == nil else { continue }
                byId[id] = row
                ids.append(id)
            }
            rowsById = byId
            let changed = ids.filter {
                previous[$0] != nil && (previous[$0] != byId[$0] || liveSwitch.contains($0)
                    || Self.carriesAgents(byId[$0], stateSwitch))
            }
            // Without a list or data source there is nothing to apply.
            guard let collection, let dataSource else { return }

            if ids == orderedIds {
                guard !changed.isEmpty else { return }
                var snapshot = dataSource.snapshot()
                snapshot.reconfigureItems(changed)
                dataSource.apply(snapshot, animatingDifferences: false)
                return
            }

            // A structure update moves rows via the anchor or the follow-up anyway — a still open expand pin would write against
            // it.
            expandPin = nil
            let fresh = insertedPositions(ids, previous: orderedIds)
            // The arrow hold ends ONLY on real new arrivals (then something really new lies below the reader) — not on
            // replacements: the log resync swaps rows a few seconds after opening, and the arrow would pop up anyway over the
            // freshly expanded row (in real chats that happens all the time).
            if fresh != nil { awayHeldByExpansion = false }
            orderedIds = ids
            var snapshot = NSDiffableDataSourceSnapshot<Int, String>()
            snapshot.appendSections([0])
            snapshot.appendItems(ids)

            // Capture the state AT THE TIME OF THE DECISION — applying lays out again and updates `lastFill` at once. Without this
            // copy the trace would hold the state from AFTER the update, and the decision would look wrong in it.
            let decidedFill = lastFill
            let decidedOffset = collection.contentOffset.y + collection.adjustedContentInset.top

            if !changed.isEmpty { snapshot.reconfigureItems(changed) }

            // Soft follow-up: rows are only ADDED (nothing removed, nothing re-sorted), the reader stands at the chat end (or a
            // follow-up is already running), the timeline fills the window (otherwise nothing moves up, see `lastFill`) and the list
            // hangs in the window. If any of these does not hold, the immediate path stays.
            if let fresh, atRest || sliding, decidedFill <= 0.5, collection.window != nil {
                pushUp(fresh, snapshot: snapshot, in: collection, dataSource: dataSource)
                trace(fresh, note: "shifted", fill: decidedFill, offset: decidedOffset)
                return
            }

            let anchor = visibleAnchor()
            // Only fade in: in a short timeline nothing moves up (the new row grows downward into the free space), and when whole
            // sections are reloaded nothing should travel either. The opacity is set INSIDE the animation-free block and only then
            // animated — otherwise `performWithoutAnimation` swallows the fade.
            var entering: [UICollectionViewCell] = []
            UIView.performWithoutAnimation {
                dataSource.apply(snapshot, animatingDifferences: false)
                restore(anchor)
                if let fresh, !sliding { entering = hide(fresh) }
            }
            guard !entering.isEmpty else { return }
            UIView.animate(withDuration: 0.26, delay: 0, options: [.curveEaseOut, .allowUserInteraction]) {
                for cell in entering { cell.alpha = 1 }
            }
            if let fresh { trace(fresh, note: "fade only", fill: decidedFill, offset: decidedOffset) }
        }

        /// The timeline is PUSHED upward by the height of the new rows — in two steps, and the order is the whole point:
        ///
        ///  1. The new rows enter the list AT ONCE and without animation, and the scroll offset is carried along by exactly their
        ///     height. Nothing moves on screen: the new row lies behind the composer island, everything visible stands
        ///     unchanged.
        ///  2. Only then does the offset glide back to the rest position. The whole timeline including the new row travels up as
        ///     ONE block, the row rises from behind the island.
        ///
        /// Why not the collection's animated stack diff (`animatingDifferences: true`) that stood here before: its animation
        /// begins in the same pass in which the list first BUILDS the new cells (SwiftUI hosting, measured 59 ms of standstill).
        /// The first really drawn frame was already 40 % into the ease-out curve — visible as a 33 pt jump, after which it ran
        /// out smoothly. That was exactly the finding "the chat jumps up instead of being pushed". The spring here ticks itself
        /// and computes per frame with the time that REALLY passed; a dropped first frame costs almost nothing, because it
        /// starts at speed 0.
        ///
        /// The second gain is the continuation: one send pushes several times in quick succession (own row with run indicator,
        /// then the first tool call, then the answer). Each push adds its height to the still open path of the running spring —
        /// two jolts become one movement.
        /// Lay out UNTIL the self-sizing stands still — and only then read frames.
        ///
        /// ONE `layoutIfNeeded()` is not enough: the list first realises the new cell with the ESTIMATED height
        /// (`.estimated(80)`), only afterwards asks for its real one and processes the deviation in a FURTHER pass. Whoever pins
        /// the scroll offset between the two passes pins it to the estimate; the difference to reality lands unbraked on screen
        /// one frame later.
        ///
        /// MEASURED (entrance trace, long chat): the answer row's push jumped by exactly the amount the content grew in that
        /// frame — 58.7 pt of a 94.7 pt path. The error had been in there before (about 26 pt) but fell below the bound; the
        /// action bar under every message made the rows 32 pt taller and so the jump visible. Three rounds are enough; more
        /// would be an endless loop, because a cell that claims a new height on every pass would never come to rest.
        private func settleLayout(_ collection: UICollectionView) {
            var previous: CGFloat = -1
            for _ in 0..<3 {
                collection.layoutIfNeeded()
                let height = collection.collectionViewLayout.collectionViewContentSize.height
                if abs(height - previous) < 0.5 { return }
                previous = height
            }
        }

        private func pushUp(
            _ fresh: [Int],
            snapshot: NSDiffableDataSourceSnapshot<Int, String>,
            in collection: UICollectionView,
            dataSource: UICollectionViewDiffableDataSource<Int, String>
        ) {
            // The fixed point is the row that was the BOTTOM one before the update: its distance to the offset must survive the
            // update. Counting its height change (instead of simply adding the height of the new rows) is deliberate — content
            // often changes in the same update, e.g. the ticking run indicator.
            let pinned = fresh.max().map { $0 + 1 }.flatMap { position -> (String, CGFloat)? in
                guard position < orderedIds.count else { return nil }
                let id = orderedIds[position]
                guard let path = dataSource.indexPath(for: id),
                      let frame = collection.layoutAttributesForItem(at: path)?.frame
                else { return nil }
                return (id, frame.minY - collection.contentOffset.y)
            }
            // A running UIKit scroll ride (jump arrow) ends by itself with the assignment below; its post-correction must not
            // strike afterwards.
            pendingLatest = false
            pinning = true
            defer { pinning = false }
            var entering: [UICollectionViewCell] = []
            UIView.performWithoutAnimation {
                dataSource.apply(snapshot, animatingDifferences: false)
                settleLayout(collection)
                if let (id, gap) = pinned, let path = dataSource.indexPath(for: id),
                   let frame = collection.layoutAttributesForItem(at: path)?.frame {
                    collection.contentOffset.y = frame.minY - gap
                }
                entering = hide(fresh)
            }
            // Fade in briefly, much shorter than the path: the row should be opaque when it comes out from behind the island — a
            // half-transparent bubble gliding over the timeline would look like a bug.
            UIView.animate(withDuration: 0.16, delay: 0, options: [.curveEaseOut, .allowUserInteraction]) {
                for cell in entering { cell.alpha = 1 }
            }
            // The open path is the distance to the rest position — after pinning exactly the height of what grew, and with a push
            // in the MIDDLE of the movement the sum of the old remainder and the new growth. If no fixed point was found (the new
            // row is the only one) there is nothing to push; then it stays with the fade.
            let remaining = collection.contentOffset.y + collection.adjustedContentInset.top
            guard remaining > 0.5 else { return }
            // The spring carries the REMAINING PATH, not the position: the rest position itself moves on the way (composer grows
            // or shrinks, keyboard, fill remainder), and re-reading it every frame is the only way that arrives without
            // post-correction.
            slide.start(from: remaining, to: 0, velocity: slide.isRunning ? slide.velocity : 0) {
                [weak self] rest in
                guard let self, let collection = self.collection else { return }
                collection.contentOffset.y = -collection.adjustedContentInset.top + rest
            } onFinish: { [weak self] in
                self?.updateAway()
            }
        }

        /// Kick off the frame-by-frame trace of the entrance (DEBUG with a trace path only, see `ChatEntranceTrace`): observed
        /// are the BOTTOM new row and the row directly above it, which moves up in the same step.
        private func trace(_ fresh: [Int], note: String, fill: CGFloat, offset: CGFloat) {
            #if DEBUG
            // NO `layoutIfNeeded` here: in the animated path the update is running, a forced layout pass in the middle would be an
            // intervention in the animation. The cells of the new rows already stand (the update is applied synchronously, what
            // is animated is the presentation).
            guard ChatEntranceTrace.isOn, let collection, let last = fresh.max() else { return }
            // The row ABOVE the new one is the witness: it should push softly upward. It is followed via its IDENTIFIER, not via
            // its cell — see `traceSample`.
            let witness = last + 1 < orderedIds.count ? orderedIds[last + 1] : nil
            ChatEntranceTrace.shared.run(
                entering: collection.cellForItem(at: IndexPath(item: last, section: 0)),
                above: collection.cellForItem(at: IndexPath(item: last + 1, section: 0)),
                extra: { [weak self] in self?.traceSample(witness) ?? "" },
                // `off` is the distance to the rest position: anything over 1 pt means "the reader is not at the chat end" and sends
                // the update to the immediate path. `fill` is the fill remainder: over 0 means "the timeline is shorter than the
                // window, nothing moves up". Both values come from the moment of the decision.
                note: "\(note) \(fresh.map(kindLabel).joined(separator: "+"))"
                    + String(format: " fill=%.2f off=%.1f", fill, offset)
            )
            #endif
        }

        #if DEBUG
        /// Extra columns of the trace, evaluated per frame: screen position of the followed row and the three control values it
        /// results from.
        ///
        /// `screenY` is the distance of the row's top edge from the BOTTOM edge of the window — the only quantity the user really
        /// sees. It is in neither the cell's content frame nor the offset alone: the cell moves in content space when rows are
        /// inserted below it, and the offset moves when the inset changes (composer, keyboard, fill remainder). The DIFFERENCE is
        /// what matters, and both parts must come from the presentation layer, otherwise the animated intermediate state is
        /// missing.
        ///
        /// The row is resolved via its IDENTIFIER, not via a held cell: the collection recycles cells, and the reconciliation with
        /// the server (identifier change "live-…" → "row-…") slides it under a foreign row — the trace then showed a jump that
        /// never existed.
        private func traceSample(_ id: String?) -> String {
            guard let collection else { return "" }
            let presented = collection.layer.presentation() ?? collection.layer
            let offset = presented.bounds.origin.y
            var screen = ""
            if let id, let dataSource, let path = dataSource.indexPath(for: id),
               let cell = collection.cellForItem(at: path) {
                let layer = cell.layer.presentation() ?? cell.layer
                screen = f(layer.frame.minY - offset)
            }
            return [
                screen, f(offset), f(collection.adjustedContentInset.top),
                f(collection.collectionViewLayout.collectionViewContentSize.height)
            ].joined(separator: ",")
        }

        private func f(_ value: CGFloat) -> String { String(format: "%.2f", value) }

        /// Kind of a row for the trace — "user", "assistant", "run" …
        private func kindLabel(_ position: Int) -> String {
            guard position < orderedIds.count, let row = rowsById[orderedIds[position]] else { return "?" }
            switch row {
            case .permission: return "permission"
            case .run: return "run"
            case .error: return "error"
            case .day: return "day"
            case .item(let item): return "\(item.role)"
            }
        }
        #endif

        /// Does the reader stand at the chat end? There — and only there — may new content move the timeline.
        private var atRest: Bool {
            guard let collection else { return false }
            return abs(collection.contentOffset.y + collection.adjustedContentInset.top) < 1
        }

        /// Pure ADDITION? Then all old rows still stand unchanged and in the same order, and what comes back are the positions of
        /// the new ones in the NEW index world. If an old row is missing or the order turned around (the reconciliation with the
        /// server swaps "live-…" for "row-…"), there is nothing to enter — then the anchor path is right. The empty previous state
        /// is deliberately excluded: the first filling of an opened chat is not an arrival.
        private func insertedPositions(_ ids: [String], previous: [String]) -> [Int]? {
            guard !previous.isEmpty, ids.count > previous.count,
                  ids.count - previous.count <= Self.maxEntering else { return nil }
            let known = Set(previous)
            var kept: [String] = []
            kept.reserveCapacity(previous.count)
            var fresh: [Int] = []
            for (position, id) in ids.enumerated() {
                if known.contains(id) { kept.append(id) } else { fresh.append(position) }
            }
            guard kept == previous else { return nil }
            return fresh
        }

        /// Hide the named rows and hand back their cells. There are no cells outside the visible window — they need no fade-in
        /// either.
        private func hide(_ positions: [Int]) -> [UICollectionViewCell] {
            guard let collection else { return [] }
            collection.layoutIfNeeded()
            var cells: [UICollectionViewCell] = []
            for position in positions {
                guard let cell = collection.cellForItem(at: IndexPath(item: position, section: 0))
                else { continue }
                cell.alpha = 0
                cells.append(cell)
            }
            return cells
        }

        /// Visible row with its distance to the offset — the fixed point across a structure update. Only whoever reads the history
        /// is anchored; at the chat end (distance ≈ 0) new content should push the list upward naturally.
        private struct Anchor {
            let id: String
            let gap: CGFloat
        }

        private func visibleAnchor() -> Anchor? {
            guard let collection, let dataSource else { return nil }
            let distance = collection.contentOffset.y + collection.adjustedContentInset.top
            guard distance > 24 else { return nil }
            // The visible row FARTHEST from the chat end: between it and the update activity at element 0 lie all other visible
            // rows — if its offset is right again, all are.
            let visible = collection.indexPathsForVisibleItems.sorted { $0.item > $1.item }
            for path in visible {
                guard let id = dataSource.itemIdentifier(for: path),
                      rowsById[id] != nil,
                      let frame = collection.layoutAttributesForItem(at: path)?.frame
                else { continue }
                return Anchor(id: id, gap: frame.minY - collection.contentOffset.y)
            }
            return nil
        }

        /// Put the anchored reader back in place.
        ///
        /// `shrinkingContent` switches on the UPPER clamp and is explicitly off as long as the caller only adds rows — see the
        /// reasoning below.
        private func restore(_ anchor: Anchor?, shrinkingContent: Bool = false) {
            guard let anchor, let collection, let dataSource else { return }
            collection.layoutIfNeeded()
            guard let path = dataSource.indexPath(for: anchor.id),
                  let frame = collection.layoutAttributesForItem(at: path)?.frame
            else { return }
            let bottom = -collection.adjustedContentInset.top
            var target = max(frame.minY - anchor.gap, bottom)
            // Clamp upward ONLY where the content can shrink — and it can only at a text-size change ("Very large" → "Compact"
            // takes about a third of the total height). Without the clamp the offset would sit behind the end of the content, and
            // the reader would face an empty area from which only the next scroll would bring them back.
            //
            // For the other caller — the structure update in `apply` — it would be not merely superfluous but harmful. There rows
            // are ADDED, so the anchor cannot exceed the end of the content; and `apply` does NOT lay out to rest beforehand, only
            // `setTextSize` does via `settleLayout`. Freshly realised cells then still stand at their estimate (`.estimated(80)`),
            // the `contentSize.height` read here is too small, and a clamp to it would pull the reader out of the history toward
            // the chat end — exactly what the anchor is supposed to prevent. Hence the default value is `false`: `apply` goes the
            // same way as before the text size.
            if shrinkingContent {
                let top = max(
                    bottom,
                    collection.contentSize.height + collection.adjustedContentInset.bottom - collection.bounds.height
                )
                target = min(target, top)
            }
            if abs(target - collection.contentOffset.y) > 0.5 {
                collection.contentOffset.y = target
            }
        }

        /// After every layout (collection OR stage): recompute the upper inset canonically. It carries FOUR parts: the base
        /// padding, the COMPOSER AREA (composer height plus keyboard overlap in ONE measure — straight from the layout, because
        /// the composer hangs on the keyboard guide), the overhang of the collection over the stage (the frozen safe-area swap,
        /// see `ChatStageView`) and the fill remainder, so a short timeline starts at the TOP and does not stick to the composer.
        /// As soon as the content fills the available window the fill remainder is 0 — at the transition both cases coincide, so
        /// there is no jump.
        ///
        /// If the assignment runs inside a keyboard animation (UIKit lays out the stage INSIDE the animation block, with end
        /// values), the offset assignment below animates with the same curve — the newest message travels in sync with composer
        /// and keyboard. During interactive dragging the same code runs per frame with instantaneous values.
        func collectionDidLayout() {
            guard let collection, let stage else { return }
            let composerArea: CGFloat
            if let composer = stage.composerView, composer.frame.height > 0 {
                composerArea = max(0, stage.bounds.maxY - composer.frame.minY)
            } else {
                composerArea = 0
            }
            // If the composer area moves (keyboard travelling, island growing), an active expand pin drops at once: its animation
            // freeze would otherwise turn exactly this ride into a jolt, and its reference position no longer holds anyway.
            if expandPin != nil, lastComposerArea >= 0, abs(composerArea - lastComposerArea) > 0.5 {
                expandPin = nil
            }
            lastComposerArea = composerArea
            let contentHeight = collection.collectionViewLayout.collectionViewContentSize.height
            // Late height report DURING the follow-up: the list realises a newly inserted row with the estimated height
            // (`.estimated(80)`) and reports the real one only frames later — the SwiftUI build of a large row takes more than one
            // pass, so `settleLayout` in `pushUp` does not always see it. The row lies BELOW the fixed point, so its growth pushes
            // everything visible by exactly that amount; the spring, however, writes an absolute position and knows nothing of it.
            // MEASURED (entrance trace), the timeline jumped by 58.7 of 94.7 pt that way. The surcharge adds the amount to the open
            // path — the jump becomes a piece of the same movement.
            if slide.isRunning, !pinning, lastContentHeight >= 0 {
                slide.bump(by: contentHeight - lastContentHeight)
            }
            lastContentHeight = contentHeight
            // Overhang of the list beyond the stage — SIGNED. `composerArea` measures against the stage bottom edge, `extra`
            // compensates its movement: the sum is `list height − composer top edge` and thus independent of whether the stage frame
            // shrinks (34 pt, working chat) or grows (48 pt) on a keyboard change. Clamped to 0 the second direction dropped out.
            let extra = collection.bounds.height - stage.bounds.height
            let window = stage.bounds.height - composerArea
            // The header inset (`topInset`) is part of the visible padding at the top — without it a short timeline would start
            // BEHIND the bar instead of under it.
            let fill = max(0, window - contentHeight - Self.basePadding * 2 - topInset)
            let top = Self.basePadding + composerArea + fill + extra
            // Remember for `apply`: only without a fill remainder does a new row move the timeline up at all — and only then may
            // the entrance run animated.
            lastFill = fill
            if abs(collection.contentInset.top - top) > 0.5 {
                // If the reader stood at the chat end, they should stay there — even if the composer has just grown (action panel,
                // attachment, queue). Without this note the newest message would slide behind the island: its offset would suddenly
                // be too SMALL against the new rest position, and the clamp below only acts in the opposite case.
                let wasAtRest = abs(collection.contentOffset.y + collection.contentInset.top) < 1
                collection.contentInset.top = top
                // If everything fits in the window there is exactly one rest position — take it, unless the user is currently
                // bouncing. If the fill inset shrinks (the timeline got longer), an offset that is too small is clamped up.
                //
                // During the follow-up the clamp stays out: there the offset belongs to the spring, which re-reads the rest position
                // every frame and thus follows this change by itself (see `pushUp`). An intervention here would have swallowed its
                // remaining path — and because it writes its own value again in the next frame, the timeline would have jumped back by
                // exactly that remainder.
                if !collection.isTracking, !collection.isDecelerating, !sliding {
                    let rest = -top
                    // A running ride to the chat end is aborted by this assignment — but it lands exactly where the ride was headed.
                    if pendingLatest || fill > 0 || wasAtRest || collection.contentOffset.y < rest - 0.5 {
                        pendingLatest = false
                        collection.contentOffset.y = rest
                    }
                }
            }
            applyExpandPin()
            updateAway()
        }

        /// A row reports (via `chatRowExpansionWillChange`) that it is about to change its height on a tap. The pin remembers its
        /// visual top edge — `applyExpandPin` holds it across the following layout passes, newer content below moves down (as in
        /// the web client). Afterwards the bottom anchoring applies again (streaming keeps growing at the chat end).
        func pinExpandingRow(id: String) {
            guard let collection, let dataSource,
                  !sliding, !collection.isTracking, !collection.isDecelerating,
                  let path = dataSource.indexPath(for: id),
                  let frame = collection.layoutAttributesForItem(at: path)?.frame
            else { return }
            if atRest { awayHeldByExpansion = true }
            expandPin = ExpandPin(
                id: id,
                gapTop: frame.maxY - collection.contentOffset.y,
                height: frame.height,
                armedAt: CACurrentMediaTime(),
                lastChangeAt: nil
            )
            #if DEBUG
            // Frame-by-frame trace of the expanding (presentation layer!) — XCUITest never sees movement DURING an animation, the
            // trace does. Observed are the expanding row itself and the row above; three extra columns for the pinned cell:
            // presented cell height, height of the hosting view in it and the identity of the hosting tree (if it changes, it is a
            // real remount).
            if ChatEntranceTrace.isOn {
                let pinnedCell = collection.cellForItem(at: path)
                ChatEntranceTrace.shared.run(
                    entering: pinnedCell,
                    above: collection.cellForItem(at: IndexPath(item: path.item + 1, section: 0)),
                    extra: { [weak self, weak pinnedCell] in
                        let base = self?.traceSample(id) ?? ""
                        guard let cell = pinnedCell as? UICollectionViewCell else {
                            return base + ",-,-,-"
                        }
                        // With a `contentConfiguration` set, `contentView` IS the hosting view (the assignment swaps it — exactly why
                        // its identity serves as a remount detector).
                        let cellLayer = cell.layer.presentation() ?? cell.layer
                        let hostLayer = cell.contentView.layer.presentation() ?? cell.contentView.layer
                        let identity = String(
                            UInt(bitPattern: ObjectIdentifier(cell.contentView).hashValue) % 100_000
                        )
                        // Window position of collection and stage (presentation layer): if the FRAME slips, all content-space-relative
                        // columns are blind — measured: a 96 pt block slip at topSpan 0.01.
                        let colFrame = (collection.layer.presentation() ?? collection.layer).frame
                        let stageLayer = collection.superview.map {
                            ($0.layer.presentation() ?? $0.layer).frame
                        } ?? .zero
                        return base
                            + String(format: ",%.2f", cellLayer.bounds.height)
                            + String(format: ",%.2f", hostLayer.bounds.height)
                            + "," + identity
                            + String(format: ",%.2f,%.2f,%.2f,%.2f",
                                     colFrame.minY, colFrame.height,
                                     stageLayer.minY, stageLayer.height)
                    },
                    note: "expand \(id)",
                    // Longer than the default: the slide-after (realisation of estimated rows) can come seconds after the tap — 2.4 s
                    // missed it.
                    duration: 6
                )
            }
            #endif
        }

        /// Apply the active expand pin. Runs deliberately AFTER the inset computation in `collectionDidLayout`: its clamp does not
        /// know the pin — if the fill remainder flips to 0 through the expanding, it would otherwise set the offset to the rest
        /// position and the header would jump after all.
        private func applyExpandPin() {
            guard var pin = expandPin else { return }
            guard let collection, let dataSource,
                  !sliding, !collection.isTracking, !collection.isDecelerating,
                  let path = dataSource.indexPath(for: pin.id),
                  let frame = collection.layoutAttributesForItem(at: path)?.frame
            else {
                expandPin = nil
                return
            }
            let now = CACurrentMediaTime()
            if abs(frame.height - pin.height) > 0.5 {
                pin.height = frame.height
                pin.lastChangeAt = now
                expandPin = pin
            }
            if pin.lastChangeAt == nil {
                // Still ARMED: the height never changed, there is nothing to compensate — the offset stays untouched, only the
                // reference position is refreshed. The 2 s backstop catches taps without a height consequence.
                if now - pin.armedAt > 2 {
                    expandPin = nil
                } else {
                    pin.gapTop = frame.maxY - collection.contentOffset.y
                    expandPin = pin
                }
                return
            }
            // FOLLOWING: never beyond the edges — not behind the rest position (collapsing at the chat end), not beyond the start of
            // the timeline (expanding the oldest row), otherwise emptiness would stand in the window.
            let rest = -collection.adjustedContentInset.top
            let farthest = max(rest, collection.collectionViewLayout.collectionViewContentSize.height
                + collection.adjustedContentInset.bottom - collection.bounds.height)
            let target = min(max(frame.maxY - pin.gapTop, rest), farthest)
            if abs(target - collection.contentOffset.y) > 0.5 {
                collection.contentOffset.y = target
            }
            // Release only once the self-sizing has been CALM for a while (0.6 s since the LAST change) — the offset jump realises
            // estimated rows with a delay. The 4 s cap limits the animation freeze from above.
            if let last = pin.lastChangeAt, now - last > 0.6 || now - pin.armedAt > 4 {
                expandPin = nil
            }
        }

        func scrollViewDidScroll(_ scrollView: UIScrollView) {
            updateAway()
            checkOlder(scrollView)
        }

        /// This close to the START of the timeline (mirrored: the end of the content) the model loads the older page.
        static let olderReloadFromPt: CGFloat = 900

        /// Window of the timeline (`ChatViewModel+Window.swift`): if the reader scrolls to the start, the model appends the next older
        /// page. In the mirrored list it grows on the far side — the anchor (`visibleAnchor`/`restore` in `apply`) holds what the
        /// reader sees. The guards (already loading, nothing before, open answer) live in the model.
        private func checkOlder(_ scrollView: UIScrollView) {
            guard let model = parent?.model, model.logOlder, !model.loadingOlder else { return }
            let rest = scrollView.contentSize.height + scrollView.adjustedContentInset.bottom
                - scrollView.bounds.height - scrollView.contentOffset.y
            if rest < Self.olderReloadFromPt { model.loadOlder() }
        }

        /// Release of a drag in the timeline: send a half-pulled-down keyboard to its end at once (see `settleKeyboardAfterRelease`).
        func scrollViewDidEndDragging(
            _ scrollView: UIScrollView, willDecelerate decelerate: Bool
        ) {
            stage?.settleKeyboardAfterRelease()
        }

        /// Threshold deliberately well above 0, so the arrow does not flicker on bouncing and just above the edge. Written
        /// asynchronously: the offset also changes in the middle of a SwiftUI update (anchor, fill inset), and writing State at that
        /// moment would be undefined.
        private func updateAway() {
            guard let collection, let parent else { return }
            // During the follow-up the offset is DELIBERATELY shifted out of the rest position (see `pushUp`) — that is not a reader
            // scrolled up. Without this exception the jump arrow flashed as soon as several pushes coincided.
            guard !sliding else { return }
            let distance = collection.contentOffset.y + collection.adjustedContentInset.top
            // Back at the rest position (collapsing): the expand hold is done. ONLY without a live pin — when arming, the distance is
            // still 0, and the reset would delete the hold before the height change even lands.
            if distance < 1, expandPin == nil { awayHeldByExpansion = false }
            let away = !awayHeldByExpansion && distance > 200
            guard parent.awayFromLatest != away else { return }
            Task { @MainActor in
                self.parent?.awayFromLatest = away
            }
        }
    }
}
