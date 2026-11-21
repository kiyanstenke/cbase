import SwiftUI

// ── Thinking process and tool calls: from below, not in the history ─────────
//
// Thinking blocks and tool calls do not expand IN their history row. In the
// inverted list that is the most expensive movement of all: every height change moves the
// cell frames of the whole list, and the top-edge pin (`chatRowExpansionWillChange`)
// was a chapter of its own. So the history carries only calm rows
// ("Ran 8 commands ›", "Thinking process ›"), and the content comes as a sheet from
// below — as in the Claude app: a timeline of the calls, behind each call a page
// with command, changes and result. The history row never changes a pixel.
//
// Presented OUTSIDE the inverted list: the cells (UIHostingConfiguration)
// have no hosting controller in the responder chain, a `.sheet` there would go nowhere.
// The way is the same as for the image viewer — an environment value (`chatDetailPresenter`) that
// the stage sets per cell and the chat's root view serves. Outside the stage
// (plain ScrollView) it is missing, and the row presents itself.

/// What opens from a history row: the thinking process or the calls of a row.
struct ChatDetailRequest: Identifiable {
    enum Kind { case thinking, tools }
    let kind: Kind
    /// Row in the history — the sheet resolves the LIVE state by it: results arriving after
    /// the tap appear in the open sheet.
    let itemId: String
    let blockIds: [String]
    /// State at the tap — the fallback when the row can no longer be found in the model,
    /// for instance after the reconciliation at run end, which creates blocks under new identifiers.
    let snapshot: [ChatBlock]
    /// The row's turn is still running (state at the tap). A call without a result only then means
    /// "Running…"; in an ended run it is OPEN — the row says so (`ToolGroupRow`),
    /// and the sheet must give the same answer. With a model `LiveStatus` keeps reading along.
    let live: Bool

    var id: String { itemId + "|" + blockIds.joined(separator: ",") }

    init(kind: Kind, itemId: String, blocks: [ChatBlock], live: Bool) {
        self.kind = kind
        self.itemId = itemId
        self.blockIds = blocks.map(\.id)
        self.snapshot = blocks
        self.live = live
    }
}

struct ChatDetailPresenterKey: EnvironmentKey {
    static let defaultValue: ((ChatDetailRequest) -> Void)? = nil
}

/// Opens the subagent sheet and selects the agent of the tapped call in it
/// (argument: the call's block id; empty = just open). The button in the chat header takes the
/// same way. If it is missing, the marker in the
/// history falls back to the ordinary call sheet — it must not tap into the void.
struct ChatAgentPresenterKey: EnvironmentKey {
    static let defaultValue: ((String) -> Void)? = nil
}

/// The state of every subagent of this chat, computed ONCE (`ChatViewModel.agentStates`):
/// block id of the call → identifier from
/// `HistoryState.agentStates` or `"fertig"`. The marker in the history reads it here, the
/// subagent sheet the same computation via `SubagentEntry.state` — so both say the same.
/// `nil` means "there is no list" (outside the stage): then the
/// marker computes itself, with `inStream: nil`. Empty is not unknown — an empty dictionary means
/// "there is a list, and this call is not in it".
struct ChatAgentStatesKey: EnvironmentKey {
    static let defaultValue: [String: String]? = nil
}

/// Identifier of the history row in which a cell is currently drawing — so that a tap knows in
/// which row the sheet should later look up the live state.
struct ChatTimelineItemIdKey: EnvironmentKey {
    static let defaultValue = ""
}

extension EnvironmentValues {
    var chatDetailPresenter: ((ChatDetailRequest) -> Void)? {
        get { self[ChatDetailPresenterKey.self] }
        set { self[ChatDetailPresenterKey.self] = newValue }
    }
    var chatTimelineItemId: String {
        get { self[ChatTimelineItemIdKey.self] }
        set { self[ChatTimelineItemIdKey.self] = newValue }
    }
    var chatAgentPresenter: ((String) -> Void)? {
        get { self[ChatAgentPresenterKey.self] }
        set { self[ChatAgentPresenterKey.self] = newValue }
    }
    var chatAgentStates: [String: String]? {
        get { self[ChatAgentStatesKey.self] }
        set { self[ChatAgentStatesKey.self] = newValue }
    }
}

/// Button of a history row that opens a sheet — via the stage if it offers a
/// presentation, otherwise itself. Press feedback without dimming
/// (`ExpandRowPressStyle`): the row's text does not change a pixel on tap.
struct ChatDetailButton<Label: View>: View {
    let identifier: String
    let request: () -> ChatDetailRequest
    @ViewBuilder let label: () -> Label
    @Environment(\.chatDetailPresenter) private var presenter
    @State private var local: ChatDetailRequest?

    var body: some View {
        Button {
            let request = request()
            if let presenter { presenter(request) } else { local = request }
        } label: {
            label().contentShape(Rectangle())
        }
        .buttonStyle(ExpandRowPressStyle())
        .accessibilityIdentifier(identifier)
        .sheet(item: $local) { ChatDetailSheet(request: $0, model: nil).cbSheet(.small) }
    }
}

// ── Summary of a tool row ─────────────────────────────────────────

/// "Ran 15 commands, created one file  +35 −0" — counted as in the Claude app:
/// every call is a command, files are counted by created/edited, and the
/// line balance comes from the inputs of the write tools.
struct ToolSummary {
    /// The whole sentence — sheet title and row label.
    let text: String
    /// The sentence in pieces, so the row can set the counter red without changing the
    /// sentence (verbatim with `tool-summary.ts` on the web): `base` ("Ran 5 commands"),
    /// `counter` ("(1 failed)" or nil) and `postscript` (", created one file" or
    /// empty). The counter stands in the MIDDLE, not at the end.
    let base: String
    let counter: String?
    let postscript: String
    let added: Int
    let removed: Int
    /// At least one write tool involved — then the balance stands at the row, even "−0".
    let files: Bool
    /// Calls with an error result. From two calls on the text counts them
    /// ("(2 failed)"); for a single one the row's "ERROR" marker says it.
    let error: Int
}

func toolSummary(_ blocks: [ChatBlock]) -> ToolSummary {
    let error = blocks.filter(\.resultIsError).count
    let base = blocks.count == 1 ? L("Ran 1 command") : L("Ran {n} commands", ["n": blocks.count])
    let counter: String? = blocks.count > 1 && error > 0 ? L("({k} failed)", ["k": error]) : nil
    var parts: [String] = []
    var created = 0, edited = 0, added = 0, removed = 0
    for block in blocks {
        switch block.toolName ?? "" {
        case "Write": created += 1
        case "Edit", "MultiEdit", "NotebookEdit", "apply_patch": edited += 1
        default: break
        }
        for line in block.diffLines ?? [] {
            if line.sign == "+" { added += 1 } else if line.sign == "-" { removed += 1 }
        }
    }
    if created == 1 { parts.append(L("created one file")) }
    else if created > 1 { parts.append(L("created {n} files", ["n": created])) }
    if edited == 1 { parts.append(L("edited one file")) }
    else if edited > 1 { parts.append(L("Edited {n} files", ["n": edited])) }
    let postscript = parts.map { ", " + $0 }.joined()
    return ToolSummary(
        text: base + (counter.map { " " + $0 } ?? "") + postscript,
        base: base, counter: counter, postscript: postscript,
        added: added, removed: removed,
        files: created + edited > 0,
        error: error
    )
}

