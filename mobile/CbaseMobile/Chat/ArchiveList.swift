import SwiftUI

// The archive on the iPhone: the list of archived coding chats, opened as a sheet from the list header (one button with the
// archive symbol, no count). The normal list shows none of it and its search does not search the archive; this one has its own.
//
// Plus the "Archive" procedure (`ArchiveProcedure`): the pre-check is loaded only AFTER the tap. Open work ⇒ the reasons as
// server text and nothing archived; if the open question is the ONLY reason, "Discard question and archive" sits beside it.
// Open shells ⇒ a confirmation. The PUT checks on its own anyway — a pre-check is a snapshot; a 409 reloads the reasons and
// shows them.

// ── The "Archive" procedure ───────────────────────────────────────────────────────
/// A job: what gets archived and HOW — the open chat goes through its model (the bar shows at once), a list row through the
/// list model (the row disappears at once).
struct ArchiveJob: Identifiable {
    let target: ArchiveTarget
    let execute: (_ dismissQuestion: Bool) async throws -> Void
    var id: String { target.id }
}

private enum ArchiveDialog: Identifiable {
    case locked(ArchiveJob, ArchiveHint)
    case shells(ArchiveJob, count: Int, dismiss: Bool)
    case error(String)

    var id: String {
        switch self {
        case .locked(let a, _): return "locked:\(a.id)"
        case .shells(let a, _, _): return "shells:\(a.id)"
        case .error(let text): return "error:\(text)"
        }
    }
}

struct ArchiveProcedure: ViewModifier {
    @Binding var job: ArchiveJob?
    let client: APIClient?
    @State private var dialog: ArchiveDialog?

    func body(content: Content) -> some View {
        content
            .onChange(of: job?.id) { _, id in
                guard id != nil, let a = job else { return }
                job = nil
                Task { await check(a) }
            }
            .alert(
                title,
                isPresented: Binding(get: { dialog != nil }, set: { if !$0 { dialog = nil } }),
                presenting: dialog
            ) { d in
                switch d {
                case .locked(let a, let h):
                    if h.onlyQuestion {
                        Button(L("Discard the question and archive"), role: .destructive) {
                            Task { await further(a, terminals: h.terminals, dismiss: true) }
                        }
                    }
                    Button(L("OK"), role: .cancel) {}
                case .shells(let a, _, let dismiss):
                    Button(L("Archive")) { Task { await run(a, dismiss: dismiss) } }
                    Button(L("Cancel"), role: .cancel) {}
                case .error:
                    Button(L("OK"), role: .cancel) {}
                }
            } message: { d in
                switch d {
                case .locked(_, let h): Text(h.rows.joined(separator: "\n"))
                case .shells: EmptyView()
                case .error(let text): Text(text)
                }
            }
    }

    private var title: String {
        switch dialog {
        case .locked(let a, _):
            if case .folder = a.target { return L("Work is still open in this folder — nothing archived") }
            return L("Work is still open in this chat — not archived")
        case .shells(_, let n, _):
            return n == 1 ? L("Archive? 1 open shell will be ended.") : L("Archive? {n} open shells will be ended.", ["n": n])
        case .error: return L("Archiving failed")
        case nil: return ""
        }
    }

    private func hint(_ a: ArchiveJob) async throws -> ArchiveHint? {
        guard let client else { return nil }
        switch a.target {
        case .chat(let id, _): return ArchiveHint(chat: try await client.archivePrecheck(chat: id))
        case .folder(let id, _): return ArchiveHint(folder: try await client.archivePrecheck(folder: id))
        }
    }

    private func check(_ a: ArchiveJob) async {
        // Without a pre-check (network, older server) the way stays open — the PUT checks on its own.
        guard let h = try? await hint(a) else { return await run(a, dismiss: false) }
        if h.locked { dialog = .locked(a, h); return }
        await further(a, terminals: h.terminals, dismiss: false)
    }

    private func further(_ a: ArchiveJob, terminals: Int, dismiss: Bool) async {
        if terminals > 0 { dialog = .shells(a, count: terminals, dismiss: dismiss); return }
        await run(a, dismiss: dismiss)
    }

    private func run(_ a: ArchiveJob, dismiss: Bool) async {
        do {
            try await a.execute(dismiss)
        } catch {
            // 409: work arrived between pre-check and PUT. `APIError` carries only the sentence — a fresh pre-check fetches the
            // reasons.
            if (error as? APIError)?.status == 409, let h = try? await hint(a), h.locked {
                dialog = .locked(a, h)
                return
            }
            let text = error.localizedDescription
            dialog = .error(text.isEmpty ? L("Archiving failed") : text)
        }
    }
}

