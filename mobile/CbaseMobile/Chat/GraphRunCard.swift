import SwiftUI

// The card of ONE background graph workflow under "Background Tasks" in the agent sheet; the iOS counterpart of
// `web/src/components/chat/GraphRunCard.tsx`. Same surface and structure as the card of a dynamic workflow
// (`DynWorkflowCard`, Chat/DynWorkflowTree.swift): a `CbPane` without accent, the head on top (chevron, title, running
// time, stop as a symbol), below it "Graph workflow <state>" in the tone's color with the warning dot when it waits for
// the human; expanded the reason or "{step}/{total}: {nodeTitle}", the worktree path and "Open".
//
// NOTHING is computed here: title, state word, tone, warning dot, second row, worktree and stop come from
// `GraphRuns.cardOf` (bound to the web, graph-runs-binding), the child chat from `ChatViewModel.graphChildChat`.
// "Open" shows the child chat WITH composer (`AppState.openChat`; `SelectedChatHost` fetches an unlisted chat by id);
// without a child chat (before the start, child deleted) there is no button. The stop is the human one
// (`POST …/graph-workflows/:startId/stop` with `from: "human"` on the starting chat, `stopGraphStart`).
//
// Every waiting state can be answered IN the card: `GraphRunResponse` draws the form from `card.response`
// (`GraphRuns.responseForm`: buttons, free text, the questions of an ask card) and sends through
// `ChatViewModel.respondGraphRun`, which calls the existing route on the child chat after `GraphRuns.responseRequest`.
// Above it the question (`wait.question`, truncated with "more"), for a permission the tool and truncated input. Until
// the answer everything is locked; after 2xx the form clears and `graph_run` brings the new state. "No longer open" (409,
// another device was faster) appears as a hint in the card and reloads the state; any other error appears as a line.
//
// HIG instead of the web model: no glass, surfaces from `Kit/CbKit`; the stop asks first, like on the workflow card.
struct GraphRunCard: View {
    @ObservedObject var model: ChatViewModel
    let run: GraphRuns.View
    let now: Date
    /// "Open" with the id of the child chat: the sheet closes and then shows the chat. `nil` = no Open (preview).
    let onOpen: ((String) -> Void)?
    /// An open run is shown expanded, a finished one collapsed; chosen on FIRST appearance, the choice sticks.
    @State private var open: Bool?
    @State private var stopQuestion = false
    @State private var stops = false

