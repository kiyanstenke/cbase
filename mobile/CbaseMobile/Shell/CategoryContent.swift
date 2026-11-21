import SwiftUI

// Content area of the workspace view: one mobile version per category. Chats, terminal and browser deliberately stay MOUNTED
// (only hidden) so running streams, PTYs and the screencast keep going across a category switch.
struct CategoryContent: View {
    @EnvironmentObject private var state: AppState
    @EnvironmentObject private var session: SessionStore

    /// A category is visible only when it is selected AND the overview is not in front of it. The overview does NOT REPLACE the
    /// permanently mounted panes; it covers them like a category switch, otherwise every tap on the tab would kill the screencast
    /// and the terminal would rebuild its session.
    private func visible(_ category: WorkspaceCategory) -> Bool {
        !state.showingCodingOverview && state.category == category
    }

    var body: some View {
        if let client = session.client, let workspace = state.activeWorkspace {
            ZStack {
                ChatsSection(client: client, workspace: workspace)
                    .opacity(visible(.chats) ? 1 : 0)
                    .allowsHitTesting(visible(.chats))
                    .accessibilityHidden(!visible(.chats))

                if let terminals = state.terminals, state.hasVisited(.terminal) {
                    TerminalsPane(model: terminals, active: visible(.terminal))
                        .opacity(visible(.terminal) ? 1 : 0)
                        .allowsHitTesting(visible(.terminal))
                        .accessibilityHidden(!visible(.terminal))
                }

                if let browserModel = state.browserModel, state.hasVisited(.browser) {
                    BrowserPane(model: browserModel, active: visible(.browser))
                        .opacity(visible(.browser) ? 1 : 0)
                        .allowsHitTesting(visible(.browser))
                        .accessibilityHidden(!visible(.browser))
                }

                if state.showingCodingOverview {
                    CodingOverview()
                        // The overview is where the arrow leads; it has none itself (measured: otherwise it stood in front of "Coding" and led nowhere).
                        .environment(\.paneBack, nil)
                } else {
                    category(client: client, workspace: workspace)
                }
            }
            // Every page with `PaneScaffold` thereby gets the arrow back to the overview. Code, terminal and browser have no scaffold,
            // but toolbars (the browser already carries a left arrow there, for ITS history); there the right drawer leads back (the
            // "Coding" place at the top or a category).
            .environment(\.paneBack, { state.showingCodingOverview = true })
        } else {
            EmptyPaneState(
                title: L("No server connection"),
                message: L("There is no connection to the cbase gateway."),
                systemImage: "network.slash"
            )
        }
    }