/// Search a block with its children — the sheet resolves identifiers from the history, and
/// the child calls of a subagent sit one level deeper.
func findChatBlock(_ id: String, in blocks: [ChatBlock]) -> ChatBlock? {
    for block in blocks {
        if block.id == id { return block }
        if let hits = findChatBlock(id, in: block.children) { return hits }
    }
    return nil
}

extension ChatBlock {
    /// Subagent tools; a provider without its own tool betrays itself by child calls.
    static let agentToolNames: Set<String> = ["Task", "Agent", "mcp__cbase__cbase_agent"]

    var isAgentCall: Bool {
        Self.agentToolNames.contains(toolName ?? "") || !children.isEmpty
    }

    /// Raw tool name for the sheet title ("Bash", "Read"); MCP tools without prefix.
    var toolTitle: String {
        let name = toolName ?? "Tool"
        if name.hasPrefix("mcp__") {
            return name.split(separator: "__").last.map(String.init) ?? name
        }
        return name
    }

    /// Speaking name for the history row of a subagent or the task list.
    var toolLabel: String {
        let name = toolName ?? "Tool"
        let known: [String: String] = [
            "Bash": L("Run command"),
            "Read": L("Read file"),
            "Write": L("Write file"),
            "Edit": L("Edit file"),
            "MultiEdit": L("Edit files"),
            "apply_patch": L("Change files"),
            "Glob": L("Find files"),
            "Grep": L("Search text"),
            "Task": L("Subagent"),
            "Agent": L("Subagent"),
            "mcp__cbase__cbase_agent": L("Subagent"),
            "TodoWrite": L("Update tasks"),
            "TaskCreate": L("Create task"),
            "TaskUpdate": L("Update task"),
            "TaskList": L("List tasks"),
            "TaskGet": L("View task")
        ]
        return known[name] ?? toolTitle
    }

    /// Subtitle of a call: the tool's description (Claude gives Bash and
    /// subagents one), otherwise the detail (command, path, pattern), otherwise the name.
    var description: String {
        if let text = input?["description"]?.stringValue, !text.isEmpty { return text }
        if !detail.isEmpty { return detail }
        return toolLabel
    }

    /// Symbol per tool kind in the sheet's timeline.
    var symbolName: String {
        if isAgentCall { return "person.2" }
        switch toolName ?? "" {
        case "Bash": return "chevron.left.forwardslash.chevron.right"
        case "Read": return "doc.text"
        case "Write": return "doc.badge.plus"
        case "Edit", "MultiEdit", "NotebookEdit", "apply_patch": return "square.and.pencil"
        case "Glob", "Grep": return "magnifyingglass"
        case "WebFetch", "WebSearch": return "globe"
        case "TodoWrite", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet": return "checklist"
        default: return "wrench.and.screwdriver"
        }
    }

    /// Which model works in this subagent? The REPORT names the resolved model
    /// (even in the state "running"), the call itself only the main agent's wish.
    var agentModel: String {
        guard isAgentCall else { return "" }
        if let report = agentReport {
            let model = report["resolvedModel"]?.stringValue ?? ""
            let provider = report["provider"]?.stringValue ?? ""
            if !model.isEmpty, !model.hasPrefix("(") {
                return provider.isEmpty ? model : "\(provider)::\(model)"
            }
            if !provider.isEmpty { return provider }
        }
        return input?["model"]?.stringValue ?? ""
    }

    /// The report of a subagent comes as JSON in the result.
    var agentReport: JSONValue? {
        guard isAgentCall, let result, let data = result.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(JSONValue.self, from: data)
    }

    /// Child calls of a subagent without the empty text/thinking blocks — they draw nothing
    /// and must not inflate the count on the history row.
    var visibleChildren: [ChatBlock] {
        children.filter { child in
            if child.kind == .text || child.kind == .thinking {
                return !child.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            }
            return true
        }
    }

    var diffLines: [DiffLine]? {
        guard let input else { return nil }
        let name = toolName ?? ""
        var lines: [DiffLine] = []
        func append(_ sign: Character, _ text: String) {
            for line in text.components(separatedBy: "\n") {
                lines.append(DiffLine(sign: sign, text: line))
            }
        }
        if name == "Write", let content = input["content"]?.stringValue {
            append("+", content)
        } else if name == "Edit", let old = input["old_string"]?.stringValue {
            append("-", old)
            if let new = input["new_string"]?.stringValue { append("+", new) }
        } else if name == "MultiEdit", let edits = input["edits"]?.arrayValue {
            for edit in edits {
                if let old = edit["old_string"]?.stringValue { append("-", old) }
                if let new = edit["new_string"]?.stringValue { append("+", new) }
            }
        } else if name == "apply_patch", let changes = input["changes"]?.arrayValue {
            // Codex delivers {path, kind} — depending on the CLI version additionally the unified diff.
            for change in changes {
                let kind = change["kind"]?.stringValue ?? "update"
                let path = change["path"]?.stringValue ?? ""
                let patch = change["diff"]?.stringValue ?? change["unified_diff"]?.stringValue
                if let patch, !patch.isEmpty {
                    append(" ", "\(kind) \(path)")
                    for line in patch.components(separatedBy: "\n") {
                        let sign: Character = line.hasPrefix("+") && !line.hasPrefix("+++") ? "+"
                            : (line.hasPrefix("-") && !line.hasPrefix("---") ? "-" : " ")
                        lines.append(DiffLine(sign: sign, text: line))
                    }
                } else {
                    append(kind == "delete" ? "-" : (kind == "add" ? "+" : " "), "\(kind) \(path)")
                }
            }
        }
        return lines.isEmpty ? nil : lines
    }
}

// ── The sheet ───────────────────────────────────────────────────────────────

struct ChatDetailSheet: View {
    let request: ChatDetailRequest
    /// With a model the sheet follows the live state; without (row outside the stage)
    /// it shows the state at the tap.
    let model: ChatViewModel?
    // The text size arrives as a trait on the window and reaches the sheet by itself (Kit/TextSize.swift) —
    // a sheet does not inherit the stage's environment.

    var body: some View {
        Group {
            if let model {
                LiveStatus(request: request, model: model)
                    .environment(\.chatRowFull, { row in await model.resolveTruncation(row: row) })
            } else {
                ChatDetailContent(request: request, blocks: request.snapshot, live: request.live)
            }
        }
        // Half height, and ONLY that (`cbSheet(.klein)` at every place that shows it): the sheet should not cover
        // the chat behind it. Long
        // results scroll inside the sheet.
    }
}

private struct LiveStatus: View {
    let request: ChatDetailRequest
    @ObservedObject var model: ChatViewModel

    var body: some View {
        ChatDetailContent(request: request, blocks: current, live: live)
    }

    /// How the row computes (`live` in ChatView): the streaming row itself, otherwise the state
    /// measured at the tap — and that only while the run is still going. If it ends with the sheet
    /// open, the spinner stops instead of turning forever.
    private var live: Bool {
        let item = model.timeline.first(where: { $0.id == request.itemId })
        return item?.streaming == true || (model.busy && request.live)
    }

