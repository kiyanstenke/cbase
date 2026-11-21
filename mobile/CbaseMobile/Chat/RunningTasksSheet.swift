import SwiftUI

/// The sheet behind the pill "N running tasks": the iOS counterpart of the pill's sheet on the web
/// (`web/src/components/chat/TasksPill.tsx`). Presented from the chat root (`ChatView`), never from the run row's cell.
///
/// It carries what the former chips above the input field said: the description of every background command and
/// monitor (fallback "No description"), wake time with countdown, reason and follow-up prompt of the wakeup, the two
/// explanatory sentences. Plus subagents and workflows, each entry with "Open" (the subagent sheet, with the subagent
/// selected; the workflows' progress tree lives there) and "Stop" where the server has a human stop
/// (`RunningTasks.hasStop`). Also the background graph workflows: "Open" shows their child chat (only if there is one,
/// `ChatViewModel.graphChildChat`), "Stop" goes to `…/graph-workflows/:startId/stop`. The list reads the model LIVE: an
/// entry that ends drops out.
///
/// HIG form: a `List`, one row per task, `.bordered` buttons (in a list row default buttons would otherwise fire
/// together), stop with a confirmation like in the subagent sheet and in the tree.
struct RunningTasksSheet: View {
    @ObservedObject var model: ChatViewModel
    /// "Open": the root closes this sheet and then opens the subagent sheet.
    let onOpen: (RunningTasks.Item) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var now = Date()
    @State private var stopQuestion: RunningTasks.Item?
    @State private var stops: Set<String> = []