extension View {
    func archiveProcedure(_ job: Binding<ArchiveJob?>, client: APIClient?) -> some View {
        modifier(ArchiveProcedure(job: job, client: client))
    }
}

// ── The archive list ────────────────────────────────────────────────────────────
/// Archived folders come first, expanded with their chats; below them loosely archived chats, each with the name of its
/// (still active) folder. Every row carries ⋯ with "Restore" and "Delete permanently"; the confirmation names what is lost
/// (for a folder the numbers FROM THE SERVER, `questionFolder`). A tap opens the chat — read-only, with the archive bar.
struct ArchiveList: View {
    @EnvironmentObject private var state: AppState
    @Environment(\.dismiss) private var dismiss
    let client: APIClient
    let workspaceId: String
    /// Entered project (coding): only its chats and folders — like the normal list.
    var projectId: String?
    /// Open by id — the coding chat via `openChat` (`SelectedChatHost` fetches it by id).
    let open: (String) -> Void
    /// After restore/delete: reload the normal list.
    let changed: () async -> Void

    @State private var inventory: ArchiveInventory?
    @State private var error = ""
    @State private var search = ""
    @State private var closed: Set<String> = []
    @State private var chatToDelete: ArchiveEntry?
    @State private var folderDelete: FolderQuestion?

    private struct FolderQuestion: Identifiable {
        let folder: ChatFolder
        let text: String
        var id: String { folder.id }
    }

    private var groups: ArchiveGroups? {
        guard var b = inventory else { return nil }
        if let projectId {
            b.chats = b.chats.filter { $0.projectId == projectId }
            b.folder = b.folder.filter { $0.projectId == projectId }
        }
        return ArchiveGroups(b).filtered(search)
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                CbSearch(placeholder: L("Search the archive…"), text: $search, identifier: "archive-search")
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                // Rows instead of cards — the same language as "Recent chats", where one comes from: the list 6 pt from the
                // edge, each row pads 10 pt, surface only under the pressed row (`ChatRowStyle`).
                ScrollView {
                    LazyVStack(spacing: 2) {
                        InlineError(message: error)
                        content
                    }
                    .padding(.horizontal, 6)
                    .padding(.bottom, 22)
                }
                .cbRefreshable { await load() }
                .scrollDismissesKeyboard(.immediately)
            }
            .cbSheetBase()
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("archive-list")
            .navigationTitle(L("Archive##noun"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { SheetClose(identifier: "archive-finished", label: L("Done")) { dismiss() } }
        }
        .task { await load() }
        // Another client, a folder, a run that restores: the event `chat_archive`.
        .onChange(of: state.archiveChanged) { Task { await load() } }
        .confirmationDialog(
            L("Delete chat \"{title}\" permanently? History, artifacts and attachments will be lost.",
              ["title": chatToDelete.map { $0.title.isEmpty ? L("Untitled") : $0.title } ?? ""]),
            isPresented: Binding(get: { chatToDelete != nil }, set: { if !$0 { chatToDelete = nil } }),
            titleVisibility: .visible
        ) {
            Button(L("Delete permanently"), role: .destructive) {
                guard let c = chatToDelete else { return }
                chatToDelete = nil
                Task { await deleteChat(c) }
            }
            Button(L("Cancel"), role: .cancel) { chatToDelete = nil }
        }
        .confirmationDialog(
            folderDelete?.text ?? "",
            isPresented: Binding(get: { folderDelete != nil }, set: { if !$0 { folderDelete = nil } }),
            titleVisibility: .visible
        ) {
            Button(L("Delete permanently"), role: .destructive) {
                guard let f = folderDelete else { return }
                folderDelete = nil
                Task { await deleteFolder(f.folder) }
            }
            Button(L("Cancel"), role: .cancel) { folderDelete = nil }
        }
    }

