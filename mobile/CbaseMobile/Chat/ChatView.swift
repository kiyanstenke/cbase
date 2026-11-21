import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

// An open chat inside the mobile shell. The chat list lives in the LEFT drawer (swipe right) — this view brings only its
// own slim header.
struct MobileChatView: View {
    @EnvironmentObject private var state: AppState
    @StateObject private var model: ChatViewModel
    @State private var showingSettings = false
    @State private var showingRename = false
    @State private var showingDelete = false
    @State private var showingGoal = false
    @State private var showingArtifacts = false
    @State private var showingFiles = false
    @State private var renameText = ""
    @State private var goalText = ""
    // Handle on the UIKit list for the one jump "own message → to the end". A class in @State: it survives body
    // evaluations without the body having to observe the list.
    @State private var timelineHandle = ChatTimelineHandle()
    // The reader has left the bottom edge → "Jump to end" arrow above the composer. Inverted list: "bottom of the chat" is
    // offset 0, pulling into the history raises it.
    @State private var awayFromLatest = false
    // Long press on a message: the selection dialog belongs OUTSIDE the inverted list (see `chatMessageActions`).
    @State private var messageActionText = ""
    @State private var showingMessageActions = false
    // Selected message text (long press ON the text): the small "Reply / Copy" menu is an overlay OUTSIDE the inverted
    // list, for the same reason as the message dialog. `clear` on the selection removes the blue highlight in the text
    // once the menu closes.
    @State private var textSelection: ChatTextSelection?
    /// Position of the standing selection (the menu follows it while scrolling) — see ChatSelectionTracker.
    @ObservedObject private var selectionTracker = ChatSelectionTracker.shared
    /// "Adjust" on the marker: the selected text goes into the sheet, presented from here.
    @State private var adjustRequest: AdjustRequest?
    // Tapped chat image (attachment/capture) full screen — presented OUTSIDE the inverted list, for the same reason as the
    // message dialog.
    @State private var viewerImage: ViewerImage?
    @State private var viewerVideo: ViewerVideo?
    // Thinking / tool calls of a row as a sheet from below — likewise presented from here (see ChatDetailSheet.swift).
    @State private var detailRequest: ChatDetailRequest?
    // Subagents of this chat: the header button and the mark in the timeline lead to the SAME sheet. The request carries
    // the block id of the tapped call — empty if the header button opened it. As an `item` and not a switch plus a second
    // value: `.sheet(isPresented:)` read the id from a stale state and opened the overview.
    @State private var agentsSheet: SubagentsRequest?
    // Sheet of the running tasks (pill of the run row). "Open" in it leads to the subagent sheet — only AFTER this sheet
    // closes (`onDismiss`): SwiftUI does not present two sheets at once on one view.
    @State private var tasksSheet = false
    /// How far the keyboard protrudes into the window from below — only for `emptyGreeting`.
    @State private var keyboardHeight: CGFloat = 0
    @State private var tasksTarget: SubagentsRequest?
    /// "Open" on a background graph workflow (card or tasks row): the id of its child chat — shown only AFTER the sheet
    /// closes (`onDismiss`), otherwise the chat switch would replace the view under the still standing sheet.
    @State private var openAfterSheet: String?
    /// The agenda sheet (header button `chat-agenda`) — read-only, `Chat/AgendaSheet.swift`.
    @State private var agendaSheet = false
    /// The timeline of this chat's project (header button `chat-timeline-button`, Chat/ProjectTimelineSheet.swift) — only with a project.
    @State private var timelineSheet = false
    /// The chat's channels (⋯ → "Channels", `ChatChannelsSheet` in Chat/ChannelPane.swift) and their unread messages (on the ⋯).
    @State private var channelsSheet = false
    @State private var channelsUnread = 0
    // Cells of the UIKit list do NOT inherit SwiftUI's environment — so the effective colour scheme is read and handed to
    // the list as `overrideUserInterfaceStyle`, otherwise the rows would ignore the app's theme switch.
    @Environment(\.colorScheme) private var colorScheme
    /// Counts finished runs — the git button re-reads its state accordingly.
    @State private var runsFinished = 0
    /// Measured height of header plus strips — the stage insets the timeline at the top by that much, so it starts UNDER
    /// the bar instead of behind it (see ChatHeader).
    @State private var headerHeight: CGFloat = ChatHeaderMass.height
    /// With glass: this far the status bar and the shell's TopBar lie above the chat — it extends upward by that much so the
    /// timeline runs through to the screen edge (Kit/CbGlass.swift). Otherwise 0.
    @Environment(\.headerOverhang) private var headerOverhang
    /// "Archive" in the ⋯: the flow with a precheck AFTER the tap. The chat stays open and shows the archive bar — hence
    /// via the model, not via the list.
    @State private var archiveJob: ArchiveJob?