    var body: some View {
        let tasks = model.runningTasks
        NavigationStack {
            CbList {
                Section {
                    ForEach(tasks.item) { p in row(p) }
                } footer: {
                    footnote(tasks)
                }
            }
            .overlay {
                if tasks.item.isEmpty {
                    Text(L("Nothing is running alongside right now."))
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("chat-tasks-empty")
                }
            }
            .navigationTitle(L("Running tasks"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { SheetClose(identifier: "chat-tasks-close") { dismiss() } }
        }
        .task {
            // "since …" and the wakeup's countdown, only while the sheet is up.
            while !Task.isCancelled {
                now = Date()
                try? await Task.sleep(nanoseconds: 1_000_000_000)
            }
        }
        .confirmationDialog(
            stopTitle(stopQuestion?.kind),
            isPresented: Binding(get: { stopQuestion != nil }, set: { if !$0 { stopQuestion = nil } }),
            titleVisibility: .visible
        ) {
            Button(stopButton(stopQuestion?.kind), role: .destructive) {
                guard let p = stopQuestion else { return }
                stopQuestion = nil
                stop(p)
            }
            Button(L("Cancel"), role: .cancel) { stopQuestion = nil }
        } message: {
            Text(stopText(stopQuestion?.kind))
        }
    }

    private func row(_ p: RunningTasks.Item) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Image(systemName: symbol(p.kind))
                    .foregroundStyle(.tint)
                    .frame(width: 20)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(name(p))
                        .font(.body)
                        .lineLimit(3)
                    Text(subline(p))
                        .font(.footnote)
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                }
            }
            if p.kind == .wakeup {
                Text(L("The chat is woken at the given time by itself — until then you can keep writing."))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if !p.reason.isEmpty { detail(L("Reason"), p.reason) }
                if !p.prompt.isEmpty { detail(L("Then"), p.prompt, mono: true) }
            }
            let open = p.kind == .agent || p.kind == .workflow || (p.kind == .graph && model.graphView(p.reference).flatMap(model.graphChildChat) != nil)
            let stop = RunningTasks.hasStop(p)
            if open || stop {
                HStack(spacing: 8) {
                    if open {
                        Button(L("Open")) { onOpen(p) }
                            .accessibilityIdentifier("chat-task-open")
                    }
                    if stop {
                        Button(stops.contains(p.key) ? L("Stopping…") : L("Stop"), role: .destructive) { stopQuestion = p }
                            .disabled(stops.contains(p.key))
                            .accessibilityIdentifier("chat-task-stop")
                    }
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("chat-task-\(p.kind.rawValue)")
    }

    @ViewBuilder
    private func footnote(_ tasks: RunningTasks.Result) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if tasks.item.contains(where: { $0.kind == .command || $0.kind == .monitor }) {
                Text(L("Keeps running alongside while the chat stays responsive. As soon as it finishes, the agent evaluates the result on its own."))
            }
            if !tasks.complete {
                Text(L("This chat's workflows have not loaded yet — more may be running."))
                    .accessibilityIdentifier("chat-tasks-incomplete")
            }
        }
    }

    private func detail(_ title: String, _ value: String, mono: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(value)
                .font(mono ? .footnote.monospaced() : .footnote)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func symbol(_ kind: RunningTasks.Kind) -> String {
        switch kind {
        case .agent: return "person"
        case .workflow: return "point.3.connected.trianglepath.dotted"
        case .graph: return "flowchart"
        case .command: return "terminal"
        case .monitor: return "waveform.path.ecg"
        case .wakeup: return "alarm"
        }
    }

    private func name(_ p: RunningTasks.Item) -> String {
        if p.kind == .wakeup { return L("Scheduled to continue") }
        return p.name.isEmpty ? L("No description") : p.name
    }

    /// "Subagent · for 1m 05s", "Alarm · at 14:05 · in 19:58", "Subagent · waits until 14:05": the same parts as on the
    /// web; the duration in the run row's format (`formatDuration`).
    private func subline(_ p: RunningTasks.Item) -> String {
        let kind = L(RunningTasks.kindWord[p.kind] ?? "")
        let time: String
        if p.kind == .wakeup, let until = p.until {
            let target = Date(timeIntervalSince1970: until / 1000)
            time = "\(L("at {time}", ["time": target.formatted(date: .omitted, time: .shortened)])) · \(L("in {time}", ["time": Self.durationShort(target.timeIntervalSince(now))]))"
        } else if p.kind == .agent, let until = p.until {
            time = SubagentEntry.waitingUntilText(Date(timeIntervalSince1970: until / 1000))
        } else if let since = p.since {
            time = L("for {duration}", ["duration": ChatViewModel.formatDuration(max(0, Int(now.timeIntervalSince(Date(timeIntervalSince1970: since / 1000)))))])
        } else {
            time = ""
        }
        return time.isEmpty ? kind : "\(kind) · \(time)"
    }

    /// Remaining time "4:07" or "1:02:30" (the form of the old wakeup card, `durationShort` on the web).
    static func durationShort(_ seconds: TimeInterval) -> String {
        let total = max(0, Int(seconds.rounded()))
        let h = total / 3600, m = (total % 3600) / 60, s = total % 60
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, s) : String(format: "%d:%02d", m, s)
    }

    private func stopTitle(_ kind: RunningTasks.Kind?) -> String {
        switch kind {
        case .workflow: return L("Stop this workflow?")
        case .graph: return L("Stop this graph workflow?")
        case .monitor: return L("Stop this monitor?")
        case .wakeup: return L("Stop this wakeup?")
        default: return L("Stop this subagent?")
        }
    }

    private func stopButton(_ kind: RunningTasks.Kind?) -> String {
        switch kind {
        case .workflow: return L("Stop workflow")
        case .graph: return L("Stop graph workflow")
        case .monitor: return L("Stop monitor")
        case .wakeup: return L("Stop wakeup")
        default: return L("Stop")
        }
    }

    private func stopText(_ kind: RunningTasks.Kind?) -> String {
        switch kind {
        case .workflow: return L("Stop the whole workflow — running agents end, the main agent learns about it in its next turn.")
        case .graph: return L("The run ends right away; one that has not started yet is dropped.")
        case .monitor: return L("The monitor's command ends; the main agent learns about it in its next turn.")
        case .wakeup: return L("The chat will then not be woken; the main agent learns about it in its next turn.")
        default: return L("The main agent receives a “stopped by the human” result and keeps working.")
        }
    }

    private func stop(_ p: RunningTasks.Item) {
        stops.insert(p.key)
        Task {
            switch p.kind {
            case .workflow: _ = await model.stopDynWorkflow(p.reference)
            case .graph: _ = await model.stopGraphStart(p.reference)
            case .monitor: await model.stopMonitor(p.reference)
            case .wakeup: await model.stopWakeup()
            default: await model.stopAgent(p.reference)
            }
            stops.remove(p.key)
        }
    }
}
