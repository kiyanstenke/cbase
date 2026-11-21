// Start and end marker of a dynamic workflow in the history. Twin of web/src/lib/workflow-marker.ts.
//
// The server (server/backend/electron/server/dynworkflows/run.js, `marker`) writes EXACTLY two rows per run under its
// OWN role `workflow_marker` (not under `meta`, which already holds figures and compaction) and sends the same payload
// live as harness event `workflow_marker` (nested under `marker`). Payload:
// `{ phase: "start"|"end", runId, taskId, name, status?, at }`; `status` of the end marker: finished, stopped, failed
// (like the completion notice) or interrupted (server end). In the history a status row with a symbol (`.divider` with
// `marker` and `tone`); identifier `chat-workflow-marker-<phase>` on the text (ChatTimelineRow). It hangs on no parent block.
import Foundation

struct WorkflowMarker: Hashable, Sendable {
    static let role = "workflow_marker"

    let phase: String   // "start" | "end"
    let runId: String
    let taskId: String
    let name: String
    let status: String  // only on the end marker
    /// The marker from a JSON value (history row parsed or `event["marker"]`). `nil` if it is none.
    init?(json: JSONValue?) {
        guard let json, let phase = json["phase"]?.stringValue, phase == "start" || phase == "end" else { return nil }
        self.phase = phase
        runId = json["runId"]?.stringValue ?? ""
        taskId = json["taskId"]?.stringValue ?? ""
        name = json["name"]?.stringValue ?? ""
        status = phase == "end" ? (json["status"]?.stringValue ?? "") : ""
    }

    /// The marker from a history row's text.
    init?(text: String) {
        guard let data = text.data(using: .utf8), let json = try? JSONDecoder().decode(JSONValue.self, from: data) else { return nil }
        self.init(json: json)
    }

    /// The row in the history, translated; the name stays data (parameter). The same keys as on the web.
    var row: String { L(key, ["name": name.isEmpty ? "workflow" : name]) }

    /// The row's tone (status row with a symbol, Chat/CompletionNotice.swift `SeparatorTone`).
    var tone: SeparatorTone { SeparatorTone.from(kind: phase == "start" ? "workflow-start" : "workflow-end", key: key) ?? .ok }

    private var key: String {
        if phase == "start" { return "Workflow “{name}” started" }
        switch status {
        case "finished": return "Workflow “{name}” finished"
        case "stopped": return "Workflow “{name}” stopped"
        case "failed": return "Workflow “{name}” failed"
        case "interrupted": return "Workflow “{name}” interrupted"
        default: return "Workflow “{name}” ended"
        }
    }
}

extension ChatViewModel {
    /// The marker live (harness event `workflow_marker`): like an upload card it closes the running answer (text after it
    /// starts a new one; in the history the row stands at the same place); the same marker appears once.
    func pushWorkflowMarker(_ json: JSONValue?) { // internal, for extensions
        guard let marker = WorkflowMarker(json: json) else { return }
        if let last = timeline.indices.last, timeline[last].role == .assistant, timeline[last].streaming {
            if timeline[last].blocks.isEmpty { timeline.remove(at: last) }
            else { timeline[last].streaming = false }
        }
        streamOpen = false
        streamingText = false
        guard !timeline.contains(where: { $0.marker?.runId == marker.runId && $0.marker?.phase == marker.phase }) else { return }
        timeline.append(TimelineItem(role: .divider, label: marker.row, marker: marker, tone: marker.tone))
    }
}
