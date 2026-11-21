import Foundation

// Which page the "Projects" category shows (workspace level) or the "Project" category (inside an entered project): the pure
// computation behind Code/ProjectsPane.swift, compiled and run by web/test/project-view-ios.test.mjs (`xcrun swiftc`). Foundation only.
//   - `projectsSelected` (a project's services, set from "Details" in the left drawer, "Services" in the context menu or "Manage
//     services" in the project view) applies inside an entered project ONLY to that project. The value is workspace-wide and
//     survives entering, so it must not leak project A's services into project B.
//   - The list is LOADED at this point (`CategoryContent` renders only with `state.activeWorkspace`; restoring an entered project
//     runs after `workspaces = list`). If the entered project is missing from it, it is gone, not "not loaded yet".
enum ProjectCategoryPage: Equatable {
    /// A project's services (`ProjectDetailPane`).
    case details(String)
    /// The entered project's view, embedded.
    case project(String)
    /// The entered project is not in the list: "no longer exists" with "Leave project".
    case gone(String)
    /// The list of all projects in the workspace.
    case list

    /// `selected`: `AppState.projectsSelected`; `enter`: the entered project (nil at workspace level); `projects`: ids of the loaded list.
    static func from(selected: String?, enter: String?, projects: [String]) -> ProjectCategoryPage {
        if let a = selected, projects.contains(a), enter == nil || enter == a { return .details(a) }
        guard let b = enter else { return .list }
        return projects.contains(b) ? .project(b) : .gone(b)
    }
}
