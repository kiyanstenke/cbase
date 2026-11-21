import SwiftUI

// The progress tree of the dynamic workflows in the agents sheet of a Coding chat — the same tree as in the right bar of the
// web (web/src/components/chat/DynWorkflowTree.tsx).
//
// Laid out like Claude Code's workflow view. EVERY WORKFLOW IS ONE CARD: a `CbPane` per run —
// without tint and without an accent border, even while it runs —, spacing instead of a divider between two runs. At the top of the card
// the head — name, runtime (driven by the sheet's one-second tick, `now`), stop as a symbol (`stop.fill`), "Workflow ·
// status" with the current phase, "N agents · X tokens" with n/m, the description (meta.description), the newest
// log() row —, below it one SECTION per phase of the same surface (hairline across the full width, no border of its own,
// no surface of its own, no "Phases" heading) with title, n/m, chevron and one tile per agent (blue running, gray
// filled finished, gray outlined waiting, red error, muted the rest). The running phase stands open, a finished one closed;
// open/closed is told by the chevron alone (and `accessibilityHint`); a tap toggles, the choice holds. A collapsed run
// shows only the head in its card. Expanded, the table: state symbol, label (below it
// deviation, restarts, short model), tokens, time, the handles as SF Symbols (`arrow.counterclockwise`,
// `forward.end`, each with an accessibilityLabel) and a chevron. A tap on a row SWAPS the sheet's page for
// that of the agent (as with a subagent): its transcript as the same timeline as the steps of a subagent,
// every step leads to the page of its call.
//
// The WAIT REASON stands there with its number (a phase with six dashed circles without
// tokens and time raised the question whether it was skipped — the cap per run was 2): the side line of a waiting agent says
// "waiting · 2 at a time" (not "waiting for a free slot" without a number), and the head of a phase in which agents wait and
// nothing works carries under the tiles "waiting for a free slot · 2 at a time" (`chat-dynwf-band-wait`).
// Text and number from `DynTree.waitText`/`bandWaitText` (bound to the web); the number stands first ("waiting · 8 per user").
// The rule, the same as on the web: the reason NEVER displaces what a waiting agent already has — tokens and time
// stand in every row, also for one parked at the usage limit (started, with tokens), and the reason stands briefly beside them in the
// side line. The web replaces model, tokens and time by one cell with the reason only while the waiting agent has none of them
// (`waitCell` in web/src/lib/dyn-tree.ts); here two dashes then stand — the reason is in the side line anyway.
//
// NOTHING is computed here: bands, n/m (head and phase), default "open", tile kind, times, token sum, short name
// of the model, wait reason, display word and loading state come from `DynTree` (Chat/DynTree.swift, bound to the web), the
// state words from `HistoryState`. The stop at the head is the human stop.
// HIG instead of the web model: no glass, surfaces and hairlines from `Kit/CbKit`.
//
// This file holds ONLY THE CARD (`DynWorkflowCard`), not the list of runs with a "Dynamic workflows" heading:
// all tasks appear in one list under "Background Tasks", with the same card design as the workflows in the agents sidebar, subagents
// included. That ONE list is built by the agents sheet (`SubagentsSheet`, Chat/ChatDetailSheet.swift): subagents and runs
// mixed, newest on top (Chat/BackgroundTasks.swift, bound to the web), the subagent card in THIS form.

/// The transcript of ONE workflow agent (`GET …/dyn-workflows/runs/:runId/agents/:n`): the
/// framed task, text, thinking, tool calls and their results — read leniently like the tree.
enum DynTranscript {
    struct Row: Decodable, Equatable {
        let kind: String
        let text: String
        let name: String
        let id: String
        let input: JSONValue?
        let error: Bool
        /// Only for kind "message" (agent communication): sender, delivery state, reason.
        let from: String
        let state: String
        let reason: String

