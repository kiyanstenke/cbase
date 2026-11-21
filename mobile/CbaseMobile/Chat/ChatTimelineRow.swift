// One timeline row: dispatches on the item role and draws the bubbles, status rows, cards and run lines.
import AVKit
import SwiftUI
import UIKit

struct TimelineRow: View {
    let item: TimelineItem
    let chatId: String
    let loadAttachment: (Attachment) async throws -> Data
    /// Answer to a question card. If missing, the card stays readable as history but cannot be tapped.
    var onAnswerAsk: ((String, [AskAnswer]) -> Void)? = nil
    /// Files of a capture card (role .capture): poster as data, video as URL for AVPlayer. If missing, the card shows only
    /// the header and caption.
    var loadCaptureFile: ((String, String) async throws -> Data)? = nil
    var captureFileURL: ((String, String) -> URL?)? = nil
    /// Play a downloaded capture — the chat root presents it full screen.
    var onPlayVideo: ((URL) -> Void)? = nil
    /// Decision on an approval card (requestId, approve, reason, changed parameters). If missing, the card stays readable
    /// but without buttons.
    var onDecideApproval: ((String, Bool, String, JSONValue?) -> Void)? = nil
    /// Decision on the approval card of a dynamic workflow (requestId, accept).
    var onWorkflowApproval: ((String, Bool) -> Void)? = nil
    /// The turn of this row is still running (see `AssistantMessageView.live`). The stage computes it from the model;
    /// whoever builds the row without a stage keeps the default and gets the old behaviour.
    var live: Bool = true

    var body: some View {
        switch item.role {
        case .user:
            UserMessageView(item: item, loadAttachment: loadAttachment)
        case .assistant:
            AssistantMessageView(item: item, messageKey: "\(chatId):\(item.id)", live: live)
        // Divider rows ("Context compacted", "Context cleared"): lines pale, TEXT legible. Both need their own colour. A
        // single `foregroundStyle` value sets the PRIMARY colour of the hierarchy, `.secondary` is DERIVED from it (weakened
        // again): 35 % secondary grey became a remnant of a few percent — practically invisible in light mode. Now a
        // `SeparatorRow` (Chat/StatusForm.swift): left-aligned in the font of the status rows, followed by a hairline to the
        // edge.
        case .divider:
            // The workflow marker's identifier sits on the TEXT (never on the stack — it would override the children).
            // Completion notice and workflow marker are EVENTS: a status row with a symbol like its counterpart ("Monitor
            // started", "Workflow finished"); a line is left to real boundaries only (`tone == nil`).
            if let tone = item.tone {
                StatusRow(symbol: tone.symbol, header: L(item.label), identifier: item.marker.map { "chat-workflow-marker-\($0.phase)" } ?? "")
            } else {
                SeparatorRow(symbol: Self.separatorSymbol(item), text: L(item.label))
            }
        case .clear:
            SeparatorRow(symbol: "eraser", text: L(item.label), identifier: "chat-clear-marker")
        case .info:
            VStack(alignment: .leading, spacing: 6) {
                // Colour only on the symbol; the surface is that of the notices.
                Label {
                    Text(item.label)
                        .foregroundStyle(CbColor.textSecondary)
                } icon: {
                    Image(systemName: "info.circle")
                        .foregroundStyle(CbColor.textMuted)
                }
                .chatFont(.caption)
                ForEach(item.blocks) { block in
                    MarkdownView(source: block.text)
                        // TWO settings, and they MUST carry the same number.
                        //
                        // The first chooses the container's font: everything below that has none of its own (bullet, table
                        // cell) follows it. The second says the same again for the PARAGRAPH, which is drawn as UIKit text
                        // (`ChatHighlightableText`, marker branch) and cannot inherit a SwiftUI font; `chatMarkdownBaseSize`
                        // is the only way to it. Whoever swaps `.subheadline` for `.footnote` and leaves the 15 gets a
                        // paragraph at 15 with bullets at 13.
                        .chatFont(.subheadline)
                        .environment(\.chatMarkdownBaseSize, 15)
                }
            }
            .padding(12)
            .background(CbColor.elevated, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        case .goal:
            GoalEventView(item: item)
        case .monitor:
            MonitorEventView(item: item)
        case .workflow:
            if let line = item.workflow {
                WorkflowEventView(line: line)
            }
        case .limit:
            if let line = item.limit {
                LimitEventView(line: line)
            }
        case .ask:
            if let ask = item.ask {
                AskCardView(ask: ask) { answers in
                    onAnswerAsk?(ask.requestId, answers)
                }
            }
        case .capture:
            if let capture = item.capture {
                CaptureCardView(capture: capture, loadFile: loadCaptureFile, fileURL: captureFileURL, playVideo: onPlayVideo)
            }
        case .channel:
            if let card = item.channel {
                ChannelCardView(card: card)
            }
        case .message:
            if let message = item.message {
                AgentMessageCardView(message: message)
            }
        case .approval:
            if let card = item.approval {
                ApprovalCardView(card: card, onDecide: onDecideApproval)
            }
        case .workflowApproval:
            if let card = item.wfApproval {
                WorkflowApprovalView(card: card, onDecide: onWorkflowApproval)
            }
        }
    }

    /// The symbol of a divider row: only the compaction carries one (as on the web, `SeparatorRow.tsx`) — the notice has
    /// none. Completion notice and workflow marker are no divider rows (`item.tone`).
    static func separatorSymbol(_ item: TimelineItem) -> String? {
        if item.label == ChatViewModel.compactedLabel(auto: false) || item.label == ChatViewModel.compactedLabel(auto: true) {
            return "arrow.down.right.and.arrow.up.left"
        }
        return nil
    }
}

/// Trigger read-aloud. Set as an environment value like `chatMessageAction`, because the cell does not know the API
/// client — the chat root has it. If the receiver is missing, the button is left out.
struct ChatSpeakKey: EnvironmentKey {
    static let defaultValue: ((String, String) -> Void)? = nil
}

extension EnvironmentValues {
    var chatSpeak: ((String, String) -> Void)? {
        get { self[ChatSpeakKey.self] }
        set { self[ChatSpeakKey.self] = newValue }
    }
}

/// Action bar under every answer: copy (whole message) and read aloud. Permanently visible — on a phone a button that only
/// appears on hover is unreachable. No "send again" button: deliberately not wanted. Under the USER bubble it is absent;
/// copying there works via long press (`chatMessageActions`).
struct MessageActionsBar: View {
    let messageKey: String
    let text: String

