import SwiftUI

// The monitors of a chat (cbase_monitor) — they belong to the CHAT, not the turn (server
// runs/monitors.js). A monitor lives until its command ends, the agent or the human stops it, its
// time limit hits or the chat is archived. The stream delivers it in `connected`, `run_waiting`
// and `background` (field `monitors`) — so it is back after a reload. Web counterpart:
// components/AgentBar.tsx `MonitorCard`.

/// A running monitor as the server reports it (runs/monitors.js `liveMonitors`). Missing fields: empty or `nil`.
struct MonitorView: Hashable, Identifiable, Sendable {
    let taskId: String
    let description: String
    /// "rows" (every matching line wakes) or "end" (only the end wakes, once).
    let report: String
    let command: String
    let ws: String
    /// Start in ms since 1970; `nil` = unknown.
    let startedAt: Double?
    /// The log file relative to the output location (`monitors/<taskId>.log`), empty = none.
    let logPath: String

    var id: String { taskId.isEmpty ? description : taskId }
    var title: String { description.isEmpty ? L("Monitor") : description }

    init(json: JSONValue) {
        taskId = json["taskId"]?.stringValue ?? ""
        description = json["description"]?.stringValue ?? ""
        report = json["report"]?.stringValue ?? "rows"
        command = json["command"]?.stringValue ?? ""
        ws = json["ws"]?.stringValue ?? ""
        let start = json["startedAt"]?.doubleValue ?? 0
        startedAt = start > 0 ? start : nil
        logPath = json["logPath"]?.stringValue ?? ""
    }
}

/// The "Open log" target in the Background Tasks sheet — its own kind so it does not mix with block ids.
struct MonitorLogTarget: Hashable {
    let path: String
}

extension ChatViewModel {
    /// The short form for the run row (descriptions) — same source as the cards.
    var waitMonitors: [String] { monitors.map(\.description) }

    /// Stop a monitor (`POST …/monitor/stop`, `from: "human"`) — works without a running turn. The card disappearing
    /// brings the `background` event without it.
    func stopMonitor(_ taskId: String) async {
        guard !isDraft, !taskId.isEmpty else { return }
        struct Body: Encodable { let taskId: String; let from: String }
        do {
            let _: JSONValue = try await client.post("/api/chats/\(chat.id)/monitor/stop", body: Body(taskId: taskId, from: "human"))
        } catch {
            self.error = L("Could not stop: {msg}", ["msg": error.localizedDescription])
        }
    }
}

extension ChatViewModel {
    /// Stop the chat's wakeup (`POST …/wakeup/stop`, `from: "human"`) — it belongs to the chat like a monitor (server
    /// runs/wakeup.js); the stop works without a running turn and leaves the main agent a silent hint. The card
    /// disappearing brings the `background` event with `wakeupAt` 0.
    func stopWakeup() async {
        guard !isDraft else { return }
        struct Body: Encodable { let from: String }
        do {
            let _: JSONValue = try await client.post("/api/chats/\(chat.id)/wakeup/stop", body: Body(from: "human"))
        } catch {
            self.error = L("Could not stop: {msg}", ["msg": error.localizedDescription])
        }
    }
}

/// The card of a monitor under Background Tasks: title, stop, "Monitor running · reports every line|the end · runtime", the
/// command and "Open log" (the file in the output location, `OutputFileView`).
struct MonitorCard: View {
    @ObservedObject var model: ChatViewModel
    let monitor: MonitorView
    @State private var stops = false

    var body: some View {
        CbPane {
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(monitor.title)
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(2)
                    Spacer(minLength: 6)
                    if !monitor.taskId.isEmpty {
                        Button(role: .destructive) {
                            stops = true
                            Task {
                                await model.stopMonitor(monitor.taskId)
                                stops = false
                            }
                        } label: {
                            if stops { ProgressView().controlSize(.mini) } else { Image(systemName: "stop.circle") }
                        }
                        .buttonStyle(.borderless)
                        .disabled(stops)
                        .accessibilityLabel(L("Stop"))
                        .accessibilityIdentifier("chat-bg-monitor-stop")
                    }
                }
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(L("Monitor")).foregroundStyle(.secondary)
                    Text(L("running")).fontWeight(.medium).foregroundStyle(Color.accentColor)
                    Spacer(minLength: 6)
                    Text(monitor.report == "end" ? L("reports the end") : L("reports every line")).foregroundStyle(.secondary)
                    if let start = monitor.startedAt {
                        Text(Date(timeIntervalSince1970: start / 1000), style: .timer)
                            .foregroundStyle(.secondary)
                            .monospacedDigit()
                    }
                }
                .font(.caption)
                let source = monitor.command.isEmpty ? monitor.ws : monitor.command
                if !source.isEmpty {
                    Text(source)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                if !monitor.logPath.isEmpty {
                    NavigationLink(value: MonitorLogTarget(path: monitor.logPath)) {
                        Text(L("Open log")).font(.caption)
                    }
                    .accessibilityIdentifier("chat-bg-monitor-log")
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("chat-bg-monitor")
    }
}

/// The log file page — same view as under Artifacts → Outputs.
struct MonitorLogPage: View {
    @ObservedObject var model: ChatViewModel
    let target: MonitorLogTarget

    var body: some View {
        OutputFileView(model: model, entry: OutputEntry(path: target.path, size: 0, changed: 0, isInternal: true))
    }
}
