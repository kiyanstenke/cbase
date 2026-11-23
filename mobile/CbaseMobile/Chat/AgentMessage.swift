import SwiftUI

// The "Message" button on a live agent and its sheet (twin of web/src/components/chat/AgentMessageSheet.tsx): the human
// writes to a subagent (card and page in the agent sheet, address = agentId) or a workflow agent (row and page in the progress
// tree, also waiting, address always the run address `wf:<runId>:<n>`) — the same route as the main agent
// (`POST /api/chats/:id/agent/send`, `from: "human"`), without a running turn. Afterwards the sheet shows the server's sentence
// (`text`, never a wording of its own) and closes after a moment; a rejection stays so the text is not lost. That only holds if
// the `.sheet` is NOT attached to a view that vanishes when the agent ends: in the tree it hangs on the run's CARD
// (`DynWorkflowCard.message`), never on the row — that goes with its collapsing phase (guard web/test/dyn-tree.test.mjs). The
// path is NOT pre-encoded — `APIClient.makeURL` encodes itself.

/// Whom the sheet writes to: address for the route, name, kind and state (already translated) for the header.
struct AgentMessageTarget: Identifiable, Equatable {
    let address: String
    let name: String
    let kind: String
    let state: String
    var id: String { address }

    /// The run address of a workflow agent: agent n of run runId.
    static func workflowAddress(runId: String, n: Int) -> String { "wf:\(runId):\(n)" }
}

/// The route's response — `ok`, the delivery word and the sentence the UI shows.
struct AgentMessageResponse: Equatable {
    let ok: Bool
    let state: String
    let text: String
}

extension ChatViewModel {
    /// Sends the human's message to the agent `address`. Never throws: a rejection (status ≠ 2xx with
    /// `{ok:false, state:"denied", error, text}` — `APIError.message` is `error`, so the same sentence) and a network error
    /// come back as `ok: false`.
    func sendAgentMessage(to address: String, text: String) async -> AgentMessageResponse {
        struct Body: Encodable { let to: String; let message: String; let from: String }
        struct Response: Decodable { let ok: Bool?; let state: String?; let text: String? }
        do {
            let a: Response = try await client.post("/api/chats/\(chat.id)/agent/send", body: Body(to: address, message: text, from: "human"))
            return AgentMessageResponse(ok: a.ok != false, state: a.state ?? "", text: a.text ?? "")
        } catch {
            return AgentMessageResponse(ok: false, state: "denied", text: error.localizedDescription)
        }
    }
}

/// The word of a transcript row of kind "message" (state on the journal entry) — like `messageStateWord` on the web.
enum AgentMessageWord {
    static func state(_ state: String) -> String {
        switch state {
        case "delivered": return L("delivered")
        case "after_turn": return L("after its turn")
        case "earmarked": return L("queued")
        case "not_delivered": return L("not delivered")
        default: return state
        }
    }

    static func sender(_ from: String) -> String {
        from == "human" ? L("Message from the human") : L("Message from the main agent")
    }
}

/// The "Message" button as a symbol — in a table row of the tree, in the same fixed shape as Restart and Skip next to it
/// (`DynHandleStyle`: the column counts on its width).
struct AgentMessageButton: View {
    let identifier: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "bubble.left").font(.symbol(12, weight: .semibold))
        }
        .buttonStyle(DynHandleStyle())
        .accessibilityLabel(L("Message"))
        .accessibilityHint(L("Write this agent a message — also a waiting one: it then reads it when it starts."))
        .accessibilityIdentifier(identifier)
    }
}

/// The sheet: name as title, kind and state above it, a multi-line field, Send.
struct AgentMessageSheet: View {
    @ObservedObject var model: ChatViewModel
    let target: AgentMessageTarget
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var sends = false
    @State private var response: AgentMessageResponse?
    @FocusState private var focus: Bool

    private var accepted: Bool { response?.ok == true }
    private var empty: Bool { text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        NavigationStack {
            CbForm {
                Section {
                    TextEditor(text: $text)
                        .frame(minHeight: 120)
                        .focused($focus)
                        .disabled(sends || accepted)
                        .accessibilityIdentifier("chat-agent-message-field")
                } header: {
                    Text("\(target.kind) · \(target.state)")
                } footer: {
                    Text(L("The agent sees it as “Message from the human”."))
                }
                if let response {
                    Label(response.text.isEmpty ? (response.ok ? L("delivered") : L("rejected")) : response.text,
                          systemImage: response.ok ? "checkmark.circle" : "exclamationmark.circle")
                        .foregroundStyle(response.ok ? Color.green : Color.red)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("chat-agent-message-response")
                }
            }
            .navigationTitle(target.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                SheetClose(identifier: "agent-message-close") { dismiss() }
                ToolbarItem(placement: .confirmationAction) {
                    if sends {
                        ProgressView()
                    } else if !accepted {
                        Button(L("Send")) { Task { await send() } }
                            .disabled(empty)
                            .accessibilityIdentifier("chat-agent-message-send")
                    }
                }
            }
        }
        .onAppear { focus = true }
        // Accepted: the sentence stays a moment, then the sheet closes (as on the web).
        .task(id: accepted) {
            guard accepted else { return }
            try? await Task.sleep(nanoseconds: 1_800_000_000)
            if !Task.isCancelled { dismiss() }
        }
    }

    private func send() async {
        let message = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !message.isEmpty, !sends, !accepted else { return }
        sends = true
        response = nil
        let a = await model.sendAgentMessage(to: target.address, text: message)
        sends = false
        response = a
    }
}