    /// The page of the selected category, without the three permanently mounted ones (see above).
    @ViewBuilder
    private func category(client: APIClient, workspace: Workspace) -> some View {
        switch state.category {
        case .chats, .terminal, .browser:
            EmptyView()
        case .scheduled:
            // The scheduled jobs of the workspace or the entered project.
            ScheduledPane(client: client, workspaceId: workspace.id, projectId: state.enteredProject?.id)
                .id("scheduled-\(state.scopeKey)")
        case .agents:
            // Three kinds under ONE category (plus instructions): each kind its own `.id`, so a switch rebuilds the page and loads, as with
            // the workflows.
            switch state.agentKind {
            case .subagents:
                AgentsPane(client: client, workspaceId: workspace.id, projectId: state.enteredProject?.id)
                    .id("agents-\(state.scopeKey)")
            case .outerloop:
                OuterLoopPane(client: client, workspaceId: workspace.id, projectId: state.enteredProject?.id)
                    .id("outerloop-\(state.scopeKey)")
            case .instructions:
                // The instructions for agents per workspace or entered project.
                AgentInstructionsPane(client: client, workspaceId: workspace.id, projectId: state.enteredProject?.id)
                    .id("instructions-\(state.scopeKey)")
            }
        case .workflows:
            // Two kinds under ONE category; each kind its own `.id`, so a switch rebuilds the page and loads, as the category switch used
            // to. Never mount both at once (hidden): the tests grab "Edit" and `dynwf-empty` across the whole app.
            switch state.workflowKind {
            case .graph:
                WorkflowsPane(client: client, workspaceId: workspace.id, projectId: state.enteredProject?.id)
                    .id("workflows-\(state.scopeKey)")
            case .dynamic:
                DynWorkflowsPane(client: client, workspaceId: workspace.id, projectId: state.enteredProject?.id)
                    .id("dynworkflows-\(state.scopeKey)")
            }
        case .projects:
            // In the entered project, directly the view of that project (category "Project"), otherwise the list.
            ProjectsPane(client: client, workspace: workspace, onlyProject: state.enteredProject?.id)
                .id("projects-\(state.scopeKey)")
        case .mcp:
            McpPane(client: client, workspaceId: workspace.id, projectId: state.enteredProject?.id)
                .id("mcp-\(state.scopeKey)")
        case .context:
            if let project = state.enteredProject {
                ProjectContextPane(client: client, projectId: project.id, projectName: project.name)
                    .id("ctx-\(project.id)")
            } else {
                WorkspaceContextPane(client: client, workspaceId: workspace.id)
                    .id("ctx-ws-\(workspace.id)")
            }
        case .vars:
            VarsPane(
                client: client,
                basePath: state.scopeApiBase,
                isProject: state.enteredProject != nil
            )
            .id("vars-\(state.scopeKey)")
        case .skills:
            // A Coding category again, modelled on the credentials: the workspace level shows its own, in a project "Own · Adopt" from the left drawer.
            SkillsPane(client: client, workspaceId: workspace.id, projectId: state.enteredProject?.id)
                .id("skills-\(state.scopeKey)")
        case .code:
            if let codeModel = state.codeModel,
               let gitModel = state.gitModel,
               let debugModel = state.debugModel {
                CodePane(model: codeModel, git: gitModel, debug: debugModel)
                    // No arrow in code: of five subviews only "Git" has a scaffold; an arrow that appears only there would be a riddle.
                    .environment(\.paneBack, nil)
            } else if state.codeInstance != nil {
                // The instance choice waits for the project list (a copy is remembered): never show the main one briefly without a label.
                CbLoading(label: L("Loading…"))
            }
        }
    }
}

/// Chats category: overview of the latest chats OR the open chat.
private struct ChatsSection: View {
    @EnvironmentObject private var state: AppState
    let client: APIClient
    let workspace: Workspace

    var body: some View {
        Group {
            if state.showingChatOverview {
                ChatsOverviewPane(client: client, workspace: workspace)
            } else {
                ChatHost(client: client, workspace: workspace)
            }
        }
        .animation(.easeInOut(duration: 0.22), value: state.showingChatOverview)
    }
}

/// Holds the open chat. The key changes only on a real chat switch, so the stream is not rebuilt for no reason.
private struct ChatHost: View {
    @EnvironmentObject private var state: AppState
    let client: APIClient
    let workspace: Workspace

    var body: some View {
        if let id = state.selectedChatId, id != state.createdDraft?.id, let model = state.chatList {
            // Own view per chat identifier: it holds the loading state of the resolution.
            SelectedChatHost(model: model, client: client, workspace: workspace, chatId: id)
                .id(id)
        } else {
            // The draft: the values of the entry point (`state.draftDefault`) go out with the first send. After creation THIS view stays
            // (the list lists the chat only from its first message): `selectedChatId` then points at it, and `createdDraft` holds this
            // branch. If it is rebuilt (category switched and back), it opens the created chat instead of an empty draft.
            MobileChatView(
                client: client,
                workspace: workspace,
                initialChat: state.createdDraft?.id == state.selectedChatId ? state.createdDraft : nil,
                preset: state.draftDefault
            )
            // The model takes the values only in `init`: a different draft (other folder, other project, "start chat" on an instance) and
            // every draft after a created one gets a new identifier.
            .id("draft-\(state.chatDraftIdentifier.uuidString)")
        }
    }
}

