import SwiftUI

// Chat list of a workspace. The global event stream (running / new answer) lives in
// AppState; this model only keeps the list itself fresh.
@MainActor
final class WorkspaceChatsViewModel: ObservableObject {
    @Published var chats: [Chat] = []
    /// Chat folders of the same workspace. They arrive in the same round as the chats; a half-updated list would
    /// briefly show chats outside their folder.
    @Published var folders: [ChatFolder] = []
    @Published var loading = true
    @Published var error = ""

    let client: APIClient
    let workspaceId: String
    /// True only after a SUCCESSFUL fetch: an aborted or failed attempt must run again the next time the view appears.
    private var loaded = false
    private var inFlight: Task<Void, Never>?
    private var needsRefresh = false

    init(client: APIClient, workspaceId: String) {
        self.client = client
        self.workspaceId = workspaceId
    }

    func startIfNeeded() async {
        guard !loaded else { return }
        await load()
    }

    /// Loads the list. Several triggers (view, event stream, scope change, pull to refresh) do NOT run in parallel: they
    /// attach to the running fetch, and a refetch requested in the meantime is made up afterwards.
    ///
    /// The fetch itself runs in its OWN task. If the caller is cancelled (view disappears, scope changes), it runs to the
    /// end and resets `loading`; otherwise the loading skeleton would stay although nobody is loading anymore.
    func load() async {
        if let running = inFlight {
            needsRefresh = true
            await running.value
            return
        }
        let task = Task { @MainActor in
            repeat {
                needsRefresh = false
                await fetch()
            } while needsRefresh
        }
        inFlight = task
        await task.value
        inFlight = nil
    }

    private func fetch() async {
        loading = true
        defer { loading = false }
        do {
            async let chatsResponse: [Chat] = client.get(
                "/api/chats",
                query: [URLQueryItem(name: "workspaceId", value: workspaceId)],
                timeout: 20
            )
            // An old server without the folder route must not take the chat list down with it; then there are simply no folders.
            async let foldersResponse: [ChatFolder]? = try? await client.get(
                "/api/chat-folders",
                query: [URLQueryItem(name: "workspaceId", value: workspaceId)],
                timeout: 20
            )
            chats = try await chatsResponse
            folders = (await foldersResponse) ?? []
            sortFolders()
            sortChats()
            loaded = true
            error = ""
        } catch is CancellationError {
            return
        } catch {
            if let urlError = error as? URLError, urlError.code == .cancelled { return }
            let nsError = error as NSError
            if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled { return }
            self.error = error.localizedDescription
        }
    }

    func applyTitle(_ title: String, to id: String) {
        guard let index = chats.firstIndex(where: { $0.id == id }) else { return }
        chats[index].title = title
    }

    func remove(_ id: String) {
        chats.removeAll { $0.id == id }
    }

    func upsert(_ chat: Chat) {
        if let index = chats.firstIndex(where: { $0.id == chat.id }) {
            // The field `job` is carried only by the list; a PATCH response without it would otherwise take the row's clock away.
            var chat = chat
            if chat.job == nil { chat.job = chats[index].job }
            chats[index] = chat
        } else {
            chats.append(chat)
        }
        sortChats()
    }

    // ── Chat folders ───────────────────────────────────────────────────────
    /// Create a folder. `projectId` binds it to a project; it then takes only chats of that project (and new chats in it
    /// inherit it).
    @discardableResult
    func createFolder(name: String, projectId: String?) async throws -> ChatFolder {
        struct Body: Encodable {
            let workspaceId: String
            let name: String
            let projectId: String?
        }
        let folder: ChatFolder = try await client.post("/api/chat-folders", body: Body(
            workspaceId: workspaceId, name: name, projectId: projectId
        ))
        folders.append(folder)
        sortFolders()
        return folder
    }

    func renameFolder(_ folder: ChatFolder, to name: String) async throws {
        struct Body: Encodable { let name: String }
        let updated: ChatFolder = try await client.patch("/api/chat-folders/\(folder.id)", body: Body(name: name))
        if let index = folders.firstIndex(where: { $0.id == folder.id }) {
            folders[index].name = updated.name
        }
        sortFolders()
    }

    /// Dissolve a folder: the chats in it stay and afterwards sit in the list without a folder.
    func deleteFolder(_ folder: ChatFolder) async throws {
        let _: OKResponse = try await client.delete("/api/chat-folders/\(folder.id)")
        folders.removeAll { $0.id == folder.id }
        for index in chats.indices where chats[index].folderId == folder.id {
            chats[index].folderId = nil
        }
    }

