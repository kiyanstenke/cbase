import SwiftUI
import UIKit

/// The run display ("Tinkering…" or the wait reason) — its own ROW of the history,
/// directly above the composer.
///
/// It carries NO surface and no border: it is a row of the history like an answer,
/// not a card in it. The hexagon with its box sits at the EDGE of the history, where the text
/// of every answer begins — word and bracket follow 6 pt behind. The font is that of the tool
/// rows above (`.subheadline`, 15 pt).
///
/// As in Claude Code, the row on the stage of both conversations carries the running tasks:
/// [hexagon] "12s · 5k tokens" [pill "3 running tasks"] "Tinkering…". Which parts show is computed
/// by `RunningTasks.rowsParts` (bound to the web): without running work but with tasks — the wait
/// phase, a background agent after the turn — only the RESTING hexagon and the pill; it says what
/// is being waited for. The pill's content is in its sheet (`RunningTasksSheet`), which the
/// chat root presents (a cell presents nothing).
///
/// Without `laufende` the wait-phase form stays: there the parts do NOT all sit in one row —
/// label, detail and the hint "you can keep writing" would exceed the width and each wrap on its
/// own. The first row carries label + detail (the detail truncates), the hint sits below. The
/// hexagon stands centered on the FIRST row (`ChatRowSymbol`).
struct RunIndicator: View {
    let waiting: Bool
    let monitors: [String]
    let agents: [String]
    let tasks: [String]
    let wakeupAt: Date?
    let startedAt: Date?
    let inputTokens: Int
    let outputTokens: Int
    /// The running tasks (`ChatViewModel.runningTasks`) — set on the stage (`nil` is the wait-phase form).
    var runningTasks: RunningTasks.Result? = nil
    /// Is the WORK running (`HistoryState.runRowVisible`)? Without it hexagon and word rest, the pill stays.
    var running: Bool = true
    /// Tap on the pill (`ChatTimelineStage.onShowTasks`).
    var onPill: (() -> Void)? = nil
    @State private var now = Date()
    /// Is the hexagon rotating? Flipped ONCE on appearing — the animation
    /// below then repeats by itself and keeps running in Core Animation without
    /// SwiftUI having to do anything per frame. What matters is that the value stays untouched afterwards: the
    /// row is reconfigured on every token (runtime, token counter), and if the
    /// animation hung on that, it would reset every second.
    @State private var spinning = false
    /// Under Reduce Motion `spinning` is never set — the hexagon stands still.
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: ChatRowSymbol.gap) {
            // The identifier sits on the BOX, not on the rotating image: the hull of a rotated
            // square is up to 41 % wider, its edge would wander with the angle — the box is what is
            // measured, and it stands still (like `data-run-hex` on the web). An identifier on a
            // stack AROUND the image is not enough: its frame is the hull of its content (measured
            // 18.4 × 19.1 instead of 15 × 15) — hence its own, unrotated element in the box.
            // At rest it carries the same ink as that of the metrics row (0.75) — paler looked smaller.
            // When the work rests (wait phase), the hexagon rests and steps back; `spinning` follows `running`, and without
            // rotation no animation runs (nil) — a repeated return to 0° would otherwise keep rotating backwards.
            RowsHexagon()
                .foregroundStyle(running ? AnyShapeStyle(.tint) : AnyShapeStyle(.tint.opacity(0.75)))
                .rotationEffect(.degrees(spinning ? 360 : 0))
                .animation(spinning ? .linear(duration: 1.6).repeatForever(autoreverses: false) : nil, value: spinning)
                .accessibilityHidden(true)
                .chatRowSymbol(identifier: "chat-run-hex")
                .onAppear { if !reduceMotion && running { spinning = true } }
                .onChange(of: running) { _, fresh in spinning = fresh && !reduceMotion }
            if let runningTasks {
                // Wrap instead of truncate: if the row does not fit in the column (125 % text size,
                // "at least 3 running tasks" with a long time), the word moves to a second row instead of shrinking to "…".
                ViewThatFits(in: .horizontal) {
                    HStack(alignment: .firstTextBaseline, spacing: ChatRowSymbol.gap) { row(runningTasks, withWord: true) }
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(alignment: .firstTextBaseline, spacing: ChatRowSymbol.gap) { row(runningTasks, withWord: false) }
                        if RunningTasks.rowsParts(running: running, time: startedAt != nil, tasks: runningTasks.item.count).contains(.word) {
                            wordText
                        }
                    }
                }
            } else {
                waitPhasesForm
            }
            Spacer(minLength: 0)
        }
        .chatFont(.subheadline)
        // The vertical padding is deliberately exactly that of the user bubble (10 pt, see
        // `UserMessageView`): so the display's text stands as far from the row
        // above as the text of a message. Without it the row stuck to the text above.
        .padding(.vertical, 10)
        // `children: .contain` is mandatory: an identifier on the container REPLACES the
        // identifiers of all children, and the search would find some text inside it instead of
        // the frame (measured: 15 pt instead of the whole row).
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("chat-run-indicator")
        .task {
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                now = Date()
            }
        }
    }

    /// The row as in Claude Code: time · tokens, pill, word — in the order of `RunningTasks.rowsParts`.
    @ViewBuilder
    private func row(_ t: RunningTasks.Result, withWord: Bool) -> some View {
        let parts = RunningTasks.rowsParts(running: running, time: startedAt != nil, tasks: t.item.count)
        ForEach(parts.filter { $0 != .hex && (withWord || $0 != .word) }, id: \.self) { part in
            switch part {
            case .time:
                if let startedAt {
                    Text(timeText(startedAt))
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                        .lineLimit(1)
                        .fixedSize()
                        .accessibilityIdentifier("chat-run-time")
                }
            case .pill:
                pill(t)
            case .word:
                wordText
            case .hex:
                EmptyView()
            }
        }
    }

    private var wordText: some View {
        Text(L("Tinkering") + "…")
            .fontWeight(.semibold)
            .foregroundStyle(.tint)
            .lineLimit(1)
            .fixedSize()
    }

    /// "N running tasks" — one button; the sheet is presented by the chat root. Blue background as in Claude Code's
    /// "3 running tasks".
    @ViewBuilder
    private func pill(_ t: RunningTasks.Result) -> some View {
        if let text = RunningTasks.pillsText(t) {
            let word = L(text.key, ["n": text.n])
            Button { onPill?() } label: {
                Text(word)
                    .chatFont(.footnote)
                    .fontWeight(.medium)
                    .foregroundStyle(.tint)
                    .lineLimit(1)
                    .fixedSize()
                    .padding(.horizontal, 8)
                    .padding(.vertical, 2)
                    .background(Capsule().fill(Color.accentColor.opacity(0.15)))
                    .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(word)
            .accessibilityHint(L("Shows what is running alongside the chat"))
            .accessibilityIdentifier("chat-tasks-pill")
        }
    }

    /// "12s · 5k tokens" — the output, as on the web (the same number as the metrics row below).
    private func timeText(_ start: Date) -> String {
        "\(ChatViewModel.formatDuration(max(0, Int(now.timeIntervalSince(start))))) · \(ChatViewModel.formatTokens(outputTokens)) \(L("tokens"))"
    }

    /// The two-line wait-phase form (without `laufende`).
    private var waitPhasesForm: some View {
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: 5) {
                    // Wait phase: the main agent is responsive. Open is a monitor, a
                    // background agent, a background command — or a continuation
                    // scheduled by the agent.
                    Text(waiting ? L(waitLabel) : L("Tinkering") + "…")
                        .fontWeight(.semibold)
                        .foregroundStyle(.tint)
                        .fixedSize()
                    if let trailing {
                        Text(trailing)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }
                }
                if waiting {
                    Text(L("you can keep typing"))
                        .foregroundStyle(.secondary)
                }
            }
    }

    /// What stands next to the label: in the wait phase, what is waited for; otherwise runtime
    /// and token counter.
    private var trailing: String? {
        if waiting { return waitDetail.map { "— \($0)" } }
        return startedAt.map(status)
    }

    /// Order by informativeness: what is RUNNING right now beats the merely scheduled wakeup.
    private var waitLabel: String {
        if !monitors.isEmpty { return "Monitor running" }
        if !agents.isEmpty { return "Background agent running" }
        if !tasks.isEmpty { return "Background command running" }
        return "Scheduled to continue"
    }

    private var waitDetail: String? {
        // Same ranking as waitLabel — otherwise the description of an agent would stand under "Monitor running".
        // The wake time appears only when nothing else is running.
        let list = !monitors.isEmpty ? monitors : !agents.isEmpty ? agents : tasks
        if !list.isEmpty { return list.first(where: { !$0.isEmpty }) }
        return wakeupAt?.formatted(date: .omitted, time: .shortened)
    }

    private func status(_ start: Date) -> String {
        var values = [ChatViewModel.formatDuration(max(0, Int(now.timeIntervalSince(start))))]
        if inputTokens > 0 { values.append("↑ \(ChatViewModel.formatTokens(inputTokens))") }
        values.append("↓ \(ChatViewModel.formatTokens(outputTokens)) \(L("tokens"))")
        return "(\(values.joined(separator: " · ")))"
    }
}