    private var current: [ChatBlock] {
        guard let item = model.timeline.first(where: { $0.id == request.itemId }) else { return request.snapshot }
        let found = request.blockIds.compactMap { findChatBlock($0, in: item.blocks) }
        return found.count == request.blockIds.count ? found : request.snapshot
    }
}

private struct ChatDetailContent: View {
    let request: ChatDetailRequest
    let blocks: [ChatBlock]
    let live: Bool

    var body: some View {
        NavigationStack {
            root
                // Every timeline entry pushes its page; the identifier is resolved against the
                // CURRENT state, not the one at the tap.
                .navigationDestination(for: String.self) { id in
                    if let block = findChatBlock(id, in: blocks) {
                        BlockPage(block: block, root: false, live: live)
                    } else {
                        Text(L("This call is no longer available"))
                            .foregroundStyle(.secondary)
                            .modifier(SheetHeader(title: "", root: false))
                    }
                }
        }
    }

    @ViewBuilder private var root: some View {
        switch request.kind {
        case .thinking:
            ThinkingProcessPage(text: blocks.first?.text ?? "", root: true)
        case .tools:
            // ONE call: its page is the root — the detour via a list with one
            // entry would be a tap for nothing.
            if blocks.count == 1, let block = blocks.first {
                BlockPage(block: block, root: true, live: live)
            } else {
                CallListPage(blocks: blocks, root: true, live: live)
            }
        }
    }
}

private struct BlockPage: View {
    let block: ChatBlock
    let root: Bool
    let live: Bool

    var body: some View {
        switch block.kind {
        case .thinking: ThinkingProcessPage(text: block.text, root: root)
        case .tool: ToolPage(block: block, root: root, live: live)
        case .text, .error: TextPage(text: block.text, root: root)
        }
    }
}

/// Head of every page in the sheet: title in the middle, left ✕ (root: closes the sheet, `SheetClose` like every sheet of the
/// header) or ‹ (pushed page: back). Both are `dismiss` — SwiftUI resolves it per level.
private struct SheetHeader: ViewModifier {
    let title: String
    let root: Bool
    @Environment(\.dismiss) private var dismiss

    func body(content: Content) -> some View {
        content
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .navigationBarBackButtonHidden(true)
            .toolbar {
                if root {
                    SheetClose(identifier: "chat-detail-close") { dismiss() }
                } else {
                    ToolbarItem(placement: .topBarLeading) {
                        Button { dismiss() } label: { Image(systemName: "chevron.left") }
                            .accessibilityLabel(L("Back"))
                            .accessibilityIdentifier("chat-detail-back")
                    }
                }
            }
    }
}

// ── Seiten ───────────────────────────────────────────────────────────────────────

private struct ThinkingProcessPage: View {
    let text: String
    let root: Bool

    var body: some View {
        ScrollView {
            Text(text)
                .chatFont(.body)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16)
        }
        .modifier(SheetHeader(title: L("Thinking"), root: root))
    }
}

private struct TextPage: View {
    let text: String
    let root: Bool

    var body: some View {
        ScrollView {
            MarkdownView(source: text)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16)
        }
        .modifier(SheetHeader(title: L("Text"), root: root))
    }
}

private struct CallListPage: View {
    let blocks: [ChatBlock]
    let root: Bool
    let live: Bool

    var body: some View {
        ScrollView {
            CallTimeline(blocks: blocks, live: live)
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
        }
        .modifier(SheetHeader(title: toolSummary(blocks).text, root: root))
    }
}

/// The vertical timeline: per call symbol, state and description, the symbols connected by
/// a line. Intermediate texts and thinking blocks of a subagent are entries of their own.
struct CallTimeline: View { // internal for Chat/DynWorkflowTree.swift (the transcript of a workflow agent)
    let blocks: [ChatBlock]
    let live: Bool

    private var visible: [ChatBlock] {
        blocks.filter { block in
            if block.kind == .text || block.kind == .thinking {
                return !block.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            }
            return true
        }
    }

    var body: some View {
        let entries = visible
        LazyVStack(spacing: 0) {
            ForEach(Array(entries.enumerated()), id: \.element.id) { index, block in
                NavigationLink(value: block.id) {
                    CallEntry(block: block, first: index == 0, last: index == entries.count - 1, live: live)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("chat-detail-entry")
            }
        }
    }
}

private struct CallEntry: View {
    let block: ChatBlock
    let first: Bool
    let last: Bool
    let live: Bool

    private var line: Color { Color.secondary.opacity(0.3) }

    /// No result and no run any more (abort, restart) — gray as in the row above,
    /// not "Running…" with a spinner.
    private var open: Bool { block.kind == .tool && !block.done && !block.resultIsError && !live }

    private var state: String {
        // A message to a workflow agent: sender and state instead of "Text".
        if let n = block.message {
            let word = AgentMessageWord.state(n.state)
            return word.isEmpty ? AgentMessageWord.sender(n.from) : "\(AgentMessageWord.sender(n.from)) · \(word)"
        }
        switch block.kind {
        case .thinking: return L("Thinking")
        case .text, .error: return L("Text")
        case .tool:
            if block.resultIsError { return L("Failed") }
            if !block.done { return live ? L("Running") + "…" : L("Open##state") }
            return L("Done")
        }
    }

    private var subtitle: String {
        switch block.kind {
        case .tool: return block.description
        default:
            let first = block.text.split(separator: "\n", maxSplits: 1).first.map(String.init) ?? ""
            return String(first.prefix(140))
        }
    }

    /// What did not arrive stands muted (the reason is in the block's text).
    private var notDelivered: Bool { block.message?.state == "not_delivered" }

    private var symbolColor: Color {
        if notDelivered { return .secondary }
        if block.kind == .tool, block.resultIsError { return .red }
        if block.kind == .tool, !block.done { return .secondary }
        return .primary
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            // Line at the top to the symbol middle (9 pt padding + half symbol), below it to the
            // row end; the symbol covers the line with the page background.
            ZStack(alignment: .top) {
                VStack(spacing: 0) {
                    Rectangle().fill(line).frame(width: 1, height: 22).opacity(first ? 0 : 1)
                    Rectangle().fill(line).frame(width: 1).frame(maxHeight: .infinity).opacity(last ? 0 : 1)
                }
                Image(systemName: block.message != nil ? "bubble.left" : block.kind == .thinking ? "clock" : (block.kind == .tool ? block.symbolName : "text.alignleft"))
                    .font(.symbol(12, weight: .medium))
                    .foregroundStyle(symbolColor)
                    .frame(width: 26, height: 26)
                    .background(.cbElevated, in: Circle())
                    .background(.cbBase, in: Circle())
                    .padding(.top, 9)
            }
            .frame(width: 26)
            VStack(alignment: .leading, spacing: 2) {
                Text(state)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(block.resultIsError ? Color.red : (open || notDelivered ? Color.secondary : Color.primary))
                Text(subtitle)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            .padding(.vertical, 10)
            Spacer(minLength: 0)
        }
        .contentShape(Rectangle())
    }
}

/// The page of a tool call: description, the main input ("Command", "File",
/// "Pattern" …) as a code block, changes as a diff, other fields, the result — and for
/// a subagent report and steps (another timeline, every step pushable).
private struct ToolPage: View {
    let block: ChatBlock
    let root: Bool
    /// The turn is still running — only then is a call without a result "Running…"; otherwise it is open.
    let live: Bool
    /// Load a result truncated in the window without truncation (`ChatEnvironment.swift`, `ChatViewModel+Window.swift`).
    @Environment(\.chatRowFull) private var rowFull
    @State private var loadingFull = false

