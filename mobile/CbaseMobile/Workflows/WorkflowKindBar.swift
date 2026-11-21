import SwiftUI

// ── The kind of the "Workflows" category ────────────────────────────────────────────────────────────────────────────
// "Graph" and "Dynamic" (the dynamic-workflow library) are two kinds of the one category "Workflows". The bar sits fixed
// under the title of BOTH pages (`WorkflowsPane`, `DynWorkflowsPane`) and does not scroll with them. The state lives in
// `AppState.workflowKind` (remembered per workspace), not in the page: the page is rebuilt per scope and per kind.
//
// Identifiers on the button (CbSegments sets them there, with `.isSelected`): `wf-kind-graph`, `wf-kind-dynamic` — NO
// identifier on the bar itself, it would overwrite those of the buttons. Twin: `WorkflowsTab.tsx` on the web (`data-wf-kind`).
struct WorkflowKindBar: View {
    @EnvironmentObject private var state: AppState

    var body: some View {
        CbSegments(
            options: WorkflowKind.allCases.map { kind in
                CbSegment(value: kind, label: kind == .graph ? L("Graph") : L("Dynamic"), id: "wf-kind-\(kind.rawValue)")
            },
            selection: $state.workflowKind
        )
        .padding(.horizontal, 14)
        .padding(.bottom, 10)
    }
}