/// The hexagon of the run and metrics rows — the same figure as `RowsHexIcon` on the web
/// (`web/src/components/chat/RunDisplay.tsx`, path `M12 2l8.66 5v10L12 22l-8.66-5V7L12 2z`): corners on the circumscribed
/// circle of radius 10 around the center of a 24 grid, stroke 2.2, round corners; the corner list is bound to the web path
/// by `web/test/running-tasks.test.mjs`. The figure fills the box and stays centered on its middle (it rotates without wobble).
///
/// Why not the SF symbol `hexagon` (`HexagonMark`, stays for the loading view and lists): measured in the simulator, its ink
/// begins 0.875 pt into the 15 pt box, the first letter of an answer (system font 17 pt) at 1.5 pt — the hexagon stood
/// 0.625 pt BEFORE the text edge, at text size 125 % 0.5 pt. The symbol fills its box more than a letter fills its
/// line. On the circumscribed circle of radius 10 the ink begins at 0.093 em (1.375 pt): −0.125 pt or +0.125 pt, under one device pixel.
struct RowsHexagon: Shape {
    /// The corners in the 24 grid, clockwise from the top tip — the web path, point by point.
    static let corners: [(CGFloat, CGFloat)] = [(12, 2), (20.66, 7), (20.66, 17), (12, 22), (3.34, 17), (3.34, 7)]
    static let stroke: CGFloat = 2.2

