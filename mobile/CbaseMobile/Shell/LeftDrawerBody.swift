import SwiftUI

// Content of the left drawer — always matches the place the user is in.
struct LeftDrawerBody: View {
    @EnvironmentObject private var state: AppState
    @EnvironmentObject private var session: SessionStore

    var body: some View {
        Group {
            switch state.tab {
            case .apps:
                AppsSidebar()
            case .profile:
                ProfileSidebar()
            case .workspaces:
                workspaceSidebar
            }
        }
        .frame(maxHeight: .infinity)
    }

    @ViewBuilder
    private var workspaceSidebar: some View {
        if let workspace = state.activeWorkspace {
            switch state.category {
            // "Scheduled" shows the same chat list on the left: every job IS a chat, with its clock in the row.
            case .chats, .scheduled:
                if let model = state.chatList {
                    ChatsSidebar(model: model, workspace: workspace)
                }
            case .context:
                ContextSidebar()
            case .code:
                if let code = state.codeModel, let git = state.gitModel {
                    CodeSidebar(model: code, git: git)
                }
            case .terminal:
                if let terminals = state.terminals {
                    TerminalSidebar(model: terminals)
                }
            case .browser:
                if let browser = state.browserModel {
                    BrowserSidebar(model: browser)
                }
            case .projects:
                ProjectsSidebar(workspace: workspace)
            // Inside a project, skills get the same "Own · Adopt" section as agents and MCP; credentials carry it
            // in `VarsSidebar` next to the type filter.
            case .agents, .workflows, .mcp, .skills:
                ItemsSectionSidebar(category: state.category)
            case .vars:
                VarsSidebar()
            }
        } else {
            WorkspaceSidebarList()
        }
    }
}

/// With no workspace chosen: the workspace list in the drawer.
struct WorkspaceSidebarList: View {
    @EnvironmentObject private var state: AppState