    /// `preset`: the values of a draft (`initialChat == nil`) — they go out with the first send.
    init(client: APIClient, workspace: Workspace, initialChat: Chat?, preset: NewChatDraft = NewChatDraft()) {
        _model = StateObject(wrappedValue: ChatViewModel(
            client: client,
            workspace: workspace,
            chat: initialChat,
            preset: preset,
            withDynWorkflows: true,
            onChanged: {},
            onCreated: { _ in }
        ))
    }

    var body: some View {
        // Header and strips lie ABOVE the timeline: it runs beneath them and shimmers through the glass; the stage insets it
        // by their measured height.
        ZStack(alignment: .top) {
            // Timeline AND composer live together on the stage (`ChatTimelineStage`, one UIKit tree): the composer floats
            // above the continuous timeline (as in the ChatGPT app) and hangs with its bottom edge by constraint on the
            // `keyboardLayoutGuide` — UIKit moves it in the SAME transaction as the keyboard itself. The timeline is not
            // lifted: the overlap travels as a top inset into the inverted list; rows in the visible window depend only on
            // frame and offset, so readers scrolled up stay still BY CONSTRUCTION.
            timeline
            VStack(spacing: 0) {
                // Under the shell's TopBar (only with glass, otherwise 0): nothing sits here, but the veil reaches up to its
                // top edge, and the measured height includes the overhang — the stage insets the timeline by the WHOLE head
                // zone.
                Color.clear.frame(height: headerOverhang)
                chatHeader
                // Running workflow — directly under the chat name, because it determines the whole chat. A coding chat keeps
                // its agenda.
                ChatLimitStrip(model: model)
                ChatWorkflowStrip(model: model)
            }
            .modifier(ChatHeaderGlass())
            .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { headerHeight = $0 }
        }
        // The stage handles keyboard avoidance itself (constraint, see above). The shell removes the keyboard from the safe
        // area at the root for that (`chatManagesKeyboard` in AppShell): SwiftUI's automatic offset arrived in ONE step
        // (336 pt in one frame) and would act in addition to the constraint.
        .background(CbColor.ground)
        // Upward under the TopBar (only with glass): the negative padding enlarges the chat's frame UPWARD, the bottom edge
        // stays where it was — keyboard, island and stage floor keep computing against the same edge. The TopBar lies in
        // front (`zIndex` in the shell).
        .padding(.top, -headerOverhang)
        // NO `ignoresSafeArea(.keyboard)` of its own: the shell already removes the keyboard from the safe area at the root
        // (see `chatManagesKeyboard` in AppShell), and a second release here is not harmless but harmful — it detaches the
        // chat from the layout and lets it grow to the container edge. Measured: the bottom edge jumps from 792 to 840 on
        // opening the keyboard, 48 pt ABOVE the home bar. Those 48 pt cost the LazyVStack a new estimate of its total height
        // and thereby a 106 pt jump in the scroll offset — exactly what was visible as "the timeline moves when the
        // keyboard opens".
        // `chatMessageAction`/`chatTextSelectable` are NOT set on the body here: UIHostingConfiguration cells do not
        // inherit the chat's SwiftUI environment — both values are set per cell in the list (see `ChatTimelineList`).
        .fullScreenCover(item: $viewerImage) { item in
            ImageViewerScreen(image: item.image) { viewerImage = nil }
        }
        .fullScreenCover(item: $viewerVideo) { item in
            VideoViewerScreen(url: item.url) { viewerVideo = nil }
        }
        .sheet(item: $detailRequest) { request in
            ChatDetailSheet(request: request, model: model)
                .cbSheet(.small)
        }
        .sheet(item: $agentsSheet, onDismiss: openRememberedChat) { request in
            SubagentsSheet(model: model, initialSelection: request.selection, initialWf: request.wf, onOpenChat: { openAfterSheet = $0 })
                .cbSheet(.half)
        }
        .sheet(isPresented: $tasksSheet, onDismiss: {
            if let target = tasksTarget { tasksTarget = nil; agentsSheet = target } else { openRememberedChat() }
        }) {
            RunningTasksSheet(model: model) { item in
                if item.kind == .graph {
                    // A graph workflow opens its child chat, not the agents sheet.
                    openAfterSheet = model.graphView(item.reference).flatMap(model.graphChildChat)
                } else {
                    tasksTarget = SubagentsRequest(selection: item.kind == .agent ? model.blockIdOfAgent(item.reference) : "")
                }
                tasksSheet = false
            }
            .cbSheet(.half)
        }
        .sheet(item: $adjustRequest) { request in
            AdjustSheet(text: request.text, client: model.client)
                .cbSheet(.whole)
        }
        .confirmationDialog(L("Message"), isPresented: $showingMessageActions, titleVisibility: .visible) {
            Button(L("Copy message")) {
                UIPasteboard.general.string = messageActionText
            }
            Button(L("Cancel"), role: .cancel) {}
        } message: {
            Text(messageActionText.prefix(160) + (messageActionText.count > 160 ? "…" : ""))
        }
        // Menu on the text marker. The selection rectangle arrives in window coordinates from the doubly mirrored cell
        // (convert accounts for both flips) — the overlay converts it back via its own global position.
        .overlay {
            // Show only if the selection is visible: while scrolling the tracker follows the position, out of view the menu
            // stays off, and `.gone` means the selection is gone (cell recycled or new selection).
            if let selection = textSelection, case .at(let rect) = selectionTracker.placement {
                ChatSelectionMenuOverlay(
                    selection: selection,
                    rect: rect,
                    // Archived has no "Reply": it would write into an input that is not there.
                    onAsk: model.archived ? nil : { askAboutSelection() },
                    onCopy: { copySelection() },
                    onAdjust: { adjustSelection() }
                )
            }
        }
        .onChange(of: selectionTracker.placement) { _, placement in
            if placement == .gone { textSelection = nil }
        }
        .sheet(isPresented: $showingSettings) {
            ChatSettingsSheet(model: model)
                .cbSheet(.whole)
        }
        .sheet(isPresented: $agendaSheet) {
            AgendaSheet(model: model)
                .cbSheet(.half)
        }
        .sheet(isPresented: $timelineSheet) {
            if let client = state.client, let pid = timelineProjectId {
                ProjectTimelineSheet(client: client, projectId: pid,
                                     projectName: model.projects(in: state).first(where: { $0.id == pid })?.name ?? "",
                                     chatId: model.isDraft ? nil : model.chat.id,
                                     openAgenda: { DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { agendaSheet = true } })
                    .cbSheet(.half, chatOperable: true)
            }
        }
        .sheet(isPresented: $showingGoal) {
            // Archived is read-only: the header button stays, the sheet has no save.
            GoalSheet(goal: $goalText, onlyRead: model.archived, paused: model.chat.goalPaused) {
                let fresh = goalText.trimmingCharacters(in: .whitespacesAndNewlines)
                // Unchanged ⇒ no PATCH: any write of `goal` lifts the pause on the server, and "Save" without a change would
                // otherwise silently resume a paused goal.
                guard fresh != model.chat.goal.trimmingCharacters(in: .whitespacesAndNewlines) else { return }
                try await model.setGoal(fresh)
            }
            .cbSheet(.whole)
        }
        .sheet(isPresented: $showingArtifacts) {
            ArtifactBrowserSheet(model: model)
                .cbSheet(.whole)
        }
        .fileImporter(
            isPresented: $showingFiles,
            allowedContentTypes: [.data, .image, .pdf, .plainText, .sourceCode, .json],
            allowsMultipleSelection: true
        ) { result in
            if case .success(let urls) = result {
                Task {
                    for url in urls {
                        let scoped = url.startAccessingSecurityScopedResource()
                        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                        if let data = try? Data(contentsOf: url) {
                            await model.upload(name: url.lastPathComponent, data: data)
                        }
                    }
                }
            }
        }
        .alert(L("Rename chat"), isPresented: $showingRename) {
            TextField(L("Title"), text: $renameText)
            Button(L("Cancel"), role: .cancel) {}
            Button(L("Save")) {
                Task {
                    do {
                        try await model.rename(renameText)
                        await state.chatList?.load()
                    } catch {
                        model.error = error.localizedDescription
                    }
                }
            }
        }
        .archiveProcedure($archiveJob, client: model.client)
        .confirmationDialog(L("Delete chat?"), isPresented: $showingDelete, titleVisibility: .visible) {
            Button(L("Delete permanently"), role: .destructive) {
                Task {
                    do {
                        try await model.delete()
                        state.chatList?.remove(model.chat.id)
                        state.showChatOverview()
                    } catch {
                        model.error = error.localizedDescription
                    }
                }
            }
        } message: {
            Text(L("The history, attachments, and artifacts will be removed."))
        }
        .task {
            // A draft that is created on the first send stays open in THIS view and counts from then on as the open chat;
            // after the first message the list leads it — it reloads.
            let appState = state
            model.atCreation = { chat in appState.draftCreated(chat) }
            model.afterFirstMessage = { _ in Task { await appState.chatList?.load() } }
            await model.start()
        }
        // The jump "agent in chat" from outside (`AppState.openChat(_:agent:)`) — on appearing and on arrival.
        .task(id: state.agentJump?.id) { await agentJumpLead() }
        // Write the draft at once, otherwise only the model's 300 ms throttle carries it.
        .onDisappear { model.flushDraft(); model.stopListening() }
        // Run ended → the git state may have changed (the agent writes files) and so may the channels. The task list is not
        // reloaded here: the coding agent reads it only.
        .onChange(of: model.busy) {
            // The chat stream is the most reliable source for THIS chat: on connecting it says whether a turn really runs.
            // The global list may be stale (slept event stream in the background) — here it is straightened out so chat list
            // and timeline do not claim contradictory things.
            if model.busy { state.runningChats.insert(model.chat.id) }
            else { state.runningChats.remove(model.chat.id) }
            if !model.busy {
                runsFinished += 1
            }
        }
        // The return from the background is handled by the model itself (`ChatViewModel.reconnect`): it reconnects the
        // stream, and its `connected` reconciles. Reloading the chat and restarting here replaced the open bubble mid-turn
        // (the not yet stored text was gone, the following deltas attached to the last stored row), and `start()` did
        // nothing because the old, often dead stream was still there.
    }