    var body: some View {
        if let card = GraphRuns.cardOf(run) {
            let isOpen = open ?? !GraphRuns.toEnd.contains(run.state)
            CbPane {
                VStack(alignment: .leading, spacing: 0) {
                    headerRow(card, open: isOpen)
                    statusRow(card)
                    if isOpen { details(card) }
                }
                .padding(.bottom, 8)
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("chat-graph-card-\(run.startId)")
            .onAppear { if open == nil { open = !GraphRuns.toEnd.contains(run.state) } }
            .onChange(of: card.stop) { _, stoppable in if !stoppable { stops = false } }
            .confirmationDialog(L("Stop this graph workflow?"), isPresented: $stopQuestion, titleVisibility: .visible) {
                Button(L("Stop graph workflow"), role: .destructive) {
                    stopQuestion = false
                    stops = true
                    Task { if !(await model.stopGraphStart(run.startId)) { stops = false } }
                }
                Button(L("Cancel"), role: .cancel) { stopQuestion = false }
            } message: {
                Text(L("The run ends right away; one that has not started yet is dropped."))
            }
        }
    }

    /// Title left, running time right, the stop symbol beside it: its OWN button next to the expand button (a button inside
    /// a button's label does not get the touch reliably).
    private func headerRow(_ card: GraphRuns.Card, open isOpen: Bool) -> some View {
        HStack(spacing: 8) {
            Button { open = !isOpen } label: {
                HStack(spacing: 7) {
                    Image(systemName: isOpen ? "chevron.down" : "chevron.right")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: 12)
                    Text(card.title.isEmpty ? L("Graph workflow") : card.title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                    Spacer(minLength: 6)
                    if let seconds = runtime() {
                        Text(ChatViewModel.formatDuration(seconds))
                            .font(.caption)
                            .monospacedDigit()
                            .foregroundStyle(.secondary)
                            .accessibilityLabel(L("Running time {n}", ["n": ChatViewModel.formatDuration(seconds)]))
                            .accessibilityIdentifier("chat-graph-duration-\(run.startId)")
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(card.title)
            .accessibilityValue(L(card.stateWord))
            .accessibilityHint(isOpen ? L("Expanded") : L("Collapsed"))
            .accessibilityIdentifier("chat-graph-header-\(run.startId)")
            if card.stop {
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
                .accessibilityLabel(L("Stop graph workflow"))
                .accessibilityIdentifier("chat-graph-stop-\(run.startId)")
            }
        }
        .padding(.horizontal, 14)
        .padding(.top, 10)
        .padding(.bottom, 4)
    }

    /// "Graph workflow · <state>" in the card's tone, preceded by the warning dot when the run waits for the human.
    private func statusRow(_ card: GraphRuns.Card) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(L("Graph workflow"))
                .foregroundStyle(.secondary)
            if card.warningDot {
                Circle()
                    .fill(Color.orange)
                    .frame(width: 7, height: 7)
                    .accessibilityHidden(true)
            }
            Text(L(card.stateWord))
                .fontWeight(.medium)
                .foregroundStyle(color(card.tone))
                .accessibilityIdentifier("chat-graph-state-\(run.startId)")
            Spacer(minLength: 0)
        }
        .font(.caption)
        .padding(.leading, 33)
        .padding(.trailing, 14)
    }

    /// Expanded: reason or step, the worktree path, "Open".
    @ViewBuilder private func details(_ card: GraphRuns.Card) -> some View {
        let kind = model.graphChildChat(run)
        if !card.row2.isEmpty || !card.worktree.isEmpty || kind != nil || card.response != nil {
            VStack(alignment: .leading, spacing: 6) {
                if !card.row2.isEmpty {
                    Text(card.row2)
                        .font(.footnote)
                        .foregroundStyle(.primary.opacity(0.85))
                        .lineLimit(3)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("chat-graph-row2-\(run.startId)")
                }
                if !card.worktree.isEmpty {
                    Label {
                        Text(card.worktree)
                            .font(.caption.monospaced())
                            .lineLimit(2)
                            .truncationMode(.middle)
                            .textSelection(.enabled)
                    } icon: {
                        Image(systemName: "arrow.triangle.branch")
                            .font(.caption)
                    }
                    .foregroundStyle(.secondary)
                    .accessibilityLabel(L("Worktree: {path}", ["path": card.worktree]))
                    .accessibilityIdentifier("chat-graph-worktree-\(run.startId)")
                }
                if let form = card.response {
                    // Identity hangs on WHAT is waited for: a new question, card or cap round gets a fresh form
                    // (empty fields, no selection, no old hint); the same one keeps its input.
                    GraphRunResponse(model: model, run: run, form: form)
                        .id("\(form.kind)|\(form.requestId)|\(run.wait?.question ?? "")")
                        .padding(.top, 2)
                }
                if let kind, let onOpen {
                    Button(L("Open")) { onOpen(kind) }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        .accessibilityHint(L("Shows the chat this graph workflow runs in — with its input field."))
                        .accessibilityIdentifier("chat-graph-open-\(run.startId)")
                }
            }
            .padding(.leading, 33)
            .padding(.trailing, 14)
            .padding(.top, 6)
        }
    }

    /// Seconds since the start (until the end, if there is one); `nil` without a start time.
    private func runtime() -> Int? {
        guard run.startedAt > 0 else { return nil }
        let end = run.endedAt ?? now.timeIntervalSince1970 * 1000
        return max(0, Int(((end - run.startedAt) / 1000).rounded()))
    }

    /// The color per tone, the same as the outcome of the workflow card, plus orange for "waits for you".
    private func color(_ tone: GraphRuns.Tone) -> Color {
        switch tone {
        case .running: return .accentColor
        case .waiting: return .orange
        case .finished: return .green
        case .error: return .red
        case .quiet, .muted: return .secondary
        }
    }
}

/// The response form of a waiting background run: its own view so its state (text, selection, hint) hangs on the waiting
/// point (`.id` in `GraphRunCard.details`) and not on the card. Nothing is computed here: which buttons, which
/// placeholder, which questions come from `form`; what is sent and whether "Send" sent anything, from
/// `GraphRuns.responseRequest`.
struct GraphRunResponse: View {
    @ObservedObject var model: ChatViewModel
    let run: GraphRuns.View
    let form: GraphRuns.Form

    @State private var text = ""
    /// Per question of the ask card the chosen labels (in tap order).
    @State private var selection: [[String]] = []
    /// The number of the cap button "{n} more".
    @State private var moreCount = GraphRuns.moreDefault
    @State private var sends = false
    @State private var questionWhole = false
    @State private var hint: String?
    @State private var error: String?

    private var isQuestion: Bool { form.route == "ask-answer" }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            questionText
            permission
            if isQuestion { question }
            if !form.buttons.isEmpty { buttonRow }
            if form.freeText { freeTextRow }
            if let hint {
                Label(hint, systemImage: "info.circle")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("chat-graph-response-hint-\(run.startId)")
            }
            if let error {
                Label(error, systemImage: "exclamationmark.triangle")
                    .font(.caption)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("chat-graph-response-error-\(run.startId)")
            }
        }
        .disabled(sends)
    }