    /// Which field of the input is the point — a different one per tool.
    private var mainField: (key: String, label: String)? {
        switch block.toolName ?? "" {
        case "Bash": return ("command", L("Command"))
        case "Read", "Write", "Edit", "MultiEdit": return ("file_path", L("File"))
        case "NotebookEdit": return ("notebook_path", L("File"))
        case "Glob", "Grep": return ("pattern", L("Pattern"))
        case "WebFetch": return ("url", "URL")
        case "WebSearch": return ("query", L("Search"))
        case "Task", "Agent", "mcp__cbase__cbase_agent": return ("prompt", L("Brief"))
        default: return nil
        }
    }

    private var mainInput: (label: String, text: String)? {
        guard let field = mainField, let text = block.input?[field.key]?.stringValue, !text.isEmpty else { return nil }
        return (field.label, text)
    }

    /// Everything from the input not yet shown above: description, main input and the
    /// fields the diff already shows drop out. If nothing remains, there is no section.
    private var additionalDetails: String? {
        guard let input = block.input else { return nil }
        guard var rest = input.objectValue else { return input.prettyPrinted }
        var consumed: Set<String> = ["description"]
        if let field = mainField, mainInput != nil { consumed.insert(field.key) }
        if block.diffLines != nil { consumed.formUnion(["content", "old_string", "new_string", "edits", "changes"]) }
        for key in consumed { rest.removeValue(forKey: key) }
        guard !rest.isEmpty else { return nil }
        return JSONValue.object(rest).prettyPrinted
    }

    private var description: String {
        block.input?["description"]?.stringValue ?? ""
    }

    private var report: String? {
        guard block.isAgentCall, let result = block.result, !result.isEmpty else { return nil }
        if let report = block.agentReport?["report"]?.stringValue, !report.isEmpty { return report }
        return result
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                if !description.isEmpty || !block.agentModel.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        if !description.isEmpty {
                            Text(description)
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                        if !block.agentModel.isEmpty {
                            Text(block.agentModel)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                                .padding(.horizontal, 5)
                                .padding(.vertical, 1)
                                .overlay(RoundedRectangle(cornerRadius: 5).stroke(Color.secondary.opacity(0.3), lineWidth: 1))
                        }
                    }
                }
                if let main = mainInput {
                    LabeledSection(main.label) { CodeBlock(text: main.text) }
                }
                if let lines = block.diffLines {
                    LabeledSection(L("Changes")) { DiffView(lines: lines) }
                }
                if let rest = additionalDetails {
                    LabeledSection(L("Input")) { CodeBlock(text: rest) }
                }
                if let report {
                    LabeledSection(L("Report")) {
                        MarkdownView(source: report)
                            .padding(10)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(.cbElevated, in: RoundedRectangle(cornerRadius: 10))
                    }
                } else if let result = block.result, !result.isEmpty {
                    LabeledSection(block.resultIsError ? L("Error") : L("Result")) {
                        CodeBlock(text: String(result.prefix(40_000)), error: block.resultIsError)
                        if let row = block.truncated, let rowFull {
                            Button {
                                loadingFull = true
                                Task { await rowFull(row); loadingFull = false }
                            } label: {
                                if loadingFull { ProgressView().controlSize(.small) } else { Text(L("Truncated — load all")).font(.subheadline) }
                            }
                            .disabled(loadingFull)
                            .accessibilityIdentifier("tool-result-full")
                        }
                    }
                } else if !block.done, live {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text(L("Running") + "…")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                } else if !block.done {
                    // No result, but the run is over (abort, restart): open — a
                    // spinner here would turn forever while the row above stands still.
                    Text(L("Open##state"))
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                if !block.visibleChildren.isEmpty {
                    LabeledSection(L("Steps")) { CallTimeline(blocks: block.children, live: live) }
                }
            }
            .padding(16)
        }
        // Raw tool name as title (Bash, Read); the subagent is called Subagent — its
        // tool name (`cbase_agent`) is construction, not information.
        .modifier(SheetHeader(title: block.isAgentCall ? block.toolLabel : block.toolTitle, root: root))
    }
}

struct LabeledSection<Content: View>: View { // internal for Chat/DynWorkflowTree.swift
    let label: String
    @ViewBuilder let content: () -> Content

    init(_ label: String, @ViewBuilder content: @escaping () -> Content) {
        self.label = label
        self.content = content
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
            content()
        }
    }
}

/// Code block that WRAPS instead of scrolling horizontally: on the sheet there is no cell
/// whose self-sizing a horizontal ScrollView could confuse, and a command reads
/// better wrapped than cut off.
private struct CodeBlock: View {
    let text: String
    var error = false

    var body: some View {
        Text(text)
            .font(.system(.caption, design: .monospaced))
            .foregroundStyle(error ? Color.red : Color.primary.opacity(0.9))
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(10)
            .background(.cbElevated, in: RoundedRectangle(cornerRadius: 10))
    }
}

// ── The subagent sheet ──────────────────────────────────────────────────────
//
// The ONE place for subagents. The history keeps a slim marker (`AgentRow`) — whoever taps it lands
// here at exactly this agent.
//
// Shown are RUNNING (event stream) and FINISHED (from this chat's history) agents,
// merged in `ChatViewModel.subagents`, and in the coding chat the dynamic workflows.
//
// ONE list "Background Tasks": subagents and workflow runs are not distinguished, every entry is ONE card in the
// form of the workflow card, 6 pt apart, newest on top (Chat/BackgroundTasks.swift). The main run is not
// shown. The sheet's title is "Agents", like the tab on the web.
//
// HIG instead of the web model: no glass, surfaces and hairlines from `CbKit`, and ONE
// navigation level per place — choosing an agent SWAPS the sheet's page, it does not push
// a second one above it. Only the steps below lead (as in the call sheet) to the page
// of a single tool call.
/// The request to the subagent sheet. A type of its own so that `.sheet(item:)` RECEIVES the
/// selection: with `.sheet(isPresented:)` SwiftUI built the content from a stale state
/// of the view — the block id was still empty there, and a tap on the marker in the history
/// opened the overview instead of this agent's page.
struct SubagentsRequest: Identifiable {
    /// Block id of the tapped call; empty = open with the list (header button).
    let selection: String
    /// A workflow agent instead of a subagent (the jump "Agent in chat", Chat/AgentJump.swift): its row in the tree.
    var wf: DynTreeSelection? = nil
    var id: String { wf.map { "\(selection)|\($0.runId)#\($0.n)" } ?? selection }
}