    /// The jump "agent in chat" (Chat/AgentJump.swift): if it applies to THIS chat, it waits until the timeline is loaded and
    /// the agent is in the list or the progress tree, then opens the subagent sheet with it — after the grace period
    /// without a hit, the sheet with the list. The request is consumed; an expired one is discarded silently — also if it
    /// was meant for ANOTHER chat: if its target chat never opened it would otherwise linger, and whoever opened that chat
    /// minutes later would get the agents sheet. The grace period counts from the loaded timeline and restarts after every
    /// reload (like `readySince` on the web).
    private func agentJumpLead() async {
        guard let jump = state.agentJump else { return }
        guard !jump.expired else { state.agentJump = nil; return }
        guard jump.chatId == model.chat.id else { return }
        var readySince: Date?
        while !Task.isCancelled, state.agentJump?.id == jump.id {
            if model.loadingLog {
                readySince = nil
                if jump.expired {
                    state.agentJump = nil
                    return
                }
            } else {
                if let target = model.agentJumpTarget(jump.agentId) {
                    state.agentJump = nil
                    agentsSheet = target
                    return
                }
                let since = readySince ?? Date()
                readySince = since
                if Date().timeIntervalSince(since) >= AgentJump.gracePeriod {
                    state.agentJump = nil
                    agentsSheet = SubagentsRequest(selection: "")
                    return
                }
            }
            try? await Task.sleep(nanoseconds: 250_000_000)
        }
    }

