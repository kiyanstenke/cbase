// Timeline rows for tool calls: collapsed summary rows, subagent marks, the CLI task list bar and the changes view.
import SwiftUI
import UIKit

struct ChatBlockView: View {
    let block: ChatBlock
    /// The turn is still running — passed down to the summary rows below.
    var live: Bool = true

    var body: some View {
        switch block.kind {
        case .text:
            // Flush with the timeline edge (13 pt), no dot in front: paragraph, summary row and run indicator start at ONE
            // edge, as in Claude Desktop. The text edge is the view's edge (`lineFragmentPadding 0` in `ChatTextMarker`).
            if !block.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                MarkdownView(source: block.text)
                    // The container's font for everything that has none of its own (bullet, table cell) — with "Default"
                    // the same as without a font, otherwise the chat's typeface (Kit/ChatTypeface.swift).
                    .chatFont(.body)
                    .padding(.vertical, 3)
            }
        case .thinking:
            ThinkingRow(block: block)
        case .tool:
            ToolBlockRow(block: block, live: live)
        case .error:
            // No red dot: the error is recognisable by the red text.
            // No font of its own: it inherits the timeline's and grows with the text size like the answer next to it.
            Text(block.text)
                .foregroundStyle(.red)
                .chatSelectable()
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 3)
        }
    }
}

/// "Thinking ›" — the text itself comes as a sheet from below (ChatDetailSheet.swift). Flush with the edge and
/// without a symbol.
private struct ThinkingRow: View {
    let block: ChatBlock
    @Environment(\.chatTimelineItemId) private var itemId