struct SubagentsSheet: View {
    @ObservedObject var model: ChatViewModel
    /// Block id of the tapped call; empty = open with the list.
    var initialSelection: String = ""
    /// A workflow agent with which the sheet opens (the jump "Agent in chat") — `nil` = none.
    var initialWf: DynTreeSelection? = nil
    /// "Open" on the card of a graph workflow in the background: the id of its child chat. The
    /// root closes this sheet and then shows the chat; `nil` = no Open.
    var onOpenChat: ((String) -> Void)? = nil
    @Environment(\.dismiss) private var dismiss
    /// Selected agent — as entry id AND as block id. Two identifiers, because the first
    /// changes on finishing: a running agent comes from the stream, the same agent a
    /// second later from the history. Without the second the open page would fall
    /// back to the list at that moment.
    @State private var selectionId: String?
    @State private var selectionBlock: String?
    /// Selected workflow agent (Chat/DynWorkflowTree.swift) — run and number of its agent() call.
    @State private var wfSelection: DynTreeSelection?
    @State private var stepsOn = false
    @State private var stopQuestion: SubagentEntry?
    @State private var allQuestion = false
    /// The sheet "Message" to a living subagent (Chat/AgentMessage.swift).
    @State private var message: AgentMessageTarget?
    /// "Finished" collapsed — per sheet, not remembered.
    @State private var endedClosed = false
    /// One-second tick for runtime and pace — only while something is running.
    @State private var now = Date()
    @State private var wakeupStops = false // the stop of the wakeup card is running

    /// The list is computed ONCE per render and then passed along. It unpacks the report
    /// of every call (JSON in the result) — and the one-second runtime tick re-evaluates the body
    /// every second. Four accesses per render would be four rounds of that work.
    var body: some View {
        content(model.subagents)
    }

    private func selected(_ list: [SubagentEntry]) -> SubagentEntry? {
        if let selectionId, let hits = list.first(where: { $0.id == selectionId }) { return hits }
        if let selectionBlock, let hits = list.first(where: { $0.blockId == selectionBlock }) { return hits }
        return nil
    }

    @ViewBuilder private func content(_ list: [SubagentEntry]) -> some View {
        let wf = wfSelected()
        let active = wf == nil ? selected(list) : nil
        let running = list.filter(\.running)
        NavigationStack {
            Group {
                if let wf {
                    DynWorkflowAgentPage(model: model, run: wf.run, row: wf.row)
                } else if let entry = active {
                    agentPage(entry)
                } else {
                    overview(list, running: running)
                }
            }
            .navigationTitle(wf != nil ? L("Workflow agent") : active == nil ? L("Background tasks") : L("Subagent"))
            .navigationBarTitleDisplayMode(.inline)
            .navigationBarBackButtonHidden(true)
            .toolbar {
                // Top left the ✕ of every header sheet (`SheetClose`); on an agent's page
                // the way back to the overview as ‹.
                if active == nil && wf == nil {
                    SheetClose(identifier: "chat-agents-close") { dismiss() }
                } else {
                    ToolbarItem(placement: .topBarLeading) {
                        Button { select(nil) } label: { Image(systemName: "chevron.left") }
                            .accessibilityLabel(L("Background tasks"))
                            .accessibilityIdentifier("chat-agents-back")
                    }
                }
            }
            // The steps of an agent lead to the page of their call — the same page
            // as in the call sheet, resolved against the CURRENT state.
            // For the workflow agent these are the blocks of its transcript (the same page kind).
            // "Open log" on the card of a monitor (Chat/ChatMonitors.swift).
            .navigationDestination(for: MonitorLogTarget.self) { target in MonitorLogPage(model: model, target: target) }
            .navigationDestination(for: String.self) { id in
                if let block = findChatBlock(id, in: wf.map { wfSteps($0) } ?? active?.steps ?? []) {
                    BlockPage(block: block, root: false, live: wf.map { $0.run.status == "running" && $0.row.agent.status == "running" } ?? active?.running ?? false)
                } else {
                    Text(L("This call is no longer available"))
                        .foregroundStyle(.secondary)
                        .modifier(SheetHeader(title: "", root: false))
                }
            }
        }
        .sheet(item: $message) { target in AgentMessageSheet(model: model, target: target).cbSheet(.half) }
        .confirmationDialog(
            L("Stop this subagent?"),
            isPresented: Binding(get: { stopQuestion != nil }, set: { if !$0 { stopQuestion = nil } }),
            titleVisibility: .visible
        ) {
            Button(L("Stop"), role: .destructive) {
                guard let entry = stopQuestion else { return }
                stopQuestion = nil
                Task { await model.stopAgent(entry.agentId) }
            }
            Button(L("Cancel"), role: .cancel) { stopQuestion = nil }
        } message: {
            Text(L("The main agent receives a “stopped by the human” result and keeps working."))
        }
        .confirmationDialog(
            L("Stop all background agents?"),
            isPresented: $allQuestion,
            titleVisibility: .visible
        ) {
            Button(L("Stop all"), role: .destructive) {
                allQuestion = false
                Task { await model.stopAllBackgroundAgents() }
            }
            .accessibilityIdentifier("chat-agents-stop-all-confirm")
            Button(L("Cancel"), role: .cancel) { allQuestion = false }
        } message: {
            Text(L("All background agents of this chat are ended — even without a running turn. The main agent learns about it in its next turn."))
        }
        .task(id: initialSelection) {
            guard !initialSelection.isEmpty else { return }
            selectionBlock = initialSelection
            selectionId = list.first(where: { $0.blockId == initialSelection })?.id
        }
        .task { if let initialWf { wfSelection = initialWf } }

        // One-second tick only while an agent or a dynamic workflow runs — otherwise nothing ticks here. The
        // workflow runs outside the turn; its runtimes (head and table in the tree) tick on THIS beat.
        .task(id: running.isEmpty && !wfRunning) {
            guard !running.isEmpty || wfRunning else { return }
            while !Task.isCancelled {
                now = Date()
                try? await Task.sleep(nanoseconds: 1_000_000_000)
            }
        }
    }

    /// Does a dynamic workflow or a graph workflow in the background run in this chat? Then the
    /// one-second tick also runs without a running subagent.
    private var wfRunning: Bool {
        (model.withDynWorkflows && model.dynTree.runs.contains { $0.status == "running" }) || model.graphBackgroundActive
    }

    private func select(_ entry: SubagentEntry?) {
        selectionId = entry?.id
        selectionBlock = entry?.blockId
        wfSelection = nil
        stepsOn = false
    }

    /// The selected workflow agent in the CURRENT tree — if it drops out, the overview stands again.
    private func wfSelected() -> (run: DynTree.Run, row: DynTree.Row)? {
        guard let wfSelection, let run = model.dynTree.runs.first(where: { $0.runId == wfSelection.runId }) else { return nil }
        guard let row = DynTree.model(run).bands.flatMap(\.rows).first(where: { $0.agent.n == wfSelection.n }) else { return nil }
        return (run, row)
    }

    private func wfSteps(_ wf: (run: DynTree.Run, row: DynTree.Row)) -> [ChatBlock] {
        let key = DynTranscript.key(runId: wf.run.runId, n: wf.row.agent.n)
        guard case .rows(let rows)? = model.dynTranscripts[key] else { return [] }
        return DynTranscript.blocks(rows, prefix: "dynwf-\(key)")
    }

    // ── Overview: ONE list "Background Tasks" ──
    //
    // Subagents and dynamic workflows mixed, newest on top (`BackgroundTasks`, bound to the web), every card in
    // the form of the workflow card (`DynWorkflowCard`, Chat/DynWorkflowTree.swift): a `CbPane` without accent, on top the
    // head (chevron, job, runtime, stop), below "Subagent <state>" with the model on the right, below that the tokens.
    // 6 pt between two cards. The state stands as a colored word in every card.

    /// An entry of the list — the model's type (ChatViewModel+BackgroundTasks.swift): the list computes in ONE
    /// place, the sheet shows it, the header button counts from it.
    private typealias SheetTask = ChatViewModel.BgTask