    func path(in rect: CGRect) -> Path {
        let e = min(rect.width, rect.height) / 24
        let ox = rect.midX - 12 * e, oy = rect.midY - 12 * e
        var outline = Path()
        for (i, (x, y)) in Self.corners.enumerated() {
            let point = CGPoint(x: ox + x * e, y: oy + y * e)
            if i == 0 { outline.move(to: point) } else { outline.addLine(to: point) }
        }
        outline.closeSubpath()
        // The stroke as a surface: so it grows with the box (text size), and `foregroundStyle` colors it like a symbol.
        return outline.strokedPath(StrokeStyle(lineWidth: Self.stroke * e, lineJoin: .round))
    }
}

/// The symbol at the front of the run display and of the metrics row after the run: a square box whose edge length
/// follows the font size of the row — by the SAME computation as `.chatFont(.subheadline)`:
/// the Dynamic Type curve of `.subheadline` (15 pt at category L), also for the app's text size. The box
/// sits at the edge of the history; the hexagon's side air inside it (`RowsHexagon`) is that
/// of a letter — its ink begins where that of the text begins (the box is measured anyway,
/// as on the web: it is reproducible).
///
/// Vertically the box is centered on the FIRST text row next to it: its middle lies as far
/// above the baseline as the middle between ascender and descender of the system font
/// (≈ 0.36 × font size, practically half the cap height). Over the baseline rather than over
/// `.center`, because the wait-phase form has TWO rows — `.center` would put the hexagon between
/// them.
struct ChatRowSymbol: ViewModifier {
    /// Gap symbol → text, like that of the other symbol rows in the history.
    static let gap: CGFloat = 6
    /// Middle between ascender and descender above the baseline, as a share of the font size.
    static let middleOverBaseline: CGFloat = {
        let font = UIFont.systemFont(ofSize: 100)
        return (font.ascender + font.descender) / 2 / 100
    }()

    @ScaledMetric(relativeTo: .subheadline) private var dynamic: CGFloat = ChatFontStyle.subheadline.base

    /// Identifier of an unrotated element the size of the box — for a symbol that rotates
    /// (whose own frame is the hull of the rotation). `nil`: none.
    var identifier: String?

    func body(content: Content) -> some View {
        let edge = dynamic
        content
            .frame(width: edge, height: edge)
            .overlay {
                if let identifier {
                    Color.clear
                        .accessibilityElement()
                        .accessibilityIdentifier(identifier)
                }
            }
            .alignmentGuide(.firstTextBaseline) { d in
                d[VerticalAlignment.center] + edge * Self.middleOverBaseline
            }
    }
}

extension View {
    /// Box of the hexagon in run display and metrics row (see `ChatRowSymbol`).
    func chatRowSymbol(identifier: String? = nil) -> some View { modifier(ChatRowSymbol(identifier: identifier)) }
}