        private enum CodingKeys: String, CodingKey { case kind, text, name, id, input, error, from, state, reason }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            kind = (try? c.decodeIfPresent(String.self, forKey: .kind)) ?? ""
            text = (try? c.decodeIfPresent(String.self, forKey: .text)) ?? ""
            name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? ""
            id = (try? c.decodeIfPresent(String.self, forKey: .id)) ?? ""
            input = try? c.decodeIfPresent(JSONValue.self, forKey: .input)
            error = (try? c.decodeIfPresent(Bool.self, forKey: .error)) == true
            from = (try? c.decodeIfPresent(String.self, forKey: .from)) ?? ""
            state = (try? c.decodeIfPresent(String.self, forKey: .state)) ?? ""
            reason = (try? c.decodeIfPresent(String.self, forKey: .reason)) ?? ""
        }
    }

    struct Response: Decodable {
        let rows: [Row]
        private enum CodingKeys: String, CodingKey { case rows }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            rows = ((try? c.decodeIfPresent([DynTree.Possible<Row>].self, forKey: .rows)) ?? []).compactMap(\.value)
        }
    }

    enum Snapshot: Equatable {
        case loading
        case rows([Row])
        case error(String)
    }

    static func key(runId: String, n: Int) -> String { "\(runId)#\(n)" }

    /// The rows as blocks of the timeline — the same form as the steps of a subagent, so that a tap leads to the
    /// page of the same call (`BlockPage`). The task stands above, not inside; a result attaches to
    /// its call (via the call id). The identifiers are stable (prefix + position), otherwise the page would lose
    /// its block on reload.
    static func blocks(_ rows: [Row], prefix: String) -> [ChatBlock] {
        var blocks: [ChatBlock] = []
        for (i, z) in rows.enumerated() {
            let id = "\(prefix)-\(i)"
            switch z.kind {
            case "text": blocks.append(ChatBlock(id: id, kind: .text, text: z.text, done: true))
            case "thinking": blocks.append(ChatBlock(id: id, kind: .thinking, text: z.text, done: true))
            // A message to this agent (agent communication): a block of its own with a sender marker —
            // the timeline shows "Message from the human · queued" instead of "Text"; what did not arrive carries the reason.
            case "message":
                let reason = z.state == "not_delivered" && !z.reason.isEmpty ? "\n\n" + L("Reason: {reason}", ["reason": z.reason]) : ""
                blocks.append(ChatBlock(id: id, kind: .text, text: z.text + reason, done: true,
                                         message: ChatMessageMarker(from: z.from, state: z.state, reason: z.reason)))
            case "tool":
                blocks.append(ChatBlock(id: id, kind: .tool, toolUseId: z.id, toolName: z.name, input: z.input))
            case "tool-result":
                if let j = blocks.lastIndex(where: { $0.kind == .tool && !$0.done && $0.toolUseId == z.id && !z.id.isEmpty }) {
                    blocks[j].result = z.text
                    blocks[j].resultIsError = z.error
                    blocks[j].done = true
                }
            default: break
            }
        }
        return blocks
    }

    static func job(_ rows: [Row]) -> String? {
        rows.first { $0.kind == "job" && !$0.text.isEmpty }?.text
    }
}

/// Which workflow agent is open in the sheet.
struct DynTreeSelection: Equatable {
    let runId: String
    let n: Int
}

/// How many log() rows a head shows before it is expanded — the newest (as on the web).
private let logVisible = 1

/// One workflow: ONE card — the head on top, below it the phases as sections of the same surface. Not private:
/// the "Background Tasks" list of the agents sheet (`SubagentsSheet`, Chat/ChatDetailSheet.swift)
/// puts it between the subagent cards, newest on top (`BackgroundTasks`).
struct DynWorkflowCard: View {
    @ObservedObject var model: ChatViewModel
    let run: DynTree.Run
    let now: Date
    let onSelect: (DynTreeSelection) -> Void
    /// A running workflow stands open, a finished one closed — its rows are then history.
    @State private var open: Bool?
    @State private var allLogs = false
    @State private var stopQuestion = false
    @State private var stops = false
    /// The "Message" sheet to a workflow agent — HERE and not at the row: the
    /// row exists only while its phase is expanded, and the phase closes by itself as soon as nothing runs
    /// or waits in it. If the addressed agent ended while the human was typing, the sheet would go with the row, text included — exactly in the
    /// most common case of rejection (agent finished, 409), whose promise is "the text is not lost". The target is frozen
    /// on opening (name, state), it does not point into the void.
    @State private var message: AgentMessageTarget?