    /// A row of the overview: the two section heads, per task its card, per background command and monitor one item.
    /// A card's identifier is its task's key — the same in BOTH sections, so that it keeps its state when moving from
    /// "Running" to "Finished" (`uebersicht`).
    private enum SheetRow: Identifiable {
        case headerRunning
        case headerEnded
        case task(SheetTask)
        case command(Int, String)
        case monitor(MonitorView)
        case wakeup(Date)
        var id: String {
            switch self {
            case .headerRunning: return "header:running"
            case .headerEnded: return "header:ended"
            case .task(let task): return task.id
            case .command(let i, _): return "command:\(i)"
            case .monitor(let m): return "monitor:\(m.id)"
            case .wakeup: return "wakeup"
            }
        }
    }

    /// "Running" (only when something runs) with the running tasks, then the commands and monitors; "Finished" with the rest — the
    /// cards only expanded.
    private func sheetRows(active: [SheetTask], finished: [SheetTask], commands: [(offset: Int, element: String)],
                             monitors: [MonitorView], wakeup: Date?, runningSomething: Bool) -> [SheetRow] {
        var rows: [SheetRow] = []
        if runningSomething {
            rows.append(.headerRunning)
            rows += active.map { .task($0) }
            rows += commands.map { .command($0.offset, $0.element) }
            rows += monitors.map { .monitor($0) }
            if let wakeup { rows.append(.wakeup(wakeup)) }
        }
        if !finished.isEmpty {
            rows.append(.headerEnded)
            if !endedClosed { rows += finished.map { .task($0) } }
        }
        return rows
    }

    /// The key of a subagent: its block id (the same as in the history, `taskSequence`), otherwise its entry id.
    private func agentKey(_ entry: SubagentEntry) -> String {
        BackgroundTasks.agentKey(entry.blockId ?? entry.id)
    }

    @ViewBuilder
    private func taskCard(_ task: SheetTask) -> some View {
        switch task {
        case .agent(let entry, _):
            agentCard(entry)
        case .workflow(let run, _):
            DynWorkflowCard(model: model, run: run, now: now) { selection in
                select(nil)
                wfSelection = selection
            }
        case .graph(let run, _):
            GraphRunCard(model: model, run: run, now: now, onOpen: onOpenChat.map { open in
                { chatId in
                    open(chatId)
                    dismiss()
                }
            })
        }
    }

    // ── Wakeup — the same surface as the other cards (web: AgentBar.tsx `WakeupCard`). The runs of the outer loop do NOT
    // belong in this list. ──