    var body: some View {
        ChatDetailButton(identifier: "chat-thinking-row", request: {
            // A thinking block has no run state — `live` is meaningless for it.
            ChatDetailRequest(kind: .thinking, itemId: itemId, blocks: [block], live: false)
        }) {
            HStack(spacing: 7) {
                Text(L("Thinking"))
                    .chatFont(.subheadline)
                Image(systemName: "chevron.right")
                    .chatFont(.caption2, weight: .semibold)
                Spacer(minLength: 0)
            }
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
    }
}

// ── One edge for every timeline row ───────────────────────────────
// Answer, summary row, thinking row, subagent mark and the run indicator's text all start at the timeline edge
// (13 pt); there is no icon column. A state shows only through word, colour and light effect (`ChatShimmer`); the
// hexagon of the run and metrics rows sits with its box at the edge (`ChatRowSymbol` in ChatRunStatus.swift).

// ── Tool rows in the timeline ───────────────────────────────────────────────────
// Consecutive tool calls are folded by `groupToolCalls` into ONE row ("Ran 8 commands"); a single call gets the same
// row with the count 1. Nothing expands in place: the tap opens the sheet from below (ChatDetailSheet.swift) — the row
// in the timeline never changes height, so the top-edge pin that made expanding bearable in the inverted list is gone
// (it stays for the approval card).

enum ChatDisplayItem: Identifiable {
    case single(ChatBlock)
    case group([ChatBlock])
    var id: String {
        switch self {
        case .single(let block): return block.id
        case .group(let group): return group[0].id
        }
    }
}

extension TimelineItem {
    /// Does this row draw anything at all? Whatever draws nothing must get NO row in the timeline: a cell without height
    /// still costs the row spacing on BOTH sides — measured as a 22 pt gap instead of 11 pt, and correspondingly too
    /// much air above the composer at the end of the chat.
    ///
    /// Most common case: an assistant turn that contains only `TaskCreate`/`TaskUpdate`. Such calls live in the task bar
    /// above the composer and are filtered out in `groupToolCalls` — as are empty text and thinking blocks, e.g. after
    /// an abort.
    var rendersContent: Bool {
        switch role {
        case .assistant:
            return !groupToolCalls(blocks).isEmpty || summary != nil
        case .workflow:
            return workflow != nil
        case .limit:
            return limit != nil
        case .ask:
            return ask != nil
        case .capture:
            return capture != nil
        case .channel:
            return channel != nil
        case .message:
            return message != nil
        case .approval:
            return approval != nil
        case .workflowApproval:
            return wfApproval != nil
        case .user, .divider, .clear, .info, .goal, .monitor:
            // These rows carry their content themselves (bubble, divider, card) and are visible even with empty text.
            return true
        }
    }
}

// What carries something permanently visible itself is not grouped: todo lists stay, subagents get their own row.
// Subagent calls ALWAYS stand alone — even while no child event has arrived yet (background agent); in a summary row
// ("Ran 3 commands") the work of a whole run could no longer be found. Likewise `cbase_skill_write`: its block carries
// "Undo" or the request card (`SkillWriteCard`).
private func isGroupable(_ block: ChatBlock) -> Bool {
    guard block.kind == .tool, !isNativeTaskCall(block), !block.isAgentCall, !isSkillWrite(block.toolName) else { return false }
    return block.toolName != "TodoWrite"
}

func groupToolCalls(_ blocks: [ChatBlock]) -> [ChatDisplayItem] {
    var items: [ChatDisplayItem] = []
    var run: [ChatBlock] = []
    func flush() {
        if run.count >= 2 { items.append(.group(run)) }
        else { items.append(contentsOf: run.map { .single($0) }) }
        run = []
    }
    for block in blocks {
        // Invisible things do not interrupt a group: Task* calls live in the bar above the composer, empty text/thinking
        // blocks render nothing.
        if isNativeTaskCall(block) { continue }
        if block.kind == .text || block.kind == .thinking,
           block.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { continue }
        if isGroupable(block) { run.append(block); continue }
        flush()
        items.append(.single(block))
    }
    flush()
    return items
}

/// Press feedback of the expandable rows: NO label dimming. `.plain` fades the whole label out and in on a tap — since
/// the expanded height snaps (see ToolGroupView), that dimming was the only remaining motion on the header and read as
/// "the row remounts". Instead a calm surface sits behind the row while the finger holds it; the text itself never
/// moves a pixel.
struct ExpandRowPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(
                RoundedRectangle(cornerRadius: 7)
                    .fill(Color.primary.opacity(configuration.isPressed ? 0.08 : 0))
                    .padding(.horizontal, -6)
                    .padding(.vertical, -3)
            )
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

/// Summary row ("Ran 5 commands, created a file  +35 −0 ›") — for a group as for a single call. Neither dot nor spinner:
/// while something still runs, a band of light travels across the sentence (`ChatShimmer`), and the button carries the
/// value "running" for VoiceOver, which cannot see the band. An error shows next to a single call as "ERROR"; for
/// several calls the summary counts it ("(2 failed)"). The tap opens the sheet.
struct ToolGroupRow: View {
    let blocks: [ChatBlock]
    /// Deviating label (task list: the tool name instead of "Ran 1 command").
    var label: String?
    /// The turn is still running. A call without a result in an ENDED run is not "running" but open — and does not shimmer.
    var live: Bool = true
    @Environment(\.chatTimelineItemId) private var itemId

    private var summary: ToolSummary { toolSummary(blocks) }
    private var anyError: Bool { blocks.contains { $0.resultIsError } }
    /// The ONE computation (`HistoryState`, bound to the web) — not rebuilt here.
    private var running: Bool {
        HistoryState.groupRunning(blocks.map { (done: $0.done, error: $0.resultIsError) }, live: live)
    }

    /// The row's sentence. For a group with a failure the counter is RED — from two calls on there is no "ERROR" label
    /// any more, and without colour the failure was as grey as everything else in the row. ONE concatenated text, so the
    /// row keeps carrying the whole sentence as its label (the probe reads it).
    private var rowsText: Text {
        if let label { return Text(label) }
        guard let counter = summary.counter else { return Text(summary.text) }
        return Text(summary.base) + Text(" " + counter).foregroundStyle(.red) + Text(summary.postscript)
    }