    /// Project whose repository belongs to the open chat — an entered project takes precedence, otherwise the chat's
    /// project (so git also appears in the workspace view). Exactly the rule of the git sidebar in the desktop client.
    /// The project OF THE CHAT (not the entered one) — the timeline belongs to it.
    private var timelineProjectId: String? {
        guard let id = model.chat.projectId, !id.isEmpty else { return nil }
        return id
    }

    private var gitProjectId: String? {
        if let entered = state.enteredProject { return entered.id }
        guard let id = model.chat.projectId, !id.isEmpty else { return nil }
        return id
    }

    /// Name for it — shown in the empty state of the git view, so "no repository" names WHICH folder was checked.
    private var gitProjectName: String {
        if let entered = state.enteredProject { return entered.name }
        guard let id = model.chat.projectId else { return "" }
        return model.projects(in: state).first(where: { $0.id == id })?.name ?? ""
    }

    // ── Chat header ──
    private var chatHeader: some View {
        ChatHeader(title: model.chat.title) {
            // Left ONLY the way back. A ☰ button `ChatListButton` for the chat list used to sit beside it — the list still
            // opens with the swipe to the right.
            HeaderButton(systemImage: "chevron.left", label: L("Recent chats"), identifier: "chat-back") {
                state.showChatOverview()
            }
        } trailing: {
            // Git of the associated project (see ChatGitButton) — shows only if a repository really lives there. `id` binds
            // the button to the project: if the chat is moved it is rebuilt with the new folder. Also bound to the chat: the
            // view carries it (`?chat=`), in a copy chat it shows and changes the copy, never the main one. In the sheet one
            // also chooses main or another copy (Chat/ChatGitBar.swift); the choice applies per chat and survives the rebuild
            // via `id`.
            // The chat's instance: in every converted project, with "Create copy …"; in a draft it sits in the strip.
            if !model.isDraft && !model.archived {
                ChatInstanceChoice(model: model)
            }
            if let client = state.client, let projectId = gitProjectId {
                ChatGitButton(
                    client: client,
                    projectId: projectId,
                    projectName: gitProjectName,
                    chatId: model.isDraft ? nil : model.chat.id,
                    binding: model.isDraft ? nil : model.chat.instance,
                    runsFinished: runsFinished,
                    instanceEvent: state.instanceEvents[projectId] ?? 0
                )
                .id("\(projectId)|\(model.isDraft ? "" : model.chat.id)")
            }

            // The project timeline — the chat is the origin, not the scope; without a project none. A button in the place of
            // the channels button; the channels live in the ⋯. Without a project the place stays empty — the bar knows that
            // already (git only with a repository, goal only with a goal). Identifier NOT "chat-timeline" (that was the menu
            // entry): the timeline carries it (`ChatTimelineStage`), and an always visible button of the same name would fall
            // into the UI tests' query.
            if timelineProjectId != nil {
                HeaderButton(systemImage: "clock.arrow.circlepath", label: L("Timeline"), identifier: "chat-timeline-button") {
                    timelineSheet = true
                }
            }

            // Subagents: the dot shows while one works. The button stays even without a subagent — a button that comes and
            // goes shifts the whole bar.
            if !model.isDraft {
                HeaderButton(
                    // "Background Tasks" with stacked layers instead of two people (web: `BackgroundTasksIcon` in
                    // ChatRightSidebar.tsx). The dot shows while a row of the list runs — computed from the SAME list the sheet
                    // shows (ChatViewModel+BackgroundTasks).
                    systemImage: "square.stack.3d.up",
                    label: L("Background tasks"),
                    identifier: "chat-agents",
                    point: model.backgroundRunning > 0
                ) {
                    agentsSheet = SubagentsRequest(selection: "")
                }
            }

            // Agenda: the plan the agent of this chat keeps — read-only. The button is always there (except in a draft, which
            // has no id yet), for the same reason as the agents button; the dot shows while a step is in progress.
            if !model.isDraft {
                HeaderButton(
                    systemImage: "list.bullet.clipboard",
                    label: L("Agenda"),
                    identifier: "chat-agenda",
                    point: model.agendaInWork
                ) {
                    agendaSheet = true
                }
            }

            // A PAUSED goal is muted like the other handles and says so — the accent says "a state is in effect" in the head
            // zone, and a resting goal is not in effect.
            if !model.chat.goal.isEmpty {
                HeaderButton(
                    systemImage: "scope",
                    label: model.chat.goalPaused ? L("Goal paused") : L("Active goal"),
                    identifier: "chat-goal",
                    accent: !model.chat.goalPaused
                ) {
                    goalText = model.chat.goal
                    showingGoal = true
                }
            }

            Menu {
                Button(L("Artifacts"), systemImage: "doc.on.doc") {
                    showingArtifacts = true
                    Task { await model.loadArtifacts() }
                }
                .disabled(model.isDraft)
                // Channels: this chat's conversations with another coding chat — list, log and control actions. In the ⋯ (the
                // place in the bar carries the timeline). Same condition as the button: not in a draft; in the archive
                // read-only (`onlyRead` on the sheet).
                if state.client != nil, !model.isDraft {
                    Button {
                        channelsSheet = true
                    } label: {
                        Label(L("Channels"), systemImage: "arrow.left.arrow.right")
                        if channelsUnread > 0 {
                            Text(L("{n} unread", ["n": channelsUnread]))
                        }
                    }
                    .accessibilityIdentifier("chat-channels")
                }
                if model.archived {
                    archiveMenu
                } else {
                    activeMenu
                }
            } label: {
                // The unread channel messages show on the ⋯ — they are an occasion, not a stock.
                HeaderSymbol(systemImage: "ellipsis")
                    .overlay(alignment: .topTrailing) {
                        if channelsUnread > 0 { HeaderCount(n: channelsUnread) }
                    }
            }
            .accessibilityIdentifier("chat-menu")
            .accessibilityValue(channelsUnread > 0 ? L("{n} unread", ["n": channelsUnread]) : "")
            .background {
                if let client = state.client, !model.isDraft {
                    ChatChannelsSheet(
                        client: client,
                        workspaceId: model.workspace.id,
                        chatId: model.chat.id,
                        open: $channelsSheet,
                        unread: $channelsUnread,
                        refresh: runsFinished,
                        onlyRead: model.archived
                    )
                    .id(model.chat.id)
                }
            }
        }
    }