    @Environment(\.chatSpeak) private var speak
    @ObservedObject private var speech = SpeechService.shared
    @State private var copied = false

    var body: some View {
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            EmptyView()
        } else {
            HStack(spacing: 2) {
                button(
                    icon: copied ? "checkmark" : "doc.on.doc",
                    label: copied ? L("Copied") : L("Copy message"),
                    id: "copy",
                    active: false
                ) {
                    UIPasteboard.general.string = text
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    copied = true
                    Task {
                        try? await Task.sleep(nanoseconds: 1_200_000_000)
                        copied = false
                    }
                }
                if let speak {
                    let busy = speech.loadingKey == messageKey
                    let talking = speech.speakingKey == messageKey
                    button(
                        icon: busy ? "waveform" : (talking ? "stop.fill" : "speaker.wave.2"),
                        label: talking || busy ? L("Stop reading") : L("Read aloud"),
                        id: "speak",
                        active: talking || busy
                    ) {
                        speak(messageKey, text)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.top, 2)
        }
    }

    private func button(
        icon: String, label: String, id: String, active: Bool, action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.symbol(13, weight: .medium))
                .frame(width: 30, height: 26)
                .background(
                    active ? Color.accentColor.opacity(0.14) : .clear,
                    in: RoundedRectangle(cornerRadius: 8)
                )
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(active ? Color.accentColor : Color.secondary)
        .accessibilityLabel(label)
        .accessibilityIdentifier("chat-message-\(id)")
    }
}

private struct UserMessageView: View {
    let item: TimelineItem
    let loadAttachment: (Attachment) async throws -> Data

    private var text: String {
        item.blocks.filter { $0.kind == .text }.map(\.text).joined()
    }