    /// `wait.question`, wrapped; a long one is truncated to four lines, "more" shows it whole.
    @ViewBuilder private var questionText: some View {
        let question = (run.wait?.question ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !question.isEmpty {
            VStack(alignment: .leading, spacing: 2) {
                Text(question)
                    .font(.footnote)
                    .foregroundStyle(.primary)
                    .lineLimit(questionWhole ? nil : 4)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                    .accessibilityIdentifier("chat-graph-question-\(run.startId)")
                if question.count > 180 || question.filter({ $0 == "\n" }).count >= 4 {
                    Button(questionWhole ? L("less") : L("more")) { questionWhole.toggle() }
                        .font(.caption)
                        .buttonStyle(.plain)
                        .foregroundStyle(Color.accentColor)
                        .accessibilityIdentifier("chat-graph-question-more-\(run.startId)")
                }
            }
        }
    }

    /// For a permission: which tool, with which (truncated) input.
    @ViewBuilder private var permission: some View {
        if form.kind == "permission", let wait = run.wait, !wait.tool.isEmpty || !wait.input.isEmpty {
            VStack(alignment: .leading, spacing: 3) {
                if !wait.tool.isEmpty {
                    Text(wait.tool)
                        .font(.caption.weight(.semibold).monospaced())
                        .accessibilityIdentifier("chat-graph-tool-\(run.startId)")
                }
                if !wait.input.isEmpty {
                    Text(wait.input)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(4)
                        .truncationMode(.tail)
                        .textSelection(.enabled)
                }
            }
            .padding(8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
        }
    }

    /// The questions of an ask card: one button per option, multiple choice per `multiple`; the free text below.
    private var question: some View {
        ForEach(Array(form.questions.enumerated()), id: \.offset) { i, question in
            VStack(alignment: .leading, spacing: 5) {
                if !question.header.isEmpty || !question.question.isEmpty {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        if !question.header.isEmpty {
                            Text(question.header.uppercased())
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(.secondary)
                        }
                        Text(question.question)
                            .font(.footnote.weight(.medium))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                ForEach(Array(question.options.enumerated()), id: \.offset) { pos, option in
                    optionButton(question: i, multiple: question.multiple, option: option, pos: pos)
                }
            }
        }
    }

    private func optionButton(question i: Int, multiple: Bool, option: GraphRuns.Option, pos: Int) -> some View {
        let selected = selection.indices.contains(i) && selection[i].contains(option.label)
        let symbol = multiple ? (selected ? "checkmark.square.fill" : "square") : (selected ? "largecircle.fill.circle" : "circle")
        return Button {
            select(question: i, multiple: multiple, label: option.label)
        } label: {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: symbol)
                    .foregroundStyle(selected ? Color.accentColor : Color.secondary)
                VStack(alignment: .leading, spacing: 1) {
                    Text(option.label)
                        .font(.footnote.weight(selected ? .semibold : .regular))
                        .fixedSize(horizontal: false, vertical: true)
                    if !option.description.isEmpty {
                        Text(option.description)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(7)
            .background(selected ? Color.accentColor.opacity(0.12) : Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 9))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(.primary)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier("chat-graph-option-\(run.startId)-\(i)-\(pos)")
    }

    /// The buttons of the form: each sends immediately. "{n} more" carries the choice of the number beside it (1 … `moreMax`).
    private var buttonRow: some View {
        HStack(spacing: 8) {
            ForEach(form.buttons, id: \.id) { k in
                if k.id == "more" {
                    HStack(spacing: 4) {
                        Button(L(k.word, ["n": moreCount])) { send(GraphRuns.Input(button: k.id, n: moreCount)) }
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                            .accessibilityIdentifier("chat-graph-button-\(run.startId)-\(k.id)")
                        Stepper(L(k.word, ["n": moreCount]), value: $moreCount, in: 1...GraphRuns.moreMax)
                            .labelsHidden()
                            .controlSize(.mini)
                            .accessibilityIdentifier("chat-graph-more-\(run.startId)")
                    }
                } else {
                    Button(L(k.word, k.params)) { send(GraphRuns.Input(button: k.id)) }
                        .buttonStyle(.bordered)
                        .tint(k.send == "deny" || k.send == "reject" ? .red : .accentColor)
                        .controlSize(.small)
                        .accessibilityIdentifier("chat-graph-button-\(run.startId)-\(k.id)")
                }
            }
            Spacer(minLength: 0)
            if sends && !form.freeText { ProgressView().controlSize(.mini) }
        }
    }

    /// The free-text field with "Send": an empty text does not send; for an ask card a selection counts too.
    private var freeTextRow: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField(L(form.placeholder), text: $text, axis: .vertical)
                .lineLimit(1...5)
                .textFieldStyle(.roundedBorder)
                .font(.footnote)
                .accessibilityIdentifier("chat-graph-free-text-\(run.startId)")
            Button {
                send(freeTextInput)
            } label: {
                if sends {
                    ProgressView().controlSize(.mini)
                } else {
                    Text(L("Send"))
                }
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.small)
            .disabled(GraphRuns.responseRequest(run, freeTextInput) == nil)
            .accessibilityIdentifier("chat-graph-send-\(run.startId)")
        }
    }

    /// What "Send" sends: the text, for an ask card the selection per question as well.
    private var freeTextInput: GraphRuns.Input {
        GraphRuns.Input(text: text, selection: isQuestion ? selection : nil)
    }

    private func select(question i: Int, multiple: Bool, label: String) {
        if selection.count != form.questions.count { selection = form.questions.map { _ in [] } }
        guard selection.indices.contains(i) else { return }
        if let at = selection[i].firstIndex(of: label) {
            selection[i].remove(at: at)
        } else if multiple {
            selection[i].append(label)
        } else {
            selection[i] = [label]
        }
    }

    /// Sends and locks the form until the answer. After 2xx it clears; the new state (usually: the form disappears) comes
    /// through `graph_run`. "No longer open" becomes a hint (the model then reloads), any other error a line.
    private func send(_ input: GraphRuns.Input) {
        guard !sends else { return }
        sends = true
        hint = nil
        error = nil
        Task {
            let result = await model.respondGraphRun(run, input: input)
            sends = false
            switch result {
            case .sent:
                text = ""
                selection = form.questions.map { _ in [] }
                moreCount = GraphRuns.moreDefault
            case .noLongerOpen:
                hint = L("No longer open — already answered. Reloading the state.")
            case .error(let msg):
                error = L("Answer failed: {msg}", ["msg": msg])
            case nil:
                break
            }
        }
    }
}
