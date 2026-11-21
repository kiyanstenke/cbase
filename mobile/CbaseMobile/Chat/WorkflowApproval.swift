// The approval card of a dynamic workflow. Twin of web/src/lib/workflow-approval.ts and
// web/src/components/chat/WorkflowApprovalCard.tsx.
//
// The agent wanted to start a workflow without the human having chosen multi-agent orchestration (no ultracode mode, no
// "ultracode" in the message). The server (server/backend/electron/server/dynworkflows/approval.js) writes the card
// under its OWN role `workflow_approval` (`{ requestId, name, description, phases: [{ title, detail? }], at }`) and the
// ruling under `workflow_approval_ruling` (`{ requestId, decision: "accepted"|"rejected", runId?, taskId?, at }`); live
// the same payloads as harness events `workflow_approval` (under `card`) and `workflow_approval_decided` (under
// `ruling`). A card is open as long as no ruling exists; no message closes it. Accepting starts the run, rejecting
// tells the agent (POST /api/chats/:id/dyn-workflows/approval). Identifiers: `chat-workflow-approval` (head),
// `chat-workflow-approval-accept`, `chat-workflow-approval-reject`, `chat-workflow-approval-ruling` (on the
// text/button, never on the stack).
import SwiftUI

struct WorkflowApprovalState: Hashable, Sendable {
    static let role = "workflow_approval"
    static let rulingRole = "workflow_approval_ruling"

    struct Phase: Hashable, Sendable {
        let title: String
        let detail: String
    }

    let requestId: String
    let name: String
    let description: String
    let phases: [Phase]
    var decision: String? // nil = open · "accepted" · "rejected"
    var sends = false         // the ruling is in flight (buttons locked)

    /// The card from a JSON value (history row parsed or `event["card"]`). `nil` if it is none.
    init?(json: JSONValue?) {
        guard let json, let requestId = json["requestId"]?.stringValue, !requestId.isEmpty else { return nil }
        self.requestId = requestId
        name = json["name"]?.stringValue ?? ""
        description = json["description"]?.stringValue ?? ""
        phases = (json["phases"]?.arrayValue ?? []).compactMap { p in
            guard let title = p["title"]?.stringValue else { return nil }
            return Phase(title: title, detail: p["detail"]?.stringValue ?? "")
        }
        decision = nil
    }

    init?(text: String) {
        guard let json = Self.parse(text) else { return nil }
        self.init(json: json)
    }

    /// The ruling from a JSON value: (requestId, decision), `nil` if it is none.
    static func ruling(json: JSONValue?) -> (requestId: String, decision: String)? {
        guard let json, let rid = json["requestId"]?.stringValue, !rid.isEmpty,
              let e = json["decision"]?.stringValue, e == "accepted" || e == "rejected" else { return nil }
        return (rid, e)
    }

    static func ruling(text: String) -> (requestId: String, decision: String)? { ruling(json: parse(text)) }

    private static func parse(_ text: String) -> JSONValue? {
        guard let data = text.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(JSONValue.self, from: data)
    }
}

struct WorkflowApprovalView: View {
    let card: WorkflowApprovalState
    /// (requestId, accept). If missing, the card stays readable but without buttons.
    var onDecide: ((String, Bool) -> Void)? = nil

    private var open: Bool { card.decision == nil }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            // The identifier goes on the TITLE, not the head: there it would also carry the symbol (two hits per card). In the
            // history's card form (Chat/StatusForm.swift): no accent, "accepted" muted instead of green.
            CardsHeader(symbol: "point.3.connected.trianglepath.dotted", title: L("Allow this workflow?"), identifier: "chat-workflow-approval")
            Text(card.name.isEmpty ? "workflow" : card.name)
                .chatFont(.fixed(14), weight: .medium)
            if !card.description.isEmpty {
                Text(card.description)
                    .chatFont(.fixed(12.5))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !card.phases.isEmpty {
                VStack(alignment: .leading, spacing: 3) {
                    ForEach(Array(card.phases.enumerated()), id: \.offset) { i, p in
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Text("\(i + 1).").foregroundStyle(.secondary).monospacedDigit()
                            Text(p.detail.isEmpty ? p.title : "\(p.title) — \(p.detail)")
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        .chatFont(.fixed(12.5))
                    }
                }
            }
            if open, let onDecide {
                HStack(spacing: 8) {
                    Button(L("Deny"), role: .destructive) { onDecide(card.requestId, false) }
                        .buttonStyle(CardsButtonStyle())
                        .disabled(card.sends)
                        .accessibilityIdentifier("chat-workflow-approval-reject")
                    Spacer(minLength: 0)
                    Button(L("Accept")) { onDecide(card.requestId, true) }
                        .buttonStyle(CardsButtonStyle(main: true))
                        .disabled(card.sends)
                        .accessibilityIdentifier("chat-workflow-approval-accept")
                }
            } else if let e = card.decision {
                Text(e == "accepted" ? L("accepted") : L("rejected"))
                    .chatFont(.caption)
                    .foregroundStyle(CbColor.textMuted)
                    .accessibilityIdentifier("chat-workflow-approval-ruling")
            }
        }
        .cbCard()
    }
}

extension ChatViewModel {
    /// The card live (harness event `workflow_approval`): like an upload card it closes the running answer; the same card
    /// appears once.
    func pushWorkflowApproval(_ json: JSONValue?) { // internal, for extensions
        guard let card = WorkflowApprovalState(json: json) else { return }
        if let last = timeline.indices.last, timeline[last].role == .assistant, timeline[last].streaming {
            if timeline[last].blocks.isEmpty { timeline.remove(at: last) }
            else { timeline[last].streaming = false }
        }
        streamOpen = false
        streamingText = false
        guard !timeline.contains(where: { $0.wfApproval?.requestId == card.requestId }) else { return }
        timeline.append(TimelineItem(role: .workflowApproval, wfApproval: card))
    }

    /// The ruling (from this or another device): the card follows; a second one changes nothing.
    func markWorkflowApproval(requestId: String, decision: String) { // internal, for extensions
        for index in timeline.indices where timeline[index].wfApproval?.requestId == requestId && timeline[index].wfApproval?.decision == nil {
            timeline[index].wfApproval?.decision = decision
        }
    }

    /// Accept or reject, once: while the ruling is in flight the buttons are locked. What holds afterwards is what the
    /// server says (response and event); if the call fails, the card stays open and the error appears in the history.
    func decideWorkflowApproval(requestId: String, accept: Bool) async {
        struct Body: Encodable {
            let requestId: String
            let decision: String
        }
        struct Response: Decodable {
            let decision: String?
        }
        let open = timeline.indices.filter { timeline[$0].wfApproval?.requestId == requestId && timeline[$0].wfApproval?.decision == nil }
        guard !open.isEmpty, !open.contains(where: { timeline[$0].wfApproval?.sends == true }) else { return }
        for index in open { timeline[index].wfApproval?.sends = true }
        defer { for index in timeline.indices where timeline[index].wfApproval?.requestId == requestId { timeline[index].wfApproval?.sends = false } }
        do {
            let r: Response = try await client.post(
                "/api/chats/\(chat.id)/dyn-workflows/approval",
                body: Body(requestId: requestId, decision: accept ? "accept" : "reject")
            )
            if let e = r.decision { markWorkflowApproval(requestId: requestId, decision: e) }
        } catch {
            addError(error.localizedDescription)
        }
    }
}