    var body: some View {
        HStack {
            Spacer(minLength: 34)
            VStack(alignment: .leading, spacing: 8) {
                if !item.attachments.isEmpty {
                    AttachmentGrid(attachments: item.attachments, load: loadAttachment)
                }
                HStack(alignment: .top, spacing: 7) {
                    Text("›")
                        .fontWeight(.bold)
                        .foregroundStyle(Color.accentColor)
                        // Inherits its font — and thereby follows the same text size as the text next to it
                        // (`ChatHighlightableText` with the base size): both hang on Dynamic Type, not on a factor only one
                        // of them knew.
                    // Selectable (long press on the text); the fixed ideal height against swallowed lines is in the SwiftUI
                    // fallback version.
                    ChatHighlightableText(source: text, markdown: false, textColor: CbColor.ui(.text))
                        .chatSelectable()
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .padding(.horizontal, 13)
            .padding(.vertical, 10)
            .foregroundStyle(CbColor.text)
            // Like the user bubble of the Claude app: light on light, dark on dark — one step above the ground
            // (`CbColor.elevated`).
            .background(CbColor.elevated, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .chatMessageActions(text: text)
            // Reference case of the spacing measurement in the UI test: a surface with its own ground over a text block —
            // the run indicator is built the same way.
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("chat-user-bubble")
        }
    }
}

private struct AssistantMessageView: View {
    let item: TimelineItem
    let messageKey: String
    /// The turn is still running — only then is a call without a result "running". Without this value the spinner would
    /// spin forever on every group whose call never got a result (stop, restart, result filed in another row) — even hours
    /// after the run. `item.streaming` alone is not enough: nobody sets it when a running chat is opened, but the stage
    /// knows `busy` and the last answer row.
    var live: Bool = true

    /// "Done after 1m 12s · ↑ 12k · ↓ 3k tokens" — ONE text, so it wraps as a whole and is read as a whole. The words stay
    /// those of the app ("Done after", "Aborted after") but go through `L()`.
    private func metricText(_ summary: RunSummary) -> String {
        let duration = ChatViewModel.formatDuration(summary.secs)
        var parts = [summary.aborted == true
                     ? L("Aborted after {dur}", ["dur": duration])
                     : L("Done after {dur}", ["dur": duration])]
        if summary.inTok > 0 { parts.append("↑ \(ChatViewModel.formatTokens(summary.inTok))") }
        parts.append("↓ \(ChatViewModel.formatTokens(summary.outTok)) \(L("tokens"))")
        // The time of day of the run's end — always just "21:03", the day separator names the day. Like `endText` in
        // web/src/components/chat/RunDisplay.tsx.
        if let at = summary.at, at > 0 { parts.append(locEndTime(locDate(fromServer: at))) }
        return parts.joined(separator: " · ")
    }

    private var copyText: String {
        item.blocks
            .filter { $0.kind == .text }
            .map(\.text)
            .filter { !$0.isEmpty }
            .joined(separator: "\n\n")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            // Task* calls do not appear in the timeline (their state is in the NativeTaskBar), and consecutive tool calls are
            // folded into a summary row by `groupToolCalls` — both happen in the grouping.
            ForEach(groupToolCalls(item.blocks)) { entry in
                switch entry {
                case .single(let block): ChatBlockView(block: block, live: item.streaming || live)
                case .group(let group): ToolGroupRow(blocks: group, live: item.streaming || live)
                }
            }
            if let summary = item.summary {
                // The metrics row after the run: hexagon at the edge in the same box as the run indicator, 6 pt behind it the
                // sentence — at the level of the tool rows (15 pt) and before the action bar. Coding conversations draw it
                // HERE.
                HStack(alignment: .firstTextBaseline, spacing: ChatRowSymbol.gap) {
                    // The same hexagon as the run indicator (`RowsHexagon`, the web's figure) — its ink starts at that of the
                    // text. The BOX is measured, as there.
                    RowsHexagon()
                        .foregroundStyle(.tint.opacity(0.75))
                        .accessibilityHidden(true)
                        .chatRowSymbol(identifier: "chat-metric-hex")
                    Text(verbatim: metricText(summary))
                }
                .chatFont(.subheadline)
                .foregroundStyle(.secondary)
                .padding(.top, 3)
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("chat-metric-row")
            }
            // While the answer is still arriving the bar would be a moving target.
            if !item.streaming {
                MessageActionsBar(messageKey: messageKey, text: copyText)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .chatMessageActions(text: copyText)
        // The row in which a tool/thinking row later looks up its sheet.
        .environment(\.chatTimelineItemId, item.id)
    }
}

/// Verdict of the goal gate — a `StatusRow` (Chat/StatusForm.swift) like any other, without green.
private struct GoalEventView: View {
    let item: TimelineItem

    var body: some View {
        StatusRow(symbol: item.achieved == true ? "checkmark.circle" : "circle", header: header, rest: item.label)
    }

    private var header: String {
        if item.achieved == true {
            guard let turns = item.turns, turns > 0 else { return L("Goal achieved") }
            return "\(L("Goal achieved")) (\(turns) \(turns == 1 ? L("run") : L("runs")))"
        }
        guard let continuing = item.continuing else { return L("Goal still open") }
        return "\(L("Goal still open")) · \(L("continuing")) (\(continuing))"
    }
}

private struct MonitorEventView: View {
    let item: TimelineItem

    var body: some View {
        StatusRow(symbol: symbol, header: title, rest: item.label)
    }

    private var symbol: String {
        item.event == "done" ? "checkmark.circle" : item.event == "fired" ? "bolt" : "scope"
    }

    private var title: String {
        if item.event == "done" {
            return item.status.map { $0 == "completed" ? L("Monitor finished") : L("Monitor finished ({status})", ["status": $0]) } ?? L("Monitor finished")
        }
        return item.event == "fired" ? L("Monitor fired") : L("Monitor started")
    }
}

/// Rows of the workflow driver in the timeline (start, step, verdict, question, end) — in the same calm style as goal gate
/// and monitor, so the sequence stays readable.
/// Row about the usage limit in the timeline (parked / resumed / discarded / model switch). The text arrives already
/// translated from the server — it knows window, time and model name.
private struct LimitEventView: View {
    let line: LimitLine

    var body: some View {
        StatusRow(symbol: symbol, header: title, rest: line.text, rows: nil)
            .accessibilityIdentifier("chat-limit-line-\(line.kind)")
    }

    // Three start kinds that used to be ONE ("resume"): `resume` = the reset is there, it continues by itself; `retry` = the
    // human pressed "Try now" — nothing was reset; `gate-free` = the human pressed "Start anyway (costs credit)", this one
    // turn runs on credit. All three are a START, not a brake. If `retry` and `gate-free` fell into the fallback, "Usage
    // limit reached" with an orange clock would stand above a turn the human has just deliberately started — the opposite of
    // the statement. Web counterpart: LimitStrip.tsx, `LimitRow`.
    private var symbol: String {
        switch line.kind {
        case "resume", "retry": return "clock.badge.checkmark"
        case "gate-free": return "checkmark.circle"
        // No clock symbol: nothing waited here, the CLI switched the model by itself. The same icon as for parking would
        // make the row read as a limit hit.
        case "model_switch": return "arrow.left.arrow.right"
        // The credit gate intercepted the START — NOTHING failed. Here too the limit icon would be a false statement;
        // "gate-stale" and "gate-off" are even rows saying that it started anyway. (The server no longer writes `gate-off` —
        // the gate parks even without auto-continue; the branch stays for old histories.)
        case "gate": return "hand.raised"
        case "gate-stale", "gate-off": return "info.circle"
        default: return "clock.badge.exclamationmark"
        }
    }

    // The colour per kind was dropped — word and symbol carry the statement (Chat/StatusForm.swift).

    private var title: String {
        switch line.kind {
        case "resume": return line.early ? L("Credit gate clear") : L("Limit has reset")
        case "retry": return L("Tried again")
        case "credits", "too-long", "gave-up": return L("No automatic continuation")
        case "cancel": return L("Stopped waiting")
        // At the Fable limit the CLI switches the model by itself and only says so in its output ("continuing on …"). That
        // is not prevented — but it is not secret either: which model answers now is in the text next to this row.
        case "model_switch": return L("Model switched")
        case "gate": return L("No new turn started")
        // The human's decision at the gate: the server writes beside it "Started anyway: <window> is at N % — …".
        case "gate-free": return L("Started anyway")
        // Two cases in which the gate is on and still started: the measurement was too old, or automatic continuing was off.
        // Both say the same: the gate did NOT decide — and why.
        case "gate-stale", "gate-off": return L("Credit gate bypassed")
        default: return L("Usage limit reached")
        }
    }
}

private struct WorkflowEventView: View {
    let line: WorkflowLine

    var body: some View {
        StatusRow(symbol: symbol, header: title, rest: detail, rows: detailLineLimit)
            .accessibilityIdentifier("chat-workflow-line-\(line.kind)")
    }

    /// For a question (and for an error/abort reason) the follow-up text IS the content — it must not be cut off.
    /// Otherwise the row stays short so the sequence of steps stays skimmable.
    private var detailLineLimit: Int? {
        if line.kind == "ask" { return nil }
        if line.kind == "cap" && line.granted == 0 { return nil }
        if line.kind == "gate" && !line.text.isEmpty { return nil }
        if line.kind == "end" && line.status != "done" { return nil }
        return 3
    }

    private var symbol: String {
        switch line.kind {
        case "start", "step": return "arrow.right"
        case "decision": return "arrow.triangle.branch"
        case "loop": return "arrow.triangle.2.circlepath"
        case "ask": return "questionmark.bubble"
        case "review": return "person.crop.circle.badge.checkmark"
        case "cap": return "gauge.with.dots.needle.33percent"
        case "gate": return line.done == true ? "checkmark.circle" : "circle"
        case "skip": return "forward.end"
        case "command": return "terminal"
        default: return line.status == "done" ? "checkmark.circle" : "circle"
        }
    }

    private var title: String {
        switch line.kind {
        case "start":
            return L("Workflow “{name}” started", ["name": line.name])
        case "step":
            let position = line.total > 0
                ? "\(line.step)/\(line.approx ? "ca. " : "")\(line.total)"
                : String(line.step)
            let head = L("Step {pos}", ["pos": position])
            return line.title.isEmpty ? head : "\(head): \(line.title)"
        case "decision":
            let verdict = line.yes == true ? L("Yes") : L("No")
            return line.title.isEmpty ? verdict : "\(line.title): \(verdict)"
        case "loop":
            return L("Loop {title}", ["title": line.title])
        case "ask":
            return L("Question##ask")
        case "review":
            if line.verdict == "ok" { return L("Review approved") }
            if line.verdict == "issues" { return L("Findings reported — back into fixing") }
            return line.round > 1
                ? L("Review requested (round {n})", ["n": String(line.round)])
                : L("Review requested")
        case "cap":
            return line.granted > 0
                ? L("{n} more rounds granted", ["n": String(line.granted)])
                : L("Round cap: {title}", ["title": line.title])
        case "gate":
            if line.done == true { return L("Finished: {title}", ["title": line.title]) }
            if line.maxRounds > 0 && line.text.isEmpty {
                return L("Not finished yet: {title} (round {r}/{n})",
                         ["title": line.title, "r": String(line.round), "n": String(line.maxRounds)])
            }
            return L("Not finished yet: {title}", ["title": line.title])
        case "skip":
            return L("Step skipped")
        case "command":
            // A command BEFORE a node (/clear, /compact …). Without a case of its own it lands below and reports "Workflow
            // failed" although the run continues fine.
            return L("Command {cmd} before \"{title}\"", ["cmd": line.command, "title": line.title])
        default:
            // Judge only with a status set — an unknown block kind is no failure.
            switch line.status {
            case "done": return L("Workflow completed")
            case "cancelled": return L("Workflow cancelled")
            case "": return L("Workflow step")
            default: return L("Workflow failed")
            }
        }
    }

    private var detail: String {
        switch line.kind {
        case "start":
            return line.total > 0 ? L("{n} steps", ["n": String(line.total)]) : ""
        case "step":
            if let index = line.loopIndex, let total = line.loopTotal {
                return L("Item {i}/{n}: {item}", ["i": String(index), "n": String(total), "item": line.loopItem ?? ""])
            }
            return ""
        case "loop":
            return line.count > 0 ? L("{n} items", ["n": String(line.count)]) : L("nothing to do")
        case "ask":
            return line.text
        case "review":
            // The instructions are already above as the agent's message (formatted there) — here only what is to be done
            // now or how it was judged.
            if line.verdict.isEmpty { return L("Your answer decides: “looks good” moves on, findings go back into the fix.") }
            return line.note.isEmpty ? line.title : line.note
        case "cap":
            if line.auto { return line.note }
            return line.granted > 0 ? line.title : line.text
        case "gate":
            return line.text.isEmpty ? line.note : line.text
        case "skip":
            return line.title
        default:
            return line.note
        }
    }
}