    /// The ⋯ of an ARCHIVED chat (read-only): artifacts above, otherwise only the way back and permanent deletion. Anything
    /// else would write — the server would reject it with 409.
    @ViewBuilder
    private var archiveMenu: some View {
        Button(L("Restore"), systemImage: "arrow.uturn.backward") {
            Task {
                do {
                    try await model.restore()
                    state.reportArchive([model.chat.id])
                } catch {
                    model.error = error.localizedDescription
                }
            }
        }
        Divider()
        Button(L("Delete permanently"), systemImage: "trash", role: .destructive) {
            showingDelete = true
        }
    }

    @ViewBuilder
    private var activeMenu: some View {
        Button(L("Chat settings"), systemImage: "slider.horizontal.3") {
            showingSettings = true
        }
        Button(L("Rename"), systemImage: "pencil") {
            renameText = model.chat.title
            showingRename = true
        }
        .disabled(model.isDraft)
        Button(
            model.chat.pinned ? L("Detach") : L("Pin"),
            systemImage: model.chat.pinned ? "pin.slash" : "pin"
        ) {
            Task {
                do {
                    try await model.togglePin()
                    await state.chatList?.load()
                } catch {
                    model.error = error.localizedDescription
                }
            }
        }
        .disabled(model.isDraft)
        Button(L("Goal"), systemImage: "scope") {
            goalText = model.chat.goal
            showingGoal = true
        }
        Button(L("Compact context"), systemImage: "arrow.down.right.and.arrow.up.left") {
            Task {
                do { try await model.compact() }
                catch { model.error = error.localizedDescription }
            }
        }
        .disabled(model.isDraft || model.busy || model.compacting || model.contextTokens == 0)
        AutocompactMenu(model: model)
            .disabled(model.isDraft)

        Menu(L("Move to project"), systemImage: "folder") {
            Button(L("Workspace")) {
                Task {
                    try? await model.move(to: nil)
                    await state.chatList?.load()
                }
            }
            // The live project list (`ChatViewModel.projects(in:)`): a just created project is in it without reopening.
            ForEach(model.projects(in: state)) { project in
                Button(project.name) {
                    Task {
                        try? await model.move(to: project.id)
                        await state.chatList?.load()
                    }
                }
            }
        }
        .disabled(model.isDraft)

        Button(L("Fork chat"), systemImage: "arrow.triangle.branch") {
            Task {
                do {
                    let child = try await model.fork()
                    await state.chatList?.load()
                    state.openChat(child.id)
                } catch {
                    model.error = error.localizedDescription
                }
            }
        }
        .disabled(model.isDraft)
        Divider()
        // Archive: the precheck comes AFTER the tap — a run, a question, a queue then say why not.
        Button(L("Archive"), systemImage: "archivebox") {
            let id = model.chat.id
            archiveJob = ArchiveJob(target: .chat(id: id, title: model.chat.title)) { dismiss in
                try await model.archive(dismissQuestion: dismiss)
                state.reportArchive([id])
            }
        }
        .disabled(model.isDraft)
        Button(L("Delete"), systemImage: "trash", role: .destructive) {
            showingDelete = true
        }
        .disabled(model.isDraft || model.busy)
    }