    /// The wakeup: the main agent's scheduled continuation — with the wake time; the title is the reason. It belongs
    /// to the chat (server runs/wakeup.js) and has a stop at the head like the monitor (`stopWakeup`, Chat/ChatMonitors.swift).
    private func wakeupCard(_ at: Date) -> some View {
        CbPane {
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(model.waitWakeupReason.isEmpty ? L("Alarm") : model.waitWakeupReason)
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(2)
                    Spacer(minLength: 6)
                    Button(role: .destructive) {
                        wakeupStops = true
                        Task {
                            await model.stopWakeup()
                            wakeupStops = false
                        }
                    } label: {
                        if wakeupStops { ProgressView().controlSize(.mini) } else { Image(systemName: "stop.circle") }
                    }
                    .buttonStyle(.borderless)
                    .disabled(wakeupStops)
                    .accessibilityLabel(L("Stop"))
                    .accessibilityIdentifier("chat-bg-wakeup-stop")
                }
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(L("Alarm")).foregroundStyle(.secondary)
                    Text(L("waiting")).fontWeight(.medium).foregroundStyle(Color.accentColor)
                    Spacer(minLength: 6)
                    Text(at, style: .time).foregroundStyle(.secondary).monospacedDigit()
                }
                .font(.caption)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("chat-bg-wakeup")
    }

    /// The head of a section: word, behind it the count (only for "Finished"), on the right Σ if it is the first section.
    /// `chat-bg-tasks` is always carried by the FIRST visible head (the UI tests anchor on it).
    private func sectionHeader(_ word: String, count: Int?, sum: Int, closed: Bool?, identifier: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            CbOverline(word)
                .accessibilityIdentifier(identifier)
            if let count {
                Text("\(count)")
                    .font(.caption)
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
            }
            if let closed {
                Image(systemName: closed ? "chevron.down" : "chevron.up")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            if sum > 0 {
                Text(L("Σ {tokens}", ["tokens": ChatViewModel.formatTokens(sum)]))
                    .font(.caption)
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
                    .accessibilityLabel(L("Tokens of every background task in this chat — subagents and workflows together"))
                    .accessibilityValue(String(sum))
                    .accessibilityIdentifier("chat-bg-tasks-sum")
            }
        }
        .padding(.horizontal, 2)
    }

    /// A background command or monitor of the run — the same surface as the other cards, without stop (the server knows
    /// no human stop for either) and without runtime (they carry no start time).
    private func itemCard(kind: String, text: String, identifier: String) -> some View {
        CbPane {
            VStack(alignment: .leading, spacing: 2) {
                Text(text.isEmpty ? L(kind == "Monitor" ? "Monitor" : "Background command") : text)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(2)
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(L(kind)).foregroundStyle(.secondary)
                    Text(L("running")).fontWeight(.medium).foregroundStyle(Color.accentColor)
                }
                .font(.caption)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(identifier)
    }

    private func overview(_ list: [SubagentEntry], running: [SubagentEntry]) -> some View {
        let runs = model.withDynWorkflows ? model.dynTree.runs : []
        let taskList = model.backgroundList(list)
        // Two sections: "Running" — running subagents and workflows, newest on top, below them the background commands and
        // monitors of the run (`waitTasks`/`waitMonitors`, the same source as the tasks pill; without start time, newest
        // first) — and "Finished N", collapsible. The heading "Background Tasks" is the sheet's title.
        let active = taskList.filter(\.running)
        let finished = taskList.filter { !$0.running }
        let commands = Array(model.waitTasks.enumerated().reversed())
        // Monitors belong to the chat (Chat/ChatMonitors.swift) and carry start time, kind and log.
        let monitors = Array(model.monitors.reversed())
        let wakeup = model.waitWakeupAt
        let runningSomething = !active.isEmpty || !commands.isEmpty || !monitors.isEmpty || wakeup != nil
        // Σ over ALL entries — the subagents and the sum per workflow run.
        let sum = list.reduce(0) { $0 + ($1.tokens ?? 0) } + runs.reduce(0) { $0 + (DynTree.runTokens($1)?.tokens ?? 0) }
        return ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                if !running.isEmpty {
                    // ONE button for all background agents of this chat — also without a running turn.
                    // The identifier sits on the button, not on the stack (an identifier on the stack overwrites those of the children).
                    Button(role: .destructive) { allQuestion = true } label: {
                        Label(L("Stop all background agents"), systemImage: "stop.circle")
                            .font(.subheadline)
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("chat-agents-stop-all")
                }
                if taskList.isEmpty && !runningSomething {
                    // Contract: empty means empty — one sentence, no vanishing section. But a not yet loaded
                    // tree is not "no workflow" (`nil`): then no sentence until the route has answered.
                    if !model.withDynWorkflows || DynTree.carriesWorkflow(model.dynTree) == false {
                        Text(L("No background task has run in this chat yet. Subagents, workflows, background commands and alarms appear here — running as well as finished."))
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("chat-agents-empty")
                            .padding(.horizontal, 2)
                    }
                } else {
                    // Both sections in ONE ForEach with stable identifiers: a workflow that ends while
                    // one watches moves from "Running" to "Finished" — if the sections stood in two ForEach, SwiftUI
                    // would rebuild its card in the second ANEW, its expand state (`DynWorkflowCard.open`, per phase `choice`/`follows`) would be
                    // gone, and the stopped run would collapse under the eye — exactly what the card promises to avoid.
                    // Within one ForEach a card that only changes its place keeps its state. One card per entry;
                    // 6 pt between two cards, no separator line.
                    let rows = sheetRows(active: active, finished: finished, commands: commands, monitors: monitors,
                                             wakeup: wakeup, runningSomething: runningSomething)
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(rows) { row in
                            switch row {
                            case .headerRunning:
                                sectionHeader(L("Running"), count: nil, sum: sum, closed: nil, identifier: "chat-bg-tasks")
                            case .headerEnded:
                                Button { withAnimation(.snappy(duration: 0.2)) { endedClosed.toggle() } } label: {
                                    sectionHeader(L("Finished"), count: finished.count, sum: runningSomething ? 0 : sum, closed: endedClosed,
                                                  identifier: runningSomething ? "chat-bg-tasks-ended" : "chat-bg-tasks")
                                        .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                                .accessibilityHint(endedClosed ? L("Collapsed") : L("Expanded"))
                                .accessibilityIdentifier("chat-bg-ended")
                                // 12 pt between the sections (6 from the stack, 6 here).
                                .padding(.top, runningSomething ? 6 : 0)
                            case .task(let task):
                                taskCard(task)
                            case .command(_, let text):
                                itemCard(kind: "Command", text: text, identifier: "chat-bg-command")
                            case .monitor(let m):
                                MonitorCard(model: model, monitor: m)
                            case .wakeup(let at):
                                wakeupCard(at)
                            }
                        }
                    }
                }
                if model.withDynWorkflows && model.dynTree.additional > 0 {
                    Text(L("{n} older workflows of this chat are not shown.", ["n": model.dynTree.additional]))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 2)
                }
            }
            .padding(16)
        }
    }

    /// The card of ONE subagent — the same surface and the same structure as the card of a workflow run
    /// (`DynWorkflowCard`): head, "Subagent <state>" with the model on the right, the tokens. A tap on the head SWAPS
    /// the sheet's page for that of the agent — on the iPhone nothing expands in the card.
    private func agentCard(_ entry: SubagentEntry) -> some View {
        CbPane {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 8) {
                    // The job is the button; runtime and stop stand next to it. A button inside the label of a button
                    // does not reliably get the touch.
                    Button { select(entry) } label: {
                        HStack(spacing: 7) {
                            Image(systemName: "chevron.right")
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(.secondary)
                                .frame(width: 12)
                            Text(jobText(entry))
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(.primary)
                                .lineLimit(1)
                            Spacer(minLength: 6)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    // The same word as the marker's value in the history — also "running".
                    .accessibilityValue(entry.state.map { L($0.word) } ?? "")
                    .accessibilityIdentifier("chat-agents-row")
                    if let seconds = runtime(entry) {
                        Text(ChatViewModel.formatDuration(seconds))
                            .font(.caption)
                            .monospacedDigit()
                            .foregroundStyle(.secondary)
                            .accessibilityLabel(L("Running time {n}", ["n": ChatViewModel.formatDuration(seconds)]))
                            .accessibilityIdentifier("chat-agents-time")
                    }
                    if entry.running, !entry.agentId.isEmpty {
                        // "Message": the address is the agentId, also without a running turn.
                        Button { message = messageTarget(entry) } label: {
                            Image(systemName: "bubble.left").font(.caption.weight(.semibold))
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        .accessibilityLabel(L("Message"))
                        .accessibilityIdentifier("chat-agents-message")
                        Button(role: .destructive) { stopQuestion = entry } label: {
                            Image(systemName: "stop.fill").font(.caption.weight(.semibold))
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        .accessibilityLabel(L("Stop subagent"))
                        .accessibilityIdentifier("chat-agents-stop")
                    }
                }
                .padding(.horizontal, 14)
                .padding(.top, 10)
                .padding(.bottom, 4)
                // "Subagent <state>" on the left, the model on the right — like "Workflow <outcome>" and the phase at the workflow head.
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(L("Subagent"))
                        .foregroundStyle(.secondary)
                    Text(cardsWord(entry))
                        .fontWeight(.medium)
                        .foregroundStyle(wordColor(entry))
                        .accessibilityIdentifier("chat-agents-word")
                    Spacer(minLength: 6)
                    if !entry.model.isEmpty {
                        Text(Self.modelShort(entry.model))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                .font(.caption)
                .padding(.leading, 33)
                .padding(.trailing, 14)
                .padding(.bottom, 2)
                // The tokens — if the number is missing, a dash stands; behind it for a running agent the pace or
                // "waits until …" (parked at the usage limit).
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    Text("\(tokenColumn(entry)) \(L("tokens"))")
                        .monospacedDigit()
                        .accessibilityLabel(tokenReadAloud(entry))
                        .accessibilityIdentifier("chat-agents-tokens")
                    if let addition = addition(entry) {
                        Text("· \(addition)")
                            .foregroundStyle(entry.parkedUntil != nil || entry.waitingForCpu ? Color.orange : Color.secondary)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 0)
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(.leading, 33)
                .padding(.trailing, 14)
                .padding(.bottom, 10)
            }
        }
    }

    /// Behind the tokens the ONE thing that can still be said of a running agent: its pace — parked instead,
    /// when it continues. A finished one carries nothing: its state stands as a word one row above.
    private func addition(_ entry: SubagentEntry) -> String? {
        guard entry.running else { return nil }
        if let until = entry.parkedUntil { return SubagentEntry.waitingUntilText(until) }
        if entry.waitingForCpu { return L("waiting for CPU") } // RS „Rechenleistung schonen“
        if let tempo = entry.tempo { return L("{n} tokens/min", ["n": ChatViewModel.formatTokens(tempo)]) }
        return nil
    }

    /// The visible word of the card: "running", "finished", "stopped", "error", "no result" — from `entry.state`
    /// (the ONE computation that the marker in the history also reads); without a state it is finished.
    /// The target of the sheet "Message": the agentId, job as name, the card's state word.
    private func messageTarget(_ entry: SubagentEntry) -> AgentMessageTarget {
        AgentMessageTarget(address: entry.agentId, name: jobText(entry), kind: L("Subagent"), state: cardsWord(entry))
    }

    private func cardsWord(_ entry: SubagentEntry) -> String {
        entry.state.map { L($0.word) } ?? L("done")
    }

    private func tokenColumn(_ entry: SubagentEntry) -> String {
        guard let tokens = entry.tokens else { return "–" }
        let count = ChatViewModel.formatTokens(tokens)
        // "at least" is mandatory where the provider reports only the OUTPUT (Codex, loop engine) —
        // in the card as a prefixed character, the word is read aloud and stands on the agent's page.
        return entry.onlyOutput ? "≥\(count)" : count
    }

    /// What VoiceOver makes of the token row: "≥" saves space for the EYE —
    /// read aloud the word belongs there, otherwise one would hear "greater or equal forty-eight k".
    private func tokenReadAloud(_ entry: SubagentEntry) -> String {
        guard let tokens = entry.tokens else { return L("No token count") }
        // EXACT, not rounded: the card abbreviates to "18k" — read aloud the full number costs nothing. Side effect that
        // carries the test bench: from "18k" one cannot see 1,400 new tokens, from the exact number every single one.
        let count = String(tokens)
        return entry.onlyOutput
            ? L("at least {n} tokens", ["n": count])
            : L("{n} tokens", ["n": count])
    }

    // ── The page of an agent: report ON TOP, steps below ──

    private func agentPage(_ entry: SubagentEntry) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(jobText(entry))
                        .font(.headline)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("chat-agents-job")
                    Text(metrics(entry))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if entry.running, !entry.agentId.isEmpty {
                    HStack(spacing: 10) {
                        Button(role: .destructive) { stopQuestion = entry } label: {
                            Label(L("Stop subagent"), systemImage: "stop.circle")
                                .font(.subheadline)
                        }
                        .buttonStyle(.bordered)
                        // Own identifier: the same name on list AND page would find two buttons.
                        .accessibilityIdentifier("chat-agents-stop-page")
                        Button { message = messageTarget(entry) } label: {
                            Label(L("Message"), systemImage: "bubble.left")
                                .font(.subheadline)
                        }
                        .buttonStyle(.bordered)
                        .accessibilityIdentifier("chat-agents-message-page")
                        // "To background": only on a foreground agent a call is waiting for.
                        // Without confirmation — the switch ends nothing, the agent keeps working.
                        if entry.foreground {
                            Button { Task { await model.intoTheBackground(entry.agentId) } } label: {
                                Label(L("Send to background"), systemImage: "arrow.down.right.circle")
                                    .font(.subheadline)
                            }
                            .buttonStyle(.bordered)
                            .accessibilityIdentifier("chat-agents-background")
                        }
                    }
                }
                // The report is what the main agent read — hence it stands on top.
                // The steps below are the reasoning.
                LabeledSection(L("Report")) {
                    if entry.report.isEmpty {
                        Text(entry.running
                             ? L("The report appears as soon as the subagent is done.")
                             : L("This subagent left no report."))
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("chat-agents-report-empty")
                    } else {
                        MarkdownView(source: entry.report)
                            .padding(10)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(.cbElevated, in: RoundedRectangle(cornerRadius: 10))
                            // `children: .contain` is mandatory: an identifier on a stack
                            // REPLACES the identifiers of all children, and the search would find
                            // some text inside it instead of the report.
                            .accessibilityElement(children: .contain)
                            .accessibilityIdentifier("chat-agents-report")
                    }
                }
                if !entry.steps.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        Button { stepsOn.toggle() } label: {
                            HStack(spacing: 6) {
                                Text(stepsTitle(entry))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                Image(systemName: stepsOn ? "chevron.down" : "chevron.right")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                                Spacer(minLength: 0)
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("chat-agents-steps")
                        if stepsOn {
                            CallTimeline(blocks: entry.steps, live: entry.running)
                        }
                    }
                }
            }
            .padding(16)
        }
    }

    // ── Texte ──

    private func jobText(_ entry: SubagentEntry) -> String {
        entry.job.isEmpty ? L("No description") : entry.job
    }

    private func stepsTitle(_ entry: SubagentEntry) -> String {
        let n = entry.steps.count
        return n == 1 ? L("1 step") : L("{n} steps", ["n": n])
    }

    /// The provider already stands in front, so it drops out of the model name:
    /// "claude::claude-haiku-4-5-20251001" becomes "claude::haiku-4-5-20251001", "codex::gpt-5.4-mini"
    /// stays. Only in the LIST — on the agent's page and in the version for large
    /// system type the full name stands, there the row is wide enough.
    ///
    /// Identical with `modelShort` in web/src/lib/agents.ts: an abbreviation that applies on one
    /// stage and not on the other would be the same model with two names.
    /// The rows of the workflow agents abbreviate with it too (Chat/DynWorkflowTree.swift) — ONE abbreviation on iOS.
    static func modelShort(_ full: String) -> String {
        guard let separator = full.range(of: "::") else { return full }
        let header = String(full[full.startIndex..<separator.lowerBound])
        let tail = String(full[separator.upperBound...])
        let prefix = header + "-"
        guard tail.hasPrefix(prefix) else { return full }
        return header + "::" + String(tail.dropFirst(prefix.count))
    }

    /// The color of the state word in the card — the same colors as the outcome at the head of a workflow card
    /// (`DynWorkflowCard.outcomeColor`): running in the accent, finished green, error red, otherwise muted. It reads the state
    /// from the SAME computation as the word. The card carries ONE state indicator, the word.
    private func wordColor(_ entry: SubagentEntry) -> Color {
        switch entry.state?.identifier {
        case "running": return .accentColor
        case "error": return .red
        case nil: return .green
        default: return .secondary
        }
    }

    /// A row of metrics: state · model · runtime · tokens · pace. What is not known
    /// is missing — a 0 would be a statement nobody measured.
    private func metrics(_ entry: SubagentEntry) -> String {
        var parts: [String] = []
        if let word = stateWord(entry) { parts.append(word) }
        if entry.running, let until = entry.parkedUntil { parts.append(SubagentEntry.waitingUntilText(until)) }
        if !entry.model.isEmpty { parts.append(entry.model) }
        if let seconds = runtime(entry) { parts.append(ChatViewModel.formatDuration(seconds)) }
        if let tokens = entry.tokens {
            let count = ChatViewModel.formatTokens(tokens)
            // "at least" is mandatory where the provider reports only the OUTPUT (Codex, loop engine):
            // an understated number cannot otherwise be told from a complete one.
            parts.append(entry.onlyOutput
                         ? L("at least {n} tokens", ["n": count])
                         : L("{n} tokens", ["n": count]))
        }
        if entry.running, let tempo = entry.tempo {
            parts.append(L("{n} tokens/min", ["n": ChatViewModel.formatTokens(tempo)]))
        }
        if entry.tools > 0 {
            parts.append(entry.tools == 1
                         ? L("1 tool")
                         : L("{n} tools", ["n": entry.tools]))
        }
        return parts.joined(separator: " · ")
    }

    /// The visible state word — from `entry.state`, i.e. from the ONE computation that also
    /// the marker in the history reads: "stopped", "error", "no result"; finished carries
    /// none, and "running" is said by the stop button next to it (on the agent's page — the card of the
    /// list names every word, `cardsWord`). Having its own chain of words would contradict the
    /// marker at measured places.
    private func stateWord(_ entry: SubagentEntry) -> String? {
        guard let state = entry.state, state.identifier != "running" else { return nil }
        return L(state.word)
    }

    /// Runtime in seconds: for running ones from the start time on the one-second tick, for finished ones from
    /// their report. If both are missing, it is left out.
    private func runtime(_ entry: SubagentEntry) -> Int? {
        if let seconds = entry.runtime { return seconds }
        guard let start = entry.startedAt else { return nil }
        return max(0, Int(now.timeIntervalSince(start)))
    }
}
