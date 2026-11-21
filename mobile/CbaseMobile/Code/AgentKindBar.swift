import SwiftUI

// ── The kind of the "Agents" category ──────────────────────────────────────────────────────────────────────────────────
// Three kinds under ONE category: the subagents (`AgentsPane`), the outer loop (`OuterLoopPane`) and the instructions for
// agents (`AgentInstructionsPane`), the same pattern as the kinds of the workflows (`Workflows/WorkflowKindBar.swift`).
// The bar stays fixed under the title of ALL three pages and does not scroll; the state lives in `AppState.agentKind`
// (remembered per workspace), not in the page.
//
// Identifiers on the button (CbSegments sets them there): `agents-kind-subagents`, `agents-kind-outerloop`,
// `agents-kind-instructions`. NO identifier on the bar itself, it would overwrite the buttons'. Twin:
// `components/outerloop/AgentsTab.tsx` on the web (`data-agents-kind`).
struct AgentKindBar: View {
    @EnvironmentObject private var state: AppState

    var body: some View {
        CbSegments(
            options: AgentKind.allCases.map { kind in
                CbSegment(value: kind, label: Self.label(kind), id: "agents-kind-\(kind.rawValue)")
            },
            selection: $state.agentKind
        )
        .padding(.horizontal, 14)
        .padding(.bottom, 10)
    }

    /// Exhaustive over the kinds: a new kind without a label does not compile.
    static func label(_ kind: AgentKind) -> String {
        switch kind {
        case .subagents: return L("Subagents")
        case .outerloop: return L("Outer loop")
        case .instructions: return L("Instructions")
        }
    }
}
