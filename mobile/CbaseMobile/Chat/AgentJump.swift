import Foundation

// The "agent in chat" jump (twin of web/src/lib/agent-jump.ts). A view outside the chat (the git overview: small in the git
// sheet, large under Projects → Git) names an agent working on a branch; a tap calls `AppState.openChat(_:agent:)`
// (Models/AppState.swift). That opens the chat like `openChat(_:)` and stores the request (`AppState.agentJump`);
// `MobileChatView` (Chat/ChatView.swift `agentJumpLead`) turns it, once the timeline is loaded, into the subagent sheet with
// exactly this agent (`agentJumpTarget` below) and consumes it.
//
// The key is the agentId, not the block id: `parentToolUseId` can be synthetic (`agent:<id>`, agent-runtime.js), and a
// re-parenting is not stored. `blockIdOfAgent` resolves the block; an agent of a dynamic workflow appears as a row of its run
// in the progress tree (`DynTreeSelection`). If it is in no list after the grace period, the sheet opens with the list; if the
// chat never opens within `valid`, the request expires silently.

struct AgentJump: Equatable {
    let id = UUID()
    let chatId: String
    let agentId: String
    let at = Date()

    /// How long the request waits for its chat (the chat list is still loading, the chat is gone).
    static let valid: TimeInterval = 30
    /// How long the loaded chat waits for the agent in its list (progress tree still on its way) before only the list opens.
    static let gracePeriod: TimeInterval = 3
    var expired: Bool { Date().timeIntervalSince(at) > Self.valid }
}

extension ChatViewModel {
    /// Where an "agent in chat" jump leads in the subagent sheet — `nil` while the agent is in no list. Twin of
    /// `agentJumpTarget` in web/src/lib/agent-jump.ts.
    func agentJumpTarget(_ agentId: String) -> SubagentsRequest? {
        guard !agentId.isEmpty else { return nil }
        let block = blockIdOfAgent(agentId)
        if !block.isEmpty { return SubagentsRequest(selection: block) }
        for run in dynTree.runs {
            if let a = run.agents.first(where: { $0.agentId == agentId }) {
                return SubagentsRequest(selection: "", wf: DynTreeSelection(runId: run.runId, n: a.n))
            }
        }
        return nil
    }
}