    /// No message yet, nothing loading, nothing running, not archived: the free area carries the greeting.
    private var isEmptyChat: Bool {
        model.timeline.isEmpty && !model.busy && !model.loadingLog && !model.archived
    }

    /// The greeting of the empty chat (like the ChatGPT start page) — centred in the space between header and island. The
    /// island stays at the bottom; the shell does not take the keyboard, so the greeting moves up with it itself
    /// (`keyboardHeight`). It lies BEHIND the stage and takes no taps; the project choice is a row in the composer's strip
    /// stack.
    ///
    /// Like the start page of the Claude app: the lens above the greeting (like the star there — the lens stays blue, the
    /// logo rule forbids recolouring it), the greeting one step muted, in the system font (`cbTitle(.greeting)`). The
    /// identifier sits on the TEXT (the test looks for `staticTexts["chat-empty-greeting"]`) — on the stack it would
    /// override the children.
    private var emptyGreeting: some View {
        VStack(spacing: 14) {
            CbaseLogo(size: 36)
            Text(ChatComposer.greeting())
                .cbTitle(.greeting)
                .foregroundStyle(CbColor.textSecondary)
                .multilineTextAlignment(.center)
                .accessibilityIdentifier("chat-empty-greeting")
        }
            .padding(.horizontal, 24)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .padding(.top, headerHeight)
            // Roughly the height of the island including drag zone and stack — it need not be exact, only never below.
            .padding(.bottom, max(keyboardHeight, 34) + 150)
            .allowsHitTesting(false)
            .animation(.easeOut(duration: 0.25), value: keyboardHeight)
    }

