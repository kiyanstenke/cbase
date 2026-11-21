import SwiftUI

// Entering a workspace lands on this overview of the latest chats
// (instead of directly in an empty new chat). From here one goes into a chat —
// where the complete chat list then lives in the left drawer.
// Search and sorting of the chat list. Deliberately ONE building block for overview and left drawer:
// both work on the same state in AppState (the sorting is persistent) so they never
// show different things. There is no project filter toggle any more: in the
// entered project the list always shows only the project (`AppState.visibleChats`).
struct ChatFilterBar: View {
    /// In the drawer the search field is a glass capsule, on the "Recent chats" page the surface it used to be.
    @Environment(\.drawerGlass) private var drawerGlass
    @EnvironmentObject private var state: AppState
    /// Compact = left drawer (narrower, smaller type).
    var compact = false
    /// The archive as a sheet: a button with the archive symbol, without a count.
    @State private var archiveOpen = false

    /// Overview and drawer are both mounted — unique identifiers, otherwise a
    /// test finds two controls with the same name.
    private var idPrefix: String { compact ? "sidebar-chats" : "chats" }

    var body: some View {
        HStack(spacing: compact ? 2 : 4) {
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass")
                    .font(.symbol(compact ? 11.5 : 12.5))
                    .foregroundStyle(CbColor.textMuted)
                TextField(L("Search chats…"), text: $state.chatSearch)
                    .cbFont(compact ? 13 : 14)
                    .foregroundStyle(CbColor.text)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .accessibilityIdentifier("\(idPrefix)-search")
                if !state.chatSearch.isEmpty {
                    Button {
                        state.chatSearch = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.symbol(12.5))
                            .foregroundStyle(CbColor.textMuted)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(L("Clear search"))
                    .accessibilityIdentifier("\(idPrefix)-search-clear")
                }
            }
            .padding(.horizontal, 11)
            .padding(.vertical, compact ? 7 : 8.5)
            .modifier(SearchFieldBase(glass: drawerGlass && CbGlass.on))
            .padding(.trailing, compact ? 2 : 4)

            // Sorting, archive: calm symbols without circles of their own (chat list like the Claude app) —
            // muted, in the accent only while the sorting deviates from the default.
            Menu {
                Picker(L("Sorting"), selection: $state.chatSort) {
                    ForEach(ChatSort.allCases) { option in
                        Label(L(option.displayLabel), systemImage: option.symbol).tag(option)
                    }
                }
            } label: {
                Image(systemName: "arrow.up.arrow.down")
                    .font(.symbol(compact ? 13 : 14.5))
                    .foregroundStyle(state.chatSort == .newest ? CbColor.textMuted : Color.accentColor)
                    .frame(width: compact ? 30 : 34, height: compact ? 30 : 34)
                    .contentShape(Rectangle())
            }
            .accessibilityIdentifier("\(idPrefix)-sort")
            .accessibilityLabel(L("Sorting"))

            Button {
                archiveOpen = true
            } label: {
                Image(systemName: "archivebox")
                    .font(.symbol(compact ? 13 : 14.5))
                    .foregroundStyle(CbColor.textMuted)
                    .frame(width: compact ? 30 : 34, height: compact ? 30 : 34)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(state.chatList == nil)
            .accessibilityIdentifier("\(idPrefix)-archive")
            .accessibilityLabel(L("Archive##noun"))
        }
        .sheet(isPresented: $archiveOpen) {
            if let list = state.chatList {
                ArchiveList(
                    client: list.client,
                    workspaceId: list.workspaceId,
                    // In the entered project only its archived chats and folders — like the list behind it.
                    projectId: state.enteredProject?.id,
                    open: { state.openChat($0) },
                    changed: { await state.chatList?.load() }
                )
                .environmentObject(state)
                .cbSheet(.whole)
            }
        }
    }
}

/// The base of the search field: surface with edge, in a drawer with glass a glass capsule.
private struct SearchFieldBase: ViewModifier {
    let glass: Bool

    func body(content: Content) -> some View {
        if glass {
            content.cbGlass(Capsule())
        } else {
            content
                .background(CbColor.surface, in: Capsule())
                .overlay(Capsule().strokeBorder(CbColor.edge))
        }
    }
}

