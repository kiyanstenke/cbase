import SwiftUI

// Shared form of the project pages (twin of web/src/components/projects/ProjectForm.tsx): a leading tile with the thing's symbol in
// the colour of its state (`ProjectTile`), background `CbColor.elevated` like `CbSign`, never a system surface (it would show as a cold
// patch in the warm look); no hairlines between rows; a field has a small tile with its category symbol before its title
// (`ProjectField`). The building blocks `ProjectTile` and `ProjectField` live in the kit (Kit/CbTile.swift, with `CbTileRow`,
// `CbTileHeader` and `CbSituation`) under their old names, so subagents, outer loop, workflows, MCP, context and credentials pages
// speak the same form. What remains here is what only projects know: the colour of a container state.

/// Colour of an instance state (store/project-instances.js), same as `ProjectInstancesPage.color` and the web (`instanceColor`):
/// green ready, orange in transition or waiting, red error, muted otherwise (stopped, no state).
func projectStateColor(_ state: String?) -> Color {
    switch state {
    case "ready": return .green
    case "error": return .red
    case "create", "build", "start", "stop", "recreate", "relocation", "waiting_queue", "waiting_storage", "clearAway": return .orange
    default: return CbColor.textMuted
    }
}