    // ── Timeline ──
    //
    // The timeline is an INVERTED UIKit list (`ChatTimelineList`, UICollectionView in a UIViewRepresentable) — as in
    // classic messengers: collection and cells are each mirrored once (doubly mirrored = upright), element 0 sits at offset
    // 0, and that IS the newest message, directly above the composer.
    //
    // Why UIKit instead of ScrollView/LazyVStack: "stand at the end" there presupposed the total height, which a
    // `LazyVStack` does not know — it estimates the height of rows not yet built. Measured on a timeline of a real 32,484
    // pt: first 39,280, standing at the top 72,875, while the keyboard opened temporarily 180,849. Every pull to the
    // estimated edge built other rows and produced the next estimate — a feedback loop that made the timeline visibly jump
    // and, in an unlucky case, ended BEHIND the content (black screen).
    //
    // The inverted UICollectionView NEVER needs the total height: everything not yet measured lies above the visible
    // window in the history, between reader and newest message every row is already exactly measured. Offset 0 is fixed
    // without any estimate — neither opening nor the growing answer in the stream nor the keyboard needs a follow-up. The
    // composer deliberately sits IN the layout (no `safeAreaInset`): the timeline ends at its top edge, and when the
    // keyboard shrinks the space, offset 0 simply stays offset 0.
    private var timeline: some View {
        ZStack {
            if model.loadingLog && model.timeline.isEmpty {
                ChatLoadingSkeleton()
                    .padding(.top, headerHeight)
                    .transition(.opacity)
            } else if isEmptyChat {
                emptyGreeting
                    .transition(.opacity)
            }

            ChatTimelineStage(
                rows: timelineRows,
                handle: timelineHandle,
                colorScheme: colorScheme,
                // On first load only the LIST stays invisible (skeleton behind it), the composer on the stage is visible.
                listHidden: model.loadingLog && model.timeline.isEmpty,
                awayFromLatest: $awayFromLatest,
                showingFiles: $showingFiles,
                showingSettings: $showingSettings,
                chatId: model.chat.id,
                model: model,
                state: state,
                loadAttachment: model.attachmentData,
                // Selection in a question card (cbase_ask).
                onAnswerAsk: { requestId, answers in
                    Task { await model.answerAsk(requestId: requestId, answers: answers) }
                },
                onDecidePermission: { request, allow, reason, remember in
                    Task { await model.decidePermission(request, allow: allow, reason: reason, remember: remember) }
                },
                onDecideApproval: { requestId, allow, reason, input in
                    Task { await model.decideApproval(requestId: requestId, allow: allow, reason: reason, updatedInput: input) }
                },
                onMessageAction: { text in
                    messageActionText = text
                    showingMessageActions = true
                },
                onTextHighlight: { selection in
                    textSelection = selection
                },
                onViewImage: { image in
                    viewerImage = ViewerImage(image: image)
                },
                onPlayVideo: { url in
                    viewerVideo = ViewerVideo(url: url)
                },
                onShowDetail: { request in
                    detailRequest = request
                },
                onShowAgents: { blockId in
                    agentsSheet = SubagentsRequest(selection: blockId)
                },
                onShowTasks: { tasksSheet = true },
                topInset: headerHeight
            )
            // An own message brings the reader back to the end — offset 0, exactly.
            .onChange(of: model.timeline.map(\.id)) { oldIDs, newIDs in
                guard newIDs.count > oldIDs.count, model.timeline.last?.role == .user else { return }
                timelineHandle.scrollToLatest()
            }
        }
        .animation(.easeInOut(duration: 0.28), value: model.loadingLog)
        // Only for the greeting of the empty chat (`emptyGreeting`) — on the stack, not on the greeting: it also arises with the
        // keyboard already open.
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillChangeFrameNotification)) { note in
            guard let end = note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect,
                  let window = UIApplication.shared.connectedScenes
                    .compactMap({ ($0 as? UIWindowScene)?.keyWindow }).first
            else { return }
            keyboardHeight = max(0, window.bounds.maxY - end.minY)
        }
    }

    /// Close the menu: remove the highlight in the text, then dismantle the overlay.
    private func dismissTextSelection() {
        textSelection?.clear()
        textSelection = nil
    }

    /// "Adjust" on the marker: the excerpt into the sheet — the result is in the clipboard afterwards.
    private func adjustSelection() {
        guard let selection = textSelection else { return }
        let text = selection.text
        dismissTextSelection()
        adjustRequest = AdjustRequest(text: text)
    }

    /// "Copy" on the marker: ONLY the selected excerpt into the clipboard.
    private func copySelection() {
        guard let selection = textSelection else { return }
        UIPasteboard.general.string = selection.text
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        dismissTextSelection()
    }

    /// Shows the remembered child chat of a graph workflow — WITH composer; an unlisted chat arrives by id
    /// (`SelectedChatHost.fetchPerId`).
    private func openRememberedChat() {
        guard let id = openAfterSheet else { return }
        openAfterSheet = nil
        state.openChat(id)
    }

    /// "Reply" on the marker: put the selection as a quote above the composer (`ChatViewModel.quotes`, card and mark in the
    /// island) and open the keyboard — the user types the reply into the field; the same goes out (`ChatViewModel+Quotes.swift`).
    private func askAboutSelection() {
        guard let selection = textSelection, !model.archived else { return }
        model.attachQuote(selection.text)
        dismissTextSelection()
        ChatInputTextView.focusCurrent()
    }

    /// Rows of the list. Element 0 appears at the BOTTOM at the composer, then it goes upward: approval cards, run
    /// indicator, timeline (newest first), errors.
    private var timelineRows: [ChatTimelineRowKind] {
        var rows: [ChatTimelineRowKind] = []
        for request in model.permissionRequests.reversed() {
            rows.append(.permission(request))
        }
        // The run indicator stands while the run runs — INDEPENDENT of whether text is streaming right now. It used to
        // hang on `!streamingText`, and that flag flips constantly in a real run: text → true (row gone), tool call → false
        // (row there), text → true (row gone). Every flip inserts a row at the bottom or removes it, so it shifts everything
        // above by its height plus row spacing (measured 41 pt) — visible as "suddenly extremely much space under the user
        // message, and it flickers back and forth". As a resting row above the composer it says the right thing anyway: the
        // run runs.
        //
        // In the WAITING phase (and after the turn while something runs in the background) the work rests: the row then
        // shows only [hexagon] [pill "N running tasks"] — the pill says what is waited for. Whether work runs lives ONCE in
        // `HistoryState`, which parts in `RunningTasks` (both bound to the web).
        let runningTasks = model.runningTasks
        if !RunningTasks.rowsParts(running: HistoryState.runRowVisible(busy: model.busy, waiting: model.waiting), time: model.runStartedAt != nil, tasks: runningTasks.item.count).isEmpty {
            rows.append(.run(ChatRunRowState(
                waiting: false,
                monitors: model.waitMonitors,
                agents: model.waitAgents,
                tasks: model.waitTasks,
                wakeupAt: model.waitWakeupAt,
                startedAt: model.runStartedAt,
                inputTokens: model.inputTokens,
                outputTokens: model.outputTokens,
                running: HistoryState.runRowVisible(busy: model.busy, waiting: model.waiting),
                runningTasks: runningTasks
            )))
        }
        // Rows without content are skipped — a cell without height still costs the row spacing on both sides (see
        // `rendersContent`).
        let visible = model.timeline.filter { item in
            guard item.rendersContent else { return false }
            // Do not show an OPEN coding approval that currently stands as a transient card at the composer a second time in
            // the timeline. After a restart (no transient card any more) the timeline card is the place to decide.
            if let f = item.approval, f.open, f.ruling == nil,
               model.permissionRequests.contains(where: { $0.requestId == f.requestId }) { return false }
            return true
        }
        // The day separator (Chat/DaySeparator.swift) above the first visible row of a calendar day — computed over the LOADED
        // rows; if older ones are still on the server (`logOlder`), the first loaded one gets none. In the inverted list it
        // stands BEHIND its row (= above it); its identifier hangs on it ("day-<row id>").
        let days = DaySeparator.markers(visible.map(\.at), olderBeforehand: model.logOlder, now: Date().timeIntervalSince1970 * 1000)
        for (index, item) in visible.enumerated().reversed() {
            rows.append(.item(item))
            if let day = days[index] { rows.append(.day(day, before: item.id)) }
        }
        if !model.error.isEmpty {
            rows.append(.error(model.error))
        }
        return rows
    }

}