/// Resolves a chat identifier against the chat list and WAITS until it appears in it.
///
/// The waiting is the core: `MobileChatView` takes `initialChat` only in `init` into its `StateObject`. Passing `nil` while the
/// list is still empty leaves the empty draft standing, even if the chat arrives a fraction of a second later, because the
/// `.id` does not change and the view is not rebuilt. That is exactly how a tap on the iPhone notification landed in a
/// completely empty chat: the notification opens the chat before the list of this scope is loaded (`enterProject` /
/// `enter(workspaceId:)` only kick off the fetch).
///
/// `@ObservedObject` on the list model is mandatory: `AppState` publishes only the replacement of the model, not its content
/// (same trap as in `ChatsOverviewPane`).
///
/// The chat list carries only ACTIVE chats. If the identifier is not in it after the one refetch, the chat is fetched by id
/// (`GET /api/chats/:id`) and held: an archived coding chat (`kind == "normal"`) of the same workspace opens read-only, with the
/// archive bar. "Not found" means ONLY 404 (or a foreign workspace); a network error is not an answer "does not exist". And an
/// open chat that was just archived drops out of the list but stays: what was already shown is held too.
private struct SelectedChatHost: View {
    @EnvironmentObject private var state: AppState
    @ObservedObject var model: WorkspaceChatsViewModel
    let client: APIClient
    let workspace: Workspace
    let chatId: String
    /// A refetch has already been tried; only after that may "not found" show.
    @State private var reloaded = false
    /// The chat outside the list: fetched by id (archived) or already shown.
    @State private var held: Chat?
    /// The answer of the fetch by id: `missing` only on 404, `error` on everything else.
    @State private var missing = false
    @State private var error = ""

    var body: some View {
        if let chat = model.chats.first(where: { $0.id == chatId }) ?? held {
            MobileChatView(
                client: client,
                workspace: workspace,
                initialChat: chat
            )
            .id(chat.id)
            .onAppear { if held == nil { held = chat } }
            // If the open chat drops out of the list (archived, deleted, here or in another client), it stays; only a 404 closes it.
            .onChange(of: model.chats.contains { $0.id == chatId }) { _, inside in
                guard !inside else { return }
                Task { await fetchPerId() }
            }
        } else if !error.isEmpty {
            VStack(spacing: 10) {
                InlineError(message: error)
                PillButton(title: L("Try again"), systemImage: "arrow.clockwise") {
                    error = ""
                    Task { await fetchPerId() }
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        } else if !missing && (model.loading || !reloaded) {
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                // Deliberately `load()` instead of `startIfNeeded()`: a triggered run creates a NEW chat and sends the notification at once; an
                // already loaded list does not know it yet and would show "not found" without a refetch.
                .task {
                    await model.load()
                    if !model.chats.contains(where: { $0.id == chatId }) { await fetchPerId() }
                    reloaded = true
                }
        } else {
            EmptyPaneState(
                title: L("Chat not found"),
                message: L("It was deleted or belongs to a different workspace."),
                systemImage: "bubble.left.and.exclamationmark.bubble.right"
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        }
    }

    private func fetchPerId() async {
        do {
            let chat: Chat = try await client.get("/api/chats/\(chatId)", timeout: 20)
            // Only a CODING chat of this workspace opens here: a manager conversation or an old app-agent chat (whose question
            // notification carries `chatId`) would otherwise get the coding composer and the coding menu (move, branch, archive ⇒ 400).
            // `archivedAt` is deliberately NOT required: the fallback also helps the just created, not yet listed chat (see `.task` above).
            if chat.workspaceId == workspace.id && chat.kind == "normal" {
                held = chat
                missing = false
            } else {
                held = nil
                missing = true
            }
            error = ""
        } catch {
            if Task.isCancelled { return }
            if (error as? APIError)?.status == 404 {
                held = nil
                missing = true
                self.error = ""
            } else if held == nil {
                self.error = error.localizedDescription
            }
        }
        reloaded = true
    }
}