    @ViewBuilder
    private var content: some View {
        if let g = groups {
            // Quiet section headers instead of a divider, as in the chat lists (`ChatListSection`).
            if !g.folder.isEmpty {
                ChatListSection(title: L("Folders"))
            }
            ForEach(g.folder) { group in
                let open = !closed.contains(group.id)
                VStack(spacing: 2) {
                    folderRow(group, open: open)
                    if open {
                        ChatFolderChildren(compact: true) {
                            if group.chats.isEmpty {
                                Text(L("Folder is empty"))
                                    .cbFont(13)
                                    .foregroundStyle(CbColor.textMuted)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(.horizontal, 10)
                                    .padding(.vertical, 8)
                            }
                            ForEach(group.chats) { c in row(c, label: "") }
                        }
                    }
                }
            }
            if !g.folder.isEmpty && !g.loose.isEmpty {
                ChatListSection(title: L("Chats"))
            }
            ForEach(g.loose) { l in row(l.chat, label: l.label) }
            if g.empty {
                EmptyPaneState(
                    title: search.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        ? L("Nothing archived.") : L("Nothing in the archive matches the search."),
                    systemImage: "archivebox"
                )
                .accessibilityIdentifier("archive-empty")
            }
        } else if error.isEmpty {
            ChatRowSkeleton(rows: 3)
        }
    }