/// Root of the hosted composer tree on the stage (see `ChatStageController`). The tree is deliberately cut TIGHT around
/// padding + island: the hosting view swallows touches even in EMPTY places (neither `hitTest → nil` nor
/// `allowsHitTesting(false)` pass a drag through to the collection). Every additional surface here would be a dead band
/// in which the timeline neither scrolls nor gets taps. The jump arrow therefore lives in a SEPARATE, tightly cut
/// mini-hosting on the stage (`ChatStageController.arrowHost`) — it too moves there by constraint, in sync with the
/// keyboard.
struct ChatComposerRoot: View {
    @ObservedObject var model: ChatViewModel
    let state: AppState
    @Binding var showingFiles: Bool
    @Binding var showingSettings: Bool

    var body: some View {
        ChatComposer(model: model, showingFiles: $showingFiles, showingSettings: $showingSettings)
            .environmentObject(state)
            // Hosted: does not inherit the root's tint — the accent therefore arrives here.
            .cbAccent()
            // Anchored at the BOTTOM: if the hosting frame lags an animated content height by one frame, the input row still
            // stays on the bottom edge — the overhang then lies at the top in the transparent drag zone. Without the anchor
            // the content would sit centred in the deviating frame (measured: exactly half a stroke, 84.5 pt deflection of
            // the input row).
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
    }
}

/// The floating arrow to the chat end — mini-hosting of its own on the stage, cut tight around the button so the area
/// beside it belongs to the timeline (see `ChatComposerRoot`). The padding around it keeps the distance to the composer's
/// top edge.
///
/// Form: a circle in the stage's ground colour (`CbColor.ground`) with a fine ring, arrow with a shaft in primary text, no
/// shadow — as on the web (`ChatStage.tsx`).
struct ChatArrowOverlay: View {
    let away: Bool
    let handle: ChatTimelineHandle

    var body: some View {
        Button {
            handle.scrollToLatest()
        } label: {
            Image(systemName: "arrow.down")
                .font(.symbol(15, weight: .medium))
                .foregroundStyle(CbColor.text)
                .frame(width: 34, height: 34)
                // With glass a glass circle above the timeline, otherwise opaque with an edge.
                .cbGlass(Circle(), interactive: true) {
                    Circle().fill(CbColor.ground)
                        .overlay(Circle().strokeBorder(CbColor.text.opacity(0.2), lineWidth: 1))
                }
        }
        .accessibilityIdentifier("jump-to-latest")
        .accessibilityLabel(Text(L("Jump to latest")))
        .padding(.horizontal, 12)
        .padding(.top, 12)
        .padding(.bottom, 10)
        .opacity(away ? 1 : 0)
        .scaleEffect(away ? 1 : 0.6)
        .allowsHitTesting(away)
        .animation(.spring(duration: 0.25), value: away)
    }
}