    /// Assign a chat to a folder (or take it out with `nil`).
    func moveChat(_ chat: Chat, toFolder folderId: String?) async throws {
        // `encode` instead of the generated version: that uses `encodeIfPresent` and would OMIT the key for nil; the server
        // would then see no folder field at all and the chat would stay in its folder. Taking it out needs an explicit null.
        struct Body: Encodable {
            let folderId: String?
            enum CodingKeys: String, CodingKey { case folderId }
            func encode(to encoder: Encoder) throws {
                var container = encoder.container(keyedBy: CodingKeys.self)
                try container.encode(folderId, forKey: .folderId)
            }
        }
        let updated: Chat = try await client.patch("/api/chats/\(chat.id)", body: Body(folderId: folderId))
        upsert(updated)
        refreshFolderCounts()
    }

    // ── Archive ────────────────────────────────────────────────────────────
    /// Archive; the precheck is done by the procedure before it (`ArchiveProcedure`). Afterwards the chat is missing from
    /// the list (excluding archived chats is the default), without waiting for a fetch.
    func archive(_ chatId: String, dismissQuestion: Bool = false) async throws {
        try await client.setArchive(chat: chatId, true, dismissQuestion: dismissQuestion)
        chats.removeAll { $0.id == chatId }
        refreshFolderCounts()
    }

    /// Archive a folder with content: the folder and the chats that went with it drop out of the list.
    func archiveFolder(_ folderId: String) async throws {
        let response = try await client.setArchive(folder: folderId, true)
        let deleted = Set(response.chatIds)
        chats.removeAll { deleted.contains($0.id) || $0.folderId == folderId }
        folders.removeAll { $0.id == folderId }
    }

    /// The archive of this workspace, for the archive list.
    func loadArchive() async throws -> ArchiveInventory {
        try await client.loadArchive(workspaceId: workspaceId)
    }

    /// The counter on the folder row comes from the server; after local changes we recompute it from the already loaded
    /// chat list instead of making a round trip.
    private func refreshFolderCounts() {
        var counts: [String: Int] = [:]
        for chat in chats {
            guard let id = chat.folderId else { continue }
            counts[id, default: 0] += 1
        }
        for index in folders.indices {
            folders[index].chatCount = counts[folders[index].id] ?? 0
        }
    }