    var body: some View {
        ScrollView {
            VStack(spacing: 3) {
                ForEach(state.workspaces) { workspace in
                    Button {
                        Task { await state.enter(workspaceId: workspace.id) }
                        state.closeDrawersAfterChoice()
                    } label: {
                        HStack {
                            Text(workspace.name)
                                .cbFont(14, weight: workspace.id == state.activeWorkspaceId ? .semibold : .regular)
                                .lineLimit(1)
                            Spacer()
                        }
                        .padding(.horizontal, 16)
                        .padding(.vertical, 9)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.vertical, 8)
        }
    }
}

/// Context: dumpster / memory plus category filter.
struct ContextSidebar: View {
    @EnvironmentObject private var state: AppState

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                SectionLabel(text: L("View"))
                SegmentedPills(
                    options: ContextSubView.allCases.map { ($0, L($0.displayLabel)) },
                    selection: Binding(
                        get: { state.contextSub },
                        set: { state.contextSub = $0 }
                    )
                )
                .accessibilityIdentifier("context-sub-switch")

                if state.contextSub == .memory {
                    SectionLabel(text: L("Categories"))
                    VStack(spacing: 3) {
                        drawerRow(
                            title: L("All"),
                            count: state.enteredProject == nil
                                ? state.overview?.contextCount
                                : categories.reduce(0) { $0 + $1.n },
                            active: state.contextCategory == nil
                        ) {
                            state.contextCategory = nil
                        }
                        ForEach(categories, id: \.slug) { entry in
                            drawerRow(
                                title: entry.category,
                                count: entry.n,
                                active: state.contextCategory == entry.slug
                            ) {
                                state.contextCategory = entry.slug
                            }
                        }
                        if categories.isEmpty {
                            Text(L("No categories yet."))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .padding(.vertical, 6)
                        }
                    }
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
        }
    }

    private var categories: [ContextCategory] {
        state.enteredProject != nil ? state.projectContextCounts : (state.overview?.categories ?? [])
    }

    @ViewBuilder
    private func drawerRow(title: String, count: Int?, active: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack {
                Text(title)
                    .cbFont(13.5, weight: active ? .semibold : .regular)
                    .lineLimit(1)
                Spacer()
                if let count {
                    Text(verbatim: "\(count)")
                        .cbFont(11, weight: .medium)
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                }
            }
            .foregroundStyle(Color.primary)
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .cbSelection(active, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// Agents/workflows/MCP/skills: own items vs. adopting workspace items.
struct ItemsSectionSidebar: View {
    @EnvironmentObject private var state: AppState
    let category: WorkspaceCategory

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                // Dynamic workflows have no project-own entries: the library belongs to the workspace and a project
                // only adopts from it, so there is no "Own" / "Adopt" section. It is the "Dynamic" kind under
                // "Workflows", not a category of its own.
                if state.enteredProject != nil, !isDynamic {
                    SectionLabel(text: L("Section"))
                    SegmentedPills(
                        options: ItemsSection.allCases.map { ($0, L($0.displayLabel)) },
                        selection: Binding(
                            get: { state.itemsSection },
                            set: { state.itemsSection = $0 }
                        )
                    )
                    .accessibilityIdentifier("items-section-switch")
                    Text(sectionHint)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                } else {
                    SectionLabel(text: L("Section"))
                    Text(workspaceHint)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Divider().padding(.vertical, 4)

                SectionLabel(text: L("Switch to"))
                ForEach([WorkspaceCategory.agents, .workflows, .mcp, .vars, .skills]) { item in
                    Button {
                        state.select(category: item)
                        state.closeDrawersAfterChoice()
                    } label: {
                        HStack(spacing: 10) {
                            Image(systemName: item.symbol)
                                .font(.symbol(13))
                                .frame(width: 18)
                            Text(L(item.displayLabel))
                                .cbFont(13.5, weight: item == category ? .semibold : .regular)
                            Spacer()
                        }
                        .foregroundStyle(Color.primary)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 8)
                        .cbSelection(item == category, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
        }
    }

    private var isDynamic: Bool { category == .workflows && state.workflowKind == .dynamic }

    private var sectionHint: String {
        switch category {
        case .agents: return L("Your own project subagents, or switch this project's workspace subagents on and off.")
        case .workflows: return L("Your own project workflows, or adopt workspace ones.")
        case .mcp: return L("Add project-specific MCP servers or adopt workspace servers.")
        case .skills: return L("This project's own skills, or the workspace skills in this project — each can be hidden there.")
        default: return ""
        }
    }

    private var workspaceHint: String {
        switch category {
        // NEW projects adopt the workspace agents automatically (existing projects stay opt-in).
        case .agents: return L("Workspace-wide subagents. Active automatically in new projects — switch them off there one by one.")
        case .workflows:
            guard isDynamic else { return L("Start in a chat with /workflow:<short name> — the model starts it.") }
            return state.enteredProject != nil
                ? L("The library belongs to the workspace — adopt each workflow for this project here.")
                : L("Saved by the agent; in a chat the model starts it by name.")
        case .mcp: return L("Enabled servers are available to the agent in every chat of this workspace.")
        case .skills: return L("Workspace-wide skills of the coding agents. Active in every project — each can be hidden there.")
        default: return ""
        }
    }
}

/// Credentials: filter by type.
struct VarsSidebar: View {
    @EnvironmentObject private var state: AppState

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                SectionLabel(text: L("Type"))
                VStack(spacing: 3) {
                    ForEach(VarsFilter.allCases, id: \.rawValue) { filter in
                        Button {
                            state.varsFilter = filter
                        } label: {
                            HStack {
                                Text(L(filter.displayLabel))
                                    .cbFont(13.5, weight: state.varsFilter == filter ? .semibold : .regular)
                                Spacer()
                            }
                            .foregroundStyle(Color.primary)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 8)
                            .cbSelection(state.varsFilter == filter, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }

                if state.enteredProject != nil {
                    Divider().padding(.vertical, 4)
                    SectionLabel(text: L("Section"))
                    SegmentedPills(
                        options: ItemsSection.allCases.map { ($0, L($0.displayLabel)) },
                        selection: Binding(
                            get: { state.itemsSection },
                            set: { state.itemsSection = $0 }
                        )
                    )
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
        }
    }
}

/// Projects: quick access to a project (enter it or open its details).
struct ProjectsSidebar: View {
    @EnvironmentObject private var state: AppState
    let workspace: Workspace

    /// Inside an entered project only THAT project is listed, without "Enter" (the user is already in it).
    private var projects: [Project] {
        guard let e = state.enteredProject else { return workspace.projects }
        return workspace.projects.filter { $0.id == e.id }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                SectionLabel(text: state.enteredProject == nil ? L("Projects") : L("Project"))
                if projects.isEmpty {
                    Text(L("No projects yet."))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                ForEach(projects) { project in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(project.name)
                            .cbFont(13.5, weight: .semibold)
                            .lineLimit(1)
                        HStack(spacing: 6) {
                            if state.enteredProject == nil {
                                PillButton(title: L("Enter"), prominent: true) {
                                    state.enterProject(project)
                                    state.closeDrawersAfterChoice()
                                }
                            }
                            PillButton(title: L("Details")) {
                                state.projectsSelected = project.id
                                state.closeDrawersAfterChoice()
                            }
                        }
                    }
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.secondary.opacity(0.07), in: RoundedRectangle(cornerRadius: 12))
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
        }
    }
}