    var body: some View {
        let (header, bands) = DynTree.model(run)
        let isOpen = open ?? header.running
        CbPane {
            VStack(alignment: .leading, spacing: 0) {
                headerRow(header, open: isOpen)
                statusRow(header)
                numbersLine(header)
                if !header.description.isEmpty {
                    Text(header.description)
                        .font(.footnote)
                        .foregroundStyle(.primary.opacity(0.85))
                        .lineLimit(4)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.horizontal, 14)
                        .padding(.bottom, 8)
                        .accessibilityIdentifier("chat-dynwf-description-\(header.runId)")
                }
                if let warning = header.warning {
                    Text(warning)
                        .font(.caption)
                        .foregroundStyle(.orange)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.horizontal, 14)
                        .padding(.bottom, 6)
                }
                logs(header)
            }
            .padding(.bottom, 2)
            // The phases as sections of the card: one hairline across the full width before each, no "Phases"
            // heading (the card carries the structure).
            if isOpen {
                // The identity is the title (like the key on the web): by offset the expand choice wandered to another phase as soon as a
                // new phase came in before "No phase" (stands last). Titles are unique — the bands ARE the groups per title.
                ForEach(bands, id: \.title) { band in
                    CbSeparator(inset: 0)
                    if let empty = band.empty {
                        DynWorkflowEmptyPhase(title: band.title ?? L("No phase"), empty: empty)
                    } else {
                        DynWorkflowPhase(model: model, run: run, header: header, band: band, now: now, onSelect: onSelect,
                                         onMessage: { message = $0 })
                    }
                }
            }
        }
        // As on the web (`useState(header.running)`): the state at FIRST appearance decides — a run that ends
        // while one watches does not collapse under the eye (otherwise the stopped agent would vanish with the stop).
        .onAppear { if open == nil { open = header.running } }
        .onChange(of: header.running) { _, running in if !running { stops = false } }
        .sheet(item: $message) { target in AgentMessageSheet(model: model, target: target).cbSheet(.half) }
        .confirmationDialog(L("Stop this workflow?"), isPresented: $stopQuestion, titleVisibility: .visible) {
            Button(L("Stop workflow"), role: .destructive) {
                stopQuestion = false
                stops = true
                Task { if !(await model.stopDynWorkflow(run.runId)) { stops = false } }
            }
            Button(L("Cancel"), role: .cancel) { stopQuestion = false }
        } message: {
            Text(L("Stop the whole workflow — running agents end, the main agent learns about it in its next turn."))
        }
    }

    /// Name on the left, runtime on the right, beside it the stop as a symbol — a SEPARATE button next to the expand button.
    private func headerRow(_ header: DynTree.Header, open isOpen: Bool) -> some View {
        HStack(spacing: 8) {
            Button { open = !isOpen } label: {
                HStack(spacing: 7) {
                    Image(systemName: isOpen ? "chevron.down" : "chevron.right")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: 12)
                    Text(header.name.isEmpty ? L("Workflow") : header.name)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                    Spacer(minLength: 6)
                    if let duration = DynTree.runDurationMs(run, now: now.timeIntervalSince1970 * 1000) {
                        Text(ChatViewModel.formatDuration(Int((duration / 1000).rounded())))
                            .font(.caption)
                            .monospacedDigit()
                            .foregroundStyle(.secondary)
                            .accessibilityIdentifier("chat-dynwf-duration-\(header.runId)")
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(header.name)
            // n/m as the value: finished / agent() calls. Open/closed as a hint (on the web `aria-expanded`) — the border does not say it.
            .accessibilityValue("\(header.finished)/\(header.started)")
            .accessibilityHint(isOpen ? L("Expanded") : L("Collapsed"))
            .accessibilityIdentifier("chat-dynwf-header-\(header.runId)")
            if header.running {
                Button(role: .destructive) { stopQuestion = true } label: {
                    if stops {
                        ProgressView().controlSize(.mini)
                    } else {
                        Image(systemName: "stop.fill").font(.caption.weight(.semibold))
                    }
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(stops)
                .accessibilityLabel(L("Stop"))
                .accessibilityHint(L("Stop the whole workflow — running agents end, the main agent learns about it in its next turn."))
                .accessibilityIdentifier("chat-dynwf-stop-\(header.runId)")
            }
        }
        .padding(.horizontal, 14)
        .padding(.top, 10)
        .padding(.bottom, 4)
    }

    /// "Workflow · status" on the left, the current phase on the right.
    private func statusRow(_ header: DynTree.Header) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(L("Workflow"))
                .foregroundStyle(.secondary)
            Text(outcome(header))
                .fontWeight(.medium)
                .foregroundStyle(outcomeColor(header.status))
                .accessibilityIdentifier("chat-dynwf-outcome-\(header.runId)")
            Spacer(minLength: 6)
            Text(header.phase.map { L("Phase: {phase}", ["phase": $0]) } ?? L("no phase yet"))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .accessibilityIdentifier("chat-dynwf-phase-\(header.runId)")
        }
        .font(.caption)
        .padding(.leading, 33)
        .padding(.trailing, 14)
        .padding(.bottom, 2)
    }

    /// "N agents · X tokens" on the left, n/m on the right.
    private func numbersLine(_ header: DynTree.Header) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(agentsAndTokens(header))
                .lineLimit(1)
            Spacer(minLength: 6)
            Text("\(header.finished)/\(header.started)")
                .monospacedDigit()
                .accessibilityHidden(true)
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .padding(.leading, 33)
        .padding(.trailing, 14)
        .padding(.bottom, 8)
    }

    private func agentsAndTokens(_ header: DynTree.Header) -> String {
        var parts = [header.started == 1 ? L("1 agent") : L("{n} agents", ["n": header.started])]
        if let sum = DynTree.runTokens(run) {
            let count = ChatViewModel.formatTokens(sum.tokens)
            parts.append("\(ChatViewModel.tokenLowerLimit(sum.tokenKind) ? "≥" : "")\(count) \(L("tokens"))")
        }
        return parts.joined(separator: " · ")
    }

    private func outcome(_ header: DynTree.Header) -> String {
        let word = L(DynTree.runWord(header.status))
        return header.status == "stopped" && header.stoppedOf == "human" ? "\(word) · \(L("by you"))" : word
    }

    private func outcomeColor(_ status: String) -> Color {
        switch status {
        case "running": return .accentColor
        case "finished": return .green
        case "failed": return .red
        default: return .secondary
        }
    }

    @ViewBuilder private func logs(_ header: DynTree.Header) -> some View {
        let shown = allLogs ? header.logs : Array(header.logs.suffix(logVisible))
        let hidden = header.logs.count - shown.count
        if !header.logs.isEmpty || header.logsTruncated > 0 {
            VStack(alignment: .leading, spacing: 2) {
                if allLogs && header.logsTruncated > 0 {
                    Text(L("Truncated: the tree does not show the {n} oldest lines.", ["n": header.logsTruncated]))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                ForEach(Array(shown.enumerated()), id: \.offset) { _, z in
                    Text(z.text)
                        .cbFont(11, design: .monospaced)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .accessibilityIdentifier("chat-dynwf-log")
                }
                if hidden > 0 || header.logsTruncated > 0 {
                    Button { allLogs.toggle() } label: {
                        Text(allLogs ? L("fewer log() lines") : L("{n} older log() lines", ["n": hidden + header.logsTruncated]))
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .underline()
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("chat-dynwf-log-more")
                }
            }
            .padding(.leading, 33)
            .padding(.trailing, 14)
            .padding(.bottom, 8)
        }
    }
}

// ── One phase as a section of the card: title, n/m, one tile per agent, expanded the table ──

/// A phase without agents (known from meta.phases or passed without an agent() call) — as on the web
/// (`EmptyPhase` in DynWorkflowTree.tsx): the title row muted, on the right the word instead of n/m, nothing to expand. Own
/// identifier `chat-dynwf-band-empty`, so that tests that count phase cards count only those with agents.
private struct DynWorkflowEmptyPhase: View {
    let title: String
    let empty: DynTree.Empty

    var body: some View {
        HStack(spacing: 8) {
            Text(title)
                .font(.subheadline.weight(.medium))
                .lineLimit(1)
            Spacer(minLength: 6)
            Text(L(empty.word))
                .font(.caption)
        }
        .foregroundStyle(.secondary)
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(title)
        .accessibilityValue(L(empty.word))
        .accessibilityIdentifier("chat-dynwf-band-empty")
    }
}

private struct DynWorkflowPhase: View {
    @ObservedObject var model: ChatViewModel
    let run: DynTree.Run
    let header: DynTree.Header
    let band: DynTree.Band
    let now: Date
    let onSelect: (DynTreeSelection) -> Void
    /// Opens the "Message" sheet at the CARD (it lives there — see `DynWorkflowCard.message`).
    let onMessage: (AgentMessageTarget) -> Void
    /// The human's choice (a tap on the phase title) — it goes before the default.
    @State private var choice: Bool?
    /// The default as it applied last: it follows the run only while it runs — a stop closes nothing.
    @State private var follows: Bool?
    @ScaledMetric(relativeTo: .caption) private var spTokens: CGFloat = 48
    @ScaledMetric(relativeTo: .caption) private var spTime: CGFloat = 42
    /// The column of the buttons — COMPUTED from `DynHandleStyle`, not estimated: a
    /// `@ScaledMetric` (106 relative to .caption) used to stand here in front of `.bordered` mini buttons. Their capsule padding does not grow with the
    /// type, the column did — at "Compact"/"Small" it shrank below the three buttons, and they ran over the
    /// time column. The buttons now have a fixed size (symbols stay fixed, as everywhere).
    private let spHandles = DynHandleStyle.column(buttons: 3)

    var body: some View {
        let preset = DynTree.bandDefaultOpen(band, runRunning: header.running)
        let isOpen = choice ?? follows ?? preset
        let title = band.title ?? L("No phase")
        // If a phase only waits, the head says what for — otherwise it would look like a skipped one.
        let wait = DynTree.bandWaitText(band, runRunning: header.running, cap: run.cap)
        // No border of its own, no surface of its own: the phase lies IN the run's card (the hairline before it is set by the run).
        VStack(alignment: .leading, spacing: 0) {
            Button { choice = !isOpen } label: {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 8) {
                        Text(title)
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(.primary)
                            .lineLimit(1)
                        Spacer(minLength: 6)
                        Text("\(band.finished)/\(band.rows.count)")
                            .font(.caption)
                            .monospacedDigit()
                            .foregroundStyle(.secondary)
                        Image(systemName: isOpen ? "chevron.up" : "chevron.down")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.secondary)
                    }
                    DynTileRow(rows: band.rows)
                    if let wait {
                        Text(L(wait.lang, wait.values))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("chat-dynwf-band-wait")
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            // The wait reason of the phase as an addition to the label.
            .accessibilityLabel(wait.map { "\(title), \(L($0.lang, $0.values))" } ?? title)
            .accessibilityValue("\(band.finished)/\(band.rows.count)")
            // The state of the phase (on the web `aria-expanded`) — the only one next to the chevron, it carries no border any more; the
            // value stays n/m — testDynWorkflowTreeInAgentsSheet reads it.
            .accessibilityHint(isOpen ? L("Expanded") : L("Collapsed"))
            .accessibilityIdentifier("chat-dynwf-band")
            // Expanded: the column head directly under the tiles (without a line — the tiles close off the title), before
            // EVERY row an indented hairline — quieter than the full-width line between two phases.
            if isOpen {
                tablesHeader
                ForEach(band.rows, id: \.agent.n) { row in
                    CbSeparator()
                    DynWorkflowAgentRow(model: model, run: run, row: row, runRunning: header.running, now: now,
                                          spTokens: spTokens, spTime: spTime, spHandles: spHandles, onMessage: onMessage) {
                        onSelect(DynTreeSelection(runId: run.runId, n: row.agent.n))
                    }
                }
            }
        }
        .onAppear { if follows == nil { follows = preset } }
        .onChange(of: preset) { _, fresh in if header.running { follows = fresh } }
    }

    /// The column head of the table: agent · tokens · time (the model stands under the name — the phone has no width
    /// to spare for a column).
    private var tablesHeader: some View {
        HStack(spacing: 8) {
            CbOverline(L("Agent"))
                .padding(.leading, 27)
            Spacer(minLength: 8)
            CbOverline(L("tokens"))
                .frame(width: spTokens, alignment: .trailing)
            CbOverline(L("Time"))
                .frame(width: spTime, alignment: .trailing)
            // The space of the buttons (in a running run in every row) and the chevron — empty, so the heads stand above the numbers.
            Color.clear.frame(width: (header.running ? spHandles + 8 : 0) + DynWorkflowAgentRow.rightMargin, height: 1)
        }
        .padding(.horizontal, 14)
        .padding(.bottom, 4)
        .accessibilityHidden(true)
    }
}

/// One tile per agent — blue running, green finished, gray outlined waiting, red error, orange aborted, muted the rest
/// (`DynTree.tileKind`, the same computation as on the web). Purely displaying: the phase's value (n/m) says it when read aloud.
private struct DynTileRow: View {
    let rows: [DynTree.Row]
    private let columns = [GridItem(.adaptive(minimum: 9, maximum: 9), spacing: 3, alignment: .leading)]

    var body: some View {
        LazyVGrid(columns: columns, alignment: .leading, spacing: 3) {
            ForEach(rows, id: \.agent.n) { row in
                tile(DynTree.tileKind(row.agent.status))
                    .frame(width: 9, height: 9)
            }
        }
        .accessibilityHidden(true)
    }

    @ViewBuilder private func tile(_ kind: String) -> some View {
        let form = RoundedRectangle(cornerRadius: 2, style: .continuous)
        switch kind {
        case "running": form.fill(Color.accentColor)
        case "finished": form.fill(Color.green.opacity(0.85))
        case "waiting": form.strokeBorder(Color.secondary.opacity(0.6), lineWidth: 1)
        case "error": form.fill(Color.red.opacity(0.85))
        case "aborted": form.fill(Color.orange.opacity(0.8))
        default: form.fill(Color.secondary.opacity(0.22))
        }
    }
}

// ── The handles of an agent row ──

/// Message, restart, skip: a symbol (fixed, `.symbol(12, weight: .semibold)` on the image) in a tinted
/// capsule of FIXED size, so that the column (`DynWorkflowPhase.spHandles`) fits the buttons exactly at every text size.
/// Looks like the earlier `.bordered` + `.controlSize(.mini)` — whose padding the system determined, not we.
struct DynHandleStyle: ButtonStyle {
    static let width: CGFloat = 30
    static let height: CGFloat = 24
    static let gap: CGFloat = 4

    static func column(buttons: Int) -> CGFloat {
        CGFloat(buttons) * width + CGFloat(max(buttons - 1, 0)) * gap
    }

    func makeBody(configuration: Configuration) -> some View {
        Handle(configuration: configuration)
    }

    private struct Handle: View {
        let configuration: ButtonStyleConfiguration
        @Environment(\.isEnabled) private var active

        var body: some View {
            configuration.label
                .foregroundStyle(.tint)
                .frame(width: DynHandleStyle.width, height: DynHandleStyle.height)
                .background(.tint.opacity(configuration.isPressed ? 0.32 : 0.18), in: Capsule())
                .contentShape(Capsule())
                .opacity(active ? 1 : 0.4)
        }
    }
}

// ── One agent row of the table ──

private struct DynWorkflowAgentRow: View {
    @ObservedObject var model: ChatViewModel
    let run: DynTree.Run
    let row: DynTree.Row
    let runRunning: Bool
    let now: Date
    let spTokens: CGFloat
    let spTime: CGFloat
    let spHandles: CGFloat
    /// "Message" opens the sheet at the CARD, never here: the row vanishes with its collapsing phase (see
    /// `DynWorkflowCard.message`).
    let onMessage: (AgentMessageTarget) -> Void
    let onTap: () -> Void
    /// A handle is in flight: both buttons rest until the state of the row changes (the tree's message).
    @State private var inFlight = false

    /// Right: the chevron. "Restart" and "Skip" are SEPARATE symbol buttons in front of it — a button inside the
    /// label of a button does not reliably get the touch, so the row button is only the left part.
    static let rightMargin: CGFloat = 12
    // The column of the three buttons (`spHandles`) stands in EVERY row in a running run, so the numbers do not jump
    // when they come and go (as on the web).

    private var agent: DynTree.Agent { row.agent }
    private var identifier: String { row.state?.identifier ?? "finished" }

    var body: some View {
        HStack(alignment: .center, spacing: 8) {
            Button(action: onTap) {
                HStack(alignment: .center, spacing: 9) {
                    stateSymbol
                        .frame(width: 18)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(agent.label.isEmpty ? L("Agent {n}", ["n": agent.n]) : agent.label)
                            .font(.subheadline)
                            .foregroundStyle(.primary)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                        if !sideLine.isEmpty {
                            Text(sideLine)
                                .font(.caption)
                                .foregroundStyle(sideLineColor)
                                .lineLimit(2)
                                .multilineTextAlignment(.leading)
                        }
                    }
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            // The state word as the value — also "running", which the row visibly does not carry (as in the subagents sheet). The
            // wait reason with its number is read by VoiceOver from the side line in the label; the value stays the word.
            .accessibilityValue(row.state.map { L($0.word) } ?? "")
            .accessibilityIdentifier("chat-dynwf-agent-\(run.runId)-\(agent.n)")
            Text(Self.tokenColumn(agent))
                .font(.caption.weight(.medium))
                .monospacedDigit()
                .foregroundStyle(.primary)
                .lineLimit(1)
                .frame(width: spTokens, alignment: .trailing)
                .accessibilityLabel(Self.tokenReadAloud(agent))
                .accessibilityValue(Self.tokenColumn(agent))
                .accessibilityIdentifier("chat-dynwf-tokens-\(run.runId)-\(agent.n)")
            Text(timeColumn)
                .font(.caption)
                .monospacedDigit()
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .frame(width: spTime, alignment: .trailing)
                .accessibilityIdentifier("chat-dynwf-time-\(run.runId)-\(agent.n)")
            if runRunning {
                actions
                    .frame(width: spHandles, alignment: .trailing)
            }
            Image(systemName: "chevron.right")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .frame(width: Self.rightMargin, alignment: .trailing)
        }
        .cbRow(vertical: 8)
        .onChange(of: agent.status) { _, _ in inFlight = false }
        .onChange(of: agent.restarts) { _, _ in inFlight = false }
    }

    /// The state symbol before the row — checkmark finished, spinning circle running, cross error, dashed circle waiting.
    @ViewBuilder private var stateSymbol: some View {
        switch identifier {
        case "finished": Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
        case "running": ProgressView().controlSize(.mini)
        case "error": Image(systemName: "xmark.circle.fill").foregroundStyle(.red)
        case "waiting": Image(systemName: "circle.dashed").foregroundStyle(.secondary)
        case "skipped": Image(systemName: "forward.end.circle").foregroundStyle(.secondary)
        case "stopped": Image(systemName: "stop.circle").foregroundStyle(.secondary)
        default: Image(systemName: "minus.circle").foregroundStyle(.secondary)
        }
    }

    /// The buttons per agent as SF Symbols: which ones stand is told by `DynTree.handles` (the same rule as on the web);
    /// a third word "Stop per agent" does not exist. Identifiers on the button, never on the stack.
    @ViewBuilder private var actions: some View {
        let g = DynTree.handles(agent, runRunning: runRunning)
        HStack(spacing: DynHandleStyle.gap) {
            // "Message" on every LIVING agent — also a waiting one (the run address applies before its start; the
            // message is queued). As on the web.
            if Self.live(agent, runRunning: runRunning) {
                AgentMessageButton(identifier: "chat-dynwf-message-\(run.runId)-\(agent.n)") {
                    onMessage(Self.messageTarget(run: run, row: row, runRunning: runRunning))
                }
            }
            if g.restart {
                Button { handle(restart: true) } label: {
                    Image(systemName: "arrow.counterclockwise").font(.symbol(12, weight: .semibold))
                }
                .buttonStyle(DynHandleStyle())
                .disabled(inFlight)
                .accessibilityLabel(L("Restart"))
                .accessibilityIdentifier("chat-dynwf-restart-\(run.runId)-\(agent.n)")
            }
            if g.skip {
                Button { handle(restart: false) } label: {
                    Image(systemName: "forward.end").font(.symbol(12, weight: .semibold))
                }
                .buttonStyle(DynHandleStyle())
                .disabled(inFlight)
                .accessibilityLabel(L("Skip"))
                .accessibilityIdentifier("chat-dynwf-skip-\(run.runId)-\(agent.n)")
            }
        }
    }

    /// Is the agent alive — does it run or wait in a running workflow? Only then "Message" stands.
    static func live(_ agent: DynTree.Agent, runRunning: Bool) -> Bool {
        runRunning && (agent.status == "running" || agent.status == "waiting")
    }

    /// The target of the sheet: always the run address (`wf:<runId>:<n>`), state as in the row (for a waiting one the reason).
    static func messageTarget(run: DynTree.Run, row: DynTree.Row, runRunning: Bool) -> AgentMessageTarget {
        let agent = row.agent
        var state = row.state.map { L($0.word) } ?? L("done")
        if row.state?.identifier == "waiting", let w = DynTree.waitText(agent, cap: run.cap) { state = L(w.lang, w.values) }
        return AgentMessageTarget(address: AgentMessageTarget.workflowAddress(runId: run.runId, n: agent.n),
                                  name: agent.label.isEmpty ? L("Agent {n}", ["n": agent.n]) : agent.label,
                                  kind: L("Workflow agent"), state: state)
    }

    private func handle(restart: Bool) {
        guard !inFlight else { return }
        inFlight = true
        Task { if !(await model.dynAgentIntervention(runId: run.runId, n: agent.n, restart: restart)) { inFlight = false } }
    }

    /// The agent's time (`DynTree.agentDurationMs`) as m:ss — a dash where it never started.
    private var timeColumn: String {
        guard let ms = DynTree.agentDurationMs(agent, run: run, now: now.timeIntervalSince1970 * 1000) else { return "–" }
        return DynTree.durationShort(ms)
    }

    /// The second line: the word only on deviation (finished carries none, a running one in a running workflow
    /// neither — there the symbol says it), for a waiting one its reason with the cap number ("waiting · 2 at a time",
    /// `DynTree.waitText`), then restarts, the model (short) and "from the journal".
    private var sideLine: String {
        var parts: [String] = []
        if let z = row.state, !(z.identifier == "running" && runRunning) {
            if z.identifier == "waiting", let w = DynTree.waitText(agent, cap: run.cap) {
                parts.append(L(w.short, w.values))
            } else {
                parts.append(L(z.word))
            }
        }
        // The restart before the model — as on the web, where the model takes the truncation.
        if agent.restarts > 0 { parts.append(L("restarted {n}×", ["n": agent.restarts])) }
        let model = DynTree.modelShortName(provider: agent.provider, model: agent.model)
        if !model.isEmpty { parts.append(model) }
        if agent.fromCache { parts.append(L("from the journal")) }
        return parts.joined(separator: " · ")
    }

    /// The tone from the one table — red only for "error".
    private var sideLineColor: Color {
        guard let z = row.state, !(z.identifier == "running" && runRunning) else { return .secondary }
        switch z.tone {
        case .danger: return .red
        case .accent: return .accentColor
        case .dim: return .secondary
        }
    }

    static func tokenColumn(_ agent: DynTree.Agent) -> String {
        guard let tokens = agent.tokens else { return "–" }
        let count = ChatViewModel.formatTokens(tokens)
        return ChatViewModel.tokenLowerLimit(agent.tokenKind) ? "≥\(count)" : count
    }

    static func tokenReadAloud(_ agent: DynTree.Agent) -> String {
        guard let tokens = agent.tokens else { return L("No token count") }
        return ChatViewModel.tokenLowerLimit(agent.tokenKind)
            ? L("at least {n} tokens", ["n": String(tokens)])
            : L("{n} tokens", ["n": String(tokens)])
    }
}

// ── The page of a workflow agent ──

struct DynWorkflowAgentPage: View {
    @ObservedObject var model: ChatViewModel
    let run: DynTree.Run
    let row: DynTree.Row

    private var agent: DynTree.Agent { row.agent }
    private var key: String { DynTranscript.key(runId: run.runId, n: agent.n) }
    private var running: Bool { run.status == "running" && agent.status == "running" }
    @State private var message: AgentMessageTarget?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(agent.label.isEmpty ? L("Agent {n}", ["n": agent.n]) : agent.label)
                        .font(.headline)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("chat-dynwf-agent-title")
                    Text(metrics)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("chat-dynwf-agent-metrics")
                }
                if DynWorkflowAgentRow.live(agent, runRunning: run.status == "running") {
                    Button {
                        message = DynWorkflowAgentRow.messageTarget(run: run, row: row, runRunning: true)
                    } label: {
                        Label(L("Message"), systemImage: "bubble.left")
                            .font(.subheadline)
                    }
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("chat-dynwf-message-page")
                }
                transcript
            }
            .padding(16)
        }
        .sheet(item: $message) { target in AgentMessageSheet(model: model, target: target).cbSheet(.half) }
        // Fetched anew as soon as state or tokens change — so the page follows the running agent without a tick of its own.
        .task(id: "\(key):\(agent.status):\(agent.tokens ?? -1)") {
            await model.loadDynTranscript(runId: run.runId, n: agent.n)
        }
    }

    @ViewBuilder private var transcript: some View {
        switch model.dynTranscripts[key] ?? .loading {
        case .loading:
            ProgressView().frame(maxWidth: .infinity, alignment: .leading)
        case .error(let notice):
            Text(L("Transcript not loaded: {msg}", ["msg": notice]))
                .font(.subheadline)
                .foregroundStyle(.red)
                .fixedSize(horizontal: false, vertical: true)
        case .rows(let rows):
            if let job = DynTranscript.job(rows) {
                LabeledSection(L("Brief")) {
                    Text(job)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(8)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("chat-dynwf-job")
                }
            }
            let blocks = DynTranscript.blocks(rows, prefix: "dynwf-\(key)")
            LabeledSection(L("Transcript")) {
                if blocks.isEmpty {
                    Text(L("Nothing in the transcript yet."))
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("chat-dynwf-transcript-empty")
                } else {
                    CallTimeline(blocks: blocks, live: running)
                }
            }
        }
    }

    /// One row of key figures: state · reason · model · tokens · "from the journal". What is not known is missing.
    private var metrics: String {
        var parts: [String] = []
        // For a waiting one the reason instead of the word — "waiting for a free slot · 2 at a time" already says "waiting".
        if row.state?.identifier == "waiting", let w = DynTree.waitText(agent, cap: run.cap) {
            parts.append(L(w.lang, w.values))
        } else if let z = row.state { parts.append(L(z.word)) }
        let model = DynTree.modelText(provider: agent.provider, model: agent.model)
        if !model.isEmpty { parts.append(model) }
        if let tokens = agent.tokens {
            let count = ChatViewModel.formatTokens(tokens)
            parts.append(ChatViewModel.tokenLowerLimit(agent.tokenKind) ? L("at least {n} tokens", ["n": count]) : L("{n} tokens", ["n": count]))
        }
        if agent.fromCache { parts.append(L("from the journal")) }
        return parts.joined(separator: " · ")
    }
}