    /// The same sentence, only the red counter visible — as a layer of its own ABOVE the band of light. The band is
    /// masked with the whole sentence and lightened the counter in its middle almost to white; on the web the red counter
    /// paints as an opaque child over the band, here this layer. Same text, same font, same proposal ⇒ same wrap, so the
    /// counter lies exactly on itself. `nil`: no counter, no layer.
    private var counterLevel: Text? {
        guard label == nil, let counter = summary.counter else { return nil }
        return Text(summary.base).foregroundStyle(.clear)
            + Text(" " + counter).foregroundStyle(.red)
            + Text(summary.postscript).foregroundStyle(.clear)
    }

    var body: some View {
        ChatDetailButton(identifier: "chat-tool-row", request: {
            ChatDetailRequest(kind: .tools, itemId: itemId, blocks: blocks, live: live)
        }) {
            HStack(spacing: 6) {
                rowsText
                    .chatFont(.subheadline)
                    // BEFORE the colour: under Reduce Motion the effect sets the sentence to `.primary`, and only an inner
                    // colour beats the outer one.
                    .chatShimmer(running)
                    .overlay(alignment: .topLeading) {
                        if running, let counterLevel {
                            counterLevel
                                .chatFont(.subheadline)
                                .allowsHitTesting(false)
                                .accessibilityHidden(true)
                        }
                    }
                    .foregroundStyle(.secondary)
                if summary.files {
                    Text(verbatim: "+\(summary.added)")
                        .chatFont(.subheadline, monospacedDigit: true)
                        .foregroundStyle(.green)
                    Text(verbatim: "-\(summary.removed)")
                        .chatFont(.subheadline, monospacedDigit: true)
                        .foregroundStyle(.red)
                }
                if anyError && blocks.count == 1 {
                    Text(L("ERROR"))
                        .chatFont(.caption2, weight: .bold)
                        .foregroundStyle(.red)
                }
                Image(systemName: "chevron.right")
                    .chatFont(.caption2, weight: .semibold)
                    .foregroundStyle(.secondary)
                Spacer(minLength: 0)
            }
        }
        // The only audible sign for "running": translated, not the identifier.
        .accessibilityValue(running ? L("running") : "")
        .padding(.vertical, 2)
    }
}

/// A single call: subagents have their own row (name, description, model, step count), the task list stays visible
/// under its row — everything else is a summary row with the count 1.
private struct ToolBlockRow: View {
    let block: ChatBlock
    /// The turn is still running — passed on to the summary and subagent rows.
    var live: Bool = true

    var body: some View {
        if block.isAgentCall {
            AgentRow(block: block, live: live)
        } else if isSkillWrite(block.toolName), let result = SkillWriteResult.from(
            result: block.result,
            action: block.input?["action"]?.stringValue,
            inputName: block.input?["name"]?.stringValue
        ) {
            // Under the row, what happened — with Undo or the request card.
            VStack(alignment: .leading, spacing: 6) {
                ToolGroupRow(blocks: [block], live: live)
                SkillWriteCard(result: result)
            }
            .padding(.vertical, 3)
        } else if let todos = toolTodos(block) {
            VStack(alignment: .leading, spacing: 6) {
                ToolGroupRow(blocks: [block], label: block.toolLabel, live: live)
                // At the edge like every row — the indent belonged to the icon column.
                TodoListView(todos: todos)
            }
            .padding(.vertical, 3)
        } else {
            ToolGroupRow(blocks: [block], live: live)
        }
    }
}

/// The MARK of a subagent in the timeline: the word "Subagent", the task, a state word, a chevron to the right. Nothing
/// more — no steps, no model badge, no disclosure. Everything about the subagent lives in the subagent sheet, and a tap
/// leads exactly there: it opens with this agent selected. Model and step count are shown in exactly one place — two
/// places for the same information are one too many, and in the timeline the subagent is only a pointer.
///
/// No dot: the state is a WORD after the task — "running" (pulsing), "stopped", red "Error", "no result"; a finished
/// subagent carries none. This row does NOT compute which: it reads the stage's map (`chatAgentStates`), in which
/// `ChatViewModel.agentStates` computed the state ONCE per agent — the same computation the subagent sheet takes its
/// words from. Only without a map does it compute itself, with `inStream: nil`.
private struct AgentRow: View {
    let block: ChatBlock
    /// The turn is still running — only the fallback without a map asks for it.
    var live: Bool = true
    @Environment(\.chatTimelineItemId) private var itemId
    @Environment(\.chatAgentPresenter) private var agentPresenter
    @Environment(\.chatDetailPresenter) private var detailPresenter
    @Environment(\.chatAgentStates) private var states
    @State private var local: ChatDetailRequest?