// The overview MUST observe the chat list model. It used to read it only via
// AppState — without `@ObservedObject`, `loading = false` triggers NO redraw.
// That was exactly the reported "endless loading": the list was long there (measured: 3 chats,
// loaded=1), but the view kept showing its loading skeleton until some other change
// to AppState happened to redraw it.
struct ChatsOverviewPane: View {
    @EnvironmentObject private var state: AppState
    let client: APIClient
    let workspace: Workspace

    var body: some View {
        if let model = state.chatList {
            ChatsOverviewList(model: model, client: client, workspace: workspace)
        } else {
            EmptyPaneState(
                title: L("No chats yet"),
                message: L("Start the first chat in this workspace."),
                systemImage: "bubble.left.and.bubble.right"
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        }
    }
}

private struct ChatsOverviewList: View {
    @EnvironmentObject private var state: AppState
    @ObservedObject var model: WorkspaceChatsViewModel
    let client: APIClient
    let workspace: Workspace
    @State private var newChatSheet = false
    /// Preset folder of the "New chat" sheet (from the folder menu).
    @State private var newChatFolderId = ""
    @State private var folderSheet = ChatFolderSheetState()
    /// Opened FOLDER VIEW (context files + artifacts of all chats of the folder). As a sheet,
    /// so it is reachable from the overview AND from the drawer without leaving the navigation
    /// behind it.
    @State private var openFolder: ChatFolder?
    /// The notifications sheet of a chat — five three-way toggles, hence a sheet.
    @State private var notifyFor: Chat?
    /// Archiving from the context menu (card, folder) — the flow with a pre-check.
    @State private var archiveJob: ArchiveJob?
    /// Deleting asks first — otherwise a tap in the context menu went through at once without confirmation.
    @State private var chatToDelete: Chat?
    /// A failed deletion (409: the chat is running) — the card stays, the server's message stands here.
    @State private var deleteError: String?

    private var chats: [Chat] {
        state.visibleChats(model.chats, projects: workspace.projects, folders: model.folders)
    }

    private var folders: [ChatFolder] {
        state.visibleFolders(model.folders, matching: chats)
    }

    /// Chats WITHOUT a (visible) folder — they stand below the folders in the flat list.
    private var looseChats: [Chat] {
        let known = Set(folders.map(\.id))
        return chats.filter { chat in
            guard let id = chat.folderId else { return true }
            return !known.contains(id)
        }
    }

    /// Is a search running? Then folders are always expanded, otherwise hits hide behind
    /// collapsed folders.
    private var searching: Bool {
        !state.chatSearch.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }


    var body: some View {
        PaneScaffold(
            title: L("Recent chats"),
            subtitle: state.enteredProject?.name ?? workspace.name,
            trailing: AnyView(
                HStack(spacing: 8) {
                    // Create folder — only a symbol, the space belongs to the "New chat" button. Round in
                    // the raised level like the close button of the drawer.
                    Button {
                        folderSheet.startCreate()
                    } label: {
                        Image(systemName: "folder.badge.plus")
                            .font(.symbol(13, weight: .medium))
                            .foregroundStyle(Color.primary)
                            .frame(width: 32, height: 32)
                            .background(CbColor.elevated, in: Circle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(L("Create folder"))
                    .accessibilityIdentifier("overview-new-folder")
                    // THE SAME button as above in the drawer (`sidebar-new-chat`): the primary button of the
                    // Claude app (light on dark or dark on light) with the pencil — one action, one
                    // shape in both places. A "New chat" row in the list would be one row among many between the chats;
                    // here it is the one surface with full contrast.
                    PillButton(title: L("New chat"), systemImage: "square.and.pencil", prominent: true) {
                        newChatFolderId = ""
                        newChatSheet = true
                    }
                    .accessibilityIdentifier("overview-new-chat")
                }
            )
        ) {
            VStack(spacing: 0) {
                ChatFilterBar()
                    .padding(.horizontal, 16)
                    .padding(.bottom, 6)

                // Rows instead of cards (see `ChatFolderViews.swift`): the list sits 6 pt from the
                // edge, every row pads 10 pt — hexagon, folder arrow and section heads thus stand
                // on the same line as the page title (16 pt).
                ScrollView {
                    LazyVStack(spacing: 2) {
                        if model.loading && model.chats.isEmpty {
                            ChatRowSkeleton(rows: 7)
                        } else if chats.isEmpty && folders.isEmpty {
                            // "Nothing found" only if someone is searching — a project without chats is empty, not searched without success.
                            EmptyPaneState(
                                title: searching ? L("Nothing found") : L("No chats yet"),
                                message: searching ? nil
                                    : state.enteredProject != nil ? L("Start the first chat in this project.")
                                    : L("Start the first chat in this workspace."),
                                systemImage: "bubble.left.and.bubble.right"
                            )
                        }

                        // Folders stand on top — they are structure, not history. Expanded,
                        // their chats run indented on a guide line below.
                        if !folders.isEmpty {
                            ChatListSection(title: L("Folders"))
                        }
                        ForEach(folders) { folder in
                            let inside = chats.filter { $0.folderId == folder.id }
                            let expanded = state.openChatFolders.contains(folder.id) || searching
                            VStack(spacing: 2) {
                                ChatFolderRow(
                                    folder: folder,
                                    count: inside.count,
                                    expanded: expanded,
                                    projectName: folderProjectName(folder),
                                    active: inside.contains { $0.id == state.selectedChatId },
                                    running: inside.contains { state.chatWorking($0.id) },
                                    compact: false,
                                    onToggle: { state.toggleChatFolder(folder.id) },
                                    onOpen: { openFolder = folder }
                                )
                                .accessibilityIdentifier("overview-folder-\(folder.id)")
                                .contextMenu {
                                    ChatFolderActions(
                                        folder: folder,
                                        onOpen: { openFolder = folder },
                                        onNewChat: { newChatInFolder(folder) },
                                        onRename: { folderSheet.startRename(folder) },
                                        onArchive: { archiveJob = folderJob(folder, model: model, state: state) },
                                        onDelete: { folderSheet.deleting = folder }
                                    )
                                }
                                if expanded {
                                    // The dense form of the guide line (as in the drawer): the rows
                                    // pad themselves, a gap like between cards would be mere air here.
                                    ChatFolderChildren(compact: true) {
                                        if inside.isEmpty {
                                            Text(L("Folder is empty"))
                                                .cbFont(13)
                                                .foregroundStyle(CbColor.textMuted)
                                                .frame(maxWidth: .infinity, alignment: .leading)
                                                .padding(.horizontal, 10)
                                                .padding(.vertical, 8)
                                        }
                                        ForEach(inside) { chat in chatRow(chat) }
                                    }
                                }
                            }
                        }

                        // Loose chats like "Starred" · "Recents" of the Claude app: pinned above the rest.
                        let sections = ChatListSections(loose: looseChats)
                        if !sections.pinned.isEmpty {
                            ChatListSection(title: L("Pinned"))
                            ForEach(sections.pinned) { chat in chatRow(chat) }
                        }
                        if sections.chatsHeader(byFolders: !folders.isEmpty) {
                            ChatListSection(title: L("Chats"))
                        }
                        ForEach(sections.leftOver) { chat in chatRow(chat) }

                        if !model.error.isEmpty {
                            VStack(spacing: 8) {
                                InlineError(message: model.error)
                                PillButton(title: L("Try again"), systemImage: "arrow.clockwise") {
                                    Task { await model.load() }
                                }
                                .accessibilityIdentifier("overview-retry")
                            }
                            .padding(.horizontal, 10)
                            .padding(.top, 8)
                        }
                    }
                    .padding(.horizontal, 6)
                    .padding(.bottom, 22)
                }
                .cbRefreshable { await model.load() }
                .scrollDismissesKeyboard(.immediately)
            }
        }
        // The overview stays mounted permanently — its `.task` does NOT fire again on
        // scope change. The switch itself triggers the fetch (AppState), this here is the
        // safety net in case it failed or was cancelled.
        .task { await model.startIfNeeded() }
        .onChange(of: state.scopeKey) {
            Task { await state.chatList?.startIfNeeded() }
        }
        .sheet(isPresented: $newChatSheet) {
            NewChatSheet(
                client: client,
                workspace: workspace,
                presetProjectId: state.enteredProject?.id,
                presetFolderId: newChatFolderId.isEmpty ? nil : newChatFolderId,
                folders: model.folders
            ) { draft in
                // The sheet creates nothing — it opens the draft with its values,
                // created on the first send (`ensureServerChat`). `openDraft` expands the folder.
                state.openDraft(draft)
            }
            .cbSheet(.whole)
        }
        .chatFolderDialogs($folderSheet, model: model, projectId: state.enteredProject?.id)
        .sheet(item: $notifyFor) { chat in
            NotifyChatSheet(chatId: chat.id, title: chat.title, job: chat.job != nil, choice: chat.notify) { fresh in
                var copy = chat
                copy.notify = fresh
                model.upsert(copy)
            }
            .cbSheet(.whole)
        }
        .sheet(item: $openFolder) { folder in
            FolderContentSheet(client: client, folder: folder)
                .cbSheet(.whole)
        }
        .archiveProcedure($archiveJob, client: client)
        .confirmationDialog(
            L("Delete chat \"{title}\"?", ["title": chatToDelete?.title ?? ""]),
            isPresented: Binding(get: { chatToDelete != nil }, set: { if !$0 { chatToDelete = nil } }),
            titleVisibility: .visible
        ) {
            Button(L("Delete permanently"), role: .destructive) {
                guard let chat = chatToDelete else { return }
                chatToDelete = nil
                Task { await delete(chat) }
            }
            Button(L("Cancel"), role: .cancel) { chatToDelete = nil }
        } message: {
            Text(L("The history, attachments, and artifacts will be removed."))
        }
        .alert(
            L("Delete failed"),
            isPresented: Binding(get: { deleteError != nil }, set: { if !$0 { deleteError = nil } }),
            presenting: deleteError
        ) { _ in
            Button(L("OK"), role: .cancel) { deleteError = nil }
        } message: { text in
            Text(text)
        }
    }

    /// A chat row of the overview (identical in a folder and outside). It used to be a card per
    /// chat — now the same row as in the drawer,
    /// plus the time small on the right; pressed it lies in `CbColor.marked` (`ChatRowStyle`).
    @ViewBuilder
    private func chatRow(_ chat: Chat) -> some View {
        Button {
            state.openChat(chat.id)
        } label: {
            ChatRow(
                chat: chat,
                project: workspace.projects.first(where: { $0.id == chat.projectId }),
                running: state.chatWorking(chat.id),
                unread: state.unreadChats.contains(chat.id),
                time: chatRowsTime(chat.updatedAt)
            )
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(ChatRowStyle())
        .contentShape(.contextMenuPreview, ChatRowStyle.form)
        .accessibilityIdentifier("overview-chat-\(chat.id)")
        .contextMenu {
            Button(L("Open"), systemImage: "arrow.right.circle") {
                state.openChat(chat.id)
            }
            Button(chat.pinned ? L("Detach") : L("Pin"), systemImage: chat.pinned ? "pin.slash" : "pin") {
                Task { await togglePin(chat) }
            }
            Button(L("Notifications"), systemImage: "bell") { notifyFor = chat }
            ChatFolderPicker(chat: chat, folders: model.folders) { folderId in
                Task {
                    try? await model.moveChat(chat, toFolder: folderId)
                    if let folderId { state.revealChatFolder(folderId) }
                }
            }
            Button(L("Archive"), systemImage: "archivebox") {
                archiveJob = chatJob(chat, model: model, state: state)
            }
            Button(L("Delete"), systemImage: "trash", role: .destructive) {
                chatToDelete = chat
            }
        }
    }

    /// At workspace level a project folder also stands in the list — then the row says
    /// which project it belongs to.
    private func folderProjectName(_ folder: ChatFolder) -> String? {
        guard state.enteredProject?.id != folder.projectId, let id = folder.projectId else { return nil }
        return workspace.projects.first(where: { $0.id == id })?.name
    }

    private func newChatInFolder(_ folder: ChatFolder) {
        newChatFolderId = folder.id
        state.revealChatFolder(folder.id)
        newChatSheet = true
    }

    private func togglePin(_ chat: Chat) async {
        struct Body: Encodable { let pinned: Bool }
        if let updated: Chat = try? await client.patch("/api/chats/\(chat.id)", body: Body(pinned: !chat.pinned)) {
            model.upsert(updated)
        }
    }

    /// The card is removed only after a 2xx response: a 409 (the chat is running) used to make it disappear
    /// although the chat stayed — and on the next load it was there again.
    private func delete(_ chat: Chat) async {
        do {
            _ = try await client.send("/api/chats/\(chat.id)", method: .delete)
        } catch {
            deleteError = error.localizedDescription
            return
        }
        model.remove(chat.id)
        if state.selectedChatId == chat.id { state.showChatOverview() }
    }
}

// ── Archiving from the Coding list ──────────────────────────────────────────
/// The job for a chat card or row: via the list model (the row drops out at once), then the notice
/// to open conversations — if the chat is currently open, it then shows the archive bar.
@MainActor
func chatJob(_ chat: Chat, model: WorkspaceChatsViewModel, state: AppState) -> ArchiveJob {
    ArchiveJob(target: .chat(id: chat.id, title: chat.title)) { dismiss in
        try await model.archive(chat.id, dismissQuestion: dismiss)
        state.reportArchive([chat.id])
    }
}

/// The job for a folder row: the folder and its chats go together.
@MainActor
func folderJob(_ folder: ChatFolder, model: WorkspaceChatsViewModel, state: AppState) -> ArchiveJob {
    ArchiveJob(target: .folder(id: folder.id, name: folder.name)) { _ in
        let inside = model.chats.filter { $0.folderId == folder.id }.map(\.id)
        try await model.archiveFolder(folder.id)
        state.reportArchive(inside)
    }
}

// ── Time and loading state of the rows ──────────────────────────────────────
/// The time on the right in a chat row — as short as in a message list: today the time of day, otherwise day and
/// month, in an earlier year the short date. It used to be ALWAYS "dd.MM. HH:mm" (`locDateTime`) — twelve
/// characters per row that the title was missing.
func chatRowsTime(_ updatedAt: Double) -> String {
    let date = locDate(fromServer: updatedAt)
    let calendar = Calendar.current
    if !calendar.isDate(date, equalTo: Date(), toGranularity: .year) { return locShortDate(date) }
    let format = DateFormatter()
    format.locale = Loc.locale
    format.setLocalizedDateFormatFromTemplate(calendar.isDateInToday(date) ? "HH:mm" : "d MMM")
    return format.string(from: date)
}

/// Placeholder of the overview while the list loads — in the shape of the rows (small marker, title and
/// meta bars), no longer as cards (`ListLoadingSkeleton` of the kit carries surfaces and stays for the other
/// lists).
struct ChatRowSkeleton: View {
    var rows = 6
    @State private var visible = false

    var body: some View {
        VStack(spacing: 2) {
            ForEach(0..<rows, id: \.self) { index in
                HStack(spacing: 10) {
                    Circle()
                        .fill(CbColor.elevated)
                        .frame(width: 14, height: 14)
                        .frame(width: 18)
                    VStack(alignment: .leading, spacing: 7) {
                        RoundedRectangle(cornerRadius: 4)
                            .fill(CbColor.elevated)
                            .frame(height: 11)
                            .frame(maxWidth: index % 2 == 0 ? 210 : 170, alignment: .leading)
                        RoundedRectangle(cornerRadius: 4)
                            .fill(CbColor.elevated.opacity(0.7))
                            .frame(height: 9)
                            .frame(maxWidth: 120, alignment: .leading)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(.horizontal, 10)
                .frame(minHeight: 58)
                .opacity(visible ? 1 : 0)
                .animation(.easeOut(duration: 0.35).delay(Double(index) * 0.06), value: visible)
            }
        }
        .shimmering()
        .onAppear { visible = true }
    }
}

// ── Left drawer: complete chat list ─────────────────────────────────────────
struct ChatsSidebar: View {
    @EnvironmentObject private var state: AppState
    @ObservedObject var model: WorkspaceChatsViewModel
    let workspace: Workspace
    @State private var folderSheet = ChatFolderSheetState()
    /// Opened FOLDER VIEW (context files + artifacts of all chats of the folder). As a sheet,
    /// so it is reachable from the overview AND from the drawer without leaving the navigation
    /// behind it.
    @State private var openFolder: ChatFolder?
    /// Archiving from the context menu of the drawer (row, folder).
    @State private var archiveJob: ArchiveJob?

    private var chats: [Chat] {
        state.visibleChats(model.chats, projects: workspace.projects, folders: model.folders)
    }

    private var folders: [ChatFolder] {
        state.visibleFolders(model.folders, matching: chats)
    }

    /// Chats WITHOUT a (visible) folder — they stand below the folders in the flat list.
    private var looseChats: [Chat] {
        let known = Set(folders.map(\.id))
        return chats.filter { chat in
            guard let id = chat.folderId else { return true }
            return !known.contains(id)
        }
    }

    /// Is a search running? Then folders are always expanded, otherwise hits hide behind
    /// collapsed folders. The entered project does NOT count here (as in the overview): it
    /// always restricts the list, and a folder in the project must stay collapsible. The empty state
    /// "Nothing found" also exists only for a search — an empty project is empty.
    private var searching: Bool {
        !state.chatSearch.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                PillButton(title: L("New chat"), systemImage: "square.and.pencil", prominent: true) {
                    state.startNewChat()
                }
                .accessibilityIdentifier("sidebar-new-chat")
                Spacer()
                // Round buttons in the raised level like "Create folder" on the "Recent chats" page and the
                // close button of the drawer; on glass glass circles.
                Button {
                    folderSheet.startCreate()
                } label: {
                    Image(systemName: "folder.badge.plus")
                        .font(.symbol(13, weight: .medium))
                        .foregroundStyle(Color.primary)
                        .frame(width: 30, height: 30)
                        .cbGlassButton(Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(L("Create folder"))
                .accessibilityIdentifier("sidebar-new-folder")
                Button {
                    state.showChatOverview()
                } label: {
                    Image(systemName: "list.bullet.rectangle")
                        .font(.symbol(13, weight: .medium))
                        .foregroundStyle(Color.primary)
                        .frame(width: 30, height: 30)
                        .cbGlassButton(Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(L("Recent chats"))
                .accessibilityIdentifier("sidebar-overview")
            }
            .padding(.horizontal, 14)
            .padding(.top, 10)
            .padding(.bottom, 8)

            ChatFilterBar(compact: true)
                .padding(.horizontal, 12)
                .padding(.bottom, 9)

            if !model.error.isEmpty {
                VStack(spacing: 7) {
                    InlineError(message: model.error)
                    // A failed fetch must be repeatable by hand — otherwise
                    // the drawer stays empty until the user switches scope.
                    PillButton(title: L("Try again"), systemImage: "arrow.clockwise") {
                        Task { await model.load() }
                    }
                    .accessibilityIdentifier("sidebar-retry")
                }
                .padding(.horizontal, 12)
                .padding(.bottom, 8)
                .accessibilityIdentifier("sidebar-error")
            }

            if model.loading && model.chats.isEmpty {
                CbLoading(label: L("Loading chats…"))
                Spacer()
            } else if chats.isEmpty && folders.isEmpty {
                EmptyPaneState(
                    title: searching ? L("Nothing found") : L("No chats yet"),
                    systemImage: "bubble.left.and.bubble.right"
                )
                Spacer()
            } else {
                ScrollView {
                    LazyVStack(spacing: 4) {
                        // Folders on top, their chats indented on a guide line below. The
                        // section heads are the same as on the "Recent chats" page.
                        if !folders.isEmpty {
                            ChatListSection(title: L("Folders"), compact: true)
                        }
                        ForEach(folders) { folder in
                            let inside = chats.filter { $0.folderId == folder.id }
                            let expanded = state.openChatFolders.contains(folder.id) || searching
                            VStack(spacing: 4) {
                                ChatFolderRow(
                                    folder: folder,
                                    count: inside.count,
                                    expanded: expanded,
                                    projectName: folderProjectName(folder),
                                    active: inside.contains { $0.id == state.selectedChatId && !state.showingChatOverview },
                                    running: inside.contains { state.chatWorking($0.id) },
                                    compact: true,
                                    onToggle: { state.toggleChatFolder(folder.id) },
                                    onOpen: { openFolder = folder }
                                )
                                .accessibilityIdentifier("sidebar-folder-\(folder.id)")
                                .contextMenu {
                                    ChatFolderActions(
                                        folder: folder,
                                        onOpen: { openFolder = folder },
                                        onNewChat: { state.startNewChat(inFolder: folder.id) },
                                        onRename: { folderSheet.startRename(folder) },
                                        onArchive: { archiveJob = folderJob(folder, model: model, state: state) },
                                        onDelete: { folderSheet.deleting = folder }
                                    )
                                }
                                if expanded {
                                    ChatFolderChildren(compact: true) {
                                        if inside.isEmpty {
                                            Text(L("Folder is empty"))
                                                .cbFont(12.5)
                                                .foregroundStyle(CbColor.textMuted)
                                                .frame(maxWidth: .infinity, alignment: .leading)
                                                .padding(.horizontal, 11)
                                                .padding(.vertical, 5)
                                        }
                                        ForEach(inside) { chat in sidebarRow(chat) }
                                    }
                                }
                            }
                            .padding(.bottom, 2)
                        }

                        let sections = ChatListSections(loose: looseChats)
                        if !sections.pinned.isEmpty {
                            ChatListSection(title: L("Pinned"), compact: true)
                            ForEach(sections.pinned) { chat in sidebarRow(chat) }
                        }
                        if sections.chatsHeader(byFolders: !folders.isEmpty) {
                            ChatListSection(title: L("Chats"), compact: true)
                        }
                        ForEach(sections.leftOver) { chat in sidebarRow(chat) }
                    }
                    .padding(.horizontal, 8)
                    .padding(.bottom, 10)
                }
                .scrollDismissesKeyboard(.immediately)
                .cbRefreshable { await model.load() }
            }
        }
        .task { await model.startIfNeeded() }
        .chatFolderDialogs($folderSheet, model: model, projectId: state.enteredProject?.id)
        .sheet(item: $openFolder) { folder in
            FolderContentSheet(client: model.client, folder: folder)
                .cbSheet(.whole)
        }
        .archiveProcedure($archiveJob, client: model.client)
    }

    /// A chat row of the drawer (identical in a folder and outside).
    @ViewBuilder
    private func sidebarRow(_ chat: Chat) -> some View {
        Button {
            state.openChat(chat.id)
        } label: {
            ChatRow(
                chat: chat,
                project: workspace.projects.first(where: { $0.id == chat.projectId }),
                running: state.chatWorking(chat.id),
                unread: state.unreadChats.contains(chat.id)
            )
            .padding(.horizontal, 11)
            .padding(.vertical, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        // Selected as before in `CbColor.marked`, now also pressed — the same style as the rows
        // of the "Recent chats" page.
        .buttonStyle(ChatRowStyle(selected: state.selectedChatId == chat.id && !state.showingChatOverview))
        .contentShape(.contextMenuPreview, ChatRowStyle.form)
        .accessibilityIdentifier("sidebar-chat-\(chat.id)")
        .contextMenu {
            ChatFolderPicker(chat: chat, folders: model.folders) { folderId in
                Task {
                    try? await model.moveChat(chat, toFolder: folderId)
                    if let folderId { state.revealChatFolder(folderId) }
                }
            }
            Button(L("Archive"), systemImage: "archivebox") {
                archiveJob = chatJob(chat, model: model, state: state)
            }
        }
    }

    /// At workspace level a project folder also stands in the list — then the row says
    /// which project it belongs to.
    private func folderProjectName(_ folder: ChatFolder) -> String? {
        guard state.enteredProject?.id != folder.projectId, let id = folder.projectId else { return nil }
        return workspace.projects.first(where: { $0.id == id })?.name
    }
}
