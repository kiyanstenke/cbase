import SwiftUI

// Settings → Workflows: the per-user cap and the size guideline of the dynamic workflows. They set how work is done, not what
// was consumed, hence an own page in the "Behavior" group (contract `WORKFLOWS_PAGE`). Content: `WorkflowCapSection`
// (WorkflowCapSection.swift) with `WorkflowSizeRow` (WorkflowSizeSection.swift), identifiers `usage-dynwf-*`.
struct WorkflowsSettingsView: View {
    var body: some View {
        CbList {
            WorkflowCapSection()
            // "Spare computing power": Settings/SaverSection.swift.
            SaverSection()
        }
        .navigationTitle(L("Workflows"))
        .navigationBarTitleDisplayMode(.inline)
    }
}