    /// The folder header in the form of `ChatFolderRow`: no surface, arrow and folder muted, the name in primary text.
    private func folderRow(_ group: ArchiveGroups.Folder, open: Bool) -> some View {
        HStack(spacing: 0) {
            Button {
                if closed.contains(group.id) { closed.remove(group.id) } else { closed.insert(group.id) }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "chevron.right")
                        .font(.symbol(10, weight: .semibold))
                        .foregroundStyle(CbColor.textMuted)
                        .rotationEffect(.degrees(open ? 90 : 0))
                        .frame(width: 12)
                    Image(systemName: "folder.fill")
                        .font(.symbol(14))
                        .foregroundStyle(CbColor.textMuted)
                        .frame(width: 18)
                    Text(group.folder.name)
                        .cbFont(15.5, weight: .medium)
                        .foregroundStyle(CbColor.text)
                        .lineLimit(1)
                    Spacer(minLength: 6)
                    Text("\(group.chats.count)")
                        .cbFont(11.5, digitsEqual: true)
                        .foregroundStyle(CbColor.textMuted)
                }
                .padding(.leading, 10)
                .padding(.vertical, 9)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(ChatRowStyle())
            .accessibilityIdentifier("archive-folder-\(group.id)")
            .accessibilityValue(open ? "open" : "closed")
            rowMenu(id: group.id) {
                Task { await fetchBack(folder: group.id) }
            } erase: {
                Task { await questionFolder(group) }
            }
        }
        .padding(.trailing, 2)
        .contentShape(.contextMenuPreview, ChatRowStyle.form)
        .contextMenu {
            menuEntries {
                Task { await fetchBack(folder: group.id) }
            } erase: {
                Task { await questionFolder(group) }
            }
        }
    }

    /// An archived row without a card: on the sheet's ground, pressed in `CbColor.marked` (`ChatRowStyle`); title in primary
    /// text, label and date muted — like the rows of the chat lists.
    private func row(_ c: ArchiveEntry, label: String) -> some View {
        HStack(spacing: 0) {
            Button {
                dismiss()
                open(c.id)
            } label: {
                HStack(spacing: 10) {
                    Image(systemName: "archivebox")
                        .font(.symbol(13))
                        .foregroundStyle(CbColor.textMuted)
                        .frame(width: 18)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(c.title.isEmpty ? L("Untitled") : c.title)
                            .cbFont(15)
                            .foregroundStyle(CbColor.text)
                            .lineLimit(1)
                        if !label.isEmpty {
                            Text(label)
                                .cbFont(12.5)
                                .foregroundStyle(CbColor.textMuted)
                                .lineLimit(1)
                        }
                        // The timer archived it, not the human — otherwise one looks for a gesture that never existed. Muted like the
                        // folder label above; computation and order stay.
                        if c.automatic {
                            Text(L("archived automatically"))
                                .cbFont(12.5)
                                .foregroundStyle(CbColor.textMuted)
                                .lineLimit(1)
                                .accessibilityIdentifier("archive-auto-\(c.id)")
                        }
                    }
                    Spacer(minLength: 6)
                    if c.archivedAt > 0 {
                        Text(locShortDate(locDate(fromServer: c.archivedAt)))
                            .cbFont(11.5, digitsEqual: true)
                            .foregroundStyle(CbColor.textMuted)
                            .fixedSize()
                    }
                }
                .padding(.leading, 10)
                .padding(.vertical, 8)
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(ChatRowStyle())
            .accessibilityIdentifier("archive-row-\(c.id)")
            rowMenu(id: c.id) {
                Task { await fetchBack(chat: c.id) }
            } erase: {
                chatToDelete = c
            }
        }
        .padding(.trailing, 2)
        .contentShape(.contextMenuPreview, ChatRowStyle.form)
        .contextMenu {
            menuEntries {
                Task { await fetchBack(chat: c.id) }
            } erase: {
                chatToDelete = c
            }
        }
    }

    /// ⋯ on every row — more reliable than the long press, and the same content as the context menu.
    private func rowMenu(id: String, restore: @escaping () -> Void, erase: @escaping () -> Void) -> some View {
        Menu {
            menuEntries(restore: restore, erase: erase)
        } label: {
            Image(systemName: "ellipsis")
                .font(.symbol(13, weight: .semibold))
                .foregroundStyle(CbColor.textMuted)
                .frame(width: 38, height: 34)
                .contentShape(Rectangle())
        }
        .accessibilityLabel(L("More"))
        .accessibilityIdentifier("archive-menu-\(id)")
    }

    @ViewBuilder
    private func menuEntries(restore: @escaping () -> Void, erase: @escaping () -> Void) -> some View {
        Button(action: restore) {
            Label(L("Restore"), systemImage: "arrow.uturn.backward")
        }
        Divider()
        Button(role: .destructive, action: erase) {
            Label(L("Delete permanently"), systemImage: "trash")
        }
    }

    // ── Loading and acting ──
    private func load() async {
        do {
            inventory = try await client.loadArchive(workspaceId: workspaceId)
            error = ""
        } catch {
            if Task.isCancelled { return }
            self.error = error.localizedDescription
        }
    }

    private func after() async {
        await load()
        await changed()
    }

    private func fetchBack(chat id: String) async {
        do { try await client.setArchive(chat: id, false) } catch {
            self.error = error.localizedDescription.isEmpty ? L("Restoring failed") : error.localizedDescription
            return
        }
        // If the chat is open, it loses its bar — without waiting for the event.
        state.reportArchive([id])
        await after()
    }

    private func fetchBack(folder id: String) async {
        let response: ArchiveFolderResponse
        do { response = try await client.setArchive(folder: id, false) } catch {
            self.error = error.localizedDescription.isEmpty ? L("Restoring failed") : error.localizedDescription
            return
        }
        state.reportArchive(response.chatIds)
        await after()
    }

    private func deleteChat(_ c: ArchiveEntry) async {
        do { _ = try await client.send("/api/chats/\(c.id)", method: .delete) } catch {
            self.error = error.localizedDescription
            return
        }
        closeDeleted([c.id])
        await after()
    }

    /// The confirmation names the number of chats AND context files that are lost — both from the SERVER (the pre-check on the
    /// archived folder counts exactly what `?permanently=1` deletes). NOT from `groups`: that is cut by search and project filter,
    /// while the server deletes the whole folder (search "bug", confirmation "1 chat", three deleted). Without an answer no
    /// confirmation and no delete: a guessed number before an irreversible step would be worse than an error.
    private func questionFolder(_ group: ArchiveGroups.Folder) async {
        let counts: ArchiveFolderPrecheck
        do { counts = try await client.archivePrecheck(folder: group.id) } catch {
            if Task.isCancelled { return }
            self.error = error.localizedDescription
            return
        }
        guard let text = ArchiveQuestion.folderDelete(name: group.folder.name,
                                                    chats: counts.chats, contextFiles: counts.contextFiles) else {
            // The answer came but named no chat count: same situation as without an answer (web: ArchiveView).
            error = L("The numbers for the confirmation could not be loaded — nothing was deleted. Please try again.")
            return
        }
        folderDelete = FolderQuestion(folder: group.folder, text: text)
    }

    private func deleteFolder(_ folder: ChatFolder) async {
        let doomed = inventory?.chats.filter { $0.folderId == folder.id }.map(\.id) ?? []
        do { try await client.deleteFolderPermanently(folder.id) } catch {
            self.error = error.localizedDescription
            return
        }
        closeDeleted(doomed)
        await after()
    }

    /// If a just-deleted chat was open, back to the list — otherwise one would stand in a chat that does not exist.
    private func closeDeleted(_ ids: [String]) {
        if let open = state.selectedChatId, ids.contains(open) { state.showChatOverview() }
    }
}