    private func sortFolders() {
        folders.sort { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    private func sortChats() {
        chats.sort {
            if $0.pinned != $1.pinned { return $0.pinned }
            return $0.updatedAt > $1.updatedAt
        }
    }
}

/// The values of a new chat: the DEFAULTS of a draft. Every "New chat" entry (sheet, drawer, folder menu, "Start chat" on
/// an instance) opens the empty chat view with these values, WITHOUT `POST`; the chat is created on the first send with
/// exactly them (`ChatViewModel.ensureServerChat`). Empty fields mean "no choice"; the draft and the server then set
/// their default. The defaults here are those of the drawer's empty draft (full access, level = default when creating).
/// Agent instructions per workspace/project replace a persona choice.
struct NewChatDraft: Equatable {
    var projectId = ""
    /// Chat folder (empty = none). A project-bound folder sets the project itself.
    var folderId = ""
    var provider = ""
    var model = ""
    var permissionMode = "bypassPermissions"
    var effort = ""
    /// Ultracode as a preselection: a switch next to the level (counterpart of `ultracodeSel` on the web), independent of it.
    var ultracode = false
    var browserMode = ""
    /// The instance ("copy-<name>"; nil = main): "Start chat" on an instance (`Code/ProjectInstances.swift`). Only goes out
    /// with a project (`ensureServerChat`).
    var instance: String? = nil
}

/// A chat row, for the "Recent chats" page AND the left drawer (both in `ChatsOverviewPane.swift`).
///
/// In the language of the Claude app's sidebar: no card; the place paints the surface, and only when the row is selected
/// or pressed (`ChatRowStyle`); the title in primary text, below it ONE short, muted meta line. The hexagon stays as a
/// run marker, but small; it carries color only when the chat is running or has unread content.
struct ChatRow: View {
    let chat: Chat
    let project: Project?
    let running: Bool
    let unread: Bool
    /// Time of the last change, small on the right of the title row. Only the "Recent chats" page sets it; in the narrow
    /// drawer the title would otherwise have too little room.
    var time: String? = nil

    /// Short: the model already names its provider ("claude-opus-5-5", "gpt-5.6-sol"); the provider appears only when no
    /// model is set. Search still finds the provider (`AppState.visibleChats` reads the field, not this row).
    private var metadata: String {
        var parts = [project?.name ?? L("Workspace")]
        if !chat.model.isEmpty {
            parts.append(chat.model)
        } else if !chat.provider.isEmpty {
            parts.append(chat.provider.capitalized)
        }
        return parts.joined(separator: " · ")
    }

    var body: some View {
        HStack(spacing: 10) {
            ZStack {
                HexagonMark()
                    .frame(width: 14, height: 14)
                    .foregroundStyle(running || unread ? Color.accentColor : CbColor.textMuted.opacity(0.6))
                    .symbolEffect(.rotate, options: running ? .repeat(.continuous) : .nonRepeating)
                if unread && !running {
                    Circle()
                        .fill(Color.accentColor)
                        .frame(width: 4.5, height: 4.5)
                }
            }
            .frame(width: 18)

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 5) {
                    if chat.pinned {
                        Image(systemName: "pin.fill")
                            .font(.symbol(9.5, weight: .semibold))
                            .foregroundStyle(CbColor.textMuted)
                    }
                    Text(chat.title)
                        .cbFont(16, weight: unread ? .semibold : .regular)
                        .foregroundStyle(CbColor.text)
                        .lineLimit(1)
                    // Only when it differs from the default; otherwise twenty identical symbols say nothing.
                    if !notifyMarker(chat.notify).isEmpty {
                        Image(systemName: notifyMarker(chat.notify))
                            .font(.symbol(10, weight: .semibold))
                            .foregroundStyle(notifyMarker(chat.notify) == "bell.slash" ? CbColor.textMuted : Color.accentColor)
                            .accessibilityIdentifier("chat-notify-marker-\(chat.id)")
                    }
                    // A job chat carries a clock with the next occurrence; paused or done as a word.
                    if let job = chat.job {
                        jobClock(job)
                    }
                    if let time {
                        Spacer(minLength: 8)
                        Text(time)
                            .cbFont(11.5, digitsEqual: true)
                            .foregroundStyle(CbColor.textMuted)
                            .fixedSize()
                    }
                }
                Text(metadata)
                    .cbFont(12.5)
                    .foregroundStyle(CbColor.textMuted)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .accessibilityIdentifier("chat-metadata-\(chat.id)")
                    .frame(maxWidth: .infinity, minHeight: 16, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .layoutPriority(1)
        }
        .padding(.vertical, 2)
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
    }

    /// Clock and occurrence small behind the title; active in the accent color, paused and done muted. Identifiers on image and text
    /// (never on the stack): `chat-job-clock-<chatId>`, `chat-job-occurrence-<chatId>`.
    private func jobClock(_ job: ChatJob) -> some View {
        let active = job.status == "active"
        return HStack(spacing: 3) {
            Image(systemName: "clock")
                .font(.symbol(10, weight: .semibold))
                .accessibilityLabel(L("Scheduled"))
                .accessibilityIdentifier("chat-job-clock-\(chat.id)")
            Text(ScheduledWord.clock(job))
                .cbFont(11.5, digitsEqual: true)
                .lineLimit(1)
                .accessibilityIdentifier("chat-job-occurrence-\(chat.id)")
        }
        .foregroundStyle(active ? Color.accentColor : CbColor.textMuted)
        .fixedSize()
    }
}

struct NewChatSheet: View {
    @Environment(\.dismiss) private var dismiss
    let client: APIClient
    let workspace: Workspace
    let presetProjectId: String?
    /// Preset chat folder (from "New chat in folder").
    var presetFolderId: String? = nil
    /// Folders of the workspace; only those of the chosen project scope are offered.
    var folders: [ChatFolder] = []
    /// "Start": opens the draft with these values; the chat is created only on the first send.
    let onStart: (NewChatDraft) -> Void

    @State private var draft = NewChatDraft()
    @State private var providers: [Provider] = []
    @State private var error = ""

    var body: some View {
        NavigationStack {
            CbForm {
                Section(L("Assignment")) {
                    // If the project comes from the entered one (the only caller, `ChatsOverviewPane`), it is fixed, like on the web
                    // (`newChatProjectId` = focus). The list shows only its chats in a project; another would immediately drop the new one.
                    if let fixed = presetProjectId, let project = workspace.projects.first(where: { $0.id == fixed }) {
                        LabeledContent(L("Project"), value: project.name)
                    } else {
                        Picker(L("Project"), selection: $draft.projectId) {
                            Text(L("Workspace")).tag("")
                            ForEach(workspace.projects) { Text($0.name).tag($0.id) }
                        }
                    }
                    // Folders of the same scope: the new chat starts in it and shares the other chats' artifacts of this folder
                    // read-only.
                    if !scopedFolders.isEmpty {
                        Picker(L("Folder"), selection: $draft.folderId) {
                            Text(L("No folder")).tag("")
                            ForEach(scopedFolders) { Text($0.name).tag($0.id) }
                        }
                        .accessibilityIdentifier("new-chat-folder")
                    }
                }

                Section(L("Model")) {
                    Picker(L("Providers"), selection: $draft.provider) {
                        ForEach(providers.filter(\.connected)) { provider in
                            Text(provider.label).tag(provider.id)
                        }
                    }
                    // With OpenRouter: the same choice as a searchable sheet (Kit/ModelSelection.swift).
                    ModelChoice(title: L("Model"), groups: selectedProvider.map { [ModelGroup($0)] } ?? [], selection: $draft.model) {
                        Picker(L("Model"), selection: $draft.model) {
                            ForEach(selectedProvider?.models ?? []) { model in
                                Text(model.label).tag(model.id)
                            }
                        }
                    }
                }

                Section(L("run")) {
                    Picker(L("Permissions"), selection: $draft.permissionMode) {
                        Text(L("Full access")).tag("bypassPermissions")
                        Text(L("Auto-edit")).tag("acceptEdits")
                        Text(L("Plan")).tag("plan")
                        Text(L("Ask")).tag("default")
                    }
                    // The entries are built by the block of the four pickers (Kit/EffortSelection.swift), which hides itself:
                    // model without levels, provider with `caps.effort` off.
                    // Ultracode is a switch of its own below, like in the chat sheet (independent of the level).
                    EffortSelection(effort: $draft.effort, empty: nil, providers: providers, provider: draft.provider, model: draft.model)
                    UltracodeToggle(on: $draft.ultracode)
                    Picker(L("Browser"), selection: $draft.browserMode) {
                        Text(L("Auto")).tag("")
                        Text(L("Background")).tag("hidden")
                        Text(L("Visible")).tag("shown")
                    }
                }

                if !error.isEmpty {
                    Label(error, systemImage: "exclamationmark.circle")
                        .foregroundStyle(.red)
                }
            }
            .navigationTitle(L("New chat"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                SheetClose(label: L("Cancel")) { dismiss() }
                ToolbarItem(placement: .confirmationAction) {
                    Button(L("Start")) {
                        onStart(draft)
                        dismiss()
                    }
                    .disabled(draft.provider.isEmpty || draft.model.isEmpty)
                }
            }
            .task { await loadOptions() }
            .onChange(of: draft.provider) {
                if !(selectedProvider?.models.contains(where: { $0.id == draft.model }) ?? false) {
                    draft.model = selectedProvider?.defaultModel ?? selectedProvider?.models.first?.id ?? ""
                }
            }
            // Project change: a folder of the old scope no longer fits.
            // No empty entry anymore: a new chat from a model without levels gets the default.
            .onChange(of: draft.model) {
                if draft.effort.isEmpty { draft.effort = EffortLevels.standard(providers, provider: draft.provider, model: draft.model) }
            }
            .onChange(of: draft.projectId) {
                if !scopedFolders.contains(where: { $0.id == draft.folderId }) { draft.folderId = "" }
            }
        }
    }

    private var selectedProvider: Provider? {
        providers.first(where: { $0.id == draft.provider })
    }

    /// Only folders that fit the chosen project; the server rejects everything else.
    private var scopedFolders: [ChatFolder] {
        folders.filter { ($0.projectId ?? "") == draft.projectId }
    }

    private func loadOptions() async {
        if let presetProjectId, draft.projectId.isEmpty { draft.projectId = presetProjectId }
        if let presetFolderId, draft.folderId.isEmpty {
            draft.folderId = presetFolderId
            // A project-bound folder also determines the project; otherwise the sheet would show a combination the server
            // would reject.
            if let folder = folders.first(where: { $0.id == presetFolderId }), let project = folder.projectId {
                draft.projectId = project
            }
        }
        do {
            let providerResponse: ProvidersResponse = try await client.get("/api/providers")
            providers = providerResponse.providers
            let active = providers.first(where: { $0.id == providerResponse.active && $0.connected })
                ?? providers.first(where: \.connected)
            draft.provider = active?.id ?? ""
            draft.model = active?.defaultModel ?? active?.models.first?.id ?? ""
            // Preset with the provider's default level, clamped to the model only while nobody has chosen.
            if draft.effort.isEmpty { draft.effort = EffortLevels.standard(providers, provider: draft.provider, model: draft.model) }
        } catch {
            self.error = error.localizedDescription
        }
    }

}