    /// The state of this subagent, `nil` = finished (no word). If the block is in the map the map decides; if the map is
    /// known but the block is not in it, it is not in the list (`inStream: false`); without a map nobody knows anything
    /// about the stream (`nil`).
    private var state: HistoryState.Agent? {
        if let states, let identifier = states[block.id] {
            return HistoryState.agentStates[identifier]   // "finished" is not in the table
        }
        return HistoryState.agent(
            error: block.resultIsError,
            rawStatus: block.agentReport?["status"]?.stringValue ?? "",
            done: block.done,
            inStream: states != nil ? false : nil,
            turnRunning: live
        )
    }

    /// The task as the main agent posed it. `description` would fall back to the tool name — and "Subagent · Subagent" is
    /// no information.
    private var job: String {
        if let text = block.input?["description"]?.stringValue, !text.isEmpty { return text }
        return block.detail
    }

    var body: some View {
        let z = state
        // Identifier ONLY on the button; it hangs on the TOOL, not on the presence of children: a subagent that has no or
        // no child call yet is still a subagent mark.
        Button {
            if let agentPresenter {
                agentPresenter(block.id)
                return
            }
            // Without a subagent sheet the old path remains: the ordinary call sheet. A mark that taps into the void would
            // be worse.
            let request = ChatDetailRequest(kind: .tools, itemId: itemId, blocks: [block], live: live)
            if let detailPresenter { detailPresenter(request) } else { local = request }
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(L("Subagent"))
                    .chatFont(.subheadline)
                    .foregroundStyle(.primary)
                    .fixedSize()
                if !job.isEmpty {
                    Text(job)
                        .chatFont(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                Spacer(minLength: 4)
                if let z {
                    // Own identity per state: a change (running → no result → running) restarts the pulse instead of
                    // hanging on a stale value.
                    Word(state: z).id(z.identifier)
                }
                Image(systemName: "chevron.right")
                    .chatFont(.caption2)
                    .foregroundStyle(.secondary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(ExpandRowPressStyle())
        // Audibly the word, translated — not the raw identifier (a hyphenated key would be read aloud with "minus"), and empty when finished. The visible
        // word is therefore removed from the tree.
        .accessibilityValue(z.map { L($0.word) } ?? "")
        .accessibilityIdentifier("chat-agent-row")
        .sheet(item: $local) { ChatDetailSheet(request: $0, model: nil).cbSheet(.small) }
        .padding(.vertical, 3)
    }

    /// The state word in capitals, colour from the tone of the ONE table. "running" pulses — in opacity, kicked off once in
    /// `.onAppear` like the spin of the run indicator, and not at all under Reduce Motion.
    private struct Word: View {
        let state: HistoryState.Agent
        @Environment(\.accessibilityReduceMotion) private var reduceMotion
        @State private var pulse = false

        // accent is the house tint (`.tint`, accent), like the hexagon of the run indicator.
        private var color: AnyShapeStyle {
            switch state.tone {
            case .accent: return AnyShapeStyle(.tint)
            case .dim: return AnyShapeStyle(.secondary)
            case .danger: return AnyShapeStyle(Color.red)
            }
        }

        var body: some View {
            Text(L(state.word).uppercased())
                .chatFont(.caption2, weight: .bold)
                .foregroundStyle(color)
                .fixedSize()
                .opacity(pulse ? 0.4 : 1)
                .animation(.easeInOut(duration: 1).repeatForever(autoreverses: true), value: pulse)
                .onAppear { if state.pulses && !reduceMotion { pulse = true } }
                .accessibilityHidden(true)
        }
    }
}

private func toolTodos(_ block: ChatBlock) -> [ToolTodo]? {
    guard block.toolName == "TodoWrite",
          let values = block.input?["todos"]?.arrayValue else { return nil }
    let items = values.compactMap { value -> ToolTodo? in
        guard let content = value["content"]?.stringValue, !content.isEmpty else { return nil }
        return ToolTodo(
            content: content,
            activeForm: value["activeForm"]?.stringValue,
            status: value["status"]?.stringValue ?? "pending"
        )
    }
    return items.isEmpty ? nil : items
}

private struct ToolTodo: Identifiable {
    let id = UUID()
    let content: String
    let activeForm: String?
    let status: String
}

// ── CLI task list (TaskCreate/TaskUpdate) ─────────────────────────
// The replaced `TodoWrite` carried the WHOLE list in one call; the Task* tools concern ONE task each, and their id only
// appears in the result ("Task #3 created successfully: …"). The list state therefore only arises from the sequence of
// ALL calls in the timeline. It is not shown in the timeline but in a fixed bar above the composer (as in the CLI) —
// inline the list moved one position on every check-off and flickered.
func isNativeTaskCall(_ block: ChatBlock) -> Bool {
    guard block.kind == .tool, let name = block.toolName else { return false }
    return (name == "TaskCreate" || name == "TaskUpdate") && !block.resultIsError
}

/// Current state of the CLI task list. The id is the CLI's ("1", "2", …) and stays the SAME across updates — otherwise
/// SwiftUI replaces every row on check-off (flicker).
func nativeTaskList(_ blocks: [ChatBlock]) -> [NativeTask] {
    var order: [String] = []                 // creation order, independent of the dictionary
    var tasks: [String: NativeTask] = [:]
    for (index, block) in blocks.enumerated() where isNativeTaskCall(block) {
        let input = block.input
        if block.toolName == "TaskCreate" {
            // Live the block arises BEFORE its result — the id is still missing and a placeholder per position keeps the
            // task in the list anyway.
            let id = block.result.flatMap(parsedTaskId) ?? "new-\(index)"
            if tasks[id] == nil { order.append(id) }
            tasks[id] = NativeTask(
                id: id,
                subject: input?["subject"]?.stringValue ?? "",
                activeForm: input?["activeForm"]?.stringValue,
                status: "pending"
            )
        } else {
            guard let id = input?["taskId"]?.stringValue, let previous = tasks[id] else { continue }
            let status = input?["status"]?.stringValue ?? previous.status
            if status == "deleted" {
                tasks[id] = nil
                order.removeAll { $0 == id }
            } else {
                tasks[id] = NativeTask(
                    id: id,
                    subject: input?["subject"]?.stringValue ?? previous.subject,
                    activeForm: input?["activeForm"]?.stringValue ?? previous.activeForm,
                    status: status
                )
            }
        }
    }
    return order.compactMap { tasks[$0] }
}

private func parsedTaskId(_ result: String) -> String? {
    guard let hash = result.firstIndex(of: "#") else { return nil }
    let digits = result[result.index(after: hash)...].prefix(while: \.isNumber)
    return digits.isEmpty ? nil : String(digits)
}

/// Fixed bar above the composer while the list is RELEVANT — i.e. at least one item is open; once all are done it
/// disappears (as in the CLI). The OPEN items are shown, the finished ones only as a count: otherwise they would crowd
/// out the actual work in long lists. NO `chatFont` in here, on purpose: this bar sits in the `ChatComposer`
/// (ChatView.swift), not in the timeline — the environment factor never reaches it, and `chatFont` would read as a
/// promise of scaling that does not exist here. The conversation's frame stays fixed.
struct NativeTaskBar: View {
    let tasks: [NativeTask]
    private static let shownLimit = 3   // no more fits above the keyboard

    private var open: [NativeTask] { tasks.filter { $0.status != "completed" } }

    var body: some View {
        if !open.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(L("Agent's tasks"))
                        .font(.caption2.weight(.semibold))
                        .textCase(.uppercase)
                        .foregroundStyle(.secondary)
                    if open.count < tasks.count {
                        Text(L("{done} of {all} done",
                               ["done": tasks.count - open.count, "all": tasks.count]))
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
                ForEach(open.prefix(Self.shownLimit)) { task in
                    HStack(alignment: .top, spacing: 7) {
                        let active = task.status == "in_progress"
                        RoundedRectangle(cornerRadius: 4)
                            .strokeBorder(active ? Color.accentColor : Color.secondary.opacity(0.45), lineWidth: 1)
                            .frame(width: 14, height: 14)
                            .overlay {
                                if active {
                                    Circle().fill(Color.accentColor).frame(width: 6, height: 6)
                                }
                            }
                            .padding(.top, 1)
                        Text(task.status == "in_progress" ? (task.activeForm ?? task.subject) : task.subject)
                            .font(.caption)
                            .fontWeight(task.status == "in_progress" ? .medium : .regular)
                            .lineLimit(1)
                    }
                }
                if open.count > Self.shownLimit {
                    Text(L("+{n} more", ["n": open.count - Self.shownLimit]))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            // With glass like the island below — glass of its own, not in its group: it sits at a distance above and must not
            // merge with it.
            .cbGlass(RoundedRectangle(cornerRadius: 12, style: .continuous)) {
                RoundedRectangle(cornerRadius: 9).fill(CbColor.elevated)
            }
            .accessibilityIdentifier("native-task-bar")
        }
    }
}

private struct TodoListView: View {
    let todos: [ToolTodo]

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(todos) { todo in
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: symbol(for: todo))
                        .foregroundStyle(color(for: todo))
                        .frame(width: 15)
                    Text(todo.status == "in_progress"
                        ? (todo.activeForm?.isEmpty == false ? todo.activeForm! : todo.content)
                        : todo.content)
                        .strikethrough(todo.status == "completed")
                        .foregroundStyle(todo.status == "completed" ? Color.secondary : Color.primary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .chatFont(.caption)
            }
        }
        .padding(9)
        .background(CbColor.elevated, in: RoundedRectangle(cornerRadius: 9))
    }

    private func symbol(for todo: ToolTodo) -> String {
        todo.status == "completed"
            ? "checkmark.square.fill"
            : todo.status == "in_progress" ? "circle.inset.filled" : "square"
    }

    private func color(for todo: ToolTodo) -> Color {
        todo.status == "completed"
            ? .green
            : todo.status == "in_progress" ? .accentColor : .secondary
    }
}

struct DiffLine: Identifiable {
    let id = UUID()
    let sign: Character
    let text: String
}

/// NO `chatFont` in here: the only call site is `ChatDetailSheet` ("Changes"), and sheets are explicitly exempt from the
/// text size — on the web this content sits IN the timeline, on mobile it is a sheet. Whoever wants to change that moves
/// the whole sheet; until then the code claims no scaling that would never happen for lack of an environment factor.
struct DiffView: View {
    let lines: [DiffLine]

    var body: some View {
        ScrollView(.horizontal) {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(lines.prefix(300)) { line in
                    HStack(spacing: 6) {
                        Text(String(line.sign))
                            .frame(width: 9)
                        Text(line.text.isEmpty ? " " : line.text)
                    }
                    .font(.system(.caption2, design: .monospaced))
                    .foregroundStyle(line.sign == "+" ? Color.green : Color.red)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 1)
                    .background((line.sign == "+" ? Color.green : Color.red).opacity(0.09))
                }
            }
        }
        // Horizontal scroll views in timeline rows need the vertical ideal height, otherwise the cell (UIHostingConfiguration)
        // measures a different height than it renders.
        .fixedSize(horizontal: false, vertical: true)
        .background(CbColor.elevated, in: RoundedRectangle(cornerRadius: 9))
    }
}
